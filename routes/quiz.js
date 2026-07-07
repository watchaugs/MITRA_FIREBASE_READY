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
  try {
    const db   = getFirestore();
    const snap = await db.collection('quizzes').doc(req.params.id)
                         .collection('questions').orderBy('sort_order').get();
    if (!snap.empty) {
      return res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }
  } catch (_) {}
  // Fallback until real questions are added via dashboard
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
  try {
    const db   = getFirestore();
    const snap = await db.collection('quiz_attempts').limit(1000).get();

    if (snap.empty) throw new Error('no data');

    const attempts = snap.docs.map(d => d.data());

    // Overview
    const total     = attempts.length;
    const avg_score = attempts.reduce((s, a) => s + (a.score || 0), 0) / total;
    const pass_rate = (attempts.filter(a => (a.score || 0) >= 40).length / total) * 100;
    const avg_time  = attempts.reduce((s, a) => s + (a.time_secs || 0), 0) / total;

    // By subject
    const subjectMap = {};
    attempts.forEach(a => {
      if (!a.subject) return;
      if (!subjectMap[a.subject]) subjectMap[a.subject] = { attempts: 0, total_score: 0, passed: 0 };
      subjectMap[a.subject].attempts++;
      subjectMap[a.subject].total_score += (a.score || 0);
      if ((a.score || 0) >= 40) subjectMap[a.subject].passed++;
    });
    const by_subject = Object.entries(subjectMap).map(([subject, d]) => ({
      subject,
      attempts:  d.attempts,
      avg_score: parseFloat((d.total_score / d.attempts).toFixed(1)),
      pass_rate: parseFloat(((d.passed / d.attempts) * 100).toFixed(1)),
    }));

    // By state
    const stateMap = {};
    attempts.forEach(a => {
      if (!a.state) return;
      if (!stateMap[a.state]) stateMap[a.state] = { attempts: 0, total_score: 0 };
      stateMap[a.state].attempts++;
      stateMap[a.state].total_score += (a.score || 0);
    });
    const by_state = Object.entries(stateMap).map(([state, d]) => ({
      state,
      attempts:  d.attempts,
      avg_score: parseFloat((d.total_score / d.attempts).toFixed(1)),
    }));

    return res.json({
      overview: {
        total_attempts: total,
        avg_score:      parseFloat(avg_score.toFixed(1)),
        pass_rate:      parseFloat(pass_rate.toFixed(1)),
        avg_time_secs:  Math.round(avg_time),
      },
      by_subject,
      by_state,
      hard_questions: [],
    });
  } catch (_) {
    // Fallback until real attempts exist
    res.json({
      overview: { total_attempts: 0, avg_score: 0, pass_rate: 0, avg_time_secs: 0 },
      by_subject: [],
      by_state:   [],
      hard_questions: [],
    });
  }
});

router.post('/attempts', async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = { ...req.body, synced_at: new Date() };
    await db.collection('quiz_attempts').add(doc);
    res.status(202).json({ received: true });
  } catch (_) {
    // Never fail the student app
    res.status(202).json({ received: true, queued: true });
  }
});

module.exports = router;
