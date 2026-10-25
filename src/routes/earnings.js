const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');

const ICONS = {
  breakdown: 'car',
  fuel: 'flame',
  tyre: 'radio-button-on',
  medical: 'medkit',
  jumpstart: 'battery-charging',
  ambulance: 'medkit',
  ev: 'flash',
};

function periodStart(period) {
  const now = new Date();
  const start = new Date(now);

  if (period === 'this_week') {
    const day = start.getDay(); // 0 = Sunday
    const diffToMonday = (day === 0 ? -6 : 1) - day;
    start.setDate(start.getDate() + diffToMonday);
  } else if (period === 'this_month') {
    start.setDate(1);
  }
  // 'today' (and anything else) just uses today's date as-is

  start.setHours(0, 0, 0, 0);
  return start;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /providers/:id/earnings?period=today|this_week|this_month
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/earnings', async (req, res) => {
  const providerId = req.params.id;
  const period = req.query.period || 'today';

  try {
    const start = periodStart(period);

    // Your status column only has 'pending' / 'no_providers' in practice —
    // there's no 'completed' (or similar) value being set anywhere yet, so
    // filtering on status isn't reliable. Using `pay_amount IS NOT NULL`
    // instead: a request only has a pay_amount once it's been priced/paid,
    // which is the actual signal we care about for earnings. Once you add
    // a real completion step (see note below), you can tighten this back
    // up with a status filter if you want to be stricter.
    //
    // Scoping on `current_provider_id` to match dispatch.js, since
    // requests.js's /active route was filtering on a different column
    // (provider_id) that doesn't appear to exist on this table — flagged
    // earlier as a likely bug.
    const { data: jobs, error } = await supabase
      .from('service_requests')
      .select(`
        id,
        type,
        status,
        pay_amount,
        created_at,
        customer:user_id ( full_name )
      `)
      .eq('current_provider_id', providerId)
      .not('pay_amount', 'is', null)
      .gte('created_at', start.toISOString())
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Earnings period lookup error:', error);
      return res.status(500).json({ error: 'Failed to fetch earnings', detail: error.message });
    }

    const rows = jobs || [];
    const total = rows.reduce((sum, r) => sum + (r.pay_amount || 0), 0);
    const jobCount = rows.length;
    const avg = jobCount > 0 ? total / jobCount : 0;

    const transactions = rows.map((r) => ({
      id: r.id,
      type: r.type,
      customer: r.customer?.full_name ?? 'Customer',
      amount: r.pay_amount || 0,
      date: r.created_at,
      status: r.pay_amount ? 'paid' : 'pending',
      icon: ICONS[r.type] ?? 'car',
    }));

    // ASSUMPTION 2: table is named 'payouts' with these columns and a
    // 'status' of 'scheduled' for the upcoming one. You mentioned you
    // have this table but didn't share its columns — adjust the
    // .select()/.eq() below to match the real names.
    const { data: payout, error: payoutError } = await supabase
      .from('payouts')
      .select('amount, scheduled_date, method, phone')
      .eq('provider_id', providerId)
      .eq('status', 'scheduled')
      .order('scheduled_date', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (payoutError) {
      console.error('Payout lookup error:', payoutError.message);
    }

    res.json({
      summary: { total, jobs: jobCount, avg },
      transactions,
      nextPayout: payout || null,
    });

  } catch (err) {
    console.error('Earnings route error:', err.message);
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

module.exports = router;