/**
 * routes/curriculum.js — Curriculum Taxonomy CRUD + AR/Quiz Linking
 * GET /tree reads from Firestore. /ar-topics is the app's lesson feed and only
 * returns content that is published AND released (lib/release.js).
 */
'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { authenticate, requirePerm } = require('../middleware/auth');
const { visibleInState, canAccessState } = require('../lib/stateScope');
const { isAppCaller, isReleased } = require('../lib/release');
const log = require('../lib/logger');
router.use(authenticate);

// ── GET / and /tree — Reads from Firestore curriculum collection ──────────────
async function getCurriculumNodes() {
  const db = getFirestore();
  let snap = null;
  try {
    snap = await db.collection('curriculum').get();
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load curriculum — showing placeholder content, check this error');
  }
  if (snap && !snap.empty) {
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  // Nothing added yet — return an empty tree (no invented chapters on students' phones).
  return [];
}

router.get('/', async (req, res) => {
  try {
    res.json(await getCurriculumNodes());
  } catch { res.status(500).json({ error: 'Failed to fetch curriculum' }); }
});

router.get('/tree', async (req, res) => {
  try {
    const nodes = await getCurriculumNodes();
    res.json({ success: true, nodes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch curriculum', details: err.message });
  }
});

router.post('/', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { parent_id, node_type, name, icon = '📘', sort_order = 0 } = req.body;
    if (!node_type || !name) return res.status(400).json({ error: 'node_type and name required' });
    const db  = getFirestore();
    const id  = uuidv4();
    const doc = { parent_id: parent_id || null, node_type, name, icon, sort_order, is_active: true, created_by: req.user.id };
    await db.collection('curriculum').doc(id).set(doc);
    res.status(201).json({ id, ...doc });
  } catch { res.status(500).json({ error: 'Failed to create node' }); }
});

router.put('/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { name, icon, sort_order, is_active } = req.body;
    const db = getFirestore();
    const updates = {};
    if (name !== undefined)       updates.name       = name;
    if (icon !== undefined)       updates.icon       = icon;
    if (sort_order !== undefined) updates.sort_order = sort_order;
    if (is_active !== undefined)  updates.is_active  = is_active;
    await db.collection('curriculum').doc(req.params.id).update(updates);
    res.json({ id: req.params.id, ...updates });
  } catch { res.status(500).json({ error: 'Failed to update node' }); }
});

router.delete('/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('curriculum').doc(req.params.id).update({ is_active: false });
    res.json({ message: 'Node deactivated' });
  } catch { res.status(500).json({ error: 'Failed to delete node' }); }
});

// ── AR Topics ──────────────────────────────────────────────────────────────────
// Returns published AR assets as "topics" — what the Flutter app uses to
// display the lesson list and request the CDN URL for the GLB file.
// Is the requested state inside MITRA's approved territory? A state is
// "supported" once the dashboard has saved a curriculum for it.
async function _territorySupported(db, state) {
  const s = String(state || '').trim();
  if (!s) return true;
  try {
    const snap = await db.collection('curriculum_hierarchy').get();
    return snap.docs.some(d => {
      const h = d.data() || {};
      const a = String(h.state_name || '').trim().toLowerCase();
      const b = String(h.state_code || '').trim().toLowerCase();
      const want = s.toLowerCase();
      return a === want || b === want;
    });
  } catch (_) {
    return true;
  }
}

// ── Curriculum manifest (scaling cost-shield) ───────────────────────────────
// At lakhs of DAU, every student querying several collections per launch makes
// Firestore the biggest bill. Instead we build ONE compact JSON per state
// (classes → subjects → topics → released AR lessons + model URLs), cache it
// hard, and let the app read just this. Regenerated when an admin saves a
// state's curriculum; served with a long Cache-Control so repeat reads are free
// at the CDN/proxy. (Later: push the same JSON to R2 — format stays identical.)
async function buildStateManifest(db, stateCode, stateName) {
  const hDoc = await db.collection('curriculum_hierarchy').doc(stateCode).get();
  const structure = hDoc.exists ? (hDoc.data().structure || []) : [];
  // Published AR assets visible to this state, keyed for quick topic lookup.
  let assets = [];
  try {
    const aSnap = await db.collection('ar_assets').where('status', '==', 'published').limit(1000).get();
    assets = aSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(a => {
        const ts = Array.isArray(a.target_states) ? a.target_states : [];
        if (!ts.length) return true; // national
        const want = String(stateName || stateCode).trim().toUpperCase();
        return ts.map(x => String(x).trim().toUpperCase()).includes(want);
      });
  } catch (_) {}
  const nrm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const lessonsFor = (cls, subj, topic) => assets
    .filter(a => nrm(a.class_name) === nrm(cls) && nrm(a.subject) === nrm(subj) && nrm(a.topic) === nrm(topic))
    .map(a => ({ id: a.id, title: a.title || a.topic || a.id,
                 flutter_url: a.flutter_url || null, audio_url: a.audio_url || null,
                 mind_url: a.mind_url || null, video_url: a.video_url || null,
                 chroma_enabled: a.chroma_enabled === true, chroma_color: a.chroma_color || null,
                 ar_mode: a.ar_mode || null }));
  return {
    version: 1,
    state_code: stateCode,
    state_name: stateName || stateCode,
    generated_at: new Date().toISOString(),
    classes: structure.map(c => ({
      class_name: c.class_name,
      subjects: (c.subjects || []).map(sj => ({
        subject: sj.subject,
        topics: (sj.topics || []).map(t => ({
          topic: t.topic,
          ar_lessons: lessonsFor(c.class_name, sj.subject, t.topic),
        })),
      })),
    })),
  };
}

// GET /manifest/:state — the app reads this ONCE per launch instead of querying
// several collections. Cached hard; recomputed only if no cached copy exists.
router.get('/manifest/:state', async (req, res) => {
  try {
    const db = getFirestore();
    const stateKey = req.params.state;
    // Serve a stored copy if present (written on publish); else build on demand.
    let manifest = null;
    try {
      const cached = await db.collection('curriculum_manifests').doc(stateKey).get();
      if (cached.exists) manifest = cached.data();
    } catch (_) {}
    if (!manifest) {
      manifest = await buildStateManifest(db, stateKey, req.query.state_name || stateKey);
      try { await db.collection('curriculum_manifests').doc(stateKey).set(manifest); } catch (_) {}
    }
    res.set('Cache-Control', 'public, max-age=3600'); // 1h at the edge/proxy
    res.json(manifest);
  } catch (err) {
    log.error({ err: err.message }, 'manifest build failed');
    res.status(500).json({ error: 'Failed to build manifest' });
  }
});

router.get('/ar-topics', async (req, res) => {
  const db = getFirestore();
  let snap = null;
  try {
    snap = await db.collection('ar_assets').where('status', '==', 'published').limit(200).get();
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load AR topics — showing placeholder content, check this error');
  }
  if (snap && !snap.empty) {
    let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    rows     = visibleInState(rows, req.query.state); // geofence: national + requested state
    // Release control: students only get lessons that have been released for their state.
    if (isAppCaller(req)) rows = rows.filter(r => isReleased(r, req.query.state || req.user.state));
    const data = rows.map(r => ({
      id:         r.id,
      topic:      r.topic      || '',
      class_name: r.class_name || '',
      subject:    r.subject    || '',
      language:   r.language   || 'English',
      status:     r.status     || 'live',
      unity_url:  r.unity_url  || null,
      flutter_url:r.flutter_url|| null,
      mind_url:         r.mind_url         || null,
      audio_url:        r.audio_url        || null,
      target_image_url: r.target_image_url || null,
      video_url:        r.video_url        || null,
      chroma_enabled:   r.chroma_enabled   === true,
      chroma_color:     r.chroma_color     || null,
      ar_mode:          r.ar_mode          || null,
    }));
    // The app reads res.data['data'] — it was getting a bare array, so it always
    // fell back to its built-in demo list.
    return res.json({ data, total: data.length, territory_supported: true });
  }
  // No published AR assets yet — empty list. territory_supported tells the app
  // whether to say "coming soon" (true) or "not in your area yet" (false).
  const territory_supported = await _territorySupported(db, req.query.state);
  res.json({ data: [], total: 0, territory_supported });
});

// ── State Hierarchy ────────────────────────────────────────────────────────────
router.post('/hierarchy', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { state_code, structure } = req.body;
    if (!state_code) return res.status(400).json({ error: 'state_code required' });
    if (!canAccessState(req, req.body.state_name || state_code) && !canAccessState(req, state_code)) {
      return res.status(403).json({ error: 'Your account cannot edit this state\'s curriculum.' });
    }
    if (!Array.isArray(structure)) return res.status(400).json({ error: 'structure must be a list' });
    const db = getFirestore();
    await db.collection('curriculum_hierarchy').doc(state_code).set({ state_code, state_name: req.body.state_name || state_code, structure, updated_by: req.user?.id, updated_at: new Date() }, { merge: true });
    // Rebuild this state's cached manifest so the app's next read is instant and DB-free.
    try {
      const manifest = await buildStateManifest(db, state_code, req.body.state_name || state_code);
      await db.collection('curriculum_manifests').doc(state_code).set(manifest);
    } catch (e) { log.error({ err: e.message }, 'manifest regen after save failed (non-fatal)'); }
    res.json({ success: true, message: 'Hierarchy saved', state_code });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save curriculum hierarchy');
    res.status(500).json({ error: 'Failed to save hierarchy' });
  }
});

// ── Auto-match AR assets to curriculum topics by their tags ──────────────────
// An uploaded AR asset already carries class_name / subject / topic / target_states.
// We attach each live (non-app) asset to the matching topic in that state so the
// Curriculum page shows it automatically — no manual linking table needed.
const _norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
function _assetTargetsState(a, stateName, stateCode) {
  const ts = Array.isArray(a.target_states) ? a.target_states : [];
  if (!ts.length) return true;                       // national asset → every state
  const want = new Set([_norm(stateName), _norm(stateCode)]);
  return ts.some(t => want.has(_norm(t)));
}

// ── GET /hierarchy ─── every saved state (the Curriculum page loads this) ────
router.get('/hierarchy', async (req, res) => {
  try {
    const db = getFirestore();
    const snap = await db.collection('curriculum_hierarchy').get();

    // Load all AR assets once and index them by class|subject|topic for fast lookup.
    let assets = [];
    try {
      const aSnap = await db.collection('ar_assets').limit(1000).get();
      assets = aSnap.docs.map(d => ({ id: d.id, ...d.data() }))
                         .filter(a => a.status !== 'archived');   // archived/deleted never show
    } catch (e) { log.error({ err: e.message }, 'hierarchy: AR asset load failed (topics will show without assets)'); }

    const data = snap.docs.map(d => d.data())
      .filter(h => Array.isArray(h.structure) && h.structure.length)
      .filter(h => canAccessState(req, h.state_name || h.state_code) || canAccessState(req, h.state_code))
      .map(h => {
        const stateName = h.state_name || h.state_code;
        const structure = (h.structure || []).map(c => ({
          ...c,
          subjects: (c.subjects || []).map(sj => ({
            ...sj,
            topics: (sj.topics || []).map(t => {
              const matched = assets.filter(a =>
                _assetTargetsState(a, stateName, h.state_code) &&
                _norm(a.class_name) === _norm(c.class_name) &&
                _norm(a.subject)    === _norm(sj.subject) &&
                _norm(a.topic)      === _norm(t.topic)
              ).map(a => ({ id: a.id, title: a.title || a.original_name || a.topic || a.id, status: a.status || 'uploaded' }));
              // Keep any assets the saved structure already had; add matched ones without duplicates.
              const existing = Array.isArray(t.ar_assets) ? t.ar_assets : [];
              const seen = new Set(existing.map(x => x.id));
              const ar_assets = existing.concat(matched.filter(m => !seen.has(m.id)));
              return { ...t, ar_assets };
            }),
          })),
        }));
        return { state_code: h.state_code, state_name: stateName, structure,
                 updated_at: h.updated_at && h.updated_at.toDate ? h.updated_at.toDate().toISOString() : null };
      });
    res.json({ data, total: data.length });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load curriculum hierarchies');
    res.status(500).json({ error: 'Failed to load curriculum' });
  }
});

router.get('/hierarchy/:stateCode', async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('curriculum_hierarchy').doc(req.params.stateCode).get();
    res.json(doc.exists ? doc.data().structure : []);
  } catch { res.json([]); }
});

// ── Export ──────────────────────────────────────────────────────────────────────
router.get('/export', requirePerm('perm_export_data'), async (req, res) => {
  res.json({ data: [], total: 0, exported_at: new Date().toISOString() });
});

// ── Quiz Links ──────────────────────────────────────────────────────────────────
router.post('/quiz-links', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { node_id, quiz_id } = req.body;
    if (!node_id || !quiz_id) return res.status(400).json({ error: 'node_id and quiz_id required' });
    const db  = getFirestore();
    const id  = uuidv4();
    const doc = { id, node_id, quiz_id, created_by: req.user.id, created_at: new Date() };
    await db.collection('curriculum_quiz_links').doc(id).set(doc);
    res.status(201).json({ message: 'Quiz linked', link: doc });
  } catch (_) {
    res.status(500).json({ error: 'Failed to link quiz' });
  }
});

router.delete('/quiz-links/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('curriculum_quiz_links').doc(req.params.id).delete();
    res.json({ message: 'Quiz link removed' });
  } catch (_) {
    res.status(500).json({ error: 'Failed to remove quiz link' });
  }
});

router.get('/quiz-links/:nodeId', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('curriculum_quiz_links')
      .where('node_id', '==', req.params.nodeId).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (_) {
    res.json([]);
  }
});

// ── AR Links ────────────────────────────────────────────────────────────────────
router.post('/ar-links', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { curriculum_node_id, asset_id } = req.body;
    if (!curriculum_node_id || !asset_id) return res.status(400).json({ error: 'curriculum_node_id and asset_id required' });
    const db  = getFirestore();
    const id  = uuidv4();
    const doc = { id, curriculum_node_id, asset_id, created_by: req.user.id, created_at: new Date() };
    await db.collection('curriculum_ar_links').doc(id).set(doc);
    res.status(201).json({ message: 'AR asset linked', link: doc });
  } catch (_) {
    res.status(500).json({ error: 'Failed to link AR asset' });
  }
});

router.delete('/ar-links/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('curriculum_ar_links').doc(req.params.id).delete();
    res.json({ message: 'AR link removed' });
  } catch (_) {
    res.status(500).json({ error: 'Failed to remove AR link' });
  }
});

router.get('/ar-links/:nodeId', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('curriculum_ar_links')
      .where('curriculum_node_id', '==', req.params.nodeId).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (_) {
    res.json([]);
  }
});

// ── Content Schedule (Time-Lock Mechanism) ────────────────────────────────────
// The PDF architecture: the Flutter app downloads the full term schedule once.
// It checks the local clock against unlocks_at timestamps — no server ping needed.
// Dashboard admins POST the schedule; the app GETs it on first launch per term.

router.post('/schedule', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    // Body: { term, state_code, entries: [{ topic_id, class_name, subject, unlocks_at }] }
    const { term, state_code, entries } = req.body;
    if (!term || !Array.isArray(entries)) {
      return res.status(400).json({ error: 'term and entries[] required' });
    }
    const db  = getFirestore();
    const key = `${state_code || 'ALL'}_${term}`;
    await db.collection('content_schedules').doc(key).set({
      term, state_code: state_code || 'ALL', entries,
      published_by: req.user.id, published_at: new Date(),
    }, { merge: true });
    res.json({ success: true, key, entry_count: entries.length });
  } catch (err) {
    res.status(500).json({ error: 'Schedule save failed', detail: err.message });
  }
});

// GET /schedule/:stateCode/:term — Flutter app downloads this on first launch
router.get('/schedule/:stateCode/:term', async (req, res) => {
  try {
    const db  = getFirestore();
    const key = `${req.params.stateCode}_${req.params.term}`;
    const doc = await db.collection('content_schedules').doc(key).get();
    if (!doc.exists) {
      // Try the ALL fallback
      const fallback = await db.collection('content_schedules').doc(`ALL_${req.params.term}`).get();
      if (!fallback.exists) return res.json({ entries: [], term: req.params.term });
      return res.json(fallback.data());
    }
    res.json(doc.data());
  } catch (_) {
    res.json({ entries: [], term: req.params.term });
  }
});

module.exports = router;