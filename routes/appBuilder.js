'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { authenticate, requirePerm } = require('../middleware/auth');
const { getFirestore } = require('../lib/firebase');
router.use(authenticate);

async function getBuilds() {
  try {
    const db   = getFirestore();
    const snap = await db.collection('app_builds').orderBy('created_at', 'desc').limit(50).get();
    if (!snap.empty) return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (_) {}
  return [];
}

router.get('/state-config', async (req, res) => {
  const { State } = require('country-state-city');
  const states    = State.getStatesOfCountry('IN');
  const builds    = await getBuilds();
  res.json({
    apps:           builds,
    states:         states.map(s => ({ code: s.isoCode, name: s.name })),
    default_config: { theme_color: '#6366f1', version: 'v1.0.0', status: 'building' },
  });
});

router.get('/settings', async (req, res) => {
  const builds = await getBuilds();
  res.json({ apps: builds, total: builds.length });
});
router.put('/settings', requirePerm('perm_publish_apps'), async (req, res) => res.json({ success: true, ...req.body }));

router.get('/builds', async (req, res) => {
  const builds = await getBuilds();
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
  } catch (_) {}
  res.status(404).json({ id: req.params.id, status: 'unknown' });
});
router.post('/builds/:id/publish', requirePerm('perm_publish_apps'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('app_builds').doc(req.params.id).update({ status: 'live', published_at: new Date() });
    res.json({ success: true, message: 'Build published', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to publish build' });
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
  const builds = await getBuilds();
  res.json({ data: builds, total: builds.length });
});

module.exports = router;
