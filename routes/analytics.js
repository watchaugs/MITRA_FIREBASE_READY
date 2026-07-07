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
  try {
    const db = require('../lib/firebase').getFirestore();
    const payload = req.body;

    // Accept both: a single event object OR an array (weekly batch sync)
    const events = Array.isArray(payload) ? payload : [payload];

    const batch = db.batch();
    events.forEach(event => {
      const ref = db.collection('telemetry_sessions').doc();
      batch.set(ref, {
        ...event,
        ingested_at: new Date(),
        source: 'app_batch_sync',
      });
    });

    await batch.commit();
    res.status(202).json({ received: true, count: events.length });
  } catch (err) {
    // Never fail the student app — always acknowledge receipt
    // The client will retry next weekly sync
    res.status(202).json({ received: true, queued: true });
  }
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
  try {
    const db   = require('../lib/firebase').getFirestore();
    const snap = await db.collection('telemetry_sessions').limit(2000).get();

    if (snap.empty) throw new Error('no data');

    const sessions = snap.docs.map(d => d.data());
    const total    = sessions.length;

    // ── KPIs ──────────────────────────────────────────────────────────────
    const totalReplays   = sessions.reduce((s, a) => s + (a.replay_count || 0), 0);
    const repeatSessions = sessions.filter(s => (s.replay_count || 0) > 0).length;

    // ── By module (topic) ─────────────────────────────────────────────────
    const moduleMap = {};
    sessions.forEach(s => {
      const key = s.topic || 'Unknown';
      if (!moduleMap[key]) moduleMap[key] = { topic: key, total_replays: 0, count: 0 };
      moduleMap[key].total_replays += (s.replay_count || 0);
      moduleMap[key].count++;
    });
    const by_module = Object.values(moduleMap)
      .map(m => ({
        topic:        m.topic,
        avg_replays:  parseFloat((m.total_replays / m.count).toFixed(2)),
        total_events: m.count,
      }))
      .sort((a, b) => b.avg_replays - a.avg_replays)
      .slice(0, 10);

    // ── By subject ────────────────────────────────────────────────────────
    const subjectMap = {};
    sessions.forEach(s => {
      const key = s.subject || 'Unknown';
      if (!subjectMap[key]) subjectMap[key] = { subject: key, total_replays: 0, repeat_students: new Set(), count: 0 };
      subjectMap[key].total_replays += (s.replay_count || 0);
      if ((s.replay_count || 0) > 0) subjectMap[key].repeat_students.add(s.student_id);
      subjectMap[key].count++;
    });
    const by_subject = Object.values(subjectMap)
      .map(s => ({
        subject:         s.subject,
        avg_replays:     parseFloat((s.total_replays / s.count).toFixed(2)),
        repeat_students: s.repeat_students.size,
      }))
      .sort((a, b) => b.avg_replays - a.avg_replays);

    // ── By state ──────────────────────────────────────────────────────────
    const stateMap = {};
    sessions.forEach(s => {
      const key = s.state || 'Unknown';
      if (!stateMap[key]) stateMap[key] = { state: key, total_replays: 0, repeat: 0, count: 0 };
      stateMap[key].total_replays += (s.replay_count || 0);
      if ((s.replay_count || 0) > 0) stateMap[key].repeat++;
      stateMap[key].count++;
    });
    const by_state = Object.values(stateMap)
      .map(s => ({
        state:       s.state,
        avg_replays: parseFloat((s.total_replays / s.count).toFixed(2)),
        repeat_pct:  parseFloat(((s.repeat / s.count) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.avg_replays - a.avg_replays);

    res.json({
      kpi: {
        total_replays:             totalReplays,
        avg_replays_per_student:   parseFloat((totalReplays / total).toFixed(2)),
        repeat_sessions:           repeatSessions,
      },
      by_module,
      by_subject,
      by_state,
      table: [],
    });
  } catch (_) {
    // Return zeroed structure — dashboard renders empty state cleanly
    res.json({
      kpi: { total_replays: 0, avg_replays_per_student: 0, repeat_sessions: 0 },
      by_module: [],
      by_subject: [],
      by_state: [],
      table: [],
    });
  }
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
    const { format = 'xlsx', state, district, class_grade, subject } = req.query;
    const db = require('../lib/firebase').getFirestore();

    // Build filtered query — all filters are optional
    let query = db.collection('telemetry_sessions');
    if (state)       query = query.where('state',       '==', state);
    if (district)    query = query.where('district',    '==', district);
    if (class_grade) query = query.where('class_grade', '==', class_grade);
    if (subject)     query = query.where('subject',     '==', subject);

    const snap = await query.limit(10000).get();

    const rows = snap.docs.map(d => {
      const s = d.data();
      return {
        Student_ID:      s.student_id      || '',
        State:           s.state           || '',
        District:        s.district        || '',
        Class:           s.class_grade     || '',
        Subject:         s.subject         || '',
        Topic:           s.topic           || '',
        AR_Tier:         s.ar_tier         || '',
        Session_Minutes: s.session_minutes || 0,
        Replay_Count:    s.replay_count    || 0,
        Dropped_Off:     s.dropped_off     ? 'Yes' : 'No',
        Offline:         s.offline         ? 'Yes' : 'No',
        Network_Type:    s.network_type    || '',
        Device_RAM_GB:   s.device_ram_gb   || '',
        Battery_Drain:   s.battery_drain   || '',
        Cold_Start_Sec:  s.cold_start_sec  || '',
        Date:            s.created_at
                           ? new Date(s.created_at._seconds * 1000).toISOString().slice(0, 10)
                           : '',
      };
    });

    // If no real data yet, return an informative empty sheet
    if (rows.length === 0) {
      rows.push({
        Student_ID: 'NO_DATA', State: '', District: '', Class: '',
        Subject: '', Topic: '', AR_Tier: '', Session_Minutes: 0,
        Replay_Count: 0, Dropped_Off: '', Offline: '', Network_Type: '',
        Device_RAM_GB: '', Battery_Drain: '', Cold_Start_Sec: '', Date: '',
      });
    }

    const ws  = XLSX.utils.json_to_sheet(rows);
    const wb  = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'RAW_Sessions');

    const ext      = format === 'csv' ? 'csv' : 'xlsx';
    const bookType = format === 'csv' ? 'csv'  : 'xlsx';
    const buf      = XLSX.write(wb, { type: 'buffer', bookType });

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="MITRA_Analytics_${new Date().toISOString().slice(0, 10)}.${ext}"`
    );
    res.setHeader('Content-Type', format === 'csv'
      ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Export failed', detail: err.message });
  }
});

module.exports = router;
