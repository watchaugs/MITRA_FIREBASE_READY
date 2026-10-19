'use strict';
const router = require('express').Router();
const multer  = require('multer');
const { v4: uuidv4 } = require('uuid');
const { authenticate, requirePerm } = require('../middleware/auth');
const { getFirestore } = require('../lib/firebase');
const { filterByState, canAccessState, visibleInState } = require('../lib/stateScope');
const storage = require('../lib/storage');
const log = require('../lib/logger');
const { isAppCaller } = require('../lib/release');
const tms = (v) => (v && typeof v.toDate === 'function') ? v.toDate().getTime() : (v ? new Date(v).getTime() : null);
// A campaign reaches phones only when it is live (or scheduled and its start
// date has passed) and it has not expired.
function isRunning(a, now = Date.now()) {
  if (!['live', 'scheduled'].includes(a.status)) return false;
  const start = tms(a.publish_at), end = tms(a.expires_at);
  if (start && start > now) return false;
  if (end && end < now) return false;
  // Optional publishing days (India time): ['mon','tue',…]; empty = every day
  if (Array.isArray(a.publish_days) && a.publish_days.length) {
    const day = new Date(now + 5.5 * 3600000).getUTCDay();          // IST weekday
    const key = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day];
    if (!a.publish_days.includes(key)) return false;
  }
  return true;
}
router.use(authenticate);
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

// ── GET /  — List all ad campaigns ───────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('ad_campaigns').orderBy('created_at', 'desc').limit(100).get();
    // National admins see all; a state user sees their own state's ads + national (stateless) ads.
    const all  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    let data   = all.filter(a => !a.state || canAccessState(req, a.state));
    // App-facing geofence: when a device passes ?state, keep national + that state's ads
    if (req.query.state) data = visibleInState(data, req.query.state);
    // Students never receive drafts, paused, future or expired campaigns.
    if (isAppCaller(req)) data = data.filter(a => isRunning(a)).map(a => ({ ...a, status: 'live' }));
    res.json({ data, total: data.length });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load ad campaigns');
    res.status(500).json({ error: 'Failed to load ad campaigns' });
  }
});

// ── Change #27: POST /upload — Ad creative file upload ───────────────────────
router.post('/upload', requirePerm('perm_manage_ads'), memUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  try {
    const result = await storage.put('ad_media', req.file.originalname, req.file.buffer);
    const id = uuidv4();
    const doc = {
      id, category: 'ad_media',
      storage_key: result.key,
      original_name: result.originalName,
      size: result.size,
      uploaded_by: req.user.id,
      created_at: new Date(),
    };
    await getFirestore().collection('uploads').doc(id).set(doc);
    const url = `/api/uploads/file/${encodeURIComponent(result.key)}`;
    res.status(201).json({ ...doc, url });
  } catch (err) {
    log.error({ err: err.message }, 'Ad creative upload failed');
    res.status(err.status || 500).json({ error: err.message || 'Upload failed' });
  }
});

// ── GET /kpi  — Aggregate stats ───────────────────────────────────────────────
// NOTE: /kpi must be declared BEFORE /:id to avoid Express matching 'kpi' as an id
router.get('/kpi', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('ad_campaigns').get();
    const ads  = snap.docs.map(d => d.data());
    const total_impressions = ads.reduce((s, a) => s + (a.impressions || 0), 0);
    const total_clicks      = ads.reduce((s, a) => s + (a.clicks || 0), 0);
    const active_campaigns  = ads.filter(a => isRunning(a)).length;
    const ctr = total_impressions > 0
      ? parseFloat(((total_clicks / total_impressions) * 100).toFixed(2))
      : 0;
    let daily_push = null;
    try { const f = await db.collection('ad_settings').doc('frequency').get(); if (f.exists) daily_push = f.data().daily_push ?? f.data().cap ?? null; } catch (_) {}
    res.json({ total_impressions, total_clicks, active_campaigns, ctr, total_spend: 0,
      states_targeted: new Set(ads.flatMap(a => a.target_states || [])).size,
      reach: new Set(ads.flatMap(a => a.target_states || [])).size, daily_push });
  } catch (_) {
    res.json({ total_impressions: 0, total_clicks: 0, active_campaigns: 0, ctr: 0, total_spend: 0, reach: 0 });
  }
});

// ── GET /frequency  — Ad frequency cap settings ───────────────────────────────
router.get('/frequency', async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('ad_settings').doc('frequency').get();
    res.json(doc.exists ? doc.data() : { cap: 3, window_hours: 24 });
  } catch (_) {
    res.json({ cap: 3, window_hours: 24 });
  }
});

// ── PUT /frequency  — Update frequency cap ────────────────────────────────────
router.put('/frequency', requirePerm('perm_manage_ads'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('ad_settings').doc('frequency').set({ ...req.body, updated_at: new Date() }, { merge: true });
    res.json({ success: true, ...req.body });
  } catch (_) {
    res.status(500).json({ error: 'Failed to update frequency settings' });
  }
});

// ── GET /impressions  — Impression log ────────────────────────────────────────
router.get('/impressions', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('ad_impressions').orderBy('created_at', 'desc').limit(500).get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ data, total: data.length });
  } catch (_) {
    res.json({ data: [], total: 0 });
  }
});

// POST /impressions — the student app records that an ad was shown.
// Never fail the app: always acknowledge so the client doesn't retry-loop.
router.post('/impressions', async (req, res) => {
  try {
    const db = getFirestore();
    const adId = String(req.body?.ad_id || req.body?.campaign_id || '');
    // One write per impression (same as before), but now it moves the campaign's
    // counter, so the Ads KPIs and CTR are real instead of always 0.
    if (adId) {
      const { FieldValue } = require('firebase-admin/firestore');
      await db.collection('ad_campaigns').doc(adId).set({ impressions: FieldValue.increment(1), last_impression_at: new Date() }, { merge: true });
    }
    res.status(202).json({ received: true });
  } catch (_) {
    res.status(202).json({ received: true, queued: true });
  }
});

// POST /engagement — richer ad interaction depth from the student app.
// Stores click / view-time / completion events; bumps click counter only.
// One or two Firestore writes per call; no compute, scale-to-zero safe.
router.post('/engagement', async (req, res) => {
  try {
    const db = getFirestore();
    const b  = req.body || {};
    await db.collection('ad_engagement').add({
      campaign_id:     b.campaign_id || null,
      event_type:      b.event_type || 'view',   // 'view' | 'click' | 'complete' | 'skip'
      view_time_ms:    typeof b.view_time_ms === 'number' ? b.view_time_ms : null,
      completed:       b.completed === true,
      completion_pct:  typeof b.completion_pct === 'number' ? b.completion_pct : null,
      media_type:      b.media_type || null,      // 'image' | 'video'
      state:           b.state || null,
      district:        b.district || null,
      student_id:      b.student_id || null,
      created_at:      new Date(),
      source:          'student_app',
    });
    // Best-effort live click counter for the /kpi CTR tile (never double-counts impressions).
    if (b.campaign_id && b.event_type === 'click') {
      try {
        const { FieldValue } = require('firebase-admin/firestore');
        await db.collection('ad_campaigns').doc(b.campaign_id)
          .set({ clicks: FieldValue.increment(1) }, { merge: true });
      } catch (_) { /* counter is best-effort; never fail the app */ }
    }
    res.status(202).json({ received: true });
  } catch (_) {
    res.status(202).json({ received: true, queued: true });
  }
});

// ── GET /analytics/overview  ──────────────────────────────────────────────────
router.get('/analytics/overview', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('ad_campaigns').where('status', '==', 'live').get();
    const ads  = snap.docs.map(d => d.data());
    const impressions = ads.reduce((s, a) => s + (a.impressions || 0), 0);
    const clicks      = ads.reduce((s, a) => s + (a.clicks || 0), 0);
    res.json({
      impressions, clicks,
      ctr:    impressions > 0 ? parseFloat(((clicks / impressions) * 100).toFixed(2)) : 0,
      active: snap.size,
    });
  } catch (_) {
    res.json({ impressions: 0, clicks: 0, ctr: 0, active: 0 });
  }
});

// ── GET /:id  ─────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('ad_campaigns').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (_) {
    res.status(500).json({ error: 'Failed to fetch ad' });
  }
});

// ── POST /  — Create ad campaign ─────────────────────────────────────────────
// ── Departmental-notice guardrail (DPDPA / scope) ────────────────────────────
// This module is ONLY for school/departmental information — quiz competitions,
// exams, official declarations — NOT product or service promotions. This check
// blocks obvious commercial campaigns before they can be created or published.
const COMMERCIAL_TERMS = [
  'buy now', 'discount', 'sale', 'offer', 'coupon', 'cashback', 'shop',
  'order now', 'price', '% off', 'limited offer', 'subscribe', 'free trial',
  'brand', 'sponsor', 'promo code', 'lowest price', 'book now', 'deal'
];
function noticeScopeError(b) {
  const hay = [b.name, b.title, b.description, b.cta_text, b.body]
    .filter(Boolean).join(' ').toLowerCase();
  const hit = COMMERCIAL_TERMS.find(t => hay.includes(t));
  if (hit) {
    return 'This module is for departmental notices only (quiz competitions, '
      + 'exams, official school declarations). Content that reads as a product '
      + 'or service promotion ("' + hit + '") is not allowed.';
  }
  return null;
}

router.post('/', requirePerm('perm_manage_ads'), async (req, res) => {
  try {
    const db  = getFirestore();
    const id  = uuidv4();
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Campaign name is required' });
    const scopeErr = noticeScopeError(b);
    if (scopeErr) return res.status(422).json({ error: scopeErr });
    const doc = { ...b, id,
                  status: b.status === 'scheduled' ? 'scheduled' : 'draft',
                  target_states: Array.isArray(b.target_states) ? b.target_states : [],
                  impressions: 0, clicks: 0,
                  created_by: req.user.id, created_at: new Date() };
    await db.collection('ad_campaigns').doc(id).set(doc);
    res.status(201).json(doc);
  } catch (err) {
    log.error({ err: err.message }, 'Failed to create ad campaign');
    res.status(500).json({ error: 'Failed to create ad campaign' });
  }
});

// ── PUT /:id  — Update ad campaign ───────────────────────────────────────────
router.put('/:id', requirePerm('perm_manage_ads'), async (req, res) => {
  try {
    const db  = getFirestore();
    const ref = db.collection('ad_campaigns').doc(req.params.id);
    const cur = await ref.get();
    if (!cur.exists) return res.status(404).json({ error: 'Not found' });
    if (cur.data().state && !canAccessState(req, cur.data().state)) {
      return res.status(403).json({ error: 'Your account cannot edit this state\'s campaign.' });
    }
    // Re-check scope on edit using the merged result, so clean content can't be
    // created then edited into a commercial promotion.
    const scopeErr = noticeScopeError({ ...cur.data(), ...req.body });
    if (scopeErr) return res.status(422).json({ error: scopeErr });
    // Never let the client overwrite system-owned fields (counters, ownership,
    // id, or publish state) via a plain edit. Publishing has its own endpoint.
    const safe = { ...req.body };
    ['id', 'impressions', 'clicks', 'created_by', 'created_at',
     'published_at', 'published_by', 'status', 'last_impression_at'].forEach(k => delete safe[k]);
    await ref.update({ ...safe, updated_at: new Date() });
    res.json({ id: req.params.id, ...safe });
  } catch (err) {
    log.error({ err: err.message, id: req.params.id }, 'Failed to update ad campaign');
    res.status(500).json({ error: 'Failed to update ad campaign' });
  }
});

// ── DELETE /:id  — Delete ad campaign ────────────────────────────────────────
router.delete('/:id', requirePerm('perm_manage_ads'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('ad_campaigns').doc(req.params.id).delete();
    res.json({ message: 'Ad campaign deleted' });
  } catch (err) {
    log.error({ err: err.message, id: req.params.id }, 'Failed to delete ad campaign');
    res.status(500).json({ error: 'Failed to delete ad campaign' });
  }
});

// ── POST /:id/publish  — Go live ─────────────────────────────────────────────
router.post('/:id/publish', requirePerm('perm_manage_ads'), async (req, res) => {
  try {
    const db = getFirestore();
    const snap = await db.collection('ad_campaigns').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'Not found' });
    const scopeErr = noticeScopeError(snap.data());
    if (scopeErr) return res.status(422).json({ error: scopeErr });
    await db.collection('ad_campaigns').doc(req.params.id)
      .update({ status: 'live', published_at: new Date(), published_by: req.user.id });
    res.json({ message: 'Ad campaign published', id: req.params.id });
  } catch (err) {
    log.error({ err: err.message, id: req.params.id }, 'Ad publish failed');
    res.status(500).json({ error: 'Publish failed' });
  }
});

module.exports = router;