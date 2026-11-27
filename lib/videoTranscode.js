'use strict';
// Page-scan lesson video → small H.264/AAC MP4 (the "screen" that plays on the
// textbook page in the app).
//
//   480 (default): shorter side ≤ 480 px, ~0.7 Mbps  → ~6 MB per minute
//   720 ("Sharper"): shorter side ≤ 720 px, ~1.4 Mbps → ~11 MB per minute
//   Audio: AAC mono 96 kbps. Never upscales. Frame rate capped at 30.
//   +faststart puts the index first, so playback starts while it downloads.
//
// Why it is split into steps: the dashboard reaches the API through Firebase
// Hosting, which cuts every request at 60 seconds. So the video is converted
// in 20-second pieces (one request each, ~10–25 s of work), the sound in one
// request, then the pieces are joined without re-encoding. Input is a signed
// storage link (or a local path in dev), so a large original never has to fit
// in Cloud Run's memory or pass through the 32 MB request limit.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const MAX_SECONDS = 300;   // 5-minute cap per lesson video
const SEGMENT_SECONDS = 20;
const PRESETS = {
  480: { side: 480, vb: '700k', maxrate: '900k', bufsize: '1400k' },
  720: { side: 720, vb: '1400k', maxrate: '1800k', bufsize: '2800k' },
};

class VideoError extends Error {
  constructor(message, code, status = 422) { super(message); this.code = code; this.status = status; }
}

const tmpFile = (ext) => path.join(os.tmpdir(), `mitra_vid_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);

// Every input may only be read from local files or pipes: an uploaded file that
// is really a playlist (HLS / concat) can't make ffmpeg fetch URLs (SEC-019).
const localInputsOnly = (args) =>
  args.flatMap(a => (a === '-i' ? ['-protocol_whitelist', 'file,pipe', '-i'] : [a]));

// Run ffmpeg; resolve with stderr text. Rejects on a non-zero exit.
function run(args, { timeoutMs = 55000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-nostdin', ...localInputsOnly(args)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    const t = setTimeout(() => { p.kill('SIGKILL'); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code, signal) => {
      clearTimeout(t);
      if (code === 0) return resolve(err);
      const last = err.trim().split('\n').slice(-3).join(' | ');
      reject(new VideoError(signal === 'SIGKILL' ? 'Video step took too long' : `ffmpeg failed: ${last}`, 'TRANSCODE'));
    });
  });
}

/** Duration, size and whether there is sound. Reads only the file header. */
async function probeVideo(input) {
  // "ffmpeg -i x" with no output exits 1 but prints the stream info.
  const info = await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-nostdin', ...localInputsOnly(['-i', input])], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.on('error', reject);
    p.on('close', () => { clearTimeout(t); resolve(err); });
  });
  const dm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info);
  const vm = /Stream #\d+:\d+[^\n]*?: Video: [^\n]*?(\d{2,5})x(\d{2,5})/.exec(info);
  if (!vm) throw new VideoError('This file has no video track that can be read. Use MP4, MOV or WebM.', 'NO_VIDEO', 400);
  const duration = dm ? (+dm[1]) * 3600 + (+dm[2]) * 60 + (+dm[3]) : null;
  if (!duration || duration <= 0) throw new VideoError('Could not read the video length.', 'NO_DURATION', 400);
  // Phone videos store rotation as metadata; ffmpeg applies it when converting.
  const rot = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(info) || /rotate\s*:\s*(-?\d+)/.exec(info);
  const quarter = rot ? Math.abs(Math.round(+rot[1] / 90)) % 2 === 1 : false;
  const w = +vm[1], h = +vm[2];
  return {
    duration: Math.round(duration * 1000) / 1000,
    width: quarter ? h : w,
    height: quarter ? w : h,
    has_audio: /Stream #\d+:\d+[^\n]*?: Audio:/.test(info),
  };
}

function segmentCount(duration) {
  return Math.max(1, Math.ceil((duration - 0.05) / SEGMENT_SECONDS));
}

/** Converts piece n (0-based) of the picture, no sound. Returns the MP4 bytes. */
async function transcodeSegment(input, n, { quality = '480' } = {}) {
  const p = PRESETS[String(quality)] || PRESETS[480];
  const out = tmpFile('.mp4');
  // Shorter side ≤ preset (portrait or landscape), even sizes, never upscaled.
  const scale = `scale=w='if(gte(iw,ih),-2,min(${p.side},iw))':h='if(gte(iw,ih),min(${p.side},ih),-2)'`;
  try {
    await run([
      '-ss', String(n * SEGMENT_SECONDS), '-t', String(SEGMENT_SECONDS), '-i', input,
      '-map', '0:v:0', '-an', '-sn', '-dn',
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-vf', `${scale},setsar=1,fps=30`,
      '-b:v', p.vb, '-maxrate', p.maxrate, '-bufsize', p.bufsize,
      '-g', '60', '-keyint_min', '30', '-sc_threshold', '0',
      '-video_track_timescale', '15360',
      '-y', out,
    ]);
    return fs.readFileSync(out);
  } finally { fs.unlink(out, () => {}); }
}

/** Converts the whole soundtrack (fast: sound only). Returns M4A bytes. */
async function transcodeAudio(input, { duration } = {}) {
  const out = tmpFile('.m4a');
  try {
    await run([
      '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn',
      ...(duration ? ['-t', String(duration)] : []),
      '-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-ar', '44100',
      '-y', out,
    ]);
    return fs.readFileSync(out);
  } finally { fs.unlink(out, () => {}); }
}

/** Joins the converted pieces (+ sound) without re-encoding. Returns MP4 bytes. */
async function joinParts(segmentBuffers, audioBuffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitra_join_'));
  try {
    const list = segmentBuffers.map((b, i) => {
      const f = path.join(dir, `v${String(i).padStart(3, '0')}.mp4`);
      fs.writeFileSync(f, b);
      return `file '${f}'`;
    }).join('\n');
    fs.writeFileSync(path.join(dir, 'list.txt'), list + '\n');
    const args = ['-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt')];
    if (audioBuffer) {
      fs.writeFileSync(path.join(dir, 'a.m4a'), audioBuffer);
      args.push('-i', path.join(dir, 'a.m4a'), '-map', '0:v:0', '-map', '1:a:0');
    } else {
      args.push('-map', '0:v:0');
    }
    const out = path.join(dir, 'final.mp4');
    await run([...args, '-c', 'copy', '-movflags', '+faststart', '-y', out]);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  probeVideo, segmentCount, transcodeSegment, transcodeAudio, joinParts,
  VideoError, MAX_SECONDS, SEGMENT_SECONDS, PRESETS,
};
