import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);
const YT_DLP_PATH = '/usr/local/bin/yt-dlp';

/**
 * Resolves the path to the cookies file if present.
 * Looks for Render's secret path first (/etc/secrets/cookies.txt), then local root.
 */
function getCookieFilePath() {
  const possiblePaths = [
    process.env.YOUTUBE_COOKIES_PATH,
    '/etc/secrets/cookies.txt',
    path.join(process.cwd(), 'cookies.txt')
  ];

  for (const filePath of possiblePaths) {
    if (filePath && fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/**
 * Returns baseline yt-dlp arguments required to satisfy YouTube JS challenges
 * and bypass bot-detection on cloud servers.
 */
function getBaseYtDlpArgs() {
  const args = [
    '--no-warnings',
    '--js-runtimes', 'node',
    '--remote-components', 'ejs:github',
    '--extractor-args', 'youtube:player_client=android,web'
  ];

  const cookiePath = getCookieFilePath();
  if (cookiePath) {
    args.push('--cookies', cookiePath);
  }

  return args;
}

/**
 * Searches YouTube and finds the best matching track.
 */
export async function findBestMatch({ title, author, targetDuration = 0 }) {
  const query = `ytsearch15:${title} ${author} audio`;
  console.log(`[YouTube Search] Query: "${query}"`);

  const args = [
    ...getBaseYtDlpArgs(),
    query,
    '--dump-single-json',
    '--flat-playlist'
  ];

  const { stdout } = await execFileAsync(YT_DLP_PATH, args);

  const { entries = [] } = JSON.parse(stdout);
  if (entries.length === 0) {
    throw new Error(`No YouTube results for: "${title} ${author}"`);
  }

  const normAuthor = (author || '').toLowerCase().trim();

  const best = entries
    .map((e) => {
      const dur = e.duration ?? 0;
      const diff = Math.abs(dur - targetDuration);
      const uploader = (e.uploader || e.channel || '').toLowerCase();
      const entryTitle = (e.title || '').toLowerCase();

      const matchesAuthor =
        uploader.includes(normAuthor) ||
        normAuthor.includes(uploader) ||
        entryTitle.includes(normAuthor);

      const durScore = targetDuration > 0 ? Math.max(0, 1 - diff / 60) : 0.5;
      const authorScore = matchesAuthor ? 1 : 0.2;

      return {
        id: e.id,
        url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
        title: e.title,
        score: durScore * 0.7 + authorScore * 0.3
      };
    })
    .sort((a, b) => b.score - a.score)[0];

  if (!best) {
    throw new Error(`Could not find a match for "${title}" by "${author}".`);
  }

  console.log(`[YouTube Match] Found: "${best.title}"`);
  return best;
}

/**
 * Streams audio with Title and Artist Vorbis tags embedded via FFmpeg.
 */
export async function getAudioStream(videoUrl, { title, author } = {}) {
  // 1. Fetch direct audio URL
  const args = [
    ...getBaseYtDlpArgs(),
    '-g',
    '-f', 'bestaudio[ext=opus]/bestaudio/best',
    videoUrl
  ];

  const { stdout } = await execFileAsync(YT_DLP_PATH, args);
  const directAudioUrl = stdout.trim();

  // 2. FFmpeg remuxing arguments
  const ffmpegArgs = [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', directAudioUrl,
    '-vn',
    '-c:a', 'copy',
    ...(title ? ['-metadata', `title=${title}`] : []),
    ...(author ? ['-metadata', `artist=${author}`] : []),
    '-f', 'opus',
    'pipe:1'
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Prevent unhandled error events from crashing the Node server
  ffmpeg.on('error', (err) => {
    console.error('[FFmpeg Process Error]', err.message);
  });

  ffmpeg.stderr.on('data', (data) => {
    const str = data.toString();
    if (str.includes('Error') || str.includes('Invalid')) {
      console.error('[FFmpeg STDERR]', str.trim());
    }
  });

  return {
    stream: ffmpeg.stdout,
    cleanup: () => {
      try {
        ffmpeg.kill('SIGTERM');
      } catch (_) {}
    }
  };
}