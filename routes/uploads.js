'use strict';
const router = require('express').Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { authenticate, requirePerm } = require('../middleware/auth');
const log = require('../lib/logger');

router.use(authenticate);
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

router.post('/quiz-xlsx', requirePerm('perm_edit_curriculum'), memUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  res.status(201).json({ id: uuidv4(), category: 'quiz_xlsx', originalName: req.file.originalname, size: req.file.size });
});
router.post('/app-icon', requirePerm('perm_publish_apps'), memUpload.single('icon'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  res.status(201).json({ id: uuidv4(), category: 'app_assets', originalName: req.file.originalname, size: req.file.size });
});
router.post('/app-splash', requirePerm('perm_publish_apps'), memUpload.single('splash'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  res.status(201).json({ id: uuidv4(), category: 'app_assets', originalName: req.file.originalname, size: req.file.size });
});
router.get('/', requirePerm('perm_export_data'), (req, res) => res.json({ data: [], limit: 50, offset: 0 }));
router.get('/file/:id', (req, res) => res.status(404).json({ error: 'File not found' }));
router.delete('/:id', requirePerm('perm_upload_unity'), (req, res) => res.json({ message: 'Upload deleted' }));

module.exports = router;
