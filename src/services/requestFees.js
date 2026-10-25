const { supabase } = require('./supabase');

const REQUEST_FEE_CURRENCY = 'KES';

/**
 * Fee in cents for a service, read from services.request_fee_cents.
 *
 * - NULL or 0  -> the service has no request fee (returns 0).
 * - Unknown key -> THROWS, so a typo can never silently give away a paid
 *   service. The routes turn a throw into a 500 / 502 error response.
 *
 * Deliberately not cached: edits to the services table apply on the very
 * next request, which keeps testing (e.g. setting 100 = KES 1) simple.
 */
async function getRequestFeeCents(type) {
  const { data, error } = await supabase
    .from('services')
    .select('request_fee_cents')
    .eq('key', type)
    .maybeSingle();

  if (error) throw new Error(`services lookup failed: ${error.message}`);
  if (!data) throw new Error(`Unknown service "${type}"`);

  return data.request_fee_cents ?? 0;
}

module.exports = { getRequestFeeCents, REQUEST_FEE_CURRENCY };