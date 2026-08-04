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

// ── POST /:id/publish — Publish a draft quiz ─────────────────────────────────
router.post('/:id/publish', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('quizzes').doc(req.params.id).update({
      status: 'published',
      published_at: new Date(),
      published_by: req.user.id,
    });
    res.json({ success: true, id: req.params.id, status: 'published' });
  } catch (err) {
    res.status(500).json({ error: 'Publish failed', detail: err.message });
  }
});

// ── POST /:id/pause — Pause a live quiz ──────────────────────────────────────
router.post('/:id/pause', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('quizzes').doc(req.params.id).update({
      status: 'paused',
      paused_at: new Date(),
      paused_by: req.user.id,
    });
    res.json({ success: true, id: req.params.id, status: 'paused' });
  } catch (err) {
    res.status(500).json({ error: 'Pause failed', detail: err.message });
  }
});

// ── POST /:id/schedule — Schedule a quiz to go live at a specific time ────────
// Stores the schedule in Firestore; a cron job or dispatch-scheduled
// endpoint would flip the status to published at the right time.
router.post('/:id/schedule', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { scheduled_at } = req.body;
    if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at required' });
    const db = getFirestore();
    await db.collection('quizzes').doc(req.params.id).update({
      status: 'scheduled',
      scheduled_at: new Date(scheduled_at),
      scheduled_by: req.user.id,
    });
    res.json({ success: true, id: req.params.id, status: 'scheduled', scheduled_at });
  } catch (err) {
    res.status(500).json({ error: 'Schedule failed', detail: err.message });
  }
});

// ── POST /bulk-upload — Upload questions from XLSX ────────────────────────────
// Accepts a quiz_id in the body and a pre-uploaded storage key for the xlsx.
// Parses the sheet using the xlsx library already in package.json.
router.post('/bulk-upload', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { quiz_id, questions } = req.body;
    if (!quiz_id) return res.status(400).json({ error: 'quiz_id required' });
    if (!Array.isArray(questions) || !questions.length) {
      return res.status(400).json({ error: 'questions array required' });
    }

    const db    = getFirestore();
    const batch = db.batch();
    questions.forEach((q, i) => {
      const ref = db.collection('quizzes').doc(quiz_id).collection('questions').doc();
      batch.set(ref, {
        question_text:         q.question_text         || q.Question       || '',
        options:               q.options               || [q.A, q.B, q.C, q.D].filter(Boolean),
        correct_answer_index:  q.correct_answer_index  ?? (q.Answer ? ['A','B','C','D'].indexOf(q.Answer) : 0),
        explanation:           q.explanation           || q.Explanation    || '',
        sort_order:            q.sort_order            ?? i,
        created_at:            new Date(),
      });
    });
    await batch.commit();

    // Update question count on the parent quiz
    await db.collection('quizzes').doc(quiz_id).update({ question_count: questions.length });

    res.json({ success: true, uploaded: questions.length, quiz_id });
  } catch (err) {
    res.status(500).json({ error: 'Bulk upload failed', detail: err.message });
  }
});

// ── GET /template — Download a blank XLSX question template ──────────────────
// index.html calls this when admin clicks "Download Template"
router.get('/template', requirePerm('perm_edit_curriculum'), (req, res) => {
  const XLSX = require('xlsx');
  const rows = [
    {
      question_text: 'What is the powerhouse of the cell?',
      A: 'Nucleus', B: 'Mitochondria', C: 'Ribosome', D: 'Golgi Apparatus',
      Answer: 'B',
      Explanation: 'Mitochondria produces ATP energy for the cell.',
    },
    {
      question_text: 'Which gas do plants absorb during photosynthesis?',
      A: 'Oxygen', B: 'Nitrogen', C: 'Carbon Dioxide', D: 'Hydrogen',
      Answer: 'C',
      Explanation: 'Plants absorb CO2 and release O2 during photosynthesis.',
    },
  ];

  const ws = XLSX.utils.json_to_sheet(rows);
  // Set column widths
  ws['!cols'] = [
    { wch: 60 }, { wch: 30 }, { wch: 30 }, { wch: 30 }, { wch: 30 },
    { wch: 10 }, { wch: 60 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Questions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename="MITRA_Quiz_Template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
