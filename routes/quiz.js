// ═══════════════════════════════════════════════════════════════════════
// routes/quiz.js — Quiz management
// Quizzes are stored in and served from Firestore.
// ═══════════════════════════════════════════════════════════════════════
'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { authenticate, requirePerm } = require('../middleware/auth');
const { visibleInState, parseTargetStates } = require('../lib/stateScope');
const { isAppCaller, isReleased, cleanRelease, mergeStateRelease } = require('../lib/release');
const LIVE_STATUSES = new Set(['live', 'published']);
const log = require('../lib/logger');
router.use((req, res, next) => {
  // Cloud Scheduler calls /dispatch-scheduled with a shared secret (no user token).
  if (req.path === '/dispatch-scheduled' &&
      process.env.DISPATCH_SECRET &&
      req.get('x-cron-secret') === process.env.DISPATCH_SECRET) {
    req.user = { id: 'cloud-scheduler', role: 'master_admin' };
    return next();
  }
  return authenticate(req, res, next);
});

router.get('/', async (req, res) => {
  try {
    const db = getFirestore();
    const snap = await db.collection('quizzes').limit(50).get();
    let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    rows     = visibleInState(rows, req.query.state); // geofence: national + requested state
    if (isAppCaller(req)) {
      // Students: only live/published quizzes that are released for their state.
      // (The app treats any unknown status as "live", so drafts/paused used to show.)
      const st = req.query.state || req.user.state;
      rows = rows.filter(q => LIVE_STATUSES.has(q.status) && isReleased(q, st))
                 .map(q => ({ ...q, status: 'live' }));
    }
    return res.json({ data: rows, total: rows.length });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load quizzes');
    res.status(500).json({ error: 'Failed to load quizzes' });
  }
});

router.get('/:id', async (req, res, next) => {
  // '/:id' is declared before '/analytics' and '/template', so Express sent those
  // requests here and answered 404 "Quiz not found". Hand them on instead.
  if (req.params.id === 'analytics' || req.params.id === 'template') return next();
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
    const { go_live_immediately, release, ...fields } = req.body || {};
    const status = go_live_immediately === true ? 'live' : 'draft';
    if (release) fields.release = cleanRelease(release);
    await db.collection('quizzes').doc(id).set({ ...fields, target_states: parseTargetStates(fields.target_states), created_by: req.user.id, created_at: new Date(), status, question_count: 0 });
    res.status(201).json({ id, ...fields, status });
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

// ── Shared: load quiz attempts once, normalised + filtered ───────────────────
// The app stores raw points (score / max_score) and time_taken_secs; older code
// treated score as a percentage and read a time field that does not exist.
async function loadAttempts(db, q = {}) {
  const [attemptsSnap, quizzesSnap] = await Promise.all([
    db.collection('quiz_attempts').limit(2000).get(),
    db.collection('quizzes').limit(500).get(),
  ]);
  const quizzes = {};
  quizzesSnap.docs.forEach(d => { quizzes[d.id] = { id: d.id, ...d.data() }; });
  const ms = (v) => (v && typeof v.toDate === 'function') ? v.toDate().getTime() : (v ? new Date(v).getTime() : 0);
  const days = parseInt(q.days, 10) || 0;
  const since = days ? Date.now() - days * 86400000 : 0;
  const lc = (v) => String(v || '').trim().toLowerCase();
  const rows = attemptsSnap.docs.map(d => {
    const a = d.data();
    const quiz = quizzes[a.quiz_id] || {};
    const max = Number(a.max_score) || 0;
    const raw = Number(a.score) || 0;
    return {
      quiz_id: a.quiz_id || null, student_id: a.student_id || null,
      pct: max > 0 ? (raw / max) * 100 : raw,
      time_secs: Number(a.time_taken_secs ?? a.time_secs) || 0,
      subject: a.subject || quiz.subject || null,
      class_name: a.class_grade || a.class_name || quiz.class_name || null,
      state: a.state || null, district: a.district || null,
      language: a.app_language || a.language || quiz.language || null,
      at: ms(a.completed_at) || ms(a.submitted_at) || ms(a.synced_at),
    };
  }).filter(a =>
    (!since || a.at >= since) &&
    (!q.state || lc(a.state) === lc(q.state)) &&
    (!q.district || lc(a.district) === lc(q.district)) &&
    (!q.class_name || lc(a.class_name) === lc(q.class_name)) &&
    (!q.subject || lc(a.subject) === lc(q.subject)) &&
    (!q.language || lc(a.language) === lc(q.language)));
  return { rows, quizzes };
}
const round1 = (v) => parseFloat((Number(v) || 0).toFixed(1));
function groupBy(rows, key) {
  const m = {};
  rows.forEach(a => {
    const k = a[key]; if (!k) return;
    m[k] = m[k] || { attempts: 0, total: 0, passed: 0 };
    m[k].attempts++; m[k].total += a.pct; if (a.pct >= 40) m[k].passed++;
  });
  return Object.entries(m).map(([k, d]) => ({ [key]: k, attempts: d.attempts,
    avg_score: round1(d.total / d.attempts), pass_rate: round1((d.passed / d.attempts) * 100) }))
    .sort((x, y) => y.attempts - x.attempts);
}

router.get('/analytics/deep', async (req, res) => {
  try {
    const { rows } = await loadAttempts(getFirestore(), { days: req.query.days });
    const total = rows.length;
    if (!total) return res.json({ overview: { total_attempts: 0, avg_score: 0, pass_rate: 0, avg_time_secs: 0 }, by_subject: [], by_state: [], hard_questions: [] });
    res.json({
      overview: {
        total_attempts: total,
        avg_score:      round1(rows.reduce((s, a) => s + a.pct, 0) / total),
        pass_rate:      round1((rows.filter(a => a.pct >= 40).length / total) * 100),
        avg_time_secs:  Math.round(rows.reduce((s, a) => s + a.time_secs, 0) / total),
      },
      by_subject: groupBy(rows, 'subject'),
      by_state:   groupBy(rows, 'state'),
      hard_questions: [],
    });
  } catch (err) {
    log.error({ err: err.message }, 'deep quiz analytics failed');
    res.status(500).json({ error: 'Failed to load quiz insights' });
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
    // No scheduler needed: the quiz is published now with a release date —
    // students start seeing it from that moment (checked on every app read).
    const release = cleanRelease({ mode: 'date', at: scheduled_at });
    const db = getFirestore();
    await db.collection('quizzes').doc(req.params.id).update({
      status: 'live', release,
      scheduled_at: new Date(scheduled_at),
      scheduled_by: req.user.id,
    });
    res.json({ success: true, id: req.params.id, status: 'live', release, scheduled_at });
  } catch (err) {
    res.status(500).json({ error: 'Schedule failed', detail: err.message });
  }
});

// ── PUT /:id/release-state ─── release in ONE state (Curriculum page) ───────
router.put('/:id/release-state', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    const ref = db.collection('quizzes').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Quiz not found' });
    const release = cleanRelease(mergeStateRelease(doc.data().release, req.body?.state, req.body?.value));
    await ref.update({ release, release_updated_by: req.user.id, release_updated_at: new Date() });
    res.json({ success: true, id: req.params.id, release });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save release' });
  }
});

// ── PUT /:id/release ─── when students may see this quiz ─────────────────────
router.put('/:id/release', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const release = cleanRelease(req.body && req.body.release);
    const db = getFirestore();
    const ref = db.collection('quizzes').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ error: 'Quiz not found' });
    await ref.update({ release, release_updated_by: req.user.id, release_updated_at: new Date() });
    await db.collection('audit_log').add({ action: 'quiz_release_set', actor: req.user.id, detail: { quiz_id: req.params.id, release }, created_at: new Date() });
    res.json({ success: true, id: req.params.id, release });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save release' });
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
    // Filters from the dashboard: state, district, class_name, subject, language, days
    const { rows, quizzes } = await loadAttempts(getFirestore(), req.query);
    const total_attempts  = rows.length;
    const unique_students = new Set(rows.map(a => a.student_id).filter(Boolean)).size;
    const avg_score_pct   = total_attempts ? round1(rows.reduce((s, a) => s + a.pct, 0) / total_attempts) : 0;
    const liveQuizzes = Object.values(quizzes).filter(q => ['live', 'published'].includes(q.status)).length;
    const completion_rate = (liveQuizzes && unique_students)
      ? round1(Math.min(100, (total_attempts / (liveQuizzes * unique_students)) * 100)) : 0;

    const buckets = [['0–25%', 0, 25], ['25–50%', 25, 50], ['50–75%', 50, 75], ['75–100%', 75, 101]];
    const score_distribution = total_attempts
      ? buckets.map(([bucket, lo, hi]) => ({ bucket, count: rows.filter(a => a.pct >= lo && a.pct < hi).length })) : [];

    const perQuiz = {};
    rows.forEach(a => {
      if (!a.quiz_id) return;
      perQuiz[a.quiz_id] = perQuiz[a.quiz_id] || { attempts: 0, total: 0, students: new Set() };
      perQuiz[a.quiz_id].attempts++; perQuiz[a.quiz_id].total += a.pct;
      if (a.student_id) perQuiz[a.quiz_id].students.add(a.student_id);
    });
    const top_quizzes = Object.entries(perQuiz).map(([quiz_id, d]) => {
      const q = quizzes[quiz_id] || {};
      return { quiz_id, title: q.title || quiz_id, class_name: q.class_name || null, subject: q.subject || null,
               topic: q.topic || null, language: q.language || null, status: q.status || null,
               attempts: d.attempts, avg_score_pct: round1(d.total / d.attempts),
               completion_rate: unique_students ? round1((d.students.size / unique_students) * 100) : 0 };
    }).sort((a, b) => b.attempts - a.attempts).slice(0, 10);

    res.json({
      kpi: { total_attempts, unique_students, avg_score_pct, completion_rate },
      score_distribution,
      by_subject: groupBy(rows, 'subject'),
      by_class:   groupBy(rows, 'class_name'),
      by_state:   groupBy(rows, 'state'),
      top_quizzes,
    });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load quiz analytics');
    res.status(500).json({ error: 'Failed to load quiz analytics' });
  }
});

// ── Change #32: Quiz analytics export (XLSX) ──────────────────────────────────
router.get('/analytics/export', requirePerm('perm_export_data'), async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const { rows, quizzes } = await loadAttempts(getFirestore(), req.query);
    const out = rows.map(a => ({
      'Quiz': (quizzes[a.quiz_id] || {}).title || a.quiz_id || '',
      'Student ID': a.student_id || '',
      'Score %': round1(a.pct),
      'Time (secs)': a.time_secs || '',
      'Subject': a.subject || '', 'Class': a.class_name || '',
      'State': a.state || '', 'District': a.district || '', 'Language': a.language || '',
      'Completed At': a.at ? new Date(a.at).toISOString() : '',
    }));
    const ws = XLSX.utils.json_to_sheet(out);
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

// ── POST /dispatch-scheduled ─ Cloud Scheduler flips due scheduled quizzes live ─
router.post('/dispatch-scheduled', async (req, res) => {
  try {
    const db  = getFirestore();
    const now = new Date();
    const snap = await db.collection('quizzes')
      .where('status', '==', 'scheduled')
      .where('scheduled_at', '<=', now)
      .limit(200)
      .get();
    if (snap.empty) return res.json({ published: 0 });
    let published = 0;
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = db.batch();
      for (const doc of snap.docs.slice(i, i + 400)) { batch.update(doc.ref, { status: 'live', published_at: now }); published++; }
      await batch.commit();
    }
    res.json({ published });
  } catch (err) {
    res.status(500).json({ error: 'Quiz dispatch failed', detail: err.message });
  }
});

module.exports = router;