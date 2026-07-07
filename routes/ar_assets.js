'use strict';
const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { compressGlb }  = require('../lib/draco');
const storage          = require('../lib/storage');
const { authenticate, requirePerm } = require('../middleware/auth');
// NOTE: fs and UPLOAD_DIR removed — all file I/O now goes through lib/storage.js
// In dev (no STORAGE_BUCKET set): files save to ./uploads/ on local disk
// In prod (STORAGE_BUCKET set):   files save to GCS bucket → later swapped to R2

const ALLOWED_EXTENSIONS = new Set(['.unitypackage','.assetbundle','.unity','.glb','.gltf','.fbx','.obj','.zip','.png','.jpg']);
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

        // Save Unity-tier (Draco-heavy) to persistent storage
        const unityKey   = `ar_assets/${id}_draco.glb`;
        const flutterKey = `ar_assets/${id}_lite.glb`;

        await storage.putRaw(compression.unity,   unityKey,   { contentType: 'model/gltf-binary' });
        await storage.putRaw(compression.flutter, flutterKey, { contentType: 'model/gltf-binary' });

        // Build public URLs — storage.js returns CDN-routed paths in prod
        unity_url   = process.env.R2_PUBLIC_URL
          ? `${process.env.R2_PUBLIC_URL}/${unityKey}`
          : `/api/ar/file/${id}_draco.glb`;
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
      console.error('Firestore write failed:', err.message);
    }
    res.status(201).json({ message: 'AR Asset uploaded', asset: doc });
  }
);

router.get('/assets', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('ar_assets').limit(100).get();
    if (!snap.empty) return res.json({ data: snap.docs.map(d => ({ id: d.id, ...d.data() })), total: snap.size });
  } catch (_) {}
  res.json({ data: [], total: 0 });
});

router.get('/topics', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('ar_assets').where('status', '==', 'published').limit(200).get();
    if (!snap.empty) {
      return res.json(snap.docs.map(d => ({
        id:          d.id,
        topic:       d.data().topic       || '',
        class_name:  d.data().class_name  || '',
        subject:     d.data().subject     || '',
        language:    d.data().language    || 'English',
        status:      d.data().status      || 'live',
        unity_url:   d.data().unity_url   || null,
        flutter_url: d.data().flutter_url || null,
      })));
    }
  } catch (_) {}
  res.json([]);
});

router.get('/assets/:id', async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('ar_assets').doc(req.params.id).get();
    if (doc.exists) return res.json({ id: doc.id, ...doc.data() });
  } catch (_) {}
  res.status(404).json({ error: 'Asset not found' });
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
