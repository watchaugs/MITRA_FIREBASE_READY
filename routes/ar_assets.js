'use strict';
const router  = require('express').Router();
// Express 4 doesn't catch a rejected async handler (the request would hang
// until the 60 s Hosting timeout); caught() passes it to the error handler.
const caught = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const multer  = require('multer');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { compressGlb, MODEL_SPECS, estimateOutputs, QUALITY_PRESETS } = require('../lib/draco');
const { toGlb, needsConversion } = require('../lib/modelConvert');
const storage          = require('../lib/storage');
const { authenticate, requirePerm } = require('../middleware/auth');
const { visibleInState, parseTargetStates } = require('../lib/stateScope');
const { unknownStates, UNKNOWN_STATE_MSG } = require('../lib/states');
const { isAppCaller, isReleased, cleanRelease, mergeStateRelease } = require('../lib/release');
const { stripFields } = require('../lib/writeGuard');
const log = require('../lib/logger');
const { transcodeNarration } = require('../lib/audioTranscode');
const bhashini = require('../lib/bhashini');
const vt = require('../lib/videoTranscode');
// NOTE: fs and UPLOAD_DIR removed — all file I/O now goes through lib/storage.js
// In dev (no STORAGE_BUCKET set): files save to ./uploads/ on local disk
// In prod (STORAGE_BUCKET set):   files save to GCS bucket → later swapped to R2

const ALLOWED_EXTENSIONS = new Set(['.unitypackage','.assetbundle','.unity','.glb','.gltf','.fbx','.obj','.zip','.png','.jpg','.jpeg','.webp','.mind','.mp3','.aac','.m4a','.wav','.ogg','.mp4','.webm','.mov','.m4v']);
const arUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    ALLOWED_EXTENSIONS.has(ext) ? cb(null, true) : cb(new Error(`Unsupported: ${ext}`));
  }
});

// ── GET /file/:name ─── public read of a stored AR file (model / audio / mind) ─
// model_viewer_plus and the in-app WebView fetch these URLs directly, with no
// Authorization header, so this route is mounted BEFORE authenticate. Keys are
// confined to the ar_assets/ prefix and the name is sanitised against traversal.
const AR_FILE_TYPES = {
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.mind': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.m4a': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
};
router.get('/file/:name', async (req, res) => {
  try {
    const name = String(req.params.name || '');
    if (!name || name.includes('/') || name.includes('..') || name.includes('\\')) {
      return res.status(400).json({ error: 'Bad file name' });
    }
    const ext = path.extname(name).toLowerCase();
    const contentType = AR_FILE_TYPES[ext];
    if (!contentType) return res.status(400).json({ error: 'Unsupported file type' });
    const key = `ar_assets/${name}`;

    // Common headers — the video/audio player needs Accept-Ranges to know it may seek.
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Accept-Ranges', 'bytes');

    // Parse an optional "Range: bytes=START-END" request from the player.
    const parseRange = (header, size) => {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
      if (!m) return null;
      let start = m[1] === '' ? null : parseInt(m[1], 10);
      let end   = m[2] === '' ? null : parseInt(m[2], 10);
      if (start == null && end == null) return null;
      if (start == null) { start = size - end; end = size - 1; }   // suffix: last N bytes
      else if (end == null || end >= size) { end = size - 1; }
      if (!(start >= 0) || start > end) return null;
      return { start, end };
    };

    let total;
    try {
      // Peek size first (cheap) so we can answer a Range correctly.
      const head = await storage.statStream(key, {});
      total = head.size;
      // We only needed the size; drop this probe stream.
      if (head.stream && head.stream.destroy) head.stream.destroy();
    } catch (e) {
      res.set('Cache-Control', 'no-store');
      return res.status(404).json({ error: 'File not found' });
    }

    const range = parseRange(req.headers.range, total);
    if (range) {
      const { start, end } = range;
      const { stream } = await storage.statStream(key, { start, end });
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${total}`);
      res.set('Content-Length', String(end - start + 1));
      stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
      return stream.pipe(res);
    }

    // No Range → whole file.
    const { stream } = await storage.statStream(key, {});
    res.set('Content-Length', String(total));
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    stream.pipe(res);
  } catch (err) {
    log.error({ err: err.message }, 'AR file serve failed');
    if (!res.headersSent) res.status(500).json({ error: 'Failed to serve file' });
  }
});


router.use(authenticate);

// GET /model-specs — recommended model specifications, shown in the dashboard
// uploader so people export AR-safe models the first time (and returned in the
// error when an upload is rejected for being unprocessable).
router.get('/model-specs', (req, res) => res.json(MODEL_SPECS));

// POST /estimate — dry run. Upload the model, get predicted output per quality
// level (triangles, approx MB, peak memory) WITHOUT storing or publishing
// anything. Powers the "preview before upload" dropdown. Fast: triangle math
// only, no compression.
router.post('/estimate', requirePerm('perm_upload_unity'),
  (req, res, next) => arUpload.single('model')(req, res, err => err ? res.status(400).json({ error: err.message }) : next()),
  (req, res) => {
    const model = req.file;
    if (!model) return res.status(400).json({ error: 'No model file uploaded' });
    const ext = path.extname(model.originalname).toLowerCase();
    if (ext !== '.glb' && ext !== '.gltf') {
      return res.status(400).json({ error: 'Model must be .glb/.gltf (convert FBX/OBJ in the browser first)' });
    }
    try {
      const est = estimateOutputs(model.buffer);
      res.json({ ok: true, filename: model.originalname, quality_presets: QUALITY_PRESETS, ...est });
    } catch (e) {
      res.status(422).json({ error: e.message || 'Could not analyze model', recommended_specs: MODEL_SPECS });
    }
  });

router.post('/upload', requirePerm('perm_upload_unity'),
  (req, res, next) => arUpload.single('file')(req, res, err => err ? res.status(400).json({ error: err.message }) : next()),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const badStates = unknownStates(parseTargetStates(req.body.target_states));
    if (badStates.length) return res.status(400).json({ error: UNKNOWN_STATE_MSG(badStates) });
    const { class_name, subject, topic, language, title } = req.body;
    const id  = uuidv4();
    const ext = path.extname(req.file.originalname).toLowerCase();

    // ── Draco compression + persistent storage ────────────────────────────
    // Files go through lib/storage.js:
    //   dev  → local ./uploads/ar_assets/
    //   prod → GCS bucket (or R2 once wired into storage.js)
    let compression   = null;
    let unity_url     = null;
    let flutter_url   = null;
    let native_url    = null;

    const MODEL_EXTS = ['.glb', '.gltf', '.fbx', '.obj', '.dae', '.stl', '.ply', '.3ds', '.zip'];
    if (MODEL_EXTS.includes(ext)) {
      try {
        const glbBuffer = needsConversion(ext)
          ? await toGlb(req.file.buffer, req.file.originalname)
          : req.file.buffer;
        compression = await compressGlb(glbBuffer);

        // Only the lite GLB is served to the app. (unity_url retired — the
        // heavier Draco tier was never consumed by the student app.)
        const flutterKey = `ar_assets/${id}_lite.glb`;
        await storage.putRaw(compression.flutter, flutterKey, { contentType: 'model/gltf-binary' });
        flutter_url = process.env.R2_PUBLIC_URL
          ? `${process.env.R2_PUBLIC_URL}/${flutterKey}`
          : `/api/ar/file/${id}_lite.glb`;

        // Native (NON-Draco) GLB → floor-AR renderer (Filament can't read Draco).
        const nativeKey = `ar_assets/${id}_native.glb`;
        await storage.putRaw(compression.native, nativeKey, { contentType: 'model/gltf-binary' });
        native_url = process.env.R2_PUBLIC_URL
          ? `${process.env.R2_PUBLIC_URL}/${nativeKey}`
          : `/api/ar/file/${id}_native.glb`;

      } catch (convErr) {
        return res.status(422).json({ error: convErr.message || 'Model conversion/compression failed', detail: convErr.message, recommended_specs: MODEL_SPECS });
      }
    }

    const doc = {
      id,
      title:         title || req.file.originalname,
      class_name,
      subject,
      topic,
      language,
      original_name: req.file.originalname,
      file_format:   ext.replace('.', ''),
      file_size_mb:  (req.file.size / 1024 / 1024).toFixed(2),
      status:        'uploaded',
      target_states: parseTargetStates(req.body.target_states),
      uploaded_by:   req.user.id,
      created_at:    new Date(),
      // compression stats — null for non-GLB uploads
      compression: compression ? {
        original_mb: compression.originalMb,
        unity_mb:    compression.unityMb,
        flutter_mb:  compression.flutterMb,
        ratio:       ((1 - compression.unity.length / req.file.size) * 100).toFixed(1) + '%',
      } : null,
      unity_url,
      flutter_url,
      native_url,
    };

    try {
      const db = getFirestore();
      // Strip undefined fields — Firestore rejects them
      const cleanDoc = Object.fromEntries(
        Object.entries(doc).filter(([, v]) => v !== undefined)
      );
      await db.collection('ar_assets').doc(id).set(cleanDoc);
    } catch (err) {
      log.error({ err: err.message }, 'AR asset Firestore write failed — file uploaded but not recorded');
      return res.status(500).json({ error: 'Upload saved the file but failed to record it. Please retry.' });
    }
    res.status(201).json({ message: 'AR Asset uploaded', asset: doc });
  }
);

// ── Rich AR upload ──────────────────────────────────────────────────────────
// Accepts a model (GLB — already converted from FBX/OBJ in the admin's browser),
// plus an optional textbook-page image, narration audio, and a compiled MindAR
// .mind target (also produced in the browser). Heavy processing stays client-
// side, so Cloud Run only stores the finished files + records the asset.
// ═══════════════════════════════════════════════════════════════════════════
// Page-scan video — the browser uploads straight to the bucket, then the API
// converts it in short steps (each well under Firebase Hosting's 60 s cut-off):
//   POST /video/start            → job_id + signed PUT link
//   (browser PUTs the file to the link; dev/local: POST /video/:job/source)
//   POST /video/:job/probe       → length, size, sound?  (rejects > 5 min)
//   POST /video/:job/segment/:n  → converts 20 s of picture
//   POST /video/:job/audio       → converts the sound
//   POST /video/:job/finish      → joins the pieces (no re-encode)
// Then upload-rich (video_job) or POST /assets/:id/video attaches the result.
// Temp files live under ar_uploads_tmp/<job>/ (bucket lifecycle clears leftovers).
// ═══════════════════════════════════════════════════════════════════════════
const VIDEO_TMP = 'ar_uploads_tmp';
const VIDEO_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.3gp': 'video/3gpp',
};
const MAX_VIDEO_UPLOAD_MB = 1024;
const JOB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const jobKey = (job, name) => `${VIDEO_TMP}/${job}/${name}`;
const segName = (n) => `v${String(n).padStart(3, '0')}.mp4`;
const arPub = (key) => process.env.R2_PUBLIC_URL
  ? `${process.env.R2_PUBLIC_URL}/${key}`
  : `/api/ar/file/${key.replace('ar_assets/', '')}`;

async function loadVideoJob(jobId, userId) {
  if (!JOB_RE.test(String(jobId || ''))) { const e = new Error('Bad video job id'); e.status = 400; throw e; }
  let job;
  try { job = JSON.parse((await storage.getBuffer(jobKey(jobId, 'job.json'))).toString('utf8')); }
  catch (_) { const e = new Error('Video job not found or expired. Choose the video again.'); e.status = 404; throw e; }
  if (job.created_by !== userId) { const e = new Error('This video job belongs to another user'); e.status = 403; throw e; }
  return job;
}
const saveVideoJob = (job) => storage.putRaw(Buffer.from(JSON.stringify(job)), jobKey(job.job_id, 'job.json'), { contentType: 'application/json' });
async function purgeVideoJob(job) {
  const names = ['job.json', 'final.mp4', 'a.m4a', path.basename(job.src_key || '')];
  for (let n = 0; n < (job.segments || 0); n++) names.push(segName(n));
  for (const n of names) { if (n) { try { await storage.delete(jobKey(job.job_id, n)); } catch (_) { /* ignore */ } } }
}
function videoErr(res, e, fallback) {
  const status = e.status || (e instanceof vt.VideoError ? (e.status || 422) : 500);
  if (status >= 500) log.error({ err: e.message }, fallback);
  return res.status(status).json({ error: status >= 500 ? fallback : e.message, detail: status >= 500 ? e.message : undefined });
}
// Wrap a job step: loads + checks the job, maps errors to clean responses.
const videoStep = (fallback, fn) => async (req, res) => {
  try {
    const job = await loadVideoJob(req.params.job, req.user.id);
    return await fn(req, res, job);
  } catch (e) { return videoErr(res, e, fallback); }
};

router.post('/video/start', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const name = String(req.body?.filename || '').slice(0, 200);
    const ext = path.extname(name).toLowerCase();
    const contentType = VIDEO_TYPES[ext];
    if (!contentType) return res.status(400).json({ error: `Unsupported video type "${ext || '?'}". Use MP4, MOV or WebM.` });
    const sizeMb = Number(req.body?.size || 0) / 1048576;
    if (!(sizeMb > 0)) return res.status(400).json({ error: 'Missing file size' });
    if (sizeMb > MAX_VIDEO_UPLOAD_MB) return res.status(413).json({ error: `Video is larger than ${MAX_VIDEO_UPLOAD_MB} MB` });
    const quality = String(req.body?.quality) === '720' ? '720' : '480';
    const job = {
      job_id: uuidv4(), created_by: req.user.id, created_at: new Date().toISOString(),
      original_name: path.basename(name), content_type: contentType, size_mb: +sizeMb.toFixed(2), quality,
    };
    job.src_key = jobKey(job.job_id, `source${ext}`);
    const uploadUrl = await storage.signedUploadUrl(job.src_key, { contentType });
    await saveVideoJob(job);
    res.json({
      job_id: job.job_id, upload_url: uploadUrl, method: 'PUT', headers: { 'Content-Type': contentType },
      max_seconds: vt.MAX_SECONDS, segment_seconds: vt.SEGMENT_SECONDS,
    });
  } catch (e) { return videoErr(res, e, 'Could not start the video upload'); }
});

// Fallback when the storage has no direct-upload link (local disk in dev).
// Through Cloud Run this is limited to ~32 MB.
router.post('/video/:job/source', requirePerm('perm_upload_unity'),
  (req, res, next) => arUpload.single('file')(req, res, err => err ? res.status(400).json({ error: err.message }) : next()),
  videoStep('Could not store the video', async (req, res, job) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    await storage.putRaw(req.file.buffer, job.src_key, { contentType: job.content_type });
    res.json({ ok: true });
  }));

router.post('/video/:job/probe', requirePerm('perm_upload_unity'), videoStep('Could not read the video', async (req, res, job) => {
  if (!(await storage.exists(job.src_key))) return res.status(409).json({ error: 'The upload has not finished yet' });
  const info = await vt.probeVideo(await storage.inputUrl(job.src_key));
  if (info.duration > vt.MAX_SECONDS) {
    await purgeVideoJob(job);
    return res.status(422).json({ error: `Video is ${Math.round(info.duration)} s long. The limit is ${vt.MAX_SECONDS / 60} minutes — trim it and upload again.` });
  }
  Object.assign(job, info, { segments: vt.segmentCount(info.duration) });
  await saveVideoJob(job);
  res.json({ duration: job.duration, width: job.width, height: job.height, has_audio: job.has_audio, segments: job.segments });
}));

router.post('/video/:job/segment/:n', requirePerm('perm_upload_unity'), videoStep('Video conversion failed', async (req, res, job) => {
  const n = Number(req.params.n);
  if (!job.segments) return res.status(409).json({ error: 'Probe the video first' });
  if (!Number.isInteger(n) || n < 0 || n >= job.segments) return res.status(400).json({ error: 'Bad segment number' });
  const buf = await vt.transcodeSegment(await storage.inputUrl(job.src_key), n, { quality: job.quality });
  await storage.putRaw(buf, jobKey(job.job_id, segName(n)), { contentType: 'video/mp4' });
  res.json({ n, segments: job.segments });
}));

router.post('/video/:job/audio', requirePerm('perm_upload_unity'), videoStep('Video sound conversion failed', async (req, res, job) => {
  if (!job.segments) return res.status(409).json({ error: 'Probe the video first' });
  if (!job.has_audio) return res.json({ skipped: true });
  const buf = await vt.transcodeAudio(await storage.inputUrl(job.src_key), { duration: job.duration });
  await storage.putRaw(buf, jobKey(job.job_id, 'a.m4a'), { contentType: 'audio/mp4' });
  res.json({ ok: true });
}));

router.post('/video/:job/finish', requirePerm('perm_upload_unity'), videoStep('Could not join the video', async (req, res, job) => {
  if (!job.segments) return res.status(409).json({ error: 'Probe the video first' });
  const parts = [];
  for (let n = 0; n < job.segments; n++) {
    const k = jobKey(job.job_id, segName(n));
    if (!(await storage.exists(k))) return res.status(409).json({ error: `Piece ${n + 1} of ${job.segments} is missing — convert it first` });
    parts.push(await storage.getBuffer(k));
  }
  let audio = null;
  if (job.has_audio) {
    const ak = jobKey(job.job_id, 'a.m4a');
    if (!(await storage.exists(ak))) return res.status(409).json({ error: 'The sound has not been converted yet' });
    audio = await storage.getBuffer(ak);
  }
  const out = await vt.joinParts(parts, audio);
  await storage.putRaw(out, jobKey(job.job_id, 'final.mp4'), { contentType: 'video/mp4' });
  job.status = 'ready';
  job.final_mb = +(out.length / 1048576).toFixed(2);
  await saveVideoJob(job);
  // Pieces are no longer needed; the source stays until the video is attached.
  for (let n = 0; n < job.segments; n++) { try { await storage.delete(jobKey(job.job_id, segName(n))); } catch (_) { /* ignore */ } }
  try { await storage.delete(jobKey(job.job_id, 'a.m4a')); } catch (_) { /* ignore */ }
  res.json({ ready: true, size_mb: job.final_mb, duration: job.duration, quality: job.quality });
}));

// Copies a finished job's MP4 onto the asset, removes the temp files, and
// returns the fields to store. ?v= busts the year-long cache on replace.
async function attachVideoJob(jobId, userId, assetId) {
  const job = await loadVideoJob(jobId, userId);
  if (job.status !== 'ready') { const e = new Error('The video has not finished converting'); e.status = 409; throw e; }
  const buf = await storage.getBuffer(jobKey(job.job_id, 'final.mp4'));
  const key = `ar_assets/${assetId}_video.mp4`;
  await storage.putRaw(buf, key, { contentType: 'video/mp4' });
  for (const old of ['webm', 'mov']) { try { await storage.delete(`ar_assets/${assetId}_video.${old}`); } catch (_) { /* ignore */ } }
  await purgeVideoJob(job);
  return {
    video_url: `${arPub(key)}?v=${Date.now()}`,
    video_mb: job.final_mb, video_duration: job.duration, video_quality: job.quality,
    video_name: job.original_name,
  };
}

// Video placement + sound settings (dashboard form). Only keys present in
// `src` are returned. Throws a 400-style Error on bad input.
function cleanVideoSettings(src = {}) {
  const out = {};
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };
  if (src.video_region !== undefined && src.video_region !== null && src.video_region !== '') {
    let r = src.video_region;
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch (_) { bad('video_region must be JSON {x,y,w,h}'); } }
    const nums = ['x', 'y', 'w', 'h'].map(k => Number(r && r[k]));
    if (nums.some(n => !Number.isFinite(n))) bad('video_region needs numbers x, y, w, h (0–1)');
    let [x, y, w, h] = nums.map(n => Math.min(1, Math.max(0, n)));
    w = Math.min(w, 1 - x); h = Math.min(h, 1 - y);
    if (w < 0.05 || h < 0.05) bad('The video box is too small — make it at least 5% of the page');
    const r4 = (n) => Math.round(n * 10000) / 10000;
    out.video_region = { x: r4(x), y: r4(y), w: r4(w), h: r4(h) };
    const pa = Number(r && r.page_aspect);
    if (Number.isFinite(pa) && pa > 0.1 && pa < 10) out.video_region.page_aspect = r4(pa);
  }
  if (src.video_sound !== undefined) {
    if (!['video', 'narration'].includes(src.video_sound)) bad('video_sound must be "video" or "narration"');
    out.video_sound = src.video_sound;
  }
  if (src.video_default_view !== undefined) {
    if (!['3d', 'video'].includes(src.video_default_view)) bad('video_default_view must be "3d" or "video"');
    out.video_default_view = src.video_default_view;
  }
  return out;
}

router.post('/upload-rich', requirePerm('perm_upload_unity'),
  (req, res, next) => arUpload.fields([
    { name: 'model', maxCount: 1 },
    { name: 'image', maxCount: 1 },
    { name: 'audio', maxCount: 1 },
    { name: 'mind',  maxCount: 1 },
    { name: 'video', maxCount: 1 },
  ])(req, res, err => err ? res.status(400).json({ error: err.message }) : next()),
  async (req, res) => {
    const files = req.files || {};
    const model = files.model && files.model[0];
    const videoJob = String(req.body.video_job || '').trim();
    // Raw videos no longer pass through here (32 MB request cap) — the
    // dashboard uploads them via /video/start and sends video_job.
    if (files.video && files.video[0]) {
      return res.status(400).json({ error: 'Send the video through /api/ar/video/start (direct upload), then pass video_job' });
    }
    if (!model && !videoJob) return res.status(400).json({ error: 'Add a 3D model, a page video, or both' });
    // The video plays ON the textbook page, so it needs the page target.
    if (videoJob && !(files.mind && files.mind[0])) {
      return res.status(400).json({ error: 'A page video needs the textbook page image (it plays on that page)' });
    }
    let videoSettings;
    try { videoSettings = cleanVideoSettings(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    const badStates = unknownStates(parseTargetStates(req.body.target_states));
    if (badStates.length) return res.status(400).json({ error: UNKNOWN_STATE_MSG(badStates) });

    const { class_name, subject, topic, language, title } = req.body;
    const id  = uuidv4();
    const ext = model ? path.extname(model.originalname).toLowerCase() : '';

    // The browser converts FBX/OBJ → GLB before upload, so the model is GLB here.
    if (model && ext !== '.glb' && ext !== '.gltf') {
      return res.status(400).json({ error: 'Model must be .glb/.gltf (convert FBX/OBJ in the browser first)' });
    }

    let compression = null, unity_url = null, flutter_url = null, native_url = null;
    if (model) try {
      compression = await compressGlb(model.buffer, { quality: req.body.quality });
      // Only the lite GLB is served to the app (unity_url retired).
      const flutterKey = `ar_assets/${id}_lite.glb`;
      await storage.putRaw(compression.flutter, flutterKey, { contentType: 'model/gltf-binary' });
      flutter_url = process.env.R2_PUBLIC_URL ? `${process.env.R2_PUBLIC_URL}/${flutterKey}` : `/api/ar/file/${id}_lite.glb`;

      // Native (NON-Draco) GLB → floor-AR renderer (Filament can't read Draco).
      const nativeKey = `ar_assets/${id}_native.glb`;
      await storage.putRaw(compression.native, nativeKey, { contentType: 'model/gltf-binary' });
      native_url = process.env.R2_PUBLIC_URL ? `${process.env.R2_PUBLIC_URL}/${nativeKey}` : `/api/ar/file/${id}_native.glb`;

      // Keep the ORIGINAL uploaded GLB too, so a future backfill / re-process can
      // rebuild any tier from the true source (not from an already-simplified
      // derivative). Costs a little storage; saves a lot of rework later.
      const originalKey = `ar_assets/${id}_original.glb`;
      await storage.putRaw(model.buffer, originalKey, { contentType: 'model/gltf-binary' });
    } catch (compressionErr) {
      return res.status(422).json({ error: compressionErr.message || 'Model could not be prepared for AR', detail: compressionErr.message, recommended_specs: MODEL_SPECS });
    }

    // Store an optional side file (image / audio / mind) and return its public URL.
    const storeSide = async (file, keySuffix, contentType) => {
      if (!file) return null;
      const key = `ar_assets/${id}_${keySuffix}`;
      await storage.putRaw(file.buffer, key, { contentType });
      return process.env.R2_PUBLIC_URL ? `${process.env.R2_PUBLIC_URL}/${key}` : `/api/ar/file/${id}_${keySuffix}`;
    };

    let target_image_url = null, audio_url = null, mind_url = null;
    try {
      const img = files.image && files.image[0];
      const aud = files.audio && files.audio[0];
      const mnd = files.mind  && files.mind[0];
      const imgExt = img ? path.extname(img.originalname).toLowerCase() : '.png';
      const audExt = aud ? path.extname(aud.originalname).toLowerCase() : '.mp3';
      target_image_url = await storeSide(img, `target${imgExt}`, imgExt === '.jpg' || imgExt === '.jpeg' ? 'image/jpeg' : (imgExt === '.webp' ? 'image/webp' : 'image/png'));
      audio_url        = await storeSide(aud, `audio${audExt}`,  audExt === '.aac' || audExt === '.m4a' ? 'audio/aac' : (audExt === '.wav' ? 'audio/wav' : (audExt === '.ogg' ? 'audio/ogg' : 'audio/mpeg')));
      mind_url         = await storeSide(mnd, 'targets.mind', 'application/octet-stream');
    } catch (sideErr) {
      return res.status(500).json({ error: 'Failed to store AR side files', detail: sideErr.message });
    }

    // Page video: copy the converted MP4 from its finished job.
    let video = null;
    if (videoJob) {
      try { video = await attachVideoJob(videoJob, req.user.id, id); }
      catch (e) { return res.status(e.status || 500).json({ error: e.status ? e.message : 'Failed to attach the video', detail: e.message }); }
    }

    const doc = {
      id,
      title:         title || (model ? model.originalname : (video && video.video_name) || 'Page video'),
      class_name, subject, topic, language,
      original_name: model ? model.originalname : (video && video.video_name) || null,
      file_format:   model ? ext.replace('.', '') : 'mp4',
      file_size_mb:  model ? (model.size / 1024 / 1024).toFixed(2) : String(video ? video.video_mb : 0),
      status:        'uploaded',
      target_states: parseTargetStates(req.body.target_states),
      uploaded_by:   req.user.id,
      created_at:    new Date(),
      compression: compression ? {
        original_mb: compression.originalMb,
        unity_mb:    compression.unityMb,
        flutter_mb:  compression.flutterMb,
        ratio:       ((1 - compression.unity.length / model.size) * 100).toFixed(1) + '%',
      } : null,
      unity_url,
      flutter_url,
      native_url,
      // ── New AR fields consumed by the in-app engine ──
      target_image_url,
      audio_url,
      mind_url,
      video_url:     video ? video.video_url : null,
      // Page video: where it sits on the page (0–1 of the page, from the top-
      // left; whole page if not drawn), whose sound plays, which view opens.
      ...(video ? {
        video_mb: video.video_mb, video_duration: video.video_duration, video_quality: video.video_quality,
        video_region: videoSettings.video_region || { x: 0, y: 0, w: 1, h: 1 },
        video_sound: videoSettings.video_sound || 'video',
        video_default_view: model ? (videoSettings.video_default_view || '3d') : 'video',
      } : {}),
      // Green-screen (ChromaKey) settings for the AR video plane, from the form.
      chroma_enabled: req.body.chroma_enabled === 'true' || req.body.chroma_enabled === true,
      chroma_color:   req.body.chroma_color || '#00ff00',
      ar_mode: mind_url ? 'marker' : 'overlay', // hint for the app's tier router
    };

    try {
      const db = getFirestore();
      const cleanDoc = Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined));
      await db.collection('ar_assets').doc(id).set(cleanDoc);
    } catch (err) {
      log.error({ err: err.message }, 'Rich AR asset Firestore write failed — files stored but not recorded');
      return res.status(500).json({ error: 'Upload saved the files but failed to record it. Please retry.' });
    }
    res.status(201).json({ message: 'AR Asset uploaded', asset: doc });
  }
);

// Lesson ids a student may get: the ones in their own state's manifest (own
// registered state, open, on its Curriculum Map, released) — same rule as
// /api/curriculum/manifest and /ar-topics.
async function studentLessonIds(db, req) {
  const m = await require('./curriculum').servedManifest(db, req, req.query.state);
  const ids = new Set();
  for (const c of (m.classes || [])) for (const sj of (c.subjects || [])) for (const t of (sj.topics || [])) {
    for (const l of (t.ar_lessons || [])) ids.add(l.id);
  }
  return ids;
}

router.get('/assets', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('ar_assets').limit(100).get();
    let rows   = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (isAppCaller(req)) {
      const ids = await studentLessonIds(db, req);
      rows = rows.filter(r => r.status === 'published' && ids.has(r.id));
    } else {
      rows = visibleInState(rows, req.query.state); // geofence: national + requested state
    }
    return res.json({ data: rows, total: rows.length });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load AR assets');
    return res.status(500).json({ error: 'Failed to load AR assets' });
  }
});

router.get('/topics', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('ar_assets').where('status', '==', 'published').limit(200).get();
    let rows   = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (isAppCaller(req)) {
      const ids = await studentLessonIds(db, req);
      rows = rows.filter(r => ids.has(r.id));
    } else {
      rows = visibleInState(rows, req.query.state); // geofence: national + requested state
    }
    return res.json(rows.map(r => ({
      id:          r.id,
      topic:       r.topic       || '',
      class_name:  r.class_name  || '',
      subject:     r.subject     || '',
      language:    r.language    || 'English',
      status:      r.status      || 'live',
      unity_url:   r.unity_url   || null,
      flutter_url: r.flutter_url || null,
      native_url:  r.native_url  || null,
      audio_url:        r.audio_url        || null,
      audios:           r.audios           || {},   // { lang: url } multi-language narration
      mind_url:         r.mind_url         || null,
      target_image_url: r.target_image_url || null,
      video_url:        r.video_url        || null,
      video_region:     r.video_region     || null,
      video_sound:      r.video_sound      || null,
      video_default_view: r.video_default_view || null,
      chroma_enabled:   r.chroma_enabled   === true,
      chroma_color:     r.chroma_color     || null,
      ar_mode:          r.ar_mode          || null,
    })));
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load AR topics');
    return res.status(500).json({ error: 'Failed to load AR topics' });
  }
});

router.get('/assets/:id', async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('ar_assets').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Asset not found' });
    // Students: only a lesson their own state's list shows.
    if (isAppCaller(req) && !(await studentLessonIds(db, req)).has(doc.id)) {
      return res.status(404).json({ error: 'Asset not found' });
    }
    return res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load AR asset');
    return res.status(500).json({ error: 'Failed to load asset' });
  }
});

router.put('/assets/:id', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const db = getFirestore();
    // Never let an uploader set system/workflow fields via the body (status,
    // release, ownership, URLs). Publishing/releasing have their own guarded routes.
    const safe = stripFields(req.body, [
      'id', 'status', 'release', 'uploaded_by', 'created_at', 'created_by',
      'flutter_url', 'native_url', 'unity_url', 'file_size_mb', 'compression',
      'published_at', 'published_by', 'submitted_by', 'submitted_at',
      'release_updated_by', 'release_updated_at',
      // Video file fields change only through POST/DELETE /assets/:id/video.
      'video_url', 'video_mb', 'video_duration', 'video_quality',
    ]);
    try { Object.assign(safe, cleanVideoSettings(safe)); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (safe.video_region === '' || safe.video_region === null) delete safe.video_region;
    // Edits save codes too ("Gujarat" → "GJ"), the same as a new upload.
    if ('target_states' in safe) safe.target_states = parseTargetStates(safe.target_states);
    const badEdit = unknownStates(safe.target_states || []);
    if (badEdit.length) return res.status(400).json({ error: UNKNOWN_STATE_MSG(badEdit) });
    await db.collection('ar_assets').doc(req.params.id).update({ ...safe, updated_at: new Date() });
    await invalidateManifests(db);
    res.json({ id: req.params.id, ...safe });
  } catch { res.status(500).json({ error: 'Failed to update asset' }); }
});

// Download the original uploaded GLB (stored at upload, never served until now).
router.get('/assets/:id/original', requirePerm('perm_upload_unity'), async (req, res) => {
  const key = `ar_assets/${req.params.id}_original.glb`;
  try {
    if (!(await storage.exists(key))) return res.status(404).json({ error: 'No original on file for this asset' });
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}_original.glb"`);
    (await storage.createReadStream(key)).pipe(res);
  } catch (e) { res.status(500).json({ error: 'Failed to read original', detail: e.message }); }
});

// All stored file keys an asset could own — single source of truth for deletes.
function assetFileKeys(id, a = {}) {
  const base = `ar_assets/${id}`;
  const keys = [
    `${base}_lite.glb`, `${base}_native.glb`, `${base}_original.glb`,
    `${base}_targets.mind`,
    `${base}_target.png`, `${base}_target.jpg`, `${base}_target.jpeg`, `${base}_target.webp`,
    `${base}_video.mp4`, `${base}_video.webm`, `${base}_video.mov`,
  ];
  const langs = new Set([...Object.keys(a.audios || {}), ...Object.keys(a.audios_aac || {})]);
  const audioExts = ['.opus', '.m4a', '.mp3', '.aac', '.wav', '.ogg'];
  for (const lang of langs) for (const ext of audioExts) keys.push(`${base}_audio_${lang}${ext}`);
  if (a.audio_url) for (const ext of audioExts) keys.push(`${base}_audio${ext}`);
  return keys;
}

async function purgeAssetFiles(id, a) {
  for (const k of assetFileKeys(id, a)) { try { await storage.delete(k); } catch (_) { /* ignore */ } }
}

// ── Deletion guards — a government content system must never orphan live media.
// A published/scheduled/in-review asset is LOCKED and must be unpublished first.
// A narration file referenced by any asset cannot be discarded.
const LIVE_STATUSES = ['published', 'scheduled', 'review'];
function assetDeletionBlock(a) {
  if (!a) return null;
  if (LIVE_STATUSES.includes(a.status)) {
    return { status: a.status,
      reason: `This asset is "${a.status}". Live or pending content cannot be deleted directly.`,
      steps: ['1. Open this asset and set its status to Draft (Unpublish).',
        '2. If it is released in any state, clear its Release settings first.',
        '3. Once it shows "draft" / "uploaded", delete it again.'] };
  }
  return null;
}
async function narrationInUse(db, url) {
  if (!url) return [];
  const snap = await db.collection('ar_assets').limit(1000).get();
  const users = [];
  snap.forEach(d => { const a = d.data() || {};
    const urls = [a.audio_url, ...Object.values(a.audios || {}), ...Object.values(a.audios_aac || {})];
    if (urls.includes(url)) users.push({ id: d.id, title: a.title || a.original_name || d.id, status: a.status });
  });
  return users;
}

// Immediate delete. The UI gets its safety from a type-to-confirm dialog, so the
// backend requires an explicit confirm flag in the body to avoid accidental calls.
router.delete('/assets/:id', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const db  = getFirestore();
    const ref = db.collection('ar_assets').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Asset not found' });
    if (req.body?.confirm !== true && req.body?.confirm !== 'true') {
      return res.status(400).json({ error: 'Delete must be confirmed', hint: 'send { "confirm": true }' });
    }
    const a = doc.data();
    const block = assetDeletionBlock(a);
    if (block) return res.status(409).json({ error: 'Asset is live — cannot delete', locked: true, ...block });
    const purgeAfter = new Date(Date.now() + 30 * 86400000);
    await ref.set({ status: 'archived', prev_status: a.status || 'uploaded', archived_by: req.user.id, archived_at: new Date(), purge_after: purgeAfter }, { merge: true });
    await invalidateManifests(db);
    await db.collection('audit_log').add({ action: 'ar_asset_archived', actor: req.user.id, detail: { asset_id: req.params.id, title: a.title || a.original_name || null }, created_at: new Date() }).catch(() => {});
    res.json({ message: 'Asset moved to recycle bin (30-day recovery)', id: req.params.id, purge_after: purgeAfter });
  } catch (err) { log.error({ err: err.message }, 'AR asset delete failed'); res.status(500).json({ error: 'Failed to delete asset' }); }
});

// Clears cached state manifests so the app sees content changes on next launch.
async function invalidateManifests(db) {
  try {
    const snap = await db.collection('curriculum_manifests').get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  } catch (e) { log.error({ err: e.message }, 'invalidateManifests failed — app may serve stale content'); return false; }
  return true;
}

router.post('/assets/:id/publish', requirePerm('perm_approve_content'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('ar_assets').doc(req.params.id).update({ status: 'published', published_by: req.user.id, published_at: new Date(), updated_at: new Date() });
    await invalidateManifests(db);
    res.json({ message: 'Asset published' });
  } catch { res.status(500).json({ error: 'Publish failed' }); }
});

router.post('/assets/:id/unpublish', requirePerm('perm_approve_content'), async (req, res) => {
  try {
    const db = getFirestore();
    const ref = db.collection('ar_assets').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Asset not found' });
    const a = doc.data();
    if (a.published_by && a.published_by === req.user.id) {
      return res.status(409).json({ error: 'Two-person rule', locked: true, reason: 'You published this asset — a different approver must take it down.', steps: ['Ask another user with approval rights to unpublish it.', 'This protects live government content from unilateral takedown.'] });
    }
    await ref.update({ status: 'draft', unpublished_by: req.user.id, unpublished_at: new Date(), updated_at: new Date() });
    await invalidateManifests(db);
    await db.collection('audit_log').add({ action: 'ar_asset_unpublished', actor: req.user.id, detail: { asset_id: req.params.id, was: a.status }, created_at: new Date() }).catch(() => {});
    res.json({ message: 'Asset unpublished — now a draft and deletable', id: req.params.id });
  } catch (e) { res.status(500).json({ error: 'Unpublish failed', detail: e.message }); }
});

router.post('/assets/:id/restore', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const db = getFirestore();
    const ref = db.collection('ar_assets').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Asset not found' });
    const a = doc.data();
    if (a.status !== 'archived') return res.status(400).json({ error: 'Asset is not in the recycle bin' });
    const { FieldValue } = require('firebase-admin/firestore');
    await ref.update({ status: a.prev_status || 'draft', restored_by: req.user.id, restored_at: new Date(), archived_by: FieldValue.delete(), archived_at: FieldValue.delete(), purge_after: FieldValue.delete(), prev_status: FieldValue.delete() });
    await invalidateManifests(db);
    res.json({ message: 'Asset restored', id: req.params.id, status: a.prev_status || 'draft' });
  } catch (e) { res.status(500).json({ error: 'Restore failed', detail: e.message }); }
});

router.delete('/assets/:id/purge', requirePerm('perm_approve_content'), async (req, res) => {
  try {
    const db = getFirestore();
    const ref = db.collection('ar_assets').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Asset not found' });
    const a = doc.data();
    if (a.status !== 'archived') return res.status(409).json({ error: 'Only archived assets can be purged — delete (archive) it first' });
    if (req.body?.confirm !== true && req.body?.confirm !== 'true') return res.status(400).json({ error: 'Purge must be confirmed', hint: 'send { "confirm": true }' });
    await purgeAssetFiles(req.params.id, a);
    await ref.delete();
    await db.collection('audit_log').add({ action: 'ar_asset_purged', actor: req.user.id, detail: { asset_id: req.params.id }, created_at: new Date() }).catch(() => {});
    res.json({ message: 'Asset permanently deleted', id: req.params.id });
  } catch (e) { res.status(500).json({ error: 'Purge failed', detail: e.message }); }
});

// Mark an asset "scheduled" (coming soon). Students see it greyed/locked in the
// app as a teaser (Rule 3), but it is not yet openable. Publish it later to go live.
router.post('/assets/:id/schedule', requirePerm('perm_approve_content'), async (req, res) => {
  try {
    const db = getFirestore();
    const patch = { status: 'scheduled', published_by: req.user.id, published_at: new Date(), updated_at: new Date() };
    // Optional reveal date: when it passes, the topic list auto-publishes this
    // asset on the next read (no scheduler). Omit for an indefinite teaser.
    const raw = req.body && req.body.reveal_date;
    if (raw) {
      const d = new Date(raw);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'reveal_date is not a valid date' });
      patch.reveal_date = d;
    }
    await db.collection('ar_assets').doc(req.params.id).update(patch);
    await invalidateManifests(db);
    res.json({ message: 'Asset scheduled (coming soon)', reveal_date: patch.reveal_date || null });
  } catch { res.status(500).json({ error: 'Schedule failed' }); }
});

router.post('/assets/:id/review', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    await getFirestore().collection('ar_assets').doc(req.params.id)
      .update({ status: 'review', submitted_by: req.user.id, submitted_at: new Date() });
    res.json({ success: true, message: 'Submitted for review' });
  } catch { res.status(500).json({ error: 'Could not submit for review' }); }
});

// ── PUT /assets/:id/release-state ─── release in ONE state (Curriculum page) ─
router.put('/assets/:id/release-state', requirePerm('perm_approve_content'), async (req, res) => {
  try {
    const db = getFirestore();
    const ref = db.collection('ar_assets').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Asset not found' });
    const release = cleanRelease(mergeStateRelease(doc.data().release, req.body?.state, req.body?.value));
    await ref.update({ release, release_updated_by: req.user.id, release_updated_at: new Date() });
    await invalidateManifests(db);
    res.json({ success: true, id: req.params.id, release });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save release' });
  }
});

// ── PUT /assets/:id/release ─── when students may see this lesson ───────────
router.put('/assets/:id/release', requirePerm('perm_approve_content'), async (req, res) => {
  try {
    const release = cleanRelease(req.body && req.body.release);
    const db = getFirestore();
    const ref = db.collection('ar_assets').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ error: 'Asset not found' });
    await ref.update({ release, release_updated_by: req.user.id, release_updated_at: new Date() });
    await invalidateManifests(db);
    await db.collection('audit_log').add({ action: 'ar_release_set', actor: req.user.id, detail: { asset_id: req.params.id, release }, created_at: new Date() });
    res.json({ success: true, id: req.params.id, release });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save release' });
  }
});

router.post('/links', requirePerm('perm_edit_curriculum'), async (req, res) => {
  res.status(201).json({ message: 'AR asset linked', link: { id: uuidv4(), ...req.body } });
});
router.delete('/links/:linkId', requirePerm('perm_edit_curriculum'), async (req, res) => {
  res.json({ message: 'AR link removed' });
});
router.get('/links/:nodeId', async (req, res) => { res.json([]); });

// ── Attach / replace a per-LANGUAGE narration audio on an existing asset ──────
// Multi-language narration: one model, many audios keyed by language. Stored at
// ar_assets/{id}_audio_{lang}.{ext}; the asset's `audios` map gets { lang: url }.
// The FIRST language also mirrors to audio_url/language so single-audio app
// builds keep working.
router.post('/assets/:id/audio', requirePerm('perm_upload_unity'),
  (req, res, next) => arUpload.single('audio')(req, res, err => err ? res.status(400).json({ error: err.message }) : next()),
  async (req, res) => {
    const { id } = req.params;
    const lang = (req.body.language || '').trim().toLowerCase();
    if (!id)        return res.status(400).json({ error: 'Missing asset id' });
    if (!lang)      return res.status(400).json({ error: 'Missing language code' });
    if (!req.file)  return res.status(400).json({ error: 'No audio file uploaded' });

    // Transcode to Opus (default) + AAC (fallback); keep original as last-resort.
    const origExt = path.extname(req.file.originalname).toLowerCase() || '.mp3';
    const pub = (suffix) => process.env.R2_PUBLIC_URL
      ? `${process.env.R2_PUBLIC_URL}/ar_assets/${id}_audio_${lang}${suffix}`
      : `/api/ar/file/${id}_audio_${lang}${suffix}`;
    let url, urlOpus = null, urlAac = null;
    try {
      let opus, aac;
      try {
        ({ opus, aac } = await transcodeNarration(req.file.buffer));
      } catch (tcErr) {
        log.warn({ err: tcErr.message, id, lang }, 'Audio transcode failed — storing original only');
      }
      if (opus && aac) {
        await storage.putRaw(opus, `ar_assets/${id}_audio_${lang}.opus`, { contentType: 'audio/ogg' });
        await storage.putRaw(aac,  `ar_assets/${id}_audio_${lang}.m4a`,  { contentType: 'audio/aac' });
        urlOpus = pub('.opus');
        urlAac  = pub('.m4a');
        url = urlOpus; // app prefers Opus, falls back to AAC
      } else {
        const ct = origExt === '.aac' || origExt === '.m4a' ? 'audio/aac'
                 : origExt === '.wav' ? 'audio/wav'
                 : origExt === '.ogg' ? 'audio/ogg' : 'audio/mpeg';
        await storage.putRaw(req.file.buffer, `ar_assets/${id}_audio_${lang}${origExt}`, { contentType: ct });
        url = pub(origExt);
      }
    } catch (e) {
      return res.status(500).json({ error: 'Failed to store language audio', detail: e.message });
    }

    try {
      const db  = getFirestore();
      const ref = db.collection('ar_assets').doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'AR asset not found' });
      const data   = snap.data() || {};
      const audios = { ...(data.audios || {}), [lang]: url };
      const audios_aac = { ...(data.audios_aac || {}), [lang]: urlAac || url };
      const update = { audios, audios_aac };
      if (!data.audio_url) { update.audio_url = url; update.language = lang; }
      await ref.set(update, { merge: true });
      await invalidateManifests(db); // phones get the new language on their next read
      return res.json({ message: 'Language audio saved', id, language: lang, url, audios });
    } catch (e) {
      return res.status(500).json({ error: 'Audio stored but asset update failed', detail: e.message });
    }
  }
);

// ── Remove a per-language audio ───────────────────────────────────────────────
router.delete('/assets/:id/audio/:lang', requirePerm('perm_upload_unity'), async (req, res) => {
  const { id, lang } = req.params;
  try {
    const db  = getFirestore();
    const ref = db.collection('ar_assets').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'AR asset not found' });
    const block = assetDeletionBlock(snap.data());
    if (block) return res.status(409).json({ error: 'Asset is live — unpublish before changing its narration', locked: true, ...block });
    const audios = { ...((snap.data() || {}).audios || {}) };
    const audiosAac = { ...((snap.data() || {}).audios_aac || {}) };
    const lk = (lang || '').toLowerCase();
    const targetUrl = audios[lk];
    // Library narration (nlib_…) is shared and never deleted here — unlinking
    // it from THIS asset must not depend on other assets using the same file.
    if (targetUrl && !String(targetUrl).includes('nlib_')) {
      const others = (await narrationInUse(db, targetUrl)).filter(u => u.id !== id);
      if (others.length) {
        return res.status(409).json({
          error: 'Narration in use by other assets — cannot delete',
          locked: true,
          used_by: others,
          steps: ['This audio file is associated with other asset(s).', 'Remove it from those assets (or unpublish them) before deleting it here.'],
        });
      }
    }
    delete audios[lk];
    delete audiosAac[lk];
    await ref.set({ audios, audios_aac: audiosAac }, { merge: true });
    await invalidateManifests(db); // phones drop the language on their next read
    return res.json({ message: 'Language audio removed', id, lang, audios });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to remove language audio', detail: e.message });
  }
});

// ── Bhashini health-check (verify keys from the dashboard with one click) ─────
router.get('/bhashini/health', requirePerm('perm_upload_unity'), async (req, res) => {
  if (!bhashini.isConfigured()) return res.json({ configured: false, message: 'Bhashini keys not set in environment' });
  try {
    await bhashini.getConfig('tts', 'hi'); // a cheap config call proves the keys work
    return res.json({ configured: true, ok: true, message: 'Bhashini keys valid' });
  } catch (e) {
    return res.json({ configured: true, ok: false, message: 'Keys set but call failed', detail: e.message });
  }
});

// ── Available TTS voices for a language (dynamic dropdown) ─────────────────────
router.get('/bhashini/voices/:lang', requirePerm('perm_upload_unity'), caught(async (req, res) => {
  const voices = await bhashini.ttsVoices((req.params.lang || '').toLowerCase());
  res.json({ lang: req.params.lang, voices });
}));

// ── Generate narration with Bhashini for one or more languages ────────────────
// body: { languages: ['hi','gu',...], text: '...' | texts: {hi:'...',gu:'...'}, gender }
// Generates TTS → transcodes Opus+AAC → stores → updates audios/audios_aac.
// Languages with no voice are returned in `needs_manual` for manual upload.
router.post('/assets/:id/narration', requirePerm('perm_upload_unity'), async (req, res) => {
  const { id } = req.params;
  if (!bhashini.isConfigured()) return res.status(503).json({ error: 'Bhashini not configured' });
  const db  = getFirestore();
  const ref = db.collection('ar_assets').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'Asset not found' });
  const data = snap.data();
  const languages = Array.isArray(req.body.languages) ? req.body.languages.map(l => String(l).toLowerCase()) : [];
  const texts = req.body.texts || {};
  const singleText = req.body.text || '';
  const gender = (req.body.gender || 'female').toLowerCase();
  if (!languages.length) return res.status(400).json({ error: 'No languages given' });

  const pub = (k) => process.env.R2_PUBLIC_URL ? `${process.env.R2_PUBLIC_URL}/${k}` : `/api/ar/file/${k.replace('ar_assets/', '')}`;
  const audios = { ...(data.audios || {}) }, audios_aac = { ...(data.audios_aac || {}) };
  const done = [], needs_manual = [], failed = [];

  for (const lang of languages) {
    const text = (texts[lang] || singleText || '').trim();
    if (!text) { failed.push({ lang, error: 'no text' }); continue; }
    try {
      // No usable voice makes tts() throw → caught below as needs_manual.
      const { audio } = await bhashini.tts(text, lang, { gender });
      let opus, aac;
      try { ({ opus, aac } = await transcodeNarration(audio)); }
      catch (tc) { failed.push({ lang, error: 'transcode: ' + tc.message }); continue; }
      await storage.putRaw(opus, `ar_assets/${id}_audio_${lang}.opus`, { contentType: 'audio/ogg' });
      await storage.putRaw(aac,  `ar_assets/${id}_audio_${lang}.m4a`,  { contentType: 'audio/aac' });
      audios[lang] = pub(`ar_assets/${id}_audio_${lang}.opus`);
      audios_aac[lang] = pub(`ar_assets/${id}_audio_${lang}.m4a`);
      done.push(lang);
    } catch (e) {
      if (String(e.message).includes('No audio') || String(e.message).toLowerCase().includes('voice')) {
        needs_manual.push(lang);           // no usable voice → prompt manual upload
      } else {
        failed.push({ lang, error: e.message });
      }
    }
  }

  const engine = { ...(data.audio_engine || {}) };
  done.forEach(l => { engine[l] = 'bhashini'; });
  await ref.set({ audios, audios_aac, audio_engine: engine, updated_at: new Date() }, { merge: true });
  await invalidateManifests(db);
  res.json({ message: 'Narration generated', id, done, needs_manual, failed, audios });
});


// ═══════════════════════════════════════════════════════════════════════════
// Phase 3e — Replace a single media file in place
//   field = model | image | video | audio   (audio needs ?language=xx in body)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/assets/:id/replace', requirePerm('perm_upload_unity'),
  (req, res, next) => arUpload.single('file')(req, res, err => err ? res.status(400).json({ error: err.message }) : next()),
  async (req, res) => {
    const { id } = req.params;
    const field = (req.body.field || '').toLowerCase();
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const db  = getFirestore();
    const ref = db.collection('ar_assets').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Asset not found' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const pub = (k) => process.env.R2_PUBLIC_URL ? `${process.env.R2_PUBLIC_URL}/${k}` : `/api/ar/file/${k.replace('ar_assets/', '')}`;
    try {
      if (field === 'model') {
        if (ext !== '.glb' && ext !== '.gltf') return res.status(400).json({ error: 'Model must be .glb/.gltf' });
        const compression = await compressGlb(req.file.buffer, { quality: req.body.quality });
        await storage.putRaw(compression.flutter, `ar_assets/${id}_lite.glb`, { contentType: 'model/gltf-binary' });
        await storage.putRaw(compression.native,  `ar_assets/${id}_native.glb`, { contentType: 'model/gltf-binary' });
        await storage.putRaw(req.file.buffer,      `ar_assets/${id}_original.glb`, { contentType: 'model/gltf-binary' });
        // Set the URLs too, so a video-only asset gains its 3D model here.
        // ?v= makes phones fetch the new file (the old one is cached for a year).
        const v = `?v=${Date.now()}`;
        await ref.set({ flutter_url: pub(`ar_assets/${id}_lite.glb`) + v, native_url: pub(`ar_assets/${id}_native.glb`) + v,
          file_format: 'glb', updated_at: new Date() }, { merge: true });
        await invalidateManifests(db);
        return res.json({ message: 'Model replaced', id });
      }
      if (field === 'image') {
        const ct = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
        const key = `ar_assets/${id}_target${ext}`;
        await storage.putRaw(req.file.buffer, key, { contentType: ct });
        await ref.set({ target_image_url: pub(key), updated_at: new Date() }, { merge: true });
        await invalidateManifests(db);
        return res.json({ message: 'Image replaced', id, url: pub(key) });
      }
      if (field === 'video') {
        return res.status(400).json({ error: 'Videos are converted first — use the 🎬 Video button (POST /assets/:id/video)' });
      }
      if (field === 'audio') {
        const lang = (req.body.language || '').trim().toLowerCase();
        if (!lang) return res.status(400).json({ error: 'Missing language for audio replace' });
        let opus, aac;
        try { ({ opus, aac } = await transcodeNarration(req.file.buffer)); } catch (e) { return res.status(422).json({ error: 'Audio transcode failed', detail: e.message }); }
        await storage.putRaw(opus, `ar_assets/${id}_audio_${lang}.opus`, { contentType: 'audio/ogg' });
        await storage.putRaw(aac,  `ar_assets/${id}_audio_${lang}.m4a`,  { contentType: 'audio/aac' });
        const data = snap.data();
        const audios = { ...(data.audios || {}), [lang]: pub(`ar_assets/${id}_audio_${lang}.opus`) };
        const audios_aac = { ...(data.audios_aac || {}), [lang]: pub(`ar_assets/${id}_audio_${lang}.m4a`) };
        await ref.set({ audios, audios_aac, updated_at: new Date() }, { merge: true });
        await invalidateManifests(db);
        return res.json({ message: 'Audio replaced', id, language: lang, audios, audios_aac });
      }
      return res.status(400).json({ error: `Unknown field "${field}" (model|image|video|audio)` });
    } catch (e) { return res.status(500).json({ error: 'Replace failed', detail: e.message }); }
  }
);

// ── Add/replace (POST {video_job, ...settings}) or remove (DELETE) the page
// video of an existing asset. Needs the page target (.mind) to exist.
router.post('/assets/:id/video', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const db = getFirestore();
    const ref = db.collection('ar_assets').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Asset not found' });
    const a = snap.data() || {};
    if (!a.mind_url) return res.status(409).json({ error: 'This asset has no textbook page image yet. A page video plays on the page — upload the asset with its page image first.' });
    let settings;
    try { settings = cleanVideoSettings(req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
    const video = await attachVideoJob(req.body?.video_job, req.user.id, req.params.id);
    delete video.video_name;
    const hasModel = !!(a.flutter_url || a.native_url);
    const update = {
      ...video,
      video_region: settings.video_region || a.video_region || { x: 0, y: 0, w: 1, h: 1 },
      video_sound: settings.video_sound || a.video_sound || 'video',
      video_default_view: hasModel ? (settings.video_default_view || a.video_default_view || '3d') : 'video',
      updated_at: new Date(),
    };
    await ref.set(update, { merge: true });
    await invalidateManifests(db);
    await db.collection('audit_log').add({ action: 'ar_video_set', actor: req.user.id, detail: { asset_id: req.params.id, mb: video.video_mb }, created_at: new Date() }).catch(() => {});
    res.json({ message: 'Video saved', id: req.params.id, ...update });
  } catch (e) { return videoErr(res, e, 'Failed to save the video'); }
});

router.delete('/assets/:id/video', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const db = getFirestore();
    const ref = db.collection('ar_assets').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Asset not found' });
    const a = snap.data() || {};
    if (!a.flutter_url && !a.native_url) {
      return res.status(409).json({ error: 'This asset has only the video (no 3D model). Delete the whole asset instead.' });
    }
    const { FieldValue } = require('firebase-admin/firestore');
    const del = FieldValue.delete();
    await ref.update({ video_url: null, video_mb: del, video_duration: del, video_quality: del,
      video_region: del, video_sound: del, video_default_view: del, updated_at: new Date() });
    for (const e of ['mp4', 'webm', 'mov']) { try { await storage.delete(`ar_assets/${req.params.id}_video.${e}`); } catch (_) { /* ignore */ } }
    await invalidateManifests(db);
    await db.collection('audit_log').add({ action: 'ar_video_removed', actor: req.user.id, detail: { asset_id: req.params.id }, created_at: new Date() }).catch(() => {});
    res.json({ message: 'Video removed', id: req.params.id });
  } catch (e) { return videoErr(res, e, 'Failed to remove the video'); }
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3e — Regenerate derivatives from stored sources
//   kind = model (re-run Draco from _original.glb) | transcode (re-encode audio)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/assets/:id/regenerate', requirePerm('perm_upload_unity'), caught(async (req, res) => {
  const { id } = req.params;
  const kind = (req.body.kind || '').toLowerCase();
  const db  = getFirestore();
  const ref = db.collection('ar_assets').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'Asset not found' });
  const a = snap.data();
  const pub = (k) => process.env.R2_PUBLIC_URL ? `${process.env.R2_PUBLIC_URL}/${k}` : `/api/ar/file/${k.replace('ar_assets/', '')}`;
  const readKey = async (key) => {
    const chunks = [];
    await new Promise((ok, no) => (storage.createReadStream(key)).on('data', c => chunks.push(c)).on('end', ok).on('error', no));
    return Buffer.concat(chunks);
  };
  try {
    if (kind === 'model') {
      const okey = `ar_assets/${id}_original.glb`;
      if (!(await storage.exists(okey))) return res.status(409).json({ error: 'No original GLB stored to rebuild from' });
      const compression = await compressGlb(await readKey(okey), { quality: req.body.quality });
      await storage.putRaw(compression.flutter, `ar_assets/${id}_lite.glb`,   { contentType: 'model/gltf-binary' });
      await storage.putRaw(compression.native,  `ar_assets/${id}_native.glb`, { contentType: 'model/gltf-binary' });
      await ref.set({ updated_at: new Date() }, { merge: true });
      await invalidateManifests(db);
      return res.json({ message: 'Model regenerated from original', id });
    }
    if (kind === 'transcode') {
      const langs = Object.keys(a.audios || {});
      const done = [];
      for (const lang of langs) {
        let srcKey = null;
        for (const e of ['.wav', '.mp3', '.m4a', '.opus']) {
          const k = `ar_assets/${id}_audio_${lang}${e}`;
          if (await storage.exists(k)) { srcKey = k; break; }
        }
        if (!srcKey) continue;
        let opus, aac;
        try { ({ opus, aac } = await transcodeNarration(await readKey(srcKey))); } catch (_) { continue; }
        await storage.putRaw(opus, `ar_assets/${id}_audio_${lang}.opus`, { contentType: 'audio/ogg' });
        await storage.putRaw(aac,  `ar_assets/${id}_audio_${lang}.m4a`,  { contentType: 'audio/aac' });
        done.push(lang);
      }
      const audios = { ...(a.audios || {}) }, audios_aac = { ...(a.audios_aac || {}) };
      for (const lang of done) { audios[lang] = pub(`ar_assets/${id}_audio_${lang}.opus`); audios_aac[lang] = pub(`ar_assets/${id}_audio_${lang}.m4a`); }
      await ref.set({ audios, audios_aac, updated_at: new Date() }, { merge: true });
      await invalidateManifests(db);
      return res.json({ message: 'Audio re-transcoded', id, languages: done });
    }
    if (kind === 'nmt') {
      if (!bhashini.isConfigured()) return res.status(503).json({ error: 'Bhashini not configured' });
      const src = (req.body.source_lang || 'en').toLowerCase();
      const targets = (Array.isArray(req.body.target_langs) ? req.body.target_langs : []).map(l => String(l).toLowerCase());
      const text = req.body.text || '';
      const out = {};
      for (const t of targets) { try { out[t] = await bhashini.translate(text, src, t); } catch (e) { out[t] = null; } }
      const narration_text = { ...(a.narration_text || {}), ...out };
      await ref.set({ narration_text, updated_at: new Date() }, { merge: true });
      return res.json({ message: 'Narration text translated', id, narration_text });
    }
    return res.status(400).json({ error: `Unknown kind "${kind}" (model|transcode|nmt)` });
  } catch (e) { return res.status(500).json({ error: 'Regenerate failed', detail: e.message }); }
}));

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3f — Bulk actions   action = delete | publish
// ═══════════════════════════════════════════════════════════════════════════
router.post('/assets/bulk', requirePerm('perm_upload_unity'), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const action = (req.body.action || '').toLowerCase();
  if (!ids.length) return res.status(400).json({ error: 'No ids given' });
  const db = getFirestore();
  const results = [];
  for (const id of ids) {
    try {
      const ref = db.collection('ar_assets').doc(id);
      const snap = await ref.get();
      if (!snap.exists) { results.push({ id, ok: false, error: 'not found' }); continue; }
      if (action === 'delete') {
        const block = assetDeletionBlock(snap.data());
        if (block) { results.push({ id, ok: false, error: `locked (${block.status}) — unpublish first` }); continue; }
        await purgeAssetFiles(id, snap.data());
        await ref.delete();
        results.push({ id, ok: true });
      } else if (action === 'publish') {
        await ref.set({ status: 'published', published_at: new Date(), published_by: req.user.id }, { merge: true });
        results.push({ id, ok: true });
      } else {
        results.push({ id, ok: false, error: `unsupported bulk action "${action}"` });
      }
    } catch (e) { results.push({ id, ok: false, error: e.message }); }
  }
  await invalidateManifests(db);
  res.json({ action, results });
});

// ── Region → allowed narration languages (admin-configurable) ─────────────────
// Firestore language_config/regions = { "gujarat": ["gu"], "tamil nadu": ["ta"] }
// hi + en are universal (merged by the app), so config lists only the EXTRAS.
router.get('/language-config', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('language_config').doc('regions').get();
    const saved = snap.exists ? (snap.data().regions || snap.data() || {}) : {};
    // Every state always gets its own language (Punjab → pa), keyed by name
    // AND code. Nothing ever saved language_config, so every state got only
    // hi + en and the app hid Punjabi / Gujarati / … narration.
    const { STATE_PRIMARY } = require('../lib/stateLang');
    const { toCode } = require('../lib/states');
    const regions = {};
    const add = (k, langs) => {
      const key = String(k || '').trim().toLowerCase();
      if (!key) return;
      regions[key] = [...new Set([...(regions[key] || []), ...langs.map(l => String(l).toLowerCase())])];
    };
    for (const [name, lang] of Object.entries(STATE_PRIMARY)) {
      if (lang === 'hi' || lang === 'en') continue;
      add(name, [lang]);
      add(toCode(name), [lang]);
    }
    for (const [k, langs] of Object.entries(saved)) {   // admin-added extras still apply
      if (!Array.isArray(langs)) continue;
      add(k, langs);
      add(toCode(k), langs);
    }
    return res.json({ regions, universal: ['hi', 'en'] });
  } catch (e) {
    return res.json({ regions: {}, universal: ['hi', 'en'] }); // fail-open
  }
});

router.put('/language-config/:region', requirePerm('perm_edit_curriculum'), async (req, res) => {
  const region = (req.params.region || '').trim().toLowerCase();
  const langs  = Array.isArray(req.body.languages) ? req.body.languages.map(s => String(s).toLowerCase()) : [];
  if (!region) return res.status(400).json({ error: 'Missing region' });
  try {
    const db = getFirestore();
    await db.collection('language_config').doc('regions').set({ regions: { [region]: langs } }, { merge: true });
    return res.json({ message: 'Saved', region, languages: langs });
  } catch (e) {
    return res.status(500).json({ error: 'Save failed', detail: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// NARRATION STUDIO — standalone TTS workspace. Generate audio from text in many
// languages into a reusable library (narration_library), preview/approve, then
// associate to any AR asset for publishing. Decoupled from a specific asset.
// ═══════════════════════════════════════════════════════════════════════════

// Bhashini-supported Indian languages for the Studio multi-select.
const STUDIO_LANGUAGES = [
  { code: 'hi', name: 'हिंदी (Hindi)' }, { code: 'en', name: 'English' },
  { code: 'bn', name: 'বাংলা (Bengali)' }, { code: 'mr', name: 'मराठी (Marathi)' },
  { code: 'te', name: 'తెలుగు (Telugu)' }, { code: 'ta', name: 'தமிழ் (Tamil)' },
  { code: 'gu', name: 'ગુજરાતી (Gujarati)' }, { code: 'kn', name: 'ಕನ್ನಡ (Kannada)' },
  { code: 'ml', name: 'മലയാളം (Malayalam)' }, { code: 'pa', name: 'ਪੰਜਾਬੀ (Punjabi)' },
  { code: 'or', name: 'ଓଡ଼ିଆ (Odia)' }, { code: 'as', name: 'অসমীয়া (Assamese)' },
  { code: 'ur', name: 'اردو (Urdu)' }, { code: 'ne', name: 'नेपाली (Nepali)' },
  { code: 'sa', name: 'संस्कृतम् (Sanskrit)' }, { code: 'brx', name: 'बड़ो (Bodo)' },
  { code: 'mni', name: 'ꯃꯤꯇꯩ (Manipuri)' }, { code: 'doi', name: 'डोगरी (Dogri)' },
  { code: 'ks', name: 'کٲشُر (Kashmiri)' }, { code: 'kok', name: 'कोंकणी (Konkani)' },
  { code: 'mai', name: 'मैथिली (Maithili)' }, { code: 'sat', name: 'ᱥᱟᱱᱛᱟᱲᱤ (Santali)' },
  { code: 'sd', name: 'سنڌي (Sindhi)' },
];

// GET /bhashini/languages — the Studio language dropdown (engine-supported set).
// Each language also carries its English name ("Punjabi") — the name used in
// library file names and in the upload pickers, so choosing is unambiguous.
router.get('/bhashini/languages', requirePerm('perm_upload_unity'), (req, res) => {
  res.json({
    languages: STUDIO_LANGUAGES.map(l => ({ ...l, english: langEnglishName(l.code) })),
    configured: bhashini.isConfigured(),
  });
});

// ── Narration naming ─────────────────────────────────────────────────────────
// Readable library name: State_Class9_Biology_HumanHeart_Hindi_F
// (state → "AllIndia" when untagged; voice F/M, or "Upload" for a manual file).
const _pascal = (v) => String(v || '').replace(/[^A-Za-z0-9]+/g, ' ').trim()
  .split(' ').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
function langEnglishName(code) {
  const l = STUDIO_LANGUAGES.find(x => x.code === String(code || '').toLowerCase());
  if (!l) return String(code || '').toUpperCase();
  const m = /\(([^)]+)\)/.exec(l.name);
  return m ? m[1] : l.name; // "हिंदी (Hindi)" → "Hindi"; "English" → "English"
}
function narrationBaseName(t) {
  const cls = String(t.class_name || '').replace(/[^0-9]/g, '');
  const voice = t.voice || (String(t.gender || '').toLowerCase() === 'male' ? 'M' : 'F');
  return [
    _pascal(t.state) || 'AllIndia',
    cls ? 'Class' + cls : '',
    _pascal(t.subject),
    _pascal(t.topic),
    _pascal(langEnglishName(t.language)),
    voice,
  ].filter(Boolean).join('_');
}
// Unique within the library: adds _v2, _v3 … only when the same name exists.
async function uniqueNarrationName(db, base) {
  for (let v = 1; v < 100; v++) {
    const name = v === 1 ? base : `${base}_v${v}`;
    const hit = await db.collection('narration_library').where('name', '==', name).limit(1).get();
    if (hit.empty) return name;
  }
  return `${base}_${Date.now()}`;
}
// Download filename = the library name (older items: rebuilt from tags).
function studioFileName(item, ext) {
  return (item.name || narrationBaseName(item) || 'narration') + (ext || '.m4a');
}

// ── Long-text handling for Bhashini ──────────────────────────────────────────
// Split narration into sentence-sized chunks (~450 chars) so long scripts
// don't hit the engine's request limits; very long sentences are hard-wrapped.
function splitForBhashini(text, max = 450) {
  const sentences = String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?।॥])\s+/);
  const out = [];
  let cur = '';
  for (const sn of sentences) {
    if (!sn) continue;
    if (cur && (cur.length + 1 + sn.length) > max) { out.push(cur); cur = sn; }
    else cur = cur ? cur + ' ' + sn : sn;
    while (cur.length > max) {
      let cut = cur.lastIndexOf(' ', max);
      if (cut < max / 2) cut = max;
      out.push(cur.slice(0, cut).trim());
      cur = cur.slice(cut).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}
// Join several WAV buffers (same format, as Bhashini returns) into one WAV.
function _wavParts(buf) {
  if (!buf || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12, fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = buf.subarray(off, off + 8 + size);
    else if (id === 'data') return fmt ? { fmt, data: buf.subarray(off + 8, Math.min(buf.length, off + 8 + size)) } : null;
    off += 8 + size + (size % 2);
  }
  return null;
}
function concatWav(buffers) {
  if (buffers.length === 1) return buffers[0];
  const parts = buffers.map(_wavParts);
  if (parts.some(p => !p)) throw new Error('Unexpected audio format from Bhashini (not WAV)');
  const data = Buffer.concat(parts.map(p => p.data));
  const fmt = parts[0].fmt;
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(4 + fmt.length + 8 + data.length, 4); head.write('WAVE', 8, 'ascii');
  const dh = Buffer.alloc(8);
  dh.write('data', 0, 'ascii'); dh.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, fmt, dh, data]);
}

// POST /narration-studio/translate — Bhashini NMT for review BEFORE voicing.
// body: { text, source_lang, languages:[] } → { translations:{lang:text}, failed:[] }
// The dashboard calls this one language at a time (keeps each request short).
router.post('/narration-studio/translate', requirePerm('perm_upload_unity'), async (req, res) => {
  if (!bhashini.isConfigured()) return res.status(503).json({ error: 'Bhashini not configured' });
  const b = req.body || {};
  const text = String(b.text || '').trim();
  const src = String(b.source_lang || 'en').toLowerCase();
  const languages = Array.isArray(b.languages) ? [...new Set(b.languages.map(l => String(l).toLowerCase()))] : [];
  if (!text) return res.status(400).json({ error: 'Narration text is required' });
  if (!languages.length) return res.status(400).json({ error: 'Pick at least one language' });
  const chunks = splitForBhashini(text);
  const translations = {}, failed = [];
  for (const lang of languages) {
    if (lang === src) { translations[lang] = text; continue; }
    try {
      const out = [];
      for (const c of chunks) out.push(await bhashini.translate(c, src, lang));
      const joined = out.join(' ').replace(/\s+/g, ' ').trim();
      if (!joined) throw new Error('Empty translation');
      translations[lang] = joined;
    } catch (e) { failed.push({ lang, error: e.message }); }
  }
  res.json({ translations, failed });
});

// POST /narration-studio/generate — text→TTS into the library, one file per language.
// body: { text, texts:{lang:reviewedText}, source_lang, languages:[], gender,
//         class_name, subject, topic, state }
// `texts` carries the reviewed translations; a language without one falls back to `text`.
router.post('/narration-studio/generate', requirePerm('perm_upload_unity'), async (req, res) => {
  if (!bhashini.isConfigured()) return res.status(503).json({ error: 'Bhashini not configured' });
  const b = req.body || {};
  const text = String(b.text || '').trim();
  const texts = (b.texts && typeof b.texts === 'object') ? b.texts : {};
  const languages = Array.isArray(b.languages) ? b.languages.map(l => String(l).toLowerCase()) : [];
  const gender = (b.gender || 'female').toLowerCase();
  if (!text && !Object.keys(texts).length) return res.status(400).json({ error: 'Narration text is required' });
  if (!languages.length) return res.status(400).json({ error: 'Pick at least one language' });

  const db = getFirestore();
  const pub = (k) => process.env.R2_PUBLIC_URL ? `${process.env.R2_PUBLIC_URL}/${k}` : `/api/ar/file/${k.replace('ar_assets/', '')}`;
  const done = [], needs_manual = [], failed = [];

  for (const lang of languages) {
    try {
      const spoken = String(texts[lang] || text).trim();
      if (!spoken) { failed.push({ lang, error: 'No text for this language' }); continue; }
      const wavs = [];
      for (const chunk of splitForBhashini(spoken)) wavs.push((await bhashini.tts(chunk, lang, { gender })).audio);
      const audio = concatWav(wavs);
      let opus, aac;
      try { ({ opus, aac } = await transcodeNarration(audio)); }
      catch (tc) { failed.push({ lang, error: 'transcode: ' + tc.message }); continue; }
      const itemId = uuidv4();
      // Stored under ar_assets/ prefix so the existing /file/:name serve route plays them.
      const baseKey = `ar_assets/nlib_${itemId}_${lang}`;
      await storage.putRaw(opus, `${baseKey}.opus`, { contentType: 'audio/ogg' });
      await storage.putRaw(aac,  `${baseKey}.m4a`,  { contentType: 'audio/aac' });
      const tags = {
        language: lang, gender, class_name: b.class_name || null, subject: b.subject || null,
        topic: b.topic || null, state: b.state || null,
      };
      const item = {
        id: itemId, ...tags, text: spoken,
        source_lang: String(b.source_lang || 'en').toLowerCase(), source_text: text || null,
        name: await uniqueNarrationName(db, narrationBaseName(tags)),
        origin: 'bhashini',
        url: pub(`${baseKey}.opus`), url_aac: pub(`${baseKey}.m4a`),
        status: 'pending', created_by: req.user.id, created_at: new Date(),
      };
      await db.collection('narration_library').doc(itemId).set(item);
      done.push(item);
    } catch (e) {
      if (String(e.message).toLowerCase().includes('voice') || String(e.message).includes('No audio')) needs_manual.push(lang);
      else failed.push({ lang, error: e.message });
    }
  }
  res.json({ message: 'Narration generated', done, needs_manual, failed });
});

// GET /narration-studio/library — list generated items (optional filters).
router.get('/narration-studio/library', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const db = getFirestore();
    const snap = await db.collection('narration_library').limit(500).get();
    let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const { language, subject, topic, status, class_name } = req.query;
    if (class_name) rows = rows.filter(r => String(r.class_name || '').toLowerCase() === String(class_name).toLowerCase());
    if (language) rows = rows.filter(r => String(r.language) === String(language).toLowerCase());
    if (subject)  rows = rows.filter(r => String(r.subject || '').toLowerCase() === String(subject).toLowerCase());
    if (topic)    rows = rows.filter(r => String(r.topic || '').toLowerCase().includes(String(topic).toLowerCase()));
    if (status)   rows = rows.filter(r => String(r.status) === String(status));
    const assetsSnap = await db.collection('ar_assets').limit(1000).get();
    const urlToAssets = {};
    assetsSnap.forEach(d => { const a = d.data() || {}; [a.audio_url, ...Object.values(a.audios || {}), ...Object.values(a.audios_aac || {})].forEach(u => { if (u) (urlToAssets[u] ||= []).push({ id: d.id, title: a.title || a.original_name || d.id, status: a.status }); }); });
    rows = rows.map(r => { const used = [...(urlToAssets[r.url] || []), ...(urlToAssets[r.url_aac] || [])].filter((v, i, arr) => arr.findIndex(x => x.id === v.id) === i); return { ...r, name: r.name || narrationBaseName(r), language_name: langEnglishName(r.language), used_by: used, used_count: used.length }; });
    rows.sort((a, b) => (b.created_at?.toMillis?.() || 0) - (a.created_at?.toMillis?.() || 0));
    res.json({ data: rows, total: rows.length });
  } catch (e) { res.status(500).json({ error: 'Failed to load narration library', detail: e.message }); }
});

// POST /narration-studio/upload — fallback: add a narration file from the local
// drive (mp3/wav/m4a/ogg) to the library, tagged like a generated one. It is
// approved on upload (an admin chose this exact file), so it can be linked
// straight away. multipart: audio + class_name, subject, topic, state, language
router.post('/narration-studio/upload', requirePerm('perm_upload_unity'), arUpload.single('audio'), async (req, res) => {
  try {
    const f = req.file;
    const b = req.body || {};
    const lang = String(b.language || '').toLowerCase();
    if (!f) return res.status(400).json({ error: 'Choose an audio file' });
    if (!STUDIO_LANGUAGES.some(l => l.code === lang)) return res.status(400).json({ error: 'Pick the language of this audio' });
    let item;
    try { item = await saveUploadedNarration(getFirestore(), req, f, lang, b); }
    catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message, detail: e.detail });
      throw e;
    }
    res.json({ message: 'Narration uploaded', item });
  } catch (e) { res.status(500).json({ error: 'Upload failed', detail: e.message }); }
});

// One uploaded file → Opus + AAC → a library item tagged exactly like a
// generated one (language, class, subject, topic, state), named
// State_Class8_Science_HumanAnatomy_Punjabi_Upload, approved at once.
async function saveUploadedNarration(db, req, f, lang, b) {
  let opus, aac;
  try { ({ opus, aac } = await transcodeNarration(f.buffer)); }
  catch (e) {
    const err = new Error('Could not read this audio file');
    err.status = 400; err.detail = e.message;
    throw err;
  }
  const itemId = uuidv4();
  const baseKey = `ar_assets/nlib_${itemId}_${lang}`;
  const pub = (k) => process.env.R2_PUBLIC_URL ? `${process.env.R2_PUBLIC_URL}/${k}` : `/api/ar/file/${k.replace('ar_assets/', '')}`;
  await storage.putRaw(opus, `${baseKey}.opus`, { contentType: 'audio/ogg' });
  await storage.putRaw(aac,  `${baseKey}.m4a`,  { contentType: 'audio/aac' });
  const tags = {
    language: lang, voice: 'Upload', class_name: b.class_name || null, subject: b.subject || null,
    topic: b.topic || null, state: b.state || null,
  };
  const item = {
    id: itemId, ...tags, text: null, origin: 'upload', original_name: f.originalname,
    name: await uniqueNarrationName(db, narrationBaseName(tags)),
    url: pub(`${baseKey}.opus`), url_aac: pub(`${baseKey}.m4a`),
    status: 'approved', approved_by: req.user.id, approved_at: new Date(),
    created_by: req.user.id, created_at: new Date(),
  };
  await db.collection('narration_library').doc(itemId).set(item);
  return item;
}

// POST /narration-studio/upload-multi — several narration files from the local
// drive in one go, each with its own language. multipart: audio (one part per
// file) + languages (JSON array of codes, same order as the files) + class_name,
// subject, topic, state. One file per language per batch. Each file is saved
// like the single upload; one bad file doesn't stop the others.
const MAX_NARRATION_FILES = 25;
router.post('/narration-studio/upload-multi', requirePerm('perm_upload_unity'),
  (req, res, next) => arUpload.array('audio', MAX_NARRATION_FILES)(req, res,
    err => err ? res.status(400).json({ error: err.code === 'LIMIT_UNEXPECTED_FILE' ? `At most ${MAX_NARRATION_FILES} files at a time` : err.message }) : next()),
  async (req, res) => {
    try {
      const files = req.files || [];
      const b = req.body || {};
      let langs = [];
      try { langs = JSON.parse(b.languages || '[]'); } catch (_) { langs = []; }
      langs = Array.isArray(langs) ? langs.map(l => String(l || '').trim().toLowerCase()) : [];
      if (!files.length) return res.status(400).json({ error: 'Choose at least one audio file' });
      if (langs.length !== files.length) return res.status(400).json({ error: 'Give every file its language' });
      const bad = langs.findIndex(l => !STUDIO_LANGUAGES.some(x => x.code === l));
      if (bad >= 0) return res.status(400).json({ error: `Pick the language of "${files[bad].originalname}"` });
      const dup = langs.find((l, i) => langs.indexOf(l) !== i);
      if (dup) return res.status(400).json({ error: `Two files are tagged ${langEnglishName(dup)} — one file per language` });
      if (!b.class_name || !b.subject || !b.topic) return res.status(400).json({ error: 'Class, Subject and Topic are required — they name the files' });
      const db = getFirestore();
      const done = [], failed = [];
      for (let i = 0; i < files.length; i++) {
        try { done.push(await saveUploadedNarration(db, req, files[i], langs[i], b)); }
        catch (e) { failed.push({ file: files[i].originalname, language: langs[i], error: e.message }); }
      }
      res.status(done.length ? 200 : 400).json({
        message: `${done.length} narration file(s) added`, done, failed,
        ...(done.length ? {} : { error: 'No file could be added' }),
      });
    } catch (e) { res.status(500).json({ error: 'Upload failed', detail: e.message }); }
  });

// POST /narration-studio/:itemId/approve — flag reviewed/approved.
router.post('/narration-studio/:itemId/approve', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('narration_library').doc(req.params.itemId).update({ status: 'approved', approved_by: req.user.id, approved_at: new Date() });
    res.json({ message: 'Approved', id: req.params.itemId });
  } catch (e) { res.status(500).json({ error: 'Approve failed', detail: e.message }); }
});

// POST /narration-studio/:itemId/associate — attach a library item to an asset.
// body: { asset_id }. Keeps the library copy (reusable for other assets).
router.post('/narration-studio/:itemId/associate', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const db = getFirestore();
    const item = (await db.collection('narration_library').doc(req.params.itemId).get()).data();
    if (!item) return res.status(404).json({ error: 'Library item not found' });
    const assetId = req.body && req.body.asset_id;
    if (!assetId) return res.status(400).json({ error: 'asset_id required' });
    const ref = db.collection('ar_assets').doc(assetId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Asset not found' });
    const data = snap.data() || {};
    const lang = item.language;
    const audios = { ...(data.audios || {}), [lang]: item.url };
    const audios_aac = { ...(data.audios_aac || {}), [lang]: item.url_aac || item.url };
    const update = { audios, audios_aac };
    if (!data.audio_url) { update.audio_url = item.url; update.language = lang; }
    await ref.set(update, { merge: true });
    await invalidateManifests(db);
    res.json({ message: 'Narration associated to asset', asset_id: assetId, language: lang, audios });
  } catch (e) { res.status(500).json({ error: 'Associate failed', detail: e.message }); }
});

// DELETE /narration-studio/:itemId — discard (removes files + record).
router.delete('/narration-studio/:itemId', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const db = getFirestore();
    const ref = db.collection('narration_library').doc(req.params.itemId);
    const item = (await ref.get()).data();
    if (!item) return res.status(404).json({ error: 'Library item not found' });
    const u1 = await narrationInUse(db, item.url).catch(() => []);
    const u2 = await narrationInUse(db, item.url_aac).catch(() => []);
    const all = [...u1, ...u2].filter((v, i, arr) => arr.findIndex(x => x.id === v.id) === i);
    if (all.length) {
      return res.status(409).json({ error: 'Narration is in use — cannot discard', locked: true, used_by: all,
        reason: `This audio is associated with ${all.length} asset(s).`,
        steps: ['1. Unpublish each listed asset (set status to Draft).',
          '2. Remove this language\'s narration from each of those assets.',
          '3. Then discard this library item.'] });
    }
    for (const ext of ['.opus', '.m4a']) {
      try { await storage.delete(`ar_assets/nlib_${req.params.itemId}_${item.language}${ext}`); } catch (_) {}
    }
    await ref.delete();
    res.json({ message: 'Narration discarded', id: req.params.itemId });
  } catch (e) { res.status(500).json({ error: 'Discard failed', detail: e.message }); }
});

// GET /narration-studio/:itemId/download — friendly-named audio download.
router.get('/narration-studio/:itemId/download', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const db = getFirestore();
    const item = (await db.collection('narration_library').doc(req.params.itemId).get()).data();
    if (!item) return res.status(404).json({ error: 'Library item not found' });
    const key = `ar_assets/nlib_${req.params.itemId}_${item.language}.m4a`;
    if (!(await storage.exists(key))) return res.status(404).json({ error: 'Audio file missing' });
    res.setHeader('Content-Type', 'audio/aac');
    res.setHeader('Content-Disposition', `attachment; filename="${studioFileName(item, '.m4a')}"`);
    (await storage.createReadStream(key)).pipe(res);
  } catch (e) { res.status(500).json({ error: 'Download failed', detail: e.message }); }
});


module.exports = router;