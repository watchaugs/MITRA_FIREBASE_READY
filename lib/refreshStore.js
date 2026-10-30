'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// lib/refreshStore.js — stateful, revocable refresh-token sessions  (Wave 1 C5)
//
// Each login opens a "family" (one device/session). The current refresh token's
// hash is stored in Firestore under refresh_sessions/{familyId}. On every use we:
//   • verify the presented token's hash matches the stored current hash,
//   • if it does NOT match (an OLD token replayed) → REUSE DETECTED → revoke the
//     whole family (someone has a stolen copy),
//   • if it matches → rotate: store the hash of the newly-issued token.
// logout() and revokeAllForUser() (password change/reset) revoke sessions so a
// stolen token can be killed. Tokens themselves stay JWTs; only their hashes live
// server-side, so the store is small and never holds a usable secret.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { getFirestore } = require('./firebase');
const log = require('./logger');

const COLLECTION = 'refresh_sessions';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Open a new session family at login. Returns nothing; caller already has familyId.
async function openSession(userId, familyId, refreshToken) {
  try {
    await getFirestore().collection(COLLECTION).doc(familyId).set({
      user_id: userId,
      current_hash: hashToken(refreshToken),
      revoked: false,
      created_at: new Date(),
      rotated_at: new Date(),
    });
  } catch (err) {
    log.error({ err: err.message }, 'refreshStore.openSession failed');
  }
}

// Validate a presented refresh token against the stored family, rotate on success.
// Returns { ok:true } to proceed, or { ok:false, reason } to reject.
// On reuse detection the family is revoked.
async function rotateSession(userId, familyId, presentedToken, newToken) {
  const db = getFirestore();
  const ref = db.collection(COLLECTION).doc(familyId);
  try {
    const snap = await ref.get();
    if (!snap.exists) return { ok: false, reason: 'unknown_session' };
    const data = snap.data();
    if (data.revoked === true) return { ok: false, reason: 'revoked' };
    if (data.user_id !== userId) return { ok: false, reason: 'user_mismatch' };
    if (data.current_hash !== hashToken(presentedToken)) {
      // An old/rotated token was replayed → likely theft. Burn the family.
      await ref.update({ revoked: true, revoked_at: new Date(), revoked_reason: 'reuse_detected' });
      log.warn({ userId, familyId }, 'refresh reuse detected — family revoked');
      return { ok: false, reason: 'reuse_detected' };
    }
    await ref.update({ current_hash: hashToken(newToken), rotated_at: new Date() });
    return { ok: true };
  } catch (err) {
    log.error({ err: err.message }, 'refreshStore.rotateSession failed');
    return { ok: false, reason: 'error' };
  }
}

// Revoke a single session (logout on this device).
async function revokeSession(familyId) {
  try {
    await getFirestore().collection(COLLECTION).doc(familyId)
      .set({ revoked: true, revoked_at: new Date(), revoked_reason: 'logout' }, { merge: true });
  } catch (err) {
    log.error({ err: err.message }, 'refreshStore.revokeSession failed');
  }
}

// Revoke ALL of a user's sessions (password change/reset, "log out everywhere").
async function revokeAllForUser(userId) {
  try {
    const db = getFirestore();
    const snap = await db.collection(COLLECTION).where('user_id', '==', userId).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, {
      revoked: true, revoked_at: new Date(), revoked_reason: 'revoke_all',
    }));
    await batch.commit();
  } catch (err) {
    log.error({ err: err.message }, 'refreshStore.revokeAllForUser failed');
  }
}

module.exports = { openSession, rotateSession, revokeSession, revokeAllForUser };