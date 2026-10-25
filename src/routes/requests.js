const express = require('express');
const multer = require('multer');
const router = express.Router();
const { sendSMS, buildConfirmationMessage } = require('../services/sms');
const { supabase } = require('../services/supabase');
const { assignRequest, acceptRequest, sendJobCancelledPush } = require('../services/dispatch');
const { getRequestFeeCents } = require('../services/requestFees');
const {
  claimPayment,
  markPaymentUsed,
  releasePayment,
  releasePaymentForRequest,
} = require('../services/requestFeePayments');

// ─────────────────────────────────────────────────────────────────────────────
// SETUP NEEDED
//
//   1. npm install multer
//   2. Supabase Storage bucket `request-attachments` (public, or switch
//      getPublicUrl() to createSignedUrl()).
//   3. service_requests.attachment_url (text) must exist.
//   4. The supabase client must use the service-role key.
//   5. Run migration.sql: service_requests.excluded_provider_ids (uuid[]),
//      cancelled_by_customer (boolean) and retry_payment_id (uuid).
//   6. service_requests.service_option_id (uuid), variant_id (uuid) and
//      quantity (numeric) must exist (added with option_variants and
//      provider_offerings). They record what the customer asked for, e.g.
//      Gas > LPG Cylinder > Total 13kg x 1.
//   7. The request_ratings table (request_id UNIQUE, provider_id, customer_id,
//      rating 1-5, tags text[], comment) must exist. See POST /:id/rating.
//   8. Live tracking: users.last_fix_at (timestamptz), current_speed,
//      current_heading and current_accuracy (double precision) must exist.
//      GET /requests/:id/provider-location selects them.
//
// Request fees:
//   - Prices live in services.request_fee_cents (matched on services.key),
//     read by services/requestFees.js. NULL or 0 = free. The fee is per
//     service TYPE, so choosing an option or variant does not change it.
//   - The pay / status / callback endpoints live in routes/fee.js, mounted
//     below at /requests/fee.
//   - Payments are recorded in request_fee_payments and spent through the
//     claim helpers in services/requestFeePayments.js. There is no
//     service_requests.payment_id column — the link lives the other way,
//     as request_fee_payments.used_request_id pointing at the request it
//     paid for. GET /requests/status/:id looks it up that direction.
//
// Cancelling:
//   - A customer may cancel until the provider taps Arrived. Cancelling while
//     'en_route' keeps the request fee (see KEEP_FEE_ON_LATE_CANCEL below).
//   - The assigned provider is told by socket event + push, and, once they
//     have accepted, by SMS too (see SMS_PROVIDER_ON_CANCEL).
//
// Attachments:
//   - GET /requests/status/:id and GET /requests/active both return
//     `attachment_url` (public URL of the customer's photo/PDF, or null) so
//     the provider app can show it.
// ─────────────────────────────────────────────────────────────────────────────

// Fee endpoints: GET /requests/fee, POST /requests/fee/pay,
// GET /requests/fee/status/:checkoutId, POST /requests/fee/callback
router.use('/fee', require('./fee'));

const ETA = {
  breakdown: 20,
  mechanic: 20,
  fuel: 15,
  tyre: 22,
  tow: 30,
  medical: 12,
  ambulance: 12,
  jumpstart: 20,
  ev: 25,
  traffic: 20,
  security: 15,
  insurance: 30,
};

// A repeat request (same user + same type) inside this window is a double tap.
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

// Statuses a customer may still cancel out of. 'arrived' onward is locked.
const CANCELLABLE_STATUSES = ['pending', 'assigned', 'accepted', 'en_route', 'no_providers'];

// A provider in these states has committed to the job, so on top of the
// socket event + push they also get an SMS (reaches them with the app closed).
const SMS_PROVIDER_ON_CANCEL = ['accepted', 'en_route'];

// Cancelling once the provider is driving to the customer keeps the request
// fee (the provider already spent time and fuel). Set
// KEEP_FEE_ON_LATE_CANCEL=false to give a free retry instead.
const KEEP_FEE_ON_LATE_CANCEL = process.env.KEEP_FEE_ON_LATE_CANCEL !== 'false';
const LATE_CANCEL_STATUSES = ['en_route'];

// Beyond this age a provider's last ping is flagged `stale` in
// GET /requests/:id/provider-location. The position is still returned (so the
// customer's map doesn't go blank in a tunnel); the app greys the marker.
const PROVIDER_LOCATION_STALE_MS = 60 * 1000;

// The customer may see who the provider is only in these statuses.
const PROVIDER_VISIBLE_STATUSES = ['accepted', 'en_route', 'arrived', 'completed'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// When a service has options (Fuel, Gas, Mechanic), a request must say which
// one, otherwise dispatch can't match the right provider. Set
// REQUIRE_SERVICE_OPTION=false to let older app builds, which don't send an
// option yet, keep creating requests while they are phased out.
const REQUIRE_OPTION = process.env.REQUIRE_SERVICE_OPTION !== 'false';

// Sanity ceiling so a typo like 1000000 litres is rejected.
const MAX_QUANTITY = 1000;

// excludeProviderIds arrives as a JSON-encoded string in multipart requests
// and as a real array in JSON requests. Only valid UUIDs survive, because the
// columns it feeds are uuid[] and a bad value would fail the insert.
function parseExcludedIds(raw) {
  try {
    const list = Array.isArray(raw) ? raw : raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return [...new Set(list.map(String).filter((id) => UUID_RE.test(id)))];
  } catch {
    return [];
  }
}

// ── What the customer asked for: option, variant, quantity ──────────────────
//
// Checks the choice against the database and returns either
//   { selection: null }                       service with no options / none sent
//   { selection: { optionId, variantId, quantity, ... } }
//   { status, error }                         to send back as a 400
//
// Everything is validated BEFORE any fee payment is claimed, so a bad choice
// never costs the customer anything.
async function resolveServiceSelection(type, raw) {
  const optionKey = raw.optionKey ? String(raw.optionKey).trim() : '';
  const variantId = raw.variantId ? String(raw.variantId).trim() : '';
  const quantityRaw =
    raw.quantity === undefined || raw.quantity === null || raw.quantity === ''
      ? null
      : Number(raw.quantity);

  const { data: service, error } = await supabase
    .from('services')
    .select(
      `id,
       service_options (
         id, key, label, is_active, unit, quantity_mode, min_qty,
         option_variants ( id, name, is_active )
       )`,
    )
    .eq('key', type)
    .maybeSingle();

  if (error) throw error;

  // Types with no row in `services` (older keys) behave exactly as before.
  if (!service) {
    if (optionKey || variantId) {
      return { status: 400, error: 'That service has no options.' };
    }
    return { selection: null };
  }

  const options = (service.service_options || []).filter((o) => o.is_active);

  if (!optionKey) {
    if (variantId) {
      return { status: 400, error: 'Choose an option before choosing a product.' };
    }
    if (options.length > 0 && REQUIRE_OPTION) {
      return { status: 400, error: 'Please choose what you need.' };
    }
    return { selection: null };
  }

  const option = options.find((o) => o.key === optionKey);
  if (!option) {
    return { status: 400, error: 'That option is not available.' };
  }

  // Variant: required when the option has any, forbidden when it has none.
  const variants = (option.option_variants || []).filter((v) => v.is_active);
  let variant = null;

  if (variants.length > 0) {
    if (!variantId) {
      return { status: 400, error: `Please choose which ${option.label} product you want.` };
    }
    variant = variants.find((v) => v.id === variantId);
    if (!variant) {
      return { status: 400, error: 'That product is no longer available.' };
    }
  } else if (variantId) {
    return { status: 400, error: `${option.label} has no product choices.` };
  }

  // Quantity follows how the option is ordered.
  const mode = option.quantity_mode || 'fixed';
  const minQty = Number(option.min_qty) > 0 ? Number(option.min_qty) : 1;
  let quantity = null;

  if (mode === 'free') {
    if (quantityRaw === null || !Number.isFinite(quantityRaw) || quantityRaw <= 0) {
      return { status: 400, error: `Enter how many ${option.unit || 'units'} you need.` };
    }
    if (quantityRaw < minQty) {
      return { status: 400, error: `The minimum is ${minQty} ${option.unit || 'units'}.` };
    }
    quantity = quantityRaw;
  } else if (mode === 'fixed') {
    // Older app builds send no quantity for fixed items: treat that as one.
    const q = quantityRaw === null ? minQty : quantityRaw;
    if (!Number.isInteger(q) || q < minQty) {
      return { status: 400, error: 'Choose a whole number of items.' };
    }
    quantity = q;
  }

  if (quantity !== null && quantity > MAX_QUANTITY) {
    return { status: 400, error: 'That quantity is too large.' };
  }

  return {
    selection: {
      optionId: option.id,
      optionLabel: option.label,
      variantId: variant ? variant.id : null,
      variantName: variant ? variant.name : null,
      quantity,
      unit: option.unit || null,
    },
  };
}

// "Total 13kg x 1", "Kerosene x 2 litres", "Engine". Used in payloads the
// provider app and the customer's status screen can show as-is.
function orderSummary(row) {
  const item = row?.variant?.name ?? row?.option?.label;
  if (!item) return null;
  if (row.quantity == null) return item;

  const q = Number(row.quantity);
  const unit = row.option?.unit;
  const unitText = unit ? ` ${unit}${q === 1 ? '' : 's'}` : '';
  return `${item} x ${q}${unitText}`;
}

// ── Provider identity (name, phone, photo) for the tracking screen ──────────
const DOCUMENTS_BUCKET = 'provider-documents';
const SIGNED_URL_TTL_SECONDS = 60 * 60;
const PROFILE_PHOTO_DOC_TYPE = {
  individual: 'passport_photo',
  business: 'premises_photos',
};

// Signed URLs are cached so the polled status route returns a stable URL
// string (otherwise Image.network reloads and flickers every poll).
const signedUrlCache = new Map(); // storagePath -> { url, expiresAt }

async function signDocumentUrl(storagePath) {
  if (!storagePath) return null;

  const cached = signedUrlCache.get(storagePath);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    console.error('❌ Document sign error:', error?.message);
    return null;
  }

  signedUrlCache.set(storagePath, {
    url: data.signedUrl,
    expiresAt: Date.now() + (SIGNED_URL_TTL_SECONDS - 600) * 1000,
  });
  return data.signedUrl;
}

// Never throws: a lookup failure must not break the status payload.
async function loadProviderIdentity(providerId) {
  try {
    const [{ data: user }, { data: provider }] = await Promise.all([
      supabase.from('users').select('full_name, phone').eq('id', providerId).maybeSingle(),
      supabase
        .from('providers')
        .select('provider_type, business_name')
        .eq('user_id', providerId)
        .maybeSingle(),
    ]);

    if (!user) return null;

    const isBusiness = provider?.provider_type === 'business';
    const photoDocType = PROFILE_PHOTO_DOC_TYPE[isBusiness ? 'business' : 'individual'];

    const { data: photoDoc, error: photoError } = await supabase
      .from('provider_documents')
      .select('storage_path')
      .eq('provider_id', providerId)
      .eq('document_type', photoDocType)
      .order('uploaded_at', { ascending: isBusiness })
      .limit(1)
      .maybeSingle();

    if (photoError) {
      console.error('❌ Provider photo lookup error:', photoError.message);
    }

    return {
      full_name: (isBusiness && provider?.business_name) || user.full_name || 'Your provider',
      phone: user.phone ?? null,
      avatar_url: await signDocumentUrl(photoDoc?.storage_path),
    };
  } catch (err) {
    console.error('❌ Provider identity error:', err.message);
    return null;
  }
}

// Never throws: a lookup failure must not break the status payload. Looks
// up the fee payment linked to this request, if any — see the SETUP NEEDED
// note above on why this is a reverse lookup rather than a column read.
async function loadPaymentId(requestId) {
  try {
    const { data, error } = await supabase
      .from('request_fee_payments')
      .select('id')
      .eq('used_request_id', requestId)
      .maybeSingle();

    if (error) {
      console.error('❌ Payment lookup error (status):', error.message);
      return null;
    }
    return data?.id ?? null;
  } catch (err) {
    console.error('❌ Payment lookup threw (status):', err.message);
    return null;
  }
}

// ── Attachment upload (held in memory, forwarded to Supabase Storage) ───────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB, matches the Flutter check
});

// Postgres `timestamp` (no tz) comes back without a trailing Z, and
// `new Date()` would read it as server-local time (EAT = UTC+3), skewing
// every staleness check. Treat offset-less strings as UTC.
// Real fix: make users.last_ping_at a `timestamptz`.
function parseAsUtc(raw) {
  if (!raw) return null;
  const hasOffset = /[zZ]|[+-]\d{2}:\d{2}$/.test(raw);
  const iso = hasOffset ? raw : `${raw}Z`;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// Never throws: a failed SMS must not affect the customer's cancel.
async function smsProviderOfCancel(providerId, requestId) {
  try {
    const { data: provider, error } = await supabase
      .from('users')
      .select('phone')
      .eq('id', providerId)
      .maybeSingle();

    if (error || !provider?.phone) {
      console.warn(`⚠️ No phone for provider ${providerId}, cancel SMS skipped`);
      return;
    }

    await sendSMS(
      [provider.phone],
      `Imergency: the customer has cancelled request #${String(requestId).slice(-8)}. ` +
        `No need to continue to the location.`,
    );
  } catch (err) {
    console.error('❌ Provider cancel SMS error:', err.message);
  }
}

// True only when this service type has no request fee. Used to decide
// whether a cancelled request with no reclaimable payment can be retried
// for free. Unknown types or lookup errors count as "not free".
async function isFreeServiceType(type) {
  try {
    return (await getRequestFeeCents(type)) === 0;
  } catch (err) {
    console.error('❌ Fee lookup error (retry check):', err.message);
    return false;
  }
}

// Runs dispatch without leaving an unhandled rejection behind.
function dispatchSafely(requestId, io) {
  Promise.resolve()
    .then(() => assignRequest(requestId, io))
    .catch((err) => console.error(`❌ Dispatch error for request ${requestId}:`, err.message));
}

// Best-effort: a lost photo is far less bad than a lost emergency request.
async function uploadAttachmentIfPresent(file) {
  if (!file) return null;

  try {
    const ext = file.originalname && file.originalname.includes('.')
      ? file.originalname.split('.').pop()
      : 'bin';
    const path = `requests/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('request-attachments')
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });

    if (uploadError) {
      console.error('❌ Attachment upload error:', uploadError.message);
      return null;
    }

    const { data: publicUrlData } = supabase.storage
      .from('request-attachments')
      .getPublicUrl(path);

    return publicUrlData?.publicUrl ?? null;
  } catch (err) {
    console.error('❌ Attachment upload threw:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /requests/create
//
// Order matters:
//   1. validate + resolve user
//   2. validate the option / variant / quantity (before any money moves)
//   3. duplicate check (before any payment is touched)
//   4. verify + claim the fee payment (types that charge a fee)
//   5. upload attachment, insert request
//      - insert fails  -> release the payment so the customer can retry free
//      - insert works  -> link the payment to the request permanently
//   6. SMS + dispatch
//
// Any `providerId` in the body is ignored: dispatch always does the matching.
//
// Body also accepts, for services that have options:
//   optionKey   key of the chosen option (e.g. "lpg_refill")
//   variantId   id of the chosen variant (e.g. Total 13kg)
//   quantity    litres / cylinders; ignored for jobs
// They are stored on the request (service_option_id, variant_id, quantity)
// so dispatch can match only providers who offer exactly that.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/create', upload.single('attachment'), async (req, res) => {
  const { type, userPhone, userName, address, details, latitude, longitude, paymentId } = req.body;

  console.log('📍 RAW BODY:', JSON.stringify(req.body));
  if (req.file) {
    console.log('📎 Attachment received:', {
      name: req.file.originalname,
      size: req.file.size,
      type: req.file.mimetype,
    });
  }

  let claimedPaymentId = null; // set once we hold a payment claim

  try {
    if (!type || !userPhone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const eta = ETA[type] || 20;

    // Providers the customer already cancelled on (retry after cancel).
    const excludeProviderIds = parseExcludedIds(req.body.excludeProviderIds);

    const lat = latitude !== undefined && latitude !== null && latitude !== '' ? Number(latitude) : null;
    const lng = longitude !== undefined && longitude !== null && longitude !== '' ? Number(longitude) : null;
    const hasValidCoords = lat !== null && lng !== null && !Number.isNaN(lat) && !Number.isNaN(lng);

    if (!hasValidCoords && (latitude !== undefined || longitude !== undefined)) {
      console.warn('⚠️  Coords present in body but failed validation:', { latitude, longitude });
    }

    // ── What exactly was asked for (option / variant / quantity) ───────────
    const resolved = await resolveServiceSelection(type, req.body);
    if (resolved.error) {
      return res.status(resolved.status).json({ error: resolved.error });
    }
    const selection = resolved.selection;

    // ── Resolve or create user ─────────────────────────────────────────────
    let userId = null;
    try {
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('phone', userPhone)
        .maybeSingle();

      if (existingUser) {
        userId = existingUser.id;
      } else {
        const { data: newUser, error: userErr } = await supabase
          .from('users')
          .insert({ phone: userPhone, full_name: userName })
          .select('id')
          .single();

        if (userErr) console.error('❌ User insert error:', userErr.message);
        else userId = newUser.id;
      }
    } catch (userLookupErr) {
      console.error('❌ User lookup error:', userLookupErr.message);
    }

    // ── Duplicate guard (runs BEFORE payment is claimed) ───────────────────
    if (userId) {
      try {
        const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
        // Same service AND same item: a customer may legitimately order
        // different things (e.g. LPG then petrol) back to back.
        let dupQuery = supabase
          .from('service_requests')
          .select('id, eta_minutes')
          .eq('user_id', userId)
          .eq('type', type)
          .in('status', ['pending', 'assigned'])
          .gte('created_at', since);
        dupQuery = selection?.optionId
          ? dupQuery.eq('service_option_id', selection.optionId)
          : dupQuery.is('service_option_id', null);
        dupQuery = selection?.variantId
          ? dupQuery.eq('variant_id', selection.variantId)
          : dupQuery.is('variant_id', null);
        const { data: recent } = await dupQuery
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (recent) {
          console.log(`♻️  Duplicate ${type} request from ${userPhone}, returning existing ${recent.id}`);
          return res.json({
            success: true,
            duplicate: true,
            eta: recent.eta_minutes ?? eta,
            requestId: recent.id,
            message: `${type} request already in progress. ETA ${recent.eta_minutes ?? eta} minutes`,
          });
        }
      } catch (dupErr) {
        console.error('⚠️  Duplicate check failed, continuing:', dupErr.message);
      }
    }

    // ── Fee enforcement ────────────────────────────────────────────────────
    // Price comes from services.request_fee_cents. An unknown type throws and
    // lands in the outer catch (500) rather than silently being free.
    const requiredFee = await getRequestFeeCents(type);
    if (requiredFee > 0) {
      if (!paymentId) {
        return res.status(402).json({ error: 'Payment required.' });
      }

      // Atomic: only succeeds for a succeeded, unused payment that belongs
      // to this customer + service and covers the current fee. A payment
      // released by POST /requests/:id/cancel (releasePaymentForRequest)
      // claims here exactly the same way a brand-new one does.
      const claimed = await claimPayment({
        paymentId,
        type,
        userPhone,
        minAmountCents: requiredFee,
      });
      if (!claimed) {
        return res.status(402).json({
          error: 'Payment could not be verified or was already used.',
        });
      }
      claimedPaymentId = paymentId;
    }

    // ── Attachment, then insert ────────────────────────────────────────────
    const attachmentUrl = await uploadAttachmentIfPresent(req.file);

    let savedRequest = null;
    let dbInsertError = null;
    try {
      const { data, error: dbError } = await supabase
        .from('service_requests')
        .insert({
          type,
          details,
          address,
          latitude: lat,
          longitude: lng,
          status: 'pending',
          eta_minutes: eta,
          user_id: userId,
          attachment_url: attachmentUrl,
          // What was asked for. Dispatch matches providers on these.
          service_option_id: selection?.optionId ?? null,
          variant_id: selection?.variantId ?? null,
          quantity: selection?.quantity ?? null,
          // Claim-pool / accept guard.
          excluded_provider_ids: excludeProviderIds,
          // Dispatch reads this as "already tried", so seeding it makes
          // nearest-first matching skip those providers.
          assigned_provider_ids: excludeProviderIds,
        })
        .select()
        .single();

      if (dbError) {
        console.error('❌ DB error:', dbError.message);
        dbInsertError = dbError.message;
      } else {
        savedRequest = data;
        console.log('✅ Request saved:', savedRequest.id);
      }
    } catch (dbErr) {
      console.error('❌ DB connection error:', dbErr.message);
      dbInsertError = dbErr.message;
    }

    if (!savedRequest) {
      // Give the payment back so the customer's retry doesn't need a new charge.
      if (claimedPaymentId) await releasePayment(claimedPaymentId);
      return res.status(500).json({
        error: 'Failed to save request',
        detail: dbInsertError || 'Unknown database error',
      });
    }

    if (claimedPaymentId) {
      await markPaymentUsed(claimedPaymentId, savedRequest.id);
      claimedPaymentId = null; // committed; nothing to release on later errors
    }

    // ── SMS confirmation ───────────────────────────────────────────────────
    try {
      await sendSMS([userPhone], buildConfirmationMessage(type, eta));
    } catch (smsErr) {
      console.error('❌ SMS error:', smsErr.message);
    }

    // ── Dispatch ───────────────────────────────────────────────────────────
    const io = req.app.get('io');
    if (hasValidCoords) {
      console.log(`🚀 Starting dispatch for ${type} request...`);
      dispatchSafely(savedRequest.id, io);
    } else {
      console.warn(`⚠️  No valid coords for request ${savedRequest.id} — skipping dispatch.`);
      io.to('admins').emit('request_created', {
        id: savedRequest.id,
        type,
        timestamp: new Date(),
      });
    }

    console.log(`✅ ${type} request from ${userName} at ${address}`);
    res.json({
      success: true,
      eta,
      requestId: savedRequest.id,
      message: `${type} request confirmed. ETA ${eta} minutes`,
    });
  } catch (err) {
    console.error('Request error:', err.message);
    // An unexpected throw before the request was saved must not eat the payment.
    if (claimedPaymentId) await releasePayment(claimedPaymentId);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /requests/active?providerId=<id>
// Also returns `order_summary` ("Total 13kg x 1") so the provider sees what
// to bring before accepting, and `attachment_url` (customer's photo/PDF).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/active', async (req, res) => {
  const { providerId } = req.query;

  if (!providerId) {
    return res.status(400).json({ error: 'providerId query param is required' });
  }

  try {
    const { data, error } = await supabase
      .from('service_requests')
      .select(`
        id,
        type,
        address,
        latitude,
        longitude,
        details,
        attachment_url,
        eta_minutes,
        status,
        quantity,
        option:service_options ( label, unit ),
        variant:option_variants ( name ),
        customer:user_id ( full_name, phone )
      `)
      .eq('current_provider_id', providerId)
      .eq('status', 'assigned')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('❌ Active request fetch error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch active request', detail: error.message });
    }

    if (!data) return res.json(null);

    const distanceKm = null; // compute from provider location, or store at dispatch time
    res.json({
      id: data.id,
      type: data.type,
      customer: data.customer?.full_name ?? 'Customer',
      distance: distanceKm ? `${distanceKm} km away` : 'Nearby',
      location: data.address,
      latitude: data.latitude,
      longitude: data.longitude,
      details: data.details,
      attachment_url: data.attachment_url ?? null,
      order_summary: orderSummary(data),
      icon: iconForType(data.type),
    });
  } catch (err) {
    console.error('❌ Active request error:', err.message);
    res.status(500).json({ error: 'Failed to fetch active request' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /requests/history/:phone
// ─────────────────────────────────────────────────────────────────────────────
router.get('/history/:phone', async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);

  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  try {
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, phone')
      .eq('phone', phone)
      .maybeSingle();

    if (userError) {
      return res.status(500).json({ error: 'DB error looking up user', detail: userError.message });
    }

    if (!user) {
      return res.json({ success: true, data: [] });
    }

    const { data, error } = await supabase
      .from('service_requests')
      .select('id, type, status, address, eta_minutes, created_at, quantity, option:service_options ( label, unit ), variant:option_variants ( name )')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch history', detail: error.message });
    }

    const items = (data || []).map(({ option, variant, quantity, ...row }) => ({
      ...row,
      order_summary: orderSummary({ option, variant, quantity }),
    }));

    res.json({ success: true, data: items });
  } catch (err) {
    console.error('History error:', err.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /requests/status/:id
// Includes a `provider` object once a provider has accepted (see
// PROVIDER_VISIBLE_STATUSES), otherwise null. Also includes `payment_id` —
// the fee payment this request was created with, if any (see
// loadPaymentId) — which RequestTrackingScreen._retryWithOtherProvider
// carries forward on a post-cancel retry. `order_summary` describes what was
// asked for ("Total 13kg x 1"), when the request had an option.
// `attachment_url` is the customer's photo/PDF (or null); the provider app
// shows it on the active-job screen.
//
// `can_retry` is true only for a customer-cancelled request that can be sent
// out again without paying: either its released fee payment is still unused,
// or the service type is free. It is false after a late (en_route) cancel on
// a paid service, because the fee was kept.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('service_requests')
      .select(`
        id,
        type,
        status,
        address,
        latitude,
        longitude,
        eta_minutes,
        details,
        attachment_url,
        current_provider_id,
        cancelled_by_customer,
        retry_payment_id,
        excluded_provider_ids,
        service_option_id,
        variant_id,
        quantity,
        option:service_options ( key, label, unit ),
        variant:option_variants ( name ),
        customer:user_id ( full_name, phone )
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const provider =
      data.current_provider_id && PROVIDER_VISIBLE_STATUSES.includes(data.status)
        ? await loadProviderIdentity(data.current_provider_id)
        : null;

    let paymentId = await loadPaymentId(data.id);
    let canRetry = false;

    // After a customer cancel the payment is released (used_request_id is
    // cleared), so the reverse lookup above finds nothing. retry_payment_id,
    // saved at cancel time, is how the retry still reaches the paid fee.
    if (data.status === 'cancelled' && data.cancelled_by_customer) {
      if (data.retry_payment_id) {
        const { data: pay } = await supabase
          .from('request_fee_payments')
          .select('used_request_id')
          .eq('id', data.retry_payment_id)
          .maybeSingle();
        canRetry = !!pay && pay.used_request_id == null; // false once reused
        paymentId = data.retry_payment_id;
      } else {
        // No payment to reclaim. A retry is only free when the service
        // type itself is free; otherwise the fee was kept (late cancel) and
        // a new request needs a new payment.
        canRetry = await isFreeServiceType(data.type);
      }
    }

    const { retry_payment_id, option, variant, ...rest } = data;
    res.json({
      ...rest, // includes attachment_url, variant_id, quantity
      // Needed so a "Find another provider" retry can re-send the same
      // option (the backend rejects option-less requests for services that
      // have options).
      option_key: option?.key ?? null,
      order_summary: orderSummary({ option, variant, quantity: data.quantity }),
      provider,
      payment_id: paymentId,
      can_retry: canRetry,
    });
  } catch (err) {
    console.error('Status fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /requests/:id/provider-location
//
// 200 { latitude, longitude, speed, heading, accuracy, providerName,
//       updatedAt, stale, ageSeconds }
// 204 only when there is genuinely nothing to show: no provider assigned yet,
//     or the provider has no coordinates at all.
//
// A ping older than PROVIDER_LOCATION_STALE_MS is NOT hidden any more. The
// last known position is returned with `stale: true`, so a tunnel or dead
// zone mid-trip greys the marker ("Last seen 40 s ago") instead of blanking
// the map. Customer apps that ignore `stale` simply keep showing the last
// position. Location lives on `users` (current_latitude, current_longitude,
// current_speed, current_heading, current_accuracy, last_ping_at).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/provider-location', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: request, error: reqError } = await supabase
      .from('service_requests')
      .select('current_provider_id')
      .eq('id', id)
      .single();

    if (reqError || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (!request.current_provider_id) {
      return res.status(204).send();
    }

    const { data: providerUser, error: userError } = await supabase
      .from('users')
      .select(
        'full_name, current_latitude, current_longitude, current_speed, current_heading, current_accuracy, last_ping_at',
      )
      .eq('id', request.current_provider_id)
      .maybeSingle();

    if (userError) {
      console.error('❌ Provider location fetch error:', userError.message);
      return res.status(500).json({ error: 'Failed to fetch provider location' });
    }

    if (!providerUser || providerUser.current_latitude == null || providerUser.current_longitude == null) {
      return res.status(204).send();
    }

    const lastPingMs = parseAsUtc(providerUser.last_ping_at);
    const ageMs = lastPingMs == null ? null : Date.now() - lastPingMs;
    const isStale = ageMs == null || ageMs > PROVIDER_LOCATION_STALE_MS;

    if (isStale) {
      console.warn(
        `⚠️ Provider ${request.current_provider_id} location is stale (returned flagged)`,
        { last_ping_at: providerUser.last_ping_at, parsedMs: lastPingMs, nowMs: Date.now() },
      );
    }

    res.json({
      latitude: providerUser.current_latitude,
      longitude: providerUser.current_longitude,
      speed: providerUser.current_speed ?? null,
      heading: providerUser.current_heading ?? null,
      accuracy: providerUser.current_accuracy ?? null,
      providerName: providerUser.full_name ?? null,
      updatedAt: providerUser.last_ping_at ?? null,
      stale: isStale,
      ageSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
    });
  } catch (err) {
    console.error('❌ Provider location error:', err.message);
    res.status(500).json({ error: 'Failed to fetch provider location' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /requests/accept
// ─────────────────────────────────────────────────────────────────────────────
router.post('/accept', async (req, res) => {
  const { requestId, providerId } = req.body;

  try {
    const io = req.app.get('io');
    const result = await acceptRequest(requestId, providerId, io);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true, message: 'Job accepted!' });
  } catch (err) {
    console.error('Accept error:', err.message);
    res.status(500).json({ error: 'Failed to accept request' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /requests/decline
// Only the provider the request is currently assigned to may decline it.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/decline', async (req, res) => {
  const { requestId, providerId } = req.body;

  if (!requestId || !providerId) {
    return res.status(400).json({ error: 'requestId and providerId are required' });
  }

  try {
    const { data: request, error: reqError } = await supabase
      .from('service_requests')
      .select('id, status, current_provider_id')
      .eq('id', requestId)
      .single();

    if (reqError || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.current_provider_id !== providerId || request.status !== 'assigned') {
      return res.status(403).json({ error: 'This request is not currently assigned to you' });
    }

    console.log(`❌ Provider ${providerId} declined request ${requestId} — reassigning...`);

    const io = req.app.get('io');
    dispatchSafely(requestId, io);

    res.json({ success: true, message: 'Request reassigned' });
  } catch (err) {
    console.error('Decline error:', err.message);
    res.status(500).json({ error: 'Failed to decline request' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /requests/:id/start   (accepted -> en_route)
// Once this lands the customer can still cancel until the provider taps
// Arrived; the cancel route then notifies the provider (socket, push, SMS)
// and keeps the request fee. CAS-guarded so a racing cancel can't leave the
// request inconsistent.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/start', async (req, res) => {
  const { id } = req.params;
  const { providerId } = req.body;

  if (!providerId) {
    return res.status(400).json({ error: 'providerId is required' });
  }

  try {
    const { data: request, error: reqError } = await supabase
      .from('service_requests')
      .select('id, status, current_provider_id, user_id')
      .eq('id', id)
      .single();

    if (reqError || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.current_provider_id !== providerId) {
      return res.status(403).json({ error: 'This request is not assigned to you' });
    }

    if (request.status !== 'accepted') {
      return res.status(400).json({ error: `Cannot start journey — request is ${request.status}` });
    }

    const { data: updated, error: updateError } = await supabase
      .from('service_requests')
      .update({ status: 'en_route' })
      .eq('id', id)
      .eq('status', 'accepted') // CAS guard
      .select('id, user_id')
      .maybeSingle();

    if (updateError) {
      console.error('❌ Start journey error:', updateError.message);
      return res.status(500).json({ error: 'Failed to start journey' });
    }

    if (!updated) {
      return res.status(409).json({ error: 'Request changed — please refresh and try again' });
    }

    console.log(`🚗 Provider ${providerId} started journey for request ${id}`);

    const io = req.app.get('io');
    if (updated.user_id) {
      io.to(updated.user_id).emit('provider_en_route', { requestId: id });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Start journey error:', err.message);
    res.status(500).json({ error: 'Failed to start journey' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /requests/:id/arrived   (en_route -> arrived)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/arrived', async (req, res) => {
  const { id } = req.params;
  const { providerId } = req.body;

  if (!providerId) {
    return res.status(400).json({ error: 'providerId is required' });
  }

  try {
    const { data: request, error: reqError } = await supabase
      .from('service_requests')
      .select('id, status, current_provider_id')
      .eq('id', id)
      .single();

    if (reqError || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.current_provider_id !== providerId) {
      return res.status(403).json({ error: 'This request is not assigned to you' });
    }

    if (request.status !== 'en_route') {
      return res.status(400).json({ error: `Cannot mark arrived — request is ${request.status}` });
    }

    const { data: updated, error: updateError } = await supabase
      .from('service_requests')
      .update({ status: 'arrived' })
      .eq('id', id)
      .eq('status', 'en_route') // CAS guard
      .select('id, user_id')
      .maybeSingle();

    if (updateError) {
      console.error('❌ Arrived error:', updateError.message);
      return res.status(500).json({ error: 'Failed to mark arrived' });
    }

    if (!updated) {
      return res.status(409).json({ error: 'Request changed — please refresh and try again' });
    }

    console.log(`📍 Provider ${providerId} arrived for request ${id}`);

    const io = req.app.get('io');
    if (updated.user_id) {
      io.to(updated.user_id).emit('provider_arrived', { requestId: id });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Arrived error:', err.message);
    res.status(500).json({ error: 'Failed to mark arrived' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /requests/:id/cancel   (customer)
// Authorized by phone number. CAS-guarded on the status we just read, so a
// racing accept / reassignment / completion can't be clobbered.
//
// Allowed until the provider taps Arrived (see CANCELLABLE_STATUSES).
//
// Fee handling:
//   - Early cancel (pending / assigned / accepted / no_providers): releases
//     whatever fee payment this request was using (releasePaymentForRequest),
//     so a customer who cancels and retries
//     (RequestTrackingScreen._retryWithOtherProvider) is not charged again.
//   - Late cancel (en_route): the fee is kept when KEEP_FEE_ON_LATE_CANCEL is
//     on (the default). The payment stays linked to the cancelled request,
//     no retry payment is saved, and GET /status reports can_retry=false for
//     paid services.
//
// Provider notification: socket event + push for any assigned provider, plus
// an SMS once they have accepted (SMS_PROVIDER_ON_CANCEL).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/cancel', async (req, res) => {
  const { id } = req.params;
  const { userPhone } = req.body;

  if (!userPhone) {
    return res.status(400).json({ error: 'userPhone is required' });
  }

  try {
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('phone', userPhone)
      .maybeSingle();

    if (userError) {
      console.error('❌ Cancel user lookup error:', userError.message);
      return res.status(500).json({ error: 'Failed to cancel request' });
    }

    if (!user) {
      return res.status(404).json({ error: 'No account found for this phone number' });
    }

    const { data: request, error: reqError } = await supabase
      .from('service_requests')
      .select('id, status, user_id, current_provider_id, excluded_provider_ids')
      .eq('id', id)
      .single();

    if (reqError || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.user_id !== user.id) {
      return res.status(403).json({ error: 'This request does not belong to you' });
    }

    if (!CANCELLABLE_STATUSES.includes(request.status)) {
      if (request.status === 'arrived') {
        return res.status(400).json({
          error: 'Your provider has already arrived, so this request can no longer be cancelled.',
        });
      }
      return res.status(400).json({ error: `Request is already ${request.status}` });
    }

    // A late cancel keeps the fee: nothing is saved for a retry, and the
    // payment is not released below.
    const keepFee = KEEP_FEE_ON_LATE_CANCEL && LATE_CANCEL_STATUSES.includes(request.status);

    // Read the payment link BEFORE it is released, and remember who the
    // customer is cancelling on so a retry (even after the app is closed)
    // skips them.
    const payIdForRetry = keepFee ? null : await loadPaymentId(id);
    const excludedNow = [
      ...new Set([
        ...(request.excluded_provider_ids || []).map(String),
        ...(request.current_provider_id ? [String(request.current_provider_id)] : []),
      ]),
    ];

    const { data: updated, error: updateError } = await supabase
      .from('service_requests')
      .update({
        status: 'cancelled',
        cancelled_by_customer: true,
        retry_payment_id: payIdForRetry,
        excluded_provider_ids: excludedNow,
      })
      .eq('id', id)
      .eq('status', request.status) // CAS guard
      .select('id, current_provider_id, status')
      .maybeSingle();

    if (updateError) {
      console.error('❌ Cancel update error:', updateError.message);
      return res.status(500).json({ error: 'Failed to cancel request' });
    }

    if (!updated) {
      return res.status(409).json({ error: 'Request changed — please refresh and try again' });
    }

    console.log(`🚫 Request ${id} cancelled by customer ${userPhone} (was ${request.status})`);

    // Give back whatever fee payment this request was using, unless this is
    // a late cancel that keeps the fee. Only reached once the CAS update
    // above has actually confirmed the request moved to 'cancelled' — see
    // releasePaymentForRequest's doc comment on why that ordering matters.
    // Awaited (not fire-and-forget) so the retry button that appears
    // immediately after this response always has a reusable payment waiting,
    // rather than racing it.
    if (keepFee) {
      console.log(`💰 Request ${id}: late cancel (${request.status}), fee kept`);
    } else {
      await releasePaymentForRequest(id);
    }

    const io = req.app.get('io');
    if (updated.current_provider_id) {
      io.to(`provider_${updated.current_provider_id}`).emit('job_cancelled', {
        requestId: id,
        reason: 'Customer cancelled the request',
      });
      sendJobCancelledPush(updated.current_provider_id, id); // fire-and-forget

      // Provider already accepted / driving: also reach them by SMS, which
      // works with the app closed. Fire-and-forget; never blocks the response.
      if (SMS_PROVIDER_ON_CANCEL.includes(request.status)) {
        smsProviderOfCancel(updated.current_provider_id, id);
      }
    }

    res.json({ success: true, message: 'Request cancelled', feeKept: keepFee });
  } catch (err) {
    console.error('Cancel error:', err.message);
    res.status(500).json({ error: 'Failed to cancel request' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /requests/:id/complete   (provider)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/complete', async (req, res) => {
  const { id } = req.params;
  const { providerId } = req.body;

  if (!providerId) {
    return res.status(400).json({ error: 'providerId is required' });
  }

  try {
    const { data: request, error: reqError } = await supabase
      .from('service_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (reqError || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.current_provider_id !== providerId) {
      return res.status(403).json({ error: 'This request is not assigned to you' });
    }

    if (request.status === 'completed') {
      return res.status(400).json({ error: 'Request is already completed' });
    }

    const { error: updateError } = await supabase
      .from('service_requests')
      .update({ status: 'completed' })
      .eq('id', id);

    if (updateError) {
      console.error('Complete request error:', updateError.message);
      return res.status(500).json({ error: 'Failed to complete job', detail: updateError.message });
    }

    const io = req.app.get('io');
    if (request.user_id) {
      io.to(request.user_id).emit('job_completed', { requestId: id });
    }

    console.log(`✅ Request ${id} marked completed by provider ${providerId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Complete error:', err.message);
    res.status(500).json({ error: 'Failed to complete job' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Ratings
// ─────────────────────────────────────────────────────────────────────────────

// Must match _positiveTags / _neutralTags / _negativeTags in
// rate_provider_screen.dart.
const ALLOWED_RATING_TAGS = new Set([
  'On time', 'Professional', 'Friendly', 'Fast work', 'Fair price', 'Clean work',
  'Late', 'Unprofessional', 'Slow', 'Overpriced', 'Poor quality', 'Hard to reach',
]);
const MAX_RATING_COMMENT = 300; // matches the TextField maxLength

// ─────────────────────────────────────────────────────────────────────────────
// POST /requests/:id/rating   (customer)
// Body: { providerId, rating (1-5), tags: [..], comment, userPhone? }
//
// 201 on success, 409 if the job was already rated (the app treats 409 as
// success). The request must be 'completed' and providerId must be the
// provider who did the job. If userPhone is sent it must belong to the
// customer who made the request. Pass userPhone from the app, or put real
// auth in front of this route, since otherwise anyone with a request id could
// rate it.
//
// providers.rating is recalculated by the trigger on request_ratings
// (trg_refresh_provider_rating).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/rating', async (req, res) => {
  const { id } = req.params;
  const { providerId, userPhone } = req.body;
  const rating = Number(req.body.rating);

  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid request id' });
  }
  if (!providerId || !UUID_RE.test(String(providerId))) {
    return res.status(400).json({ error: 'providerId is required' });
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'rating must be a whole number from 1 to 5' });
  }

  const tags = Array.isArray(req.body.tags)
    ? [...new Set(req.body.tags.map(String).filter((t) => ALLOWED_RATING_TAGS.has(t)))]
    : [];
  const comment = `${req.body.comment ?? ''}`.trim().slice(0, MAX_RATING_COMMENT) || null;

  try {
    const { data: request, error: reqError } = await supabase
      .from('service_requests')
      .select('id, status, user_id, current_provider_id')
      .eq('id', id)
      .maybeSingle();

    if (reqError) {
      console.error('❌ Rating request lookup error:', reqError.message);
      return res.status(500).json({ error: 'Failed to submit rating' });
    }
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (request.status !== 'completed') {
      return res.status(400).json({ error: 'Only completed jobs can be rated' });
    }
    if (request.current_provider_id !== providerId) {
      return res.status(403).json({ error: 'That provider did not do this job' });
    }

    if (userPhone) {
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('id')
        .eq('phone', userPhone)
        .maybeSingle();
      if (userError) {
        console.error('❌ Rating user lookup error:', userError.message);
        return res.status(500).json({ error: 'Failed to submit rating' });
      }
      if (!user || user.id !== request.user_id) {
        return res.status(403).json({ error: 'This request does not belong to you' });
      }
    }

    const { data: saved, error: insertError } = await supabase
      .from('request_ratings')
      .insert({
        request_id: id,
        provider_id: providerId,
        customer_id: request.user_id ?? null,
        rating,
        tags,
        comment,
      })
      .select('id')
      .single();

    if (insertError) {
      // 23505 = unique_violation on request_id -> already rated.
      if (insertError.code === '23505') {
        return res.status(409).json({ error: 'This job has already been rated' });
      }
      console.error('❌ Rating insert error:', insertError.message);
      return res.status(500).json({ error: 'Failed to submit rating' });
    }

    console.log(`⭐ Request ${id} rated ${rating}/5 for provider ${providerId}`);
    res.status(201).json({ success: true, ratingId: saved.id });
  } catch (err) {
    console.error('❌ Rating route error:', err.message);
    res.status(500).json({ error: 'Failed to submit rating' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function iconForType(type) {
  const map = {
    breakdown: 'car',
    mechanic: 'construct',
    fuel: 'flame',
    gas: 'flame',
    tyre: 'radio-button-on',
    tow: 'car-sport',
    medical: 'medkit',
    ambulance: 'medkit',
    jumpstart: 'battery-charging',
    ev: 'flash',
    traffic: 'shield',
    security: 'shield-checkmark',
    insurance: 'document-text',
  };
  return map[type] ?? 'car';
}

module.exports = router;