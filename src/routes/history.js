// Add this route to your existing requests.js router
// GET /requests/history/:phone — fetch request history for a user

router.get('/history/:phone', async (req, res) => {
  const { phone } = req.params;

  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  try {
    const { data, error } = await supabase
      .from('service_requests')
      .select('id, type, status, address, eta_minutes, created_at')
      .eq('phone', phone)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('❌ History fetch error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch history' });
    }

    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('History error:', err.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});