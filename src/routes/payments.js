const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { stkPush } = require('../services/mpesa');
const { getRequestFeeCents, REQUEST_FEE_CURRENCY } = require('../services/requestFee');

// Mount in server.js:
//   app.use('/payments', require('./routes/payments'));
//
// The M-Pesa result arrives at your existing MPESA_CALLBACK_URL
// (POST /providers/mpesa/callback). That handler must branch on
// payment.purpose — see the patch in the notes.

// ─────────────────────────────────────────────────────────────────────────────
// GET /payments/request-fee?type=mechanic
// Tells the app how much (if anything) to charge before sending the request.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/request-fee', async (req, res) => {
  const { type } = req.query;
  if (!type) return res.status(400).json({ error: 'type is required' });

  try {
    const feeCents = await getRequestFeeCents(String(type));
    res.json({
      type,
      feeCents,
      currency: REQUEST_FEE_CURRENCY,
      required: feeCents > 0,
    });
  } catch (err) {
    console.error('❌ Request fee route error:', err.message);
    res.status(500).json({ error: 'Failed to load request fee' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /payments/request-fee/pay
// Body: { type, phone, userPhone }
//   phone     = the M-Pesa number that gets the prompt (may differ from
//               the customer's account phone)
//   userPhone = the customer's account phone; the payment is bound to it
//               and POST /requests/create checks it matches.
// Only confirms the prompt was sent. Success is reported asynchronously.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/request-fee/pay', async (req, res) => {
  const { type, phone, userPhone } = req.body;

  if (!type || !phone || !userPhone) {
    return res.status(400).json({ error: 'type, phone and userPhone are required' });
  }

  try {
    const feeCents = await getRequestFeeCents(type);
    if (feeCents <= 0) {
      return res.status(400).json({ error: 'No fee is required for this service.' });
    }

    // Record the attempt first so a callback can never arrive for a payment
    // we have no row for.
    const { data: payment, error: insertError } = await supabase
      .from('payments')
      .insert({
        purpose: 'service_request',
        amount_cents: feeCents,
        currency: REQUEST_FEE_CURRENCY,
        status: 'pending',
        provider: 'mpesa',
        payer_phone: userPhone,
        service_type: type,
      })
      .select('id')
      .single();

    if (insertError || !payment) {
      console.error('❌ Request payment insert error:', insertError?.message);
      return res.status(500).json({ error: 'Failed to start payment' });
    }

    const failPayment = (reason) =>
      supabase.from('payments').update({ status: 'failed', failure_reason: reason }).eq('id', payment.id);

    let stkResponse;
    try {
      stkResponse = await stkPush({
        phone,
        amount: Math.round(feeCents / 100), // M-Pesa takes whole shillings
        accountReference: `request-${type}`,
        transactionDesc: 'Service request fee',
      });
    } catch (mpesaErr) {
      console.error('❌ STK push error:', mpesaErr.response?.data || mpesaErr.message);
      await failPayment('Could not reach M-Pesa');
      return res.status(502).json({ error: 'Could not reach M-Pesa. Please try again.' });
    }

    if (stkResponse.ResponseCode !== '0') {
      console.error('❌ STK push rejected:', stkResponse);
      await failPayment(stkResponse.ResponseDescription || 'STK push rejected');
      return res
        .status(400)
        .json({ error: stkResponse.ResponseDescription || 'Payment could not be started.' });
    }

    const { error: refError } = await supabase
      .from('payments')
      .update({ provider_ref: stkResponse.CheckoutRequestID })
      .eq('id', payment.id);

    if (refError) {
      // Without the ref the callback can't find this row. Log loudly.
      console.error('❌ Request payment ref update error:', refError.message);
    }

    res.json({ success: true, checkoutRequestId: stkResponse.CheckoutRequestID });
  } catch (err) {
    console.error('❌ Request fee pay error:', err.message);
    res.status(500).json({ error: 'Failed to start payment' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /payments/request-fee/status/:checkoutRequestId
// Polled by the app after the STK prompt. Returns the paymentId once the
// payment has succeeded; the app sends that to POST /requests/create.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/request-fee/status/:checkoutRequestId', async (req, res) => {
  try {
    const { data: payment, error } = await supabase
      .from('payments')
      .select('id, status, failure_reason')
      .eq('purpose', 'service_request')
      .eq('provider', 'mpesa')
      .eq('provider_ref', req.params.checkoutRequestId)
      .maybeSingle();

    if (error) {
      console.error('❌ Request payment status error:', error.message);
      return res.status(500).json({ error: 'Failed to check payment' });
    }
    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    res.json({
      status: payment.status, // 'pending' | 'succeeded' | 'failed'
      paymentId: payment.status === 'succeeded' ? payment.id : null,
      failureReason: payment.status === 'failed' ? payment.failure_reason : null,
    });
  } catch (err) {
    console.error('❌ Request payment status error:', err.message);
    res.status(500).json({ error: 'Failed to check payment' });
  }
});

module.exports = router;
