'use strict';
/**
 * lib/states.js — every state comparison on the server goes through here.
 *
 * The data lives in public/mitra-states.js (shared with the Dashboard page;
 * the app keeps an identical copy). Any form of a state — "Gujarat", "GJ",
 * "gujarat", "Orissa", "OR" — resolves to the same entry.
 */
const STATES = require('../public/mitra-states.js');

// The country-wide value staff accounts use for "no single state".
const NATIONAL = new Set(['all india', 'india', 'national', 'all']);

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase()
  .replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

// norm(form) -> state entry, for the code, the name and every alias.
const BY_KEY = new Map();
for (const s of STATES) {
  for (const f of [s.code, s.name, ...(s.aliases || [])]) BY_KEY.set(norm(f), s);
}

/** The state entry for any form, or null if unknown. */
function findState(value) {
  const k = norm(value);
  return k ? BY_KEY.get(k) || null : null;
}

/** MITRA code ("GJ") for any form, or null if unknown. */
function toCode(value) {
  const s = findState(value);
  return s ? s.code : null;
}

/** Official name ("Gujarat") for any form, or null if unknown. */
function toName(value) {
  const s = findState(value);
  return s ? s.name : null;
}

/** True for "All India" and similar country-wide values. */
function isNational(value) {
  return NATIONAL.has(String(value == null ? '' : value).trim().toLowerCase());
}

/**
 * Every lowercase form of a state: what was given, its code, its name and its
 * aliases. Unknown values give just themselves (lowercased), so nothing that
 * matched before stops matching.
 */
function stateKeys(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return new Set();
  const out = new Set([raw.toLowerCase()]);
  const s = findState(raw);
  if (s) for (const f of [s.code, s.name, ...(s.aliases || [])]) out.add(String(f).toLowerCase());
  return out;
}

/** Same state? Works across codes, names, case and old spellings. */
function sameState(a, b) {
  const sa = findState(a);
  const sb = findState(b);
  if (sa && sb) return sa.code === sb.code;
  const na = norm(a);
  return !!na && na === norm(b);
}

/**
 * Stage 4: the values in `list` that are neither a state in the list nor
 * "All India". Used to refuse a save instead of storing a typo.
 */
function unknownStates(list) {
  const arr = Array.isArray(list) ? list : [list];
  return arr.map(v => String(v == null ? '' : v).trim())
    .filter(v => v && !isNational(v) && !findState(v));
}

const UNKNOWN_STATE_MSG = (bad) =>
  `Unknown state: ${bad.join(', ')}. Pick it from the list (36 states and UTs).`;

module.exports = { STATES, findState, toCode, toName, isNational, stateKeys, sameState, norm, unknownStates, UNKNOWN_STATE_MSG };
