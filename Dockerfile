FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive
# Render sets PORT dynamically, default fallback to 3000 locally
ENV PORT=3000

# Install dependencies, dumb-init, python3, ffmpeg, ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    ffmpeg \
    ca-certificates \
    curl \
    dumb-init \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts

COPY . .

# Render ignores EXPOSE, but keeping it standard
EXPOSE ${PORT}

# Use dumb-init to properly handle PID 1 signals and child processes
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

CMD ["node", "server.js"]