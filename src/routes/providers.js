const express = require('express');
const router = express.Router();
const multer = require('multer');
const { supabase } = require('../services/supabase');
const { updateProviderLocation } = require('../services/dispatch');

const upload = multer({
  storage: multer.memoryStorage(),
  // A business registration needs 3 named slots plus however many premises
  // photos they add, and an individual registration needs 5-6 named slots.
  limits: { fileSize: 10 * 1024 * 1024, files: 15 }, // 10MB per file, 15 files max
  fileFilter: (req, file, cb) => {
    const allowed = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf';
    cb(allowed ? null : new Error('Only images and PDFs are allowed'), allowed);
  },
});

// Private Supabase Storage bucket — create this once in the dashboard
// (Storage → New bucket → name "provider-documents", Public OFF) and run
// the provider_documents table SQL before this route will work.
const DOCUMENTS_BUCKET = 'provider-documents';

// How long a signed URL for a private document stays valid.
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

const ICONS = {
  breakdown: 'car',
  fuel: 'flame',
  tyre: 'radio-button-on',
  medical: 'medkit',
  jumpstart: 'battery-charging',
  ambulance: 'medkit',
  ev: 'flash',
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── /providers/nearby tuning ─────────────────────────────────────────────
const DEFAULT_RADIUS_KM = 15;
const MAX_RESULTS = 20;
const AVG_SPEED_KMH = 28; // rough urban average, for a *display-only* ETA estimate

// Providers whose last ping is older than this are not shown on the
// customer's map (they can't respond). 0 disables the check.
// Passed to the find_nearby_providers() SQL function.
const NEARBY_MAX_PING_AGE_SECONDS = Number(process.env.NEARBY_MAX_PING_AGE_SECONDS || 120);

// How far back an unclaimed request (status 'no_providers' — see the
// dashboard route's "nearby open requests" section below) stays visible in
// a provider's claim pool before it's considered too stale to bother
// surfacing. The customer has very likely cancelled or given up by then;
// this just keeps the pool from accumulating ancient dead rows forever.
const BROADCAST_POOL_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// A second panic press inside this window returns the existing alert instead
// of creating a duplicate (stray double-taps, retries on a flaky connection).
const PANIC_DEDUPE_WINDOW_MS = 60 * 1000; // 60 seconds

// Great-circle distance in km. Used by the dashboard route below to rank
// "nearby open requests" by distance FROM a provider — the opposite
// direction from find_nearest_provider() (which ranks providers near a
// single request, and is what dispatch.js uses). No DB-side RPC exists for
// this direction, and the candidate set here is always small (one
// provider's approved service types, one time window), so plain JS is fine
// rather than adding a second Postgres function.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Individual vs Business registration requirements ────────────────────
//
// Document field names below are a contract with the client — they're the
// multipart field name each file is sent under (register_screen.dart's
// DocumentRequirement.key), and become the `document_type` recorded
// against each row in provider_documents. Keep both sides in sync.
const PROVIDER_TYPES = ['individual', 'business'];

const INDIVIDUAL_REQUIRED_DOCS = [
  'passport_photo',
  'national_id_front',
  'national_id_back',
  'licence', // Driver's / Business / Professional Licence or Permit, as applicable
  'good_conduct', // Certificate of Good Conduct, or a digital taxi/cab profile screenshot
];
const BUSINESS_REQUIRED_DOCS = [
  'premises_photos',
  'business_licence',
  'business_registration_certificate',
];

// Which document doubles as the provider's profile image.
// Individuals: passport photo. Businesses: a premises photo.
const PROFILE_PHOTO_DOC_TYPE = {
  individual: 'passport_photo',
  business: 'premises_photos',
};

// Individual providers offering any of these services must additionally
// submit insurance_certificate (Motor Vehicle Insurance — cargo only).
// Keep in sync with register_screen.dart's `_cargoServiceKeys`.
// Matched against BOTH top-level service keys and selected sub-service
// keys, same as the client.
const CARGO_SERVICE_KEYS = new Set(['cargo']);

function requiredDocumentTypes(providerType, serviceKeys) {
  if (providerType === 'business') return [...BUSINESS_REQUIRED_DOCS];
  const docs = [...INDIVIDUAL_REQUIRED_DOCS];
  if (serviceKeys.some((key) => CARGO_SERVICE_KEYS.has(key))) {
    docs.push('insurance_certificate');
  }
  return docs;
}

// Some multipart clients (dio included, depending on ListFormat) send
// list-valued fields as `name[]` or `name[0]`. Normalise so the document
// type is always the plain key the server expects.
function documentTypeOf(file) {
  return `${file.fieldname}`.replace(/\[\d*\]$/, '');
}

// Multipart fields arrive as strings; the client JSON-encodes structured
// values. Returns { ok, value } so callers can 400 on malformed input.
function parseJsonField(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: fallback };
  if (typeof raw !== 'string') return { ok: true, value: raw };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, value: fallback };
  }
}

// serviceOptions shape: { "<serviceKey>": ["<subServiceKey>", ...] }.
// Drops anything that isn't a string-array entry and any parent key the
// provider didn't actually select, so stored data can't drift from
// `services`.
function sanitizeServiceOptions(raw, selectedServiceKeys) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const allowedParents = new Set(selectedServiceKeys);
  for (const [parentKey, subKeys] of Object.entries(raw)) {
    if (!allowedParents.has(parentKey) || !Array.isArray(subKeys)) continue;
    const cleaned = [...new Set(subKeys.filter((k) => typeof k === 'string' && k.trim()))];
    if (cleaned.length) out[parentKey] = cleaned;
  }
  return out;
}

// ── Option / variant offerings ───────────────────────────────────────────
//
// Besides the coarse `provider_services` link, a provider records exactly
// which options (Petrol, Engine, LPG Cylinder…) and variants (Total 13kg…)
// they offer in `provider_offerings`. That's what lets a rider asking for
// "Total 13kg gas" be matched only with providers who stock it.
//
// Requires the option_variants and provider_offerings tables
// (provider_offerings.provider_id references providers(user_id)).

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// serviceVariants shape: { "<serviceKey>": { "<optionKey>": ["<variantId>", ...] } }
// Keeps only entries for services and options the provider actually selected,
// and only well-formed UUID strings, so a malformed body can't reach the DB.
function sanitizeServiceVariants(raw, serviceOptions) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  for (const [serviceKey, byOption] of Object.entries(raw)) {
    const selectedOptions = serviceOptions[serviceKey];
    if (!selectedOptions || !byOption || typeof byOption !== 'object' || Array.isArray(byOption)) {
      continue;
    }
    const allowed = new Set(selectedOptions);

    for (const [optionKey, ids] of Object.entries(byOption)) {
      if (!allowed.has(optionKey) || !Array.isArray(ids)) continue;
      const cleaned = [
        ...new Set(ids.filter((id) => typeof id === 'string' && UUID_PATTERN.test(id))),
      ];
      if (cleaned.length) (out[serviceKey] ||= {})[optionKey] = cleaned;
    }
  }
  return out;
}

// Validates the provider's selections against the DB and returns the
// provider_offerings rows to insert, WITHOUT writing anything. Run it before
// the provider row is created so a bad selection never leaves a half-made
// registration behind.
//
// One row per chosen variant, or a single row with variant_id = null for an
// option that has no variants. Options that don't exist in service_options
// (e.g. legacy entries from the old services.options JSON) are skipped; they
// stay recorded in providers.service_options as before.
async function buildOfferingRows(userId, matchedServices, serviceOptions, serviceVariants) {
  const serviceIdByKey = new Map(matchedServices.map((s) => [s.key, s.id]));
  const serviceIds = [...serviceIdByKey.values()];

  const { data: optionRows, error: optionError } = await supabase
    .from('service_options')
    .select('id, key, label, service_id, option_variants ( id, is_active )')
    .in('service_id', serviceIds)
    .eq('is_active', true);

  if (optionError) {
    console.error('❌ Option lookup error:', optionError.message);
    return { status: 500, error: 'Failed to validate selected options' };
  }

  const optionByCompositeKey = new Map();
  for (const o of optionRows || []) {
    optionByCompositeKey.set(`${o.service_id}:${o.key}`, o);
  }

  const rows = [];

  for (const [serviceKey, optionKeys] of Object.entries(serviceOptions)) {
    const serviceId = serviceIdByKey.get(serviceKey);

    for (const optionKey of optionKeys) {
      const option = optionByCompositeKey.get(`${serviceId}:${optionKey}`);
      if (!option) {
        console.warn(
          `⚠️ Option "${serviceKey}/${optionKey}" not found in service_options; skipping offering row`
        );
        continue;
      }

      const activeVariantIds = new Set(
        (option.option_variants || []).filter((v) => v.is_active).map((v) => v.id)
      );
      const chosen = serviceVariants[serviceKey]?.[optionKey] ?? [];

      if (chosen.some((id) => !activeVariantIds.has(id))) {
        return {
          status: 400,
          error: `One or more selected "${option.label}" products are no longer available`,
        };
      }
      if (activeVariantIds.size > 0 && chosen.length === 0) {
        return {
          status: 400,
          error: `Please choose which "${option.label}" products you stock`,
        };
      }

      if (chosen.length > 0) {
        for (const variantId of chosen) {
          rows.push({ provider_id: userId, service_option_id: option.id, variant_id: variantId });
        }
      } else {
        rows.push({ provider_id: userId, service_option_id: option.id, variant_id: null });
      }
    }
  }

  return { rows };
}

// Removes everything created for a registration that failed part-way.
// Best effort: each step logs its own failure and the next still runs.
async function rollbackRegistration(userId) {
  for (const table of ['provider_offerings', 'provider_services']) {
    const { error } = await supabase.from(table).delete().eq('provider_id', userId);
    if (error) console.error(`❌ Rollback ${table} error:`, error.message);
  }
  const { error } = await supabase.from('providers').delete().eq('user_id', userId);
  if (error) console.error('❌ Rollback providers error:', error.message);
}

// Creates a short-lived signed URL for a file in the private documents
// bucket. Returns null (and logs) on failure rather than throwing, so a
// storage hiccup never breaks the route that asked for it.
async function signDocumentUrl(storagePath) {
  if (!storagePath) return null;
  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error) {
    console.error('❌ Document sign error:', error.message);
    return null;
  }
  return data?.signedUrl ?? null;
}

// ── Referral attribution ─────────────────────────────────────────────────
//
// A provider can optionally enter a staff member's referral code during
// registration (register_screen.dart's referralCode field). Resolving that
// code to a staff user is looked up against staff_roles.code.
//
// ASSUMPTION: staff_roles has a `code` column holding each staff member's
// referral/staff code, stored UPPERCASE. If that column is named something
// else, change the `.eq('code', ...)` call below to match.
async function resolveReferringStaffId(referralCode) {
  const trimmed = `${referralCode ?? ''}`.trim();
  if (!trimmed) return null;

  const { data: referringStaff, error: referralLookupError } = await supabase
    .from('staff_roles')
    .select('user_id')
    .eq('code', trimmed.toUpperCase())
    .maybeSingle();

  if (referralLookupError) {
    // Don't fail registration over a lookup hiccup — log and proceed
    // without attribution.
    console.error('❌ Referral code lookup error:', referralLookupError.message);
    return null;
  }
  if (!referringStaff) {
    console.warn(`⚠️ Referral code "${trimmed}" did not match any staff member`);
    return null;
  }
  return referringStaff.user_id;
}

// POST /providers/register
// upload.any() rather than upload.array('documents') — the set of expected
// field names depends on providerType (individual vs business have
// different document checklists), so files are grouped by whatever
// fieldname they arrive under and that fieldname is the document type.
//
// Requires these columns on `providers` (all nullable):
//   area_of_operation text, latitude double precision,
//   longitude double precision, free_trial_months int, service_options jsonb
//
// Also writes provider_offerings (one row per chosen option or variant) from
// the `serviceOptions` and `serviceVariants` fields.
router.post('/register', upload.any(), async (req, res) => {
  const {
    userId,
    email,
    providerType,
    businessName,
    vehicleInfo,
    location,
    referralCode,
    areaOfOperation,
    latitude,
    longitude,
    freeTrialMonths,
  } = req.body;

  // Multipart bodies arrive as strings, so the client JSON-encodes the
  // services / serviceOptions / serviceVariants before appending them to
  // FormData — undo that here.
  const servicesParsed = parseJsonField(req.body.services, undefined);
  if (!servicesParsed.ok) {
    return res.status(400).json({ error: 'Invalid services format' });
  }
  let services = servicesParsed.value;

  const serviceOptionsParsed = parseJsonField(req.body.serviceOptions, {});
  if (!serviceOptionsParsed.ok) {
    return res.status(400).json({ error: 'Invalid serviceOptions format' });
  }

  const serviceVariantsParsed = parseJsonField(req.body.serviceVariants, {});
  if (!serviceVariantsParsed.ok) {
    return res.status(400).json({ error: 'Invalid serviceVariants format' });
  }

  if (Array.isArray(services)) {
    // De-dupe so ['tow', 'tow'] isn't rejected as "invalid" below.
    services = [...new Set(services)];
  }

  if (!userId || !email || !services?.length || !location) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!PROVIDER_TYPES.includes(providerType)) {
    return res.status(400).json({ error: "providerType must be 'individual' or 'business'" });
  }
  if (providerType === 'individual' && !vehicleInfo) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (providerType === 'business' && !businessName?.trim()) {
    return res.status(400).json({ error: 'businessName is required for business providers' });
  }

  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address' });
  }

  // Map pin. Required by the app, but kept optional server-side so older
  // app builds that don't send it can still register. If present, it must
  // be a valid coordinate.
  let pinLatitude = null;
  let pinLongitude = null;
  if (latitude != null && latitude !== '' && longitude != null && longitude !== '') {
    pinLatitude = Number(latitude);
    pinLongitude = Number(longitude);
    if (
      !Number.isFinite(pinLatitude) ||
      !Number.isFinite(pinLongitude) ||
      pinLatitude < -90 ||
      pinLatitude > 90 ||
      pinLongitude < -180 ||
      pinLongitude > 180
    ) {
      return res.status(400).json({ error: 'Invalid latitude/longitude' });
    }
  }

  const trialMonths = Number.parseInt(freeTrialMonths, 10);
  const freeTrialMonthsValue = Number.isFinite(trialMonths) && trialMonths >= 0 ? trialMonths : null;

  const serviceOptions = sanitizeServiceOptions(serviceOptionsParsed.value, services);
  const serviceVariants = sanitizeServiceVariants(serviceVariantsParsed.value, serviceOptions);

  try {
    const { data: matchedServices, error: serviceError } = await supabase
      .from('services')
      .select('id, key')
      .in('key', services);

    if (serviceError) {
      console.error('Service lookup error:', serviceError);
      return res.status(500).json({ error: 'Failed to validate services' });
    }

    if (!matchedServices || matchedServices.length !== services.length) {
      return res.status(400).json({ error: 'One or more selected services are invalid' });
    }

    // Group uploaded files by document type (normalised field name).
    const filesByType = {};
    for (const file of req.files || []) {
      (filesByType[documentTypeOf(file)] ||= []).push(file);
    }

    // Cargo can be selected as a top-level service OR as a sub-service
    // under another service, so check both (mirrors the client).
    const allSelectedKeys = [...services, ...Object.values(serviceOptions).flat()];

    const missingDocuments = requiredDocumentTypes(providerType, allSelectedKeys).filter(
      (docType) => !filesByType[docType]?.length
    );
    if (missingDocuments.length > 0) {
      return res.status(400).json({ error: 'Missing required documents', missingDocuments });
    }

    // Validate the option / variant selections and prepare the
    // provider_offerings rows now, before anything is written, so a bad
    // selection can't leave a half-made registration behind.
    const offerings = await buildOfferingRows(userId, matchedServices, serviceOptions, serviceVariants);
    if (offerings.error) {
      return res.status(offerings.status).json({ error: offerings.error });
    }

    // Referral attribution: a code that doesn't match anyone is treated as
    // "no referrer" rather than a registration-blocking error.
    const referredByStaffId = await resolveReferringStaffId(referralCode);

    const { data: provider, error: providerError } = await supabase
      .from('providers')
      .insert({
        user_id: userId,
        provider_type: providerType,
        business_name: providerType === 'business' ? businessName.trim() : null,
        email,
        vehicle_info: providerType === 'individual' ? vehicleInfo : null,
        location,
        area_of_operation: areaOfOperation?.trim() || null,
        latitude: pinLatitude,
        longitude: pinLongitude,
        free_trial_months: freeTrialMonthsValue,
        service_options: serviceOptions,
        status: 'pending',
        service_type: services[0],
        referred_by_staff_id: referredByStaffId, // null if no code / no match
      })
      .select('*')
      .single();

    if (providerError) {
      console.error('Provider insert error:', providerError);
      return res.status(500).json({ error: 'Failed to register provider' });
    }

    const providerServiceRows = matchedServices.map((s) => ({
      provider_id: userId,
      service_id: s.id,
      status: 'pending',
    }));

    const { error: linkError } = await supabase
      .from('provider_services')
      .insert(providerServiceRows);

    if (linkError) {
      console.error('Provider services insert error:', linkError);
      // Roll back the provider row so a retry doesn't collide with an
      // orphaned registration.
      const { error: rollbackError } = await supabase
        .from('providers')
        .delete()
        .eq('user_id', userId);
      if (rollbackError) {
        console.error('❌ Provider rollback error:', rollbackError.message);
      }
      return res.status(500).json({ error: 'Failed to attach services to provider' });
    }

    // The exact options / variants this provider offers (see the
    // "Option / variant offerings" section above). If this fails, undo the
    // whole registration so the provider can simply try again.
    if (offerings.rows.length > 0) {
      const { error: offeringsError } = await supabase
        .from('provider_offerings')
        .insert(offerings.rows);

      if (offeringsError) {
        console.error('Provider offerings insert error:', offeringsError);
        await rollbackRegistration(userId);
        return res.status(500).json({ error: 'Failed to save the products you offer' });
      }
    }

    // Upload failures are non-fatal — a partial storage failure shouldn't
    // undo a registration that otherwise succeeded. Each file is uploaded
    // to Storage, then recorded as its own row (tagged with document_type)
    // in provider_documents so reviewers can approve them individually.
    let documentsUploaded = 0;
    const failedDocumentTypes = [];

    if (req.files?.length) {
      const results = await Promise.all(
        req.files.map(async (file) => {
          const documentType = documentTypeOf(file);
          try {
            const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
            const storagePath = `${userId}/${documentType}/${Date.now()}-${safeName}`;

            const { error: uploadError } = await supabase.storage
              .from(DOCUMENTS_BUCKET)
              .upload(storagePath, file.buffer, {
                contentType: file.mimetype,
                upsert: false,
              });

            if (uploadError) {
              console.error('❌ Document upload error:', uploadError.message);
              return { ok: false, documentType };
            }

            const { error: insertError } = await supabase
              .from('provider_documents')
              .insert({
                provider_id: userId,
                document_type: documentType,
                file_name: file.originalname,
                storage_path: storagePath,
                mime_type: file.mimetype,
                size_bytes: file.size,
                status: 'pending',
              });

            if (insertError) {
              console.error('❌ Document record insert error:', insertError.message);
              return { ok: false, documentType };
            }

            return { ok: true, documentType };
          } catch (err) {
            console.error('❌ Document handling error:', err.message);
            return { ok: false, documentType };
          }
        })
      );

      documentsUploaded = results.filter((r) => r.ok).length;
      results.filter((r) => !r.ok).forEach((r) => failedDocumentTypes.push(r.documentType));
    }

    res.json({
      success: true,
      provider,
      services: matchedServices.map((s) => s.key),
      serviceOptions,
      serviceVariants,
      offerings: offerings.rows.length,
      documents: {
        uploaded: documentsUploaded,
        failed: failedDocumentTypes.length,
        failedDocumentTypes: failedDocumentTypes.length ? failedDocumentTypes : undefined,
      },
      referral: referredByStaffId ? { staffId: referredByStaffId } : null,
    });
  } catch (err) {
    console.error('Register provider error:', err);
    res.status(500).json({ error: 'Failed to register provider' });
  }
});

// GET /providers/status/:userId
router.get('/status/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const { data, error } = await supabase
      .from('providers')
      .select('status')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('Status lookup error:', error);
      return res.status(500).json({ error: 'Failed to fetch status' });
    }

    res.json({ status: data ? data.status : 'not_registered' });
  } catch (err) {
    console.error('Status lookup error:', err);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// GET /providers/profile/:userId
// IMPORTANT: must stay above any /:providerId/... routes
router.get('/profile/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, full_name, phone, user_type')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      console.error('Profile user lookup error:', userError);
      return res.status(404).json({ error: 'User not found' });
    }

    const { data: provider, error: providerError } = await supabase
      .from('providers')
      .select(
        'provider_type, business_name, email, vehicle_info, location, area_of_operation, latitude, longitude, service_options, status, rating',
      )
      .eq('user_id', userId)
      .maybeSingle();

    if (providerError) {
      console.error('Profile provider lookup error:', providerError);
      return res.status(500).json({ error: 'Failed to load provider details' });
    }

    if (!provider) {
      return res.json({ user, provider: null, services: [], profilePhotoUrl: null });
    }

    // Profile image: individuals show their passport photo; businesses show
    // a premises photo. The bucket is private, so return a short-lived
    // signed URL.
    const isBusiness = provider.provider_type === 'business';
    const photoDocType = PROFILE_PHOTO_DOC_TYPE[isBusiness ? 'business' : 'individual'];

    // Individuals: latest passport photo. Businesses: the first premises
    // photo they uploaded, so the image stays stable as more are added.
    // NOTE: provider_documents' timestamp column is `uploaded_at`, not
    // `created_at` — ordering by the wrong name previously made this
    // query fail silently (Supabase returns an error, which was logged
    // but swallowed), leaving profilePhotoUrl permanently null.
    const { data: photoDoc, error: photoError } = await supabase
      .from('provider_documents')
      .select('storage_path')
      .eq('provider_id', userId)
      .eq('document_type', photoDocType)
      .order('uploaded_at', { ascending: isBusiness })
      .limit(1)
      .maybeSingle();

    if (photoError) {
      console.error('❌ Profile photo lookup error:', photoError.message);
    }
    const profilePhotoUrl = await signDocumentUrl(photoDoc?.storage_path);

    const { data: providerServices, error: servicesError } = await supabase
      .from('provider_services')
      .select('status, services ( key, title, icon )')
      .eq('provider_id', userId);

    if (servicesError) {
      console.error('Profile services lookup error:', servicesError);
      return res.status(500).json({ error: 'Failed to load services' });
    }

    res.json({
      user,
      provider,
      profilePhotoUrl,
      services: (providerServices || []).map((ps) => ({
        key: ps.services?.key,
        title: ps.services?.title,
        icon: ps.services?.icon,
        status: ps.status,
      })),
    });
  } catch (err) {
    console.error('Profile fetch error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// PATCH /providers/profile/:userId
// Lets a provider edit their own contact/vehicle/business/location details.
// Deliberately excludes provider_type, status, and rating — those are
// system-managed (provider_type in particular drives which documents were
// required at registration) and must not be settable from this endpoint.
// IMPORTANT: must stay above any /:providerId/... routes.
router.patch('/profile/:userId', async (req, res) => {
  const { userId } = req.params;
  const { email, businessName, vehicleInfo, location, areaOfOperation } = req.body;

  const update = {};
  if (email !== undefined) {
    if (!EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }
    update.email = email;
  }
  if (businessName !== undefined) {
    if (!`${businessName}`.trim()) {
      return res.status(400).json({ error: 'Business name cannot be empty' });
    }
    update.business_name = `${businessName}`.trim();
  }
  if (vehicleInfo !== undefined) {
    if (!`${vehicleInfo}`.trim()) {
      return res.status(400).json({ error: 'Vehicle info cannot be empty' });
    }
    update.vehicle_info = `${vehicleInfo}`.trim();
  }
  if (location !== undefined) {
    if (!`${location}`.trim()) {
      return res.status(400).json({ error: 'Location cannot be empty' });
    }
    update.location = `${location}`.trim();
  }
  if (areaOfOperation !== undefined) {
    if (!`${areaOfOperation}`.trim()) {
      return res.status(400).json({ error: 'Area of operation cannot be empty' });
    }
    update.area_of_operation = `${areaOfOperation}`.trim();
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  try {
    const { data, error } = await supabase
      .from('providers')
      .update(update)
      .eq('user_id', userId)
      .select(
        'provider_type, business_name, email, vehicle_info, location, area_of_operation, latitude, longitude, service_options, status, rating',
      )
      .single();

    if (error) {
      console.error('Profile update error:', error);
      return res.status(500).json({ error: 'Failed to update profile' });
    }

    res.json({ success: true, provider: data });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Post-registration service management
//
// Lets a provider add services, edit the options/variants of services they
// already offer, remove a service, and upload extra supporting documents
// (manage_services_screen.dart). Reuses the registration helpers above, so
// the same validation rules apply.
//
// Added services start as 'pending' in provider_services and are not matched
// to jobs until an admin approves them. Admins review each new service on its
// own from the provider detail page (PATCH /admin/providers/:id/services/
// :serviceKey/approve|reject in admin.js). NOTE: the /:providerId/approve
// route below approves ALL of a provider's services at once.
//
// NOTE: like the other provider routes there is no auth check on these. Add
// the same auth you put on the other provider routes.
//
// IMPORTANT: must stay above the /:providerId/... routes further down.
// ─────────────────────────────────────────────────────────────────────────────

// Document types a provider may upload after registration. The client sends
// these as the multipart field names.
const LATE_DOC_TYPES = new Set(['insurance_certificate', 'supporting_document']);

// Groups uploaded files by document type and reports any field name that
// isn't an allowed post-registration document type.
function groupLateFiles(files) {
  const filesByType = {};
  const unexpected = [];
  for (const file of files || []) {
    const type = documentTypeOf(file);
    if (!LATE_DOC_TYPES.has(type)) unexpected.push(type);
    else (filesByType[type] ||= []).push(file);
  }
  return { filesByType, unexpected };
}

// Individuals adding cargo (as a service or a sub-option) need a Motor
// Vehicle Insurance certificate — either in this request or already on file
// (and not rejected). Returns the list of missing document types.
async function missingLateDocuments(userId, providerType, selectedKeys, filesByType) {
  if (providerType !== 'individual') return [];
  if (!selectedKeys.some((k) => CARGO_SERVICE_KEYS.has(k))) return [];
  if (filesByType.insurance_certificate?.length) return [];

  const { data } = await supabase
    .from('provider_documents')
    .select('id')
    .eq('provider_id', userId)
    .eq('document_type', 'insurance_certificate')
    .neq('status', 'rejected')
    .limit(1);
  return data?.length ? [] : ['insurance_certificate'];
}

// Uploads each file to Storage and records it in provider_documents, same as
// registration. Failures are counted, not thrown — the service change has
// already been saved by the time this runs.
async function storeDocuments(userId, filesByType) {
  const files = Object.entries(filesByType).flatMap(([type, list]) =>
    list.map((file) => [type, file])
  );

  const results = await Promise.all(
    files.map(async ([documentType, file]) => {
      try {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const storagePath = `${userId}/${documentType}/${Date.now()}-${safeName}`;

        const { error: uploadError } = await supabase.storage
          .from(DOCUMENTS_BUCKET)
          .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
        if (uploadError) throw uploadError;

        const { error: insertError } = await supabase.from('provider_documents').insert({
          provider_id: userId,
          document_type: documentType,
          file_name: file.originalname,
          storage_path: storagePath,
          mime_type: file.mimetype,
          size_bytes: file.size,
          status: 'pending',
        });
        if (insertError) throw insertError;

        return { ok: true, documentType };
      } catch (err) {
        console.error('❌ Document handling error:', err.message);
        return { ok: false, documentType };
      }
    })
  );

  const failedDocumentTypes = results.filter((r) => !r.ok).map((r) => r.documentType);
  return {
    uploaded: results.filter((r) => r.ok).length,
    failed: failedDocumentTypes.length,
    failedDocumentTypes: failedDocumentTypes.length ? failedDocumentTypes : undefined,
  };
}

// Loads the provider row a service change applies to, or an error result.
async function loadProviderForEdit(userId) {
  const { data, error } = await supabase
    .from('providers')
    .select('provider_type, status, service_options')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return { status: 500, error: 'Failed to load provider' };
  if (!data) return { status: 404, error: 'Provider not found' };
  if (data.status === 'rejected') {
    return { status: 403, error: 'Your registration was rejected; services cannot be changed' };
  }
  return { provider: data };
}

// GET /providers/:userId/offerings
// -> { offerings: { "<serviceKey>": { "<optionKey>": ["<variantId>", ...] } } }
// What the provider currently stocks, so the edit screen can pre-select
// variants. Options with no variants appear with an empty array.
router.get('/:userId/offerings', async (req, res) => {
  const { userId } = req.params;

  try {
    const { data, error } = await supabase
      .from('provider_offerings')
      .select('variant_id, service_options ( key, services ( key ) )')
      .eq('provider_id', userId);

    if (error) {
      console.error('❌ Offerings lookup error:', error.message);
      return res.status(500).json({ error: 'Failed to load offerings' });
    }

    const offerings = {};
    for (const row of data || []) {
      const serviceKey = row.service_options?.services?.key;
      const optionKey = row.service_options?.key;
      if (!serviceKey || !optionKey) continue;
      offerings[serviceKey] ||= {};
      offerings[serviceKey][optionKey] ||= [];
      if (row.variant_id) offerings[serviceKey][optionKey].push(row.variant_id);
    }

    res.json({ offerings });
  } catch (err) {
    console.error('❌ Offerings route error:', err.message);
    res.status(500).json({ error: 'Failed to load offerings' });
  }
});

// POST /providers/:userId/services   (multipart or JSON)
// Fields: services (JSON array of NEW service keys), serviceOptions,
// serviceVariants. Optional files: insurance_certificate,
// supporting_document. New services start 'pending' for admin review.
router.post('/:userId/services', upload.any(), async (req, res) => {
  const { userId } = req.params;

  const servicesParsed = parseJsonField(req.body.services, undefined);
  const optionsParsed = parseJsonField(req.body.serviceOptions, {});
  const variantsParsed = parseJsonField(req.body.serviceVariants, {});
  if (!servicesParsed.ok || !optionsParsed.ok || !variantsParsed.ok) {
    return res
      .status(400)
      .json({ error: 'Invalid services, serviceOptions or serviceVariants format' });
  }
  const newKeys = Array.isArray(servicesParsed.value) ? [...new Set(servicesParsed.value)] : [];
  if (!newKeys.length) {
    return res.status(400).json({ error: 'Select at least one service to add' });
  }

  try {
    const loaded = await loadProviderForEdit(userId);
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });
    const { provider } = loaded;

    const { data: matched, error: serviceError } = await supabase
      .from('services')
      .select('id, key')
      .in('key', newKeys);
    if (serviceError) {
      console.error('Add services lookup error:', serviceError);
      return res.status(500).json({ error: 'Failed to validate services' });
    }
    if (!matched || matched.length !== newKeys.length) {
      return res.status(400).json({ error: 'One or more selected services are invalid' });
    }

    const { data: existing, error: existingError } = await supabase
      .from('provider_services')
      .select('service_id')
      .eq('provider_id', userId);
    if (existingError) {
      console.error('Add services existing lookup error:', existingError);
      return res.status(500).json({ error: 'Failed to add services' });
    }
    const existingIds = new Set((existing || []).map((e) => e.service_id));
    if (matched.some((s) => existingIds.has(s.id))) {
      return res.status(409).json({ error: 'You already offer one or more of these services' });
    }

    const serviceOptions = sanitizeServiceOptions(optionsParsed.value, newKeys);
    const serviceVariants = sanitizeServiceVariants(variantsParsed.value, serviceOptions);

    const { filesByType, unexpected } = groupLateFiles(req.files);
    if (unexpected.length) {
      return res.status(400).json({ error: `Unexpected document type: ${unexpected[0]}` });
    }

    const selectedKeys = [...newKeys, ...Object.values(serviceOptions).flat()];
    const missingDocuments = await missingLateDocuments(
      userId,
      provider.provider_type,
      selectedKeys,
      filesByType
    );
    if (missingDocuments.length) {
      return res.status(400).json({ error: 'Missing required documents', missingDocuments });
    }

    // Validate options/variants before writing anything.
    const offerings = await buildOfferingRows(userId, matched, serviceOptions, serviceVariants);
    if (offerings.error) {
      return res.status(offerings.status).json({ error: offerings.error });
    }

    const { error: linkError } = await supabase.from('provider_services').insert(
      matched.map((s) => ({ provider_id: userId, service_id: s.id, status: 'pending' }))
    );
    if (linkError) {
      console.error('Add services link error:', linkError);
      return res.status(500).json({ error: 'Failed to add services' });
    }

    if (offerings.rows.length > 0) {
      const { error: offeringsError } = await supabase
        .from('provider_offerings')
        .insert(offerings.rows);
      if (offeringsError) {
        console.error('Add services offerings error:', offeringsError);
        // Undo just the links added above so the provider can retry.
        await supabase
          .from('provider_services')
          .delete()
          .eq('provider_id', userId)
          .in('service_id', matched.map((s) => s.id));
        return res.status(500).json({ error: 'Failed to save the products you offer' });
      }
    }

    // Merge the new option selections into the stored JSON.
    const { error: optionsError } = await supabase
      .from('providers')
      .update({ service_options: { ...(provider.service_options || {}), ...serviceOptions } })
      .eq('user_id', userId);
    if (optionsError) {
      console.error('Add services options update error:', optionsError.message);
    }

    const documents = await storeDocuments(userId, filesByType);

    res.json({ success: true, added: newKeys, offerings: offerings.rows.length, documents });
  } catch (err) {
    console.error('Add services error:', err);
    res.status(500).json({ error: 'Failed to add services' });
  }
});

// PATCH /providers/:userId/services/:serviceKey   (multipart or JSON)
// Replaces the options/variants a provider offers under ONE service they
// already have. Fields: serviceOptions, serviceVariants (for that service
// only). Optional files: insurance_certificate, supporting_document.
// NOTE: edits to an approved service take effect immediately. To require
// re-review, also set that provider_services row back to 'pending' here.
router.patch('/:userId/services/:serviceKey', upload.any(), async (req, res) => {
  const { userId, serviceKey } = req.params;

  const optionsParsed = parseJsonField(req.body.serviceOptions, {});
  const variantsParsed = parseJsonField(req.body.serviceVariants, {});
  if (!optionsParsed.ok || !variantsParsed.ok) {
    return res.status(400).json({ error: 'Invalid serviceOptions or serviceVariants format' });
  }

  try {
    const loaded = await loadProviderForEdit(userId);
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });
    const { provider } = loaded;

    const { data: service, error: serviceError } = await supabase
      .from('services')
      .select('id, key')
      .eq('key', serviceKey)
      .maybeSingle();
    if (serviceError) {
      console.error('Edit service lookup error:', serviceError);
      return res.status(500).json({ error: 'Failed to update service' });
    }
    if (!service) return res.status(404).json({ error: 'Service not found' });

    const { data: link } = await supabase
      .from('provider_services')
      .select('status')
      .eq('provider_id', userId)
      .eq('service_id', service.id)
      .maybeSingle();
    if (!link) return res.status(404).json({ error: 'You do not offer this service' });

    const serviceOptions = sanitizeServiceOptions(optionsParsed.value, [serviceKey]);
    const serviceVariants = sanitizeServiceVariants(variantsParsed.value, serviceOptions);

    const { filesByType, unexpected } = groupLateFiles(req.files);
    if (unexpected.length) {
      return res.status(400).json({ error: `Unexpected document type: ${unexpected[0]}` });
    }

    const selectedKeys = [serviceKey, ...(serviceOptions[serviceKey] || [])];
    const missingDocuments = await missingLateDocuments(
      userId,
      provider.provider_type,
      selectedKeys,
      filesByType
    );
    if (missingDocuments.length) {
      return res.status(400).json({ error: 'Missing required documents', missingDocuments });
    }

    // Validate BEFORE touching the existing rows.
    const offerings = await buildOfferingRows(userId, [service], serviceOptions, serviceVariants);
    if (offerings.error) {
      return res.status(offerings.status).json({ error: offerings.error });
    }

    // Snapshot, delete, insert; restore the snapshot if the insert fails.
    const { data: optionRows } = await supabase
      .from('service_options')
      .select('id')
      .eq('service_id', service.id);
    const optionIds = (optionRows || []).map((o) => o.id);

    let oldRows = [];
    if (optionIds.length) {
      const { data } = await supabase
        .from('provider_offerings')
        .select('provider_id, service_option_id, variant_id')
        .eq('provider_id', userId)
        .in('service_option_id', optionIds);
      oldRows = data || [];

      const { error: deleteError } = await supabase
        .from('provider_offerings')
        .delete()
        .eq('provider_id', userId)
        .in('service_option_id', optionIds);
      if (deleteError) {
        console.error('Edit service delete error:', deleteError.message);
        return res.status(500).json({ error: 'Failed to update service' });
      }
    }

    if (offerings.rows.length > 0) {
      const { error: insertError } = await supabase
        .from('provider_offerings')
        .insert(offerings.rows);
      if (insertError) {
        console.error('Edit service insert error:', insertError.message);
        if (oldRows.length) {
          await supabase.from('provider_offerings').insert(oldRows);
        }
        return res.status(500).json({ error: 'Failed to update service' });
      }
    }

    const nextOptions = { ...(provider.service_options || {}) };
    if (serviceOptions[serviceKey]) nextOptions[serviceKey] = serviceOptions[serviceKey];
    else delete nextOptions[serviceKey];
    const { error: optionsError } = await supabase
      .from('providers')
      .update({ service_options: nextOptions })
      .eq('user_id', userId);
    if (optionsError) {
      console.error('Edit service options update error:', optionsError.message);
    }

    const documents = await storeDocuments(userId, filesByType);

    res.json({ success: true, serviceKey, offerings: offerings.rows.length, documents });
  } catch (err) {
    console.error('Edit service error:', err);
    res.status(500).json({ error: 'Failed to update service' });
  }
});

// DELETE /providers/:userId/services/:serviceKey
// Stops offering a service and clears its offerings. A provider must keep at
// least one service. This does not check for an in-progress job — add that
// check here if removing a service mid-job would be a problem.
router.delete('/:userId/services/:serviceKey', async (req, res) => {
  const { userId, serviceKey } = req.params;

  try {
    const { data: service, error: serviceError } = await supabase
      .from('services')
      .select('id')
      .eq('key', serviceKey)
      .maybeSingle();
    if (serviceError) {
      console.error('Remove service lookup error:', serviceError);
      return res.status(500).json({ error: 'Failed to remove service' });
    }
    if (!service) return res.status(404).json({ error: 'Service not found' });

    const { count, error: countError } = await supabase
      .from('provider_services')
      .select('service_id', { count: 'exact', head: true })
      .eq('provider_id', userId);
    if (countError) {
      console.error('Remove service count error:', countError);
      return res.status(500).json({ error: 'Failed to remove service' });
    }
    if ((count || 0) <= 1) {
      return res.status(400).json({ error: 'You must offer at least one service' });
    }

    const { data: optionRows } = await supabase
      .from('service_options')
      .select('id')
      .eq('service_id', service.id);
    const optionIds = (optionRows || []).map((o) => o.id);

    if (optionIds.length) {
      const { error: offeringsError } = await supabase
        .from('provider_offerings')
        .delete()
        .eq('provider_id', userId)
        .in('service_option_id', optionIds);
      if (offeringsError) {
        console.error('Remove service offerings error:', offeringsError.message);
        return res.status(500).json({ error: 'Failed to remove service' });
      }
    }

    const { error: linkError } = await supabase
      .from('provider_services')
      .delete()
      .eq('provider_id', userId)
      .eq('service_id', service.id);
    if (linkError) {
      console.error('Remove service link error:', linkError.message);
      return res.status(500).json({ error: 'Failed to remove service' });
    }

    const { data: provider } = await supabase
      .from('providers')
      .select('service_options')
      .eq('user_id', userId)
      .maybeSingle();
    if (provider?.service_options?.[serviceKey]) {
      const next = { ...provider.service_options };
      delete next[serviceKey];
      await supabase.from('providers').update({ service_options: next }).eq('user_id', userId);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Remove service error:', err);
    res.status(500).json({ error: 'Failed to remove service' });
  }
});

// POST /providers/:userId/documents   (multipart, files only)
// Standalone upload of extra documents (insurance_certificate or
// supporting_document) without changing any services.
router.post('/:userId/documents', upload.any(), async (req, res) => {
  const { userId } = req.params;

  const { filesByType, unexpected } = groupLateFiles(req.files);
  if (unexpected.length) {
    return res.status(400).json({ error: `Unexpected document type: ${unexpected[0]}` });
  }
  if (!Object.keys(filesByType).length) {
    return res.status(400).json({ error: 'No documents uploaded' });
  }

  try {
    const { data: provider, error } = await supabase
      .from('providers')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('Documents provider lookup error:', error);
      return res.status(500).json({ error: 'Failed to upload documents' });
    }
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    const documents = await storeDocuments(userId, filesByType);
    res.json({ success: true, documents });
  } catch (err) {
    console.error('Documents upload error:', err);
    res.status(500).json({ error: 'Failed to upload documents' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /providers/nearby?type=mechanic&lat=-1.286&lng=36.817&radius=15
//                       [&optionKey=electrical&variantId=<uuid>]
//
// optionKey / variantId are what the customer picked under the service. When
// given, only providers who currently offer exactly that (provider_offerings:
// active and in stock) are returned, the same rule find_nearest_provider()
// applies at dispatch. Without them the search is service-level, as before.
//
// Uses the find_nearby_providers() SQL function (see
// find_nearby_providers.sql). It applies the same core filters as
// find_nearest_provider() — online, approved for this service, has a
// location — but returns MANY rows nearest-first instead of just one, and
// also drops providers whose last ping is older than
// NEARBY_MAX_PING_AGE_SECONDS so the map only shows providers who can
// actually respond.
//
// find_nearest_provider() is left alone: dispatch.js depends on it
// returning the single best match.
//
// Customer-facing and deliberately minimal: only id, name, live position
// and an ETA estimate. No rating, vehicle info, avatar, distance, phone, or
// anything else about the provider — customers can't choose a provider, so
// the map only needs enough to draw a marker and show a name.
//
// IMPORTANT: must stay above any /:providerId/... or /:id/... routes below,
// or "nearby" gets captured as a param instead of matching this route.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/nearby', async (req, res) => {
  const { type } = req.query;
  const latitude = Number(req.query.lat);
  const longitude = Number(req.query.lng);
  const radiusKm = Number(req.query.radius) > 0 ? Number(req.query.radius) : DEFAULT_RADIUS_KM;
  const optionKey = req.query.optionKey ? String(req.query.optionKey).trim() : '';
  const variantId = req.query.variantId ? String(req.query.variantId).trim() : '';

  if (!type) {
    return res.status(400).json({ error: 'type is required' });
  }
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return res.status(400).json({ error: 'Valid lat and lng are required' });
  }
  if (variantId && !optionKey) {
    return res.status(400).json({ error: 'variantId needs an optionKey' });
  }
  if (variantId && !UUID_PATTERN.test(variantId)) {
    return res.status(400).json({ error: 'Invalid variantId' });
  }

  try {
    // Resolve the chosen option to its id for this service. An option that
    // doesn't exist (or is switched off) can't match anyone, so return an
    // empty list rather than falling back to every provider of the service.
    let optionId = null;
    if (optionKey) {
      const { data: option, error: optionError } = await supabase
        .from('service_options')
        .select('id, services!inner ( key )')
        .eq('key', optionKey)
        .eq('is_active', true)
        .eq('services.key', type)
        .maybeSingle();

      if (optionError) {
        console.error('❌ Nearby option lookup error:', optionError.message);
        return res.status(500).json({ error: 'Failed to fetch nearby providers' });
      }
      if (!option) {
        return res.json({ success: true, data: [], count: 0 });
      }
      optionId = option.id;
    }

    const { data: ranked, error: rpcError } = await supabase.rpc('find_nearby_providers', {
      request_lat: latitude,
      request_lng: longitude,
      service_type: type,
      excluded_ids: [],
      max_results: MAX_RESULTS,
      max_ping_age_seconds: NEARBY_MAX_PING_AGE_SECONDS,
      request_option_id: optionId,
      request_variant_id: variantId || null,
    });

    if (rpcError) {
      console.error('❌ Nearby providers RPC error:', rpcError.message);
      return res.status(500).json({ error: 'Failed to fetch nearby providers', detail: rpcError.message });
    }

    const result = (ranked || [])
      .filter((p) => p.distance_km == null || p.distance_km <= radiusKm)
      .slice(0, MAX_RESULTS)
      .map((p) => ({
        id: p.id,
        name: p.full_name || 'Provider',
        latitude: p.current_latitude ?? null,
        longitude: p.current_longitude ?? null,
        etaMinutes:
          p.distance_km != null
            ? Math.max(3, Math.round((p.distance_km / AVG_SPEED_KMH) * 60))
            : null,
      }));

    if (process.env.DISPATCH_DEBUG === 'true') {
      console.log(
        `🔍 Nearby "${type}"${optionKey ? `/${optionKey}` : ''}: rpc=${ranked?.length ?? 0}, returned=${result.length}`
      );
    }

    res.json({ success: true, data: result, count: result.length });
  } catch (err) {
    console.error('❌ Nearby providers error:', err.message);
    res.status(500).json({ error: 'Failed to fetch nearby providers' });
  }
});

// POST /providers/:id/status
router.post('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { online, latitude, longitude } = req.body;

  if (online && (latitude == null || longitude == null)) {
    return res.status(400).json({ error: 'Location is required to go online' });
  }

  try {
    const update = { is_online: !!online };
    if (online) {
      update.current_latitude = latitude;
      update.current_longitude = longitude;
      // Stamp the heartbeat here too, not just on /location — otherwise a
      // provider who goes online but whose first location ping is delayed
      // would have a null last_ping_at and get reaped as stale almost
      // immediately by expire_stale_provider_presence().
      update.last_ping_at = new Date().toISOString();
    }

    const { error } = await supabase
      .from('users')
      .update(update)
      .eq('id', id);

    if (error) {
      console.error('Status update error:', error);
      return res.status(500).json({ error: 'Failed to update status' });
    }

    res.json({ success: true, online: !!online });
  } catch (err) {
    console.error('Status update error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /providers/:id/location
// Body: { latitude, longitude, speed?, heading?, accuracy?, recordedAt? }
//
// The heartbeat AND live-tracking source: the foreground-service isolate
// posts here every ~15 s while idle and every ~4 s during a job. Once pings
// stop — crash, force-kill, dead battery — the scheduled reaper
// (migrations/fix_stale_provider_presence.sql) flips is_online back to false
// within ~2-3 minutes, and during a job the sweeper's tracking-health check
// (dispatch.js checkTrackingHealth) alerts the customer and the provider.
//
// Goes through updateProviderLocation() in dispatch.js, the same function the
// 'provider_location' socket event uses, so the customer ALSO gets the instant
// socket push even though the foreground isolate only speaks HTTP. That
// function also drops out-of-order pings (using recordedAt), only accepts
// users with user_type 'provider', and reports a failed write so this route
// answers 500 and the phone's error counter climbs.
//
// NOTE: like the other provider routes there is no auth check here, so anyone
// who knows a provider id could move that provider on the customer's map. Add
// the same auth you put on the other provider routes, and check that the
// authenticated user id equals :id.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/location', async (req, res) => {
  const { id } = req.params;
  const latitude = Number(req.body.latitude);
  const longitude = Number(req.body.longitude);

  if (
    !UUID_PATTERN.test(id) ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return res.status(400).json({ error: 'Valid latitude and longitude are required' });
  }

  try {
    const ok = await updateProviderLocation(id, latitude, longitude, req.app.get('io'), {
      speed: req.body.speed,
      heading: req.body.heading,
      accuracy: req.body.accuracy,
      recordedAt: req.body.recordedAt,
    });

    if (!ok) {
      return res.status(500).json({ error: 'Failed to update location' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Location update error:', err);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /providers/:id/panic
// Body: { name?, phone?, latitude, longitude, accuracy? }
//
// The provider app's SOS button → "Send Panic Alert" (provider_dashboard_
// screen.dart). Records the provider's name, phone number and live location
// in panic_alerts (see panic_alerts.sql) so the team can respond.
//
// Name and phone are read from the users table, which is the source of truth;
// the values the app sends are only a fallback. Coordinates must be valid.
// A repeat press within PANIC_DEDUPE_WINDOW_MS returns the existing alert
// instead of creating a duplicate.
//
// If the app set an Socket.IO instance with app.set('io', io), the alert is
// also pushed live to the 'admins' room as 'panic_alert'. Change the room /
// event name to match your admin dashboard, or remove the emit.
//
// NOTE: like the other provider routes there is no auth check here, so anyone
// who knows a provider id could raise a false alert for them. Add the same
// auth you put on the other provider routes.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/panic', async (req, res) => {
  const { id } = req.params;
  const latitude = Number(req.body.latitude);
  const longitude = Number(req.body.longitude);
  const accuracy = Number(req.body.accuracy);

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return res.status(400).json({ error: 'Valid latitude and longitude are required' });
  }

  try {
    // Used by BOTH apps: the provider app's SOS sheet and the customer app's
    // Home panic button. Anyone with a users row can raise an alert; the
    // reporter_type column records which kind of user it was.
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('full_name, phone, user_type')
      .eq('id', id)
      .maybeSingle();

    if (userError) {
      console.error('❌ Panic user lookup error:', userError.message);
      return res.status(500).json({ error: 'Failed to send alert' });
    }
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Ignore repeat presses inside the dedupe window.
    const since = new Date(Date.now() - PANIC_DEDUPE_WINDOW_MS).toISOString();
    const { data: recent, error: recentError } = await supabase
      .from('panic_alerts')
      .select('id')
      .eq('provider_id', id)
      .gte('created_at', since)
      .limit(1);

    if (recentError) {
      // Don't block a real emergency over a dedupe-check hiccup.
      console.error('❌ Panic dedupe lookup error (continuing):', recentError.message);
    } else if (recent?.length) {
      return res.json({ success: true, alertId: recent[0].id, duplicate: true });
    }

    const { data: alert, error: insertError } = await supabase
      .from('panic_alerts')
      .insert({
        provider_id: id,
        provider_name: user.full_name || `${req.body.name ?? ''}`.trim() || null,
        provider_phone: user.phone || `${req.body.phone ?? ''}`.trim() || null,
        reporter_type: user.user_type === 'provider' ? 'provider' : 'customer',
        latitude,
        longitude,
        accuracy_m: Number.isFinite(accuracy) ? accuracy : null,
      })
      .select('*')
      .single();

    if (insertError) {
      console.error('❌ Panic insert error:', insertError.message);
      return res.status(500).json({ error: 'Failed to send alert' });
    }

    // Optional live push to the admin dashboard.
    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('panic_alert', {
        ...alert,
        maps_url: `https://www.google.com/maps?q=${latitude},${longitude}`,
      });
    }

    console.log(`🚨 PANIC ALERT from provider ${id} at ${latitude},${longitude}`);
    res.json({ success: true, alertId: alert.id });
  } catch (err) {
    console.error('❌ Panic route error:', err.message);
    res.status(500).json({ error: 'Failed to send alert' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /providers/:id/fcm-token
// Body: { fcmToken: "<FCM device token>" }
//
// The provider app (PushNotificationService) registers its device token here
// on login and whenever Firebase rotates it. dispatch.js reads
// users.fcm_token to send job-request / job-cancelled pushes, so without this
// route no push ever reaches the phone.
//
// Requires: ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token text;
//
// NOTE: like the other provider routes there is no auth check here, so anyone
// who knows a provider id could overwrite that provider's token. Add the same
// auth you put on the other provider routes.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/fcm-token', async (req, res) => {
  const { id } = req.params;
  const { fcmToken } = req.body;

  if (!fcmToken || typeof fcmToken !== 'string') {
    return res.status(400).json({ error: 'fcmToken is required' });
  }

  try {
    // A phone that switches accounts keeps the same token. Clear it from any
    // other user first so the previous account stops getting this device's
    // alerts.
    const { error: clearError } = await supabase
      .from('users')
      .update({ fcm_token: null })
      .eq('fcm_token', fcmToken)
      .neq('id', id);

    if (clearError) {
      console.error('❌ FCM token clear error:', clearError.message);
    }

    const { error } = await supabase
      .from('users')
      .update({ fcm_token: fcmToken })
      .eq('id', id)
      .eq('user_type', 'provider');

    if (error) {
      console.error('❌ FCM token save error:', error.message);
      return res.status(500).json({ error: 'Failed to save token' });
    }

    console.log(`🔔 FCM token saved for provider ${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ FCM token route error:', err.message);
    res.status(500).json({ error: 'Failed to save token' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /providers/:id/fcm-token
//
// Called by the provider app on logout so a logged-out phone stops receiving
// job pushes. Clearing an already-null token is a harmless no-op.
//
// NOTE: same caveat as the POST route above: no auth check, so anyone who
// knows a provider id could clear that provider's token. Add the same auth
// you put on the other provider routes.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id/fcm-token', async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from('users')
      .update({ fcm_token: null })
      .eq('id', id)
      .eq('user_type', 'provider');

    if (error) {
      console.error('❌ FCM token delete error:', error.message);
      return res.status(500).json({ error: 'Failed to clear token' });
    }

    console.log(`🔕 FCM token cleared for provider ${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ FCM token delete route error:', err.message);
    res.status(500).json({ error: 'Failed to clear token' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /providers/:providerId/jobs
// Powers the Job History screen. Returns all requests assigned to this
// provider (any status), newest first.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:providerId/jobs', async (req, res) => {
  const { providerId } = req.params;

  try {
    const { data, error } = await supabase
      .from('service_requests')
      .select(`
        id,
        type,
        status,
        address,
        eta_minutes,
        created_at,
        customer:user_id ( full_name, phone )
      `)
      .eq('current_provider_id', providerId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      console.error('❌ Jobs fetch error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch jobs', detail: error.message });
    }

    const jobs = (data || []).map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      address: r.address,
      eta_minutes: r.eta_minutes,
      created_at: r.created_at,
      customer_name: r.customer?.full_name ?? null,
      customer_phone: r.customer?.phone ?? null,
    }));

    res.json({ jobs });
  } catch (err) {
    console.error('❌ Jobs route error:', err.message);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /providers/:id/ratings
// Powers the RATINGS section of the provider's Profile screen
// (provider_profile_screen.dart's _fetchRatings / _buildRatingsCard).
//
// :id is the provider's user id, i.e. request_ratings.provider_id (the
// customer's POST /requests/:id/rating stores the job's current_provider_id
// there).
//
// Response shape (field names are a contract with the Flutter screen):
//   {
//     count:        total number of ratings,
//     average:      mean rating, one decimal (0 when there are none),
//     distribution: { "1": n, "2": n, "3": n, "4": n, "5": n },
//     topTags:      [{ tag, count }, ...]  up to 5, most mentioned first,
//     recent:       [{ rating, comment, tags, createdAt }, ...]  up to 10
//   }
//
// With no ratings yet this returns count 0, which the app shows as
// "No ratings yet" rather than an error.
//
// Requires request_ratings.created_at (timestamptz default now()).
//
// NOTE: like the other provider routes there is no auth check here. Add the
// same auth you put on the other provider routes.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/ratings', async (req, res) => {
  const { id } = req.params;

  if (!UUID_PATTERN.test(id)) {
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
      console.error('❌ Ratings fetch error:', error.message);
      return res.status(500).json({ error: 'Failed to load ratings' });
    }

    const rows = data || [];
    const count = rows.length;

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const tagCounts = new Map();
    let sum = 0;

    for (const r of rows) {
      const stars = Number(r.rating);
      if (stars >= 1 && stars <= 5) {
        distribution[stars] += 1;
        sum += stars;
      }
      for (const t of r.tags || []) {
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      }
    }

    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag, n]) => ({ tag, count: n }));

    const recent = rows.slice(0, 10).map((r) => ({
      rating: r.rating,
      comment: r.comment,
      tags: r.tags || [],
      createdAt: r.created_at,
    }));

    res.json({
      count,
      average: count ? Math.round((sum / count) * 10) / 10 : 0,
      distribution,
      topTags,
      recent,
    });
  } catch (err) {
    console.error('❌ Ratings route error:', err.message);
    res.status(500).json({ error: 'Failed to load ratings' });
  }
});

// GET /providers/:providerId/earnings?period=today|this_week|this_month
router.get('/:providerId/earnings', async (req, res) => {
  const { providerId } = req.params;
  const period = (req.query.period || 'today').toString();

  try {
    const now = new Date();
    let startDate = new Date();
    if (period === 'today') {
      startDate.setHours(0, 0, 0, 0);
    } else if (period === 'this_week') {
      const dayOfWeek = now.getDay();
      startDate.setDate(now.getDate() - dayOfWeek);
      startDate.setHours(0, 0, 0, 0);
    } else if (period === 'this_month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      return res.status(400).json({ error: 'Invalid period' });
    }

    const { data: periodJobs, error: periodError } = await supabase
      .from('service_requests')
      .select('id, pay_amount')
      .eq('current_provider_id', providerId)
      .eq('status', 'completed')
      .gte('created_at', startDate.toISOString());

    if (periodError) {
      console.error('Earnings period lookup error:', periodError);
      return res.status(500).json({ error: 'Failed to load earnings summary' });
    }

    const jobs = periodJobs?.length || 0;
    const total = (periodJobs || []).reduce((sum, j) => sum + (j.pay_amount || 0), 0);
    const avg = jobs > 0 ? Math.round(total / jobs) : 0;

    const { data: recent, error: recentError } = await supabase
      .from('service_requests')
      .select('id, type, pay_amount, created_at, customer:user_id ( full_name )')
      .eq('current_provider_id', providerId)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(10);

    if (recentError) {
      console.error('Earnings transactions lookup error:', recentError);
      return res.status(500).json({ error: 'Failed to load transactions' });
    }

    const { data: nextPayout, error: payoutError } = await supabase
      .from('payouts')
      .select('amount, scheduled_date, method, phone, status')
      .eq('provider_id', providerId)
      .eq('status', 'pending')
      .order('scheduled_date', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (payoutError) {
      console.error('Earnings payout lookup error:', payoutError);
      return res.status(500).json({ error: 'Failed to load payout info' });
    }

    res.json({
      summary: { total, jobs, avg },
      transactions: (recent || []).map((t) => ({
        id: t.id,
        type: t.type,
        customer: t.customer?.full_name ?? 'Customer',
        amount: t.pay_amount || 0,
        date: t.created_at,
        status: t.pay_amount != null ? 'paid' : 'pending',
        icon: ICONS[t.type] || 'car',
      })),
      nextPayout: nextPayout || null,
    });
  } catch (err) {
    console.error('Earnings fetch error:', err);
    res.status(500).json({ error: 'Failed to load earnings' });
  }
});

// PATCH /providers/:providerId/approve
router.patch('/:providerId/approve', async (req, res) => {
  const { providerId } = req.params;

  try {
    const { data, error } = await supabase
      .from('providers')
      .update({ status: 'approved' })
      .eq('user_id', providerId)
      .select()
      .maybeSingle();

    if (error) {
      console.error('Approve provider error:', error);
      return res.status(500).json({ error: 'Failed to approve provider' });
    }
    if (!data) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    await supabase
      .from('provider_services')
      .update({ status: 'approved' })
      .eq('provider_id', providerId);

    res.json({ success: true, provider: data });
  } catch (err) {
    console.error('Approve provider error:', err);
    res.status(500).json({ error: 'Failed to approve provider' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /providers/:providerId/dashboard
//
// "Nearby requests" (pendingJobs) is the open CLAIM POOL, not a re-list of
// jobs already targeted at this provider. Auto-dispatch (dispatch.js)
// always tries a single nearest provider first via a direct 'assigned'
// push (see the "Job request" card, fed by socket/push/active-poll on the
// client, never this endpoint). Only once that targeted match comes up
// empty does a request land here — status 'no_providers', current_
// provider_id still null — as the fallback: any online provider approved
// for that service, within DEFAULT_RADIUS_KM, can browse and claim it.
// Claiming goes through the exact same POST /requests/accept →
// acceptRequest() as a targeted assignment, CAS-protected the same way
// (dispatch.js's CLAIMABLE_STATUSES), so first-to-accept wins with no
// double-booking risk.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:providerId/dashboard', async (req, res) => {
  const { providerId } = req.params;

  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { count: todaysJobsCount, error: todaysError } = await supabase
      .from('service_requests')
      .select('id', { count: 'exact', head: true })
      .eq('current_provider_id', providerId)
      .eq('status', 'completed')
      .gte('created_at', startOfDay.toISOString());

    if (todaysError) {
      console.error('Todays jobs lookup error:', todaysError);
      return res.status(500).json({ error: 'Failed to load dashboard' });
    }

    const { count: totalJobs, error: totalError } = await supabase
      .from('service_requests')
      .select('id', { count: 'exact', head: true })
      .eq('current_provider_id', providerId)
      .eq('status', 'completed');

    if (totalError) {
      console.error('Total jobs lookup error:', totalError);
      return res.status(500).json({ error: 'Failed to load dashboard' });
    }

    const { data: provider, error: providerLookupError } = await supabase
      .from('providers')
      .select('rating')
      .eq('user_id', providerId)
      .maybeSingle();

    if (providerLookupError) {
      console.error('Provider rating lookup error:', providerLookupError);
      return res.status(500).json({ error: 'Failed to load dashboard' });
    }

    const { data: providerUser, error: providerUserError } = await supabase
      .from('users')
      .select('is_online, current_latitude, current_longitude')
      .eq('id', providerId)
      .maybeSingle();

    if (providerUserError) {
      console.error('Provider online-status lookup error:', providerUserError);
      return res.status(500).json({ error: 'Failed to load dashboard' });
    }

    // ── Nearby open-claim pool ───────────────────────────────────────────
    // Needs the provider to be online with a known location, and to have
    // at least one approved service — without both, "nearby" and "matching
    // service" are meaningless, so the pool is just empty rather than an
    // error.
    let pendingJobs = [];

    if (providerUser?.current_latitude != null && providerUser?.current_longitude != null) {
      const { data: approvedServices, error: approvedServicesError } = await supabase
        .from('provider_services')
        .select('services ( key )')
        .eq('provider_id', providerId)
        .eq('status', 'approved');

      if (approvedServicesError) {
        console.error('Approved services lookup error:', approvedServicesError);
        return res.status(500).json({ error: 'Failed to load dashboard' });
      }

      const approvedKeys = [
        ...new Set((approvedServices || []).map((s) => s.services?.key).filter(Boolean)),
      ];

      if (approvedKeys.length > 0) {
        const since = new Date(Date.now() - BROADCAST_POOL_WINDOW_MS).toISOString();
        const { data: openRequests, error: openError } = await supabase
          .from('service_requests')
          .select('id, type, address, latitude, longitude, customer:user_id ( full_name )')
          .eq('status', 'no_providers')
          .is('current_provider_id', null)
          .in('type', approvedKeys)
          .not('latitude', 'is', null)
          .not('longitude', 'is', null)
          .gte('created_at', since)
          .limit(50);

        if (openError) {
          console.error('Nearby open-requests lookup error:', openError);
          return res.status(500).json({ error: 'Failed to load dashboard' });
        }

        pendingJobs = (openRequests || [])
          .map((r) => ({
            id: r.id,
            type: r.type,
            customer_name: r.customer?.full_name ?? 'Customer',
            address: r.address,
            distanceKm: haversineKm(
              providerUser.current_latitude,
              providerUser.current_longitude,
              r.latitude,
              r.longitude,
            ),
          }))
          .filter((r) => r.distanceKm <= DEFAULT_RADIUS_KM)
          .sort((a, b) => a.distanceKm - b.distanceKm)
          .slice(0, 20)
          .map((r) => ({
            id: r.id,
            type: r.type,
            customer_name: r.customer_name,
            address: r.address,
            distance: `${r.distanceKm.toFixed(1)} km away`,
          }));
      }
    }

    res.json({
      stats: {
        todaysJobs: todaysJobsCount || 0,
        rating: provider?.rating ?? null,
        totalJobs: totalJobs || 0,
      },
      isOnline: providerUser?.is_online ?? false,
      pendingJobs,
    });
  } catch (err) {
    console.error('Dashboard fetch error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// GET /providers/referrals/:staffId
// Lets an admin/staff panel look up which providers a given staff member
// referred, newest first. Not gated by role here (mirrors the rest of this
// router's routes) — add an auth check if this ends up exposed beyond the
// admin panel's own session-gated pages.
router.get('/referrals/:staffId', async (req, res) => {
  const { staffId } = req.params;

  try {
    const { data, error } = await supabase
      .from('providers')
      .select('user_id, provider_type, business_name, email, status, created_at')
      .eq('referred_by_staff_id', staffId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('❌ Referrals lookup error:', error.message);
      return res.status(500).json({ error: 'Failed to load referrals' });
    }

    res.json({ referrals: data || [] });
  } catch (err) {
    console.error('❌ Referrals route error:', err.message);
    res.status(500).json({ error: 'Failed to load referrals' });
  }
});

// Router-level error handler — catches Multer errors (wrong field name,
// file too large, too many files, disallowed mimetype from the fileFilter
// above) so a bad multipart request comes back as a clean 400 JSON
// response instead of a raw stack trace. Must have all four
// (err, req, res, next) params for Express to treat it as an error handler.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('❌ Multer error:', err.code, err.field);
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        error: `Unexpected file field "${err.field}" — the client and server document field names are out of sync.`,
        field: err.field,
      });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}`, field: err.field });
  }
  if (err) {
    // Covers the fileFilter's plain Error('Only images and PDFs are allowed').
    console.error('❌ Upload error:', err.message);
    return res.status(400).json({ error: err.message });
  }
  next();
});

module.exports = router;