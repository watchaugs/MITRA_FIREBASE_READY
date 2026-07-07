/**
 * routes/notifications.js — FCM Push Notification Pipeline
 *
 * Implements the "5:00 PM content-unlock notification" architecture from the
 * Netflix Strategy PDF: client-side time-locks gate the actual content,
 * but FCM sends a lightweight "New chapter available!" push so students
 * know to open the app. The heavy AR asset is never touched server-side.
 *
 * Uses Firebase Admin SDK messaging (same SDK already initialised in lib/firebase.js)
 */
'use strict';

const router   = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { authenticate, requirePerm } = require('../middleware/auth');
const { getFirestore }              = require('../lib/firebase');
const log = require('../lib/logger');

router.use(authenticate);

// ── Helper: get FCM messaging instance ───────────────────────────────────────
function getMessaging() {
  const { getMessaging: getFCM } = require('firebase-admin/messaging');
  return getFCM();
}

// ── GET /  — List all notification records ───────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('notifications').orderBy('created_at', 'desc').limit(100).get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ data, total: data.length });
  } catch (_) {
    res.json({ data: [], total: 0 });
  }
});

// ── POST /send  — Send immediate FCM push ────────────────────────────────────
// Body: { title, body, topic_filter, state_filter, class_filter, subject_filter }
// Uses FCM Topic messaging — students subscribe to topics like "class_8_science_GJ"
// No per-device token management needed at this stage.
router.post('/send', requirePerm('perm_view_notif'), async (req, res) => {
  try {
    const {
      title         = 'New AR Content Available!',
      body          = 'Open MITRA to explore your new lesson.',
      topic_filter,   // e.g. "class_8_science_GJ"  — FCM topic
      data_payload = {},
    } = req.body;

    const messaging = getMessaging();

    // Build the FCM message
    const message = {
      notification: { title, body },
      data: {
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        ...data_payload,
      },
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'mitra_content' },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
      },
      // Send to topic if specified, otherwise broadcast to all MITRA students
      topic: topic_filter || 'mitra_all_students',
    };

    const response = await messaging.send(message);

    // Persist notification record
    const db = getFirestore();
    const id = uuidv4();
    await db.collection('notifications').doc(id).set({
      id,
      title,
      body,
      topic: topic_filter || 'mitra_all_students',
      fcm_message_id: response,
      status: 'sent',
      sent_by: req.user.id,
      created_at: new Date(),
    });

    log.info({ id, topic: topic_filter, fcm_id: response }, 'FCM notification sent');
    res.json({ success: true, message: 'Notification sent', id, fcm_message_id: response });
  } catch (err) {
    log.error({ err: err.message }, 'FCM send failed');
    res.status(500).json({ error: 'Notification send failed', detail: err.message });
  }
});

// ── POST /schedule  — Schedule a future notification ─────────────────────────
// Stores in Firestore; /dispatch-scheduled processes due entries.
// This powers the 5:00 PM daily content-unlock notification.
router.post('/schedule', requirePerm('perm_view_notif'), async (req, res) => {
  try {
    const {
      title, body, topic_filter,
      scheduled_at,   // ISO string — e.g. "2026-07-08T11:30:00.000Z" (5:00 PM IST)
      data_payload = {},
    } = req.body;

    if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at required (ISO datetime)' });

    const db = getFirestore();
    const id = uuidv4();
    await db.collection('scheduled_notifications').doc(id).set({
      id, title, body,
      topic: topic_filter || 'mitra_all_students',
      scheduled_at: new Date(scheduled_at),
      data_payload,
      status: 'pending',
      created_by: req.user.id,
      created_at: new Date(),
    });

    res.json({ success: true, message: 'Notification scheduled', id, scheduled_at });
  } catch (err) {
    res.status(500).json({ error: 'Schedule failed', detail: err.message });
  }
});

// ── GET /history  — Past notifications ───────────────────────────────────────
router.get('/history', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('notifications').orderBy('created_at', 'desc').limit(200).get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ data, total: data.length });
  } catch (_) {
    res.json({ data: [], total: 0 });
  }
});

// ── DELETE /:id  — Cancel a scheduled notification ───────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const db  = getFirestore();
    const ref = db.collection('scheduled_notifications').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Notification not found' });
    if (doc.data().status === 'sent') return res.status(400).json({ error: 'Already sent — cannot cancel' });
    await ref.update({ status: 'cancelled', cancelled_by: req.user.id, cancelled_at: new Date() });
    res.json({ message: 'Notification cancelled' });
  } catch (_) {
    res.status(500).json({ error: 'Cancel failed' });
  }
});

// ── GET /filters  — Available segment filters for targeting ──────────────────
// Dynamically built from live Firestore data where possible
router.get('/filters', async (req, res) => {
  try {
    const db = getFirestore();
    const [statesSnap, classSnap] = await Promise.all([
      db.collection('telemetry_sessions').select('state').limit(1000).get(),
      db.collection('telemetry_sessions').select('class_grade', 'subject').limit(1000).get(),
    ]);

    const states   = [...new Set(statesSnap.docs.map(d => d.data().state).filter(Boolean))].sort();
    const classes  = [...new Set(classSnap.docs.map(d => d.data().class_grade).filter(Boolean))].sort();
    const subjects = [...new Set(classSnap.docs.map(d => d.data().subject).filter(Boolean))].sort();

    res.json({
      states:   states.length ? states.map(s => ({ code: s, name: s })) : [
        { code: 'GJ', name: 'Gujarat' }, { code: 'MH', name: 'Maharashtra' },
        { code: 'UP', name: 'Uttar Pradesh' }, { code: 'MP', name: 'Madhya Pradesh' },
      ],
      classes:  classes.length ? classes : ['Class 6','Class 7','Class 8','Class 9','Class 10'],
      subjects: subjects.length ? subjects : ['Science','Mathematics','Social Science','English'],
      languages: ['English','Hindi','Gujarati','Marathi','Tamil','Kannada','Telugu','Bengali'],
      topics:   [],
      quizzes:  [],
    });
  } catch (_) {
    res.json({
      states: [{ code: 'GJ', name: 'Gujarat' }, { code: 'MH', name: 'Maharashtra' }],
      classes: ['Class 6','Class 7','Class 8','Class 9','Class 10'],
      subjects: ['Science','Mathematics','Social Science','English'],
      languages: ['English','Hindi','Gujarati'],
      topics: [], quizzes: [],
    });
  }
});

// ── GET /analytics  — Notification send/delivery stats ───────────────────────
router.get('/analytics', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('notifications').get();
    const sent      = snap.size;
    const delivered = snap.docs.filter(d => d.data().fcm_message_id).length;
    res.json({ sent, delivered, opened: 0, failed: sent - delivered });
  } catch (_) {
    res.json({ sent: 0, delivered: 0, opened: 0, failed: 0 });
  }
});

// ── GET /analytics/export  — Download notification log ───────────────────────
router.get('/analytics/export', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('notifications').orderBy('created_at', 'desc').limit(500).get();
    res.json({ data: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (_) {
    res.json({ data: [] });
  }
});

// ── POST /dispatch-scheduled  ─────────────────────────────────────────────────
// Called by a Cloud Scheduler cron job every 15 minutes.
// Finds pending notifications whose scheduled_at has passed and fires them via FCM.
router.post('/dispatch-scheduled', async (req, res) => {
  try {
    const db  = getFirestore();
    const now = new Date();
    const snap = await db.collection('scheduled_notifications')
      .where('status', '==', 'pending')
      .where('scheduled_at', '<=', now)
      .limit(50)
      .get();

    if (snap.empty) return res.json({ dispatched: 0 });

    const messaging = getMessaging();
    let dispatched  = 0;

    for (const doc of snap.docs) {
      const n = doc.data();
      try {
        const fcmId = await messaging.send({
          notification: { title: n.title, body: n.body },
          data: n.data_payload || {},
          android: { priority: 'high', notification: { channelId: 'mitra_content' } },
          topic: n.topic,
        });

        await doc.ref.update({ status: 'sent', sent_at: new Date(), fcm_message_id: fcmId });

        // Archive to notifications collection for history
        await db.collection('notifications').doc(doc.id).set({
          ...n, status: 'sent', sent_at: new Date(), fcm_message_id: fcmId,
        });

        dispatched++;
        log.info({ id: doc.id, topic: n.topic, fcm_id: fcmId }, 'Scheduled notification dispatched');
      } catch (err) {
        await doc.ref.update({ status: 'failed', error: err.message });
        log.error({ id: doc.id, err: err.message }, 'Scheduled notification failed');
      }
    }

    res.json({ dispatched });
  } catch (err) {
    res.status(500).json({ error: 'Dispatch failed', detail: err.message });
  }
});

module.exports = router;
