const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');

// Pulls each service together with its options, and each option with its
// variants (e.g. Gas > LPG Cylinder > Total 13kg).
const SERVICE_SELECT = `
  *,
  service_options (
    id, key, label, subtitle, is_active, sort_order,
    unit, quantity_mode, min_qty, step,
    option_variants ( id, name, brand, size_value, size_unit, is_active )
  )
`;

// Only active options and variants are sent, in display order. Pricing is
// deliberately left out: the apps don't need it to let a provider choose what
// they offer, and fees are worked out server-side.
function toSubServices(row) {
  return (row.service_options || [])
    .filter((o) => o.is_active)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((o) => ({
      id: o.id,
      key: o.key,
      label: o.label,
      subtitle: o.subtitle,
      is_active: o.is_active,
      unit: o.unit,
      quantity_mode: o.quantity_mode,
      min_qty: o.min_qty,
      step: o.step,
      option_variants: (o.option_variants || [])
        .filter((v) => v.is_active)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((v) => ({
          id: v.id,
          name: v.name,
          brand: v.brand,
          size_value: v.size_value,
          size_unit: v.size_unit,
          is_active: v.is_active,
        })),
    }));
}

// Existing fields are unchanged, so apps that already use this route keep
// working. `sub_services` is new; the provider register screen reads it.
// `requestFee` is the per-request fee in whole KES (services.request_fee_cents
// / 100), shown on the service card. NULL or 0 means free. It is display-only:
// POST /requests/create enforces the real fee from the database through
// getRequestFeeCents, never from anything the client sends.
function toClientShape(row) {
  return {
    key: row.key,
    title: row.title,
    subtitle: row.subtitle,
    icon: row.icon,
    color: row.color,
    responseType: row.response_type,
    etaMinutes: row.eta_minutes,
    requestFee: row.request_fee_cents == null ? null : Number(row.request_fee_cents) / 100,
    options: row.options || [], // legacy free-form JSON column
    sub_services: toSubServices(row),
    comingSoon: row.coming_soon,
  };
}

// GET /services -> active services for the home screen grid
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('services')
      .select(SERVICE_SELECT)
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json({ services: data.map(toClientShape) });
  } catch (err) {
    console.error('Failed to fetch services:', err);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

// GET /services/:key -> a single service's config, used as a fallback if the
// app navigates directly to /service?type=key without a cached service object
router.get('/:key', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('services')
      .select(SERVICE_SELECT)
      .eq('key', req.params.key)
      .eq('is_active', true)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Service not found' });
    }
    res.json({ service: toClientShape(data) });
  } catch (err) {
    console.error('Failed to fetch service:', err);
    res.status(500).json({ error: 'Failed to fetch service' });
  }
});

module.exports = router;