'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// lib/writeGuard.js — mass-assignment protection for Firestore writes  (Wave 2 H4/H12)
//
// Client write routes used `{ ...req.body }`, letting a caller set ANY field
// (status, release, created_by, counters, ownership …) and bypass dedicated
// endpoints. pickFields() keeps ONLY the fields a route is allowed to accept;
// stripFields() removes known-dangerous/system fields from a body. Also drops
// prototype-pollution keys (__proto__, constructor, prototype).
// ═══════════════════════════════════════════════════════════════════════════

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Keep only the listed fields from body. Returns a NEW plain object.
function pickFields(body, allowed) {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  for (const k of allowed) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined) {
      out[k] = body[k];
    }
  }
  return out;
}

// Copy body but remove the listed (and always the forbidden) keys.
function stripFields(body, blocked) {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  const block = new Set([...(blocked || []), ...FORBIDDEN_KEYS]);
  for (const k of Object.keys(body)) {
    if (block.has(k)) continue;
    out[k] = body[k];
  }
  return out;
}

module.exports = { pickFields, stripFields };