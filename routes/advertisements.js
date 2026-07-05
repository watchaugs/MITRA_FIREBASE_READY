'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { authenticate, requirePerm } = require('../middleware/auth');
router.use(authenticate);

const mockAds = [
  { id: 'ad-1', title: 'NCERT Digital Initiative', status: 'live', target_states: ['Gujarat', 'Maharashtra'], impressions: 12400, clicks: 840 },
  { id: 'ad-2', title: 'Skill India Campaign', status: 'live', target_states: ['All'], impressions: 8200, clicks: 560 },
  { id: 'ad-3', title: 'Mid-Day Meal Programme', status: 'paused', target_states: ['Uttar Pradesh'], impressions: 3100, clicks: 210 },
];

router.get('/', async (req, res) => res.json({ data: mockAds, total: mockAds.length }));
router.get('/:id', async (req, res) => {
  const ad = mockAds.find(a => a.id === req.params.id);
  if (!ad) return res.status(404).json({ error: 'Not found' });
  res.json(ad);
});
router.post('/', requirePerm('perm_manage_ads'), async (req, res) => {
  res.status(201).json({ id: uuidv4(), ...req.body, status: 'draft' });
});
router.put('/:id', requirePerm('perm_manage_ads'), async (req, res) => {
  res.json({ id: req.params.id, ...req.body });
});
router.delete('/:id', requirePerm('perm_manage_ads'), async (req, res) => {
  res.json({ message: 'Ad campaign deleted' });
});

router.get('/kpi', async (req, res) => res.json({
  total_impressions: 24300, total_clicks: 1610,
  active_campaigns: 2, ctr: 6.6,
  total_spend: 0, reach: 18400,
}));
router.get('/frequency', async (req, res) => res.json({ cap: 3, window_hours: 24 }));
router.put('/frequency', requirePerm('perm_manage_ads'), async (req, res) => res.json({ success: true, ...req.body }));
router.get('/impressions', async (req, res) => res.json({ data: [], total: 0 }));
router.get('/analytics/overview', async (req, res) => res.json({ impressions: 24300, clicks: 1610, ctr: 6.6, active: 2 }));
router.post('/:id/publish', requirePerm('perm_manage_ads'), async (req, res) => {
  res.json({ message: 'Ad campaign published', id: req.params.id });
});

module.exports = router;
