'use strict';
// Route that triggers the telemetry exporter. Called by Cloud Scheduler.
// Mount in server.js:  app.use('/api/internal', require('./routes/telemetry_export'));

const router = require('express').Router();
const { runExport } = require('../lib/telemetry_exporter');

// AUTH: this endpoint must NOT be public. Two simple protections:
//  1. A shared secret in a header (set EXPORT_SECRET in env + in the Scheduler job).
//  2. (Optional) restrict to Cloud Scheduler's OIDC token in production.
function checkSecret(req, res, next) {
  const secret = process.env.EXPORT_SECRET;
  if (!secret) return res.status(500).json({ error: 'EXPORT_SECRET not set' });
  if (req.get('x-export-secret') !== secret) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

router.post('/telemetry-export', checkSecret, async (req, res) => {
  try {
    const result = await runExport({ limitPerCollection: 500 });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Telemetry export failed:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// CERT-In: purge audit logs older than the retention window (≥180 days).
// Scheduled daily via Cloud Scheduler hitting this secured endpoint.
router.post('/audit-retention-sweep', checkSecret, async (req, res) => {
  try {
    const { purgeOldAuditLogs } = require('../lib/auditRetention');
    const { query } = require('../lib/db');
    const purged = await purgeOldAuditLogs(query);
    res.json({ ok: true, purged });
  } catch (err) {
    console.error('Audit retention sweep failed:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

module.exports = router;