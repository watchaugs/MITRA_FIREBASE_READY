'use strict';
const router = require('express').Router();
const { authenticate, requirePerm } = require('../middleware/auth');
router.use(authenticate);

router.get('/', async (req, res) => res.json({ data: [], total: 0 }));
router.post('/send', requirePerm('perm_view_notif'), async (req, res) => {
  res.json({ success: true, message: 'Notification queued', id: require('uuid').v4() });
});
router.post('/schedule', requirePerm('perm_view_notif'), async (req, res) => {
  res.json({ success: true, message: 'Notification scheduled', id: require('uuid').v4() });
});
router.get('/history', async (req, res) => res.json({ data: [], total: 0 }));
router.delete('/:id', async (req, res) => res.json({ message: 'Notification cancelled' }));
router.get('/filters', async (req, res) => res.json({
  states:   [{ code: 'GJ', name: 'Gujarat' }, { code: 'MH', name: 'Maharashtra' }, { code: 'UP', name: 'Uttar Pradesh' }, { code: 'KA', name: 'Karnataka' }, { code: 'TN', name: 'Tamil Nadu' }],
  classes:  ['Class 6', 'Class 7', 'Class 8', 'Class 9', 'Class 10'],
  subjects: ['Science', 'Mathematics', 'Social Science', 'English'],
  topics:   ['Cell Division', 'Photosynthesis', 'Algebra', 'Trigonometry'],
  quizzes:  [],
  languages: ['English', 'Hindi', 'Gujarati', 'Marathi', 'Tamil', 'Kannada'],
}));
router.get('/analytics', async (req, res) => res.json({ sent: 0, delivered: 0, opened: 0, failed: 0 }));
router.get('/analytics/export', async (req, res) => res.json({ data: [] }));
router.post('/dispatch-scheduled', async (req, res) => res.json({ dispatched: 0 }));

module.exports = router;
