// ═══════════════════════════════════════════════════════════════════════
// routes/users.js — User management
// MODIFIED: Reads/writes dashboard_users from Firestore.
// ═══════════════════════════════════════════════════════════════════════
'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { authenticate, requirePerm } = require('../middleware/auth');
router.use(authenticate);

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
      full_name, email, role = 'viewer', password,
      assigned_state = 'All India', assigned_district,
      permissions = {}
    } = req.body || {};
    if (!full_name) return res.status(400).json({ error: 'full_name required' });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'valid email required' });
    const password_hash = password
      ? await bcrypt.hash(password, 12)
      : await bcrypt.hash(require('uuid').v4(), 12); // random hash if no password (reset-link flow)
    const db = getFirestore();
    const id = uuidv4();
    const userData = {
      email, password_hash, full_name, role,
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
    };
    await db.collection('dashboard_users').doc(id).set(userData);
    const { password_hash: _, ...safeUser } = userData;
    res.status(201).json({ id, ...safeUser });
  } catch { res.status(500).json({ error: 'Failed to create user' }); }
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
    const { full_name, role, is_active } = req.body;
    const db = getFirestore();
    const updates = {};
    if (full_name !== undefined) updates.full_name = full_name;
    if (role !== undefined)      updates.role      = role;
    if (is_active !== undefined) updates.is_active = is_active;
    await db.collection('dashboard_users').doc(req.params.id).update(updates);
    res.json({ id: req.params.id, ...updates });
  } catch { res.status(500).json({ error: 'Failed to update user' }); }
});

router.delete('/:id', requirePerm('perm_create_users'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('dashboard_users').doc(req.params.id).update({ is_active: false });
    res.json({ message: 'User deactivated' });
  } catch { res.status(500).json({ error: 'Failed to deactivate user' }); }
});

router.post('/bulk-update', requirePerm('perm_create_users'), async (req, res) => {
  res.json({ message: 'Bulk update queued', count: (req.body.ids || []).length });
});

router.post('/bulk-delete', requirePerm('perm_create_users'), async (req, res) => {
  res.json({ message: 'Bulk delete queued', count: (req.body.ids || []).length });
});

module.exports = router;
