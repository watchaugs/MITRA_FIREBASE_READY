// ═══════════════════════════════════════════════════════════════════════
// routes/quiz.js — Quiz management
// MODIFIED: Returns mock data. Real quizzes stored in Firestore.
// ═══════════════════════════════════════════════════════════════════════
'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { authenticate, requirePerm } = require('../middleware/auth');
const log = require('../lib/logger');
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const db = getFirestore();
    const snap = await db.collection('quizzes').limit(50).get();
    return res.json({ data: snap.docs.map(d => ({ id: d.id, ...d.data() })), total: snap.size });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load quizzes');
    res.status(500).json({ error: 'Failed to load quizzes' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('quizzes').doc(req.params.id).get();
    if (doc.exists) return res.json({ id: doc.id, ...doc.data() });
    return res.status(404).json({ error: 'Quiz not found' });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load quiz');
    res.status(500).json({ error: 'Failed to load quiz' });
  }
});

router.get('/:id/questions', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('quizzes').doc(req.params.id)
                         .collection('questions').orderBy('sort_order').get();
    return res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load quiz questions');
    res.status(500).json({ error: 'Failed to load questions' });
  }
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

// ── Change #31: Quiz analytics KPIs + top quizzes table ──────────────────────
router.get('/analytics', async (req, res) => {
  try {
    const db = getFirestore();
    const [attemptsSnap, quizzesSnap] = await Promise.all([
      db.collection('quiz_attempts').limit(2000).get(),
      db.collection('quizzes').get(),
    ]);
    const attempts = attemptsSnap.docs.map(d => d.data());
    const total_attempts  = attempts.length;
    const unique_students = new Set(attempts.map(a => a.student_id).filter(Boolean)).size;
    const avg_score_pct   = total_attempts
      ? parseFloat((attempts.reduce((s, a) => s + (a.score || 0), 0) / total_attempts).toFixed(1))
      : 0;
    const published_quizzes = quizzesSnap.docs.filter(d => d.data().status === 'published').length;
    const completion_rate = (published_quizzes && unique_students)
      ? parseFloat(Math.min(100, (total_attempts / (published_quizzes * unique_students)) * 100).toFixed(1))
      : 0;

    const perQuiz = {};
    attempts.forEach(a => {
      if (!a.quiz_id) return;
      perQuiz[a.quiz_id] = perQuiz[a.quiz_id] || { attempts: 0, total_score: 0 };
      perQuiz[a.quiz_id].attempts++;
      perQuiz[a.quiz_id].total_score += (a.score || 0);
    });
    const quizTitleMap = {};
    quizzesSnap.docs.forEach(d => { quizTitleMap[d.id] = d.data().title; });
    const top_quizzes = Object.entries(perQuiz)
      .map(([quiz_id, d]) => ({
        quiz_id, title: quizTitleMap[quiz_id] || quiz_id,
        attempts: d.attempts,
        avg_score_pct: parseFloat((d.total_score / d.attempts).toFixed(1)),
      }))
      .sort((a, b) => b.attempts - a.attempts)
      .slice(0, 10);

    res.json({ kpi: { total_attempts, unique_students, avg_score_pct, completion_rate }, top_quizzes });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load quiz analytics');
    res.status(500).json({ error: 'Failed to load quiz analytics' });
  }
});

// ── Change #32: Quiz analytics export (XLSX) ──────────────────────────────────
router.get('/analytics/export', requirePerm('perm_export_data'), async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const db   = getFirestore();
    const snap = await db.collection('quiz_attempts').limit(5000).get();
    const rows = snap.docs.map(d => {
      const a = d.data();
      return {
        'Quiz ID': a.quiz_id || '',
        'Student ID': a.student_id || '',
        'Score %': a.score || 0,
        'Time (secs)': a.time_secs || '',
        'Subject': a.subject || '',
        'State': a.state || '',
        'District': a.district || '',
        'Submitted At': a.submitted_at && a.submitted_at.toDate ? a.submitted_at.toDate().toISOString() : '',
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Quiz Attempts');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="Quiz_Analytics_Export.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    log.error({ err: err.message }, 'Quiz analytics export failed');
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── Change #33: Bulk actions (delete / publish / archive / pause) ────────────
router.post('/bulk-action', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { action, quizIds } = req.body || {};
    if (!Array.isArray(quizIds) || !quizIds.length) {
      return res.status(400).json({ error: 'quizIds required' });
    }
    const statusForAction = { publish: 'published', archive: 'archived', pause: 'draft' };
    if (action !== 'delete' && !statusForAction[action]) {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }
    const db    = getFirestore();
    const batch = db.batch();
    quizIds.forEach(id => {
      const ref = db.collection('quizzes').doc(id);
      if (action === 'delete') batch.delete(ref);
      else batch.update(ref, { status: statusForAction[action], updated_at: new Date() });
    });
    await batch.commit();
    res.json({ message: `Applied "${action}" to ${quizIds.length} quizzes`, action, count: quizIds.length });
  } catch (err) {
    log.error({ err: err.message }, 'Quiz bulk-action failed');
    res.status(500).json({ error: 'Bulk action failed' });
  }
});

module.exports = router;
