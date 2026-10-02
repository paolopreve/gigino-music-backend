import express from 'express';
import { SpotdlExtractor } from './spotifyextractor.js';
import { findBestMatch, getAudioStream } from './youtubeextractor.js';

const app = express();
const PORT = process.env.PORT || 3000;
const extractor = new SpotdlExtractor();

// Crucial on Render: trust the reverse proxy to get correct protocol & host
app.set('trust proxy', 1);

app.use(express.json());

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${req.method}] ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// Health check endpoint for Render
app.get('/health', (req, res) => res.json({ status: 'ok' }));

/**
 * Encodes URI components strictly according to RFC 3986.
 */
function encodeRFC3986(str) {
  return encodeURIComponent(str || '')
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Returns playlist title and all streamable tracks in one call
 */
async function handlePlaylist(req, res) {
  const playlistUrl = req.query.url || req.body?.url;
  if (!playlistUrl || typeof playlistUrl !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "url" parameter.' });
  }

  try {
    const { title, tracks } = await extractor.getPlaylist(playlistUrl);
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}`;

    const streamableTracks = tracks.map((track) => {
      const qTitle = `title=${encodeRFC3986(track.title)}`;
      const qAuthor = `author=${encodeRFC3986(track.author)}`;
      const qDuration = `duration=${encodeRFC3986(String(track.durationSec || 0))}`;

      return {
        title: track.title,
        author: track.author,
        durationSec: track.durationSec,
        streamUrl: `${baseUrl}/api/stream?${qTitle}&${qAuthor}&${qDuration}`
      };
    });

    return res.json({ title, count: streamableTracks.length, tracks: streamableTracks });
  } catch (err) {
    console.error(`[Playlist Error] ${err.message}`);
    return res.status(502).json({ error: 'Extraction Failed', message: err.message });
  }
}

/**
 * Search YouTube, inject Vorbis metadata tags, and pipe the Opus audio stream
 */
async function handleAudioStream(req, res) {
  const title = req.query.title || req.body?.title;
  const author = req.query.author || req.body?.author || '';
  const duration = parseInt(req.query.duration || req.body?.duration, 10) || 0;

  if (!title) {
    return res.status(400).json({ error: 'Missing "title" parameter.' });
  }

  let cleanupStream = null;

  try {
    const match = await findBestMatch({ title, author, targetDuration: duration });
    const { stream, cleanup } = await getAudioStream(match.url, { title, author });
    cleanupStream = cleanup;

    // Sanitize base ASCII filename and prepare full UTF-8 filename
    const rawFilename = author ? `${author} - ${title}.opus` : `${title}.opus`;
    const cleanFilename = rawFilename
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();

    // Standard RFC 5987 / RFC 6266 header handling UTF-8 characters safely
    const asciiFallback = cleanFilename.replace(/[^\x20-\x7E]/g, '_');
    const encodedFilename = encodeURIComponent(cleanFilename);

    res.setHeader('Content-Type', 'audio/opus');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`
    );

    // Clean up when client aborts the request
    req.on('close', () => {
      if (!res.writableEnded && cleanupStream) {
        cleanupStream();
      }
    });

    stream.on('error', (err) => {
      console.error('[Stream Error]', err);
      if (cleanupStream) cleanupStream();
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream interrupted' });
      } else {
        res.end();
      }
    });

    stream.pipe(res);
  } catch (err) {
    console.error('[Match Error]', err.message);
    if (cleanupStream) cleanupStream();
    if (!res.headersSent) {
      return res.status(404).json({ error: 'Track not found', message: err.message });
    }
  }
}

// Endpoints
app.route('/api/playlist').get(handlePlaylist).post(handlePlaylist);
app.route('/api/stream').get(handleAudioStream).post(handleAudioStream);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on http://0.0.0.0:${PORT}`);
});

// Graceful shutdown handling for container stops (Render/Docker)
const shutdown = (signal) => {
  console.log(`Received ${signal}. Shutting down cleanly...`);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Forcing shutdown after timeout.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));