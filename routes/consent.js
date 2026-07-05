'use strict';
const router = require('express').Router();
const { getFirestore } = require('../lib/firebase');
const { authenticate } = require('../middleware/auth');

// Consent endpoints are called by the Flutter app before authentication
router.get('/status', async (req, res) => {
  try {
    const { student_id } = req.query;
    if (!student_id) return res.status(400).json({ error: 'student_id required' });
    const db  = getFirestore();
    const doc = await db.collection('consent_records').doc(student_id).get();
    res.json(doc.exists ? doc.data() : { student_id, granted: false, version: null });
  } catch { res.json({ granted: false }); }
});

router.post('/grant', async (req, res) => {
  try {
    const { student_id, consents, version } = req.body;
    if (!student_id) return res.status(400).json({ error: 'student_id required' });
    const db = getFirestore();
    await db.collection('consent_records').doc(student_id).set({
      student_id, consents, version, granted: true, granted_at: new Date()
    }, { merge: true });
    res.json({ success: true, student_id });
  } catch { res.status(500).json({ error: 'Consent save failed' }); }
});

router.post('/revoke', authenticate, async (req, res) => {
  try {
    const { student_id } = req.body;
    const db = getFirestore();
    await db.collection('consent_records').doc(student_id).update({ granted: false, revoked_at: new Date() });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Revoke failed' }); }
});

module.exports = router;
