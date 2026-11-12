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
         tierRows, netRows, langRows, featRows, devRows, distRows, modRows, qbRows,
         renderRows, devTierRows, notifRows, bounceRows] = await Promise.all([
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
         SUM(IF(${SESS_END},duration_seconds,0))/NULLIF(COUNTIF(${SESS_END}),0)/60 avg_min,
         COUNTIF(${QUIZ}) q_att, SUM(IF(${QUIZ},score_pct,0)) q_sum,
         COUNTIF(${AR_END}) ar_n, COUNTIF(${AR_END} AND completed=true) ar_done
       FROM ${FQ_TABLE} WHERE gender IS NOT NULL GROUP BY state,k`),
    q(`SELECT COALESCE(state,'Unknown') state, COALESCE(mobile_ownership,'Unknown') k,
         COUNT(DISTINCT student_id) students, COUNT(*) sessions,
         SUM(IF(${SESS_END},duration_seconds,0))/NULLIF(COUNTIF(${SESS_END}),0)/60 avg_min,
         COUNTIF(${QUIZ}) q_att, SUM(IF(${QUIZ},score_pct,0)) q_sum,
         COUNTIF(${AR_END}) ar_n, COUNTIF(${AR_END} AND completed=true) ar_done
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
         COUNTIF(accessibility_feature='haptics' AND accessibility_enabled=true) haptics,
         COUNTIF(accessibility_feature='colorblind' AND accessibility_enabled=true) cblind,
         COUNTIF(accessibility_feature='contrast' AND accessibility_enabled=true) contrast,
         COUNTIF(accessibility_feature='large_text' AND accessibility_enabled=true) lgtxt,
         COUNTIF(accessibility_feature='screen_reader' AND accessibility_enabled=true) screen_rdr
       FROM ${FQ_TABLE} GROUP BY state`),
    q(`SELECT COALESCE(state,'Unknown') state,
         COUNT(DISTINCT device_id) devices,
         COUNT(DISTINCT IF(ar_capable=true,device_id,NULL)) ar_capable,
         COUNTIF(event_collection='device_events' AND event_type='crash') crashes,
         AVG(IF(event_collection='device_events' AND event_type='cold_start',cold_start_ms,NULL))/1000 cold_s,
         COUNTIF(event_collection='device_events' AND event_type='anr') anr,
         AVG(IF(${AR_END},battery_drain_pct,NULL)) batt,
         COUNTIF(exited_rage_tap=true) rage
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
    // render-mode breakdown (MARKER/MARKLESS/BASIC3D/INT3D) — from ar_end render_mode
    q(`SELECT COALESCE(state,'Unknown') state, COALESCE(render_mode,'unknown') k,
         COUNT(*) sess, COUNTIF(completed=true) comp, SUM(duration_seconds) secs
       FROM ${FQ_TABLE} WHERE ${AR_END} AND render_mode IS NOT NULL GROUP BY state,k`),
    // device-tier performance (high/medium/low)
    q(`SELECT COALESCE(state,'Unknown') state, COALESCE(device_tier,'unknown') k,
         COUNTIF(${SESS_END}) sess, SUM(IF(${SESS_END},duration_seconds,0)) secs,
         COUNTIF(${AR_END}) ar_n, COUNTIF(${AR_END} AND completed=true) ar_done
       FROM ${FQ_TABLE} WHERE device_tier IS NOT NULL GROUP BY state,k`),
    // notification opens/clicks by campaign_id (per-campaign NT rows) + aggregate
    q(`SELECT COALESCE(state,'Unknown') state, COALESCE(campaign_id,'none') cid,
         COUNTIF(event_collection='notification_events' AND notification_action='open') opens,
         COUNTIF(event_collection='notification_events' AND notification_action='click') clicks,
         COUNTIF(event_collection='notification_events') total
       FROM ${FQ_TABLE} WHERE event_collection='notification_events' GROUP BY state,cid`),
    // bounce: screen_views with very short dwell
    q(`SELECT COALESCE(state,'Unknown') state,
         COUNTIF(event_collection='screen_views') sv_total,
         COUNTIF(event_collection='screen_views' AND duration_seconds<5) bounces
       FROM ${FQ_TABLE} WHERE event_collection='screen_views' GROUP BY state`),
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

    // ── Derive new-dimension maps for THIS scope (feeds the PPT token map) ──
    const _fs = (rows) => (rows || []).filter(r => r.state === scope || scope === 'All India');
    const renderD = {};
    const _RM = { marker:'MARKER', markerless:'MARKLESS', basic3d:'BASIC3D', interactive3d:'INT3D' };
    _fs(renderRows).forEach(r => { const k=_RM[String(r.k)]; if(!k) return;
      (renderD[k] ||= {sess:0,comp:0,secs:0}); renderD[k].sess+=Number(r.sess)||0; renderD[k].comp+=Number(r.comp)||0; renderD[k].secs+=Number(r.secs)||0; });
    const devTierD = {};
    const _DT = { high:'DEV_HIGH', medium:'DEV_MID', low:'DEV_LOW' };
    _fs(devTierRows).forEach(r => { const k=_DT[String(r.k).toLowerCase()]; if(!k) return;
      (devTierD[k] ||= {sess:0,secs:0,ar_n:0,ar_done:0}); devTierD[k].sess+=Number(r.sess)||0; devTierD[k].secs+=Number(r.secs)||0; devTierD[k].ar_n+=Number(r.ar_n)||0; devTierD[k].ar_done+=Number(r.ar_done)||0; });
    const _nf = _fs(notifRows);
    const notifAgg = { opens:sum(_nf,'opens'), clicks:sum(_nf,'clicks'), total:sum(_nf,'total'), sent:0, delivered:0 };
    const notifByCamp = _nf.filter(r=>r.cid && r.cid!=='none')
      .map(r=>({ sent:1, delivered:1, opens:Number(r.opens)||0, clicks:Number(r.clicks)||0 }))
      .sort((a,b)=>b.opens-a.opens);
    const _bo = _fs(bounceRows);
    const bounce = { total:sum(_bo,'sv_total'), bounces:sum(_bo,'bounces') };


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
      notifications: (() => {
        const L = NOTIF_LEDGER[scope] || {}; const nd = notifAgg || {};
        const sent = L.sent || 0, deliv = L.delivered || 0;
        return {
          tiles: [[inIN(sent),'Sent',0],[inIN(deliv),'Delivered',2],[inIN(nd.opens||0),'Opened',1],[pct(nd.opens||0, deliv||nd.total||1)+'%','Open Rate',3]],
          insight: sent ? `${inIN(sent)} notifications sent, ${pct(deliv,sent)}% delivered; ${pct(nd.opens||0,deliv||nd.total||1)}% opened.` : 'No notification campaigns in this period.',
          campaigns: (notifByCamp || []).slice(0, 50).map((c,i) => [i+1, 'Push', '—', c.sent||1, c.delivered||1, c.opens||0, c.clicks||0, nd.optOut||0]),
        };
      })(),
      feedback: (() => {
        const F = FEEDBACK_DATA[scope] || null;
        if (!F) return { tiles: [], insight: 'No feedback in this period.', kpis: [] };
        return {
          tiles: [[F.avgRating!=null?r1(F.avgRating):'—','Avg Rating',0],[String(F.nps||0),'NPS',2],[inIN(F.total||0),'Responses',1],[inIN(F.loved||0),'Loved It',3]],
          insight: F.total ? `${inIN(F.total)} ratings, avg ${r1(F.avgRating||0)}/5; NPS ${F.nps||0}.` : 'Feedback summary.',
          kpis: [K('Avg Rating (1–5)', F.avgRating!=null?r1(F.avgRating):0, 'num','≥ 4'), K('NPS Score', F.nps||0, 'int','≥ 30'),
                 K('Total Responses', F.total||0, 'int'), K('Promoters %', pct(F.npsPromo||0, F.npsN||1), 'pct'),
                 K('Detractors %', pct(F.npsDetract||0, F.npsN||1), 'pct'),
                 K('Found Boring', F.boring||0, 'int'), K('Found Confusing', F.confusing||0, 'int')],
        };
      })(),
      advertising: (() => {
        const A = ADS_BY_GENDER[scope] || null;
        if (!A || !A.all) return { tiles: [], insight: 'No advertising in this period.', campaigns: [] };
        const imp = A.all.imp||0, clk = A.all.clk||0;
        const fmtRows = Object.entries(A.byFmt || {}).map(([f,v],i) =>
          [i+1, f, ({BAN:'Banner',INT:'Interstitial',NAT:'Native',SPO:'Sponsored',VID:'Video'})[f]||f, v.imp||0, v.reach||v.imp||0, v.clk||0, v.imp?r1((v.clk/v.imp)*100):0, '', '', 'OK']);
        return {
          tiles: [[inIN(imp),'Impressions',0],[inIN(A.all.reach||imp),'Reach',2],[inIN(clk),'Clicks',1],[(imp?r1((clk/imp)*100):0)+'%','CTR',3]],
          insight: imp ? `${inIN(imp)} impressions, ${imp?r1((clk/imp)*100):0}% CTR across ${fmtRows.length} formats.` : 'Advertising summary.',
          campaigns: fmtRows,
        };
      })(),
      districts: { tiles: [[inIN(districts),'Districts',0],[inIN(schools),'Schools',2],[String(aspirationalCount),'Aspirational',1],[avgDistComp+'%','Avg Completion',3]],
        insight: topDist ? `${topDist[2]} leads on reach (${inIN(topDist[5])} users); aspirational districts shaded.` : 'District drilldown.', rows: dRows },
    };
    // Flat token map for the government PPT (402 tokens), from the same results.
    scopes[scope].ppt_tokens = buildTokenMap({
      scope, monthLabel: _monthLabel(), students, arS, qa, sessN, avgSessMin, arComp, offPct,
      avgQ, qComp, schools, districts, arN, arDone, qDone, coldAvg, crashes, allN,
      devices_total, ar_cap, genderRowsD: demo(genderT), ownerRowsD: demo(ownerT), subject,
      dRows, modules, bank, usage, features, network, renderD, devTierD,
      notifAgg: Object.assign(notifAgg, NOTIF_LEDGER[scope] || {}), notifByCamp,
      adg: ADS_BY_GENDER[scope] || null, bounce,
      accX: { cblind: pct(sum(fr,'cblind'),fAll), contrast: pct(sum(fr,'contrast'),fAll), lgtxt: pct(sum(fr,'lgtxt'),fAll), screen_rdr: pct(sum(fr,'screen_rdr'),fAll) },
      devX: { anr: pct(sum(dv,'anr'),allN), batt: (()=>{const v=dv.map(x=>Number(x.batt)).filter(x=>!isNaN(x));return v.length?r1(v.reduce((a,b)=>a+b,0)/v.length):null;})(), rage: sum(dv,'rage') },
      feedback: FEEDBACK_DATA[scope] || null,
      bands: distribution, netUsage: network, totalDevices: devices_total,
      subjRaw: tableFrom(subjT, null, (k,rs)=>({ key:k, att:sum(rs,'attempts'), correct:sum(rs,'completed'), n:sum(rs,'n') })),
      genderQuiz: tableFrom(genderT, null, (k,rs)=>({ key:k, att:sum(rs,'q_att'), score:sum(rs,'q_sum'), arN:sum(rs,'ar_n'), arDone:sum(rs,'ar_done') })),
      ownerQuiz: tableFrom(ownerT, null, (k,rs)=>({ key:k, att:sum(rs,'q_att'), score:sum(rs,'q_sum'), arN:sum(rs,'ar_n'), arDone:sum(rs,'ar_done') })),
    });
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
let NOTIF_LEDGER = {}, ADS_BY_GENDER = {}, FEEDBACK_DATA = {};
function setJoins({ status, bloom, board, qcount, curriculum, aspirational, notifLedger, adsByGender }) {
  STATUS = status || {}; BLOOM = bloom || {}; BOARD = board || {}; QCOUNT = qcount || {};
  CURRICULUM = curriculum || []; ASPIRATIONAL = new Set((aspirational || []).map(s => String(s).toLowerCase()));
  NOTIF_LEDGER = notifLedger || {}; ADS_BY_GENDER = adsByGender || {}; FEEDBACK_DATA = (arguments[0] && arguments[0].feedbackData) || {};
}

function _monthLabel() { try { return new Date().toLocaleString('en-US',{month:'long',year:'numeric'}); } catch(_){ return ''; } }

// ════════════════════════════════════════════════════════════════════════════
// buildTokenMap — translate one scope's computed report data into the flat
// {TOKEN: "value"} map the government PPT template needs (402 tokens). Reads the
// BigQuery results already computed in buildAllScopes (no extra queries). Any
// token with no data is OMITTED (the PPT fill then shows 'No data this period').
// ════════════════════════════════════════════════════════════════════════════
const PCT = (num, den) => den > 0 ? `${((num / den) * 100).toFixed(1)}%` : null;
const INT = (v) => (v === null || v === undefined || Number.isNaN(Number(v))) ? null : Number(v).toLocaleString('en-IN');
const F1  = (v) => (v === null || v === undefined || Number.isNaN(Number(v))) ? null : Number(v).toFixed(1);

function buildTokenMap(ctx) {
  // ctx carries every scalar + array computed for this scope (passed from the loop)
  const {
    scope, monthLabel, students, arS, qa, sessN, avgSessMin, arComp, offPct,
    avgQ, qComp, schools, districts, arN, arDone, qDone, coldAvg, crashes, allN,
    devices_total, ar_cap, genderRowsD, ownerRowsD, subject, dRows, modules,
    bank, usage, features, network, renderD, devTierD, notifAgg, notifByCamp,
    adg, bounce,
  } = ctx;
  const t = {};
  const put = (k, v) => { if (v !== null && v !== undefined && v !== '') t[k] = String(v); };

  // ── Labels / overview ──
  put('REPORT_MONTH', monthLabel); put('SELECTED_SCOPE', scope);
  put('SELECTED_GENDER', 'All'); put('SELECTED_OWNER', 'Ministry of Education');
  put('TOTAL_SESSIONS', INT(sessN)); put('TOTAL_STUDENTS', INT(students));
  put('SCHOOLS_ACTIVE', INT(schools)); put('DISTRICTS', INT(districts));
  put('AVG_SESSION_MIN', F1(avgSessMin)); put('OFFLINE_PCT', PCT(offPct, 100));
  put('DROPOFF_PCT', PCT(arN - arDone, arN));
  put('TOTAL_QUIZ', INT(qa)); put('AVG_QUIZ_SCORE', `${F1(avgQ)}%`);
  put('QUIZ_COMP_PCT', PCT(qDone, qa)); put('QUIZ_ABANDONED', INT(qa - qDone));
  put('AR_COMPLETION', PCT(arDone, arN));
  put('AR_CAPABLE_PCT', PCT(ar_cap, devices_total));
  put('CRASH_RATE', PCT(crashes, allN)); put('COLD_START', coldAvg != null ? `${F1(coldAvg)}s` : null);

  // ── Gender splits (demo rows: [i,key,students,pctStr,sessions,avgMin]) ──
  const gmap = { male: 'MALE', female: 'FEMALE', other: 'OTHER' };
  (genderRowsD || []).forEach(r => {
    const k = gmap[String(r[1]).toLowerCase()]; if (!k) return;
    put(`${k}_STUDENTS`, INT(r[2])); put(`${k}_SESSIONS`, INT(r[4])); put(`${k}_AVG_MIN`, F1(r[5]));
  });

  // ── Mobile-owner rollup (owner rows: same shape) ──
  const omap = { father: 'FAT', mother: 'MTH', self: 'SEL', other: 'OTH' };
  (ownerRowsD || []).forEach(r => {
    const k = omap[String(r[1]).toLowerCase()]; if (!k) return;
    put(`${k}_STUD`, INT(r[2])); put(`${k}_SESS`, INT(r[4]));
  });

  // ── Subject (rows: [i,name,attempts,scoreAvg,completed,compPct]) ──
  const smap = { biology: 'BIO', chemistry: 'CHE', physics: 'PHY', mathematics: 'MATH',
                 math: 'MATH', geography: 'GEO', history: 'HIST',
                 'social science': 'SS', social: 'SS', science: 'SCI' };
  const subjKey = (name) => {
    const x = String(name || '').toLowerCase();
    for (const [w, k] of Object.entries(smap)) if (x.includes(w)) return k;
    return null;
  };
  (subject || []).forEach(r => {
    const k = subjKey(r[1]); if (!k) return;
    put(`Q${k}_ATT`, INT(r[2])); put(`Q${k}_SCORE`, `${F1(r[3])}%`);
    put(`Q${k}_COMP`, PCT(r[4], r[2])); put(`${k}_ATTEMPTS`, INT(r[2])); put(`${k}_SCORE`, `${F1(r[3])}%`);
  });

  // ── AR modules M01..M10 (rows: [i,class,subject,module,tier,status,launches,uniq,dwell,compPct,replayPct,pre,post]) ──
  (modules || []).slice(0, 10).forEach((r, i) => {
    const p = `M${String(i + 1).padStart(2, '0')}`;
    put(`${p}_LAUNCHES`, INT(r[6])); put(`${p}_UNIQUE`, INT(r[7]));
    put(`${p}_DWELL`, F1(r[8])); put(`${p}_COMP`, `${r[9]}%`);
    put(`${p}_LIFT`, F1((Number(r[12]) || 0) - (Number(r[11]) || 0)));
  });

  // ── District table D01..D10 (rows: [i,state,district,area,asp,users,quizAtt,quizScore,arSess,arCompPct,schools]) ──
  (dRows || []).slice(0, 10).forEach((r, i) => {
    const p = `D${String(i + 1).padStart(2, '0')}`;
    put(`${p}_SESS`, INT(r[8])); put(`${p}_USERS`, INT(r[5])); put(`${p}_SCHOOLS`, INT(r[10]));
    put(`${p}_ARCOMP`, `${r[9]}%`); put(`${p}_QUIZ`, INT(r[6])); put(`${p}_QUIZSCORE`, `${r[7]}%`);
    put(`${p}_RISK`, r[4] === 'Yes' ? 'Aspirational' : 'Standard');
  });

  // ── QZ01-06 top quizzes (bank rows: [i,class,subject,title,bloom,board,qcount,attempts,scoreAvg,completions,abandoned]) ──
  (bank || []).slice(0, 6).forEach((r, i) => {
    const p = `QZ${String(i + 1).padStart(2, '0')}`;
    put(`${p}_ATT`, INT(r[7])); put(`${p}_SCORE`, `${r[8]}%`);
  });

  // ── Language (usage rows: [i,name,sessions,pctStr,'','']) ──
  const lmap = { english: 'ENGLISH', hindi: 'HINDI' };
  let regionSess = 0, regionShown = false;
  (usage || []).forEach(r => {
    const x = String(r[1]).toLowerCase();
    const k = x.includes('eng') ? 'ENGLISH' : x.includes('hin') ? 'HINDI' : 'REGION';
    if (k === 'REGION') { regionSess += Number(r[2]) || 0; regionShown = true; }
    else { put(`LANG_${k}_SESSIONS`, INT(r[2])); put(`LANG_${k}_PCT`, `${r[3]}%`); }
  });
  if (regionShown) { put('LANG_REGION_SESSIONS', INT(regionSess)); put('LANG_REGION_PCT', PCT(regionSess, sessN)); }

  // ── Accessibility (features: [{label,value,unit}]) — map by label keyword ──
  (features || []).forEach(f => {
    const L = String(f.label || '').toLowerCase(); const v = `${f.value}%`;
    if (L.includes('tts')) put('ACC_TTS', v);
    else if (L.includes('subtitle')) put('ACC_SUB', v);
    else if (L.includes('fallback')) put('ACC_2DFALLBACK', v);
    else if (L.includes('haptic')) put('ACC_HAPTIC', v);
  });

  // ── Device-tier perf (devTierD: {HIGH:{sess,secs,ar_n,ar_done}, MID:.., LOW:..}) ──
  const totTierSess = Object.values(devTierD || {}).reduce((s, v) => s + (v.sess || 0), 0);
  Object.entries(devTierD || {}).forEach(([k, v]) => {
    put(`${k}_PCT`, PCT(v.sess, totTierSess));
    put(`${k}_AVG_MIN`, v.sess ? F1(v.secs / v.sess / 60) : null);
    put(`${k}_COMP`, PCT(v.ar_done, v.ar_n));
  });

  // ── Render-mode (renderD: {MARKER:{sess,comp,secs}, ...}) ──
  const totRender = Object.values(renderD || {}).reduce((s, v) => s + (v.sess || 0), 0);
  Object.entries(renderD || {}).forEach(([k, v]) => {
    put(`${k}_SESSIONS`, INT(v.sess)); put(`${k}_COMP`, PCT(v.comp, v.sess));
    put(`${k}_PCT`, PCT(v.sess, totRender)); put(`${k}_AVG_MIN`, v.sess ? F1(v.secs / v.sess / 60) : null);
  });

  // ── Notifications: aggregate (notifAgg: {opens,clicks,total,sent,delivered}) ──
  if (notifAgg) {
    put('NOTIF_OPENED', INT(notifAgg.opens)); put('PUSH_OPEN', INT(notifAgg.opens));
    put('NOTIF_SENT', INT(notifAgg.sent)); put('NOTIF_DELIVERED', INT(notifAgg.delivered));
    put('NOTIF_DELIVERY_PCT', PCT(notifAgg.delivered, notifAgg.sent));
    put('PUSH_DELIVERY', PCT(notifAgg.delivered, notifAgg.sent));
    put('NOTIF_OPEN_PCT', PCT(notifAgg.opens, notifAgg.delivered || notifAgg.total));
    put('NOTIF_CTR', PCT(notifAgg.clicks, notifAgg.opens || notifAgg.total));
    put('NG_ALL_SENT', INT(notifAgg.sent)); put('NG_ALL_OPENPCT', PCT(notifAgg.opens, notifAgg.delivered || notifAgg.total));
    put('NG_ALL_CTR', PCT(notifAgg.clicks, notifAgg.opens || notifAgg.total));
  }
  // ── Per-campaign NT1-4 (notifByCamp: [{sent,delivered,opens,clicks}]) ──
  (notifByCamp || []).slice(0, 4).forEach((c, i) => {
    const p = `NT${i + 1}`;
    put(`${p}_SENT`, INT(c.sent)); put(`${p}_DEL`, INT(c.delivered));
    put(`${p}_DELPCT`, PCT(c.delivered, c.sent)); put(`${p}_OPEN`, INT(c.opens));
    put(`${p}_OPENPCT`, PCT(c.opens, c.delivered || c.sent)); put(`${p}_CLICK`, INT(c.clicks));
    put(`${p}_CTR`, PCT(c.clicks, c.opens || c.sent));
  });

  // ── ADS (adg: {all:{imp,clk}, male:{imp,clk}, fem:{imp,clk}, byFmt:{BAN:{imp,clk,reach},...}}) ──
  if (adg && adg.all) {
    put('AD_IMPRESSIONS', INT(adg.all.imp)); put('AD_CLICKS', INT(adg.all.clk));
    put('AD_CTR', PCT(adg.all.clk, adg.all.imp)); put('AD_REACH', INT(adg.all.reach || adg.all.imp));
    put('ADG_ALL_IMP', INT(adg.all.imp)); put('ADG_ALL_CTR', PCT(adg.all.clk, adg.all.imp));
    if (adg.male) { put('ADG_MALE_IMP', INT(adg.male.imp)); put('ADG_MALE_CTR', PCT(adg.male.clk, adg.male.imp)); }
    if (adg.fem)  { put('ADG_FEM_IMP', INT(adg.fem.imp));  put('ADG_FEM_CTR', PCT(adg.fem.clk, adg.fem.imp)); }
    Object.entries(adg.byFmt || {}).forEach(([f, v]) => {
      put(`CAD_${f}_IMP`, INT(v.imp)); put(`CAD_${f}_CLICK`, INT(v.clk));
      put(`CAD_${f}_CTR`, PCT(v.clk, v.imp)); put(`CAD_${f}_REACH`, INT(v.reach || v.imp));
    });
  }

  // ── Bounce (bounce: {total, bounces}) ──
  if (bounce && bounce.total) {
    put('BOUNCE_COUNT', INT(bounce.bounces)); put('BOUNCE_PCT', PCT(bounce.bounces, bounce.total));
    put('BOUNCE_RATE', PCT(bounce.bounces, bounce.total));
  }

  // ── Extra accessibility (accX: {cblind,contrast,lgtxt,screen_rdr} as pct numbers) ──
  if (ctx.accX) {
    put('ACC_CBLIND', `${ctx.accX.cblind}%`); put('ACC_CONTRAST', `${ctx.accX.contrast}%`);
    put('ACC_LGTXT', `${ctx.accX.lgtxt}%`); put('ACC_SCREEN_RDR', `${ctx.accX.screen_rdr}%`);
  }
  // ── Extra device health (devX: {anr, batt, rage}) ──
  if (ctx.devX) {
    put('ANR_RATE', `${ctx.devX.anr}%`);
    if (ctx.devX.batt != null) put('BATT_DRAIN', `${F1(ctx.devX.batt)}%`);
    if (ctx.devX.rage) put('RAGE_TAPS', INT(ctx.devX.rage));
  }
  // ── Feedback / NPS (feedback: {avgRating, total, loved, boring, confusing, tooEasy, tooFast,
  //    nps, npsPromo, npsDetract, byGender:{MALE/FEM/OTH:{nps,promo,resp,rating}}, byOwner:{FAT/MTH/SEL:{...}} }) ──
  const fb = ctx.feedback;
  if (fb) {
    if (fb.avgRating != null) { put('FB_AVG_RATING', F1(fb.avgRating)); put('AVG_RATING', F1(fb.avgRating)); }
    put('FB_TOTAL', INT(fb.total)); put('FB_LOVED', INT(fb.loved)); put('FB_BORING', INT(fb.boring));
    put('FB_CONFUSING', INT(fb.confusing)); put('FB_TOOEASY', INT(fb.tooEasy)); put('FB_TOOFAST', INT(fb.tooFast));
    if (fb.nps != null) { put('NPS_SCORE', String(fb.nps)); put('NPS_PROMO', PCT(fb.npsPromo, fb.npsN)); put('NPS_DETRACT', PCT(fb.npsDetract, fb.npsN)); }
    Object.entries(fb.byGender || {}).forEach(([k, v]) => {
      put(`GN_${k}_NPS`, String(v.nps)); put(`GN_${k}_PROMO`, PCT(v.promo, v.resp));
      put(`GN_${k}_RESP`, INT(v.resp)); put(`GN_${k}_RATING`, v.rating != null ? F1(v.rating) : null);
    });
    Object.entries(fb.byOwner || {}).forEach(([k, v]) => {
      put(`MN_${k}_NPS`, String(v.nps)); put(`MN_${k}_PROMO`, PCT(v.promo, v.resp));
      put(`MN_${k}_RESP`, INT(v.resp)); put(`MN_${k}_RATING`, v.rating != null ? F1(v.rating) : null);
    });
  }

  // ── Duration bands (distribution rows: [i,label,sessions,pctStr,'','']) ──
  const bandTok = { 'Bounce': ['D_1_5_COUNT','D_1_5_PCT'], '1–5': ['D_1_5_COUNT','D_1_5_PCT'],
                    '5–15': ['D_5_15_COUNT','D_5_15_PCT'], '15–30': ['D_15_30_COUNT','D_15_30_PCT'], '>30': ['D_30_COUNT','D_30_PCT'] };
  (ctx.bands || []).forEach(r => {
    const label = String(r[1] || '');
    for (const [kw, toks] of Object.entries(bandTok)) {
      if (label.includes(kw)) { put(toks[0], INT(r[2])); put(toks[1], `${r[3]}%`); break; }
    }
  });
  // ── Network distribution (netUsage rows) ──
  const netTok = { wifi:'NET_WIFI_PCT','4g':'NET_4G_PCT','5g':'NET_5G_PCT','3g':'NET_3G_PCT','2g':'NET_2G_PCT',offline:'NET_OFFLINE_PCT' };
  (ctx.netUsage || []).forEach(r => {
    const x = String(r[1] || '').toLowerCase();
    for (const [kw, tk] of Object.entries(netTok)) if (x.includes(kw)) { put(tk, `${r[3]}%`); break; }
  });
  put('TOTAL_DEVICES', INT(ctx.totalDevices));
  // ── Subject CORRECT% + QSS (subjRaw: [{key,att,correct,n}]) ──
  (ctx.subjRaw || []).forEach(o => {
    const k = subjKey(o.key); if (!k) return;
    put(`Q${k}_CORRECT`, PCT(o.correct, o.att));
    if (k === 'SS') { put('QSS_ATT', INT(o.att)); put('QSS_COMP', PCT(o.correct, o.n)); put('QSS_SCORE', PCT(o.correct, o.att)); put('QSS_CORRECT', PCT(o.correct, o.att)); }
  });
  // ── Gender × quiz (genderQuiz) ──
  (ctx.genderQuiz || []).forEach(o => {
    const k = gmap[String(o.key).toLowerCase()]; if (!k) return;
    put(`${k}_QUIZ`, INT(o.att)); put(`${k}_SCORE`, o.att ? `${F1((o.score / o.att) * 100)}%` : null);
  });
  // ── Owner × quiz/AR (ownerQuiz) ──
  (ctx.ownerQuiz || []).forEach(o => {
    const k = omap[String(o.key).toLowerCase()]; if (!k) return;
    put(`${k}_QUIZ`, INT(o.att)); put(`${k}_SCORE`, o.att ? `${F1((o.score / o.att) * 100)}%` : null);
    put(`${k}_ARCOMP`, PCT(o.arDone, o.arN));
  });
  // ── NG gender-split notifications + opt-out + lang switches ──
  if (notifAgg && notifAgg.byGender) {
    Object.entries(notifAgg.byGender).forEach(([k, v]) => {
      put(`NG_${k}_SENT`, INT(v.sent)); put(`NG_${k}_OPENPCT`, PCT(v.opens, v.delivered || v.sent)); put(`NG_${k}_CTR`, PCT(v.clicks, v.opens || v.sent));
    });
  }
  if (notifAgg && notifAgg.optOut != null) put('NOTIF_OPT_OUT', INT(notifAgg.optOut));
  if (ctx.langSwitches != null) put('LANG_SWITCHES', INT(ctx.langSwitches));

  return t;
}

module.exports = { buildAllScopes, setJoins };