// Put this file in src/services/ (NOT src/routes/): it requires './supabase',
// which only resolves from the services folder.
const { supabase } = require('./supabase');

/**
 * Atomically claims a succeeded, unused payment for this customer and
 * service type. Returns { id } or null. Because the UPDATE only matches
 * rows where used_at IS NULL, two simultaneous requests can never spend the
 * same payment twice.
 *
 * minAmountCents: the payment must cover at least the current fee, so a
 * payment made at a cheaper price can't be redeemed after the fee goes up.
 */
async function claimPayment({ paymentId, type, userPhone, minAmountCents = 0 }) {
  if (!paymentId) return null;

  const { data, error } = await supabase
    .from('request_fee_payments')
    .update({ used_at: new Date().toISOString() })
    .eq('id', paymentId)
    .eq('status', 'succeeded')
    .eq('service_type', type)
    .eq('user_phone', userPhone)
    .gte('amount_cents', minAmountCents)
    .is('used_at', null)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('❌ Claim payment error:', error.message);
    return null;
  }
  return data ?? null;
}

/** Links a claimed payment to the request it paid for. */
async function markPaymentUsed(paymentId, requestId) {
  const { error } = await supabase
    .from('request_fee_payments')
    .update({ used_request_id: requestId })
    .eq('id', paymentId);
  if (error) console.error('❌ Mark payment used error:', error.message);
}

/** Gives a claimed payment back if the request was never created, so the customer can retry without paying again. */
async function releasePayment(paymentId) {
  const { error } = await supabase
    .from('request_fee_payments')
    .update({ used_at: null })
    .eq('id', paymentId)
    .is('used_request_id', null);
  if (error) console.error('❌ Release payment error:', error.message);
}

/**
 * Un-spends whatever payment is linked to this request (used_request_id),
 * so a customer who cancels can retry without a fresh M-Pesa charge — see
 * RequestTrackingScreen._retryWithOtherProvider, which passes the released
 * payment's id straight back into POST /requests/create's paymentId.
 *
 * Unlike releasePayment() above — which deliberately refuses to touch a
 * payment that's already linked to a request — this function's whole job
 * is to release one that IS linked. That's safe here specifically because
 * the only caller is POST /requests/:id/cancel, and only after the CAS
 * update there has confirmed the request itself actually moved to
 * 'cancelled'. Never call this for a request that might still be live.
 *
 * Clears both used_at and used_request_id so the payment is fully
 * reusable: claimPayment()'s `.is('used_at', null)` guard would otherwise
 * still reject it even with used_request_id cleared.
 *
 * Returns the released payment's { id }, or null if there was nothing to
 * release (free request, already-released, or a lookup error — logged,
 * never thrown, since a release failure must not turn a successful
 * cancellation into an error response for the customer).
 */
async function releasePaymentForRequest(requestId) {
  if (!requestId) return null;

  try {
    const { data, error } = await supabase
      .from('request_fee_payments')
      .update({ used_at: null, used_request_id: null })
      .eq('used_request_id', requestId)
      .eq('status', 'succeeded')
      .select('id')
      .maybeSingle();

    if (error) {
      console.error(`❌ Release payment for cancelled request ${requestId} error:`, error.message);
      return null;
    }
    return data ?? null;
  } catch (err) {
    console.error(`❌ Release payment for cancelled request ${requestId} threw:`, err.message);
    return null;
  }
}

module.exports = { claimPayment, markPaymentUsed, releasePayment, releasePaymentForRequest };