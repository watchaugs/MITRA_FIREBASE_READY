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
  try {
    // Body: { geojson: { type: 'Polygon', coordinates: [...] } }
    const { geojson } = req.body;
    if (!geojson) return res.status(400).json({ error: 'geojson body required' });
    const db = getFirestore();
    await db.collection('geofences').doc(req.params.id).update({
      geojson,
      has_geojson: true,
      boundary_synced_at: new Date(),
    });
    res.json({ success: true, message: 'Boundary saved', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: 'Boundary sync failed', detail: err.message });
  }
});

// ── Haversine distance (km) — no library needed ───────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R  = 6371;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dN = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(dL / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180)
            * Math.cos(lat2 * Math.PI / 180)
            * Math.sin(dN / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── GET /check-point?lat=&lng= ────────────────────────────────────────────────
// Used by the Flutter app to verify a student's school location falls within
// an authorised geofence before granting access to AR content.
router.get('/check-point', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat and lng required' });

  try {
    const db   = getFirestore();
    const snap = await db.collection('geofences').where('is_active', '==', true).get();
    const matches = [];

    snap.docs.forEach(d => {
      const geo = d.data();
      // Every geofence must have lat/lng centre + radius_km stored when created
      if (!geo.lat || !geo.lng || !geo.radius_km) return;
      const dist = haversineKm(lat, lng, geo.lat, geo.lng);
      if (dist <= geo.radius_km) {
        matches.push({
          id:        d.id,
          name:      geo.name,
          state:     geo.state,
          district:  geo.district,
          radius_km: geo.radius_km,
          distance_km: parseFloat(dist.toFixed(2)),
        });
      }
    });

    res.json({ lat, lng, matches, inside_any: matches.length > 0 });
  } catch (err) {
    res.status(500).json({ error: 'Point check failed', detail: err.message });
  }
});

module.exports = router;
