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

// ── Canonical India state code <-> name map ──────────────────────────────────
// Content may be tagged by ISO code ("GJ"), full name ("Gujarat") or a lowercase
// variant ("gujarat"); the app sends the student's assigned_state (full name).
// This map lets every comparison treat all forms of one state as identical, so a
// lesson tagged "GJ" still reaches a student whose state is "Gujarat".
const IN_STATE_CODE_TO_NAME = {
  'AN':'Andaman and Nicobar Islands','AP':'Andhra Pradesh','AR':'Arunachal Pradesh',
  'AS':'Assam','BR':'Bihar','CH':'Chandigarh','CT':'Chhattisgarh','DN':'Dadra and Nagar Haveli and Daman and Diu',
  'DL':'Delhi','GA':'Goa','GJ':'Gujarat','HR':'Haryana','HP':'Himachal Pradesh',
  'JK':'Jammu and Kashmir','JH':'Jharkhand','KA':'Karnataka','KL':'Kerala','LA':'Ladakh',
  'LD':'Lakshadweep','MP':'Madhya Pradesh','MH':'Maharashtra','MN':'Manipur','ML':'Meghalaya',
  'MZ':'Mizoram','NL':'Nagaland','OR':'Odisha','PY':'Puducherry','PB':'Punjab','RJ':'Rajasthan',
  'SK':'Sikkim','TN':'Tamil Nadu','TG':'Telangana','TR':'Tripura','UP':'Uttar Pradesh',
  'UK':'Uttarakhand','UT':'Uttarakhand','WB':'West Bengal',
};
const IN_STATE_NAME_TO_CODE = Object.fromEntries(
  Object.entries(IN_STATE_CODE_TO_NAME).map(([c, n]) => [n.toLowerCase(), c])
);

// Return every lowercase alias of a state value: its name AND its code.
// "GJ" -> {"gj","gujarat"}; "Gujarat" -> {"gujarat","gj"}; "gujarat" -> same.
function stateAliases(value) {
  const raw = String(value || '').trim();
  if (!raw) return new Set();
  const lower = raw.toLowerCase();
  const upper = raw.toUpperCase();
  const out = new Set([lower]);
  if (IN_STATE_CODE_TO_NAME[upper]) {
    out.add(upper.toLowerCase());
    out.add(IN_STATE_CODE_TO_NAME[upper].toLowerCase());
  }
  if (IN_STATE_NAME_TO_CODE[lower]) {
    out.add(IN_STATE_NAME_TO_CODE[lower].toLowerCase());
  }
  return out;
}

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

module.exports = { scopeState, canAccessState, filterByState, requireStateMatch, NATIONAL_ROLES, visibleInState, parseTargetStates, stateAliases };