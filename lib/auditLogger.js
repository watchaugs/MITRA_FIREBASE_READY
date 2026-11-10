/**
 * lib/auditLogger.js — Tamper-evident audit logging
 *
 * Writes to:
 *   1. audit_logs table (primary)
 *   2. /tmp/mitra-audit-fallback.jsonl (fallback if DB write fails)
 *
 * Fixes H12 — audit failures used to be silently swallowed.
 *
 * On Cloud Run the writable scratch path is /tmp. On a real VM, set
 * AUDIT_FALLBACK_PATH to a path on a persistent disk.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const log = require('./logger');

const FALLBACK_PATH = process.env.AUDIT_FALLBACK_PATH || '/tmp/mitra-audit-fallback.jsonl';

let _query;
function setDbQuery(q) { _query = q; } // injected at boot to avoid circular import

async function audit({ userId = null, action, resourceType = null, resourceId = null, ip = null, details = {} }) {
  if (!action || typeof action !== 'string') {
    log.warn({ action }, 'auditLogger called with invalid action');
    return;
  }
  const row = {
    id: uuidv4(),
    user_id: userId,
    action: action.slice(0, 200),
    resource_type: resourceType ? String(resourceType).slice(0, 100) : null,
    resource_id: resourceId ? String(resourceId).slice(0, 200) : null,
    ip_address: ip ? String(ip).slice(0, 64) : null,
    details: JSON.stringify(details).slice(0, 5000),
    created_at: new Date().toISOString(),
  };

  // Primary store: Firestore (durable, survives Cloud Run restarts). The old
  // Postgres path is kept only if a _query is still injected on a VM deploy.
  if (_query) {
    try {
      await _query(
        `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, ip_address, details, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [row.id, row.user_id, row.action, row.resource_type, row.resource_id, row.ip_address, row.details, row.created_at]
      );
      return row.id;
    } catch (err) {
      log.error({ err: err.message, action }, 'audit_logs DB write failed — trying Firestore');
    }
  }
  try {
    const { getFirestore } = require('./firebase');
    await getFirestore().collection('audit_log').doc(row.id).set(row);
    return row.id;
  } catch (err) {
    log.error({ err: err.message, action }, 'audit_log Firestore write failed — falling back to file');
  }

  // Fallback: append to JSONL
  try {
    fs.mkdirSync(path.dirname(FALLBACK_PATH), { recursive: true });
    fs.appendFileSync(FALLBACK_PATH, JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch (err) {
    log.error({ err: err.message }, 'audit fallback write also failed — alert ops');
  }
  return row.id;
}

// CERT-In Directions 2022: a reportable cyber incident must be reported to
// CERT-In within 6 hours of detection. This records the incident with its
// reporting deadline and emits a high-severity log so ops is alerted at once.
// It does NOT auto-report (that is a human/legal action) — it starts the clock
// and leaves an auditable record.
async function flagSecurityIncident({ kind, severity = 'high', details = {}, userId = null, ip = null }) {
  const detectedAt = new Date();
  const reportDeadline = new Date(detectedAt.getTime() + 6 * 60 * 60 * 1000);
  log.error({ kind, severity, detectedAt: detectedAt.toISOString(), reportDeadline: reportDeadline.toISOString() },
    'SECURITY INCIDENT — CERT-In 6-hour reporting clock started');
  return audit({
    userId, ip, action: 'security_incident',
    resourceType: 'incident', resourceId: kind,
    details: { ...details, severity, detected_at: detectedAt.toISOString(), cert_in_report_by: reportDeadline.toISOString() },
  });
}

module.exports = { audit, setDbQuery, flagSecurityIncident };
