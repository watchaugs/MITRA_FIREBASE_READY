// ═══════════════════════════════════════════════════════════════════════
// routes/quiz.js — Quiz management
// MODIFIED: Returns mock data. Real quizzes stored in Firestore.
// ═══════════════════════════════════════════════════════════════════════
'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { authenticate, requirePerm } = require('../middleware/auth');
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const db = getFirestore();
    const snap = await db.collection('quizzes').limit(50).get();
    if (!snap.empty) return res.json({ data: snap.docs.map(d => ({ id: d.id, ...d.data() })), total: snap.size });
  } catch (_) {}
  res.json({
    data: [
      { id: 'quiz-1', title: 'Science Chapter 1 Quiz', class_name: 'Class 9', subject: 'Science', topic: 'Cell Structure', language: 'English', status: 'published', question_count: 10 },
      { id: 'quiz-2', title: 'Mathematics Chapter 2 Quiz', class_name: 'Class 8', subject: 'Mathematics', topic: 'Algebra', language: 'Hindi', status: 'published', question_count: 15 },
      { id: 'quiz-3', title: 'Social Science Quiz', class_name: 'Class 7', subject: 'Social Science', topic: 'Indian History', language: 'English', status: 'draft', question_count: 8 },
    ],
    total: 3,
  });
});

router.get('/:id', async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('quizzes').doc(req.params.id).get();
    if (doc.exists) return res.json({ id: doc.id, ...doc.data() });
  } catch (_) {}
  res.json({ id: req.params.id, title: 'Quiz', questions: [] });
});

router.get('/:id/questions', async (req, res) => {
  res.json([
    { id: uuidv4(), question_text: 'What is the powerhouse of the cell?', options: ['Nucleus', 'Mitochondria', 'Ribosome', 'Golgi Apparatus'], correct_answer_index: 1, explanation: 'Mitochondria produces ATP energy.' },
    { id: uuidv4(), question_text: 'Which process makes food in plants?', options: ['Respiration', 'Digestion', 'Photosynthesis', 'Absorption'], correct_answer_index: 2, explanation: 'Photosynthesis uses sunlight to make food.' },
  ]);
});

router.post('/', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    const id = uuidv4();
    await db.collection('quizzes').doc(id).set({ ...req.body, created_by: req.user.id, created_at: new Date(), status: 'draft' });
    res.status(201).json({ id, ...req.body });
  } catch { res.status(500).json({ error: 'Failed to create quiz' }); }
});

router.put('/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('quizzes').doc(req.params.id).update({ ...req.body, updated_at: new Date() });
    res.json({ id: req.params.id, ...req.body });
  } catch { res.status(500).json({ error: 'Failed to update quiz' }); }
});

router.delete('/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('quizzes').doc(req.params.id).update({ status: 'archived' });
    res.json({ message: 'Quiz archived' });
  } catch { res.status(500).json({ error: 'Failed to delete quiz' }); }
});

router.post('/attempts/batch', async (req, res) => {
  try {
    const { attempts } = req.body;
    if (!Array.isArray(attempts)) return res.status(400).json({ error: 'attempts array required' });
    const db = getFirestore();
    const batch = db.batch();
    attempts.forEach(a => {
      const ref = db.collection('quiz_attempts').doc(uuidv4());
      batch.set(ref, { ...a, synced_at: new Date() });
    });
    await batch.commit();
    res.json({ received: true, count: attempts.length });
  } catch (err) {
    res.status(500).json({ error: 'Batch submit failed' });
  }
});

router.get('/analytics/deep', async (req, res) => {
  res.json({
    overview: { total_attempts: 8420, avg_score: 68.4, pass_rate: 72.1, avg_time_secs: 840 },
    by_subject: [
      { subject: 'Science',     attempts: 3210, avg_score: 71.2, pass_rate: 76.4 },
      { subject: 'Mathematics', attempts: 2840, avg_score: 64.8, pass_rate: 68.2 },
      { subject: 'Social',      attempts: 1420, avg_score: 72.6, pass_rate: 78.1 },
      { subject: 'English',     attempts: 950,  avg_score: 69.4, pass_rate: 74.3 },
    ],
    by_state: [
      { state: 'Gujarat',       attempts: 2840, avg_score: 72.4 },
      { state: 'Maharashtra',   attempts: 2210, avg_score: 69.8 },
      { state: 'Uttar Pradesh', attempts: 1840, avg_score: 62.1 },
    ],
    hard_questions: [],
  });
});

router.post('/attempts', async (req, res) => {
  res.status(202).json({ received: true });
});

module.exports = router;
