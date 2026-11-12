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
    // ═══════════════════════════════════════════════════════════════════════
    // TELEMETRY AGGREGATES — fills the quiz / AR / district / language /
    // accessibility / device-health / notification / feedback / ads sections
    // of the template. All read straight from Firestore (no BigQuery), using
    // the same batched-events unwrap as /analytics snapshot. Scope + month
    // filters applied in memory. Anything with no data stays '—'.
    // ═══════════════════════════════════════════════════════════════════════
    const inScope = (e) => {
      if (scope && scope !== 'All India' && String(e.state || '') !== scope) return false;
      if (month && /^\d{4}-\d{2}$/.test(month)) {
        const t = e.batch_flushed_at || e.created_at || e.timestamp;
        if (!t || !String(t).startsWith(month)) return false;
      }
      return true;
    };
    const pull = async (collection, cap = 5000) => {
      try {
        const snap = await db.collectionGroup(collection)
          .orderBy('batch_flushed_at', 'desc').limit(cap).get();
        const out = [];
        snap.docs.forEach(doc => {
          const w = doc.data() || {};
          const arr = Array.isArray(w.batched_events) ? w.batched_events : [w];
          arr.forEach(e => { const ev = { ...e, batch_flushed_at: w.batch_flushed_at }; if (inScope(ev)) out.push(ev); });
        });
        return out;
      } catch (_) { return []; }
    };
    const num = v => Number(v) || 0;
    const uniqC = a => new Set(a.filter(Boolean)).size;
    const pctOf = (p, w) => w > 0 ? `${((p / w) * 100).toFixed(1)}%` : DEFAULT;
    const avgC = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
    const subjOf = (s) => {
      const x = String(s || '').toLowerCase();
      if (x.includes('bio')) return 'BIO';
      if (x.includes('chem')) return 'CHE';
      if (x.includes('phys')) return 'PHY';
      if (x.includes('math')) return 'MATH';
      if (x.includes('geo')) return 'GEO';
      if (x.includes('hist')) return 'HIST';
      if (x.includes('social')) return 'SS';
      if (x.includes('sci')) return 'SCI';
      return null;
    };

    const [arViews, quizzesT, langEv, accEv, devEv, notifEv] = await Promise.all([
      pull('ar_views'), pull('quiz_attempts'), pull('language_events'),
      pull('accessibility_events'), pull('device_events'), pull('notification_events'),
    ]);

    // ── QUIZ: totals + per-subject (QBIO_ATT/_SCORE/_CORRECT/_COMP, BIO_ATTEMPTS/_SCORE) ──
    const quizSubs = quizzesT.filter(e => e.event_type === 'quiz_submit');
    if (quizSubs.length) {
      d.TOTAL_QUIZ      = n(quizSubs.length);
      d.AVG_QUIZ_SCORE  = `${(avgC(quizSubs.map(e => num(e.score_pct) * 100))).toFixed(1)}%`;
      d.QUIZ_COMP_PCT   = pctOf(quizSubs.filter(e => e.completed === true).length, quizSubs.length);
      d.QUIZ_ABANDONED  = n(quizSubs.filter(e => e.completed !== true).length);
      const bySub = {};
      quizSubs.forEach(e => {
        const k = subjOf(e.subject); if (!k) return;
        (bySub[k] ||= { att: 0, score: [], correct: 0, total: 0, comp: 0 });
        bySub[k].att++; bySub[k].score.push(num(e.score_pct) * 100);
        bySub[k].correct += num(e.correct_answers); bySub[k].total += num(e.total_questions);
        if (e.completed === true) bySub[k].comp++;
      });
      Object.entries(bySub).forEach(([k, v]) => {
        d[`Q${k}_ATT`]     = n(v.att);
        d[`Q${k}_SCORE`]   = `${avgC(v.score).toFixed(1)}%`;
        d[`Q${k}_CORRECT`] = pctOf(v.correct, v.total);
        d[`Q${k}_COMP`]    = pctOf(v.comp, v.att);
        d[`${k}_ATTEMPTS`] = n(v.att);
        d[`${k}_SCORE`]    = `${avgC(v.score).toFixed(1)}%`;
      });
    }

    // ── AR: AR_COMPLETION + per-module M01..M10 (launches/unique/dwell/comp/lift) ──
    const arEnds = arViews.filter(e => e.event_type === 'ar_end');
    if (arEnds.length) {
      d.AR_COMPLETION = pctOf(arEnds.filter(e => e.completed === true).length, arEnds.length);
      const byMod = {};
      arViews.forEach(e => {
        const key = e.module_title || e.topic_id || e.ar_id; if (!key) return;
        (byMod[key] ||= { launches: 0, users: new Set(), dwell: [], comp: 0, ends: 0, lift: [] });
        const m = byMod[key];
        if (e.event_type === 'ar_start') m.launches++;
        if (e.student_id) m.users.add(e.student_id);
        if (e.event_type === 'ar_end') {
          m.ends++;
          if (typeof e.duration_seconds === 'number') m.dwell.push(e.duration_seconds);
          if (e.completed === true) m.comp++;
          if (e.pre_module_score != null && e.post_module_score != null)
            m.lift.push(num(e.post_module_score) - num(e.pre_module_score));
        }
      });
      const topMods = Object.entries(byMod)
        .sort((a, b) => b[1].launches - a[1].launches).slice(0, 10);
      topMods.forEach(([, m], i) => {
        const p = `M${String(i + 1).padStart(2, '0')}`;
        d[`${p}_LAUNCHES`] = n(m.launches);
        d[`${p}_UNIQUE`]   = n(m.users.size);
        d[`${p}_DWELL`]    = `${(avgC(m.dwell) / 60).toFixed(1)}`;
        d[`${p}_COMP`]     = pctOf(m.comp, m.ends);
        d[`${p}_LIFT`]     = m.lift.length ? `${avgC(m.lift).toFixed(1)}` : DEFAULT;
      });
    }

    // ── DISTRICT table D01..D10 (sessions/users/schools/ar-comp/quiz/quizscore/risk) ──
    const allEv = [...S.map(s => ({ ...s, _sess: true })), ...arViews, ...quizSubs];
    const byDist = {};
    allEv.forEach(e => {
      const dist = e.district; if (!dist) return;
      (byDist[dist] ||= { sess: 0, users: new Set(), schools: new Set(), arEnd: 0, arComp: 0, quiz: 0, qscore: [], risk: [] });
      const b = byDist[dist];
      if (e._sess) b.sess++;
      if (e.student_id) b.users.add(e.student_id);
      if (e.school_id || e.school_code) b.schools.add(e.school_id || e.school_code);
      if (e.event_type === 'ar_end') { b.arEnd++; if (e.completed === true) b.arComp++; }
      if (e.event_type === 'quiz_submit') { b.quiz++; b.qscore.push(num(e.score_pct) * 100); }
      if (e.risk_level) b.risk.push(String(e.risk_level));
    });
    Object.entries(byDist)
      .sort((a, b) => b[1].users.size - a[1].users.size).slice(0, 10)
      .forEach(([name, b], i) => {
        const p = `D${String(i + 1).padStart(2, '0')}`;
        d[`${p}_SESS`]      = n(b.sess);
        d[`${p}_USERS`]     = n(b.users.size);
        d[`${p}_SCHOOLS`]   = n(b.schools.size);
        d[`${p}_ARCOMP`]    = pctOf(b.arComp, b.arEnd);
        d[`${p}_QUIZ`]      = n(b.quiz);
        d[`${p}_QUIZSCORE`] = b.qscore.length ? `${avgC(b.qscore).toFixed(1)}%` : DEFAULT;
        const hi = b.risk.filter(r => r.toLowerCase() === 'high').length;
        d[`${p}_RISK`]      = b.risk.length ? pctOf(hi, b.risk.length) : DEFAULT;
      });

    // ── LANGUAGE: sessions by base language + switches ──
    const langOf = (e) => {
      const x = String(e.language || '').toLowerCase();
      if (x.includes('eng')) return 'ENGLISH';
      if (x.includes('hin')) return 'HINDI';
      return 'REGION';
    };
    if (S.length) {
      const lc = { ENGLISH: 0, HINDI: 0, REGION: 0 };
      S.forEach(e => { lc[langOf(e)]++; });
      const lt = S.length;
      d.LANG_ENGLISH_SESSIONS = n(lc.ENGLISH); d.LANG_ENGLISH_PCT = pctOf(lc.ENGLISH, lt);
      d.LANG_HINDI_SESSIONS   = n(lc.HINDI);   d.LANG_HINDI_PCT   = pctOf(lc.HINDI, lt);
      d.LANG_REGION_SESSIONS  = n(lc.REGION);  d.LANG_REGION_PCT  = pctOf(lc.REGION, lt);
    }
    if (langEv.length) d.LANG_SWITCHES = n(langEv.filter(e => e.event_type === 'language_switch' || e.from_language).length);

    // ── ACCESSIBILITY: % of users with each feature enabled ──
    if (accEv.length) {
      const feat = (names) => {
        const on = accEv.filter(e => {
          const f = String(e.feature || e.accommodation_type || '').toLowerCase();
          return names.some(nm => f.includes(nm)) && e.enabled !== false;
        });
        return uniqC(on.map(e => e.student_id));
      };
      const base = uniqC(accEv.map(e => e.student_id)) || 1;
      d.ACC_TTS        = pctOf(feat(['tts', 'speech']), base);
      d.ACC_SCREEN_RDR = pctOf(feat(['screen', 'reader']), base);
      d.ACC_CONTRAST   = pctOf(feat(['contrast']), base);
      d.ACC_LGTXT      = pctOf(feat(['large', 'font', 'text']), base);
      d.ACC_CBLIND     = pctOf(feat(['colbr', 'colour', 'color', 'blind']), base);
      d.ACC_HAPTIC     = pctOf(feat(['haptic', 'vibrat']), base);
      d.ACC_SUB        = pctOf(feat(['subtitle', 'caption']), base);
      d.ACC_2DFALLBACK = pctOf(feat(['2d', 'fallback']), base);
    }

    // ── DEVICE HEALTH: crash/ANR/cold-start/battery + bounce/rage ──
    if (devEv.length) {
      const crashes = devEv.filter(e => e.event_type === 'crash');
      const colds   = devEv.filter(e => typeof e.cold_start_ms === 'number');
      const sessN   = Math.max(S.length, 1);
      d.CRASH_RATE = pctOf(crashes.length, sessN);
      d.ANR_RATE   = pctOf(devEv.filter(e => e.event_type === 'anr').length, sessN);
      d.COLD_START = colds.length ? `${(avgC(colds.map(e => num(e.cold_start_ms))) / 1000).toFixed(1)}s` : DEFAULT;
      const batt = arEnds.filter(e => typeof e.battery_drain_pct === 'number').map(e => num(e.battery_drain_pct));
      d.BATT_DRAIN = batt.length ? `${avgC(batt).toFixed(1)}%` : DEFAULT;
    }
    const rage = arViews.concat(S).filter(e => e.exited_rage_tap === true || e.event_type === 'rage_tap').length;
    if (rage) d.RAGE_TAPS = n(rage);
    d.AR_CAPABLE_PCT = S.length ? pctOf(S.filter(e => e.ar_capable === true).length, S.length) : DEFAULT;

    // ── NOTIFICATIONS: app-observed open / click ──
    if (notifEv.length) {
      const opened = notifEv.filter(e => e.action === 'open' || e.event_type === 'notification_open').length;
      const clicked = notifEv.filter(e => e.action === 'click' || e.event_type === 'notification_click').length;
      const delivered = notifEv.filter(e => e.action === 'deliver' || e.event_type === 'notification_deliver').length;
      d.NOTIF_OPENED = n(opened);
      d.NOTIF_DELIVERED = n(delivered);
      d.NOTIF_OPEN_PCT = pctOf(opened, delivered || notifEv.length);
      d.NOTIF_CTR = pctOf(clicked, opened || notifEv.length);
    }

    // ── FEEDBACK / NPS (app_feedback collection) ──
    try {
      const fbSnap = await db.collection('app_feedback').limit(5000).get();
      const fb = fbSnap.docs.map(x => x.data() || {}).filter(e => {
        if (scope && scope !== 'All India' && String(e.state || '') !== scope) return false;
        if (month && /^\d{4}-\d{2}$/.test(month)) {
          const t = e.created_at && e.created_at.toDate ? e.created_at.toDate().toISOString() : '';
          if (!t.startsWith(month)) return false;
        }
        return true;
      });
      const ratings = fb.filter(e => typeof e.rating === 'number');
      if (ratings.length) {
        const ar = avgC(ratings.map(e => e.rating));
        d.FB_AVG_RATING = ar.toFixed(1); d.AVG_RATING = ar.toFixed(1);
        d.FB_TOTAL = n(ratings.length);
        const tag = (kw) => ratings.filter(e => String(e.message || '').toLowerCase().includes(kw)).length;
        d.FB_LOVED     = n(ratings.filter(e => e.rating >= 4).length);
        d.FB_BORING    = n(tag('bor'));
        d.FB_CONFUSING = n(tag('confus'));
        d.FB_TOOEASY   = n(tag('easy'));
        d.FB_TOOFAST   = n(tag('fast'));
      }
      const nps = fb.filter(e => typeof e.nps_score === 'number');
      if (nps.length) {
        let promo = 0, detr = 0;
        nps.forEach(e => { if (e.nps_score >= 9) promo++; else if (e.nps_score <= 6) detr++; });
        d.NPS_SCORE   = `${Math.round(((promo - detr) / nps.length) * 100)}`;
        d.NPS_PROMO   = pctOf(promo, nps.length);
        d.NPS_DETRACT = pctOf(detr, nps.length);
        // gender-split NPS (GN_*), when gender present on the feedback doc
        const gBuckets = { MALE: [], FEM: [], OTH: [] };
        nps.forEach(e => {
          const g = String(e.gender || '').toLowerCase();
          if (g === 'male') gBuckets.MALE.push(e); else if (g === 'female') gBuckets.FEM.push(e); else gBuckets.OTH.push(e);
        });
        Object.entries(gBuckets).forEach(([k, arr]) => {
          if (!arr.length) return;
          let p = 0, dt = 0; arr.forEach(e => { if (e.nps_score >= 9) p++; else if (e.nps_score <= 6) dt++; });
          d[`GN_${k}_NPS`]    = `${Math.round(((p - dt) / arr.length) * 100)}`;
          d[`GN_${k}_PROMO`]  = pctOf(p, arr.length);
          d[`GN_${k}_RESP`]   = n(arr.length);
          const r = arr.filter(e => typeof e.rating === 'number');
          d[`GN_${k}_RATING`] = r.length ? avgC(r.map(e => e.rating)).toFixed(1) : DEFAULT;
        });
      }
    } catch (_) { /* feedback stays '—' */ }

    // ── ADS (ad_campaigns counters, dashboard-side) ──
    try {
      const adSnap = await db.collection('ad_campaigns').limit(500).get();
      const ads = adSnap.docs.map(x => x.data() || {});
      if (ads.length) {
        const imp = ads.reduce((s, a) => s + num(a.impressions), 0);
        const clk = ads.reduce((s, a) => s + num(a.clicks), 0);
        d.AD_IMPRESSIONS = n(imp);
        d.AD_CLICKS      = n(clk);
        d.AD_CTR         = pctOf(clk, imp);
        d.AD_REACH       = n(ads.reduce((s, a) => s + num(a.reach || a.unique_reach), 0) || imp);
        // per-format rows CAD_<FMT>_* by campaign type
        const fmtMap = { banner: 'BAN', interstitial: 'INT', native: 'NAT', sponsored: 'SPO', video: 'VID' };
        const byFmt = {};
        ads.forEach(a => {
          const f = fmtMap[String(a.format || a.type || '').toLowerCase()]; if (!f) return;
          (byFmt[f] ||= { imp: 0, clk: 0, reach: 0 });
          byFmt[f].imp += num(a.impressions); byFmt[f].clk += num(a.clicks); byFmt[f].reach += num(a.reach || a.unique_reach);
        });
        Object.entries(byFmt).forEach(([f, v]) => {
          d[`CAD_${f}_IMP`]   = n(v.imp);
          d[`CAD_${f}_CLICK`] = n(v.clk);
          d[`CAD_${f}_CTR`]   = pctOf(v.clk, v.imp);
          d[`CAD_${f}_REACH`] = n(v.reach || v.imp);
        });
      }
    } catch (_) { /* ads stay '—' */ }

    // ── GENDER × QUIZ (MALE_QUIZ/_SCORE etc.) from quiz_attempts ──
    if (quizSubs.length) {
      const gq = { MALE: [], FEMALE: [], OTHER: [] };
      quizSubs.forEach(e => {
        const g = String(e.gender || '').toLowerCase();
        if (g === 'male') gq.MALE.push(e); else if (g === 'female') gq.FEMALE.push(e); else gq.OTHER.push(e);
      });
      Object.entries(gq).forEach(([k, arr]) => {
        if (!arr.length) return;
        d[`${k}_QUIZ`]  = n(arr.length);
        d[`${k}_SCORE`] = `${avgC(arr.map(e => num(e.score_pct) * 100)).toFixed(1)}%`;
      });
    }

    // ── MOBILE OWNERSHIP rollup (Father/Mother/Self/Other) ──
    // mobile_ownership is on the base event envelope (only when consented).
    // Tiles: FAT/MTH/SEL/OTH → _SESS/_STUD/_ARCOMP/_QUIZ/_SCORE.
    {
      const OWN = { Father: 'FAT', Mother: 'MTH', Self: 'SEL', Other: 'OTH' };
      const ownOf = (e) => OWN[String(e.mobile_ownership || '')] || null;
      const roll = { FAT: null, MTH: null, SEL: null, OTH: null };
      const ensureO = (k) => (roll[k] ||= { sess: 0, users: new Set(), arEnd: 0, arComp: 0, quiz: 0, qscore: [] });
      // sessions contribute _SESS / _STUD
      S.forEach(e => { const k = ownOf(e); if (!k) return; const b = ensureO(k); b.sess++; if (e.student_id) b.users.add(e.student_id); });
      // ar_views contribute _ARCOMP
      arEnds.forEach(e => { const k = ownOf(e); if (!k) return; const b = ensureO(k); b.arEnd++; if (e.completed === true) b.arComp++; if (e.student_id) b.users.add(e.student_id); });
      // quiz contribute _QUIZ / _SCORE
      quizSubs.forEach(e => { const k = ownOf(e); if (!k) return; const b = ensureO(k); b.quiz++; b.qscore.push(num(e.score_pct) * 100); if (e.student_id) b.users.add(e.student_id); });
      Object.entries(roll).forEach(([k, b]) => {
        if (!b) return;
        d[`${k}_SESS`]   = n(b.sess);
        d[`${k}_STUD`]   = n(b.users.size);
        d[`${k}_ARCOMP`] = pctOf(b.arComp, b.arEnd);
        d[`${k}_QUIZ`]   = n(b.quiz);
        d[`${k}_SCORE`]  = b.qscore.length ? `${avgC(b.qscore).toFixed(1)}%` : DEFAULT;
      });
    }

    // ── NPS by mobile ownership (MN_FAT/MTH/SEL_*) from app_feedback ──
    try {
      const mnSnap = await db.collection('app_feedback').where('type', '==', 'nps').limit(5000).get();
      const MNK = { Father: 'FAT', Mother: 'MTH', Self: 'SEL' };
      const mn = {};
      mnSnap.docs.forEach(x => {
        const e = x.data() || {};
        if (scope && scope !== 'All India' && String(e.state || '') !== scope) return;
        if (month && /^\d{4}-\d{2}$/.test(month)) {
          const t = e.created_at && e.created_at.toDate ? e.created_at.toDate().toISOString() : '';
          if (!t.startsWith(month)) return;
        }
        const k = MNK[String(e.mobile_ownership || '')]; if (!k || typeof e.nps_score !== 'number') return;
        (mn[k] ||= { promo: 0, detr: 0, n: 0, rating: [] });
        mn[k].n++;
        if (e.nps_score >= 9) mn[k].promo++; else if (e.nps_score <= 6) mn[k].detr++;
        if (typeof e.rating === 'number') mn[k].rating.push(e.rating);
      });
      Object.entries(mn).forEach(([k, v]) => {
        d[`MN_${k}_NPS`]    = `${Math.round(((v.promo - v.detr) / v.n) * 100)}`;
        d[`MN_${k}_PROMO`]  = pctOf(v.promo, v.n);
        d[`MN_${k}_RESP`]   = n(v.n);
        d[`MN_${k}_RATING`] = v.rating.length ? avgC(v.rating).toFixed(1) : DEFAULT;
      });
    } catch (_) { /* MN_* stay '—' */ }

    // ── QZ01-06: top 6 quizzes by attempts (from quiz_attempts) ──
    if (quizSubs.length) {
      const byQuiz = {};
      quizSubs.forEach(e => {
        const key = e.quiz_title || e.quiz_id; if (!key) return;
        (byQuiz[key] ||= { att: 0, score: [] });
        byQuiz[key].att++; byQuiz[key].score.push(num(e.score_pct) * 100);
      });
      Object.entries(byQuiz).sort((a, b) => b[1].att - a[1].att).slice(0, 6)
        .forEach(([, v], i) => {
          const p = `QZ${String(i + 1).padStart(2, '0')}`;
          d[`${p}_ATT`]   = n(v.att);
          d[`${p}_SCORE`] = `${avgC(v.score).toFixed(1)}%`;
        });
    }

// ── NOTIFICATIONS: send-ledger (notifications) + telemetry opens joined ──
    // Honest limits: the app's notification_events carry action (open/click)
    // and a generic notification_type ('push'), but NO campaign id/title, so
    // per-campaign opens can't be attributed. We fill the AGGREGATE send/open
    // metrics truthfully; per-row NT*_OPEN/_CTR stay '—' (no join key).
    try {
      const sentSnap = await db.collection('notifications').orderBy('created_at', 'desc').limit(500).get();
      const sent = sentSnap.docs.map(x => x.data() || {}).filter(e => {
        if (scope && scope !== 'All India' && String(e.target_state || '') !== scope) return false;
        if (month && /^\d{4}-\d{2}$/.test(month)) {
          const t = e.sent_at && e.sent_at.toDate ? e.sent_at.toDate().toISOString()
                  : (e.created_at && e.created_at.toDate ? e.created_at.toDate().toISOString() : '');
          if (!t.startsWith(month)) return false;
        }
        return true;
      });
      if (sent.length) {
        const accepted = sent.filter(e => e.fcm_message_id).length; // FCM-accepted = our best "delivered"
        d.NOTIF_SENT         = n(sent.length);
        d.NOTIF_DELIVERED    = n(accepted);
        d.NOTIF_DELIVERY_PCT = pctOf(accepted, sent.length);
        d.PUSH_DELIVERY      = pctOf(accepted, sent.length);
        d.NG_ALL_SENT        = n(sent.length);
        // NT1-4: the four most recent campaigns, SENT + DELIVERED only (no opens).
        sent.slice(0, 4).forEach((e, i) => {
          const p = `NT${i + 1}`;
          d[`${p}_SENT`]   = n(1);                       // one dispatch record = one campaign row
          d[`${p}_DEL`]    = n(e.fcm_message_id ? 1 : 0);
          d[`${p}_DELPCT`] = e.fcm_message_id ? '100.0%' : '0.0%';
        });
      }
    } catch (_) { /* notification send metrics stay '—' */ }

    // ── NOTIFICATION opens/clicks (telemetry, aggregate) ──
    if (notifEv.length) {
      const opens   = notifEv.filter(e => e.action === 'open'  || e.event_type === 'notification_open').length;
      const clicks  = notifEv.filter(e => e.action === 'click' || e.event_type === 'notification_click').length;
      const optOuts = notifEv.filter(e => e.action === 'opt_out' || e.event_type === 'notification_opt_out').length;
      d.NOTIF_OPENED  = n(opens);
      d.PUSH_OPEN     = n(opens);
      d.NOTIF_OPT_OUT = n(optOuts);
      // open/CTR % against delivered when we have it, else against events seen
      const denom = (d.NOTIF_DELIVERED && d.NOTIF_DELIVERED !== DEFAULT)
        ? Number(String(d.NOTIF_DELIVERED).replace(/[^0-9]/g, '')) : notifEv.length;
      d.NOTIF_OPEN_PCT = pctOf(opens, denom || notifEv.length);
      d.NOTIF_CTR      = pctOf(clicks, opens || notifEv.length);
      d.NG_ALL_OPENPCT = pctOf(opens, denom || notifEv.length);
      d.NG_ALL_CTR     = pctOf(clicks, opens || notifEv.length);
      // gender split of OPENS (telemetry carries gender when consented)
      const gBucket = { MALE: notifEv.filter(e => String(e.gender||'').toLowerCase()==='male'),
                        FEM:  notifEv.filter(e => String(e.gender||'').toLowerCase()==='female') };
      Object.entries(gBucket).forEach(([k, arr]) => {
        if (!arr.length) return;
        const o = arr.filter(e => e.action === 'open').length;
        const c = arr.filter(e => e.action === 'click').length;
        d[`NG_${k}_SENT`]    = n(arr.length);
        d[`NG_${k}_OPENPCT`] = pctOf(o, arr.length);
        d[`NG_${k}_CTR`]     = pctOf(c, o || arr.length);
      });
    }

    // ── AR RENDER-MODE breakdown (requires app render_mode field) ──
    // Tiers: MARKER / MARKLESS / BASIC3D / INT3D → _SESSIONS/_COMP/_PCT/_AVG_MIN.
    {
      const MODE = { marker: 'MARKER', markerless: 'MARKLESS', basic3d: 'BASIC3D', interactive3d: 'INT3D' };
      const roll = {};
      arEnds.forEach(e => {
        const k = MODE[String(e.render_mode || '')]; if (!k) return;
        (roll[k] ||= { sess: 0, comp: 0, dwell: [] });
        roll[k].sess++; if (e.completed === true) roll[k].comp++;
        if (typeof e.duration_seconds === 'number') roll[k].dwell.push(e.duration_seconds);
      });
      const totalModed = Object.values(roll).reduce((s, v) => s + v.sess, 0);
      Object.entries(roll).forEach(([k, v]) => {
        d[`${k}_SESSIONS`] = n(v.sess);
        d[`${k}_COMP`]     = pctOf(v.comp, v.sess);
        d[`${k}_PCT`]      = pctOf(v.sess, totalModed);
        d[`${k}_AVG_MIN`]  = v.dwell.length ? `${(avgC(v.dwell) / 60).toFixed(1)}` : DEFAULT;
      });
    }

    // ── DEVICE-TIER performance (requires app device_tier on envelope) ──
    {
      const TIER = { high: 'DEV_HIGH', medium: 'DEV_MID', low: 'DEV_LOW' };
      const roll = {};
      const tierOf = (e) => TIER[String(e.device_tier || '').toLowerCase()] || null;
      S.forEach(e => { const k = tierOf(e); if (!k) return; (roll[k] ||= { sess: 0, mins: [] }); roll[k].sess++; if (e.session_minutes != null) roll[k].mins.push(e.session_minutes); });
      const compByTier = {};
      arEnds.forEach(e => { const k = tierOf(e); if (!k) return; (compByTier[k] ||= { end: 0, comp: 0 }); compByTier[k].end++; if (e.completed === true) compByTier[k].comp++; });
      const totalTier = Object.values(roll).reduce((s, v) => s + v.sess, 0);
      Object.entries(roll).forEach(([k, v]) => {
        d[`${k}_PCT`]     = pctOf(v.sess, totalTier);
        d[`${k}_AVG_MIN`] = v.mins.length ? mins(avgC(v.mins)) : DEFAULT;
        const c = compByTier[k];
        d[`${k}_COMP`]    = c ? pctOf(c.comp, c.end) : DEFAULT;
      });
    }

    // ── NT1-4 per-campaign OPENS/CLICKS (requires app campaign_id on notif events) ──
    // Join telemetry notification_events → the 4 most-recent sent campaigns by id.
    try {
      const sentSnap2 = await db.collection('notifications').orderBy('created_at', 'desc').limit(4).get();
      const camps = sentSnap2.docs.map(x => ({ id: x.id, ...(x.data() || {}) }));
      camps.forEach((c, i) => {
        const p = `NT${i + 1}`;
        const evs = notifEv.filter(e => String(e.campaign_id || '') === c.id);
        const opens  = evs.filter(e => e.action === 'open').length;
        const clicks = evs.filter(e => e.action === 'click').length;
        // SENT/DEL already set in Wave 1; add the open/click side when present.
        if (evs.length) {
          d[`${p}_OPEN`]    = n(opens);
          d[`${p}_OPENPCT`] = pctOf(opens, 1);      // 1 dispatch record; audience size unknown here
          d[`${p}_CLICK`]   = n(clicks);
          d[`${p}_CTR`]     = pctOf(clicks, opens || evs.length);
        } else {
          // Explicit, report-safe "no engagement recorded" rather than a blank.
          d[`${p}_OPEN`] = '0'; d[`${p}_OPENPCT`] = '0.0%'; d[`${p}_CLICK`] = '0'; d[`${p}_CTR`] = '0.0%';
        }
      });
    } catch (_) { /* NT open/click stay '—' */ }

    // ── ADG: ads by gender (requires per-impression gender; ad_impressions docs) ──
    try {
      const impSnap = await db.collection('ad_impressions').limit(10000).get();
      const imps = impSnap.docs.map(x => x.data() || {}).filter(e => {
        if (scope && scope !== 'All India' && String(e.state || '') !== scope) return false;
        if (month && /^\d{4}-\d{2}$/.test(month)) {
          const t = e.created_at && e.created_at.toDate ? e.created_at.toDate().toISOString() : '';
          if (!t.startsWith(month)) return false;
        }
        return true;
      });
      if (imps.length) {
        const bucket = (g) => imps.filter(e => String(e.gender || '').toLowerCase() === g);
        const all = imps;
        const setADG = (sfx, arr) => {
          if (!arr.length) return;
          const clk = arr.filter(e => e.clicked === true).length;
          d[`ADG_${sfx}_IMP`] = n(arr.length);
          d[`ADG_${sfx}_CTR`] = pctOf(clk, arr.length);
        };
        setADG('ALL', all); setADG('MALE', bucket('male')); setADG('FEM', bucket('female'));
      }
    } catch (_) { /* ADG stay '—' */ }

    // ── BOUNCE: single-screen sessions that exit fast (needs screen_views) ──
    try {
      const svSnap = await db.collectionGroup('screen_views').orderBy('batch_flushed_at', 'desc').limit(5000).get();
      const sv = [];
      svSnap.docs.forEach(doc => {
        const w = doc.data() || {};
        const arr = Array.isArray(w.batched_events) ? w.batched_events : [w];
        arr.forEach(e => { if (inScope(e)) sv.push(e); });
      });
      if (sv.length) {
        // bounce = a screen_view with very short dwell (<5s) and rage/exit flag,
        // counted per student-session proxy (student_id + screen).
        const bounces = sv.filter(e => (num(e.duration_seconds) < 5) || e.exited_rage_tap === true).length;
        d.BOUNCE_COUNT = n(bounces);
        d.BOUNCE_PCT   = pctOf(bounces, sv.length);
        d.BOUNCE_RATE  = pctOf(bounces, sv.length);
      }
    } catch (_) { /* bounce stays '—' */ }

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
        (_, key) => Object.prototype.hasOwnProperty.call(data, key) ? String(data[key]) : 'No data this period'
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