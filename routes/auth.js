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
const path = require('path');
const fs   = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { authenticate } = require('../middleware/auth');
const log = require('../lib/logger');
const { sendResetEmail } = require('../lib/mailer');

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

    const userId      = userDoc.id;
    const familyId    = uuidv4();
    const accessToken  = signAccess({ ...userRow, id: userId });
    const refreshToken = signRefresh(userId, familyId);

    log.info({ userId, email, role: userRow.role }, 'Dashboard login successful');

    res.json({
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
        },
      },
    });
  } catch (err) {
    log.error({ err: err.message }, 'login error');
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// ── POST /api/auth/verify-otp (Mobile App) ───────────────────────────────────
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp, role } = req.body;

    if (otp !== '123456') {
      return res.status(400).json({ message: 'OTP is incorrect. Please try again.' });
    }

    // During development: look up student/teacher in Firestore by phone
    const db = getFirestore();
    const collection = role === 'teacher' ? 'teachers' : 'students';
    const snap = await db.collection(collection)
      .where('phone_number', '==', phone)
      .limit(1)
      .get();

    // Fallback: create a minimal user object if not found
    const userId = snap.empty ? uuidv4() : snap.docs[0].id;
    const userData = snap.empty ? { role: role || 'student' } : snap.docs[0].data();

    const familyId    = uuidv4();
    const accessToken  = signAccess({ id: userId, role: userData.role || role, ...userData });
    const refreshToken = signRefresh(userId, familyId);

    res.json({
      accessToken,
      refreshToken,
      user: {
        id:          userId,
        name:        userData.full_name || userData.name || 'User',
        email:       userData.email || null,
        role:        role,
        class_grade: userData.class_grade || null,
      }
    });
  } catch (err) {
    log.error({ err: err.message }, 'verify-otp error');
    res.status(500).json({ message: 'Failed to verify OTP.' });
  }
});

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

    const newRefresh  = signRefresh(decoded.id, decoded.fam);
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

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', authenticate, (req, res) => {
  // Token is stateless — client discards it. No DB cleanup needed.
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

    res.json({ message: 'Password updated successfully. You can now log in.' });
  } catch (err) {
    log.error({ err: err.message }, 'reset-password error');
    res.status(500).json({ error: 'Password reset failed. Please try again.' });
  }
});

module.exports = router;
