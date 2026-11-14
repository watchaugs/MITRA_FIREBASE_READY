/**
 * routes/analytics.js — Student App Telemetry & Replay Analytics
 *
 * SNAPSHOT MODEL (cost-safe):
 *   • GET endpoints read a pre-computed snapshot from Firestore
 *     (analytics_cache/latest) — NO BigQuery on page load, ever.
 *   • POST /refresh runs all the BigQuery aggregates ONCE and saves the
 *     snapshot. You trigger it manually (once or twice a month), so BigQuery
 *     is touched only then. Everything else is free-tier Firestore reads.
 *   • /export streams raw rows from BigQuery on demand (a manual admin action).
 */
'use strict';

const router = require('express').Router();
const XLSX   = require('xlsx');
const { authenticate, requirePerm } = require('../middleware/auth');
const { runQuery, FQ_TABLE } = require('../lib/bq');
const { runExport } = require('../lib/telemetry_exporter');

router.use(authenticate);

// ── State-scoping for data exports (Wave 2 H8) ────────────────────────────────
// A state-scoped actor (one with a non-empty assigned_state) may export ONLY
// their own state's data. master_admin and officers with no assigned_state
// (national scope) may export anyone. Returns the state the caller is confined
// to, or '' for national/unrestricted.
function actorStateScope(req) {
  if (req.user?.role === 'master_admin') return '';          // national
  const s = (req.user?.assigned_state || '').trim();
  return s;                                                  // '' => national
}

// ── Zeroed defaults (shown until the first Refresh populates the snapshot) ────
const EMPTY = {
  overview:  { active_users: 0, avg_session_mins: 0, dropoff_pct: 0, offline_pct: 0, avg_replays: 0 },
  replay:    { kpi: { total_replays: 0, avg_replays_per_student: 0, repeat_sessions: 0 },
               by_module: [], by_subject: [], by_state: [], table: [] },
  location:  [],
  classroom: [],
  predictive: [],
  telemetry_summary: { success: true, data: [] },
  refreshed_at: null,
};

async function readSnapshot() {
  try {
    const db  = require('../lib/firebase').getFirestore();
    const doc = await db.collection('analytics_cache').doc('latest').get();
    return doc.exists ? doc.data() : null;
  } catch (_) {
    return null;
  }
}

// ── Legacy ingest (kept as a pure ack; the app writes telemetry directly to
//    Firestore now, so this never writes anything). ───────────────────────────
router.post('/telemetry', async (req, res) => {
  res.status(202).json({ received: true, note: 'telemetry is collected via the app SDK' });
});

// ══════════════════════════════════════════════════════════════════════════
// REFRESH — the ONLY place BigQuery is queried. Run once or twice a month.
// ══════════════════════════════════════════════════════════════════════════
router.post('/refresh', requirePerm('perm_view_analytics'), async (req, res) => {
  try {
    const AR_END      = `event_collection = 'ar_views' AND event_type = 'ar_end'`;
    const SESSION_END = `event_collection = 'sessions' AND event_type = 'session_end'`;

    // Run all aggregates. Each returns a tiny result set.
    const [overviewRows, replayKpiRows, byModule, bySubject, byState,
           location, classroom, predictive, summary] = await Promise.all([
      // Overview KPIs
      runQuery(`
        SELECT
          COUNT(DISTINCT student_id) AS active_users,
          ROUND(AVG(IF(${SESSION_END}, duration_seconds, NULL)) / 60, 1) AS avg_session_mins,
          ROUND(100 * SAFE_DIVIDE(COUNTIF(${AR_END} AND completed = false),
                                  COUNTIF(${AR_END})), 1) AS dropoff_pct,
          ROUND(100 * SAFE_DIVIDE(COUNTIF(offline_session = true), COUNT(*)), 1) AS offline_pct,
          ROUND(SAFE_DIVIDE(COUNTIF(${AR_END} AND is_replay = true),
                            COUNT(DISTINCT student_id)), 2) AS avg_replays
        FROM ${FQ_TABLE}`),

      // Replay KPI base
      runQuery(`
        SELECT
          COUNTIF(${AR_END} AND is_replay = true) AS total_replays,
          COUNT(DISTINCT student_id) AS students
        FROM ${FQ_TABLE}`),

      // Replay by module
      runQuery(`
        SELECT
          COALESCE(module_title, topic_id, 'Unknown') AS topic,
          COUNT(*) AS total_events,
          ROUND(SAFE_DIVIDE(COUNTIF(is_replay = true), COUNT(*)), 2) AS avg_replays
        FROM ${FQ_TABLE}
        WHERE ${AR_END}
        GROUP BY topic ORDER BY avg_replays DESC LIMIT 10`),

      // Replay by subject
      runQuery(`
        SELECT
          COALESCE(subject, 'Unknown') AS subject,
          ROUND(SAFE_DIVIDE(COUNTIF(is_replay = true), COUNT(*)), 2) AS avg_replays,
          COUNT(DISTINCT IF(is_replay = true, student_id, NULL)) AS repeat_students
        FROM ${FQ_TABLE}
        WHERE ${AR_END}
        GROUP BY subject ORDER BY avg_replays DESC`),

      // Replay by state
      runQuery(`
        SELECT
          COALESCE(state, 'Unknown') AS state,
          ROUND(SAFE_DIVIDE(COUNTIF(is_replay = true), COUNT(*)), 2) AS avg_replays,
          ROUND(100 * SAFE_DIVIDE(COUNTIF(is_replay = true), COUNT(*)), 1) AS repeat_pct
        FROM ${FQ_TABLE}
        WHERE ${AR_END}
        GROUP BY state ORDER BY avg_replays DESC`),

      // Location breakdown
      runQuery(`
        SELECT
          state, district,
          COUNT(DISTINCT student_id) AS active_users,
          ROUND(AVG(IF(${SESSION_END}, duration_seconds, NULL)) / 60, 1) AS avg_session
        FROM ${FQ_TABLE}
        WHERE state IS NOT NULL
        GROUP BY state, district ORDER BY active_users DESC LIMIT 500`),

      // Classroom analytics
      runQuery(`
        SELECT
          class_grade, subject,
          COUNT(DISTINCT student_id) AS total_students,
          ROUND(AVG(IF(${SESSION_END}, duration_seconds, NULL)) / 60, 1) AS avg_session
        FROM ${FQ_TABLE}
        GROUP BY class_grade, subject ORDER BY total_students DESC LIMIT 500`),

      // Predictive drop-offs (AR modules ended without completion)
      runQuery(`
        SELECT
          COALESCE(module_title, topic_id, 'Unknown') AS topic,
          COUNTIF(completed = false) AS drop_offs,
          ROUND(AVG(IF(completed = false, duration_seconds, NULL)) / 60, 1) AS time_spent
        FROM ${FQ_TABLE}
        WHERE ${AR_END}
        GROUP BY topic HAVING drop_offs > 0 ORDER BY drop_offs DESC LIMIT 10`),

      // Telemetry summary by state
      runQuery(`
        SELECT
          state AS region, state,
          COUNT(DISTINCT student_id) AS users,
          CAST(ROUND(AVG(IF(${SESSION_END}, duration_seconds, NULL))) AS INT64) AS avg_module_seconds,
          ROUND(100 * SAFE_DIVIDE(COUNTIF(${AR_END} AND completed = false),
                                  COUNTIF(${AR_END})), 1) AS \`drop\`,
          ROUND(100 * SAFE_DIVIDE(COUNTIF(offline_session = true), COUNT(*)), 1) AS offline
        FROM ${FQ_TABLE}
        WHERE state IS NOT NULL
        GROUP BY state ORDER BY users DESC`),
    ]);

    const ov  = overviewRows[0]  || {};
    const rk  = replayKpiRows[0] || {};
    const totalReplays = rk.total_replays || 0;
    const students     = rk.students || 0;

    const snapshot = {
      overview: {
        active_users:     ov.active_users     || 0,
        avg_session_mins: ov.avg_session_mins || 0,
        dropoff_pct:      ov.dropoff_pct      || 0,
        offline_pct:      ov.offline_pct      || 0,
        avg_replays:      ov.avg_replays      || 0,
      },
      replay: {
        kpi: {
          total_replays:           totalReplays,
          avg_replays_per_student: students > 0 ? Math.round((totalReplays / students) * 100) / 100 : 0,
          repeat_sessions:         totalReplays,
        },
        by_module:  byModule,
        by_subject: bySubject,
        by_state:   byState,
        table:      [],
      },
      location,
      classroom,
      predictive,
      telemetry_summary: { success: true, data: summary },
      refreshed_at: new Date().toISOString(),
    };

    // Strip any BigQuery wrapper objects / undefined before storing.
    const clean = JSON.parse(JSON.stringify(snapshot));

    const db = require('../lib/firebase').getFirestore();
    await db.collection('analytics_cache').doc('latest').set(clean);

    // Also precompute the per-scope summary-report docs (for the 📑 button).
    let reportScopes = 0;
    try { reportScopes = await buildReportScopes(db); } catch (_) { /* best-effort */ }

    res.json({ ok: true, refreshed_at: clean.refreshed_at, report_scopes: reportScopes });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ── Report helpers (themed summary workbook, one doc per scope) ──────────────
// Seed aspirational-districts list (NITI Aayog) — editable later via config.
const ASPIRATIONAL_DISTRICTS = [
  'udaipur','gaya','chandauli','sonbhadra','siddharthnagar','chitrakoot','fatehpur',
  'bahraich','balrampur','shrawasti','barabanki','khagaria','araria','sheikhpura',
  'jamui','banka','katihar','purnia','nawada','muzaffarpur','dhubri','goalpara',
  'barpeta','darrang','hailakandi','dahod','narmada','ranchi','khunti','gumla',
  'dumka','godda','pakur','sahibganj','latehar','palamu','bokaro','hazaribagh',
  'ramgarh','west singhbhum','simdega','giridih','lohardaga','dindori','barwani',
  'vidisha','rajgarh','guna','chhatarpur','damoh','singrauli','gadchiroli',
  'nandurbar','osmanabad','washim','malkangiri','nabarangpur','koraput','rayagada',
  'kalahandi','kandhamal','gajapati','nuapada','bolangir','dhenkanal',
];
function slugScope(s) { return String(s || 'All India').replace(/[^A-Za-z0-9]+/g, '_'); }
function monthNameFrom(iso) {
  try { return new Date(iso).toLocaleString('en-US', { month: 'long', year: 'numeric' }); }
  catch (_) { return ''; }
}
async function buildReportScopes(db) {
  const rb = require('../lib/report_builder');
  const joins = { status: {}, bloom: {}, board: {}, qcount: {}, curriculum: [], aspirational: ASPIRATIONAL_DISTRICTS };
  try {
    const s = await db.collection('ar_assets').limit(3000).get();
    s.forEach(d => { const a = d.data(); const k = a.title || a.name || a.module_title; if (k) joins.status[k] = a.status || 'published'; });
  } catch (_) {}
  try {
    const s = await db.collection('quizzes').limit(3000).get();
    s.forEach(d => { const q = d.data(); const k = q.title || q.name; if (k) { joins.bloom[k] = q.blooms_level || q.bloom || ''; joins.board[k] = q.board || ''; joins.qcount[k] = q.question_count || q.questions || ''; } });
  } catch (_) {}
  try {
    const s = await db.collection('curriculum').limit(3000).get();
    s.forEach(d => { const c = d.data(); joins.curriculum.push([c.class_grade || c.class || '', c.subject || '', c.topic || c.title || '', c.board || '', c.language || '']); });
  } catch (_) {}
// Firestore-sourced joins the BigQuery warehouse doesn't carry:
  // notification send-ledger, per-impression ad gender, and app feedback/NPS.
  const notifLedger = {}, adsByGender = {}, feedbackData = {};
  const _bump = (o, sc, f, v) => { (o[sc] ||= {}); o[sc][f] = (o[sc][f] || 0) + v; };
  const _scopesOf = (state) => ['All India', state && String(state)].filter(Boolean);
  try { // notification send ledger
    const snap = await db.collection('notifications').limit(2000).get();
    snap.forEach(d => { const nnn = d.data(); const acc = nnn.fcm_message_id ? 1 : 0;
      _scopesOf(nnn.target_state).forEach(sc => { _bump(notifLedger, sc, 'sent', 1); _bump(notifLedger, sc, 'delivered', acc); }); });
  } catch (_) {}
  try { // ad impressions by gender
    const snap = await db.collection('ad_impressions').limit(20000).get();
    snap.forEach(d => { const a = d.data(); const g = String(a.gender || '').toLowerCase();
      _scopesOf(a.state).forEach(sc => { (adsByGender[sc] ||= { all:{imp:0,clk:0,reach:0}, male:{imp:0,clk:0}, fem:{imp:0,clk:0}, byFmt:{} });
        const B = adsByGender[sc]; B.all.imp++; if (a.clicked) B.all.clk++;
        if (g === 'male') { B.male.imp++; if (a.clicked) B.male.clk++; }
        else if (g === 'female') { B.fem.imp++; if (a.clicked) B.fem.clk++; } }); });
  } catch (_) {}
  try { // app feedback + NPS (overall, by gender, by mobile-owner)
    const snap = await db.collection('app_feedback').limit(10000).get();
    const acc = {};
    snap.forEach(d => { const e = d.data();
      _scopesOf(e.state).forEach(sc => {
        const A = (acc[sc] ||= { ratings:[], nps:[], msgs:[], g:{}, o:{} });
        if (typeof e.rating === 'number') { A.ratings.push(e.rating); A.msgs.push(String(e.message||'').toLowerCase()); }
        if (typeof e.nps_score === 'number') {
          A.nps.push(e.nps_score);
          const gk = ({male:'MALE',female:'FEM'})[String(e.gender||'').toLowerCase()];
          if (gk) { (A.g[gk] ||= []).push(e.nps_score); }
          const ok = ({Father:'FAT',Mother:'MTH',Self:'SEL'})[String(e.mobile_ownership||'')];
          if (ok) { (A.o[ok] ||= []).push(e); }
        }
      });
    });
    const npsAgg = (arr) => { let p=0,dt=0; arr.forEach(x=>{ if(x>=9)p++; else if(x<=6)dt++; }); return { nps: arr.length?Math.round(((p-dt)/arr.length)*100):0, promo:p, resp:arr.length }; };
    Object.entries(acc).forEach(([sc, A]) => {
      const avg = (xs) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
      const tag = (kw) => A.msgs.filter(m=>m.includes(kw)).length;
      const base = npsAgg(A.nps);
      const byGender = {}; Object.entries(A.g).forEach(([k,xs])=>{ const r=npsAgg(xs); byGender[k]={...r, rating:null}; });
      const byOwner = {}; Object.entries(A.o).forEach(([k,es])=>{ const r=npsAgg(es.map(e=>e.nps_score)); const rr=es.map(e=>e.rating).filter(x=>typeof x==='number'); byOwner[k]={...r, rating: rr.length?avg(rr):null}; });
      feedbackData[sc] = {
        avgRating: avg(A.ratings), total: A.ratings.length,
        loved: A.ratings.filter(x=>x>=4).length, boring: tag('bor'), confusing: tag('confus'), tooEasy: tag('easy'), tooFast: tag('fast'),
        nps: base.nps, npsPromo: base.promo, npsDetract: A.nps.filter(x=>x<=6).length, npsN: A.nps.length,
        byGender, byOwner,
      };
    });
  } catch (_) {}
  joins.notifLedger = notifLedger; joins.adsByGender = adsByGender; joins.feedbackData = feedbackData;

  rb.setJoins(joins);
  const { generated, scopes } = await rb.buildAllScopes();
  const entries = Object.entries(scopes);
  for (let i = 0; i < entries.length; i += 300) {
    const batch = db.batch();
    for (const [name, data] of entries.slice(i, i + 300)) {
      const sc = slugScope(name);
      batch.set(db.collection('analytics_cache').doc('scope__' + sc), { scope: name, generated, data });
      // PPT token cache (flat 402-token map) — read by /monthly.pptx, no compute at download.
      if (data.ppt_tokens) batch.set(db.collection('report_cache').doc('ppt__' + sc), { scope: name, generated, tokens: data.ppt_tokens });
    }
    await batch.commit();
  }
  await db.collection('analytics_cache').doc('report_index').set({ scopes: entries.map(e => e[0]), generated });
  return entries.length;
}

// ── Sync telemetry: Firestore → BigQuery (manual, admin-triggered) ───────────
// Runs the exporter on demand. No Cloud Scheduler — you trigger this from the
// dashboard button once or twice a month. Protected by the analytics permission
// (so no shared secret has to live in the browser).
router.post('/sync-telemetry', requirePerm('perm_view_analytics'), async (req, res) => {
  try {
    const result = await runExport({ limitPerCollection: 500 });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ── Whole snapshot in one call (1 Firestore read) — used by all Analytics charts
// Live snapshot: aggregates the app's batched telemetry straight from Firestore
// (collectionGroup over telemetry_sync/*/{collection}/*, each doc holding a
// batched_events[] array). No BigQuery, no manual Sync/Refresh — charts show
// data as soon as the app has flushed any. Bounded reads keep it cheap.
router.get('/snapshot', requirePerm('perm_view_analytics'), async (req, res) => {
  try {
    const db = require('../lib/firebase').getFirestore();

    // Pull the newest batches for the collections the charts need.
    const pull = async (collection, cap = 1500) => {
      try {
        const snap = await db.collectionGroup(collection)
          .orderBy('batch_flushed_at', 'desc').limit(cap).get();
        const events = [];
        snap.docs.forEach(d => {
          const arr = d.data().batched_events;
          if (Array.isArray(arr)) events.push(...arr);
        });
        return events;
      } catch (_) { return []; } // missing index / no data → empty, never 500
    };

    const [sessions, arViews, quiz] = await Promise.all([
      pull('sessions'), pull('ar_views'), pull('quiz_attempts'),
    ]);

    const num = v => Number(v) || 0;
    const uniq = arr => new Set(arr.filter(Boolean)).size;

    // ── Overview KPIs ──
    const sessionEnds = sessions.filter(e => e.event_type === 'session_end');
    const avgSessionMins = sessionEnds.length
      ? Math.round(sessionEnds.reduce((s, e) => s + num(e.duration_seconds), 0) / sessionEnds.length / 60)
      : 0;
    const arEnds = arViews.filter(e => e.event_type === 'ar_end');
    const dropoffs = arEnds.filter(e => e.completed !== true).length;
    const dropoffPct = arEnds.length ? Math.round((dropoffs / arEnds.length) * 100) : 0;
    const offlineSessions = sessionEnds.filter(e => e.was_offline === true).length;
    const offlinePct = sessionEnds.length ? Math.round((offlineSessions / sessionEnds.length) * 100) : 0;
    const replays = arEnds.filter(e => e.is_replay === true).length;
    const avgReplays = arEnds.length ? +(replays / arEnds.length).toFixed(2) : 0;
    const activeUsers = uniq([...sessions, ...arViews].map(e => e.student_id));

    const overview = {
      active_users: activeUsers,
      avg_session_mins: avgSessionMins,
      dropoff_pct: dropoffPct,
      offline_pct: offlinePct,
      avg_replays: avgReplays,
    };

    // ── Group helpers ──
    const groupCount = (arr, key) => {
      const m = {};
      arr.forEach(e => { const k = e[key]; if (k) m[k] = (m[k] || 0) + 1; });
      return Object.entries(m).map(([k, v]) => ({ [key]: k, count: v }))
        .sort((a, b) => b.count - a.count);
    };

    // ── Predictive (drop-offs per topic) ──
    const dropByTopic = {};
    arEnds.forEach(e => {
      const t = e.module_title || e.topic_id || e.ar_id;
      if (!t) return;
      dropByTopic[t] = dropByTopic[t] || { topic: t, drop_offs: 0 };
      if (e.completed !== true) dropByTopic[t].drop_offs++;
    });
    const predictive = Object.values(dropByTopic).sort((a, b) => b.drop_offs - a.drop_offs);

    // ── Replay by module ──
    const replayByModule = {};
    arEnds.forEach(e => {
      const t = e.module_title || e.topic_id || e.ar_id;
      if (!t) return;
      replayByModule[t] = replayByModule[t] || { topic: t, plays: 0, replays: 0 };
      replayByModule[t].plays++;
      if (e.is_replay === true) replayByModule[t].replays++;
    });
    const by_module = Object.values(replayByModule).map(r => ({
      topic: r.topic, avg_replays: r.plays ? r.replays / r.plays : 0,
    })).sort((a, b) => b.avg_replays - a.avg_replays);

    // ── Classroom (active students by class/subject) ──
    const classroomMap = {};
    [...sessions, ...arViews].forEach(e => {
      const cls = e['class'] || '—', subj = e.subject || '—';
      const key = cls + '||' + subj;
      classroomMap[key] = classroomMap[key] || { class_grade: cls, subject: subj, students: new Set() };
      if (e.student_id) classroomMap[key].students.add(e.student_id);
    });
    const classroom = Object.values(classroomMap).map(r => ({
      class_grade: r.class_grade, subject: r.subject, total_students: r.students.size,
    }));

    // ── Location (active students by state) ──
    const stateMap = {};
    [...sessions, ...arViews].forEach(e => {
      const st = e.state; if (!st) return;
      stateMap[st] = stateMap[st] || new Set();
      if (e.student_id) stateMap[st].add(e.student_id);
    });
    const location = Object.entries(stateMap)
      .map(([state, set]) => ({ state, total_students: set.size }))
      .sort((a, b) => b.total_students - a.total_students);

    const replayKpi = {
      total_replays: replays,
      avg_replays_per_student: activeUsers ? +(replays / activeUsers).toFixed(2) : 0,
      repeat_sessions: sessions.filter(e => e.event_type === 'session_start').length,
    };

    res.json({
      overview,
      replay: { kpi: replayKpi, by_module, by_subject: [], by_state: location, table: [] },
      location,
      classroom,
      predictive,
      telemetry_summary: { success: true, data: groupCount(arViews, 'event_type') },
      refreshed_at: new Date().toISOString(), // always "live now"
      live: true,
    });
  } catch (err) {
    res.json({ ...EMPTY, empty: true, error: String(err.message || err) });
  }
});

// ── Overview KPIs (from snapshot) ─────────────────────────────────────────────
router.get('/overview', requirePerm('perm_view_analytics'), async (req, res) => {
  const snap = await readSnapshot();
  res.json((snap && snap.overview) || EMPTY.overview);
});

// ── Replay & Repeat Analytics (from snapshot) ─────────────────────────────────
router.get('/replay', requirePerm('perm_view_analytics'), async (req, res) => {
  const snap = await readSnapshot();
  res.json((snap && snap.replay) || EMPTY.replay);
});

// ── Location breakdown (from snapshot) ────────────────────────────────────────
router.get('/location', requirePerm('perm_view_analytics'), async (req, res) => {
  const snap = await readSnapshot();
  res.json((snap && snap.location) || EMPTY.location);
});

// ── Classroom analytics (from snapshot) ───────────────────────────────────────
router.get('/classroom', requirePerm('perm_view_analytics'), async (req, res) => {
  const snap = await readSnapshot();
  res.json((snap && snap.classroom) || EMPTY.classroom);
});

// ── Predictive analytics (from snapshot) ──────────────────────────────────────
router.get('/predictive', requirePerm('perm_view_analytics'), async (req, res) => {
  const snap = await readSnapshot();
  res.json((snap && snap.predictive) || EMPTY.predictive);
});

// ── Telemetry summary (from snapshot) ─────────────────────────────────────────
router.get('/telemetry/summary', requirePerm('perm_view_analytics'), async (req, res) => {
  const snap = await readSnapshot();
  res.json((snap && snap.telemetry_summary) || EMPTY.telemetry_summary);
});

// ── Refresh status (for the "last refreshed" label) ───────────────────────────
router.get('/refresh-status', requirePerm('perm_view_analytics'), async (req, res) => {
  const snap = await readSnapshot();
  res.json({ refreshed_at: (snap && snap.refreshed_at) || null });
});

// ── Data freshness per telemetry tier ─────────────────────────────────────────
// The app now syncs on TWO cadences (see telemetry_batch_buffer.dart):
//   • CRITICAL (compliance_events, profile_events, sessions) → ~12h, so these
//     are near-current.
//   • BULK (ar_views, screen_views, notification_events, quiz_attempts) → every
//     10 days + a compulsory month-end sync. These can legitimately be up to
//     10 days behind — this endpoint lets the UI SAY SO instead of looking dead.
// Cost: one tiny ordered collectionGroup read per collection (newest batch
// only). No BigQuery, no snapshot refresh needed.
const _CRITICAL_COLLECTIONS = ['compliance_events', 'profile_events', 'sessions'];
const _BULK_COLLECTIONS = ['ar_views', 'screen_views', 'notification_events', 'quiz_attempts'];

async function latestFlushFor(db, collection) {
  try {
    // batch_flushed_at is an ISO string written by the app on every flush.
    const snap = await db.collectionGroup(collection)
      .orderBy('batch_flushed_at', 'desc')
      .limit(1)
      .get();
    if (snap.empty) return null;
    return snap.docs[0].data().batch_flushed_at || null;
  } catch (_) {
    // Missing index or no data yet → unknown, never a 500.
    return null;
  }
}

router.get('/data-freshness', requirePerm('perm_view_analytics'), async (req, res) => {
  try {
    const db = require('../lib/firebase').getFirestore();
    const all = [..._CRITICAL_COLLECTIONS, ..._BULK_COLLECTIONS];
    const results = await Promise.all(all.map((c) => latestFlushFor(db, c)));

    const byCollection = {};
    all.forEach((c, i) => { byCollection[c] = results[i]; });

    // Newest timestamp within each tier (the tier is "as fresh as" its freshest
    // collection; the UI shows the staleness of the tier as a whole).
    const maxOf = (cols) => {
      const times = cols.map((c) => byCollection[c]).filter(Boolean)
        .map((s) => Date.parse(s)).filter((n) => !Number.isNaN(n));
      return times.length ? new Date(Math.max(...times)).toISOString() : null;
    };

    res.json({
      ok: true,
      tiers: {
        critical: {
          label: 'Compliance & sessions',
          expected_max_lag_hours: 12,
          last_synced: maxOf(_CRITICAL_COLLECTIONS),
          collections: _CRITICAL_COLLECTIONS.reduce((o, c) => (o[c] = byCollection[c], o), {}),
        },
        engagement: {
          label: 'Engagement (AR, screens, quizzes)',
          expected_max_lag_days: 10,
          last_synced: maxOf(_BULK_COLLECTIONS),
          collections: _BULK_COLLECTIONS.reduce((o, c) => (o[c] = byCollection[c], o), {}),
        },
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ── Layer 3: FULL raw dataset export (BigQuery → GCS, free extract) ──────────
// EXTRACT jobs are NOT query-billed (free). Writes the whole telemetry table to
// gzipped CSV (auto-sharded at crore-scale), then hands back 24h signed links
// so the browser downloads straight from GCS (not through Cloud Run).
router.post('/raw-export', requirePerm('perm_export_data'), async (req, res) => {
  try {
    // H8: the full-table extract cannot be state-filtered (BigQuery extract jobs
    // dump the whole table). A state-scoped actor must NOT pull every state's raw
    // student telemetry, so they are blocked here and directed to /export, which
    // filters by state. Only national scope (master_admin / no assigned_state)
    // may run the raw full-table extract.
    if (actorStateScope(req) !== '') {
      return res.status(403).json({
        ok: false,
        error: 'Full raw export is national-scope only. Use the filtered export for your state.',
      });
    }
    const { BigQuery } = require('@google-cloud/bigquery');
    const { Storage }  = require('@google-cloud/storage');
    const PROJECT = process.env.GCP_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || 'watchaugs-mitra';
    const DATASET = 'mitra_telemetry_production';
    const TABLE   = 'telemetry_synced';
    const BUCKET  = process.env.TELEMETRY_BUCKET || 'mitra-telemetry-raw';

    const format = (req.body && req.body.format) === 'parquet' ? 'parquet' : 'csv';
    const ts     = new Date().toISOString().replace(/[:.]/g, '-');
    const ext    = format === 'parquet' ? 'parquet' : 'csv.gz';
    const prefix = `exports/${ts}`;
    const destUri = `gs://${BUCKET}/${prefix}/data_*.${ext}`;

    const bq = new BigQuery({ projectId: PROJECT });
    const extractCfg = format === 'parquet'
      ? { format: 'PARQUET' }
      : { format: 'CSV', gzip: true };

    // Free extract job (no query bytes billed).
    await bq.dataset(DATASET).table(TABLE).extract(destUri, extractCfg);

    // List produced files and sign 24h read URLs.
    const storage = new Storage({ projectId: PROJECT });
    const [objs] = await storage.bucket(BUCKET).getFiles({ prefix: `${prefix}/` });
    const expires = Date.now() + 24 * 60 * 60 * 1000;
    const files = [];
    for (const o of objs) {
      let url = null;
      try {
        [url] = await o.getSignedUrl({ version: 'v4', action: 'read', expires });
      } catch (_) { /* signing needs an IAM role; fall back to gs path */ }
      const sizeKb = o.metadata && o.metadata.size ? Math.round(Number(o.metadata.size) / 1024) : 0;
      files.push({ name: o.name, size: sizeKb ? `${sizeKb} KB` : '', url, gs: `gs://${BUCKET}/${o.name}` });
    }
    res.json({ ok: true, format, files });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ── Analytical report — themed 16-sheet summary workbook for a chosen scope ───
// Reads the precomputed per-scope doc (analytics_cache/scope__<slug>) and renders
// it via lib/summary_report.js. Zero BigQuery at download. Run Refresh first.
router.get('/report', requirePerm('perm_export_data'), async (req, res) => {
  try {
    let scope = (req.query.scope && String(req.query.scope).trim()) || 'All India';
    // H8: a state-scoped actor can only ever pull their own state's report,
    // regardless of the scope they requested.
    const stateScope = actorStateScope(req);
    if (stateScope !== '') {
      if (scope.toLowerCase() !== stateScope.toLowerCase() && scope !== 'All India') {
        return res.status(403).json({ error: 'You may only export reports for your own state.' });
      }
      scope = stateScope; // force it — ignores 'All India' too
    }
    const db = require('../lib/firebase').getFirestore();
    const doc = await db.collection('analytics_cache').doc('scope__' + slugScope(scope)).get();
    const payload = doc.exists ? doc.data() : null;
    const { buildSummaryWorkbook } = require('../lib/summary_report');
    const genIso = (payload && payload.generated) || new Date().toISOString();
    const buf = await buildSummaryWorkbook({
      scope,
      month: monthNameFrom(genIso),
      generated: genIso.slice(0, 19).replace('T', ' ') + ' UTC',
      data: (payload && payload.data) || {},
    });
    res.setHeader('Content-Disposition',
      `attachment; filename="MITRA_Summary_${slugScope(scope)}_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Report failed', detail: err.message });
  }
});

// ── Export — raw rows straight from BigQuery (manual admin action) ────────────
router.get('/export', requirePerm('perm_export_data'), async (req, res) => {
  try {
    let { format = 'xlsx', state = '', district = '', class_grade = '', subject = '', month = '' } = req.query;

    // H8: confine a state-scoped actor to their own state. If they asked for a
    // different state, reject; otherwise force the filter to their state so an
    // empty/other state value can't widen the export.
    const stateScope = actorStateScope(req);
    if (stateScope !== '') {
      if (state && state.toLowerCase() !== stateScope.toLowerCase()) {
        return res.status(403).json({ error: 'You may only export data for your own state.' });
      }
      state = stateScope;
    }

    const rows = await runQuery(`
      SELECT
        student_id, state, district, class_grade, subject,
        COALESCE(module_title, topic_id) AS topic,
        ar_tier, session_minutes, duration_seconds,
        is_replay, completed, offline_session, connectivity_type,
        cold_start_ms, CAST(timestamp AS STRING) AS event_time
      FROM ${FQ_TABLE}
      WHERE (@state = ''       OR state = @state)
        AND (@district = ''    OR district = @district)
        AND (@class_grade = '' OR class_grade = @class_grade)
        AND (@subject = ''     OR subject = @subject)
        AND (@month = ''       OR STARTS_WITH(CAST(timestamp AS STRING), @month))
      LIMIT 50000
    `, { state, district, class_grade, subject, month },
       { cacheKey: `export:${state}:${district}:${class_grade}:${subject}:${month}` });

    const out = rows.map(s => ({
      Student_ID:      s.student_id      || '',
      State:           s.state           || '',
      District:        s.district        || '',
      Class:           s.class_grade     || '',
      Subject:         s.subject         || '',
      Topic:           s.topic           || '',
      AR_Tier:         s.ar_tier         || '',
      Session_Minutes: s.session_minutes || 0,
      Duration_Secs:   s.duration_seconds || 0,
      Is_Replay:       s.is_replay       ? 'Yes' : 'No',
      Completed:       s.completed       ? 'Yes' : 'No',
      Offline:         s.offline_session ? 'Yes' : 'No',
      Connectivity:    s.connectivity_type || '',
      Cold_Start_Ms:   s.cold_start_ms   || '',
      Event_Time:      (s.event_time || '').slice(0, 19),
    }));

    if (out.length === 0) {
      out.push({
        Student_ID: 'NO_DATA', State: '', District: '', Class: '', Subject: '',
        Topic: '', AR_Tier: '', Session_Minutes: 0, Duration_Secs: 0, Is_Replay: '',
        Completed: '', Offline: '', Connectivity: '', Cold_Start_Ms: '', Event_Time: '',
      });
    }

    const ws = XLSX.utils.json_to_sheet(out);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'RAW_Sessions');

    const ext      = format === 'csv' ? 'csv' : 'xlsx';
    const bookType = format === 'csv' ? 'csv' : 'xlsx';
    const buf      = XLSX.write(wb, { type: 'buffer', bookType });

    res.setHeader('Content-Disposition',
      `attachment; filename="MITRA_Analytics_${new Date().toISOString().slice(0, 10)}.${ext}"`);
    res.setHeader('Content-Type', format === 'csv'
      ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Export failed', detail: err.message });
  }
});

// ── Learning funnel + content-health (live, bounded reads) ───────────────────
router.get('/funnel', requirePerm('perm_view_analytics'), async (req, res) => {
  try {
    const db = require('../lib/firebase').getFirestore();

    // The app batches telemetry into telemetry_sync/*/{collection}/*, each doc
    // holding a batched_events[] array — so read via collectionGroup and unwrap,
    // the same way the live /snapshot does. (A plain collection('ar_views') read
    // finds nothing, since the events aren't top-level documents.)
    const pull = async (collection, cap = 1500) => {
      try {
        const snap = await db.collectionGroup(collection)
          .orderBy('batch_flushed_at', 'desc').limit(cap).get();
        const events = [];
        snap.docs.forEach(d => {
          const arr = d.data().batched_events;
          if (Array.isArray(arr)) events.push(...arr);
        });
        return events;
      } catch (_) { return []; }
    };

    const [arEvents, quizEvents] = await Promise.all([
      pull('ar_views'), pull('quiz_attempts'),
    ]);

    const mod = {};
    const ensure = (id) => (mod[id] ||= { ar_id: id, title: '', started: new Set(), watched: new Set(), durations: [] });
    arEvents.forEach(e => {
      const id = e.ar_id || e.topic_id; if (!id) return;
      const sid = e.student_id || 'anon';
      const m = ensure(id);
      if (e.module_title && !m.title) m.title = e.module_title;
      if (e.event_type === 'ar_start') m.started.add(sid);
      if (e.event_type === 'ar_end') {
        m.started.add(sid);
        if (e.completed === true) m.watched.add(sid);
        if (typeof e.duration_seconds === 'number') m.durations.push(e.duration_seconds);
      }
    });

    const quiz = {};
    const qEnsure = (id) => (quiz[id] ||= { attempted: new Set(), mastered: new Set(), scores: [] });
    quizEvents.forEach(a => {
      const id = a.ar_id || a.topic_id || a.quiz_id; if (!id) return;
      const sid = a.student_id || 'anon';
      const q = qEnsure(id);
      q.attempted.add(sid);
      // App writes score_pct (0–1) on quiz_submit; older events may carry score/max_score.
      let pct = null;
      if (a.score_pct != null) pct = Number(a.score_pct) * 100;
      else if (Number(a.max_score) > 0) pct = (Number(a.score) / Number(a.max_score)) * 100;
      else if (Number(a.total_questions) > 0) pct = (Number(a.correct_answers) / Number(a.total_questions)) * 100;
      if (pct != null && !Number.isNaN(pct)) {
        q.scores.push(pct);
        if (pct >= 100 || a.passed === true) q.mastered.add(sid);
      }
    });

    const avg = (arr) => arr.length ? Math.round(arr.reduce((s, n) => s + n, 0) / arr.length) : 0;
    const funnel = Object.values(mod).map(m => {
      const q = quiz[m.ar_id] || { attempted: new Set(), mastered: new Set(), scores: [] };
      const started = m.started.size, watched = m.watched.size;
      const attempted = q.attempted.size, mastered = q.mastered.size;
      const watchRate = started ? Math.round((watched / started) * 100) : 0;
      const masteryRate = attempted ? Math.round((mastered / attempted) * 100) : 0;
      let health = 'ok';
      if (started >= 5 && watchRate < 50) health = 'low_engagement';
      else if (attempted >= 5 && masteryRate < 30) health = 'too_hard';
      else if (attempted >= 5 && masteryRate > 95) health = 'too_easy';
      return {
        ar_id: m.ar_id, title: m.title || m.ar_id,
        started, watched, attempted, mastered,
        watch_rate: watchRate, mastery_rate: masteryRate,
        avg_watch_seconds: avg(m.durations), avg_score: avg(q.scores), health,
      };
    }).sort((a, b) => b.started - a.started);

    const totals = funnel.reduce((t, m) => {
      t.started += m.started; t.watched += m.watched;
      t.attempted += m.attempted; t.mastered += m.mastered; return t;
    }, { started: 0, watched: 0, attempted: 0, mastered: 0 });

    res.json({ totals, modules: funnel, generated_at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Funnel failed', detail: String(err.message || err) });
  }
});

module.exports = router;