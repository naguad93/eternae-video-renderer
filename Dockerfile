FROM node:20-alpine

# Instalar FFmpeg y fuentes
RUN apk add --no-cache ffmpeg fontconfig ttf-freefont

WORKDIR /app

# Copiar fuente Parisienne
COPY fonts/ ./fonts/
RUN fc-cache -fv

# Instalar dependencias
COPY package.json .
RUN npm install --omit=dev

# Copiar servidor
COPY server.js .

ENV PORT=3000
ENV FONT_PATH=/app/fonts/Parisienne-Regular.ttf

EXPOSE 3000
CMD ["node", "server.js"]
