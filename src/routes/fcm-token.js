// routes/fcm-token.js
//
// Registers a provider's FCM token so dispatch.js can push to them even
// when their app is backgrounded or killed. Kept as its own small router
// rather than merged into your existing providers.js, since I don't have
// that file — mount it alongside your other provider routes (see bottom
// of this file for how).

const express = require('express');
const { supabase } = require('../supabase');

const router = express.Router();

router.post('/providers/:id/fcm-token', async (req, res) => {
  const { id } = req.params;
  const { fcmToken } = req.body;

  if (!fcmToken) {
    return res.status(400).json({ error: 'fcmToken is required' });
  }

  const { error } = await supabase
    .from('users')
    .update({ fcm_token: fcmToken })
    .eq('id', id);

  if (error) {
    console.error('❌ FCM token save error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json({ ok: true });
});

module.exports = router;

// -----------------------------------------------------------------------
// Mounting: in server.js (or wherever your other routers are mounted
// alongside the existing '/providers/:id/status' etc. routes), add:
//
//   const fcmTokenRoutes = require('./routes/fcm-token');
//   app.use(fcmTokenRoutes);
//
// If your existing provider routes are already namespaced under a base
// path (e.g. app.use('/api', providerRoutes)), mount this the same way
// so it lines up with the '$API_URL/providers/:id/fcm-token' path the
// Flutter client calls.
//
// SQL migration required before this route will work:
//
//   ALTER TABLE users ADD COLUMN fcm_token TEXT;
// -----------------------------------------------------------------------
