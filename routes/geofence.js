'use strict';
const router = require('express').Router();
const https  = require('https');
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { authenticate, requirePerm } = require('../middleware/auth');
const log = require('../lib/logger');
router.use(authenticate);

// ── Point-in-polygon (ray casting) — supports Polygon & MultiPolygon ─────────
// GeoJSON coordinates are [lng, lat], note the order vs the rest of this file.
function pointInPolygon(lat, lng, geojson) {
  if (!geojson || !geojson.coordinates) return false;
  const polygons = geojson.type === 'MultiPolygon' ? geojson.coordinates : [geojson.coordinates];
  for (const poly of polygons) {
    const ring = poly[0];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const intersect = ((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

router.get('/', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('geofences').get();
    return res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load geofences');
    return res.status(500).json({ error: 'Failed to load geofences' });
  }
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
      if (geo.has_geojson && geo.geojson) {
        // Preferred: real boundary check
        if (pointInPolygon(lat, lng, geo.geojson)) {
          matches.push({
            id: d.id, name: geo.name, state: geo.state, district: geo.district,
            method: 'boundary',
          });
        }
        return;
      }
      // Fallback: circle check for geofences with no polygon attached yet
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
          method: 'radius',
        });
      }
    });

    res.json({ lat, lng, matches, inside_any: matches.length > 0 });
  } catch (err) {
    res.status(500).json({ error: 'Point check failed', detail: err.message });
  }
});

module.exports = router;
