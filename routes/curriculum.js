/**
 * routes/curriculum.js — Curriculum Taxonomy CRUD + AR/Quiz Linking
 * MODIFIED: GET /tree reads from Firestore. Write operations return success mocks.
 */
'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { authenticate, requirePerm } = require('../middleware/auth');
router.use(authenticate);

// ── GET / and /tree — Reads from Firestore curriculum collection ──────────────
async function getCurriculumNodes() {
  try {
    const db   = getFirestore();
    const snap = await db.collection('curriculum').get();
    if (!snap.empty) {
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
  } catch (_) {}
  // Fallback mock — shown until real curriculum is added via dashboard
  return [
    { id: 'sub-science', node_type: 'subject', name: 'Science', icon: '🔬', sort_order: 1, is_active: true, parent_id: null },
    { id: 'sub-maths',   node_type: 'subject', name: 'Mathematics', icon: '📐', sort_order: 2, is_active: true, parent_id: null },
    { id: 'sub-social',  node_type: 'subject', name: 'Social Science', icon: '🌍', sort_order: 3, is_active: true, parent_id: null },
    { id: 'sub-english', node_type: 'subject', name: 'English', icon: '📚', sort_order: 4, is_active: true, parent_id: null },
    { id: 'ch-sci-1', node_type: 'chapter', name: 'Chapter 1: Cell Structure', icon: '🧬', sort_order: 1, is_active: true, parent_id: 'sub-science' },
    { id: 'ch-sci-2', node_type: 'chapter', name: 'Chapter 2: Photosynthesis', icon: '🌿', sort_order: 2, is_active: true, parent_id: 'sub-science' },
    { id: 'ch-sci-3', node_type: 'chapter', name: 'Chapter 3: Human Body Systems', icon: '🫀', sort_order: 3, is_active: true, parent_id: 'sub-science' },
  ];
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
  try {
    const db   = getFirestore();
    const snap = await db.collection('ar_assets')
      .where('status', '==', 'published').limit(200).get();
    if (!snap.empty) {
      return res.json(snap.docs.map(d => ({
        id:         d.id,
        topic:      d.data().topic      || '',
        class_name: d.data().class_name || '',
        subject:    d.data().subject    || '',
        language:   d.data().language   || 'English',
        status:     d.data().status     || 'live',
        unity_url:  d.data().unity_url  || null,
        flutter_url:d.data().flutter_url|| null,
      })));
    }
  } catch (_) {}
  // Fallback — shown until first asset is published via dashboard
  res.json([
    { id: 'demo-1', topic: 'Cell Division', class_name: 'Class 9', subject: 'Science', language: 'English', status: 'live', unity_url: null, flutter_url: null },
    { id: 'demo-2', topic: 'Photosynthesis', class_name: 'Class 8', subject: 'Science', language: 'English', status: 'live', unity_url: null, flutter_url: null },
  ]);
});

// ── State Hierarchy ────────────────────────────────────────────────────────────
router.post('/hierarchy', async (req, res) => {
  try {
    const { state_code, structure } = req.body;
    if (!state_code) return res.status(400).json({ error: 'state_code required' });
    const db = getFirestore();
    await db.collection('curriculum_hierarchy').doc(state_code).set({ state_code, structure, updated_by: req.user?.id, updated_at: new Date() }, { merge: true });
    res.json({ message: 'Hierarchy saved', state_code });
  } catch (err) {
    res.json({ message: 'Hierarchy received', state_code: req.body.state_code });
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
