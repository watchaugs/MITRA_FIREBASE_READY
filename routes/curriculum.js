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
router.get('/ar-topics', async (req, res) => {
  res.json([
    { id: uuidv4(), topic: 'Cell Division',          class_name: 'Class 9', subject: 'Science',     language: 'English', status: 'live' },
    { id: uuidv4(), topic: 'Photosynthesis',          class_name: 'Class 8', subject: 'Science',     language: 'English', status: 'live' },
    { id: uuidv4(), topic: 'Human Digestive System',  class_name: 'Class 10', subject: 'Science',   language: 'Hindi',   status: 'live' },
    { id: uuidv4(), topic: 'Periodic Table',          class_name: 'Class 9', subject: 'Chemistry',  language: 'English', status: 'review' },
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
  const { node_id, quiz_id } = req.body;
  if (!node_id || !quiz_id) return res.status(400).json({ error: 'node_id and quiz_id required' });
  res.status(201).json({ message: 'Quiz linked', link: { id: uuidv4(), node_id, quiz_id } });
});

router.delete('/quiz-links/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  res.json({ message: 'Quiz link removed' });
});

router.get('/quiz-links/:nodeId', async (req, res) => {
  res.json([]);
});

// ── AR Links ────────────────────────────────────────────────────────────────────
router.post('/ar-links', requirePerm('perm_edit_curriculum'), async (req, res) => {
  const { curriculum_node_id, asset_id } = req.body;
  if (!curriculum_node_id || !asset_id) return res.status(400).json({ error: 'curriculum_node_id and asset_id required' });
  res.status(201).json({ message: 'AR asset linked', link: { id: uuidv4(), curriculum_node_id, asset_id } });
});

router.delete('/ar-links/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  res.json({ message: 'AR link removed' });
});

router.get('/ar-links/:nodeId', async (req, res) => {
  res.json([]);
});

// ── Schedule ─────────────────────────────────────────────────────────────────────
router.post('/schedule', authenticate, async (req, res) => {
  res.json({ success: true });
});

module.exports = router;
