'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { authenticate, requirePerm } = require('../middleware/auth');
router.use(authenticate);

const mockFiles = [
  { id: uuidv4(), app_name: 'MITRA UP',   target_state: 'Uttar Pradesh', platform: 'android', version_name: 'v2.1.4', build_status: 'live',     file_size_mb: 42.7, active_students: 22300, built_by: 'System Admin' },
  { id: uuidv4(), app_name: 'MITRA Maha', target_state: 'Maharashtra',   platform: 'android', version_name: 'v2.1.4', build_status: 'live',     file_size_mb: 44.1, active_students: 20650, built_by: 'System Admin' },
  { id: uuidv4(), app_name: 'MITRA GJ',   target_state: 'Gujarat',       platform: 'android', version_name: 'v2.0.0', build_status: 'building', file_size_mb: null, active_students: 0,     built_by: 'System Admin' },
];

router.get('/files', requirePerm('perm_publish_apps'), async (req, res) => {
  res.json({ data: mockFiles, total: mockFiles.length });
});
router.post('/files', requirePerm('perm_publish_apps'), async (req, res) => {
  res.status(201).json({ success: true, id: uuidv4(), ...req.body, build_status: 'building' });
});
router.get('/states', async (req, res) => {
  res.json([{ code: 'GJ', name: 'Gujarat' }, { code: 'MH', name: 'Maharashtra' }, { code: 'UP', name: 'Uttar Pradesh' }]);
});

module.exports = router;