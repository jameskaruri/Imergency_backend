const axios = require('axios');

// Prefer IPv4: Node on Windows can stall on IPv6 lookups.
require('dns').setDefaultResultOrder('ipv4first');

const BASE_URL =
  process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

const TOKEN_TIMEOUT_MS = 30000;
const STK_TIMEOUT_MS = 30000;

let cachedToken = null;
let cachedTokenExpiry = 0;

// ── Startup sanity check (warns, never throws) ──────────────────────────────
(function warnOnBadConfig() {
  const cb = process.env.MPESA_CALLBACK_URL || '';
  if (/mpesa|safaricom/i.test(cb)) {
    console.warn(
      '⚠️  MPESA_CALLBACK_URL contains "mpesa"/"safaricom". Daraja may reject it ' +
        '(Invalid CallBackURL). Use a neutral path such as /payments/callback.',
    );
  }
  if (process.env.MPESA_TRANSACTION_TYPE === 'CustomerBuyGoodsOnline' && !process.env.MPESA_PARTY_B) {
    console.warn('⚠️  Buy Goods needs MPESA_PARTY_B set to your till number.');
  }
})();

async function getAccessToken(forceRefresh = false) {
  if (!forceRefresh && cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }

  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;

  if (!key || !secret) {
    throw new Error('MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET are not set');
  }

  const auth = Buffer.from(`${key}:${secret}`).toString('base64');

  // Retry once: Safaricom is sometimes slow on the first hit.
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { data } = await axios.get(
        `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
        { headers: { Authorization: `Basic ${auth}` }, timeout: TOKEN_TIMEOUT_MS },
      );
      cachedToken = data.access_token;
      cachedTokenExpiry = Date.now() + (Number(data.expires_in || 3599) - 60) * 1000;
      return cachedToken;
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️ M-Pesa token attempt ${attempt} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

// Daraja expects East Africa Time (UTC+3) regardless of server timezone.
function daraTimestamp() {
  const eat = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    eat.getUTCFullYear().toString() +
    pad(eat.getUTCMonth() + 1) +
    pad(eat.getUTCDate()) +
    pad(eat.getUTCHours()) +
    pad(eat.getUTCMinutes()) +
    pad(eat.getUTCSeconds())
  );
}

function normalizeKenyanPhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  if (digits.startsWith('7') || digits.startsWith('1')) return `254${digits}`;
  return digits;
}

// Daraja rejects empty or odd remarks (400.002.02): keep letters, numbers and
// spaces, trim, cap length, and fall back to a default.
function cleanField(value, fallback, maxLen) {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .trim()
    .slice(0, maxLen);
  return cleaned.length >= 2 ? cleaned : fallback;
}

function buildPassword(shortcode, passkey, ts) {
  return Buffer.from(`${shortcode}${passkey}${ts}`).toString('base64');
}

// `description` is accepted as an alias for `transactionDesc`.
// NOTE: the STK push itself is never auto-retried, to avoid sending the
// customer duplicate prompts.
async function stkPush({ phone, amount, accountReference, transactionDesc, description }) {
  const shortcode = process.env.MPESA_SHORTCODE;
  const partyB = process.env.MPESA_PARTY_B || shortcode;
  const transactionType = process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline';
  const passkey = process.env.MPESA_PASSKEY;
  const callbackUrl = process.env.MPESA_CALLBACK_URL;

  if (!shortcode || !passkey || !callbackUrl) {
    throw new Error('MPESA_SHORTCODE / MPESA_PASSKEY / MPESA_CALLBACK_URL are not set');
  }

  const normalizedPhone = normalizeKenyanPhone(phone);
  if (!/^254[17]\d{8}$/.test(normalizedPhone)) {
    throw new Error('Invalid Kenyan phone number');
  }

  const buildBody = () => {
    const ts = daraTimestamp();
    return {
      BusinessShortCode: shortcode,
      Password: buildPassword(shortcode, passkey, ts),
      Timestamp: ts,
      TransactionType: transactionType,
      Amount: Math.max(1, Math.round(amount)),
      PartyA: normalizedPhone,
      PartyB: partyB,
      PhoneNumber: normalizedPhone,
      CallBackURL: callbackUrl,
      AccountReference: cleanField(accountReference, 'iEmergency', 12),
      TransactionDesc: cleanField(transactionDesc ?? description, 'Payment', 13),
    };
  };

  const send = async (forceRefresh) => {
    const token = await getAccessToken(forceRefresh);
    const body = buildBody();
    const { data } = await axios.post(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, body, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: STK_TIMEOUT_MS,
    });
    return { data, body };
  };

  let body;
  try {
    let result;
    try {
      result = await send(false);
    } catch (err) {
      // Expired/invalid cached token: refresh once and retry (safe, the
      // request was rejected before any prompt was sent).
      if (err.response?.status === 401) {
        result = await send(true);
      } else {
        throw err;
      }
    }

    const { data } = result;
    body = result.body;

    console.log('✅ STK push accepted:', {
      BusinessShortCode: shortcode,
      PartyB: partyB,
      TransactionType: transactionType,
      CheckoutRequestID: data.CheckoutRequestID,
      MerchantRequestID: data.MerchantRequestID,
      ResponseCode: data.ResponseCode,
      ResponseDescription: data.ResponseDescription,
      CustomerMessage: data.CustomerMessage,
    });

    return data;
  } catch (err) {
    console.error('❌ STK push request failed:', {
      BusinessShortCode: shortcode,
      PartyB: partyB,
      TransactionType: transactionType,
      AccountReference: body?.AccountReference,
      TransactionDesc: body?.TransactionDesc,
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
    throw err;
  }
}

async function stkPushQuery(checkoutRequestId) {
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;

  if (!shortcode || !passkey) {
    throw new Error('MPESA_SHORTCODE / MPESA_PASSKEY are not set');
  }

  const ts = daraTimestamp();
  const token = await getAccessToken();

  const { data } = await axios.post(
    `${BASE_URL}/mpesa/stkpushquery/v1/query`,
    {
      BusinessShortCode: shortcode,
      Password: buildPassword(shortcode, passkey, ts),
      Timestamp: ts,
      CheckoutRequestID: checkoutRequestId,
    },
    { headers: { Authorization: `Bearer ${token}` }, timeout: STK_TIMEOUT_MS },
  );

  return data;
}

module.exports = { stkPush, stkPushQuery, normalizeKenyanPhone };