'use strict';
/**
 * lib/release.js — developer-controlled release of AR content and quizzes.
 *
 * Why: content should reach students only once the topic has been taught in
 * class, not all at once on day one. Each AR asset / quiz carries a `release`
 * object set from the dashboard (📅 Release button):
 *
 *   { mode: 'now' }                                   visible as soon as published (default)
 *   { mode: 'hold' }                                  published but hidden from every student
 *   { mode: 'date', at: '2026-11-03T09:00:00+05:30' } visible everywhere from that moment
 *   { mode: 'per_state', by_state: { 'uttar pradesh': '2026-11-03T09:00:00+05:30', 'bihar': 'hold' },
 *     others: 'hold' | 'now' | '<date>' }           each state its own date (or 'hold');
 *                                                     states not listed follow `others` (default hidden)
 *
 * The check runs on the server every time the app asks for content, using the
 * server clock — so a student cannot unlock early by changing the phone's date,
 * and there is no scheduler or background job (zero cost).
 */

const APP_ROLES = new Set(['student', 'teacher']);

/** True when the request comes from the student/teacher app, not the dashboard. */
function isAppCaller(req) {
  return !!(req && req.user && APP_ROLES.has(req.user.role));
}

const normState = (s) => String(s || '').trim().toLowerCase();

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v === 'object' && v._seconds != null) return v._seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Is this item released for a student in `state` right now? */
function isReleased(item, state, now = Date.now()) {
  const r = (item && item.release) || { mode: 'now' };
  switch (r.mode) {
    case 'hold':      return false;
    case 'date':      { const t = toMs(r.at); return t != null && t <= now; }
    case 'per_state': {
      const v = (r.by_state || {})[normState(state)];
      const rule = v != null ? v : (r.others || 'hold');
      if (rule === 'hold') return false;
      if (rule === 'now') return true;
      const t = toMs(rule);
      return t != null && t <= now;
    }
    default:          return true; // 'now' or no release set
  }
}

/** Validate + normalise a release object coming from the dashboard. Throws on bad input. */
function cleanRelease(input) {
  const r = input || {};
  const mode = ['now', 'hold', 'date', 'per_state'].includes(r.mode) ? r.mode : null;
  if (!mode) throw new Error('release.mode must be now, hold, date or per_state');
  if (mode === 'date') {
    if (toMs(r.at) == null) throw new Error('Pick a release date and time');
    return { mode, at: new Date(toMs(r.at)).toISOString() };
  }
  if (mode === 'per_state') {
    const by_state = {};
    Object.entries(r.by_state || {}).forEach(([k, v]) => {
      if (!normState(k)) return;
      if (v === 'hold') { by_state[normState(k)] = 'hold'; return; }
      const t = toMs(v);
      if (t != null) by_state[normState(k)] = new Date(t).toISOString();
    });
    let others = r.others == null ? 'hold' : r.others;
    if (others !== 'hold' && others !== 'now') {
      const t = toMs(others);
      if (t == null) throw new Error('"Other states" must be hold, now or a date');
      others = new Date(t).toISOString();
    }
    if (!Object.keys(by_state).length && others === 'hold') throw new Error('Set a date for at least one state');
    return { mode, by_state, others };
  }
  return { mode };
}

/** Short human summary for dashboard tables. */
function describeRelease(item) {
  const r = (item && item.release) || { mode: 'now' };
  if (r.mode === 'hold') return 'On hold';
  if (r.mode === 'date') return 'From ' + r.at;
  if (r.mode === 'per_state') return `Per state (${Object.keys(r.by_state || {}).length})`;
  return 'Immediately';
}

/**
 * Set ONE state's release on an item, keeping what other states already had.
 * value: 'now' | 'hold' | a date. Used by the Curriculum page ("Release this
 * topic in <state>"), which applies to every AR asset / quiz linked to the topic.
 */
function mergeStateRelease(current, state, value) {
  const st = normState(state);
  if (!st) throw new Error('state required');
  const cur = current || { mode: 'now' };
  let others;
  if (cur.mode === 'per_state') others = cur.others || 'hold';
  else if (cur.mode === 'hold') others = 'hold';
  else if (cur.mode === 'date') others = cur.at;
  else others = 'now';
  const by_state = cur.mode === 'per_state' ? { ...(cur.by_state || {}) } : {};
  if (value === 'hold') by_state[st] = 'hold';
  else if (value === 'now' || value == null) by_state[st] = new Date().toISOString();
  else {
    const t = toMs(value);
    if (t == null) throw new Error('Pick a valid date');
    by_state[st] = new Date(t).toISOString();
  }
  return { mode: 'per_state', by_state, others };
}

module.exports = { APP_ROLES, isAppCaller, isReleased, cleanRelease, describeRelease, normState, mergeStateRelease };