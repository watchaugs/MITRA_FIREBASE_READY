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
  res.json({
    active_users:     24731,
    avg_session_mins: 18.4,
    dropoff_pct:      12.3,
    offline_pct:      34.7,
    avg_replays:       2.1,
  });
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
  res.json([
    { state: 'Gujarat',       district: 'Anand',       active_users: 4218, avg_session: 19.2 },
    { state: 'Gujarat',       district: 'Ahmedabad',   active_users: 3841, avg_session: 17.8 },
    { state: 'Maharashtra',   district: 'Pune',        active_users: 3120, avg_session: 18.4 },
    { state: 'Uttar Pradesh', district: 'Lucknow',     active_users: 2940, avg_session: 16.2 },
    { state: 'Karnataka',     district: 'Bangalore',   active_users: 2710, avg_session: 20.1 },
    { state: 'Tamil Nadu',    district: 'Chennai',     active_users: 2480, avg_session: 17.6 },
    { state: 'Rajasthan',     district: 'Jaipur',      active_users: 1940, avg_session: 15.8 },
    { state: 'Madhya Pradesh', district: 'Bhopal',     active_users: 1620, avg_session: 14.9 },
  ]);
});

// ── Classroom analytics ───────────────────────────────────────────────────────
router.get('/classroom', async (req, res) => {
  res.json([
    { class_grade: 'Class 6',  subject: 'Science',     avg_session: 17.2, total_students: 4120 },
    { class_grade: 'Class 6',  subject: 'Mathematics',  avg_session: 14.8, total_students: 3980 },
    { class_grade: 'Class 7',  subject: 'Science',     avg_session: 18.4, total_students: 4310 },
    { class_grade: 'Class 7',  subject: 'Mathematics',  avg_session: 15.9, total_students: 4080 },
    { class_grade: 'Class 8',  subject: 'Science',     avg_session: 19.8, total_students: 4540 },
    { class_grade: 'Class 8',  subject: 'Mathematics',  avg_session: 16.4, total_students: 4210 },
    { class_grade: 'Class 9',  subject: 'Science',     avg_session: 21.2, total_students: 4720 },
    { class_grade: 'Class 10', subject: 'Science',     avg_session: 22.6, total_students: 4890 },
  ]);
});

// ── Predictive analytics ──────────────────────────────────────────────────────
router.get('/predictive', async (req, res) => {
  res.json([
    { topic_id: null, drop_offs: 842, time_spent: 4.2,  topic: 'Algebra — Linear Equations' },
    { topic_id: null, drop_offs: 718, time_spent: 3.8,  topic: 'Organic Chemistry Basics' },
    { topic_id: null, drop_offs: 694, time_spent: 5.1,  topic: 'Grammar — Tenses' },
    { topic_id: null, drop_offs: 621, time_spent: 4.7,  topic: 'Trigonometry' },
    { topic_id: null, drop_offs: 580, time_spent: 3.2,  topic: 'World War II History' },
  ]);
});

// ── Telemetry summary ─────────────────────────────────────────────────────────
router.get('/telemetry/summary', async (req, res) => {
  res.json({
    success: true,
    data: [
      { region: 'Gujarat',       state: 'GJ', district: 'All', users: 8241, avg_module_seconds: 1104, drop: 11.2, offline: 38.4, subject: 'Science' },
      { region: 'Maharashtra',   state: 'MH', district: 'All', users: 7318, avg_module_seconds: 984,  drop: 13.8, offline: 29.6, subject: 'Science' },
      { region: 'Uttar Pradesh', state: 'UP', district: 'All', users: 4920, avg_module_seconds: 912,  drop: 16.4, offline: 42.1, subject: 'Mathematics' },
      { region: 'Karnataka',     state: 'KA', district: 'All', users: 3840, avg_module_seconds: 1188, drop: 9.7,  offline: 22.8, subject: 'Science' },
      { region: 'Tamil Nadu',    state: 'TN', district: 'All', users: 3412, avg_module_seconds: 1056, drop: 10.4, offline: 18.3, subject: 'Mathematics' },
    ],
  });
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
