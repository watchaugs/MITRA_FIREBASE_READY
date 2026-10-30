'use strict';
const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { compressGlb }  = require('../lib/draco');
const { toGlb, needsConversion } = require('../lib/modelConvert');
const storage          = require('../lib/storage');
const { authenticate, requirePerm } = require('../middleware/auth');
const { visibleInState, parseTargetStates } = require('../lib/stateScope');
const { isAppCaller, isReleased, cleanRelease, mergeStateRelease } = require('../lib/release');
const { stripFields } = require('../lib/writeGuard');
const log = require('../lib/logger');
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
        return res.status(422).json({ error: 'Model conversion/compression failed', detail: convErr.message });
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
      compression = await compressGlb(model.buffer);
      // Only the lite GLB is served to the app (unity_url retired).
      const flutterKey = `ar_assets/${id}_lite.glb`;
      await storage.putRaw(compression.flutter, flutterKey, { contentType: 'model/gltf-binary' });
      flutter_url = process.env.R2_PUBLIC_URL ? `${process.env.R2_PUBLIC_URL}/${flutterKey}` : `/api/ar/file/${id}_lite.glb`;

      // Native (NON-Draco) GLB → floor-AR renderer (Filament can't read Draco).
      const nativeKey = `ar_assets/${id}_native.glb`;
      await storage.putRaw(compression.native, nativeKey, { contentType: 'model/gltf-binary' });
      native_url = process.env.R2_PUBLIC_URL ? `${process.env.R2_PUBLIC_URL}/${nativeKey}` : `/api/ar/file/${id}_native.glb`;
    } catch (compressionErr) {
      return res.status(422).json({ error: 'GLB compression failed', detail: compressionErr.message });
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
    res.json({ id: req.params.id, ...safe });
  } catch { res.status(500).json({ error: 'Failed to update asset' }); }
});

router.delete('/assets/:id', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const db  = getFirestore();
    const ref = db.collection('ar_assets').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Asset not found' });
    const a = doc.data();
    // Best-effort delete of the stored files (lite GLB + any side files). Never
    // let a missing file block the record delete.
    const keys = [
      `ar_assets/${req.params.id}_lite.glb`,
      a.mind_url && `ar_assets/${req.params.id}_targets.mind`,
    ].filter(Boolean);
    for (const k of keys) { try { await storage.delete(k); } catch (_) { /* ignore */ } }
    await ref.delete();
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

module.exports = router;