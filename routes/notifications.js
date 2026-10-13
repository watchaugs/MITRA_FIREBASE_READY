/**
 * routes/notifications.js — FCM push notifications from the dashboard.
 *
 * Delivery: FCM topic messaging. The student app subscribes to exactly these
 * topics (lib/stores/auth_store.dart → _subscribeFCMTopics):
 *     mitra_all                      every student
 *     mitra_<state>                  e.g. mitra_uttar_pradesh
 *     mitra_<state>_<class>          e.g. mitra_uttar_pradesh_class_8
 * (state/class lower-cased, spaces → underscores). topicFor() below builds
 * the same names, so targeting by state / class actually reaches phones.
 *
 * Scheduling — NO Cloud Scheduler needed (zero cost): scheduled items are
 * stored as "pending" and sent by dispatchDue(), which the dashboard calls
 * whenever an admin opens the Notifications or Home page, or presses
 * "Send due now". The old /dispatch-scheduled (cron + secret) still works if
 * a scheduler job exists, but it is no longer required.
 */
'use strict';

const router   = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { authenticate, requirePerm } = require('../middleware/auth');
const { getFirestore }              = require('../lib/firebase');
const { State }                     = require('country-state-city');
const log = require('../lib/logger');

router.use((req, res, next) => {
  // Optional: a Cloud Scheduler job may still call /dispatch-scheduled with a shared secret.
  if (req.path === '/dispatch-scheduled' &&
      process.env.DISPATCH_SECRET &&
      req.get('x-cron-secret') === process.env.DISPATCH_SECRET) {
    req.user = { id: 'cloud-scheduler', role: 'master_admin' };
    return next();
  }
  return authenticate(req, res, next);
});

function getMessaging() {
  const { getMessaging: getFCM } = require('firebase-admin/messaging');
  return getFCM();
}

// ── Topic naming — must match the app exactly ────────────────────────────────
const slug = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_\-.~%]/g, '');
function topicFor(state, cls) {
  const st = slug(state);
  const cl = slug(cls);
  if (st && cl) return `mitra_${st}_${cl}`;
  if (st)       return `mitra_${st}`;
  return 'mitra_all';
}

// The app subscribes to class topics only inside a state, so a class-only
// target would silently become "all students". Refuse it instead.
const CLASS_NEEDS_STATE = 'To target a class, also pick a state (the app listens per state + class).';

// FCM data values must all be strings.
function dataPayload(b) {
  const out = { click_action: 'FLUTTER_NOTIFICATION_CLICK' };
  if (b.deep_link_type) out.deep_link_type = String(b.deep_link_type);
  if (b.deep_link_id)   out.deep_link_id   = String(b.deep_link_id);
  if (b.target_ar_topic) out.ar_topic_id   = String(b.target_ar_topic);
  if (b.target_quiz)     out.quiz_id       = String(b.target_quiz);
  return out;
}

function buildMessage(n) {
  return {
    notification: { title: n.title, body: n.body },
    data: n.data_payload || { click_action: 'FLUTTER_NOTIFICATION_CLICK' },
    android: { priority: 'high', notification: { sound: 'default', channelId: 'mitra_content' } },
    apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    topic: n.topic,
  };
}

function targetFields(b) {
  return {
    target_state:    b.target_state    || null,
    target_class:    b.target_class    || null,
    target_ar_topic: b.target_ar_topic || null,
    target_quiz:     b.target_quiz     || null,
    deep_link_type:  b.deep_link_type  || null,
    deep_link_id:    b.deep_link_id    || null,
  };
}

const toMs = (v) => (v && typeof v.toDate === 'function') ? v.toDate().getTime() : new Date(v || 0).getTime();
const toIso = (v) => { const t = toMs(v); return t ? new Date(t).toISOString() : null; };

// ── Send everything that is due (shared by the button, page-open and cron) ───
async function dispatchDue(db) {
  // Single-field query (no composite index needed); due-time filtered in memory.
  const snap = await db.collection('scheduled_notifications').where('status', '==', 'pending').limit(200).get();
  const now  = Date.now();
  const due  = snap.docs.filter(d => toMs(d.data().scheduled_at) <= now).slice(0, 50);
  if (!due.length) return 0;
  const messaging = getMessaging();
  let dispatched = 0;
  for (const doc of due) {
    const n = doc.data();
    try {
      const fcmId = await messaging.send(buildMessage(n));
      const sentAt = new Date();
      await doc.ref.update({ status: 'sent', sent_at: sentAt, fcm_message_id: fcmId });
      await db.collection('notifications').doc(doc.id).set({ ...n, status: 'sent', sent_at: sentAt, fcm_message_id: fcmId });
      dispatched++;
      log.info({ id: doc.id, topic: n.topic }, 'Scheduled notification dispatched');
    } catch (err) {
      await doc.ref.update({ status: 'failed', error: err.message });
      log.error({ id: doc.id, err: err.message }, 'Scheduled notification failed');
    }
  }
  return dispatched;
}

// ── GET /  — notification feed (the app's notifications screen reads this) ───
router.get('/', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('notifications').orderBy('created_at', 'desc').limit(100).get();
    let data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // A student only sees notifications that were sent to them (all / their state / their class).
    if (req.query.state) {
      const st = slug(req.query.state);
      data = data.filter(n => !n.target_state || slug(n.target_state) === st);
    }
    res.json({ data, total: data.length });
  } catch (_) {
    res.json({ data: [], total: 0 });
  }
});

// ── POST /send  — send now ───────────────────────────────────────────────────
router.post('/send', requirePerm('perm_send_notif'), async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    const body  = String(b.body  || '').trim();
    if (!title || !body) return res.status(400).json({ error: 'Title and body are required' });
    if (b.target_class && !b.target_state) return res.status(400).json({ error: CLASS_NEEDS_STATE });

    const topic = topicFor(b.target_state, b.target_class);
    const n = { title, body, topic, data_payload: dataPayload(b) };
    const fcmId = await getMessaging().send(buildMessage(n));

    const db = getFirestore();
    const id = uuidv4();
    const now = new Date();
    await db.collection('notifications').doc(id).set({
      id, ...n, ...targetFields(b),
      fcm_message_id: fcmId, status: 'sent',
      sent_by: req.user.id, sent_by_name: req.user.name || null,
      sent_at: now, created_at: now,
    });
    log.info({ id, topic, fcm_id: fcmId }, 'FCM notification sent');
    res.json({ success: true, message: `Notification sent to ${topic}`, id, topic, fcm_message_id: fcmId });
  } catch (err) {
    log.error({ err: err.message }, 'FCM send failed');
    res.status(500).json({ error: 'Notification send failed', detail: err.message });
  }
});

// ── POST /schedule  — store for later; sent by dispatchDue() ────────────────
router.post('/schedule', requirePerm('perm_send_notif'), async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    const body  = String(b.body  || '').trim();
    if (!title || !body) return res.status(400).json({ error: 'Title and body are required' });
    if (b.target_class && !b.target_state) return res.status(400).json({ error: CLASS_NEEDS_STATE });
    const when = new Date(b.scheduled_at);
    if (!b.scheduled_at || Number.isNaN(when.getTime())) return res.status(400).json({ error: 'scheduled_at required (date & time)' });

    const db = getFirestore();
    const id = uuidv4();
    await db.collection('scheduled_notifications').doc(id).set({
      id, title, body,
      topic: topicFor(b.target_state, b.target_class),
      data_payload: dataPayload(b),
      ...targetFields(b),
      scheduled_at: when,
      status: 'pending',
      created_by: req.user.id, sent_by_name: req.user.name || null,
      created_at: new Date(),
    });
    res.json({ success: true, message: 'Notification scheduled — it is sent the first time the dashboard is opened after this time (or press "Send due now").', id, scheduled_at: when.toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Schedule failed', detail: err.message });
  }
});

// ── POST /dispatch-due  — dashboard trigger (page open / "Send due now") ─────
router.post('/dispatch-due', requirePerm('perm_send_notif'), async (req, res) => {
  try {
    const dispatched = await dispatchDue(getFirestore());
    res.json({ success: true, dispatched });
  } catch (err) {
    res.status(500).json({ error: 'Dispatch failed', detail: err.message });
  }
});

// ── POST /dispatch-scheduled  — optional cron (kept for compatibility) ──────
router.post('/dispatch-scheduled', async (req, res) => {
  try {
    const dispatched = await dispatchDue(getFirestore());
    res.json({ dispatched });
  } catch (err) {
    res.status(500).json({ error: 'Dispatch failed', detail: err.message });
  }
});

// ── GET /history  — sent + scheduled, with filters and paging ───────────────
router.get('/history', async (req, res) => {
  try {
    const db = getFirestore();
    const [sentSnap, schedSnap] = await Promise.all([
      db.collection('notifications').orderBy('created_at', 'desc').limit(200).get(),
      db.collection('scheduled_notifications').orderBy('created_at', 'desc').limit(200).get(),
    ]);
    const statusMap = { pending: 'scheduled' };
    const sentIds = new Set(sentSnap.docs.map(d => d.id));
    let rows = [
      ...sentSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      ...schedSnap.docs.filter(d => !sentIds.has(d.id)).map(d => ({ id: d.id, ...d.data() })),
    ].map(n => ({
      id: n.id, title: n.title, body: n.body, topic: n.topic,
      target_state: n.target_state || null, target_class: n.target_class || null,
      deep_link_type: n.deep_link_type || null,
      status: statusMap[n.status] || n.status || 'sent',
      sent_at: toIso(n.sent_at), scheduled_at: toIso(n.scheduled_at), created_at: toIso(n.created_at),
      sent_by_name: n.sent_by_name || null, error: n.error || null,
    }));

    const { status, state, date_from } = req.query;
    if (status)    rows = rows.filter(r => r.status === status);
    if (state)     rows = rows.filter(r => slug(r.target_state) === slug(state));
    if (date_from) { const t = new Date(date_from).getTime(); rows = rows.filter(r => toMs(r.sent_at || r.scheduled_at || r.created_at) >= t); }
    rows.sort((a, b) => toMs(b.sent_at || b.scheduled_at || b.created_at) - toMs(a.sent_at || a.scheduled_at || a.created_at));

    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    res.json({ data: rows.slice((page - 1) * limit, page * limit), total: rows.length, page });
  } catch (err) {
    log.error({ err: err.message }, 'notification history failed');
    res.json({ data: [], total: 0, page: 1 });
  }
});

// ── Cancel a scheduled notification (both URL forms the dashboard has used) ─
async function cancelScheduled(req, res) {
  try {
    const db  = getFirestore();
    const ref = db.collection('scheduled_notifications').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Scheduled notification not found' });
    if (doc.data().status !== 'pending') return res.status(400).json({ error: `Already ${doc.data().status} — cannot cancel` });
    await ref.update({ status: 'cancelled', cancelled_by: req.user.id, cancelled_at: new Date() });
    res.json({ success: true, message: 'Notification cancelled' });
  } catch (_) {
    res.status(500).json({ error: 'Cancel failed' });
  }
}
router.delete('/:id/cancel', requirePerm('perm_send_notif'), cancelScheduled);
router.delete('/:id',        requirePerm('perm_send_notif'), cancelScheduled);

// ── GET /filters  — targeting options (no telemetry scan: near-zero reads) ──
router.get('/filters', async (req, res) => {
  const states   = State.getStatesOfCountry('IN').map(s => ({ code: s.isoCode, name: s.name }));
  const classes  = Array.from({ length: 12 }, (_, i) => ({ name: `Class ${i + 1}` }));
  let topics = [], quizzes = [];
  try {
    const db = getFirestore();
    const [arSnap, qSnap] = await Promise.all([
      db.collection('ar_assets').where('status', '==', 'published').limit(200).get(),
      db.collection('quizzes').limit(200).get(),
    ]);
    topics  = arSnap.docs.map(d => { const a = d.data(); return { id: d.id, name: [a.topic || a.title || d.id, a.class_name].filter(Boolean).join(' · ') }; });
    quizzes = qSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(q => ['live', 'published'].includes(q.status))
      .map(q => ({ id: q.id, name: [q.title || q.id, q.class_name].filter(Boolean).join(' · ') }));
  } catch (err) {
    log.warn({ err: err.message }, 'notification filters: topic/quiz lookup failed');
  }
  res.json({ states, classes, topics, quizzes });
});

// ── GET /analytics  — what we can honestly measure ───────────────────────────
// Delivery receipts / opens are not reported by the app, so we show sent,
// accepted by FCM, scheduled-pending and failed — nothing invented.
router.get('/analytics', async (req, res) => {
  try {
    const db   = getFirestore();
    const days = Math.min(365, parseInt(req.query.days, 10) || 30);
    const since = Date.now() - days * 86400000;
    const [sentSnap, schedSnap] = await Promise.all([
      db.collection('notifications').orderBy('created_at', 'desc').limit(500).get(),
      db.collection('scheduled_notifications').where('status', 'in', ['pending', 'failed']).limit(500).get(),
    ]);
    const sent = sentSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(n => toMs(n.sent_at || n.created_at) >= since);
    const sched = schedSnap.docs.map(d => d.data());
    res.json({
      kpi: {
        total_sent:      sent.length,
        total_delivered: sent.filter(n => n.fcm_message_id).length,
        pending:         sched.filter(n => n.status === 'pending').length,
        failed:          sched.filter(n => n.status === 'failed').length,
      },
      top: sent.slice(0, 20).map(n => ({
        title: n.title, target_state: n.target_state || null, target_class: n.target_class || null,
        topic: n.topic, sent_at: toIso(n.sent_at || n.created_at),
      })),
      days,
    });
  } catch (_) {
    res.json({ kpi: { total_sent: 0, total_delivered: 0, pending: 0, failed: 0 }, top: [], days: 30 });
  }
});

// ── GET /analytics/export  — CSV of sent notifications ──────────────────────
router.get('/analytics/export', async (req, res) => {
  try {
    const db   = getFirestore();
    const days = Math.min(365, parseInt(req.query.days, 10) || 30);
    const since = Date.now() - days * 86400000;
    const snap = await db.collection('notifications').orderBy('created_at', 'desc').limit(2000).get();
    const rows = snap.docs.map(d => d.data()).filter(n => toMs(n.sent_at || n.created_at) >= since);
    const esc  = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const head = ['Title', 'Body', 'Topic', 'Target State', 'Target Class', 'Deep Link', 'Sent At', 'Sent By'];
    const csv  = [head.join(','), ...rows.map(n => [
      n.title, n.body, n.topic, n.target_state, n.target_class,
      n.deep_link_type ? `${n.deep_link_type}:${n.deep_link_id || ''}` : '',
      toIso(n.sent_at || n.created_at), n.sent_by_name || n.sent_by,
    ].map(esc).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="MITRA_Notifications_${days}d.csv"`);
    res.send(csv);
  } catch (_) {
    res.status(500).json({ error: 'Export failed' });
  }
});

module.exports = router;
module.exports.topicFor = topicFor;