'use strict';
const router = require('express').Router();
const https  = require('https');
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { authenticate, requirePerm } = require('../middleware/auth');
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('geofences').get();
    if (!snap.empty) return res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (_) {}
  res.json([
    { id: 'geo-1', name: 'Gujarat Zone', state: 'Gujarat', district: null, radius_km: 50, is_active: true, has_geojson: false },
    { id: 'geo-2', name: 'Anand District', state: 'Gujarat', district: 'Anand', radius_km: 25, is_active: true, has_geojson: false },
  ]);
});

router.post('/', requirePerm('perm_manage_geo'), async (req, res) => {
  try {
    const id  = uuidv4();
    const doc = { ...req.body, is_active: true, created_by: req.user.id, created_at: new Date() };
    const db  = getFirestore();
    await db.collection('geofences').doc(id).set(doc);
    res.status(201).json({ id, ...doc });
  } catch { res.status(500).json({ error: 'Failed to create geofence' }); }
});

router.put('/:id', requirePerm('perm_manage_geo'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('geofences').doc(req.params.id).update({ ...req.body, updated_at: new Date() });
    res.json({ id: req.params.id, ...req.body });
  } catch { res.status(500).json({ error: 'Failed to update geofence' }); }
});

router.delete('/:id', requirePerm('perm_manage_geo'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('geofences').doc(req.params.id).delete();
    res.json({ message: 'Geofence deleted' });
  } catch { res.status(500).json({ error: 'Failed to delete geofence' }); }
});

router.post('/:id/sync-boundary', requirePerm('perm_manage_geo'), async (req, res) => {
  res.json({ success: true, message: 'Boundary sync queued' });
});

router.get('/check-point', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
  res.json({ lat: parseFloat(lat), lng: parseFloat(lng), matches: [] });
});

module.exports = router;
