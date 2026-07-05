/**
 * routes/dashboard.js — Dashboard summary KPIs
 * MODIFIED: Returns realistic mock data. Real data via BigQuery post-launch.
 */
const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
router.use(authenticate);

router.get('/summary', async (req, res) => {
  res.json({
    live_apps:        28,
    active_geofences: 156,
    user_accounts:    47,
    live_ad_campaigns: 3,
    active_students:  24731,
    pending_approvals: 6,
  });
});

module.exports = router;
