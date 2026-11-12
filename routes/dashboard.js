/**
 * routes/dashboard.js — Dashboard summary KPIs
 */
const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const log = require('../lib/logger');
router.use(authenticate);

router.get('/summary', async (req, res) => {
  try {
    const db = require('../lib/firebase').getFirestore();
    const [apps, users, assets, quizzes, campaigns, geofences, reviews] = await Promise.all([
      db.collection('app_builds').where('status', '==', 'live').get(),
      db.collection('dashboard_users').where('is_active', '==', true).get(),
      db.collection('ar_assets').where('status', '==', 'published').get(),
      db.collection('quizzes').where('status', '==', 'published').get(),
      db.collection('ad_campaigns').where('status', '==', 'active').get(),
      db.collection('geofences').where('is_active', '==', true).get(),
      db.collection('ar_assets').where('status', '==', 'review').get(),
    ]);
    // Count unique student_ids from per-student 'sessions' subcollections
    // (the app writes students/{id}/sessions, read via collectionGroup).
    let active_students = 0;
    try {
      // Each 'sessions' doc is a BATCH wrapper holding batched_events[]; the
      // student_id lives inside those events, not on the wrapper — so read the
      // full doc and unwrap (a .select('student_id') projection returns nothing).
      const studentSnap = await db.collectionGroup('sessions').limit(5000).get();
      const ids = new Set();
      studentSnap.docs.forEach(d => {
        const data = d.data() || {};
        const arr = Array.isArray(data.batched_events) ? data.batched_events : [data];
        arr.forEach(e => { if (e && e.student_id) ids.add(e.student_id); });
      });
      active_students = ids.size;
    } catch (err) {
      log.error({ err: err.message }, 'Failed to count active students');
    }

    res.json({
      live_apps:         apps.size,
      user_accounts:     users.size,
      published_assets:  assets.size,
      published_quizzes: quizzes.size,
      live_ad_campaigns: campaigns.size,
      active_students,
      active_geofences:  geofences.size,   // was missing → card always showed 0
      pending_approvals: reviews.size,     // was missing → Pending Reviews always 0
    });
  } catch (err) {
    log.error({ err: err.message }, 'Dashboard summary failed — returning zeros');
    res.json({ live_apps: 0, user_accounts: 0, published_assets: 0, published_quizzes: 0, live_ad_campaigns: 0, active_students: 0, active_geofences: 0, pending_approvals: 0 });
  }
});

module.exports = router;
