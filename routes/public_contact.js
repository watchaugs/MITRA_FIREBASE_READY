'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// routes/public_contact.js — GET /api/public/contact (no sign-in).
//
// The Grievance Officer and DPO contact set on Legal & Compliance → Officers,
// published for the privacy policy page (DPDP Rules 2025, Rule 9: the
// contact must be published). Returns only name, email and phone; nothing is
// returned until an officer has been saved.
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { getFirestore } = require('../lib/firebase');

const pick = (v, keys) => {
  if (!v || typeof v !== 'object') return null;
  const out = {};
  for (const k of keys) if (typeof v[k] === 'string' && v[k].trim()) out[k] = v[k].trim().slice(0, 200);
  return Object.keys(out).length ? out : null;
};

router.get('/contact', async (req, res) => {
  try {
    const db = getFirestore();
    const [g, d] = await Promise.all([
      db.collection('compliance_settings').doc('grievance_officer').get(),
      db.collection('compliance_settings').doc('dpo_info').get(),
    ]);
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      grievance_officer: g.exists ? pick(g.data().value, ['name', 'email', 'phone']) : null,
      dpo: d.exists ? pick(d.data().value, ['name', 'email', 'phone']) : null,
    });
  } catch (_) {
    res.status(503).json({ error: 'Contact details unavailable right now' });
  }
});

module.exports = router;