// ─────────────────────────────────────────────────────────────────────────────
// Paste into routes/providers.js (the router that serves /providers/...).
// It needs `router` and `supabase`, which that file already has; the UUID
// regex is defined here in case it doesn't.
// ─────────────────────────────────────────────────────────────────────────────

const RATINGS_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────────────
// GET /providers/:id/ratings
// :id is the provider's users.id (the same id the profile screen uses).
//
// {
//   average: 4.5 | null,
//   count: 12,
//   distribution: { "1": 0, "2": 1, "3": 0, "4": 3, "5": 8 },
//   topTags: [{ tag: "On time", count: 7 }, ...],      // up to 5
//   recent:  [{ rating, tags, comment, createdAt }, ...] // latest 10
// }
//
// Customer identity is deliberately NOT returned.
// Stats are computed over the latest 500 ratings; if a provider ever has far
// more than that, switch to a SQL aggregate (view or rpc).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/ratings', async (req, res) => {
  const { id } = req.params;

  if (!RATINGS_UUID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid provider id' });
  }

  try {
    const { data, error } = await supabase
      .from('request_ratings')
      .select('rating, tags, comment, created_at')
      .eq('provider_id', id)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      console.error('❌ Provider ratings fetch error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch ratings' });
    }

    const rows = data || [];
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const tagCounts = new Map();
    let sum = 0;

    for (const row of rows) {
      distribution[row.rating] = (distribution[row.rating] || 0) + 1;
      sum += row.rating;
      for (const tag of row.tags || []) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }

    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag, count]) => ({ tag, count }));

    res.json({
      average: rows.length ? Math.round((sum / rows.length) * 100) / 100 : null,
      count: rows.length,
      distribution,
      topTags,
      recent: rows.slice(0, 10).map((r) => ({
        rating: r.rating,
        tags: r.tags || [],
        comment: r.comment,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('❌ Provider ratings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch ratings' });
  }
});
