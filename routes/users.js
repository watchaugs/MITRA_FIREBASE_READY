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
    res.json({ data: users, total: users.length });
  } catch { res.status(500).json({ error: 'Failed to fetch users' }); }
});

router.post('/', requirePerm('perm_create_users'), async (req, res) => {
  try {
    const { email, password, full_name, role = 'viewer' } = req.body;
    if (!email || !password || !full_name) return res.status(400).json({ error: 'email, password, full_name required' });
    const password_hash = await bcrypt.hash(password, 12);
    const db = getFirestore();
    const id = uuidv4();
    await db.collection('dashboard_users').doc(id).set({ email, password_hash, full_name, role, is_active: true, created_at: new Date() });
    res.status(201).json({ id, email, full_name, role });
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
