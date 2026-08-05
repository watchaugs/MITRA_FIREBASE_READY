'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { authenticate, requirePerm } = require('../middleware/auth');
const { getFirestore } = require('../lib/firebase');
const { filterByState, canAccessState } = require('../lib/stateScope');
const log = require('../lib/logger');
router.use(authenticate);

async function getBuilds(req) {
  try {
    const db   = getFirestore();
    const snap = await db.collection('app_builds').orderBy('created_at', 'desc').limit(100).get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return req ? filterByState(req, rows) : rows;   // per-state gate-keeping
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load app builds');
    return [];
  }
}

router.get('/state-config', async (req, res) => {
  const { State } = require('country-state-city');
  const states    = State.getStatesOfCountry('IN');
  const builds    = await getBuilds(req);
  res.json({
    apps:           builds,
    states:         states.map(s => ({ code: s.isoCode, name: s.name })),
    default_config: { theme_color: '#6366f1', version: 'v1.0.0', status: 'building' },
  });
});

router.get('/settings', async (req, res) => {
  const builds = await getBuilds(req);
  res.json({ apps: builds, total: builds.length });
});
router.put('/settings', requirePerm('perm_publish_apps'), async (req, res) => res.json({ success: true, ...req.body }));

router.get('/builds', async (req, res) => {
  const builds = await getBuilds(req);
  res.json({ data: builds, total: builds.length });
});
router.post('/builds', requirePerm('perm_publish_apps'), async (req, res) => {
  try {
    const db  = getFirestore();
    const id  = uuidv4();
    const doc = { ...req.body, status: 'building', created_by: req.user.id, created_at: new Date() };
    await db.collection('app_builds').doc(id).set(doc);
    res.status(201).json({ id, ...doc });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create build' });
  }
});
router.get('/builds/:id', async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('app_builds').doc(req.params.id).get();
    if (doc.exists) return res.json({ id: doc.id, ...doc.data() });
    return res.status(404).json({ error: 'Build not found' });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load build');
    return res.status(500).json({ error: 'Failed to load build' });
  }
});
router.post('/builds/:id/publish', requirePerm('perm_publish_apps'), async (req, res) => {
  try {
    const db  = getFirestore();
    const ref = db.collection('app_builds').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Build not found' });
    if (!canAccessState(req, doc.data().state)) {
      return res.status(403).json({ error: 'Your account cannot publish this state\'s app.' });
    }
    await ref.update({ status: 'live', build_status: 'live', published_at: new Date() });
    res.json({ success: true, message: 'Build published (OTA update pushed)', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to publish build' });
  }
});

// ── POST /builds/:id/rollback ─── revert to the previous live build ──────────
router.post('/builds/:id/rollback', requirePerm('perm_publish_apps'), async (req, res) => {
  try {
    const db  = getFirestore();
    const ref = db.collection('app_builds').doc(req.params.id);
    const cur = await ref.get();
    if (!cur.exists) return res.status(404).json({ error: 'Build not found' });
    const curData = cur.data();
    if (!canAccessState(req, curData.state)) {
      return res.status(403).json({ error: 'Your account cannot roll back this state\'s app.' });
    }
    const snap = await db.collection('app_builds')
      .where('state', '==', curData.state || null)
      .orderBy('created_at', 'desc').limit(20).get();
    const prev = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .find(b => b.id !== req.params.id && (b.app_name === curData.app_name || !curData.app_name));
    if (!prev) return res.status(400).json({ error: 'No previous build to roll back to.' });
    await ref.update({ status: 'rolled_back', build_status: 'rolled_back', rolled_back_at: new Date() });
    await db.collection('app_builds').doc(prev.id).update({ status: 'live', build_status: 'live', published_at: new Date() });
    res.json({ success: true, message: `Rolled back to ${prev.version || prev.id}`, active: prev.id });
  } catch (err) {
    log.error({ err: err.message }, 'rollback error');
    res.status(500).json({ error: 'Failed to roll back' });
  }
});
router.get('/skins', async (req, res) => res.json([
  { id: 'default', name: 'MITRA Default', primary: '#6366F1' },
  { id: 'saffron', name: 'MITRA Saffron', primary: '#F59E0B' },
  { id: 'forest',  name: 'MITRA Forest',  primary: '#10B981' },
]));
router.get('/ota-updates', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('ota_updates').orderBy('created_at', 'desc').limit(20).get();
    res.json({ data: snap.docs.map(d => ({ id: d.id, ...d.data() })), total: snap.size });
  } catch (_) {
    res.json({ data: [], total: 0 });
  }
});
router.post('/ota-updates', requirePerm('perm_publish_apps'), async (req, res) => {
  try {
    const db  = getFirestore();
    const id  = uuidv4();
    const doc = { ...req.body, status: 'queued', created_by: req.user.id, created_at: new Date() };
    await db.collection('ota_updates').doc(id).set(doc);
    res.status(201).json({ id, ...doc });
  } catch (err) {
    res.status(500).json({ error: 'Failed to queue OTA update' });
  }
});
router.get('/state-apps', async (req, res) => {
  const builds = await getBuilds(req);
  res.json({ data: builds, total: builds.length });
});

module.exports = router;
