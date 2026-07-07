'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { authenticate, requirePerm } = require('../middleware/auth');
const { getFirestore } = require('../lib/firebase');
const { State } = require('country-state-city');
router.use(authenticate);

// ── GET /files  — List all state-specific app builds ─────────────────────────
router.get('/files', requirePerm('perm_publish_apps'), async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('app_builds').orderBy('created_at', 'desc').limit(100).get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ data, total: data.length });
  } catch (_) {
    res.json({ data: [], total: 0 });
  }
});

// ── POST /files  — Trigger a new state app build ──────────────────────────────
router.post('/files', requirePerm('perm_publish_apps'), async (req, res) => {
  try {
    const db  = getFirestore();
    const id  = uuidv4();
    const doc = {
      id,
      ...req.body,
      build_status: 'building',
      active_students: 0,
      file_size_mb: null,
      built_by: req.user.full_name || req.user.id,
      created_by: req.user.id,
      created_at: new Date(),
    };
    await db.collection('app_builds').doc(id).set(doc);
    res.status(201).json({ success: true, ...doc });
  } catch (_) {
    res.status(500).json({ error: 'Failed to create build record' });
  }
});

// ── GET /states  — All Indian states (live from package) ─────────────────────
router.get('/states', async (req, res) => {
  const states = State.getStatesOfCountry('IN').map(s => ({ code: s.isoCode, name: s.name }));
  res.json(states);
});

module.exports = router;