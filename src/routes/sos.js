const express = require('express');
const router = express.Router();
const { sendSMS, buildSOSMessage } = require('../services/sms');
const { supabase } = require('../services/supabase');

// POST /sos/trigger
router.post('/trigger', async (req, res) => {
  const { userName, address, latitude, longitude, contacts } = req.body;

  try {
    if (!contacts || contacts.length === 0) {
      return res.status(400).json({ error: 'No emergency contacts provided' });
    }

    // Save SOS event to database
    const { data: sosEvent, error: dbError } = await supabase
      .from('sos_events')
      .insert({
        user_name: userName,
        address,
        latitude,
        longitude,
        status: 'active',
      })
      .select()
      .single();

    if (dbError) {
      console.error('DB error:', dbError);
    }

    // Build SOS message
    const message = buildSOSMessage(userName, address, latitude, longitude);

    // Send SMS to all emergency contacts
    await sendSMS(contacts, message);

    // Update contacts_notified count
    if (sosEvent) {
      await supabase
        .from('sos_events')
        .update({ contacts_notified: contacts.length })
        .eq('id', sosEvent.id);
    }

    // Notify via socket.io
    const io = req.app.get('io');
    io.emit('sos_triggered', {
      userName,
      address,
      latitude,
      longitude,
      timestamp: new Date(),
    });

    console.log(`🚨 SOS triggered by ${userName} at ${address} — saved to DB`);

    res.json({
      success: true,
      message: `SOS alert sent to ${contacts.length} contacts`,
      sosEventId: sosEvent?.id,
    });

  } catch (err) {
    console.error('SOS error:', err);
    res.status(500).json({ error: 'Failed to send SOS alert' });
  }
});

// POST /sos/resolve
router.post('/resolve', async (req, res) => {
  const { userName, contacts, sosEventId } = req.body;

  try {
    const message = `✅ i-Emergency: ${userName} is now safe. Emergency resolved. Thank you.`;
    await sendSMS(contacts, message);

    if (sosEventId) {
      await supabase
        .from('sos_events')
        .update({ status: 'resolved' })
        .eq('id', sosEventId);
    }

    res.json({ success: true, message: 'SOS resolved' });
  } catch (err) {
    console.error('Resolve error:', err);
    res.status(500).json({ error: 'Failed to resolve SOS' });
  }
});

module.exports = router;