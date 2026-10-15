'use strict';
const router = require('express').Router();
const { authenticate, requirePerm } = require('../middleware/auth');
const { getFirestore } = require('../lib/firebase');
const XLSX = require('xlsx');
const log = require('../lib/logger');

// The score shown on the Compliance page now comes from the LIVE engine
// (lib/complianceEngine.js). The old list below had 8 of 10 checks hard-coded
// to "pass", and an error fallback that showed 80%.
// (evaluateCompliance is required further down, next to GET /status.)
async function liveScore() {
  const r = await evaluateCompliance();
  return {
    score: r.score, passed: r.passed, total: r.total, critical_ok: r.critical_ok,
    checks: r.checks.map(c => ({ key: c.key, label: c.title, severity: c.severity, pass: !!c.status, description: c.description })),
    audited_at: r.audited_at,
  };
}
router.use(authenticate);

// ── Compliance score calculation ───────────────────────────────────────────

router.get('/score', requirePerm('perm_view_legal'), async (req, res) => {
  try {
    res.json(await liveScore());
  } catch (err) {
    log.error({ err: err.message }, 'compliance score failed');
    res.status(500).json({ error: 'Could not evaluate compliance right now' });
  }
});

router.post('/run-audit', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    const db     = getFirestore();
    const result = await liveScore();
    await db.collection('compliance_settings').doc('_audit_score').set(result);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Audit failed' });
  }
});

// Every write to Firestore collections that matters for DPDP compliance
// also appends a lightweight entry to audit_log. These endpoints surface that.
router.get('/audit-log', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('audit_log')
      .orderBy('created_at', 'desc').limit(200).get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ data, total: data.length });
  } catch (_) {
    res.json({ data: [], total: 0 });
  }
});
router.get('/audit-logs', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    // Latest 500 entries, filtered and paged in memory (no extra indexes needed).
    const db   = getFirestore();
    const snap = await db.collection('audit_log').orderBy('created_at', 'desc').limit(500).get();
    const ms = (v) => (v && typeof v.toDate === 'function') ? v.toDate().getTime() : (v ? new Date(v).getTime() : 0);
    const { user_id, action, date_from, date_to } = req.query;
    const from = date_from ? new Date(date_from).getTime() : 0;
    const to   = date_to ? new Date(date_to).getTime() + 86400000 : Infinity;
    let rows = snap.docs.map(d => { const x = d.data(); return {
      id: d.id, user_id: x.actor || x.user_id || null, email: x.email || null,
      action: x.action || '—', resource_type: x.resource_type || (x.detail && Object.keys(x.detail)[0]) || null,
      ip_address: x.ip || x.ip_address || null, details: x.detail || x.details || null,
      created_at: ms(x.created_at) ? new Date(ms(x.created_at)).toISOString() : null,
    }; });
    if (user_id) rows = rows.filter(r => String(r.user_id || '').includes(user_id));
    if (action)  rows = rows.filter(r => String(r.action).toLowerCase().includes(String(action).toLowerCase()));
    rows = rows.filter(r => { const t = ms(r.created_at); return t >= from && t < to; });
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    res.json({ data: rows.slice((page - 1) * limit, page * limit), total: rows.length, page });
  } catch (_) {
    res.json({ data: [], total: 0, page: 1 });
  }
});
router.get('/officers', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('compliance_settings').get();
    const map  = {};
    snap.docs.forEach(d => { map[d.id] = d.data().value; });
    res.json({ dpo: map['dpo_info'] || null, grievance_officer: map['grievance_officer'] || null });
  } catch (_) {
    res.json({ dpo: null, grievance_officer: null });
  }
});

router.post('/officers', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    const { grievance_officer, dpo } = req.body;
    if (!grievance_officer && !dpo) return res.status(400).json({ error: 'At least one officer required' });
    const db    = getFirestore();
    const batch = db.batch();
    if (dpo) {
      batch.set(db.collection('compliance_settings').doc('dpo_info'),
        { value: dpo, updated_by: req.user.id, updated_at: new Date() }, { merge: true });
    }
    if (grievance_officer) {
      batch.set(db.collection('compliance_settings').doc('grievance_officer'),
        { value: grievance_officer, updated_by: req.user.id, updated_at: new Date() }, { merge: true });
    }
    // Write audit entry
    batch.set(db.collection('audit_log').doc(), {
      action: 'officers_updated', actor: req.user.id,
      detail: { dpo: !!dpo, grievance_officer: !!grievance_officer },
      created_at: new Date(),
    });
    await batch.commit();
    // Invalidate cached audit score so it recalculates with new officer data
    await db.collection('compliance_settings').doc('_audit_score').delete().catch(() => {});
    res.json({ success: true, dpo, grievance_officer });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save officers', detail: err.message });
  }
});
router.get('/dpdpa-report', requirePerm('perm_view_legal'), async (req, res) => {
  try {
    const db = getFirestore();
    const [scoreDoc, consentSnap, purgeSnap] = await Promise.all([
      db.collection('compliance_settings').doc('_audit_score').get(),
      db.collection('consent_records').get(),
      db.collection('purge_log').limit(100).get(),
    ]);
    const score = scoreDoc.exists ? scoreDoc.data() : { score: 0, checks: [] };
    res.json({
      generated_at:    new Date().toISOString(),
      compliance_score: score.score,
      checks:          score.checks || [],
      consent_summary: {
        total:    consentSnap.size,
        granted:  consentSnap.docs.filter(d => d.data().granted).length,
        revoked:  consentSnap.docs.filter(d => !d.data().granted).length,
      },
      purge_events: purgeSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    });
  } catch (_) {
    res.json({ report: [], generated_at: new Date().toISOString() });
  }
});
router.post('/purge-user', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    const student_id = String(req.body?.student_id || req.body?.user_id || '').trim();
    const reason = req.body?.reason || 'Manual purge request';
    if (!student_id) return res.status(400).json({ error: 'student_id required' });
    const db    = getFirestore();
    const batch = db.batch();

    // Anonymise consent record — do not delete (audit trail required by DPDPA)
    const consentRef = db.collection('consent_records').doc(student_id);
    batch.set(consentRef, {
      student_id: `PURGED_${Date.now()}`,
      granted: false,
      purged: true,
      purged_at: new Date(),
      purged_by: req.user.id,
    }, { merge: false });

    // Delete telemetry sessions for this student
    const sessSnap = await db.collection('telemetry_sessions')
      .where('student_id', '==', student_id).limit(500).get();
    sessSnap.docs.forEach(d => batch.delete(d.ref));

    // Delete quiz attempts for this student
    const quizSnap = await db.collection('quiz_attempts')
      .where('student_id', '==', student_id).limit(500).get();
    quizSnap.docs.forEach(d => batch.delete(d.ref));

    // Write purge audit entry
    batch.set(db.collection('purge_log').doc(), {
      student_id, reason,
      purged_by: req.user.id,
      records_deleted: sessSnap.size + quizSnap.size,
      purged_at: new Date(),
    });
    batch.set(db.collection('audit_log').doc(), {
      action: 'user_purged', actor: req.user.id,
      detail: { student_id, reason }, created_at: new Date(),
    });

    await batch.commit();
    res.json({
      success: true,
      message: `User data purged per DPDPA Article 13`,
      records_deleted: sessSnap.size + quizSnap.size,
    });
  } catch (err) {
    res.status(500).json({ error: 'Purge failed', detail: err.message });
  }
});
router.post('/run-auto-purge', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    const db = getFirestore();
    const dryRun = req.body?.dry_run === true;
    // SAFETY: a student counts as inactive only when we can PROVE it — their last
    // app sign-in (users/{id}.last_login) and their consent record are both older
    // than 12 months. Students with no timestamps are never purged.
    // (The old version checked a collection the app never writes to, so it would
    // have anonymised every student.)
    const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const ms = (v) => (v && typeof v.toDate === 'function') ? v.toDate().getTime() : (v ? new Date(v).getTime() : 0);
    const consentSnap = await db.collection('consent_records').get();
    const candidates = consentSnap.docs.filter(d => !d.data().purged);
    const toPurge = [];
    for (let i = 0; i < candidates.length; i += 100) {
      const chunk = candidates.slice(i, i + 100);
      const users = await db.getAll(...chunk.map(d => db.collection('app_users').doc(d.id)));
      chunk.forEach((d, k) => {
        const c = d.data();
        const u = users[k].exists ? users[k].data() : null;
        const lastSeen = Math.max(ms(u && (u.last_login || u.last_login_at)), ms(c.granted_at), ms(c.revoked_at));
        if (lastSeen > 0 && lastSeen < cutoff) toPurge.push(d);
      });
    }
    if (dryRun) {
      return res.json({ success: true, dry_run: true, would_purge: toPurge.length, checked: candidates.length });
    }
    let purged = 0;
    for (const doc of toPurge) {
      await doc.ref.set({
        student_id: `AUTOPURGED_${Date.now()}_${purged}`,
        granted: false, purged: true,
        purged_at: new Date(), purged_by: 'auto_purge_manual_run',
      }, { merge: false });
      purged++;
    }

    // Record run
    await db.collection('compliance_settings').doc('_auto_purge_status').set({
      last_run: new Date(), purged_count: purged,
    }, { merge: true });
    await db.collection('audit_log').add({
      action: 'auto_purge_run', actor: req.user.id,
      detail: { purged }, created_at: new Date(),
    });

    res.json({ success: true, purged, purged_count: purged, message: `Purge completed. ${purged} inactive account(s) anonymised.` });
  } catch (err) {
    res.status(500).json({ error: 'Auto-purge failed', detail: err.message });
  }
});
router.get('/retention-policy', requirePerm('perm_view_legal'), async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('compliance_settings').doc('retention_policy').get();
    res.json(doc.exists ? doc.data() : {
      policy: 'Data retained for 2 years per DPDPA guidelines',
      retention_days: 730,
      last_updated: new Date().toISOString(),
    });
  } catch (_) {
    res.json({ policy: 'Data retained for 2 years per DPDPA guidelines', retention_days: 730 });
  }
});

router.get('/reports/summary', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('consent_records').get();
    const all     = snap.docs.map(d => d.data());
    const consented = all.filter(d => d.granted && !d.purged).length;
    const purged    = all.filter(d => d.purged).length;
    const pending   = all.filter(d => !d.granted && !d.purged).length;

    const scoreDoc  = await db.collection('compliance_settings').doc('_audit_score').get();
    const last_audit = scoreDoc.exists ? scoreDoc.data().audited_at : null;

    // Cheap count() aggregations (about 1 read per 1,000 documents)
    let audit_events_recent = null, mfa_enabled_users = null;
    try { audit_events_recent = (await db.collection('audit_log').count().get()).data().count; } catch (_) {}
    try { mfa_enabled_users = (await db.collection('dashboard_users').where('mfa_required', '==', true).count().get()).data().count; } catch (_) {}
    res.json({
      total_users: all.length,
      consented,
      pending,
      purged,
      audit_events_recent,
      mfa_enabled_users,
      last_audit: last_audit || null,
    });
  } catch (_) {
    res.json({ total_users: 0, consented: 0, pending: 0, purged: 0, last_audit: new Date().toISOString() });
  }
});
router.get('/auto-purge-status', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('compliance_settings').doc('_auto_purge_status').get();
    if (doc.exists) {
      const d = doc.data();
      res.json({
        enabled:      d.enabled || false,
        auto_purge_enabled: d.enabled || false,
        last_run:     d.last_run ? d.last_run.toDate().toISOString() : null,
        next_run:     null,
        purged_count: d.purged_count || 0,
      });
    } else {
      res.json({ enabled: false, last_run: null, next_run: null, purged_count: 0 });
    }
  } catch (_) {
    res.json({ enabled: false, last_run: null, next_run: null, purged_count: 0 });
  }
});
router.post('/auto-purge-toggle', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    const { enabled } = req.body;
    const db = getFirestore();
    await db.collection('compliance_settings').doc('_auto_purge_status')
      .set({ enabled: !!enabled, toggled_by: req.user.id, toggled_at: new Date() }, { merge: true });
    // The live compliance engine reads _global_settings.auto_purge — keep it in sync.
    await db.collection('compliance_settings').doc('_global_settings').set({ auto_purge: !!enabled }, { merge: true });
    await db.collection('audit_log').add({
      action: enabled ? 'auto_purge_enabled' : 'auto_purge_disabled',
      actor: req.user.id, created_at: new Date(),
    });
    res.json({ success: true, enabled: !!enabled });
  } catch (err) {
    res.status(500).json({ error: 'Toggle failed' });
  }
});
// Turn the email sign-in code on/off for one dashboard account (by id or email).
router.post('/enforce-mfa', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    const { user_id, enforce = true } = req.body || {};
    const key = String(user_id || '').trim();
    if (!key) return res.status(400).json({ error: 'user_id (or email) required' });
    const db = getFirestore();
    let ref = db.collection('dashboard_users').doc(key);
    let doc = key.includes('@') ? null : await ref.get();
    if (!doc || !doc.exists) {
      const snap = await db.collection('dashboard_users').where('email', '==', key.toLowerCase()).limit(1).get();
      if (snap.empty) return res.status(404).json({ error: 'No dashboard user with that id or email' });
      doc = snap.docs[0]; ref = doc.ref;
    }
    await ref.update({ mfa_required: !!enforce, updated_at: new Date() });
    await db.collection('audit_log').add({
      action: enforce ? 'mfa_enforced' : 'mfa_removed', actor: req.user.id,
      detail: { user_id: doc.id }, created_at: new Date(),
    });
    res.json({ success: true, message: `${enforce ? 'MFA required' : 'MFA removed'} for ${doc.data().email}` });
  } catch (err) {
    res.status(500).json({ error: 'Could not update MFA', detail: err.message });
  }
});
router.get('/data-export/:userId', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    const db  = getFirestore();
    const uid = req.params.userId;
    const [consentDoc, sessSnap, quizSnap] = await Promise.all([
      db.collection('consent_records').doc(uid).get(),
      db.collection('telemetry_sessions').where('student_id', '==', uid).limit(500).get(),
      db.collection('quiz_attempts').where('student_id', '==', uid).limit(500).get(),
    ]);
    res.json({
      user_id: uid,
      exported_at: new Date().toISOString(),
      data: {
        consent:          consentDoc.exists ? consentDoc.data() : null,
        telemetry_count:  sessSnap.size,
        quiz_count:       quizSnap.size,
        sessions:         sessSnap.docs.map(d => d.data()),
        quiz_attempts:    quizSnap.docs.map(d => d.data()),
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Export failed', detail: err.message });
  }
});

router.post('/incident-report', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    const db  = getFirestore();
    const id  = require('uuid').v4();
    await db.collection('incident_reports').doc(id).set({
      id,
      ...req.body,
      reported_by: req.user.id,
      status: 'open',
      created_at: new Date(),
    });
    await db.collection('audit_log').add({
      action: 'incident_reported', actor: req.user.id,
      detail: { incident_id: id, type: req.body.type }, created_at: new Date(),
    });
    // CERT-In Directions (2022): report within 6 hours of noticing the incident.
    const detected = new Date(req.body.detected_at || Date.now());
    const deadline = new Date(detected.getTime() + 6 * 60 * 60 * 1000);
    res.json({ success: true, id, incident_id: id,
      cert_in_deadline: deadline.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' });
  } catch (err) {
    res.status(500).json({ error: 'Incident report failed' });
  }
});
router.get('/consent-counts', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('consent_records').get();
    const all  = snap.docs.map(d => d.data());
    res.json({
      total:     all.length,
      granted:   all.filter(d => d.granted && !d.purged).length,
      withdrawn: all.filter(d => !d.granted && !d.purged && d.revoked_at).length,
      pending:   all.filter(d => !d.granted && !d.purged && !d.revoked_at).length,
    });
  } catch (_) {
    res.json({ total: 0, granted: 0, withdrawn: 0, pending: 0 });
  }
});
router.get('/settings', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('compliance_settings').doc('_global_settings').get();
    res.json(doc.exists ? doc.data() : { retention_days: 730, auto_purge: false, mfa_required: false });
  } catch (_) {
    res.json({ retention_days: 730, auto_purge: false, mfa_required: false });
  }
});

router.put('/settings', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    // Safety: switching the email sign-in code on for everyone without working
    // email would lock every admin out.
    if (req.body && req.body.mfa_required === true && !(process.env.SMTP_USER && process.env.SMTP_PASSWORD)) {
      return res.status(400).json({ error: 'Set SMTP_USER and SMTP_PASSWORD on the server first — otherwise nobody could receive a sign-in code.' });
    }
    const db = getFirestore();
    await db.collection('compliance_settings').doc('_global_settings')
      .set({ ...req.body, updated_by: req.user.id, updated_at: new Date() }, { merge: true });
    await db.collection('audit_log').add({
      action: 'compliance_settings_updated', actor: req.user.id,
      detail: req.body, created_at: new Date(),
    });
    res.json({ success: true, ...req.body });
  } catch (err) {
    res.status(500).json({ error: 'Settings update failed' });
  }
});
router.get('/audit-findings', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    // Findings = live checks that currently fail. A finding disappears by
    // itself once the underlying check passes (e.g. after saving the DPO).
    const r = await liveScore();
    const data = r.checks.filter(c => !c.pass).map(c => ({
      id: c.key, key: c.key, label: c.label, severity: c.severity,
      description: c.description, status: 'open', created_at: r.audited_at,
    }));
    res.json({ data, total: data.length, checked: r.total, audited_at: r.audited_at });
  } catch (err) {
    log.error({ err: err.message }, 'audit findings failed');
    res.status(500).json({ error: 'Could not evaluate findings right now' });
  }
});

router.put('/findings/:id/resolve', requirePerm('perm_manage_compliance'), async (req, res) => {
  try {
    const db  = getFirestore();
    const ref = db.collection('audit_findings').doc(req.params.id);
    await ref.set({
      status: 'resolved',
      resolved_by: req.user.id,
      resolved_at: new Date(),
      resolution_note: req.body.note || '',
    }, { merge: true });
    await db.collection('audit_log').add({
      action: 'finding_resolved', actor: req.user.id,
      detail: { finding_id: req.params.id }, created_at: new Date(),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Resolve failed' });
  }
});

// ── Change #29: Consent log export ────────────────────────────────────────
router.get('/consent-log/export', requirePerm('perm_export_data'), async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('consent_records').limit(5000).get();
    const rows = snap.docs.map(d => {
      const c = d.data();
      return {
        'Student ID':      c.student_id || d.id,
        'Consent Version': c.version || '',
        'Granted':         c.granted ? 'Yes' : 'No',
        'Granted At':      c.granted_at && c.granted_at.toDate ? c.granted_at.toDate().toISOString() : '',
        'Consents':        c.consents ? JSON.stringify(c.consents) : '',
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Consent Log');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="Consent_Log_Export.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    log.error({ err: err.message }, 'Consent log export failed');
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── Change #30: Generic compliance checklist export ───────────────────────
router.get('/export', requirePerm('perm_export_data'), async (req, res) => {
  try {
    const db     = getFirestore();
    const result = await calculateComplianceScore(db);
    const format = (req.query.format || 'xlsx').toLowerCase();
    const rows = result.checks.map(c => ({
      'Check': c.label, 'Severity': c.severity, 'Status': c.pass ? 'Pass' : 'Fail',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    if (format === 'csv') {
      const csv = XLSX.utils.sheet_to_csv(ws);
      res.setHeader('Content-Disposition', 'attachment; filename="Compliance_Export.csv"');
      res.setHeader('Content-Type', 'text/csv');
      return res.send(csv);
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Compliance');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="Compliance_Export.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    log.error({ err: err.message }, 'Compliance export failed');
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── GET /api/compliance/status ─── LIVE tracker (real checks, no caching) ────
const { evaluateCompliance } = require('../lib/complianceEngine');
router.get('/status', requirePerm('perm_view_legal'), async (req, res) => {
  try {
    const result = await evaluateCompliance();
    res.json(result);
  } catch (err) {
    log.error({ err: err.message }, 'live compliance status failed');
    res.status(500).json({ error: 'Could not evaluate compliance status' });
  }
});

module.exports = router;
