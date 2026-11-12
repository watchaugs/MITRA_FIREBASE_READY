/**
 * routes/reports.js — Monthly Government Report (PPTX) generator
 *
 * Fills the shipped PowerPoint template (assets/MITRA_Monthly_Report_Template.pptx)
 * with live telemetry and streams it back. Every {{TOKEN}} in the template is
 * replaced; any metric we don't yet have data for renders as '—' (never a crash).
 *
 * Route:  GET /api/reports/monthly.pptx?month=YYYY-MM&scope=<state|All India>&gender=<All|Male|Female>
 * Auth:   requires a valid token with perm_export_data (same as data export).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const PizZip = require('pizzip');
const router = require('express').Router();
const { authenticate, requirePerm } = require('../middleware/auth');

router.use(authenticate);

const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'MITRA_Monthly_Report_Template.pptx');
const DEFAULT = '—';
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const n  = v => (v === null || v === undefined || Number.isNaN(v)) ? DEFAULT : Number(v).toLocaleString('en-IN');
const pc = (part, whole) => whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : DEFAULT;
const mins = v => (v || v === 0) ? `${Number(v).toFixed(1)}` : DEFAULT;

/**
 * Compute the data map from Firestore telemetry_sessions. Robust by design:
 * missing fields never throw; unavailable metrics stay as '—' via the nullGetter.
 */
async function buildReportData({ month, scope, gender }) {
  const d = {}; // only set what we can compute; the rest defaults to '—'

  // ── Labels (always available) ──────────────────────────────────────────────
  let label = month;
  if (/^\d{4}-\d{2}$/.test(month || '')) {
    const [yy, mm] = month.split('-').map(Number);
    label = `${MONTHS[mm - 1]} ${yy}`;
  }
  d.REPORT_MONTH   = label || DEFAULT;
  d.SELECTED_SCOPE = scope || 'All India';
  d.SELECTED_GENDER = gender || 'All';
  d.SELECTED_OWNER = 'Ministry of Education';

  // ── Pull sessions for the period ───────────────────────────────────────────
  try {
    const db = require('../lib/firebase').getFirestore();
    // The app writes session events to the 'sessions' collection (batched).
    // Use a collectionGroup so batched sub-docs are included, then normalise
    // each event to the flat shape this report expects.
    const snap = await db.collectionGroup('sessions').limit(100000).get();
    // Each doc is a BATCH wrapper { batched_events[], batch_flushed_at, ... }.
    // Unwrap to individual events first; the student/session fields live INSIDE
    // batched_events[], not on the wrapper. Carry batch_flushed_at onto each
    // event so the month filter has a timestamp.
    let S = [];
    snap.docs.forEach(x => {
      const doc = x.data() || {};
      const flushedAt = doc.batch_flushed_at;
      const arr = Array.isArray(doc.batched_events) ? doc.batched_events : [doc];
      arr.forEach(e => {
        S.push({
          student_id: e.student_id,
          device_id: e.device_id || e.device_model,
          school_id: e.school_code || e.school_id,
          district: e.district,
          state: e.state,
          gender: e.gender,
          session_minutes: e.session_minutes != null
            ? e.session_minutes
            : (e.duration_seconds != null ? Math.ceil(e.duration_seconds / 60) : 0),
          offline: e.offline_session === true || e.was_offline === true,
          dropped_off: e.dropped_off === true || e.completed === false,
          network_type: e.network_quality || e.network_type || e.connectivity_type,
          created_at: e.created_at || flushedAt || e.timestamp,
          event_type: e.event_type,
        });
      });
    });
    // Period + scope filters applied in memory (collectionGroup can't compound-filter here).
    if (scope && scope !== 'All India') S = S.filter(s => s.state === scope);
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [yy, mm] = month.split('-').map(Number);
      const lo = new Date(Date.UTC(yy, mm - 1, 1)), hi = new Date(Date.UTC(yy, mm, 1));
      S = S.filter(s => {
        const t = s.created_at?.toDate ? s.created_at.toDate() : new Date(s.created_at);
        return t >= lo && t < hi;
      });
    }
    const total = S.length;

    if (total > 0) {
      const uniq = (f) => new Set(S.map(s => s[f]).filter(Boolean)).size;
      d.TOTAL_SESSIONS   = n(total);
      d.TOTAL_STUDENTS   = n(uniq('student_id'));
      d.TOTAL_DEVICES    = uniq('device_id') ? n(uniq('device_id')) : DEFAULT;
      d.SCHOOLS_ACTIVE   = uniq('school_id') ? n(uniq('school_id')) : DEFAULT;
      d.DISTRICTS        = uniq('district') ? n(uniq('district')) : DEFAULT;
      d.AVG_SESSION_MIN  = mins(S.reduce((a, s) => a + (s.session_minutes || 0), 0) / total);
      d.OFFLINE_PCT      = pc(S.filter(s => s.offline).length, total);
      d.DROPOFF_PCT      = pc(S.filter(s => s.dropped_off).length, total);

      // Duration bands (minutes): <5, 5–15, 15–30, >30
      const band = (lo, hi) => S.filter(s => (s.session_minutes || 0) >= lo && (s.session_minutes || 0) < hi).length;
      const b1 = band(0, 5), b2 = band(5, 15), b3 = band(15, 30), b4 = S.filter(s => (s.session_minutes || 0) >= 30).length;
      d.D_1_5_COUNT = n(b1);   d.D_1_5_PCT = pc(b1, total);
      d.D_5_15_COUNT = n(b2);  d.D_5_15_PCT = pc(b2, total);
      d.D_15_30_COUNT = n(b3); d.D_15_30_PCT = pc(b3, total);
      d.D_30_COUNT = n(b4);    d.D_30_PCT = pc(b4, total);

      // Network distribution (if network_type present)
      const netPct = (t) => pc(S.filter(s => (s.network_type || '').toLowerCase() === t).length, total);
      d.NET_WIFI_PCT = netPct('wifi'); d.NET_4G_PCT = netPct('4g'); d.NET_5G_PCT = netPct('5g');
      d.NET_3G_PCT = netPct('3g');     d.NET_2G_PCT = netPct('2g'); d.NET_OFFLINE_PCT = netPct('offline');

      // Gender splits (if gender present)
      const g = (val) => S.filter(s => (s.gender || '').toLowerCase() === val);
      const setGender = (pfx, arr) => {
        if (!arr.length) return;
        d[`${pfx}_STUDENTS`] = n(new Set(arr.map(s => s.student_id).filter(Boolean)).size);
        d[`${pfx}_SESSIONS`] = n(arr.length);
        d[`${pfx}_AVG_MIN`]  = mins(arr.reduce((a, s) => a + (s.session_minutes || 0), 0) / arr.length);
      };
      setGender('MALE', g('male')); setGender('FEMALE', g('female')); setGender('OTHER', g('other'));
    }
  } catch (err) {
    // Never let a data error break the report — it just renders '—'.
    console.error('[reports] buildReportData warning:', err.message);
  }
  return d;
}

function fillTemplate(buf, data) {
  const zip = new PizZip(buf);
  Object.keys(zip.files).forEach(name => {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) {
      const xml = zip.files[name].asText().replace(
        /\{\{([A-Z0-9_]+)\}\}/g,
        (_, key) => Object.prototype.hasOwnProperty.call(data, key) ? String(data[key]) : DEFAULT
      );
      zip.file(name, xml);
    }
  });
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

router.get('/monthly.pptx', requirePerm('perm_export_data'), async (req, res) => {
  try {
    if (!fs.existsSync(TEMPLATE_PATH)) {
      return res.status(500).json({ error: 'Report template not found on server' });
    }
    const { month = '', scope = 'All India', gender = 'All' } = req.query;
    const data = await buildReportData({ month, scope, gender });
    const out = fillTemplate(fs.readFileSync(TEMPLATE_PATH), data);

    const safeMonth = (month || 'report').replace(/[^0-9A-Za-z-]/g, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="MITRA_Monthly_Report_${safeMonth}.pptx"`);
    res.send(out);
  } catch (err) {
    console.error('[reports] monthly.pptx failed:', err);
    res.status(500).json({ error: 'Report generation failed', detail: err.message });
  }
});

module.exports = router;