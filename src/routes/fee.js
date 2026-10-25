const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { stkPush, stkPushQuery, normalizeKenyanPhone } = require('../services/mpesa');
const { getRequestFeeCents, REQUEST_FEE_CURRENCY } = require('../services/requestFees');

// Mounted in routes/requests.js as router.use('/fee', ...), so these are:
//   GET  /requests/fee?type=
//   POST /requests/fee/pay
//   GET  /requests/fee/status/:checkoutId
//   POST /requests/fee/callback   (called by Safaricom, not the app)
//
// Table: request_fee_payments. Columns used here:
//   user_phone, mpesa_phone, service_type, amount_cents, currency, status,
//   checkout_request_id, merchant_request_id, mpesa_receipt, failure_reason,
//   created_at, paid_at, used_at
// (NOT "type" and NOT "checkout_id".)

const FAILURE_REASONS = {
  1: 'Insufficient M-Pesa balance.',
  1032: 'You cancelled the payment.',
  1037: 'The M-Pesa prompt timed out. Please try again.',
  2001: 'Wrong M-Pesa PIN entered.',
};

// A pending prompt younger than this is still live on the customer's phone,
// so /pay reuses it instead of sending a second one.
const PENDING_REUSE_MS = 2 * 60 * 1000;

// Daraja answers a status query with ResultCode 4999 / "still under
// processing" while the payment is in flight. That is NOT a result: the
// customer may already have entered their PIN and the money may already be
// gone. Never settle on it.
function isStillProcessing(resultCode, resultDesc) {
  if (Number(resultCode) === 4999) return true;
  return /still under process|being processed|in progress/i.test(String(resultDesc || ''));
}

// Marks a payment succeeded/failed.
//  - Pending results are ignored (see isStillProcessing).
//  - A failure only lands on a 'pending' row.
//  - A SUCCESS is authoritative (Safaricom confirmed the money moved), so it
//    also repairs a row that was wrongly marked 'failed' earlier.
//  Duplicate callbacks and a callback racing the status-query fallback are
//  harmless no-ops.
async function settlePayment(checkoutId, resultCode, resultDesc, receipt) {
  if (isStillProcessing(resultCode, resultDesc)) return;

  const code = Number(resultCode);
  let query = supabase.from('request_fee_payments');

  if (code === 0) {
    query = query
      .update({
        status: 'succeeded',
        mpesa_receipt: receipt ?? null,
        paid_at: new Date().toISOString(),
        failure_reason: null,
      })
      .eq('checkout_request_id', checkoutId)
      .in('status', ['pending', 'failed']);
  } else {
    query = query
      .update({
        status: 'failed',
        failure_reason: FAILURE_REASONS[code] || resultDesc || 'Payment failed.',
      })
      .eq('checkout_request_id', checkoutId)
      .eq('status', 'pending');
  }

  const { error } = await query;
  if (error) console.error('❌ Settle payment error:', error.message);
}

// Safety net for lost callbacks: every minute, ask Daraja about payments still
// pending after 30s (and up to 30 min old). Results go through settlePayment.
async function reconcilePending() {
  try {
    const now = Date.now();
    const { data } = await supabase
      .from('request_fee_payments')
      .select('checkout_request_id')
      .eq('status', 'pending')
      .not('checkout_request_id', 'is', null)
      .lt('created_at', new Date(now - 30 * 1000).toISOString())
      .gt('created_at', new Date(now - 30 * 60 * 1000).toISOString())
      .limit(20);

    for (const row of data ?? []) {
      try {
        const q = await stkPushQuery(row.checkout_request_id);
        if (q?.ResultCode !== undefined && q?.ResultCode !== null) {
          await settlePayment(row.checkout_request_id, q.ResultCode, q.ResultDesc, null);
        }
      } catch (_) {
        // not ready yet; try again next minute
      }
    }
  } catch (err) {
    console.error('⚠️ reconcilePending failed:', err.message);
  }
}
if (!global.__feePendingSweeper) {
  global.__feePendingSweeper = setInterval(reconcilePending, 60 * 1000);
  global.__feePendingSweeper.unref?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /requests/fee?type=mechanic  ->  { feeCents, currency }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { type } = req.query;
  if (!type) return res.status(400).json({ error: 'type is required' });

  try {
    const feeCents = await getRequestFeeCents(type);
    res.json({ feeCents, currency: REQUEST_FEE_CURRENCY });
  } catch (err) {
    console.error('❌ Fee lookup threw:', err.message);
    res.status(500).json({ error: 'Could not load the request fee.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /requests/fee/pay  { type, mpesaPhone, userPhone }  ->  { checkoutId }
//
// Order matters: (1) reuse a live/unspent payment if there is one, (2) record
// a pending row, (3) ONLY THEN send the STK push. If the insert fails we
// return before any money can be requested, so a prompt can never go out
// without a row for the callback to settle.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/pay', async (req, res) => {
  const { type, mpesaPhone, userPhone } = req.body;

  if (!type || !mpesaPhone || !userPhone) {
    return res.status(400).json({ error: 'type, mpesaPhone and userPhone are required' });
  }

  const phone = normalizeKenyanPhone(mpesaPhone);
  if (!/^254[17]\d{8}$/.test(phone)) {
    return res.status(400).json({ error: 'Enter a valid Safaricom number, e.g. 0712345678.' });
  }

  let paymentId = null;
  try {
    const feeCents = await getRequestFeeCents(type);
    if (feeCents <= 0) {
      return res.status(400).json({ error: 'No fee is required for this service.' });
    }
    if (feeCents % 100 !== 0) {
      // STK push takes whole shillings; refuse rather than charge a number
      // that differs from what we record.
      console.error(`❌ Fee for "${type}" is not whole shillings: ${feeCents}`);
      return res.status(500).json({ error: 'Could not load the request fee.' });
    }

    // 1) Reuse an existing payment instead of charging twice.
    const { data: existing, error: existingError } = await supabase
      .from('request_fee_payments')
      .select('checkout_request_id, status, created_at')
      .eq('user_phone', userPhone)
      .eq('service_type', type)
      .eq('mpesa_phone', phone)
      .is('used_at', null)
      .not('checkout_request_id', 'is', null)
      .in('status', ['pending', 'succeeded'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingError) {
      console.error('⚠️ Existing payment lookup error:', existingError.message);
    } else if (existing) {
      const ageMs = Date.now() - new Date(existing.created_at).getTime();
      if (existing.status === 'succeeded' || ageMs < PENDING_REUSE_MS) {
        return res.json({ checkoutId: existing.checkout_request_id });
      }
    }

    // 2) Insert first so the callback can never arrive before the row exists.
    const { data: row, error: insertError } = await supabase
      .from('request_fee_payments')
      .insert({
        user_phone: userPhone,
        mpesa_phone: phone,
        service_type: type,
        amount_cents: feeCents,
        currency: REQUEST_FEE_CURRENCY,
        status: 'pending',
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('❌ Fee payment insert error:', insertError.message);
      return res.status(500).json({ error: 'Could not start the payment. Please try again.' });
    }
    paymentId = row.id;

    // 3) Now it is safe to ask the customer for money.
    const data = await stkPush({
      phone,
      amount: feeCents / 100,
      accountReference: 'Request',
      description: 'Request fee',      // name used by requests.js's old call
      transactionDesc: 'Request fee',  // name used by the newer call; extra key is ignored
    });

    const { error: linkError } = await supabase
      .from('request_fee_payments')
      .update({
        checkout_request_id: data.CheckoutRequestID,
        merchant_request_id: data.MerchantRequestID,
      })
      .eq('id', paymentId);

    if (linkError) {
      // The prompt is already on the customer's phone, so don't fail the
      // request. Log loudly: this payment can't be matched by checkout id.
      console.error('❌ Could not save checkout id for payment', paymentId, linkError.message);
    }

    res.json({ checkoutId: data.CheckoutRequestID });
  } catch (err) {
    // stkPush already logs the Daraja response body; this covers the rest.
    console.error('❌ Fee pay error:', err.response?.data || err.message);
    if (paymentId) {
      await supabase
        .from('request_fee_payments')
        .update({ status: 'failed', failure_reason: 'Could not send the M-Pesa prompt' })
        .eq('id', paymentId);
    }
    res.status(502).json({ error: 'Could not send the M-Pesa prompt. Check the number and try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /requests/fee/status/:checkoutId
//   -> { status: 'pending'|'succeeded'|'failed', paymentId?, failureReason? }
// Polled every 3s by the app's fee sheet.
//
// If the callback hasn't arrived after QUERY_AFTER_MS (slow network, or the
// callback URL isn't reachable in dev), fall back to asking Daraja directly
// with stkPushQuery, at most once per QUERY_EVERY_MS per payment so the
// app's 3s polling can't hammer Daraja's rate limit.
// ─────────────────────────────────────────────────────────────────────────────
const QUERY_AFTER_MS = 15 * 1000;
const QUERY_EVERY_MS = 10 * 1000;
const lastQueryAt = new Map(); // checkoutId -> ms

async function loadPayment(checkoutId) {
  return supabase
    .from('request_fee_payments')
    .select('id, status, failure_reason, created_at')
    .eq('checkout_request_id', checkoutId)
    .maybeSingle();
}

router.get('/status/:checkoutId', async (req, res) => {
  const { checkoutId } = req.params;

  try {
    let { data, error } = await loadPayment(checkoutId);

    if (error) {
      console.error('❌ Fee status error:', error.message);
      return res.status(500).json({ error: 'Could not check the payment status.' });
    }
    if (!data) return res.status(404).json({ error: 'Payment not found' });

    if (data.status === 'pending') {
      const age = Date.now() - new Date(data.created_at).getTime();
      const sinceLast = Date.now() - (lastQueryAt.get(checkoutId) ?? 0);

      if (age > QUERY_AFTER_MS && sinceLast > QUERY_EVERY_MS) {
        lastQueryAt.set(checkoutId, Date.now());
        try {
          const q = await stkPushQuery(checkoutId);
          // While the customer is still deciding Daraja answers with an
          // error (no ResultCode), which we just ignore and wait.
          if (q?.ResultCode !== undefined && q?.ResultCode !== null) {
            await settlePayment(checkoutId, q.ResultCode, q.ResultDesc, null);
            const reloaded = await loadPayment(checkoutId);
            if (reloaded.data) data = reloaded.data;
          }
        } catch (queryErr) {
          console.log(
            'ℹ️ STK query not ready yet:',
            queryErr.response?.data?.errorMessage || queryErr.message
          );
        }
      }
    }

    if (data.status !== 'pending') lastQueryAt.delete(checkoutId);

    res.json({
      status: data.status,
      paymentId: data.status === 'succeeded' ? data.id : null,
      failureReason: data.failure_reason ?? null,
    });
  } catch (err) {
    console.error('❌ Fee status threw:', err.message);
    res.status(500).json({ error: 'Could not check the payment status.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /requests/fee/callback?token=<MPESA_CALLBACK_SECRET>
// Safaricom calls this once the customer enters their PIN, cancels, or the
// prompt times out. Safaricom doesn't sign callbacks, so the secret token in
// the URL is what keeps strangers from marking payments as paid.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/callback', async (req, res) => {
  const secret = process.env.MPESA_CALLBACK_SECRET;
  if (!secret || req.query.token !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const cb = req.body?.Body?.stkCallback;
    if (cb?.CheckoutRequestID) {
      console.log('💳 M-Pesa callback:', JSON.stringify(cb));
      const items = cb.CallbackMetadata?.Item ?? [];
      const meta = Object.fromEntries(items.map((i) => [i.Name, i.Value]));
      await settlePayment(cb.CheckoutRequestID, cb.ResultCode, cb.ResultDesc, meta.MpesaReceiptNumber);
    }
  } catch (err) {
    console.error('❌ M-Pesa callback error:', err.message);
  }

  res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // always 200 so Safaricom doesn't retry
});

module.exports = router;