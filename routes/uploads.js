'use strict';
const router  = require('express').Router();
const multer  = require('multer');
const { v4: uuidv4 } = require('uuid');
const { authenticate, requirePerm } = require('../middleware/auth');
const storage = require('../lib/storage');
const { getFirestore } = require('../lib/firebase');
const log = require('../lib/logger');

router.use(authenticate);
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

// ── POST /quiz-xlsx — Upload quiz question sheet ──────────────────────────────
router.post('/quiz-xlsx', requirePerm('perm_edit_curriculum'),
  memUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    try {
      const result = await storage.put('quiz_xlsx', req.file.originalname, req.file.buffer);
      const id = uuidv4();
      const doc = {
        id, category: 'quiz_xlsx',
        storage_key: result.key,
        original_name: result.originalName,
        size: result.size,
        content_type: result.contentType,
        uploaded_by: req.user.id,
        created_at: new Date(),
      };
      await getFirestore().collection('uploads').doc(id).set(doc);
      log.info({ id, key: result.key }, 'quiz_xlsx uploaded');
      res.status(201).json(doc);
    } catch (err) {
      log.error({ err: err.message }, 'quiz_xlsx upload failed');
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

// ── POST /app-icon — Upload state app icon ────────────────────────────────────
router.post('/app-icon', requirePerm('perm_publish_apps'),
  memUpload.single('icon'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    try {
      const result = await storage.put('app_assets', req.file.originalname, req.file.buffer);
      const id = uuidv4();
      const doc = {
        id, category: 'app_assets', asset_type: 'icon',
        storage_key: result.key,
        original_name: result.originalName,
        size: result.size,
        uploaded_by: req.user.id,
        created_at: new Date(),
      };
      await getFirestore().collection('uploads').doc(id).set(doc);
      res.status(201).json(doc);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

// ── POST /app-splash — Upload state app splash screen ────────────────────────
router.post('/app-splash', requirePerm('perm_publish_apps'),
  memUpload.single('splash'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    try {
      const result = await storage.put('app_assets', req.file.originalname, req.file.buffer);
      const id = uuidv4();
      const doc = {
        id, category: 'app_assets', asset_type: 'splash',
        storage_key: result.key,
        original_name: result.originalName,
        size: result.size,
        uploaded_by: req.user.id,
        created_at: new Date(),
      };
      await getFirestore().collection('uploads').doc(id).set(doc);
      res.status(201).json(doc);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

// ── GET /  — List recent uploads ─────────────────────────────────────────────
router.get('/', requirePerm('perm_export_data'), async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('uploads').orderBy('created_at', 'desc').limit(50).get();
    res.json({ data: snap.docs.map(d => ({ id: d.id, ...d.data() })), limit: 50, offset: 0 });
  } catch (_) {
    res.json({ data: [], limit: 50, offset: 0 });
  }
});

// ── GET /file/:storageKey — Serve a stored file ───────────────────────────────
// storageKey is URL-encoded. In dev this streams from local disk.
// In prod (GCS/R2) this returns a signed URL redirect.
router.get('/file/:key(*)', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const stream = await storage.getStream(key);
    stream.pipe(res);
  } catch (err) {
    res.status(err.status || 404).json({ error: 'File not found' });
  }
});

// ── DELETE /:id — Remove upload record and file ───────────────────────────────
router.delete('/:id', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('uploads').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Upload not found' });
    await storage.delete(doc.data().storage_key).catch(() => {});
    await doc.ref.delete();
    res.json({ message: 'Upload deleted' });
  } catch (_) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
