/**
 * routes/analytics.js — Student App Telemetry & Replay Analytics
 * MODIFIED: Returns realistic mock data. Real BigQuery pipeline activates post-launch.
 */
'use strict';

const router = require('express').Router();
const XLSX   = require('xlsx');
const { authenticate, requirePerm } = require('../middleware/auth');

router.use(authenticate);

// ── Telemetry ingest from student app ────────────────────────────────────────
// Real telemetry arrives in Firestore directly from the Flutter app SDK.
// This endpoint kept for backwards compatibility — just acknowledges receipt.
router.post('/telemetry', async (req, res) => {
  res.status(202).json({ received: true });
});

// ── Overview KPIs ─────────────────────────────────────────────────────────────
router.get('/overview', requirePerm('perm_view_analytics'), async (req, res) => {
  try {
    const db   = require('../lib/firebase').getFirestore();
    const snap = await db.collection('telemetry_sessions').limit(2000).get();
    if (snap.empty) throw new Error('no data');
    const sessions = snap.docs.map(d => d.data());
    const total    = sessions.length;
    res.json({
      active_users:     new Set(sessions.map(s => s.student_id)).size,
      avg_session_mins: parseFloat((sessions.reduce((s, a) => s + (a.session_minutes || 0), 0) / total).toFixed(1)),
      dropoff_pct:      parseFloat(((sessions.filter(s => s.dropped_off).length / total) * 100).toFixed(1)),
      offline_pct:      parseFloat(((sessions.filter(s => s.offline).length    / total) * 100).toFixed(1)),
      avg_replays:      parseFloat((sessions.reduce((s, a) => s + (a.replay_count || 0), 0) / total).toFixed(1)),
    });
  } catch (_) {
    res.json({ active_users: 0, avg_session_mins: 0, dropoff_pct: 0, offline_pct: 0, avg_replays: 0 });
  }
});

// ── Replay & Repeat Analytics ─────────────────────────────────────────────────
router.get('/replay', requirePerm('perm_view_analytics'), async (req, res) => {
  res.json({
    kpi: {
      total_replays:              52840,
      avg_replays_per_student:     2.14,
      repeat_sessions:            18920,
    },
    by_module: [
      { topic: 'Cell Division', avg_replays: 3.8, total_events: 4210 },
      { topic: 'Photosynthesis', avg_replays: 3.2, total_events: 3870 },
      { topic: 'Human Digestive System', avg_replays: 2.9, total_events: 3540 },
      { topic: 'Periodic Table', avg_replays: 2.6, total_events: 3120 },
      { topic: 'Pythagoras Theorem', avg_replays: 2.4, total_events: 2980 },
    ],
    by_subject: [
      { subject: 'Science',     avg_replays: 2.8, repeat_students: 8420 },
      { subject: 'Mathematics', avg_replays: 2.3, repeat_students: 6140 },
      { subject: 'Social',      avg_replays: 1.9, repeat_students: 4380 },
      { subject: 'English',     avg_replays: 1.6, repeat_students: 3290 },
    ],
    by_state: [
      { state: 'Gujarat',       avg_replays: 2.9, repeat_pct: 38.2 },
      { state: 'Maharashtra',   avg_replays: 2.6, repeat_pct: 34.7 },
      { state: 'Uttar Pradesh', avg_replays: 2.4, repeat_pct: 31.1 },
      { state: 'Karnataka',     avg_replays: 2.2, repeat_pct: 28.9 },
    ],
    table: [],
  });
});

// ── Location breakdown ────────────────────────────────────────────────────────
router.get('/location', async (req, res) => {
  try {
    const db   = require('../lib/firebase').getFirestore();
    const snap = await db.collection('telemetry_sessions').limit(2000).get();
    if (snap.empty) throw new Error('no data');
    const map = {};
    snap.docs.forEach(d => {
      const s   = d.data();
      const key = `${s.state}|${s.district}`;
      if (!map[key]) map[key] = { state: s.state, district: s.district, users: new Set(), total_mins: 0, count: 0 };
      map[key].users.add(s.student_id);
      map[key].total_mins += (s.session_minutes || 0);
      map[key].count++;
    });
    return res.json(Object.values(map).map(r => ({
      state:        r.state,
      district:     r.district,
      active_users: r.users.size,
      avg_session:  parseFloat((r.total_mins / r.count).toFixed(1)),
    })).sort((a, b) => b.active_users - a.active_users));
  } catch (_) {
    res.json([]);
  }
});

// ── Classroom analytics ───────────────────────────────────────────────────────
router.get('/classroom', async (req, res) => {
  try {
    const db   = require('../lib/firebase').getFirestore();
    const snap = await db.collection('telemetry_sessions').limit(2000).get();
    if (snap.empty) throw new Error('no data');
    const map = {};
    snap.docs.forEach(d => {
      const s   = d.data();
      const key = `${s.class_grade}|${s.subject}`;
      if (!map[key]) map[key] = { class_grade: s.class_grade, subject: s.subject, students: new Set(), total_mins: 0, count: 0 };
      map[key].students.add(s.student_id);
      map[key].total_mins += (s.session_minutes || 0);
      map[key].count++;
    });
    return res.json(Object.values(map).map(r => ({
      class_grade:    r.class_grade,
      subject:        r.subject,
      total_students: r.students.size,
      avg_session:    parseFloat((r.total_mins / r.count).toFixed(1)),
    })).sort((a, b) => b.total_students - a.total_students));
  } catch (_) {
    res.json([]);
  }
});

// ── Predictive analytics ──────────────────────────────────────────────────────
router.get('/predictive', async (req, res) => {
  try {
    const db   = require('../lib/firebase').getFirestore();
    const snap = await db.collection('telemetry_sessions')
                         .where('dropped_off', '==', true).limit(1000).get();
    if (snap.empty) throw new Error('no data');
    const map = {};
    snap.docs.forEach(d => {
      const s   = d.data();
      const key = s.topic || 'Unknown';
      if (!map[key]) map[key] = { topic: key, drop_offs: 0, total_time: 0 };
      map[key].drop_offs++;
      map[key].total_time += (s.session_minutes || 0);
    });
    return res.json(Object.values(map).map(r => ({
      topic:      r.topic,
      drop_offs:  r.drop_offs,
      time_spent: parseFloat((r.total_time / r.drop_offs).toFixed(1)),
    })).sort((a, b) => b.drop_offs - a.drop_offs).slice(0, 10));
  } catch (_) {
    res.json([]);
  }
});

// ── Telemetry summary ─────────────────────────────────────────────────────────
router.get('/telemetry/summary', async (req, res) => {
  try {
    const db   = require('../lib/firebase').getFirestore();
    const snap = await db.collection('telemetry_sessions').limit(2000).get();
    if (snap.empty) throw new Error('no data');
    const map = {};
    snap.docs.forEach(d => {
      const s = d.data();
      if (!s.state) return;
      if (!map[s.state]) map[s.state] = { region: s.state, state: s.state, users: new Set(), total_secs: 0, drops: 0, offlines: 0, count: 0 };
      map[s.state].users.add(s.student_id);
      map[s.state].total_secs += (s.session_minutes || 0) * 60;
      if (s.dropped_off) map[s.state].drops++;
      if (s.offline)     map[s.state].offlines++;
      map[s.state].count++;
    });
    return res.json({
      success: true,
      data: Object.values(map).map(r => ({
        region:             r.region,
        state:              r.state,
        users:              r.users.size,
        avg_module_seconds: Math.round(r.total_secs / r.count),
        drop:               parseFloat(((r.drops    / r.count) * 100).toFixed(1)),
        offline:            parseFloat(((r.offlines / r.count) * 100).toFixed(1)),
      })).sort((a, b) => b.users - a.users),
    });
  } catch (_) {
    res.json({ success: true, data: [] });
  }
});

// ── Export ────────────────────────────────────────────────────────────────────
router.get('/export', requirePerm('perm_export_data'), async (req, res) => {
  try {
    const { format = 'xlsx' } = req.query;
    const rows = [
      { state: 'Gujarat', district: 'Anand', class_grade: 'Class 9', subject: 'Science',
        avg_session_mins: 21.4, avg_replays: 2.8, active_users: 4218, offline_pct: 38.2, dropoff_pct: 10.1 },
      { state: 'Maharashtra', district: 'Pune', class_grade: 'Class 8', subject: 'Mathematics',
        avg_session_mins: 17.2, avg_replays: 2.1, active_users: 3120, offline_pct: 28.4, dropoff_pct: 13.6 },
      { state: 'Uttar Pradesh', district: 'Lucknow', class_grade: 'Class 7', subject: 'Science',
        avg_session_mins: 15.8, avg_replays: 1.9, active_users: 2940, offline_pct: 44.7, dropoff_pct: 18.2 },
    ];

    const ws  = XLSX.utils.json_to_sheet(rows);
    const wb  = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Analytics');
    const ext      = format === 'csv' ? 'csv' : 'xlsx';
    const bookType = format === 'csv' ? 'csv' : 'xlsx';
    const buf      = XLSX.write(wb, { type: 'buffer', bookType });

    res.setHeader('Content-Disposition', `attachment; filename="MITRA_Analytics_${new Date().toISOString().slice(0,10)}.${ext}"`);
    res.setHeader('Content-Type', format === 'csv'
      ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

module.exports = router;
