const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');

// GET /contacts/:userId — get all contacts for a user
router.get('/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('emergency_contacts')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ contacts: data || [] });
  } catch (err) {
    console.error('Get contacts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// POST /contacts — add a new contact
router.post('/', async (req, res) => {
  const { userId, name, phone, relationship } = req.body;

  if (!userId || !name || !phone) {
    return res.status(400).json({ error: 'userId, name and phone are required' });
  }

  try {
    const { data, error } = await supabase
      .from('emergency_contacts')
      .insert({
        user_id: userId,
        name,
        phone,
        relationship: relationship || '',
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ contact: data });
  } catch (err) {
    console.error('Add contact error:', err.message);
    res.status(500).json({ error: 'Failed to add contact' });
  }
});

// DELETE /contacts/:id — delete a contact
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('emergency_contacts')
      .delete()
      .eq('id', req.params.id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete contact error:', err.message);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

module.exports = router;