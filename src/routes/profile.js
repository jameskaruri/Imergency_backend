// GET /providers/profile/:userId
// Powers the provider profile screen: user info + provider details + their services.
router.get('/profile/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    // Base user info (full_name, phone)
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, full_name, phone, user_type')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      console.error('Profile user lookup error:', userError);
      return res.status(404).json({ error: 'User not found' });
    }

    // Provider record (id_number, vehicle_info, location, status, rating)
    const { data: provider, error: providerError } = await supabase
      .from('providers')
      .select('id, id_number, vehicle_info, location, status, rating')
      .eq('user_id', userId)
      .maybeSingle();

    if (providerError) {
      console.error('Profile provider lookup error:', providerError);
      return res.status(500).json({ error: 'Failed to load provider details' });
    }

    if (!provider) {
      return res.json({ user, provider: null, services: [] });
    }

    // Approved/pending services tied to this provider, joined to service names
    const { data: providerServices, error: servicesError } = await supabase
      .from('provider_services')
      .select('status, services ( key, title, icon )')
      .eq('provider_id', userId);

    if (servicesError) {
      console.error('Profile services lookup error:', servicesError);
      return res.status(500).json({ error: 'Failed to load services' });
    }

    res.json({
      user,
      provider,
      services: (providerServices || []).map((ps) => ({
        key: ps.services?.key,
        title: ps.services?.title,
        icon: ps.services?.icon,
        status: ps.status,
      })),
    });
  } catch (err) {
    console.error('Profile fetch error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});