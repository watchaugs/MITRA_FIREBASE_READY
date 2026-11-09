'use strict';
// CERT-In Directions 2022: retain security logs for a MINIMUM of 180 days.
// This purges only logs OLDER than the configured window (default 400 days,
// comfortably above the 180-day floor). Never set below 180.
const log = require('./logger');

const RETENTION_DAYS = Math.max(180, parseInt(process.env.AUDIT_RETENTION_DAYS, 10) || 400);

async function purgeOldAuditLogs(query) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const res = await query(`DELETE FROM audit_logs WHERE created_at < $1`, [cutoff]);
    log.info({ retentionDays: RETENTION_DAYS, cutoff, purged: res?.rowCount ?? 0 }, 'Audit log retention sweep');
    return res?.rowCount ?? 0;
  } catch (err) {
    log.error({ err: err.message }, 'Audit retention purge failed');
    return 0;
  }
}
module.exports = { purgeOldAuditLogs, RETENTION_DAYS };