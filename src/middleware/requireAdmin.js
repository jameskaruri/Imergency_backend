const { supabase } = require('../services/supabase');

// Verifies the bearer token is a valid Supabase session AND that the user
// behind it has a row in `admins`. Two checks, not one — a valid login
// alone isn't enough, since regular app users (customers/providers) also
// authenticate through Supabase.
async function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const { data: admin, error: adminError } = await supabase
      .from('admins')
      .select('id, email, role')
      .eq('user_id', user.id)
      .maybeSingle();

    if (adminError) {
      console.error('Admin lookup error:', adminError.message);
      return res.status(500).json({ error: 'Failed to verify admin access' });
    }

    if (!admin) {
      return res.status(403).json({ error: 'Not authorized as an admin' });
    }

    req.admin = admin; // available to every route in routes/admin.js
    next();
  } catch (err) {
    console.error('requireAdmin error:', err.message);
    res.status(500).json({ error: 'Failed to verify admin access' });
  }
}

module.exports = { requireAdmin };
