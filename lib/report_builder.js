'use strict';
// ════════════════════════════════════════════════════════════════════════════
// lib/report_builder.js — builds per-scope report DATA for the summary engine.
//
// Called by /refresh ONLY. Runs grouped-by-state BigQuery aggregates (one pass
// each), reads the dashboard content collections from Firestore for the joins,
// then assembles one `data` object per scope (All India + each state) in the
// exact shape lib/summary_report.js consumes. Defensive throughout: any missing
// piece degrades to empty, never throws.
//
// Output: { generated, scopes: { '<scope>': <dataObj>, ... } }
// Each scope doc is stored separately by /refresh (Firestore 1 MiB per doc).
// ════════════════════════════════════════════════════════════════════════════
const { runQuery, FQ_TABLE } = require('./bq');

const AR_END = `event_collection='ar_views' AND event_type='ar_end'`;
const SESS_END = `event_collection='sessions' AND event_type='session_end'`;
const QUIZ = `event_collection='quiz_attempts' AND event_type='quiz_submit'`;

const K = (label, value, unit, target = null) => ({ label, value, unit, target });
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);
const r1 = (x) => Math.round(x * 10) / 10;
const grp = (rows, key) => { const m = {}; for (const r of rows) (m[r[key] || 'Unknown'] ||= []).push(r); return m; };
const sum = (rows, f) => rows.reduce((a, b) => a + (Number(b[f]) || 0), 0);

async function q(sql) { try { return await runQuery(sql); } catch (_) { return []; } }

async function buildAllScopes() {
  // ── grouped-by-state telemetry aggregates (each is ONE query) ──────────────
  const [reachRows, genderRows, ownerRows, classRows, subjRows, bandRows,
         tierRows, netRows, langRows, featRows, devRows, distRows, modRows, qbRows] = await Promise.all([
    q(`SELECT COALESCE(state,'Unknown') state,
         COUNT(DISTINCT student_id) students,
         COUNTIF(${AR_END}) ar_sessions,
         COUNTIF(${QUIZ}) quiz_attempts,
         SUM(IF(${SESS_END},duration_seconds,0)) sess_secs, COUNTIF(${SESS_END}) sess_n,
         COUNTIF(${AR_END} AND completed=true) ar_done, COUNTIF(${AR_END}) ar_n,
         COUNTIF(offline_session=true) off_n, COUNT(*) all_n,
         SUM(IF(${QUIZ},score_pct,0)) qscore_sum,
         COUNTIF(${QUIZ} AND completed=true) q_done,
         COUNT(DISTINCT school_code) schools, COUNT(DISTINCT district) districts
       FROM ${FQ_TABLE} GROUP BY state`),
    q(`SELECT COALESCE(state,'Unknown') state, COALESCE(gender,'Unknown') k,
         COUNT(DISTINCT student_id) students, COUNT(*) sessions,
         SUM(IF(${SESS_END},duration_seconds,0))/NULLIF(COUNTIF(${SESS_END}),0)/60 avg_min
       FROM ${FQ_TABLE} WHERE gender IS NOT NULL GROUP BY state,k`),
    q(`SELECT COALESCE(state,'Unknown') state, COALESCE(mobile_ownership,'Unknown') k,
         COUNT(DISTINCT student_id) students, COUNT(*) sessions,
         SUM(IF(${SESS_END},duration_seconds,0))/NULLIF(COUNTIF(${SESS_END}),0)/60 avg_min
       FROM ${FQ_TABLE} WHERE mobile_ownership IS NOT NULL GROUP BY state,k`),
    q(`SELECT COALESCE(state,'Unknown') state, COALESCE(class_grade,'Unknown') k,
         COUNT(DISTINCT student_id) students, COUNTIF(${AR_END}) sessions,
         SUM(IF(${SESS_END},duration_seconds,0))/NULLIF(COUNTIF(${SESS_END}),0)/60 avg_min,
         COUNTIF(${AR_END} AND completed=true) done, COUNTIF(${AR_END}) n
       FROM ${FQ_TABLE} GROUP BY state,k`),
    q(`SELECT COALESCE(state,'Unknown') state, COALESCE(subject,'Unknown') k,
         COUNTIF(${QUIZ}) attempts, SUM(IF(${QUIZ},score_pct,0)) score_sum,
         COUNTIF(${QUIZ} AND completed=true) completed, COUNTIF(${QUIZ}) n
       FROM ${FQ_TABLE} WHERE subject IS NOT NULL GROUP BY state,k`),
    q(`SELECT COALESCE(state,'Unknown') state,
         CASE WHEN duration_seconds<60 THEN '1 Bounce (<1 min)'
              WHEN duration_seconds<300 THEN '2 1–5 min'
              WHEN duration_seconds<900 THEN '3 5–15 min'
              WHEN duration_seconds<1800 THEN '4 15–30 min'
              ELSE '5 >30 min' END k, COUNT(*) sessions
       FROM ${FQ_TABLE} WHERE ${SESS_END} GROUP BY state,k`),
    q(`SELECT COALESCE(state,'Unknown') state, COALESCE(ar_tier,'Unknown') k,
         COUNTIF(${AR_END}) sessions,
         SUM(IF(${AR_END},duration_seconds,0))/NULLIF(COUNTIF(${AR_END}),0)/60 avg_min,
         COUNTIF(${AR_END} AND completed=true) done, COUNTIF(${AR_END}) n
       FROM ${FQ_TABLE} GROUP BY state,k`),
    q(`SELECT COALESCE(state,'Unknown') state, COALESCE(connectivity_type,'Unknown') k, COUNT(*) sessions
       FROM ${FQ_TABLE} WHERE ${SESS_END} GROUP BY state,k`),
    q(`SELECT COALESCE(state,'Unknown') state, COALESCE(language,'Unknown') k, COUNT(*) sessions
       FROM ${FQ_TABLE} WHERE ${SESS_END} GROUP BY state,k`),
    q(`SELECT COALESCE(state,'Unknown') state,
         COUNTIF(accessibility_feature='tts' AND accessibility_enabled=true) tts, COUNT(*) all_n,
         COUNTIF(accessibility_feature='subtitles' AND accessibility_enabled=true) subs,
         COUNTIF(accommodation_type='2D_Fallback') fallback,
         COUNTIF(accessibility_feature='haptics' AND accessibility_enabled=true) haptics
       FROM ${FQ_TABLE} GROUP BY state`),
    q(`SELECT COALESCE(state,'Unknown') state,
         COUNT(DISTINCT device_id) devices,
         COUNT(DISTINCT IF(ar_capable=true,device_id,NULL)) ar_capable,
         COUNTIF(event_collection='device_events' AND event_type='crash') crashes,
         AVG(IF(event_collection='device_events' AND event_type='cold_start',cold_start_ms,NULL))/1000 cold_s
       FROM ${FQ_TABLE} GROUP BY state`),
    q(`SELECT COALESCE(state,'Unknown') state, COALESCE(district,'Unknown') district,
         COALESCE(ANY_VALUE(area_type),'') area,
         COUNT(DISTINCT student_id) users, COUNTIF(${QUIZ}) quiz_attempts,
         SUM(IF(${QUIZ},score_pct,0)) qscore_sum,
         COUNTIF(${AR_END}) ar_sessions, COUNTIF(${AR_END} AND completed=true) ar_done, COUNTIF(${AR_END}) ar_n,
         COUNT(DISTINCT school_code) schools
       FROM ${FQ_TABLE} WHERE state IS NOT NULL GROUP BY state,district`),
    q(`SELECT COALESCE(state,'Unknown') state, COALESCE(module_title,topic_id,'Unknown') module,
         ANY_VALUE(class_grade) class_grade, ANY_VALUE(subject) subject, ANY_VALUE(ar_tier) ar_tier,
         COUNTIF(${AR_END}) launches, COUNT(DISTINCT IF(${AR_END},student_id,NULL)) uniq,
         AVG(IF(${AR_END},duration_seconds,NULL))/60 dwell,
         COUNTIF(${AR_END} AND completed=true) done, COUNTIF(${AR_END}) n,
         COUNTIF(${AR_END} AND is_replay=true) replays,
         AVG(IF(${AR_END},pre_module_score,NULL)) pre, AVG(IF(${AR_END},post_module_score,NULL)) post
       FROM ${FQ_TABLE} WHERE ${AR_END} GROUP BY state,module`),
    q(`SELECT COALESCE(state,'Unknown') state, COALESCE(quiz_title,quiz_id,'Unknown') title,
         ANY_VALUE(class_grade) class_grade, ANY_VALUE(subject) subject,
         COUNTIF(${QUIZ}) attempts, SUM(IF(${QUIZ},score_pct,0)) score_sum,
         COUNTIF(${QUIZ} AND completed=true) completions, COUNTIF(${QUIZ} AND completed=false) abandoned,
         COUNTIF(${QUIZ}) n
       FROM ${FQ_TABLE} WHERE ${QUIZ} GROUP BY state,title`),
  ]);

  // state universe
  const states = [...new Set(reachRows.map(r => r.state).filter(s => s && s !== 'Unknown'))].sort();
  const SCOPES = ['All India', ...states];

  // helper: rows for a scope (All India = all rows; else matching state)
  const forScope = (rows, scope) => scope === 'All India' ? rows : rows.filter(r => r.state === scope);

  const ref = {
    classes: ['Class 6','Class 7','Class 8','Class 9','Class 10','Class 11','Class 12'],
    subjects: ['Science','Mathematics','Social Studies','English','Physics','Chemistry','Biology'],
    boards: ['CBSE','ICSE','State Board'],
    ar_tiers: ['Basic 3D','Interactive 3D','Marker-based AR','Markerless AR','VR-ready'],
    languages: ['Hindi','English','Regional'],
  };

  const scopes = {};
  for (const scope of SCOPES) {
    const R = forScope(reachRows, scope);
    const students = sum(R, 'students'), arS = sum(R, 'ar_sessions'), qa = sum(R, 'quiz_attempts');
    const sessSecs = sum(R, 'sess_secs'), sessN = sum(R, 'sess_n');
    const arDone = sum(R, 'ar_done'), arN = sum(R, 'ar_n');
    const offN = sum(R, 'off_n'), allN = sum(R, 'all_n');
    const qSum = sum(R, 'qscore_sum'), qDone = sum(R, 'q_done');
    const schools = sum(R, 'schools'), districts = sum(R, 'districts');
    const avgSessMin = sessN > 0 ? r1(sessSecs / sessN / 60) : 0;
    const arComp = pct(arDone, arN), offPct = pct(offN, allN);
    const avgQ = qa > 0 ? r1((qSum / qa) * 100) : 0, qComp = pct(qDone, qa);

    const dim = (rows) => grp(forScope(rows, scope), 'k');
    const genderT = dim(genderRows), ownerT = dim(ownerRows), classT = dim(classRows),
          subjT = dim(subjRows), bandT = dim(bandRows), tierT = dim(tierRows),
          netT = dim(netRows), langT = dim(langRows);

    const tableFrom = (map, order, fn) => {
      const keys = order ? order.filter(k => map[k]) : Object.keys(map).sort();
      return keys.map((k, i) => fn(k, map[k], i));
    };
    // gender / owner
    const demo = (map) => tableFrom(map, null, (k, rs, i) => {
      const st = sum(rs, 'students'), se = sum(rs, 'sessions');
      return [i + 1, k, st, pct(st, students), se, r1(Number(rs[0] && rs[0].avg_min) || 0)];
    });
    // class-wise
    const classwise = tableFrom(classT, ref.classes, (k, rs, i) =>
      [i + 1, k, sum(rs, 'students'), sum(rs, 'sessions'), r1(Number(rs[0] && rs[0].avg_min) || 0), pct(sum(rs,'done'), sum(rs,'n'))]);
    // subject
    const subject = tableFrom(subjT, null, (k, rs, i) =>
      [i + 1, k, sum(rs,'attempts'), Math.round((sum(rs,'score_sum')/Math.max(1,sum(rs,'attempts')))*100), sum(rs,'completed'), pct(sum(rs,'completed'), sum(rs,'n'))])
      .sort((a,b)=>b[2]-a[2]).map((row,i)=>[i+1,...row.slice(1)]);
    // distribution
    const distribution = tableFrom(bandT, ['1 Bounce (<1 min)','2 1–5 min','3 5–15 min','4 15–30 min','5 >30 min'], (k, rs, i) => {
      const s = sum(rs,'sessions'); return [i+1, k.replace(/^\d\s/,''), s, pct(s, sum(forScope(bandRows,scope),'sessions')), '', ''];
    });
    // ar tier
    const ar_tier = tableFrom(tierT, ref.ar_tiers, (k, rs, i) =>
      [i+1, k, sum(rs,'sessions'), pct(sum(rs,'sessions'), arN), r1(Number(rs[0]&&rs[0].avg_min)||0), pct(sum(rs,'done'), sum(rs,'n'))]);
    // network
    const netTotal = sum(forScope(netRows, scope), 'sessions');
    const network = tableFrom(netT, null, (k, rs, i) => [i+1, k, sum(rs,'sessions'), pct(sum(rs,'sessions'), netTotal), '', '']);
    // language
    const langTotal = sum(forScope(langRows, scope), 'sessions');
    const usage = tableFrom(langT, null, (k, rs, i) => [i+1, k, sum(rs,'sessions'), pct(sum(rs,'sessions'), langTotal), '', '']);
    // accessibility features
    const fr = forScope(featRows, scope); const fAll = sum(fr,'all_n');
    const features = [
      K('TTS Used %', pct(sum(fr,'tts'), fAll), 'pct'),
      K('Subtitles Used %', pct(sum(fr,'subs'), fAll), 'pct'),
      K('2D Fallback Sessions %', pct(sum(fr,'fallback'), fAll), 'pct', '< 15%'),
      K('Haptic Feedback %', pct(sum(fr,'haptics'), fAll), 'pct'),
    ];
    // devices
    const dv = forScope(devRows, scope);
    const devices_total = sum(dv,'devices'), ar_cap = sum(dv,'ar_capable'), crashes = sum(dv,'crashes');
    const coldVals = dv.map(x=>Number(x.cold_s)).filter(x=>!isNaN(x));
    const coldAvg = coldVals.length ? r1(coldVals.reduce((a,b)=>a+b,0)/coldVals.length) : 0;
    const overview = [
      K('Total Devices', devices_total, 'int'), K('AR-Capable Devices', ar_cap, 'int'),
      K('AR-Capable %', pct(ar_cap, devices_total), 'pct', '≥ 70%'),
      K('Crash Rate %', pct(crashes, allN), 'pct', '< 1%'),
      K('Avg Cold Start (sec)', coldAvg, 'num', '< 3'),
    ];
    // districts
    const dRows = forScope(distRows, scope)
      .map(x => [0, x.state, x.district, x.area || '', ASPIRATIONAL.has((x.district||'').toLowerCase()) ? 'Yes' : 'No',
                 Number(x.users)||0, Number(x.quiz_attempts)||0,
                 x.quiz_attempts>0?Math.round((x.qscore_sum/x.quiz_attempts)*100):0,
                 Number(x.ar_sessions)||0, pct(x.ar_done, x.ar_n), Number(x.schools)||0])
      .sort((a,b)=>b[5]-a[5]).map((row,i)=>[i+1,...row.slice(1)]);
    // modules (join status from ar_assets later via Firestore in /refresh; status '' here)
    const modules = forScope(modRows, scope)
      .map(x => [0, x.class_grade||'', x.subject||'', x.module, x.ar_tier||'', (STATUS[x.module]||'published'),
                 Number(x.launches)||0, Number(x.uniq)||0, r1(Number(x.dwell)||0), pct(x.done,x.n),
                 pct(x.replays,x.n), Math.round(Number(x.pre)||0), Math.round(Number(x.post)||0)])
      .sort((a,b)=>b[7]-a[7]).map((row,i)=>[i+1,...row.slice(1)]);
    // quiz bank
    const bank = forScope(qbRows, scope)
      .map(x => [0, x.class_grade||'', x.subject||'', x.title, (BLOOM[x.title]||''), (BOARD[x.title]||''),
                 (QCOUNT[x.title]||''), Number(x.attempts)||0, Math.round((x.score_sum/Math.max(1,x.attempts))*100),
                 Number(x.completions)||0, Number(x.abandoned)||0])
      .sort((a,b)=>b[7]-a[7]).map((row,i)=>[i+1,...row.slice(1)]);

    const aspirationalCount = dRows.filter(r => r[4] === 'Yes').length;
    const avgDistComp = dRows.length ? r1(dRows.reduce((a,b)=>a+(b[9]||0),0)/dRows.length) : 0;

    // insights (simple, data-driven)
    const topClass = classwise.slice().sort((a,b)=>b[5]-a[5])[0];
    const topDist = dRows[0];

    scopes[scope] = {
      curriculum: CURRICULUM, reference: ref,
      govt_kpi: {
        tiles: [[inIN(students),'Active Students',0],[inIN(arS),'AR Sessions',1],[arComp+'%','AR Completion',2],[avgQ+'%','Avg Quiz Score',3]],
        insight: `Reach of ${inIN(students)} students across ${districts} districts; AR completion ${arComp}% and quiz score ${avgQ}%.`,
        kpis: [K('Total Active Students',students,'int'),K('Total AR Sessions',arS,'int'),K('Total Quiz Attempts',qa,'int'),
               K('Avg Session Duration',avgSessMin,'min','≥ 10'),K('AR Module Completion %',arComp,'pct','≥ 65%'),
               K('Avg Quiz Score %',avgQ,'pct','≥ 60%'),K('Schools Active',schools,'int'),K('Districts Reporting',districts,'int'),K('Offline Session %',offPct,'pct')],
      },
      reach: {
        tiles: [[inIN(students),'Active Students',0],[inIN(arS),'AR Sessions',1],[inIN(schools),'Schools Active',2],[inIN(districts),'Districts',3]],
        insight: topClass ? `Reach spans ${districts} districts and ${schools} schools; ${topClass[1]} is the most engaged cohort at ${topClass[5]}% AR completion.` : 'Reach summary.',
        kpis: [K('Total Active Students',students,'int'),K('AR Module Completion %',arComp,'pct','≥ 65%'),
               K('Session Drop-off % (non-completion)',pct(arN-arDone,arN),'pct','< 20%'),
               K('Short-session % (<2 min)',pct(sum(forScope(bandRows,scope).filter(b=>/Bounce|1–5/.test(b.k)),'sessions'),sessN),'pct'),
               K('Avg Quiz Score %',avgQ,'pct','≥ 60%'),K('Quiz Completion %',qComp,'pct','≥ 80%')],
        gender: demo(genderT), owner: demo(ownerT), classwise,
      },
      learning: {
        tiles: [[avgQ+'%','Avg Quiz Score',0],[qComp+'%','Quiz Completion',2],[arComp+'%','AR Completion',3]],
        insight: subject[0] ? `${subject[0][1]} leads subjects at ${subject[0][3]}% average score.` : 'Learning outcomes summary.',
        kpis: [K('Quiz Attempts Total',qa,'int'),K('Quiz Attempts Completed',qDone,'int'),K('Avg Quiz Score %',avgQ,'pct','≥ 60%'),K('AR Module Completion %',arComp,'pct','≥ 65%')],
        subject,
      },
      sessions: {
        tiles: [[inIN(sessN),'Total Sessions',0],[avgSessMin+' min','Avg Duration',2],[offPct+'%','Offline',3]],
        insight: 'Session behaviour summary for the selected scope.',
        distribution, kpis: [K('Total Sessions',sessN,'int'),K('Avg Session Duration',avgSessMin,'min','≥ 10'),
          K('Offline Sessions %',offPct,'pct'),K('Completion Rate %',arComp,'pct','≥ 65%')], ar_tier,
      },
      devices: { tiles: [[inIN(devices_total),'Total Devices',0],[pct(ar_cap,devices_total)+'%','AR-Capable',2],[pct(crashes,allN)+'%','Crash Rate',1],[coldAvg+' s','Cold Start',3]],
        insight: 'Device health & connectivity summary.', overview, network },
      language: { tiles: usage[0] ? [[usage[0][3]+'%',usage[0][1]+' Sessions',0]] : [],
        insight: 'Language & accessibility summary.', usage, features },
      curriculum_ar: { tiles: [[String(modules.length),'AR Modules',0],[arComp+'%','Avg Completion',2]],
        insight: modules[0] ? `'${modules[0][3]}' is the top module by launches.` : 'AR content summary.', modules },
      quiz: { tiles: [[inIN(qa),'Quiz Attempts',0],[avgQ+'%','Avg Score',2],[qComp+'%','Completion',1]],
        insight: 'Quiz performance summary.', kpis: [K('Total Quiz Attempts',qa,'int'),K('Avg Score %',avgQ,'pct','≥ 60%'),K('Completion %',qComp,'pct','≥ 80%')], bank },
      notifications: { tiles: [], insight: 'Notification performance (from dashboard campaigns).', campaigns: [] },
      feedback: { tiles: [], insight: 'Feedback & NPS summary (from app feedback).', kpis: [] },
      advertising: { tiles: [], insight: 'Advertising performance (from dashboard campaigns).', campaigns: [] },
      districts: { tiles: [[inIN(districts),'Districts',0],[inIN(schools),'Schools',2],[String(aspirationalCount),'Aspirational',1],[avgDistComp+'%','Avg Completion',3]],
        insight: topDist ? `${topDist[2]} leads on reach (${inIN(topDist[5])} users); aspirational districts shaded.` : 'District drilldown.', rows: dRows },
    };
  }

  return { generated: new Date().toISOString(), scopes };
}

// Indian grouping (string, for tile labels)
function inIN(n) {
  n = Math.round(Number(n) || 0); const neg = n < 0; let s = String(Math.abs(n));
  let last3 = s.slice(-3), rest = s.slice(0, -3);
  if (rest) last3 = ',' + last3;
  rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return (neg ? '-' : '') + rest + last3;
}

// Firestore-join maps (populated by /refresh before calling, left empty otherwise)
let STATUS = {}, BLOOM = {}, BOARD = {}, QCOUNT = {}, CURRICULUM = [], ASPIRATIONAL = new Set();
function setJoins({ status, bloom, board, qcount, curriculum, aspirational }) {
  STATUS = status || {}; BLOOM = bloom || {}; BOARD = board || {}; QCOUNT = qcount || {};
  CURRICULUM = curriculum || []; ASPIRATIONAL = new Set((aspirational || []).map(s => String(s).toLowerCase()));
}

module.exports = { buildAllScopes, setJoins };