'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { authenticate, requirePerm } = require('../middleware/auth');
router.use(authenticate);

const mockBuilds = [
  { id: 'build-1', state: 'Gujarat', language: 'Gujarati', version: 'v2.1.4', status: 'live', created_at: new Date().toISOString() },
  { id: 'build-2', state: 'Maharashtra', language: 'Marathi', version: 'v2.1.4', status: 'live', created_at: new Date().toISOString() },
];

router.get('/builds', async (req, res) => res.json({ data: mockBuilds, total: mockBuilds.length }));
router.post('/builds', requirePerm('perm_publish_apps'), async (req, res) => {
  res.status(201).json({ id: uuidv4(), ...req.body, status: 'building', created_at: new Date().toISOString() });
});
router.get('/builds/:id', async (req, res) => {
  const build = mockBuilds.find(b => b.id === req.params.id);
  res.json(build || { id: req.params.id, status: 'unknown' });
});
router.post('/builds/:id/publish', requirePerm('perm_publish_apps'), async (req, res) => {
  res.json({ success: true, message: 'Build published', id: req.params.id });
});
router.get('/skins', async (req, res) => res.json([
  { id: 'default', name: 'MITRA Default', primary: '#6366F1' },
  { id: 'saffron', name: 'MITRA Saffron', primary: '#F59E0B' },
  { id: 'forest',  name: 'MITRA Forest',  primary: '#10B981' },
]));
router.get('/ota-updates', async (req, res) => res.json({ data: [], total: 0 }));
router.post('/ota-updates', requirePerm('perm_publish_apps'), async (req, res) => {
  res.status(201).json({ id: uuidv4(), ...req.body, status: 'queued' });
});
router.get('/state-apps', async (req, res) => res.json({ data: mockBuilds, total: mockBuilds.length }));

module.exports = router;
