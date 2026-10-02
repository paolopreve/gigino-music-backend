import express from 'express';
import { SpotdlExtractor } from './spotifyextractor.js';
import { findBestMatch, getAudioStream } from './youtubeextractor.js';

const app = express();
const PORT = process.env.PORT || 3000;
const extractor = new SpotdlExtractor();

app.use(express.json());

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${req.method}] ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

/**
 * Encodes URI components strictly according to RFC 3986,
 * ensuring characters like !, ', (, ), * are percent-encoded
 * to avoid terminal shell expansion and client-side URL parsing issues.
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
    const baseUrl = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;

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

    res.json({ title, count: streamableTracks.length, tracks: streamableTracks });
  } catch (err) {
    console.error(`[Playlist Error] ${err.message}`);
    res.status(502).json({ error: 'Extraction Failed', message: err.message });
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

  try {
    const match = await findBestMatch({ title, author, targetDuration: duration });
    const { stream, cleanup } = await getAudioStream(match.url, { title, author });

    // Clean filename: remove illegal filesystem characters and normalize spaces
    const safeFilename = `${author ? `${author} - ` : ''}${title}.opus`
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();

    res.setHeader('Content-Type', 'audio/opus');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeFilename)}"`);

    stream.on('error', (err) => {
      console.error('[Stream Error]', err);
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: 'Stream interrupted' });
    });

    req.on('close', cleanup);
    stream.pipe(res);
  } catch (err) {
    console.error('[Match Error]', err.message);
    res.status(404).json({ error: 'Track not found', message: err.message });
  }
}

// Endpoints
app.route('/api/playlist').get(handlePlaylist).post(handlePlaylist);
app.route('/api/stream').get(handleAudioStream).post(handleAudioStream);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on http://0.0.0.0:${PORT}`);
});