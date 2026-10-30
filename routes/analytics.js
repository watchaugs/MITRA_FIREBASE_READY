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
  rb.setJoins(joins);
  const { generated, scopes } = await rb.buildAllScopes();
  const entries = Object.entries(scopes);
  for (let i = 0; i < entries.length; i += 300) {
    const batch = db.batch();
    for (const [name, data] of entries.slice(i, i + 300)) {
      batch.set(db.collection('analytics_cache').doc('scope__' + slugScope(name)), { scope: name, generated, data });
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
router.get('/snapshot', requirePerm('perm_view_analytics'), async (req, res) => {
  const snap = await readSnapshot();
  res.json(snap || { ...EMPTY, empty: true });
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

// ── Layer 3: FULL raw dataset export (BigQuery → GCS, free extract) ──────────
// EXTRACT jobs are NOT query-billed (free). Writes the whole telemetry table to
// gzipped CSV (auto-sharded at crore-scale), then hands back 24h signed links
// so the browser downloads straight from GCS (not through Cloud Run).
router.post('/raw-export', requirePerm('perm_export_data'), async (req, res) => {
  try {
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
    const scope = (req.query.scope && String(req.query.scope).trim()) || 'All India';
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
    const { format = 'xlsx', state = '', district = '', class_grade = '', subject = '', month = '' } = req.query;

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

module.exports = router;