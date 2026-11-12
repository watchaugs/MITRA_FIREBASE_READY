'use strict';
const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { compressGlb, MODEL_SPECS, estimateOutputs, QUALITY_PRESETS } = require('../lib/draco');
const { toGlb, needsConversion } = require('../lib/modelConvert');
const storage          = require('../lib/storage');
const { authenticate, requirePerm } = require('../middleware/auth');
const { visibleInState, parseTargetStates } = require('../lib/stateScope');
const { isAppCaller, isReleased, cleanRelease, mergeStateRelease } = require('../lib/release');
const { stripFields } = require('../lib/writeGuard');
const log = require('../lib/logger');
const { transcodeNarration } = require('../lib/audioTranscode');
const bhashini = require('../lib/bhashini');
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
    if (!model) return res.status(400).json({ error: 'No model file uploaded' });

    const { class_name, subject, topic, language, title } = req.body;
    const id  = uuidv4();
    const ext = path.extname(model.originalname).toLowerCase();

    // The browser converts FBX/OBJ → GLB before upload, so the model is GLB here.
    if (ext !== '.glb' && ext !== '.gltf') {
      return res.status(400).json({ error: 'Model must be .glb/.gltf (convert FBX/OBJ in the browser first)' });
    }

    let compression = null, unity_url = null, flutter_url = null, native_url = null;
    try {
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

    let target_image_url = null, audio_url = null, mind_url = null, video_url = null;
    try {
      const img = files.image && files.image[0];
      const aud = files.audio && files.audio[0];
      const mnd = files.mind  && files.mind[0];
      const vid = files.video && files.video[0];
      const imgExt = img ? path.extname(img.originalname).toLowerCase() : '.png';
      const audExt = aud ? path.extname(aud.originalname).toLowerCase() : '.mp3';
      const vidExt = vid ? path.extname(vid.originalname).toLowerCase() : '.mp4';
      target_image_url = await storeSide(img, `target${imgExt}`, imgExt === '.jpg' || imgExt === '.jpeg' ? 'image/jpeg' : (imgExt === '.webp' ? 'image/webp' : 'image/png'));
      audio_url        = await storeSide(aud, `audio${audExt}`,  audExt === '.aac' || audExt === '.m4a' ? 'audio/aac' : (audExt === '.wav' ? 'audio/wav' : (audExt === '.ogg' ? 'audio/ogg' : 'audio/mpeg')));
      mind_url         = await storeSide(mnd, 'targets.mind', 'application/octet-stream');
      video_url        = await storeSide(vid, `video${vidExt}`, vidExt === '.webm' ? 'video/webm' : (vidExt === '.mov' ? 'video/quicktime' : 'video/mp4'));
    } catch (sideErr) {
      return res.status(500).json({ error: 'Failed to store AR side files', detail: sideErr.message });
    }

    const doc = {
      id,
      title:         title || model.originalname,
      class_name, subject, topic, language,
      original_name: model.originalname,
      file_format:   ext.replace('.', ''),
      file_size_mb:  (model.size / 1024 / 1024).toFixed(2),
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
      video_url,
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

router.get('/assets', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('ar_assets').limit(100).get();
    let rows   = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    rows       = visibleInState(rows, req.query.state); // geofence: national + requested state
    if (isAppCaller(req)) {
      rows = rows.filter(r => r.status === 'published' && isReleased(r, req.query.state || req.user.state));
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
    rows       = visibleInState(rows, req.query.state); // geofence: national + requested state
    if (isAppCaller(req)) rows = rows.filter(r => isReleased(r, req.query.state || req.user.state));
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
    if (doc.exists) return res.json({ id: doc.id, ...doc.data() });
    return res.status(404).json({ error: 'Asset not found' });
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
    ]);
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

// Immediate delete. The UI gets its safety from a type-to-confirm dialog, so the
// backend requires an explicit confirm flag in the body to avoid accidental calls.
router.delete('/assets/:id', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const db  = getFirestore();
    const ref = db.collection('ar_assets').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Asset not found' });
    if (req.body && req.body.confirm !== true && req.body.confirm !== 'true') {
      return res.status(400).json({ error: 'Delete must be confirmed', hint: 'send { "confirm": true }' });
    }
    const a = doc.data();
    await purgeAssetFiles(req.params.id, a);   // best-effort file cleanup (never blocks record delete)
    await ref.delete();
    await invalidateManifests(db);
    await db.collection('audit_log').add({ action: 'ar_asset_deleted', actor: req.user.id, detail: { asset_id: req.params.id, title: a.title || a.original_name || null }, created_at: new Date() }).catch(() => {});
    res.json({ message: 'Asset deleted', id: req.params.id });
  } catch (err) { log.error({ err: err.message }, 'AR asset delete failed'); res.status(500).json({ error: 'Failed to delete asset' }); }
});

// Clears cached state manifests so the app sees content changes on next launch.
async function invalidateManifests(db) {
  try {
    const snap = await db.collection('curriculum_manifests').get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  } catch (e) { /* non-fatal: manifests rebuild on demand */ }
}

router.post('/assets/:id/publish', requirePerm('perm_approve_content'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('ar_assets').doc(req.params.id).update({ status: 'published', updated_at: new Date() });
    await invalidateManifests(db);
    res.json({ message: 'Asset published' });
  } catch { res.status(500).json({ error: 'Publish failed' }); }
});

// Mark an asset "scheduled" (coming soon). Students see it greyed/locked in the
// app as a teaser (Rule 3), but it is not yet openable. Publish it later to go live.
router.post('/assets/:id/schedule', requirePerm('perm_approve_content'), async (req, res) => {
  try {
    const db = getFirestore();
    const patch = { status: 'scheduled', updated_at: new Date() };
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
    const audios = { ...((snap.data() || {}).audios || {}) };
    delete audios[(lang || '').toLowerCase()];
    await ref.set({ audios }, { merge: true });
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
router.get('/bhashini/voices/:lang', requirePerm('perm_upload_unity'), async (req, res) => {
  const voices = await bhashini.ttsVoices((req.params.lang || '').toLowerCase());
  res.json({ lang: req.params.lang, voices });
});

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
      const voices = await bhashini.ttsVoices(lang);
      // If the config lists voices and none exist for this lang → manual fallback.
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
// Phase 3d — Download the original uploaded GLB
// ═══════════════════════════════════════════════════════════════════════════
router.get('/assets/:id/original', requirePerm('perm_upload_unity'), async (req, res) => {
  const key = `ar_assets/${req.params.id}_original.glb`;
  try {
    if (!(await storage.exists(key))) return res.status(404).json({ error: 'No original on file for this asset' });
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}_original.glb"`);
    (await storage.createReadStream(key)).pipe(res);
  } catch (e) { res.status(500).json({ error: 'Failed to read original', detail: e.message }); }
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
        await ref.set({ updated_at: new Date() }, { merge: true });
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
        const ct = ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';
        const key = `ar_assets/${id}_video${ext}`;
        await storage.putRaw(req.file.buffer, key, { contentType: ct });
        await ref.set({ video_url: pub(key), updated_at: new Date() }, { merge: true });
        await invalidateManifests(db);
        return res.json({ message: 'Video replaced', id, url: pub(key) });
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

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3e — Regenerate derivatives from stored sources
//   kind = model (re-run Draco from _original.glb) | transcode (re-encode audio)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/assets/:id/regenerate', requirePerm('perm_upload_unity'), async (req, res) => {
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
});

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
    const regions = snap.exists ? (snap.data().regions || snap.data() || {}) : {};
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

module.exports = router;