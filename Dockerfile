FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive

# Install python3, ffmpeg, certificates, and curl to fetch yt-dlp binary
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    ffmpeg \
    ca-certificates \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev --ignore-scripts

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]