/**
 * routes/auth.js — Login, refresh, logout, password reset
 * MODIFIED: Dashboard login now reads from Firestore `dashboard_users` collection.
 * Mobile OTP flow is unchanged.
 * Refresh/logout simplified (no Postgres refresh_token table).
 */

'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const refreshStore = require('../lib/refreshStore');
const path = require('path');
const fs   = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { authenticate } = require('../middleware/auth');
const log = require('../lib/logger');
const { sendResetEmail, sendMfaCode } = require('../lib/mailer');

const LOCKOUT_THRESHOLD = parseInt(process.env.LOCKOUT_THRESHOLD, 10) || 10;
const LOCKOUT_MINUTES   = parseInt(process.env.LOCKOUT_MINUTES, 10)   || 30;

// ── Lockout tracking via Firestore ────────────────────────────────────────────
async function recordFailedLogin(email) {
  try {
    const db = getFirestore();
    await db.collection('login_attempts').add({ email, created_at: new Date() });
  } catch (err) {
    log.warn({ err: err.message }, 'failed_logins insert failed');
  }
}

async function isLockedOut(email) {
  try {
    const db = getFirestore();
    const cutoff = new Date(Date.now() - LOCKOUT_MINUTES * 60 * 1000);
    const snap = await db.collection('login_attempts')
      .where('email', '==', email)
      .where('created_at', '>=', cutoff)
      .get();
    return snap.size >= LOCKOUT_THRESHOLD;
  } catch (_) { return false; }
}

async function clearFailedLogins(email) {
  try {
    const db = getFirestore();
    const snap = await db.collection('login_attempts').where('email', '==', email).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  } catch (_) {/* ignore */}
}

// ── JWT helpers ───────────────────────────────────────────────────────────────
function signAccess(user) {
  return jwt.sign(
    {
      id:    user.id,
      email: user.email,
      role:  user.role,
      name:  user.full_name,
      state: user.assigned_state,
      perm_publish_apps:     !!user.perm_publish_apps,
      perm_upload_unity:     !!user.perm_upload_unity,
      perm_manage_geo:       !!user.perm_manage_geo,
      perm_view_analytics:   !!user.perm_view_analytics,
      perm_create_users:     !!user.perm_create_users,
      perm_edit_curriculum:  !!user.perm_edit_curriculum,
      perm_approve_content:  !!user.perm_approve_content,
      perm_export_data:      !!user.perm_export_data,
      perm_manage_ads:       !!user.perm_manage_ads,
      perm_replay_analytics: !!user.perm_replay_analytics,
      perm_manage_compliance:!!user.perm_manage_compliance,
      perm_send_notif:       !!user.perm_send_notif,
      perm_view_legal:       !!user.perm_view_legal,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h', algorithm: 'HS256' }
  );
}

function signRefresh(userId, familyId) {
  return jwt.sign(
    { id: userId, fam: familyId, kind: 'refresh' },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d', algorithm: 'HS256' }
  );
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ── Login response (shared by password-only and password+code sign-in) ───────
function buildLoginResponse(userId, userRow) {
  const accessToken  = signAccess({ ...userRow, id: userId });
  const familyId     = uuidv4();
  const refreshToken = signRefresh(userId, familyId);
  // Register this session so the refresh token is revocable + reuse-detected.
  // Fire-and-forget: never block login on the store write.
  refreshStore.openSession(userId, familyId, refreshToken).catch(() => {});
  return {
    token:         accessToken,   // legacy field — dashboard reads this
    access_token:  accessToken,
    refresh_token: refreshToken,
    expires_in:    28800,
    user: {
      id:    userId,
      name:  userRow.full_name,
      email: userRow.email,
      role:  userRow.role,
      state: userRow.assigned_state || null,
      mfa_required: userRow.mfa_required === true,
      // Exact page/action permissions saved from Users → Edit (null = use the role preset)
      ui_permissions: Array.isArray(userRow.ui_permissions) ? userRow.ui_permissions : null,
      permissions: {
        publish_apps:     !!userRow.perm_publish_apps,
        upload_unity:     !!userRow.perm_upload_unity,
        manage_geo:       !!userRow.perm_manage_geo,
        view_analytics:   !!userRow.perm_view_analytics,
        create_users:     !!userRow.perm_create_users,
        edit_curriculum:  !!userRow.perm_edit_curriculum,
        approve_content:  !!userRow.perm_approve_content,
        export_data:      !!userRow.perm_export_data,
        manage_ads:       !!userRow.perm_manage_ads,
        replay_analytics: !!userRow.perm_replay_analytics,
        manage_compliance:!!userRow.perm_manage_compliance,
        send_notif:       !!userRow.perm_send_notif,
        view_legal:       !!userRow.perm_view_legal,
      },
    },
  };
}

// ── MFA (email code) ─────────────────────────────────────────────────────────
// Required when the account has mfa_required = true (set from Users / Compliance
// / Settings) or when Compliance settings turn it on for everyone.
async function mfaRequiredFor(db, userRow) {
  if (userRow.mfa_required === true) return true;
  try {
    const s = await db.collection('compliance_settings').doc('_global_settings').get();
    return s.exists && s.data().mfa_required === true;
  } catch (_) { return false; }
}
function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  if (!d) return '';
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '*'.repeat(Math.max(1, u.length - 2))) + '@' + d;
}
const MFA_TTL_MS = 10 * 60 * 1000;
const MFA_MAX_TRIES = 5;

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { phone, role, method } = req.body;
    const email    = String(req.body?.email || '').toLowerCase().trim();
    const password = req.body?.password;

    // ── LANE 1: MOBILE APP (PASSWORDLESS OTP) ─────────────────────────────────
    if (method) {
      if (!phone || !role) {
        return res.status(400).json({ error: 'Phone and role are required for OTP login' });
      }
      log.info({ phone, role }, 'OTP send requested');
      return res.status(200).json({ message: `OTP sent successfully via ${method}` });
    }

    // ── LANE 2: DASHBOARD (EMAIL + PASSWORD → Firestore) ──────────────────────
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (await isLockedOut(email)) {
      return res.status(429).json({ error: 'Account temporarily locked. Try again later.' });
    }

    const db = getFirestore();
    const snapshot = await db.collection('dashboard_users')
      .where('email', '==', email)
      .limit(1)
      .get();

    const fakeHash = '$2a$12$0000000000000000000000000000000000000000000000000000.';
    const userDoc  = snapshot.empty ? null : snapshot.docs[0];
    const userRow  = userDoc ? userDoc.data() : null;
    const hashToCheck = userRow ? userRow.password_hash : fakeHash;
    const match = await bcrypt.compare(password, hashToCheck);

    if (!userRow || !match || userRow.is_active === false) {
      await recordFailedLogin(email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await clearFailedLogins(email);

    const userId = userDoc.id;

    // Second step: email a 6-digit code when MFA applies to this account.
    if (await mfaRequiredFor(db, userRow)) {
      const challengeId = crypto.randomBytes(16).toString('hex');
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await db.collection('mfa_challenges').doc(challengeId).set({
        user_id: userId, email: userRow.email,
        code_hash: hashToken(`${challengeId}:${code}`),
        attempts: 0, expires_at: Date.now() + MFA_TTL_MS, created_at: new Date(),
      });
      try {
        await sendMfaCode({ to: userRow.email, code });
      } catch (err) {
        await db.collection('mfa_challenges').doc(challengeId).delete().catch(() => {});
        log.error({ err: err.message, userId }, 'MFA email failed');
        return res.status(503).json({ error: 'Could not email your sign-in code. Ask an administrator to check the SMTP settings.' });
      }
      log.info({ userId, email }, 'Password OK — MFA code emailed');
      return res.json({ mfa_required: true, challenge_id: challengeId, email_hint: maskEmail(userRow.email) });
    }

    log.info({ userId, email, role: userRow.role }, 'Dashboard login successful');
    res.json(buildLoginResponse(userId, userRow));
  } catch (err) {
    log.error({ err: err.message }, 'login error');
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// ── POST /api/auth/verify-mfa (Dashboard, second step) ───────────────────────
router.post('/verify-mfa', async (req, res) => {
  try {
    const challengeId = String(req.body?.challenge_id || '');
    const code        = String(req.body?.code || '').trim();
    if (!/^[a-f0-9]{32}$/.test(challengeId) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Enter the 6-digit code from your email.' });
    }
    const db  = getFirestore();
    const ref = db.collection('mfa_challenges').doc(challengeId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(401).json({ error: 'This code has expired. Sign in again.' });
    const c = doc.data();
    if (Date.now() > c.expires_at) {
      await ref.delete().catch(() => {});
      return res.status(401).json({ error: 'This code has expired. Sign in again.' });
    }
    if ((c.attempts || 0) >= MFA_MAX_TRIES) {
      await ref.delete().catch(() => {});
      return res.status(429).json({ error: 'Too many wrong codes. Sign in again.' });
    }
    const a = Buffer.from(hashToken(`${challengeId}:${code}`));
    const b = Buffer.from(String(c.code_hash || ''));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      await ref.update({ attempts: (c.attempts || 0) + 1 });
      await recordFailedLogin(c.email);
      return res.status(401).json({ error: 'Incorrect code. Check the latest email and try again.' });
    }
    await ref.delete();
    const userDoc = await db.collection('dashboard_users').doc(c.user_id).get();
    if (!userDoc.exists || userDoc.data().is_active === false) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    log.info({ userId: c.user_id }, 'Dashboard login successful (MFA)');
    res.json(buildLoginResponse(userDoc.id, userDoc.data()));
  } catch (err) {
    log.error({ err: err.message }, 'verify-mfa error');
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// ── PUT /api/auth/me/mfa ─── turn the sign-in code on/off for your own account
router.put('/me/mfa', authenticate, async (req, res) => {
  try {
    const enabled = req.body?.enabled === true;
    const db = getFirestore();
    if (!enabled) {
      const s = await db.collection('compliance_settings').doc('_global_settings').get();
      if (s.exists && s.data().mfa_required === true) {
        return res.status(400).json({ error: 'MFA is required for every account by the Compliance settings.' });
      }
    }
    await db.collection('dashboard_users').doc(req.user.id).update({ mfa_required: enabled, updated_at: new Date() });
    await db.collection('audit_log').add({
      action: enabled ? 'mfa_enabled_self' : 'mfa_disabled_self', actor: req.user.id, created_at: new Date(),
    });
    res.json({ success: true, mfa_required: enabled });
  } catch (err) {
    log.error({ err: err.message }, 'me/mfa error');
    res.status(500).json({ error: 'Could not update MFA setting.' });
  }
});

// NOTE (Wave-1 C3): the legacy /api/auth/verify-otp route was REMOVED. It carried a
// hardcoded master OTP ('123456') that bypassed authentication. Phone-OTP login is
// handled by real Firebase Phone Auth in the app, which then exchanges the Firebase
// ID token for a backend JWT via POST /api/auth/firebase (below). That is the ONLY
// phone-login path, and it verifies the token server-side with firebase.verifyIdToken().

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
// Simplified: verify the JWT signature only (no DB lookup).
router.post('/refresh', async (req, res) => {
  try {
    const presented = req.body?.refresh_token;
    if (!presented || typeof presented !== 'string' || presented.length > 4096) {
      return res.status(400).json({ error: 'Refresh token required' });
    }
    let decoded;
    try {
      decoded = jwt.verify(presented, process.env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
      if (decoded.kind !== 'refresh') throw new Error('not a refresh token');
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // Issue the rotated refresh token, then validate+rotate the server-side session.
    // If the presented token is an OLD one (reuse), rotateSession revokes the family
    // and we reject — a stolen token can no longer be used, and the real user's next
    // refresh will also fail (forcing a fresh login), which is the safe outcome.
    const newRefresh  = signRefresh(decoded.id, decoded.fam);
    const rotation = await refreshStore.rotateSession(
      decoded.id, decoded.fam, presented, newRefresh);
    if (!rotation.ok) {
      return res.status(401).json({ error: 'Session is no longer valid. Please sign in again.' });
    }
    const accessToken = jwt.sign(
      { id: decoded.id, fam: decoded.fam },
      process.env.JWT_SECRET,
      { expiresIn: '8h', algorithm: 'HS256' }
    );
    res.json({ access_token: accessToken, refresh_token: newRefresh, expires_in: 28800 });
  } catch (err) {
    log.error({ err: err.message }, 'refresh error');
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// ── POST /api/auth/firebase — Mobile app exchanges a Firebase ID token ─────────
// The Flutter app signs the student in with real Firebase Phone OTP, then sends
// the Firebase ID token here. We verify it and mint our own access/refresh JWTs.
router.post('/firebase', async (req, res) => {
  try {
    const idToken = req.body?.id_token;
    const role    = req.body?.role || 'student';
    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ error: 'id_token required' });
    }

    const firebase = require('../lib/firebase');
    let decodedFirebase;
    try {
      decodedFirebase = await firebase.verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ error: 'Invalid Firebase token' });
    }

    const userId = decodedFirebase.uid;
    const db     = getFirestore();

    let userData = {};
    try {
      const doc = await db.collection('app_users').doc(userId).get();
      if (doc.exists) userData = doc.data();
    } catch { /* profile may not exist yet — proceed with minimal claims */ }

    // SECURITY: the app can only ever get a student or teacher token here.
    // (Previously the role came from the request body, so a modified app could
    // ask for "master_admin".) Dashboard roles are only issued by /login.
    const appRoles  = ['student', 'teacher'];
    const finalRole = appRoles.includes(userData.role) ? userData.role
                    : (role === 'teacher' ? 'teacher' : 'student');

    const familyId     = uuidv4();
    const accessToken  = signAccess({
      id: userId, role: finalRole,
      email: userData.email || null,
      full_name: userData.full_name || userData.name || null,
      assigned_state: userData.assigned_state || null,
    });
    const refreshToken = signRefresh(userId, familyId);
    // Register this app-login session so its refresh token is revocable +
    // reuse-detected (same protection as the dashboard login path).
    refreshStore.openSession(userId, familyId, refreshToken).catch(() => {});

    return res.json({
      access_token:  accessToken,
      accessToken,
      refresh_token: refreshToken,
      refreshToken,
      expires_in:    28800,
      user: {
        id:   userId,
        name: userData.full_name || userData.name || 'User',
        role: finalRole,
      },
    });
  } catch (err) {
    log.error({ err: err.message }, 'firebase-exchange error');
    res.status(500).json({ error: 'Firebase login failed' });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', authenticate, async (req, res) => {
  // Revoke this session family so the refresh token can no longer be used.
  // The client sends its refresh token so we can target the right family; if it
  // isn't sent we fall back to revoking all of the user's sessions (safe default).
  try {
    const presented = req.body?.refresh_token;
    if (presented && typeof presented === 'string') {
      try {
        const d = jwt.verify(presented, process.env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
        if (d.fam) await refreshStore.revokeSession(d.fam);
      } catch { /* bad token → fall through to revoke-all */ }
    } else if (req.user?.id) {
      await refreshStore.revokeAllForUser(req.user.id);
    }
  } catch { /* never fail logout */ }
  res.json({ message: 'Logged out successfully' });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const db = getFirestore();
    const doc = await db.collection('dashboard_users').doc(req.user.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const data = doc.data();
    delete data.password_hash;
    res.json({ id: doc.id, ...data });
  } catch (err) {
    log.error({ err: err.message }, '/me error');
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ── POST /api/auth/request-reset ─────────────────────────────────────────────
router.post('/request-reset', async (req, res) => {
  // Always return 200 to avoid email enumeration — never reveal if email exists
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();
    if (email) {
      const db   = getFirestore();
      const snap = await db.collection('dashboard_users').where('email', '==', email).limit(1).get();
      if (!snap.empty) {
        const userDoc    = snap.docs[0];
        const token      = crypto.randomBytes(32).toString('hex');
        const expiresAt  = Date.now() + 1000 * 60 * 60; // 1 hour
        const resetUrl   = `${process.env.APP_BASE_URL}/reset?token=${token}`;
        await db.collection('password_reset_tokens').doc(token).set({
          userId: userDoc.id, email, expiresAt, used: false,
        });
        sendResetEmail({ to: email, resetUrl })
          .catch(err => log.error({ err: err.message, email }, 'reset email send failed'));
      }
    }
  } catch (err) {
    log.error({ err: err.message }, 'request-reset error');
  }
  res.json({ message: 'If that account exists, a reset link has been sent.' });
});

// ── POST /api/auth/reset-password ────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and password are required.' });
    if (newPassword.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters.' });

    const db       = getFirestore();
    const tokenDoc = await db.collection('password_reset_tokens').doc(token).get();

    if (!tokenDoc.exists)             return res.status(400).json({ error: 'Invalid or expired reset link.' });
    const data = tokenDoc.data();
    if (data.used)                    return res.status(400).json({ error: 'This reset link has already been used.' });
    if (Date.now() > data.expiresAt)  return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });

    const bcrypt      = require('bcryptjs');
    const password_hash = await bcrypt.hash(newPassword, 12);

    await db.collection('dashboard_users').doc(data.userId).update({ password_hash });
    await tokenDoc.ref.update({ used: true });
    // A password reset must invalidate every existing session (a compromised
    // account's stolen tokens are killed).
    await refreshStore.revokeAllForUser(data.userId);

    res.json({ message: 'Password updated successfully. You can now log in.' });
  } catch (err) {
    log.error({ err: err.message }, 'reset-password error');
    res.status(500).json({ error: 'Password reset failed. Please try again.' });
  }
});

// ── PUT /api/auth/me/profile ─── update your own display name ────────────────
router.put('/me/profile', authenticate, async (req, res) => {
  try {
    const { full_name } = req.body || {};
    if (!full_name || typeof full_name !== 'string' || full_name.trim().length < 2) {
      return res.status(400).json({ error: 'Full name must be at least 2 characters.' });
    }
    if (full_name.length > 120) return res.status(400).json({ error: 'Full name too long.' });
    const db = getFirestore();
    await db.collection('dashboard_users').doc(req.user.id)
      .update({ full_name: full_name.trim(), updated_at: new Date() });
    res.json({ success: true, full_name: full_name.trim() });
  } catch (err) {
    log.error({ err: err.message }, 'update profile error');
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// ── POST /api/auth/me/change-password ─── change your own password ───────────
router.post('/me/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required.' });
    }
    if (newPassword.length < 12) {
      return res.status(400).json({ error: 'New password must be at least 12 characters.' });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'New password must be different from the current one.' });
    }
    const db  = getFirestore();
    const ref = db.collection('dashboard_users').doc(req.user.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });
    const match = await bcrypt.compare(currentPassword, doc.data().password_hash || '');
    if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });
    const password_hash = await bcrypt.hash(newPassword, 12);
    await ref.update({ password_hash, password_changed_at: new Date() });
    // Invalidate all other sessions after a password change.
    await refreshStore.revokeAllForUser(req.user.id);
    res.json({ success: true, message: 'Password updated.' });
  } catch (err) {
    log.error({ err: err.message }, 'change password error');
    res.status(500).json({ error: 'Failed to change password.' });
  }
});

module.exports = router;
