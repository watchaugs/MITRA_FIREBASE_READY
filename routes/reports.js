/**
 * routes/reports.js — Monthly Government Report (PPTX) generator
 *
 * Fills the shipped PowerPoint template (assets/MITRA_Monthly_Report_Template.pptx)
 * with live telemetry and streams it back. Every {{TOKEN}} in the template is
 * replaced; any metric we don't yet have data for renders as '—' (never a crash).
 *
 * Route:  GET /api/reports/monthly.pptx?month=YYYY-MM&scope=<state|All India>&gender=<All|Male|Female>
 * Auth:   requires a valid token with perm_export_data (same as data export).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const PizZip = require('pizzip');
const router = require('express').Router();
const { authenticate, requirePerm } = require('../middleware/auth');

router.use(authenticate);

const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'MITRA_Monthly_Report_Template.pptx');
const DEFAULT = '—';
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const n  = v => (v === null || v === undefined || Number.isNaN(v)) ? DEFAULT : Number(v).toLocaleString('en-IN');
const pc = (part, whole) => whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : DEFAULT;
const mins = v => (v || v === 0) ? `${Number(v).toFixed(1)}` : DEFAULT;

/**
 * Compute the data map from Firestore telemetry_sessions. Robust by design:
 * missing fields never throw; unavailable metrics stay as '—' via the nullGetter.
 */
async function buildReportData({ month, scope, gender }) {
  // BigQuery-for-both model: the 402-token map is precomputed on /analytics
  // Refresh (report_builder.buildTokenMap → report_cache/ppt__<scope>). This
  // route just reads that cache — no BigQuery, no Firestore scan, no compute at
  // download. Run "Sync telemetry" then "Refresh" on the dashboard to populate.
  const DEFAULT_LABEL = '—';
  try {
    const db = require('../lib/firebase').getFirestore();
    const slug = String(scope || 'All India').replace(/[^A-Za-z0-9]+/g, '_');
    const doc = await db.collection('report_cache').doc('ppt__' + slug).get();
    const d = (doc.exists && doc.data() && doc.data().tokens) ? { ...doc.data().tokens } : {};
    // Always set the header labels (even before a refresh) so the deck isn't blank.
    if (!d.SELECTED_SCOPE) d.SELECTED_SCOPE = scope || 'All India';
    if (!d.SELECTED_GENDER) d.SELECTED_GENDER = gender || 'All';
    if (!d.SELECTED_OWNER) d.SELECTED_OWNER = 'Ministry of Education';
    if (!d.REPORT_MONTH && /^\d{4}-\d{2}$/.test(month || '')) {
      const MO = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const [yy, mm] = month.split('-').map(Number); d.REPORT_MONTH = `${MO[mm - 1]} ${yy}`;
    }
    return d;
  } catch (err) {
    console.error('[reports] buildReportData (cache read) failed:', err.message);
    return { SELECTED_SCOPE: scope || 'All India' };
  }
}

function fillTemplate(buf, data) {
  const zip = new PizZip(buf);
  Object.keys(zip.files).forEach(name => {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) {
      const xml = zip.files[name].asText().replace(
        /\{\{([A-Z0-9_]+)\}\}/g,
        (_, key) => Object.prototype.hasOwnProperty.call(data, key) ? String(data[key]) : 'No data this period'
      );
      zip.file(name, xml);
    }
  });
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

router.get('/monthly.pptx', requirePerm('perm_export_data'), async (req, res) => {
  try {
    if (!fs.existsSync(TEMPLATE_PATH)) {
      return res.status(500).json({ error: 'Report template not found on server' });
    }
    const { month = '', scope = 'All India', gender = 'All' } = req.query;
    const data = await buildReportData({ month, scope, gender });
    const out = fillTemplate(fs.readFileSync(TEMPLATE_PATH), data);

    const safeMonth = (month || 'report').replace(/[^0-9A-Za-z-]/g, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="MITRA_Monthly_Report_${safeMonth}.pptx"`);
    res.send(out);
  } catch (err) {
    console.error('[reports] monthly.pptx failed:', err);
    res.status(500).json({ error: 'Report generation failed', detail: err.message });
  }
});

module.exports = router;