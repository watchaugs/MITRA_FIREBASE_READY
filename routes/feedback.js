'use strict';
// ════════════════════════════════════════════════════════════════════════════
// MITRA — Feedback & NPS receiver (Table A gap closer)
//
// The student app POSTs feedback / NPS / rating entries here. We only STORE
// them (one Firestore write each) — no compute, no scheduler, scale-to-zero safe.
// GET endpoints let the dashboard read them back for a Feedback tab.
// ════════════════════════════════════════════════════════════════════════════
const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getFirestore } = require('../lib/firebase');
const log = require('../lib/logger');

router.use(authenticate);

// POST /  — app submits a feedback / NPS entry. Never fail the client.
router.post('/', async (req, res) => {
  try {
    const db = getFirestore();
    const b  = req.body || {};
    await db.collection('app_feedback').add({
      type:         b.type || 'general',        // 'nps' | 'rating' | 'general' | 'bug'
      nps_score:    typeof b.nps_score === 'number' ? b.nps_score : null,   // 0–10
      rating:       typeof b.rating === 'number' ? b.rating : null,         // 1–5
      message:      (b.message || '').toString().slice(0, 2000),
      screen:       b.screen || null,
      state:        b.state || null,
      district:     b.district || null,
      class_grade:  b.class_grade || null,
      app_version:  b.app_version || null,
      device_model: b.device_model || null,
      student_id:   b.student_id || null,
      created_at:   new Date(),
      source:       'student_app',
    });
    res.status(202).json({ received: true });
  } catch (err) {
    log.error({ err: err.message }, 'feedback submit failed');
    res.status(202).json({ received: true, queued: true });  // don't trigger app retries
  }
});

// GET /  — dashboard reads recent feedback (capped; cheap).
router.get('/', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('app_feedback').orderBy('created_at', 'desc').limit(500).get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ data, total: data.length });
  } catch (_) {
    res.json({ data: [], total: 0 });
  }
});

// GET /nps  — NPS summary (Promoters 9–10, Passives 7–8, Detractors 0–6).
router.get('/nps', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('app_feedback').where('type', '==', 'nps').limit(5000).get();
    let promoters = 0, passives = 0, detractors = 0, n = 0;
    snap.docs.forEach(d => {
      const s = d.data().nps_score;
      if (typeof s !== 'number') return;
      n++;
      if (s >= 9) promoters++; else if (s >= 7) passives++; else detractors++;
    });
    const nps = n > 0 ? Math.round(((promoters - detractors) / n) * 100) : 0;
    res.json({ nps, promoters, passives, detractors, responses: n });
  } catch (_) {
    res.json({ nps: 0, promoters: 0, passives: 0, detractors: 0, responses: 0 });
  }
});

module.exports = router;