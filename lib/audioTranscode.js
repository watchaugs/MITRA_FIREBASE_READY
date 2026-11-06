'use strict';
// Speech narration → Opus 32k mono (default) + AAC 64k mono (fallback).
// Runs at publish-time; input is any audio buffer (mp3/wav/etc.).
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { PassThrough } = require('stream');
ffmpeg.setFfmpegPath(ffmpegPath);

function encode(buffer, args, format) {
  return new Promise((resolve, reject) => {
    const input = new PassThrough();
    input.end(buffer);
    const chunks = [];
    const out = new PassThrough();
    out.on('data', c => chunks.push(c));
    out.on('end', () => resolve(Buffer.concat(chunks)));
    out.on('error', reject);
    ffmpeg(input)
      .outputOptions(args)
      .format(format)
      .on('error', reject)
      .pipe(out, { end: true });
  });
}

// Returns { opus: Buffer, aac: Buffer }. Either may throw on a corrupt input.
async function transcodeNarration(buffer) {
  const [opus, aac] = await Promise.all([
    encode(buffer, ['-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-vn'], 'opus'),
    encode(buffer, ['-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-vn'], 'adts'),
  ]);
  return { opus, aac };
}

module.exports = { transcodeNarration };