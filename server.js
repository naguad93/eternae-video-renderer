import express from "express";
import { spawn } from "child_process";
import { createClient } from "@supabase/supabase-js";
import fs from "fs/promises";
import path from "path";
import os from "os";

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT      = process.env.PORT || 3000;
const FONT_PATH = process.env.FONT_PATH || "/app/fonts/Parisienne-Regular.ttf";
const API_KEY   = process.env.RENDERER_API_KEY || "eternae-render-2025";
const MUSIC_URL = "https://fxhonuezaallalzetvmk.supabase.co/storage/v1/object/public/assets/hitslab-emotional-emotional-piano-music-302981.mp3";

// ── Auth ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (req.headers["x-api-key"] !== API_KEY)
    return res.status(401).json({ error: "Unauthorized" });
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────
async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${url} → ${res.status}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

// Escape text for FFmpeg drawtext filter
function esc(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")   // apostrophe → curly quote
    .replace(/:/g, "\\:")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited ${code}\n${stderr.slice(-3000)}`));
    });
  });
}

// ── Video builder ─────────────────────────────────────────────────────
async function processVideo(job) {
  const {
    photoUrls, recipientName, senderName, occasion,
    style = "mosaic",
    closingLine1 = "Con amor,",
    closingLine2,
    orderId,
    callbackUrl,
    supabaseUrl,
    supabaseKey,
  } = job;

  const closing2 = closingLine2 || senderName || "";
  const tmpDir   = await fs.mkdtemp(path.join(os.tmpdir(), `eternae-${orderId}-`));
  const outPath  = path.join(tmpDir, "output.mp4");

  console.log(`[${orderId}] START  style=${style}  photos=${photoUrls.length}`);

  try {
    // 1. Download photos (parallel)
    const photoPaths = new Array(photoUrls.length);
    await Promise.all(
      photoUrls.map(async (url, i) => {
        const ext = url.toLowerCase().endsWith(".png") ? "png" : "jpg";
        const p   = path.join(tmpDir, `p${i}.${ext}`);
        await download(url, p);
        photoPaths[i] = p;
      })
    );

    // 2. Download music
    const musicPath = path.join(tmpDir, "music.mp3");
    await download(MUSIC_URL, musicPath);

    // 3. Build FFmpeg command
    const W          = 1920;
    const H          = 1080;
    const PHOTO_DUR  = style === "cinematic" ? 3.5 : 2.8;
    const FADE       = 0.4;
    const INTRO_DUR  = 2.5;
    const OUTRO_DUR  = 2.5;
    const n          = photoPaths.length;

    // Total content duration (photos with overlapping xfade)
    const contentDur = n * PHOTO_DUR - (n - 1) * FADE;
    const totalDur   = INTRO_DUR + contentDur + OUTRO_DUR;
    const audioFadeStart = Math.max(0, totalDur - 2.5);

    const args = [];

    // Inputs: 0=intro color, 1=outro color, 2..n+1=photos, n+2=music
    args.push("-f", "lavfi", "-t", String(INTRO_DUR),
              "-i", `color=c=0x0e0c08:s=${W}x${H}:r=25`);
    args.push("-f", "lavfi", "-t", String(OUTRO_DUR),
              "-i", `color=c=0x0e0c08:s=${W}x${H}:r=25`);

    for (const p of photoPaths) {
      args.push("-loop", "1", "-t", String(PHOTO_DUR + FADE), "-i", p);
    }
    args.push("-i", musicPath);

    // ── Filter complex ──────────────────────────────────────────────
    const F = [];
    const musicIdx = n + 2;

    // Intro title card
    const alpha = (_st, en) =>
      `if(lt(t,0.4),t/0.4,if(lt(t,${en - 0.4}),1,if(lt(t,${en}),(${en}-t)/0.4,0)))`;

    F.push(
      `[0:v]` +
      `drawtext=fontfile=${FONT_PATH}:text='${esc(occasion)}':fontsize=80:fontcolor=#C9A96E@0.85:x=(w-text_w)/2:y=h/2-90:alpha='${alpha(0, INTRO_DUR)}',` +
      `drawtext=fontfile=${FONT_PATH}:text='para ${esc(recipientName)}':fontsize=112:fontcolor=#C9A96E:x=(w-text_w)/2:y=h/2+60:alpha='${alpha(0, INTRO_DUR)}'` +
      `[intro]`
    );

    // Outro title card
    F.push(
      `[1:v]` +
      `drawtext=fontfile=${FONT_PATH}:text='${esc(closingLine1)}':fontsize=72:fontcolor=#C9A96E@0.8:x=(w-text_w)/2:y=h/2-60:alpha='${alpha(0, OUTRO_DUR)}',` +
      `drawtext=fontfile=${FONT_PATH}:text='${esc(closing2)}':fontsize=116:fontcolor=#C9A96E:x=(w-text_w)/2:y=h/2+70:alpha='${alpha(0, OUTRO_DUR)}'` +
      `[outro]`
    );

    // Photo clips
    const TRANSITIONS_CIN  = ["fade", "fade", "fade", "fade"];
    const TRANSITIONS_MOS  = ["slideleft", "slideright", "fade", "slideleft", "slideright", "fade", "circleopen", "fade"];
    const trList = style === "cinematic" ? TRANSITIONS_CIN : TRANSITIONS_MOS;

    for (let i = 0; i < n; i++) {
      const src = i + 2; // input index
      F.push(
        `[${src}:v]` +
        `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
        `setpts=PTS-STARTPTS` +
        `[v${i}]`
      );
    }

    // xfade chain
    let photosLabel;
    if (n === 1) {
      photosLabel = "v0";
    } else {
      for (let i = 0; i < n - 1; i++) {
        const inA   = i === 0 ? "v0" : `xfc${i - 1}`;
        const inB   = `v${i + 1}`;
        const outL  = i === n - 2 ? "photos" : `xfc${i}`;
        const off   = ((i + 1) * (PHOTO_DUR - FADE)).toFixed(3);
        const tr    = trList[i % trList.length];
        F.push(`[${inA}][${inB}]xfade=transition=${tr}:duration=${FADE}:offset=${off}[${outL}]`);
      }
      photosLabel = "photos";
    }

    // Join intro + photos
    const introPhotosOff = (INTRO_DUR - FADE).toFixed(3);
    F.push(`[intro][${photosLabel}]xfade=transition=fade:duration=${FADE}:offset=${introPhotosOff}[iwp]`);

    // Join (intro+photos) + outro
    const outroOff = (INTRO_DUR + contentDur - FADE).toFixed(3);
    F.push(`[iwp][outro]xfade=transition=fade:duration=${FADE}:offset=${outroOff}[video]`);

    // Audio
    F.push(
      `[${musicIdx}:a]` +
      `atrim=0:${totalDur.toFixed(3)},` +
      `afade=t=out:st=${audioFadeStart.toFixed(3)}:d=2.5,` +
      `asetpts=PTS-STARTPTS,volume=0.65` +
      `[audio]`
    );

    args.push("-filter_complex", F.join(";"));
    args.push("-map", "[video]", "-map", "[audio]");
    args.push("-c:v", "libx264", "-preset", "fast", "-crf", "22");
    args.push("-c:a", "aac", "-b:a", "192k");
    args.push("-movflags", "+faststart");
    args.push("-t", totalDur.toFixed(3));
    args.push("-y", outPath);

    console.log(`[${orderId}] Running FFmpeg (${totalDur.toFixed(1)}s video)...`);
    await runFFmpeg(args);

    // 4. Upload to Supabase
    console.log(`[${orderId}] Uploading to Supabase...`);
    const supabase   = createClient(supabaseUrl, supabaseKey);
    const videoBuf   = await fs.readFile(outPath);
    const remotePath = `videos/${orderId}.mp4`;

    const { error: upErr } = await supabase.storage
      .from("assets")
      .upload(remotePath, videoBuf, { contentType: "video/mp4", upsert: true });
    if (upErr) throw new Error("Supabase upload: " + upErr.message);

    const { data: urlData } = supabase.storage.from("assets").getPublicUrl(remotePath);
    const videoUrl = urlData.publicUrl;

    await supabase.from("orders")
      .update({ video_url: videoUrl, status: "ready" })
      .eq("id", orderId);

    // 5. Callback to Vercel (same endpoint as Shotstack used)
    if (callbackUrl) {
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, videoUrl }),
      }).catch((e) => console.error(`[${orderId}] Callback error:`, e.message));
    }

    console.log(`[${orderId}] DONE  ${videoUrl}`);
  } catch (err) {
    console.error(`[${orderId}] ERROR:`, err.message);
    try {
      const supabase = createClient(supabaseUrl, supabaseKey);
      await supabase.from("orders").update({ status: "video_failed" }).eq("id", orderId);
    } catch {}
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Job Queue (one at a time to avoid OOM) ────────────────────────────
const jobQueue = [];
let processing = false;

async function processQueue() {
  if (processing || jobQueue.length === 0) return;
  processing = true;
  while (jobQueue.length > 0) {
    const job = jobQueue.shift();
    try {
      await processVideo(job);
    } catch (e) {
      console.error("Unhandled job error:", e);
    }
  }
  processing = false;
}

function enqueue(job) {
  jobQueue.push(job);
  processQueue();
}

// ── Routes ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "eternae-video-renderer", queue: jobQueue.length, processing })
);

app.post("/render", async (req, res) => {
  const job = req.body;
  if (!job?.photoUrls?.length || !job?.orderId) {
    return res.status(400).json({ error: "photoUrls and orderId required" });
  }
  enqueue(job);
  res.json({ success: true, message: "Rendering queued", orderId: job.orderId, position: jobQueue.length });
});

app.listen(PORT, () => console.log(`Video renderer listening on port ${PORT}`));
