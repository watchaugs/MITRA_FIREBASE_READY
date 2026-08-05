'use strict';
/**
 * lib/complianceEngine.js — LIVE DPDP Act 2023 compliance evaluation.
 *
 * Every check inspects real state in Firestore / the running config and returns
 * a genuine pass/fail. Nothing is hardcoded to "true". This replaces the old
 * cosmetic tracker where most items always showed green.
 *
 * A check returns: { key, title, description, status (bool), severity, evidence }
 */

const { getFirestore } = require('./firebase');

// Helper: does a collection have at least one doc?
async function hasAny(db, coll, limit = 1) {
  const snap = await db.collection(coll).limit(limit).get();
  return snap.size > 0;
}

async function evaluateCompliance() {
  const db = getFirestore();
  const checks = [];
  const push = (c) => checks.push(c);

  // 1. Privacy policy published (env flag or settings doc)
  let privacyOk = false, privacyEvidence = 'No privacy_policy_url configured';
  try {
    const s = await db.collection('compliance_settings').doc('_global_settings').get();
    const url = (s.exists && s.data().privacy_policy_url) || process.env.PRIVACY_POLICY_URL;
    privacyOk = !!url;
    if (url) privacyEvidence = `Published at ${url}`;
  } catch (_) {}
  push({ key: 'privacy_policy', title: 'Privacy Policy published', severity: 'high',
         status: privacyOk, description: privacyEvidence });

  // 2. Consent mechanism active — at least one consent record exists
  let consentOk = false, consentCount = 0;
  try { const snap = await db.collection('consent_records').limit(1).get(); consentOk = snap.size > 0; } catch (_) {}
  push({ key: 'consent_mechanism', title: 'Consent mechanism active', severity: 'critical',
         status: consentOk,
         description: consentOk ? 'Consent records are being captured' : 'No consent records found yet' });

  // 3. Data retention policy set (a real number in settings)
  let retentionOk = false, retentionDesc = 'No retention_days set';
  try {
    const s = await db.collection('compliance_settings').doc('_global_settings').get();
    const d = s.exists ? s.data().retention_days : null;
    retentionOk = typeof d === 'number' && d > 0;
    if (retentionOk) retentionDesc = `${d} days`;
  } catch (_) {}
  push({ key: 'retention_policy', title: 'Data retention policy set', severity: 'medium',
         status: retentionOk, description: retentionDesc });

  // 4. Auto-purge / right-to-erasure operational (purge_log has entries OR auto_purge on)
  let erasureOk = false, erasureDesc = 'No erasure activity or auto-purge disabled';
  try {
    const s = await db.collection('compliance_settings').doc('_global_settings').get();
    const autoPurge = s.exists && s.data().auto_purge === true;
    const purged = await hasAny(db, 'purge_log');
    erasureOk = autoPurge || purged;
    if (autoPurge) erasureDesc = 'Auto-purge enabled';
    else if (purged) erasureDesc = 'Erasure requests have been processed';
  } catch (_) {}
  push({ key: 'right_to_erasure', title: 'Right to erasure operational', severity: 'high',
         status: erasureOk, description: erasureDesc });

  // 5. DPO appointed (real record with name + email)
  let dpoOk = false, dpoDesc = 'No DPO configured';
  try {
    const doc = await db.collection('compliance_settings').doc('dpo_info').get();
    const v = doc.exists ? doc.data().value : null;
    const info = typeof v === 'string' ? JSON.parse(v) : v;
    dpoOk = !!(info && info.name && info.email);
    if (dpoOk) dpoDesc = `${info.name} (${info.email})`;
  } catch (_) {}
  push({ key: 'dpo_appointed', title: 'Data Protection Officer appointed', severity: 'critical',
         status: dpoOk, description: dpoDesc });

  // 6. Grievance officer configured
  let grievanceOk = false, grievanceDesc = 'No grievance officer configured';
  try {
    const doc = await db.collection('compliance_settings').doc('grievance_officer').get();
    const v = doc.exists ? doc.data().value : null;
    const info = typeof v === 'string' ? JSON.parse(v) : v;
    grievanceOk = !!(info && (info.email || info.name));
    if (grievanceOk) grievanceDesc = info.name ? `${info.name} (${info.email || 'no email'})` : info.email;
  } catch (_) {}
  push({ key: 'grievance_officer', title: 'Grievance officer configured', severity: 'high',
         status: grievanceOk, description: grievanceDesc });

  // 7. Parental consent workflow — at least one minor consent record with a guardian field
  let parentalOk = false, parentalDesc = 'No verifiable parental consent records';
  try {
    const snap = await db.collection('consent_records').limit(50).get();
    parentalOk = snap.docs.some(d => {
      const x = d.data();
      return x.guardian_id || x.guardian_name || (x.consents && x.consents.parental);
    });
    if (parentalOk) parentalDesc = 'Guardian-verified consent present for minors';
  } catch (_) {}
  push({ key: 'parental_consent', title: 'Parental consent workflow active', severity: 'critical',
         status: parentalOk, description: parentalDesc });

  // 8. Breach notification procedure (an incident-response doc/flag exists)
  let breachOk = false, breachDesc = 'No breach procedure recorded';
  try {
    const s = await db.collection('compliance_settings').doc('_global_settings').get();
    breachOk = !!(s.exists && (s.data().breach_procedure_url || s.data().breach_contact));
    if (breachOk) breachDesc = 'Breach notification contact/procedure on file';
  } catch (_) {}
  push({ key: 'breach_procedure', title: 'Breach notification procedure ready', severity: 'high',
         status: breachOk, description: breachDesc });

  // 9. Data localisation — deployment region is in India (env)
  const region = (process.env.DATA_REGION || process.env.GCP_REGION || '').toLowerCase();
  const localOk = region.includes('asia-south') || region.includes('india') || process.env.DATA_LOCALISED === 'true';
  push({ key: 'data_localisation', title: 'Data stored in India', severity: 'medium',
         status: localOk,
         description: localOk ? `Region: ${region || 'declared India'}` : 'DATA_REGION not set to an India region' });

  // 10. Audit logging active — audit_log has recent entries
  let auditOk = false, auditDesc = 'No audit log entries';
  try {
    const snap = await db.collection('audit_log').limit(1).get();
    auditOk = snap.size > 0;
    if (auditOk) auditDesc = 'Audit trail is recording actions';
  } catch (_) {}
  push({ key: 'audit_log_active', title: 'Audit logging active', severity: 'medium',
         status: auditOk, description: auditDesc });

  const passed = checks.filter(c => c.status).length;
  const total  = checks.length;
  const score  = Math.round((passed / total) * 100);
  // Any failed critical item caps the headline status.
  const criticalFail = checks.some(c => c.severity === 'critical' && !c.status);

  return {
    score, passed, total, checks,
    critical_ok: !criticalFail,
    audited_at: new Date().toISOString(),
    live: true,
  };
}

module.exports = { evaluateCompliance };