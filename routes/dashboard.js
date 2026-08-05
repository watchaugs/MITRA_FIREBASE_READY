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
    const [apps, users, assets, quizzes, campaigns] = await Promise.all([
      db.collection('app_builds').where('status', '==', 'live').get(),
      db.collection('dashboard_users').where('is_active', '==', true).get(),
      db.collection('ar_assets').where('status', '==', 'published').get(),
      db.collection('quizzes').where('status', '==', 'published').get(),
      db.collection('ad_campaigns').where('status', '==', 'active').get(),
    ]);
    // Count unique student_ids from telemetry_sessions
    let active_students = 0;
    try {
      const studentSnap = await db.collection('telemetry_sessions')
        .select('student_id').limit(5000).get();
      active_students = new Set(studentSnap.docs.map(d => d.data().student_id)).size;
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
    });
  } catch (err) {
    log.error({ err: err.message }, 'Dashboard summary failed — returning zeros');
    res.json({ live_apps: 0, user_accounts: 0, published_assets: 0, published_quizzes: 0, live_ad_campaigns: 0, active_students: 0 });
  }
});

module.exports = router;
