'use strict';
const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { compressGlb }  = require('../lib/draco');
const storage          = require('../lib/storage');
const { authenticate, requirePerm } = require('../middleware/auth');
const { visibleInState, parseTargetStates } = require('../lib/stateScope');
const log = require('../lib/logger');
// NOTE: fs and UPLOAD_DIR removed — all file I/O now goes through lib/storage.js
// In dev (no STORAGE_BUCKET set): files save to ./uploads/ on local disk
// In prod (STORAGE_BUCKET set):   files save to GCS bucket → later swapped to R2

const ALLOWED_EXTENSIONS = new Set(['.unitypackage','.assetbundle','.unity','.glb','.gltf','.fbx','.obj','.zip','.png','.jpg','.jpeg','.webp','.mind','.mp3','.aac','.m4a','.wav','.ogg']);
const arUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    ALLOWED_EXTENSIONS.has(ext) ? cb(null, true) : cb(new Error(`Unsupported: ${ext}`));
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

    if (ext === '.glb' || ext === '.gltf') {
      try {
        compression = await compressGlb(req.file.buffer);

        // Only the lite GLB is served to the app. (unity_url retired — the
        // heavier Draco tier was never consumed by the student app.)
        const flutterKey = `ar_assets/${id}_lite.glb`;
        await storage.putRaw(compression.flutter, flutterKey, { contentType: 'model/gltf-binary' });
        flutter_url = process.env.R2_PUBLIC_URL
          ? `${process.env.R2_PUBLIC_URL}/${flutterKey}`
          : `/api/ar/file/${id}_lite.glb`;

      } catch (compressionErr) {
        return res.status(422).json({ error: 'GLB compression failed', detail: compressionErr.message });
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

    let compression = null, unity_url = null, flutter_url = null;
    try {
      compression = await compressGlb(model.buffer);
      // Only the lite GLB is served to the app (unity_url retired).
      const flutterKey = `ar_assets/${id}_lite.glb`;
      await storage.putRaw(compression.flutter, flutterKey, { contentType: 'model/gltf-binary' });
      flutter_url = process.env.R2_PUBLIC_URL ? `${process.env.R2_PUBLIC_URL}/${flutterKey}` : `/api/ar/file/${id}_lite.glb`;
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
      // ── New AR fields consumed by the in-app engine ──
      target_image_url,
      audio_url,
      mind_url,
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
    return res.json(rows.map(r => ({
      id:          r.id,
      topic:       r.topic       || '',
      class_name:  r.class_name  || '',
      subject:     r.subject     || '',
      language:    r.language    || 'English',
      status:      r.status      || 'live',
      unity_url:   r.unity_url   || null,
      flutter_url: r.flutter_url || null,
      audio_url:        r.audio_url        || null,
      mind_url:         r.mind_url         || null,
      target_image_url: r.target_image_url || null,
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
    await db.collection('ar_assets').doc(req.params.id).update({ ...req.body, updated_at: new Date() });
    res.json({ id: req.params.id, ...req.body });
  } catch { res.status(500).json({ error: 'Failed to update asset' }); }
});

router.delete('/assets/:id', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('ar_assets').doc(req.params.id).update({ status: 'archived' });
    res.json({ message: 'Asset archived' });
  } catch { res.status(500).json({ error: 'Failed to archive asset' }); }
});

router.post('/assets/:id/publish', requirePerm('perm_approve_content'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('ar_assets').doc(req.params.id).update({ status: 'published', updated_at: new Date() });
    res.json({ message: 'Asset published' });
  } catch { res.status(500).json({ error: 'Publish failed' }); }
});

router.post('/assets/:id/review', requirePerm('perm_upload_unity'), async (req, res) => {
  res.json({ message: 'Submitted for review' });
});

router.post('/links', requirePerm('perm_edit_curriculum'), async (req, res) => {
  res.status(201).json({ message: 'AR asset linked', link: { id: uuidv4(), ...req.body } });
});
router.delete('/links/:linkId', requirePerm('perm_edit_curriculum'), async (req, res) => {
  res.json({ message: 'AR link removed' });
});
router.get('/links/:nodeId', async (req, res) => { res.json([]); });

module.exports = router;