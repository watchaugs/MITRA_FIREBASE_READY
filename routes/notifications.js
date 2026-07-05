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

module.exports = router;
