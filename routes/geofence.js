'use strict';
const router = require('express').Router();
const https  = require('https');
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { stripFields } = require('../lib/writeGuard');
const { authenticate, requirePerm } = require('../middleware/auth');
const log = require('../lib/logger');
router.use(authenticate);

// ── Bundled India state boundaries (all 36 states/UTs) ───────────────────────
// Loaded once from data/india_states.geojson so "geofence an entire state" needs
// no coordinates and no external API. Each feature: { state, code, geometry }.
const path = require('path');
let _IN_STATES = null;
function loadIndiaStates() {
  if (_IN_STATES) return _IN_STATES;
  try {
    const fs = require('fs');
    const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'india_states.geojson'), 'utf8');
    const fc = JSON.parse(raw);
    const byKey = {};
    for (const f of (fc.features || [])) {
      const name = f.properties && f.properties.state;
      const code = f.properties && f.properties.code;
      if (!name || !f.geometry) continue;
      const entry = { state: name, code: code || null, geometry: f.geometry };
      byKey[name.toLowerCase()] = entry;
      if (code) byKey[code.toLowerCase()] = entry;
    }
    _IN_STATES = { list: (fc.features || []).map(f => ({ state: f.properties.state, code: f.properties.code })), byKey };
  } catch (e) {
    log.error({ err: e.message }, 'india_states.geojson load failed');
    _IN_STATES = { list: [], byKey: {} };
  }
  return _IN_STATES;
}

// GET /available-states — list for the "geofence entire state" dropdown.
router.get('/available-states', (req, res) => {
  res.json(loadIndiaStates().list);
});

// POST /state/:code — geofence an ENTIRE state by its code or name.
router.post('/state/:code', requirePerm('perm_manage_geo'), async (req, res) => {
  try {
    const key = String(req.params.code || '').trim().toLowerCase();
    const entry = loadIndiaStates().byKey[key];
    if (!entry) return res.status(404).json({ error: 'Unknown state code/name' });
    const db = getFirestore();
    const docId = 'state_' + (entry.code || entry.state).toLowerCase().replace(/\s+/g, '_');
    const doc = {
      name: entry.state,
      state: entry.state,
      state_code: entry.code,
      scope: 'state',
      geojson: entry.geometry,
      has_geojson: true,
      is_active: true,
      boundary_synced_at: new Date(),
      created_by: req.user.id,
      created_at: new Date(),
    };
    await db.collection('geofences').doc(docId).set(doc, { merge: true });
    res.status(201).json({ id: docId, ...doc });
  } catch (err) {
    log.error({ err: err.message }, 'state geofence failed');
    res.status(500).json({ error: 'Failed to geofence state', detail: err.message });
  }
});

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
    const safe = stripFields(req.body, ['id', 'created_by', 'created_at', 'is_active']);
    const doc = { ...safe, is_active: true, created_by: req.user.id, created_at: new Date() };
    const db  = getFirestore();
    await db.collection('geofences').doc(id).set(doc);
    res.status(201).json({ id, ...doc });
  } catch { res.status(500).json({ error: 'Failed to create geofence' }); }
});

router.put('/:id', requirePerm('perm_manage_geo'), async (req, res) => {
  try {
    const db = getFirestore();
    const safe = stripFields(req.body, ['id', 'created_by', 'created_at']);
    await db.collection('geofences').doc(req.params.id).update({ ...safe, updated_at: new Date() });
    res.json({ id: req.params.id, ...safe });
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
