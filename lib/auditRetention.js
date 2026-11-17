'use strict';
// CERT-In Directions 2022: retain security logs for a MINIMUM of 180 days.
// This purges only logs OLDER than the configured window (default 400 days,
// comfortably above the 180-day floor). Never set below 180.
const log = require('./logger');

const RETENTION_DAYS = Math.max(180, parseInt(process.env.AUDIT_RETENTION_DAYS, 10) || 400);

// Firestore version (the old one ran a Postgres DELETE on a database MITRA
// no longer has). Audit entries are in the `audit_log` collection; some store
// created_at as a Date, older ones as an ISO string — both are swept.
// At most `maxDocs` per run (default 5000) so one press stays quick and cheap;
// `more: true` means press it again.
async function purgeOldAuditLogs(db, { maxDocs = 5000 } = {}) {
  const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoffDate.toISOString();
  let purged = 0;
  let more = false;
  try {
    for (const cutoff of [cutoffDate, cutoffIso]) {
      for (;;) {
        const left = maxDocs - purged;
        if (left <= 0) { more = true; break; }
        const snap = await db.collection('audit_log')
          .where('created_at', '<', cutoff).limit(Math.min(400, left)).get();
        if (snap.empty) break;
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        purged += snap.size;
        if (snap.size < Math.min(400, left)) break;
      }
    }
    log.info({ retentionDays: RETENTION_DAYS, cutoff: cutoffIso, purged, more }, 'Audit log retention sweep');
    return { purged, more, cutoff: cutoffIso, retention_days: RETENTION_DAYS };
  } catch (err) {
    log.error({ err: err.message }, 'Audit retention purge failed');
    throw err;
  }
}
module.exports = { purgeOldAuditLogs, RETENTION_DAYS };