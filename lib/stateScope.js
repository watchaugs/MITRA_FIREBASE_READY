'use strict';
/**
 * lib/stateScope.js — per-state gate-keeping for the shared Firestore DB.
 *
 * Everyone shares ONE database. This helper enforces that a state-scoped
 * user (assigned_state set) can only see / act on rows for their own state,
 * while national admins (master_admin / admin / superadmin, or no assigned
 * state) see everything.
 *
 * The smartphone app reads the same rows — this layer just decides who in
 * the dashboard is allowed to touch which state's rows.
 */

// Roles that are allowed to see every state.
const NATIONAL_ROLES = new Set(['master_admin', 'admin', 'superadmin']);

// ── One state table for the whole server ─────────────────────────────────────
// Content may be tagged by code ("GJ"), full name ("Gujarat"), a lowercase
// variant or an old spelling ("Orissa", "OR"); the app sends the student's
// assigned_state (full name). lib/states.js (data: public/mitra-states.js)
// treats every form of one state as identical, so a lesson tagged "GJ" still
// reaches a student whose state is "Gujarat", and an officer scoped to "GJ"
// can manage rows saved as "Gujarat".
const { stateKeys, sameState, isNational, toCode, toName } = require('./states');

// Every lowercase form of a state: given value, code, name, old spellings.
// "GJ" -> {"gj","gujarat"}; "Odisha" -> {"odisha","od","or","orissa"}.
function stateAliases(value) {
  return stateKeys(value);
}

/**
 * The state this request is scoped to, or null = national (see all).
 */
function scopeState(req) {
  const u = req.user || {};
  if (NATIONAL_ROLES.has(u.role)) return null;      // national admin
  const s = (u.state || '').trim();
  if (!s.length || isNational(s)) return null;       // no state / "All India" => national
  return s;
}

/**
 * True if this user may read/write rows for `rowState`.
 */
function canAccessState(req, rowState) {
  const scope = scopeState(req);
  if (scope === null) return true;                   // national
  if (!rowState) return false;                       // scoped user, unstated row
  return sameState(rowState, scope);                 // "GJ" == "Gujarat" == "gujarat"
}

/**
 * Filter an array of docs (each having a `.state`) down to what this user may see.
 */
function filterByState(req, rows, field = 'state') {
  const scope = scopeState(req);
  if (scope === null) return rows;
  return rows.filter(r => sameState(r[field], scope));
}

/**
 * Express guard: 403 unless the user may act on req.body[field] (or req.query[field]).
 * Use on POST/PUT so a state officer can't create/edit another state's row.
 */
function requireStateMatch(field = 'state') {
  return (req, res, next) => {
    const scope = scopeState(req);
    if (scope === null) return next();               // national admin — allowed
    const rowState = (req.body && req.body[field]) || (req.query && req.query[field]);
    if (!rowState) {
      return res.status(400).json({ error: `Missing "${field}" — your account is limited to ${scope}.` });
    }
    if (!sameState(rowState, scope)) {
      return res.status(403).json({ error: `Your account can only manage ${scope}.` });
    }
    next();
  };
}


/**
 * App-facing geo filter (state-based geofencing).
 * Keep items whose target_states is empty (national) or includes `state`.
 * `state` comes from the app: resolved via geofence /check-point (GPS->state)
 * or the student's enrolled state.
 */
function visibleInState(rows, state, field = 'target_states') {
  if (!state) return rows;
  const want = stateAliases(state); // e.g. {"gujarat","gj"}
  return rows.filter(r => {
    const t = r[field];
    if (!Array.isArray(t) || t.length === 0) return true; // national
    // Keep the row if ANY of its target tags shares an alias with the wanted state,
    // so "GJ" (tag) matches a student in "Gujarat" and vice-versa.
    return t.some(x => {
      const tagAliases = stateAliases(x);
      for (const a of tagAliases) if (want.has(a)) return true;
      return false;
    });
  });
}

/**
 * Normalise a target_states value from a request body (array | JSON | CSV).
 * Stage 2: each state is saved as its MITRA code ("Gujarat"/"gj" → "GJ",
 * "Orissa" → "OD"); an unknown value is kept uppercased as before.
 */
function parseTargetStates(v) {
  const tidy = (list) => [...new Set(list
    .map(x => String(x).trim()).filter(Boolean)
    .map(x => toCode(x) || x.toUpperCase()))];
  if (!v) return [];
  if (Array.isArray(v)) return tidy(v);
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return [];
    try { const j = JSON.parse(t); if (Array.isArray(j)) return tidy(j); } catch (e) {}
    return tidy(t.split(','));
  }
  return [];
}

/**
 * May this user change a row aimed at `targets` (a target_states list)?
 * An empty list means All India: national users only. A state-scoped user may
 * only touch rows aimed solely at their own state.
 */
function canTouchTargets(req, targets) {
  const scope = scopeState(req);
  if (scope === null) return true;                   // national
  const list = parseTargetStates(targets).filter(t => !isNational(t));
  if (!list.length) return false;                    // All India row
  return list.every(t => sameState(t, scope));
}

/**
 * Targets for a NEW row. National users keep what they sent. A state-scoped
 * user's new row is aimed at their own state (also when they sent nothing);
 * null when they asked for another state.
 */
function scopedTargets(req, targets) {
  const list = parseTargetStates(targets);
  const scope = scopeState(req);
  if (scope === null) return list;
  const real = list.filter(t => !isNational(t));
  if (!real.length) return [toCode(scope) || toName(scope) || scope];
  return real.every(t => sameState(t, scope)) ? real : null;
}

/**
 * router.param guard for `:id` routes of one collection: a state-scoped user
 * can't change (any method but GET/HEAD) a row aimed beyond their state.
 * National users pass without a read.
 */
function guardTargets(collection, field = 'target_states') {
  return async (req, res, next, id) => {
    try {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      const scope = scopeState(req);
      if (scope === null) return next();
      const { getFirestore } = require('./firebase');
      const doc = await getFirestore().collection(collection).doc(String(id)).get();
      if (doc.exists && !canTouchTargets(req, (doc.data() || {})[field])) {
        return res.status(403).json({ error: `Your account can only manage ${scope}.` });
      }
      next();
    } catch (e) { next(e); }
  };
}

module.exports = { scopeState, canAccessState, filterByState, requireStateMatch, NATIONAL_ROLES, visibleInState, parseTargetStates, stateAliases, canTouchTargets, scopedTargets, guardTargets };