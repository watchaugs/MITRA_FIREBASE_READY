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
      ar_mode:          r.ar_mode          || null,
    }));
    // The app reads res.data['data'] — it was getting a bare array, so it always
    // fell back to its built-in demo list.
    return res.json({ data, total: data.length });
  }
  // No published AR assets yet — empty list (no phantom topics).
  res.json({ data: [], total: 0 });
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
    res.json({ success: true, message: 'Hierarchy saved', state_code });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save curriculum hierarchy');
    res.status(500).json({ error: 'Failed to save hierarchy' });
  }
});

// ── GET /hierarchy ─── every saved state (the Curriculum page loads this) ────
router.get('/hierarchy', async (req, res) => {
  try {
    const snap = await getFirestore().collection('curriculum_hierarchy').get();
    const data = snap.docs.map(d => d.data())
      .filter(h => Array.isArray(h.structure) && h.structure.length)
      .filter(h => canAccessState(req, h.state_name || h.state_code) || canAccessState(req, h.state_code))
      .map(h => ({ state_code: h.state_code, state_name: h.state_name || h.state_code, structure: h.structure,
                   updated_at: h.updated_at && h.updated_at.toDate ? h.updated_at.toDate().toISOString() : null }));
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