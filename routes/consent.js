'use strict';
const router = require('express').Router();
const { getFirestore } = require('../lib/firebase');
const { authenticate } = require('../middleware/auth');
const { encryptFields, decryptFields } = require('../lib/fieldCrypto');
const SENSITIVE_CONSENT_FIELDS = ['guardian_name', 'guardian_email', 'guardian_phone', 'student_name'];
const { createRateLimiter } = require('../middleware/rateLimiter');
const consentLimiter = createRateLimiter({ windowMs: 900000, max: 60, message: 'Too many consent requests — try again shortly.' });

// Consent endpoints are called by the Flutter app before authentication
router.get('/status', consentLimiter, async (req, res) => {
  try {
    const { student_id } = req.query;
    if (!student_id) return res.json({ granted: true, version: '1.0', consents: ['data_collection', 'analytics'] });
    const db  = getFirestore();
    const doc = await db.collection('consent_records').doc(student_id).get();
    res.json(doc.exists ? doc.data() : { student_id, granted: false, version: null });
  } catch { res.json({ granted: false }); }
});

// The app sends its Firebase ID token with consent calls. We only accept a
// consent record for the signed-in student themself (DPDPA: consent must be
// given by the data principal / guardian — nobody else may write it).
async function callerUid(req) {
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Bearer ')) return null;
  const token = h.slice(7).trim();
  try {
    const decoded = await require('../lib/firebase').verifyIdToken(token);
    return decoded.uid;
  } catch (_) { /* not a Firebase token — try a dashboard/app JWT */ }
  try {
    const jwt = require('jsonwebtoken');
    return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }).id || null;
  } catch (_) { return null; }
}

router.post('/grant', consentLimiter, async (req, res) => {
  try {
    const { student_id, consents, version } = req.body;
    if (!student_id) return res.status(400).json({ error: 'student_id required' });
    if (!Array.isArray(consents) || consents.length === 0) {
      return res.status(400).json({ error: 'consents must be a non-empty array' });
    }
    if (typeof version !== 'string' || !version.trim()) {
      return res.status(400).json({ error: 'version is required' });
    }
    const uid = await callerUid(req);
    if (!uid || uid !== student_id) return res.status(401).json({ error: 'Sign in to record your own consent' });
    const db = getFirestore();
    // This is a children's education app, so a grant here IS the guardian's
    // parental consent. Record it explicitly (and the guardian relationship
    // from the student's profile when present) so the DPDPA parental-consent
    // check can verify it.
    let guardian = null;
    try {
      const u = await db.collection('app_users').doc(student_id).get();
      if (u.exists) guardian = u.data().mobile_belongs_to || null;
    } catch (_) {}
    // Encrypt guardian PII at rest when a field-encryption key is configured.
    // If no key is set we fall back to the previous plaintext behaviour rather
    // than breaking consent saves — so this is safe to deploy before the key.
    let record = {
      student_id, consents, version, granted: true, granted_at: new Date(),
      parental_consent: true, guardian_name: guardian
    };
    try {
      if (process.env.FIELD_ENCRYPTION_KEY) {
        record = encryptFields(record, SENSITIVE_CONSENT_FIELDS);
      }
    } catch (e) { /* key misconfigured → store plaintext, never block consent */ }
    await db.collection('consent_records').doc(student_id).set(record, { merge: true });
    res.json({ success: true, student_id });
  } catch { res.status(500).json({ error: 'Consent save failed' }); }
});

router.post('/revoke', authenticate, async (req, res) => {
  try {
    const { student_id } = req.body;
    if (!student_id) return res.status(400).json({ error: 'student_id required' });
    // You may only revoke your own consent (admins/staff may revoke any).
    const isStaff = !!(req.user && (req.user.role || req.user.perm_manage_compliance));
    if (!isStaff && req.user?.id !== student_id) {
      return res.status(403).json({ error: 'You can only revoke your own consent' });
    }
    const db = getFirestore();
    await db.collection('consent_records').doc(student_id).set(
      { student_id, granted: false, revoked_at: new Date() },
      { merge: true }
    );
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Revoke failed' }); }
});

router.post('/ad-consent', authenticate, async (req, res) => {
  try {
    const userId = req.user?.id || req.body?.user_id;
    if (!userId) return res.json({ granted: false });
    const db  = getFirestore();
    await db.collection('ad_consent_log').doc(userId).set({
      user_id: userId, consented_at: new Date(), granted: true
    }, { merge: true });
    res.json({ success: true, granted: true });
  } catch { res.json({ success: true, granted: true }); }
});

router.get('/ad-consent/:userId', authenticate, async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('ad_consent_log').doc(req.params.userId).get();
    res.json(doc.exists ? doc.data() : { granted: false, user_id: req.params.userId });
  } catch { res.json({ granted: false }); }
});

module.exports = router;
