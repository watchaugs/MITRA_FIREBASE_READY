// ═══════════════════════════════════════════════════════════════════════
// routes/users.js — User management
// MODIFIED: Reads/writes dashboard_users from Firestore.
// ═══════════════════════════════════════════════════════════════════════
'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { authenticate, requirePerm, canGrantRole } = require('../middleware/auth');
const { sendWelcomeEmail } = require('../lib/mailer');
const log = require('../lib/logger');
router.use(authenticate);

// Server-enforced permissions (the ones requirePerm() checks in routes/*.js).
const BACKEND_PERMS = ['perm_publish_apps','perm_upload_unity','perm_manage_geo','perm_view_analytics',
  'perm_create_users','perm_edit_curriculum','perm_approve_content','perm_export_data','perm_manage_ads',
  'perm_replay_analytics','perm_manage_compliance','perm_send_notif','perm_view_legal'];

// The dashboard sends the ticked boxes as an array of perm keys. Older code sent
// a grouped object — still accepted. Returns the perm_* fields + the full list.
function permFieldsFrom(permissions) {
  if (Array.isArray(permissions)) {
    const ui  = permissions.filter(k => typeof k === 'string' && /^perm_[a-z_]+$/.test(k));
    const set = new Set(ui);
    const fields = {};
    BACKEND_PERMS.forEach(k => { fields[k] = set.has(k); });
    return { fields, ui };
  }
  const p = permissions || {};
  return { ui: null, fields: {
    perm_manage_geo:      p.geofence === true,
    perm_create_users:    p.users === true,
    perm_edit_curriculum: p.ar_curriculum === true,
    perm_upload_unity:    p.ar_curriculum === true,
    perm_view_analytics:  p.analytics === true,
    perm_publish_apps:    p.notifications === true,
  } };
}

router.get('/', requirePerm('perm_create_users'), async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('dashboard_users').get();
    const users = snap.docs.map(d => {
      const data = { id: d.id, ...d.data() };
      delete data.password_hash;
      return data;
    });
    // Support both response shapes the dashboard uses
    res.json({ data: users, users, total: users.length });
  } catch { res.status(500).json({ error: 'Failed to fetch users' }); }
});

router.post('/', requirePerm('perm_create_users'), async (req, res) => {
  try {
    const {
      full_name, email, role = 'viewer',
      assigned_state = 'All India', assigned_district,
      permissions = {}
    } = req.body || {};
    if (!full_name) return res.status(400).json({ error: 'full_name required' });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'valid email required' });
    if (!canGrantRole(req.user.role, role)) {
      return res.status(403).json({ error: 'You cannot grant a role higher than your own' });
    }

    // Always use a random placeholder hash — user sets their real password via the emailed link
    const password_hash = await bcrypt.hash(uuidv4(), 12);

    const db = getFirestore();
    const dupe = await db.collection('dashboard_users').where('email', '==', String(email).toLowerCase()).limit(1).get();
    if (!dupe.empty) return res.status(409).json({ error: `A user with ${email} already exists` });
    const id = uuidv4();
    const mapped = permFieldsFrom(permissions);
    const userData = {
      email: String(email).toLowerCase(), password_hash, full_name, role,
      assigned_state, assigned_district: assigned_district || null,
      is_active: true, created_at: new Date(),
      perm_manage_geo:       permissions.geofence       === true,
      perm_create_users:     permissions.users          === true,
      perm_edit_curriculum:  permissions.ar_curriculum  === true,
      perm_upload_unity:     permissions.ar_curriculum  === true,
      perm_view_analytics:   permissions.analytics      === true,
      perm_publish_apps:     permissions.notifications  === true,
      perm_approve_content:  false,
      perm_export_data:      false,
      perm_manage_ads:       false,
      perm_replay_analytics: false,
      ...mapped.fields,
      ...(mapped.ui ? { ui_permissions: mapped.ui } : {}),
    };
    await db.collection('dashboard_users').doc(id).set(userData);

    // Generate setup token and fire welcome email — non-blocking
    const crypto = require('crypto');
    const setupToken   = crypto.randomBytes(32).toString('hex');
    const setupExpires = Date.now() + 1000 * 60 * 60 * 24; // 24 hours
    const setupUrl     = `${process.env.APP_BASE_URL}/reset?token=${setupToken}`;
    await db.collection('password_reset_tokens').doc(setupToken).set({
      userId: id, email, expiresAt: setupExpires, used: false,
    });
    sendWelcomeEmail({ to: email, full_name, role, setupUrl })
      .then(() => log.info({ userId: id, email }, 'Welcome/setup email sent'))
      .catch(err => log.error({ err: err.message, userId: id }, 'Welcome email failed — account still created'));

    const { password_hash: _, ...safeUser } = userData;
    res.status(201).json({ id, ...safeUser, _emailQueued: true });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to create user');
    res.status(500).json({ error: 'Failed to create user' });
  }
});

router.get('/:id', requirePerm('perm_create_users'), async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('dashboard_users').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const data = { id: doc.id, ...doc.data() };
    delete data.password_hash;
    res.json(data);
  } catch { res.status(500).json({ error: 'Failed to fetch user' }); }
});

router.put('/:id', requirePerm('perm_create_users'), async (req, res) => {
  try {
    const { full_name, role, is_active, permissions, mfa_required } = req.body;
    if (role !== undefined && !canGrantRole(req.user.role, role)) {
      return res.status(403).json({ error: 'You cannot grant a role higher than your own' });
    }
    if (req.params.id === req.user.id && is_active === false) {
      return res.status(400).json({ error: 'You cannot disable your own account' });
    }
    const db = getFirestore();
    const updates = { updated_at: new Date() };
    if (full_name !== undefined) updates.full_name = full_name;
    if (role !== undefined)      updates.role      = role;
    if (is_active !== undefined) updates.is_active = is_active === true;
    if (mfa_required !== undefined) updates.mfa_required = mfa_required === true;
    if (permissions !== undefined) {
      const mapped = permFieldsFrom(permissions);
      Object.assign(updates, mapped.fields);
      if (mapped.ui) updates.ui_permissions = mapped.ui;
    }
    await db.collection('dashboard_users').doc(req.params.id).update(updates);
    try { require('../middleware/auth').invalidateUserCache?.(req.params.id); } catch (_) {}
    res.json({ success: true, id: req.params.id, ...updates,
      note: 'Permission changes apply the next time this user signs in.' });
  } catch { res.status(500).json({ error: 'Failed to update user' }); }
});

router.delete('/:id', requirePerm('perm_create_users'), async (req, res) => {
  try {
    const db = getFirestore();
    const docRef = db.collection('dashboard_users').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    await docRef.delete();
    res.json({ message: 'User deleted' });
  } catch { res.status(500).json({ error: 'Failed to delete user' }); }
});

router.post('/bulk-update', requirePerm('perm_create_users'), async (req, res) => {
  try {
    const { ids = [] } = req.body || {};
    // Accept both { ids, updates: {...} } and the flat { ids, role } / { ids, is_active } the dashboard sends.
    const updates = req.body.updates || {
      ...(req.body.role !== undefined ? { role: req.body.role } : {}),
      ...(req.body.is_active !== undefined ? { is_active: req.body.is_active === true } : {}),
    };
    if (!ids.length) return res.status(400).json({ error: 'No user ids provided' });
    const allowed = ['role', 'is_active', 'assigned_state', 'assigned_district'];
    const safeUpdates = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(safeUpdates).length) return res.status(400).json({ error: 'No valid fields to update' });
    if (safeUpdates.role && !canGrantRole(req.user.role, safeUpdates.role)) {
      return res.status(403).json({ error: 'You cannot grant a role higher than your own' });
    }
    const db = getFirestore();
    const batch = db.batch();
    ids.forEach(id => batch.update(db.collection('dashboard_users').doc(id), safeUpdates));
    await batch.commit();
    res.json({ success: true, message: 'Users updated', count: ids.length });
  } catch (err) {
    log.error({ err: err.message }, 'bulk-update error');
    res.status(500).json({ error: 'Bulk update failed' });
  }
});

router.post('/bulk-delete', requirePerm('perm_create_users'), async (req, res) => {
  try {
    const ids = (req.body.ids || []).filter(id => id !== req.user.id);
    if (!ids.length) return res.status(400).json({ error: 'No user ids provided (you cannot remove yourself)' });
    const db = getFirestore();
    const batch = db.batch();
    // Deactivate (reversible) — the dashboard button says "Deactivate".
    ids.forEach(id => {
      batch.update(db.collection('dashboard_users').doc(id), { is_active: false, deactivated_by: req.user.id, deactivated_at: new Date() });
    });
    await batch.commit();
    res.json({ success: true, message: 'Users deactivated', count: ids.length });
  } catch (err) {
    log.error({ err: err.message }, 'bulk-delete error');
    res.status(500).json({ error: 'Bulk delete failed' });
  }
});

module.exports = router;
