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

/**
 * The state this request is scoped to, or null = national (see all).
 */
function scopeState(req) {
  const u = req.user || {};
  if (NATIONAL_ROLES.has(u.role)) return null;      // national admin
  const s = (u.state || '').trim();
  return s.length ? s : null;                        // no state set => national
}

/**
 * True if this user may read/write rows for `rowState`.
 */
function canAccessState(req, rowState) {
  const scope = scopeState(req);
  if (scope === null) return true;                   // national
  if (!rowState) return false;                       // scoped user, unstated row
  return String(rowState).trim().toLowerCase() === scope.toLowerCase();
}

/**
 * Filter an array of docs (each having a `.state`) down to what this user may see.
 */
function filterByState(req, rows, field = 'state') {
  const scope = scopeState(req);
  if (scope === null) return rows;
  const want = scope.toLowerCase();
  return rows.filter(r => String(r[field] || '').trim().toLowerCase() === want);
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
    if (String(rowState).trim().toLowerCase() !== scope.toLowerCase()) {
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
  const want = String(state).trim().toUpperCase();
  return rows.filter(r => {
    const t = r[field];
    if (!Array.isArray(t) || t.length === 0) return true; // national
    return t.map(x => String(x).trim().toUpperCase()).includes(want);
  });
}

/** Normalise a target_states value from a request body (array | JSON | CSV). */
function parseTargetStates(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => String(x).trim().toUpperCase()).filter(Boolean);
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return [];
    try { const j = JSON.parse(t); if (Array.isArray(j)) return j.map(x => String(x).trim().toUpperCase()).filter(Boolean); } catch (e) {}
    return t.split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  }
  return [];
}

module.exports = { scopeState, canAccessState, filterByState, requireStateMatch, NATIONAL_ROLES, visibleInState, parseTargetStates };