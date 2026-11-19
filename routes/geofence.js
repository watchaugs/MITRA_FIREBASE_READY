'use strict';
const router = require('express').Router();
const https  = require('https');
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { stripFields } = require('../lib/writeGuard');
const { authenticate, requirePerm } = require('../middleware/auth');
const { canAccessState } = require('../lib/stateScope');
const { toName, toCode, sameState } = require('../lib/states');
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
    const byKey = loadIndiaStates().byKey;
    // Any form works ("OD", "Odisha", "Orissa"): the bundled map uses a few
    // older codes (OR, DN), so fall back to the official name.
    const entry = byKey[key] || byKey[String(toName(key) || '').toLowerCase()];
    if (!entry) return res.status(404).json({ error: 'Unknown state code/name' });
    const db = getFirestore();
    const docId = 'state_' + (entry.code || entry.state).toLowerCase().replace(/\s+/g, '_');
    const doc = {
      name: entry.state,
      state: entry.state,
      state_code: entry.code,
      scope: 'state',
      // Firestore forbids nested arrays, and GeoJSON coordinates are nested
      // 3+ deep. Store the geometry as a JSON STRING; readers parse it back.
      geojson_str: JSON.stringify(entry.geometry),
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


// Load a geofence the caller may manage (exists + inside their state scope).
async function _ownGeofence(req, res) {
  const db = getFirestore();
  const ref = db.collection('geofences').doc(String(req.params.id || ''));
  const doc = await ref.get();
  if (!doc.exists) { res.status(404).json({ error: 'Geofence not found' }); return null; }
  const g = doc.data() || {};
  if (!canAccessState(req, g.state)) {
    res.status(403).json({ error: 'Your account cannot change this state\'s geofence.' });
    return null;
  }
  return { db, ref, g };
}

// PUT /:id — edit a geofence (✎ on a circle in the Curriculum tree).
// is_active has its own route below; state/boundary of a whole-state fence
// can't be changed here (re-apply the state instead).
router.put('/:id', requirePerm('perm_manage_geo'), async (req, res) => {
  try {
    const own = await _ownGeofence(req, res);
    if (!own) return;
    const safe = stripFields(req.body, ['id', 'created_by', 'created_at', 'is_active', 'state', 'state_code',
      'scope', 'geojson', 'geojson_str', 'has_geojson']);
    for (const k of ['lat', 'lng', 'radius_km']) {
      if (safe[k] !== undefined && !Number.isFinite(Number(safe[k]))) return res.status(400).json({ error: k + ' must be a number' });
      if (safe[k] !== undefined) safe[k] = Number(safe[k]);
    }
    if (safe.radius_km !== undefined && !(safe.radius_km > 0 && safe.radius_km <= 1000)) {
      return res.status(400).json({ error: 'radius_km must be between 1 and 1000' });
    }
    await own.ref.update({ ...safe, updated_by: req.user.id, updated_at: new Date() });
    await own.db.collection('audit_log').add({
      action: 'geofence_updated', actor: req.user.id,
      detail: { geofence_id: req.params.id, name: safe.name || own.g.name || null, state: own.g.state || null },
      created_at: new Date(),
    }).catch(() => {});
    res.json({ id: req.params.id, ...safe });
  } catch (err) {
    log.error({ err: err.message }, 'geofence update failed');
    res.status(500).json({ error: 'Failed to update geofence' });
  }
});

// POST /:id/active { is_active: true|false } — disable (keeps the boundary,
// students in that area lose access) or re-enable it.
router.post('/:id/active', requirePerm('perm_manage_geo'), async (req, res) => {
  try {
    const want = req.body && req.body.is_active;
    if (typeof want !== 'boolean') return res.status(400).json({ error: 'is_active must be true or false' });
    const own = await _ownGeofence(req, res);
    if (!own) return;
    await own.ref.update({ is_active: want, updated_by: req.user.id, updated_at: new Date() });
    await own.db.collection('audit_log').add({
      action: want ? 'geofence_enabled' : 'geofence_disabled', actor: req.user.id,
      detail: { geofence_id: req.params.id, name: own.g.name || null, state: own.g.state || null },
      created_at: new Date(),
    }).catch(() => {});
    res.json({ id: req.params.id, is_active: want });
  } catch (err) {
    log.error({ err: err.message }, 'geofence toggle failed');
    res.status(500).json({ error: 'Failed to update geofence' });
  }
});

// DELETE /:id — remove for good. A whole-state boundary can be re-applied any
// time from "Geofence an entire state"; a circle has to be redrawn.
router.delete('/:id', requirePerm('perm_manage_geo'), async (req, res) => {
  try {
    const own = await _ownGeofence(req, res);
    if (!own) return;
    await own.ref.delete();
    await own.db.collection('audit_log').add({
      action: 'geofence_deleted', actor: req.user.id,
      detail: { geofence_id: req.params.id, name: own.g.name || null, state: own.g.state || null, scope: own.g.scope || 'radius' },
      created_at: new Date(),
    }).catch(() => {});
    res.json({ message: 'Geofence deleted', id: req.params.id });
  } catch (err) {
    log.error({ err: err.message }, 'geofence delete failed');
    res.status(500).json({ error: 'Failed to delete geofence' });
  }
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
      // Boundary can be stored as a parsed object (legacy) or a JSON STRING
      // (geojson_str — because Firestore forbids GeoJSON's nested arrays).
      let boundary = geo.geojson || null;
      if (!boundary && geo.geojson_str) {
        try { boundary = JSON.parse(geo.geojson_str); } catch (_) { boundary = null; }
      }
      if (geo.has_geojson && boundary) {
        // Preferred: real boundary check
        if (pointInPolygon(lat, lng, boundary)) {
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

// ── Home-state rule (app: lib/services/territory_service.dart) ───────────────
// Students may use MITRA only inside their registered state. The app checks
// its location ON THE PHONE against that state's active geofences, so it needs
// them (and the offline grace days). No location is sent to this route.
// Grace days live in compliance_settings/territory_grace:
//   { default_days: 7, days_by_state: { "<normalised state>": n } }
const GRACE_DOC = ['compliance_settings', 'territory_grace'];
const DEFAULT_GRACE_DAYS = 7;
// "Jammu & Kashmir" == "jammu and kashmir" (same rule as the app).
const normState = (s) => String(s || '').trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

// Grace days are kept per state under the official name ("gujarat"), so a
// student saved as "Gujarat" and a request for "GJ" find the same value.
const graceKey = (s) => normState(toName(s) || s);

function graceFor(data, state) {
  const d = data || {};
  const byState = d.days_by_state || {};
  const v = graceKey(state) in byState ? byState[graceKey(state)] : byState[normState(state)];
  if (Number.isFinite(Number(v)) && v !== null && v !== '') return Number(v);
  const def = Number(d.default_days);
  return Number.isFinite(def) && d.default_days !== undefined ? def : DEFAULT_GRACE_DAYS;
}

// GET /territory?state=Maharashtra → that state's ACTIVE geofences + grace.
router.get('/territory', async (req, res) => {
  const state = String(req.query.state || '').trim();
  if (!state) return res.status(400).json({ error: 'state required' });
  try {
    const db = getFirestore();
    const [snap, graceDoc] = await Promise.all([
      db.collection('geofences').where('is_active', '==', true).get(),
      db.collection(GRACE_DOC[0]).doc(GRACE_DOC[1]).get(),
    ]);
    const geofences = [];
    snap.docs.forEach(d => {
      const g = d.data();
      // Any form of the state matches ("Gujarat", "GJ", "gujarat").
      if (g.is_active === false || !sameState(g.state || g.state_code, state)) return;
      // Same shape rules as /check-point: real boundary first, else circle.
      let boundary = g.geojson || null;
      if (!boundary && g.geojson_str) {
        try { boundary = JSON.parse(g.geojson_str); } catch (_) { boundary = null; }
      }
      if (g.has_geojson && boundary) {
        geofences.push({ id: d.id, type: 'polygon', geometry: boundary });
      } else if (g.lat && g.lng && g.radius_km) {
        geofences.push({ id: d.id, type: 'circle', lat: Number(g.lat), lng: Number(g.lng), radius_km: Number(g.radius_km) });
      }
    });
    // Same for every student of the state; the app refreshes it once a day.
    res.set('Cache-Control', 'private, max-age=3600');
    res.json({ state, geofences, grace_days: graceFor(graceDoc.exists ? graceDoc.data() : null, state) });
  } catch (err) {
    log.error({ err: err.message }, 'territory fetch failed');
    res.status(500).json({ error: 'Territory fetch failed' });
  }
});

// GET /grace → { default_days, days_by_state } for the curriculum tree.
router.get('/grace', async (req, res) => {
  try {
    const doc = await getFirestore().collection(GRACE_DOC[0]).doc(GRACE_DOC[1]).get();
    const d = doc.exists ? doc.data() : {};
    // Also list each value under the state's code, so the Dashboard finds it
    // whether its block is labelled "Gujarat" or "GJ".
    const byState = { ...(d.days_by_state || {}) };
    for (const [k, v] of Object.entries(d.days_by_state || {})) {
      const code = toCode(k);
      if (code && !(normState(code) in byState)) byState[normState(code)] = v;
    }
    res.json({ default_days: graceFor(d, '__none__'), days_by_state: byState });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load grace settings' });
  }
});

// PUT /grace/:state { days } — offline grace for one state (0–30 days).
router.put('/grace/:state', requirePerm('perm_manage_geo'), async (req, res) => {
  const state = String(req.params.state || '').trim();
  const days = Number(req.body && req.body.days);
  if (!state) return res.status(400).json({ error: 'state required' });
  if (!Number.isInteger(days) || days < 0 || days > 30) {
    return res.status(400).json({ error: 'Grace must be a whole number of days from 0 to 30' });
  }
  if (!canAccessState(req, state)) return res.status(403).json({ error: 'Not your state' });
  try {
    const ref = getFirestore().collection(GRACE_DOC[0]).doc(GRACE_DOC[1]);
    await ref.set({
      days_by_state: { [graceKey(state)]: days },
      updated_at: new Date(),
      updated_by: req.user.id,
    }, { merge: true });
    res.json({ state, days });
  } catch (err) {
    log.error({ err: err.message }, 'grace update failed');
    res.status(500).json({ error: 'Failed to save grace days' });
  }
});

module.exports = router;
