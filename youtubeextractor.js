import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);
const YT_DLP_PATH = '/usr/local/bin/yt-dlp';

/**
 * Resolves a writable path for the cookies file.
 */
function getCookieFilePath() {
  const secretPath = '/etc/secrets/cookies.txt';
  const writableTmpPath = '/tmp/yt_cookies.txt';
  const envPath = process.env.YOUTUBE_COOKIES_PATH;
  const localPath = path.join(process.cwd(), 'cookies.txt');

  const sourcePath = [envPath, secretPath, localPath].find(
    (p) => p && fs.existsSync(p)
  );

  if (!sourcePath) return null;

  if (sourcePath.startsWith('/etc/secrets')) {
    try {
      fs.copyFileSync(sourcePath, writableTmpPath);
      return writableTmpPath;
    } catch (err) {
      console.warn('[Cookies] Failed copying to /tmp:', err.message);
      return sourcePath;
    }
  }

  return sourcePath;
}

/**
 * Base arguments for cloud instances:
 * - Uses ios and web clients (avoids android SABR empty stream locks)
 * - Enables node runtime for signature descrambling
 */
function getBaseYtDlpArgs() {
  const args = [
    '--no-warnings',
    '--no-cache-dir',
    '--js-runtimes', 'node',
    '--remote-components', 'ejs:github',
    '--extractor-args', 'youtube:player_client=ios,web,mweb'
  ];

  const cookiePath = getCookieFilePath();
  if (cookiePath) {
    args.push('--cookies', cookiePath);
  }

  return args;
}

/**
 * Searches YouTube and returns metadata for the closest match.
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
 * Pipes audio directly from yt-dlp -> FFmpeg -> HTTP Response.
 * This completely avoids the fragile '-g' URL extraction step.
 */
export async function getAudioStream(videoUrl, { title, author } = {}) {
  // 1. Spawn yt-dlp to stream raw audio bytes directly to stdout
  const ytDlpProcess = spawn(
    YT_DLP_PATH,
    [
      ...getBaseYtDlpArgs(),
      '-f', 'ba/b',
      '-o', '-', // Stream directly to pipe
      videoUrl
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  // 2. Spawn FFmpeg to read from yt-dlp's stdout (pipe:0) and encode to Opus
  const ffmpegArgs = [
    '-i', 'pipe:0',
    '-vn',
    '-c:a', 'libopus',
    '-b:a', '160k',
    ...(title ? ['-metadata', `title=${title}`] : []),
    ...(author ? ['-metadata', `artist=${author}`] : []),
    '-f', 'opus',
    'pipe:1'
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Pipe raw media bytes from yt-dlp directly into FFmpeg
  ytDlpProcess.stdout.pipe(ffmpegProcess.stdin);

  ytDlpProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('ERROR') || msg.includes('WARNING')) {
      console.warn('[yt-dlp]', msg.trim());
    }
  });

  ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('Invalid')) {
      console.error('[FFmpeg]', msg.trim());
    }
  });

  const cleanup = () => {
    try {
      ytDlpProcess.kill('SIGTERM');
    } catch (_) {}
    try {
      ffmpegProcess.kill('SIGTERM');
    } catch (_) {}
  };

  ytDlpProcess.on('error', (err) => {
    console.error('[yt-dlp Spawn Error]', err.message);
    cleanup();
  });

  ffmpegProcess.on('error', (err) => {
    console.error('[FFmpeg Spawn Error]', err.message);
    cleanup();
  });

  return {
    stream: ffmpegProcess.stdout,
    cleanup
  };
}