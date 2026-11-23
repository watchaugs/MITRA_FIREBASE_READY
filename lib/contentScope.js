'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// Content scope — ONE rule for what a student (app caller) in a state gets.
// Used by the curriculum manifest, /ar-topics and the quiz list / pack / get,
// so every route answers the same way. Dashboard (staff) callers are
// unaffected.
//
//   1. The state is OPEN: it has a saved Curriculum Map AND at least one
//      active geofence. A state that isn't set up or is locked gets nothing.
//   2. Content reaches a state only through ITS Curriculum Map:
//        • linked on one of its topics, or
//        • tagged with a class (and for AR lessons, the subject + topic) that
//          the state's map has, and visible there (All India, or targeted to
//          that state).
//      A class or topic the state hasn't created never shows there.
//   3. It is released for that state (release rules: now / date / per state).
//
// The student's state is their REGISTERED state (from their account), not a
// value the app sends, so one state's content can't be asked for from another.
// ═══════════════════════════════════════════════════════════════════════════
const { toCode, toName, sameState, isNational } = require('./states');
const { isReleased } = require('./release');

const nrm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
// "Class 8" / "8" / "class-8" → "8".
const clsKey = (v) => { const s = nrm(v); const m = s.match(/\d+/); return m ? m[0] : s; };
const topicKey = (c, s, t) => `${clsKey(c)}|${nrm(s)}|${nrm(t)}`;

const TTL_MS = 60 * 1000;
const _cache = new Map(); // state code → { at, scope }

/** The state an app caller is scoped to: their registered state, else the one asked for. */
function studentState(req, asked) {
  const own = req && req.user && req.user.state;
  if (own && !isNational(own)) return String(own);
  return String(asked || '').trim();
}

/**
 * Everything needed to decide visibility in one state (cached 60 s).
 * { open, code, name, structure, classKeys, topicKeys, linkedAssets, linkedQuizzes }
 */
async function stateScope(db, state) {
  const asked = String(state || '').trim();
  const code = toCode(asked) || asked;
  const empty = { open: false, code, name: toName(asked) || asked, structure: [], classKeys: new Set(),
    topicKeys: new Set(), subjectKeys: new Set(), linkedAssets: new Set(), linkedQuizzes: new Set() };
  if (!code || isNational(code)) return empty;
  const hit = _cache.get(code);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.scope;

  let structure = [];
  let hasGeofence = false;
  try {
    const [byCode, byAsked, geo] = await Promise.all([
      db.collection('curriculum_hierarchy').doc(code).get(),
      asked && asked !== code ? db.collection('curriculum_hierarchy').doc(asked).get() : Promise.resolve(null),
      db.collection('geofences').where('is_active', '==', true).get(),
    ]);
    const h = byCode.exists ? byCode : (byAsked && byAsked.exists ? byAsked : null);
    structure = h ? (h.data().structure || []) : [];
    hasGeofence = geo.docs.some(d => { const g = d.data() || {}; return sameState(g.state || g.state_code, code); });
  } catch (_) {
    return empty; // can't tell → nothing (never everything)
  }

  const scope = { ...empty, structure, open: hasGeofence && structure.length > 0 };
  for (const c of structure) {
    scope.classKeys.add(clsKey(c.class_name));
    for (const sj of (c.subjects || [])) {
      scope.subjectKeys.add(`${clsKey(c.class_name)}|${nrm(sj.subject)}`);
      for (const t of (sj.topics || [])) {
        scope.topicKeys.add(topicKey(c.class_name, sj.subject, t.topic));
        (t.ar_assets || []).forEach(x => { if (x && x.id) scope.linkedAssets.add(x.id); });
        (t.quizzes || []).forEach(x => { if (x && x.id) scope.linkedQuizzes.add(x.id); });
      }
    }
  }
  _cache.set(code, { at: Date.now(), scope });
  return scope;
}

/** All India (no target states), or targeted to this state. */
function visibleIn(item, scope) {
  const ts = Array.isArray(item && item.target_states) ? item.target_states : [];
  return ts.length === 0 || ts.some(x => sameState(x, scope.code));
}

/** Targeted to this state by name (not just All India). */
function targetedTo(item, scope) {
  const ts = Array.isArray(item && item.target_states) ? item.target_states : [];
  return ts.some(x => sameState(x, scope.code));
}

/**
 * Quizzes a student in [scope] may get, from [rows] (all quizzes).
 * Linked on the state's map (any language of it), or for a class on the map
 * and visible there; live and released for the state.
 */
function allowedQuizzes(rows, scope, liveStatuses) {
  if (!scope.open) return [];
  const groupOf = new Map(rows.map(q => [q.id, q.translation_group || q.id]));
  const linkedGroups = new Set([...scope.linkedQuizzes].map(id => groupOf.get(id) || id));
  return rows.filter(q => {
    if (!liveStatuses.has(q.status)) return false;
    if (!isReleased(q, scope.name)) return false;
    const linked = scope.linkedQuizzes.has(q.id) || linkedGroups.has(q.translation_group || q.id);
    if (linked) return true;
    return visibleIn(q, scope) && scope.classKeys.has(clsKey(q.class_name));
  });
}

/** One quiz: may this student open it? */
function quizAllowed(q, scope, liveStatuses, allRows) {
  return allowedQuizzes(allRows && allRows.length ? allRows : [q], scope, liveStatuses).some(x => x.id === q.id);
}

function dropScopeCache() { _cache.clear(); }

module.exports = {
  stateScope, studentState, visibleIn, targetedTo, allowedQuizzes, quizAllowed,
  clsKey, topicKey, nrm, dropScopeCache,
};
