'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { authenticate, requirePerm } = require('../middleware/auth');
const { getFirestore } = require('../lib/firebase');
router.use(authenticate);

// ── GET /  — List all ad campaigns ───────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('ad_campaigns').orderBy('created_at', 'desc').limit(100).get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ data, total: data.length });
  } catch (_) {
    res.json({ data: [], total: 0 });
  }
});

// ── GET /kpi  — Aggregate stats ───────────────────────────────────────────────
// NOTE: /kpi must be declared BEFORE /:id to avoid Express matching 'kpi' as an id
router.get('/kpi', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('ad_campaigns').get();
    const ads  = snap.docs.map(d => d.data());
    const total_impressions = ads.reduce((s, a) => s + (a.impressions || 0), 0);
    const total_clicks      = ads.reduce((s, a) => s + (a.clicks || 0), 0);
    const active_campaigns  = ads.filter(a => a.status === 'live').length;
    const ctr = total_impressions > 0
      ? parseFloat(((total_clicks / total_impressions) * 100).toFixed(2))
      : 0;
    res.json({ total_impressions, total_clicks, active_campaigns, ctr, total_spend: 0,
      reach: new Set(ads.flatMap(a => a.target_states || [])).size });
  } catch (_) {
    res.json({ total_impressions: 0, total_clicks: 0, active_campaigns: 0, ctr: 0, total_spend: 0, reach: 0 });
  }
});

// ── GET /frequency  — Ad frequency cap settings ───────────────────────────────
router.get('/frequency', async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('ad_settings').doc('frequency').get();
    res.json(doc.exists ? doc.data() : { cap: 3, window_hours: 24 });
  } catch (_) {
    res.json({ cap: 3, window_hours: 24 });
  }
});

// ── PUT /frequency  — Update frequency cap ────────────────────────────────────
router.put('/frequency', requirePerm('perm_manage_ads'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('ad_settings').doc('frequency').set({ ...req.body, updated_at: new Date() }, { merge: true });
    res.json({ success: true, ...req.body });
  } catch (_) {
    res.status(500).json({ error: 'Failed to update frequency settings' });
  }
});

// ── GET /impressions  — Impression log ────────────────────────────────────────
router.get('/impressions', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('ad_impressions').orderBy('created_at', 'desc').limit(500).get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ data, total: data.length });
  } catch (_) {
    res.json({ data: [], total: 0 });
  }
});

// ── GET /analytics/overview  ──────────────────────────────────────────────────
router.get('/analytics/overview', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('ad_campaigns').where('status', '==', 'live').get();
    const ads  = snap.docs.map(d => d.data());
    const impressions = ads.reduce((s, a) => s + (a.impressions || 0), 0);
    const clicks      = ads.reduce((s, a) => s + (a.clicks || 0), 0);
    res.json({
      impressions, clicks,
      ctr:    impressions > 0 ? parseFloat(((clicks / impressions) * 100).toFixed(2)) : 0,
      active: snap.size,
    });
  } catch (_) {
    res.json({ impressions: 0, clicks: 0, ctr: 0, active: 0 });
  }
});

// ── GET /:id  ─────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('ad_campaigns').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (_) {
    res.status(500).json({ error: 'Failed to fetch ad' });
  }
});

// ── POST /  — Create ad campaign ─────────────────────────────────────────────
router.post('/', requirePerm('perm_manage_ads'), async (req, res) => {
  try {
    const db  = getFirestore();
    const id  = uuidv4();
    const doc = { ...req.body, id, status: 'draft', impressions: 0, clicks: 0,
                  created_by: req.user.id, created_at: new Date() };
    await db.collection('ad_campaigns').doc(id).set(doc);
    res.status(201).json(doc);
  } catch (_) {
    res.status(500).json({ error: 'Failed to create ad campaign' });
  }
});

// ── PUT /:id  — Update ad campaign ───────────────────────────────────────────
router.put('/:id', requirePerm('perm_manage_ads'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('ad_campaigns').doc(req.params.id)
      .update({ ...req.body, updated_at: new Date() });
    res.json({ id: req.params.id, ...req.body });
  } catch (_) {
    res.status(500).json({ error: 'Failed to update ad campaign' });
  }
});

// ── DELETE /:id  — Delete ad campaign ────────────────────────────────────────
router.delete('/:id', requirePerm('perm_manage_ads'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('ad_campaigns').doc(req.params.id).delete();
    res.json({ message: 'Ad campaign deleted' });
  } catch (_) {
    res.status(500).json({ error: 'Failed to delete ad campaign' });
  }
});

// ── POST /:id/publish  — Go live ─────────────────────────────────────────────
router.post('/:id/publish', requirePerm('perm_manage_ads'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('ad_campaigns').doc(req.params.id)
      .update({ status: 'live', published_at: new Date(), published_by: req.user.id });
    res.json({ message: 'Ad campaign published', id: req.params.id });
  } catch (_) {
    res.status(500).json({ error: 'Publish failed' });
  }
});

module.exports = router;
