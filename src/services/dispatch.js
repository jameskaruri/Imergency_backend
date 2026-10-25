const { supabase } = require('./supabase');
const admin = require('./firebase-admin-init');
const { sendSMS, buildJobRequestMessage } = require('./sms');

const ASSIGNMENT_TIMEOUT = 90; // seconds provider has to accept
const SWEEP_INTERVAL_MS = 15 * 1000; // how often the safety-net sweeper looks for expired assignments
const OPEN_STATUSES = ['pending', 'assigned']; // statuses in which a request can still be (re)assigned or accepted

// A request that fell out of targeted auto-dispatch (findNearestProvider
// found nobody) lands in 'no_providers'. That is the open claim pool any
// nearby approved+online provider can browse and accept (see
// GET /providers/:id/dashboard). acceptRequest() is the only place that
// treats it as still-claimable; assignRequest() deliberately excludes it via
// OPEN_STATUSES, so the automatic escalation timers never touch a request
// once it's here.
const CLAIMABLE_STATUSES = [...OPEN_STATUSES, 'no_providers'];

// Statuses during which the customer should receive the provider's live
// location. Adjust to match the values your journey/arrive routes actually
// write. If `status` is a Postgres enum, remove any value that isn't in it,
// otherwise the query errors.
const TRACKED_STATUSES = ['accepted', 'en_route', 'arrived', 'in_progress'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Providers whose last GPS ping is older than this are treated as unreachable
// and skipped by dispatch. 0 / unset disables the filter. Only turn this on
// once the provider app sends heartbeats while idle (see
// updateProviderHeartbeat), otherwise idle providers count as stale.
const MAX_PING_AGE_SECONDS = Number(process.env.MAX_PING_AGE_SECONDS || 0);

// ── Live location tuning ─────────────────────────────────────────────────────
// An en_route job with no ping for this long triggers "tracking lost" alerts
// to the customer (socket) and the provider (push). Checked by the sweeper.
const TRACKING_LOST_AFTER_MS = 45 * 1000;

// recordedAt sent by a phone is only trusted inside this window; otherwise the
// server clock is used (phone clocks drift).
const MAX_FIX_AGE_MS = 5 * 60 * 1000;

// The "which request is this provider on" lookup is cached briefly so a 4 s
// ping rate does not cost an extra query per ping. A status change is picked
// up within this TTL.
const ACTIVE_CACHE_TTL_MS = 10 * 1000;
const activeRequestCache = new Map(); // providerId -> { request, expiresAt }

// Request ids already alerted for the current outage (alert once, not every sweep).
const lostNotified = new Set();

// ─────────────────────────────────────────────────────────────────────────────
// What the customer asked for (option / variant)
//
// A request for e.g. Gas > LPG Cylinder > Total 13kg stores service_option_id
// and variant_id (see POST /requests/create). Matching then requires the
// provider to have an active, in-stock row in provider_offerings for that
// option, and for that exact variant when one was chosen. Requests with no
// option (older app builds, services without options) skip this filter and
// match on service type alone, as before.
// ─────────────────────────────────────────────────────────────────────────────

// Does this provider currently offer the requested item? Used when a provider
// claims a job from the open pool, so someone who only sells kerosene can't
// pick up an LPG request. Fails open on a lookup error: targeted dispatch has
// already matched on offerings, and a DB hiccup should not block an emergency
// job from being accepted.
async function providerOffers(providerId, optionId, variantId) {
  if (!optionId) return true;

  try {
    let query = supabase
      .from('provider_offerings')
      .select('id')
      .eq('provider_id', providerId)
      .eq('service_option_id', optionId)
      .eq('is_active', true)
      .eq('in_stock', true);

    if (variantId) query = query.eq('variant_id', variantId);

    const { data, error } = await query.limit(1);
    if (error) {
      console.error('❌ Offering check error (allowing accept):', error.message);
      return true;
    }
    return (data || []).length > 0;
  } catch (err) {
    console.error('❌ Offering check failed (allowing accept):', err.message);
    return true;
  }
}

// "Total 13kg x 1", "Kerosene x 2 litres", "Engine". Same format as
// orderSummary() in routes/requests.js so the provider sees the same wording
// in the job offer as on the job card. Never throws; returns null when the
// request has no option or the lookup fails.
async function loadOrderSummary(request) {
  try {
    if (!request?.service_option_id) return null;

    const [{ data: option }, { data: variant }] = await Promise.all([
      supabase
        .from('service_options')
        .select('label, unit')
        .eq('id', request.service_option_id)
        .maybeSingle(),
      request.variant_id
        ? supabase
            .from('option_variants')
            .select('name')
            .eq('id', request.variant_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const item = variant?.name ?? option?.label;
    if (!item) return null;
    if (request.quantity == null) return item;

    const q = Number(request.quantity);
    const unitText = option?.unit ? ` ${option.unit}${q === 1 ? '' : 's'}` : '';
    return `${item} x ${q}${unitText}`;
  } catch (err) {
    console.error('❌ Order summary lookup error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug breakdown: explains *why* find_nearest_provider() came back empty
// (nobody online, nobody approved for this service, nobody offering the
// requested option/variant, or everyone already tried).
// Runs only on a miss, or on every dispatch when DISPATCH_DEBUG=true.
// Only logs, never affects the actual match.
// ─────────────────────────────────────────────────────────────────────────────
async function logDispatchDebug(serviceType, excludedIds, selection = {}) {
  try {
    const { data: onlineProviders, error: onlineErr } = await supabase
      .from('users')
      .select('id, full_name')
      .eq('user_type', 'provider')
      .eq('is_online', true)
      .not('current_latitude', 'is', null)
      .not('current_longitude', 'is', null);

    if (onlineErr) {
      console.log('🔍 Debug: online-provider lookup error:', onlineErr.message);
      return;
    }

    const onlineIds = (onlineProviders || []).map((p) => p.id);
    console.log(`🔍 Debug: ${onlineIds.length} online provider(s) with a location set, for service "${serviceType}"`);
    if (onlineIds.length === 0) return;

    const { data: approved, error: matchErr } = await supabase
      .from('provider_services')
      .select('provider_id, status, services ( key )')
      .in('provider_id', onlineIds)
      .eq('status', 'approved');

    if (matchErr) {
      console.log('🔍 Debug: provider_services lookup error:', matchErr.message);
      return;
    }

    const matchingProviderIds = new Set(
      (approved || [])
        .filter((ps) => ps.services?.key === serviceType)
        .map((ps) => ps.provider_id)
    );
    console.log(`🔍 Debug: ${matchingProviderIds.size}/${onlineIds.length} online provider(s) have an APPROVED "${serviceType}" service`);

    if (matchingProviderIds.size === 0) {
      // Catches app/backend service-ID mismatches (e.g. app sends "mechanic",
      // providers registered as "breakdown").
      const keys = [...new Set((approved || []).map((ps) => ps.services?.key).filter(Boolean))];
      console.log(`🔍 Debug: approved service keys among online providers: [${keys.join(', ')}]. Does "${serviceType}" match one of them?`);
    }

    // Option / variant: of the providers approved for the service, how many
    // actually offer what was asked for.
    let candidateIds = [...matchingProviderIds];
    if (selection.optionId && candidateIds.length > 0) {
      let offerQuery = supabase
        .from('provider_offerings')
        .select('provider_id')
        .in('provider_id', candidateIds)
        .eq('service_option_id', selection.optionId)
        .eq('is_active', true)
        .eq('in_stock', true);
      if (selection.variantId) offerQuery = offerQuery.eq('variant_id', selection.variantId);

      const { data: offers, error: offerErr } = await offerQuery;
      if (offerErr) {
        console.log('🔍 Debug: provider_offerings lookup error:', offerErr.message);
      } else {
        const offering = new Set((offers || []).map((o) => o.provider_id));
        console.log(
          `🔍 Debug: ${offering.size}/${candidateIds.length} approved provider(s) offer the requested item ` +
            `(option ${selection.optionId}${selection.variantId ? `, variant ${selection.variantId}` : ''}) ` +
            'and have it active and in stock'
        );
        candidateIds = candidateIds.filter((id) => offering.has(id));
      }
    }

    const excludedSet = new Set(excludedIds);
    const eligible = candidateIds.filter((id) => !excludedSet.has(id));
    console.log(`🔍 Debug: ${eligible.length} of those remain after excluding already-tried/stale provider(s) [${excludedIds.length} excluded]`);
  } catch (debugErr) {
    console.log('🔍 Debug: breakdown failed unexpectedly:', debugErr.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getStaleProviderIds
// Providers with no ping, or a ping older than MAX_PING_AGE_SECONDS. These get
// merged into the RPC's excluded_ids so a provider whose app is closed (or
// whose location is a day old) never burns a full assignment timeout.
// Fails open: if this lookup errors, dispatch continues without the filter.
// ─────────────────────────────────────────────────────────────────────────────
async function getStaleProviderIds() {
  if (!MAX_PING_AGE_SECONDS) return [];

  try {
    const cutoff = new Date(Date.now() - MAX_PING_AGE_SECONDS * 1000).toISOString();

    const { data, error } = await supabase
      .from('users')
      .select('id')
      .eq('user_type', 'provider')
      .or(`last_ping_at.is.null,last_ping_at.lt.${cutoff}`);

    if (error) {
      console.error('❌ Stale provider lookup error:', error.message);
      return [];
    }

    return (data || []).map((r) => r.id);
  } catch (err) {
    console.error('❌ Stale provider lookup failed:', err.message);
    return [];
  }
}

// `selection` is { optionId, variantId } from the request row
// (service_option_id / variant_id). Both may be null/undefined, which means
// "match on service type only".
async function findNearestProvider(latitude, longitude, serviceType, excludedIds = [], selection = {}) {
  try {
    const staleIds = await getStaleProviderIds();
    const allExcluded = [...new Set([...excludedIds, ...staleIds])];

    const optionId = selection.optionId || null;
    const variantId = selection.variantId || null;

    if (staleIds.length > 0 && process.env.DISPATCH_DEBUG === 'true') {
      console.log(`🔍 Debug: skipping ${staleIds.length} stale provider(s) (no ping in ${MAX_PING_AGE_SECONDS}s)`);
    }

    const { data, error } = await supabase.rpc('find_nearest_provider', {
      request_lat: latitude,
      request_lng: longitude,
      service_type: serviceType,
      excluded_ids: allExcluded,
      request_option_id: optionId,
      request_variant_id: variantId,
    });

    if (error) {
      console.error('❌ Find provider error:', error.message);
      return null;
    }

    const match = data && data.length > 0 ? data[0] : null;

    if (!match || process.env.DISPATCH_DEBUG === 'true') {
      await logDispatchDebug(serviceType, allExcluded, { optionId, variantId });
    }

    return match;
  } catch (err) {
    console.error('❌ Dispatch error:', err.message);
    return null;
  }
}

// FCM data payloads must be string-to-string maps. Numbers/booleans in
// the source object get stringified here so callers can pass normal JS
// values. null/undefined values are dropped instead of being sent as
// "null"/"undefined".
function stringifyValues(obj) {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, String(v)])
  );
}

// Clears a dead FCM token so future dispatches don't keep paying for it.
async function clearStaleFcmToken(providerId) {
  try {
    await supabase.from('users').update({ fcm_token: null }).eq('id', providerId);
  } catch (clearErr) {
    console.error('❌ Failed to clear stale FCM token:', clearErr.message);
  }
}

// Reliable wake-up path for a direct job assignment. Fires even if the
// provider's app is backgrounded or killed, which the socket emit in
// assignRequest() cannot reach. Never throws: dispatch must not fail because
// a push send failed.
//
// Every exit path logs, so the terminal tells you whether a push was sent,
// skipped (and why), or rejected by Firebase.
async function sendJobRequestPush(providerId, payload) {
  try {
    const { data: row, error } = await supabase
      .from('users')
      .select('fcm_token')
      .eq('id', providerId)
      .single();

    if (error) {
      console.error(`❌ Push: token lookup failed for provider ${providerId}:`, error.message);
      return;
    }
    if (!row?.fcm_token) {
      console.warn(
        `⚠️ Push skipped: provider ${providerId} has no fcm_token in users. ` +
          'The app never registered one (check POST /providers/:id/fcm-token).'
      );
      return;
    }

    // A job offer is worthless after the assignment window, so don't let FCM
    // deliver it late (e.g. phone offline for 5 minutes).
    const ttlMs = (Number(payload.expiresIn) || ASSIGNMENT_TIMEOUT) * 1000;

    const messageId = await admin.messaging().send({
      token: row.fcm_token,
      android: {
        priority: 'high', // required for timely delivery through Doze
        ttl: ttlMs,
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { contentAvailable: true } },
      },
      // Data-only, no `notification` key. The client (PushNotificationService)
      // fully controls rendering so it can dedupe against an already-open
      // socket delivery.
      //
      // `type` is set LAST so a payload key called `type` can never overwrite
      // the message kind. The service type travels as `serviceType`/`jobType`.
      data: { ...stringifyValues(payload), type: 'job_request' },
    });

    console.log(`📲 Job push sent to provider ${providerId} (${messageId})`);
  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered') {
      console.warn(`⚠️ Push: token for provider ${providerId} is no longer valid, clearing it.`);
      await clearStaleFcmToken(providerId);
    } else {
      // err.code tells you what Firebase objected to, e.g.
      // messaging/invalid-argument, messaging/third-party-auth-error,
      // app/invalid-credential (service account misconfigured).
      console.error(`❌ Push send error for provider ${providerId}:`, err.code, err.message);
    }
  }
}

// SMS fallback for a direct job assignment. Works when the app has no data
// connection and neither the socket nor FCM can reach the phone. Never
// throws: dispatch must not fail because an SMS failed.
async function sendJobRequestSMS(providerId, request) {
  try {
    const { data: row, error } = await supabase
      .from('users')
      .select('phone')
      .eq('id', providerId)
      .single();

    if (error) {
      console.error(`❌ SMS: phone lookup failed for provider ${providerId}:`, error.message);
      return;
    }
    if (!row?.phone) {
      console.warn(`⚠️ SMS skipped: provider ${providerId} has no phone number.`);
      return;
    }

    await sendSMS(
      [row.phone],
      buildJobRequestMessage(request.type, request.address, ASSIGNMENT_TIMEOUT, request.id)
    );
    console.log(`💬 Job SMS sent to provider ${providerId}`);
  } catch (err) {
    // sendSMS already logs the HostPinnacle error; just make sure dispatch survives.
    console.error(`❌ Job SMS failed for provider ${providerId}:`, err.message);
  }
}

// Reliable wake-up path for a customer-initiated cancellation. Same safety
// guarantees as sendJobRequestPush (never throws). Matters most when the
// request was already accepted and the provider is mid-drive with the app
// backgrounded.
async function sendJobCancelledPush(providerId, requestId) {
  try {
    const { data: row, error } = await supabase
      .from('users')
      .select('fcm_token')
      .eq('id', providerId)
      .single();

    if (error) {
      console.error(`❌ Cancel push: token lookup failed for provider ${providerId}:`, error.message);
      return;
    }
    if (!row?.fcm_token) {
      console.warn(`⚠️ Cancel push skipped: provider ${providerId} has no fcm_token.`);
      return;
    }

    const messageId = await admin.messaging().send({
      token: row.fcm_token,
      android: {
        priority: 'high',
        ttl: 5 * 60 * 1000,
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { contentAvailable: true } },
      },
      data: { requestId: String(requestId), type: 'job_cancelled' },
    });

    console.log(`📲 Cancel push sent to provider ${providerId} (${messageId})`);
  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered') {
      console.warn(`⚠️ Push: token for provider ${providerId} is no longer valid, clearing it.`);
      await clearStaleFcmToken(providerId);
    } else {
      console.error(`❌ Cancel push send error for provider ${providerId}:`, err.code, err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compare-and-swap update on a request. It only applies if the request is still
// open AND still held by the provider we read it with (or still unassigned).
// If two things race (decline + timeout, double decline, two instances), only
// one update matches and the other gets `false`, so a request can never be
// handed to two providers at once.
// ─────────────────────────────────────────────────────────────────────────────
async function casUpdate(requestId, previousProviderId, patch) {
  let query = supabase
    .from('service_requests')
    .update(patch)
    .eq('id', requestId)
    .in('status', OPEN_STATUSES);

  query = previousProviderId
    ? query.eq('current_provider_id', previousProviderId)
    : query.is('current_provider_id', null);

  const { data, error } = await query.select('id').maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

async function assignRequest(requestId, io) {
  try {
    const { data: request, error: reqError } = await supabase
      .from('service_requests')
      .select('*')
      .eq('id', requestId)
      .single();

    if (reqError || !request) {
      console.error('❌ Request not found:', requestId);
      return;
    }

    // Never re-dispatch something that's already accepted, completed, cancelled, etc.
    if (!OPEN_STATUSES.includes(request.status)) {
      console.log(`ℹ️ Request ${requestId} is "${request.status}", not dispatching.`);
      return;
    }

    if (request.latitude == null || request.longitude == null) {
      console.warn(`⚠️ Request ${requestId} has no coordinates, cannot dispatch.`);
      return;
    }

    // Every provider ever assigned is appended to assigned_provider_ids, so
    // a provider who declined or timed out is excluded from re-assignment.
    // Matching is always nearest-first, among providers who offer the
    // requested option/variant (when the request has one).
    const alreadyTried = request.assigned_provider_ids || [];

    const provider = await findNearestProvider(
      request.latitude,
      request.longitude,
      request.type,
      alreadyTried,
      {
        optionId: request.service_option_id,
        variantId: request.variant_id,
      }
    );

    if (!provider) {
      console.log('⚠️ No providers available for request:', requestId);

      // Also release the previous provider. acceptRequest() only lets the
      // request be claimed from the open pool when current_provider_id is null
      // (or the claimer themselves), so leaving the last timed-out provider on
      // the row would lock everyone else out of the pool.
      const closed = await casUpdate(requestId, request.current_provider_id, {
        status: 'no_providers',
        current_provider_id: null,
        assignment_expires_at: null,
      });
      if (!closed) return; // something else already moved this request on

      if (request.user_id) {
        io.to(request.user_id).emit('no_providers', {
          requestId,
          message: 'No providers available nearby. Please try again.',
        });
      }
      return;
    }

    // Assign provider to request (atomically)
    const expiresAt = new Date(Date.now() + ASSIGNMENT_TIMEOUT * 1000);

    const claimed = await casUpdate(requestId, request.current_provider_id, {
      current_provider_id: provider.id,
      status: 'assigned',
      assignment_expires_at: expiresAt.toISOString(),
      assigned_provider_ids: [...alreadyTried, provider.id],
    });

    if (!claimed) {
      console.log(`ℹ️ Request ${requestId} changed while dispatching, skipping this assignment.`);
      return;
    }

    const distanceLabel = provider.distance_km != null ? ` (${provider.distance_km.toFixed(1)} km away)` : '';
    console.log(`✅ Request ${requestId} assigned to provider ${provider.full_name}${distanceLabel}`);

    // What the provider needs to bring, e.g. "Total 13kg x 1". Looked up after
    // the claim so the 90-second window and the CAS are never held up by it.
    const orderSummary = await loadOrderSummary(request);

    // Instant if the provider's app is open and the socket is connected.
    io.to(`provider_${provider.id}`).emit('job_request', {
      requestId,
      type: request.type,
      address: request.address,
      latitude: request.latitude,
      longitude: request.longitude,
      eta: request.eta_minutes,
      expiresIn: ASSIGNMENT_TIMEOUT,
      orderSummary,
    });

    // Reliable wake-up path, fire-and-forget so a push failure never blocks
    // or delays dispatch (sendJobRequestPush never throws).
    // jobType is what the app reads for the notification title.
    // stringifyValues drops orderSummary when it is null.
    sendJobRequestPush(provider.id, {
      requestId,
      serviceType: request.type,
      jobType: request.type,
      address: request.address,
      expiresIn: ASSIGNMENT_TIMEOUT,
      orderSummary,
    });

    // SMS fallback, also fire-and-forget (sendJobRequestSMS never throws).
    sendJobRequestSMS(provider.id, { ...request, id: requestId });

    // If the provider doesn't respond in time, escalate to the next one.
    // The sweeper below is the safety net if the server restarts before this fires.
    setTimeout(() => expireAssignment(requestId, provider.id, io), ASSIGNMENT_TIMEOUT * 1000);
  } catch (err) {
    console.error('❌ Assignment error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// expireAssignment
// Escalates a request to the next provider, but only if it is STILL assigned to
// the provider whose window expired. Without that check, a stale timer (for
// example from a provider who declined) would escalate a request that has
// already moved on to someone else and cut their 90 seconds short.
// Safe to call from both the timer and the sweeper: assignRequest is CAS-guarded.
// ─────────────────────────────────────────────────────────────────────────────
async function expireAssignment(requestId, providerId, io) {
  try {
    const { data: current, error } = await supabase
      .from('service_requests')
      .select('status, current_provider_id')
      .eq('id', requestId)
      .maybeSingle();

    if (error) {
      console.error('❌ Expiry check error:', error.message);
      return;
    }

    if (!current || current.status !== 'assigned' || current.current_provider_id !== providerId) {
      return; // accepted, declined and moved on, completed, cancelled, or reassigned
    }

    console.log(`⏰ Provider ${providerId} didn't respond to request ${requestId}, escalating...`);

    io.to(`provider_${providerId}`).emit('job_expired', { requestId });

    await assignRequest(requestId, io);
  } catch (err) {
    console.error('❌ Expire assignment error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// startAssignmentSweeper
// setTimeout lives in memory, so a restart or deploy would leave requests stuck
// in "assigned" forever. Call this once from server.js after io is created:
//   const { startAssignmentSweeper } = require('./services/dispatch');
//   startAssignmentSweeper(io);
// It also runs immediately to catch anything left over from before a restart.
//
// Each tick also runs checkTrackingHealth(), which tells the customer and the
// provider when an en_route job stops receiving location pings.
// ─────────────────────────────────────────────────────────────────────────────
function startAssignmentSweeper(io, intervalMs = SWEEP_INTERVAL_MS) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { data, error } = await supabase
        .from('service_requests')
        .select('id, current_provider_id')
        .eq('status', 'assigned')
        .lt('assignment_expires_at', new Date().toISOString())
        .limit(50);

      if (error) {
        console.error('❌ Sweeper query error:', error.message);
      } else {
        for (const r of data || []) {
          await expireAssignment(r.id, r.current_provider_id, io);
        }
      }

      // Independent of the expiry query above: a failure there must not stop
      // tracking alerts. checkTrackingHealth never throws.
      await checkTrackingHealth(io);
    } catch (err) {
      console.error('❌ Sweeper error:', err.message);
    } finally {
      running = false;
    }
  };

  tick();
  return setInterval(tick, intervalMs);
}

async function acceptRequest(requestId, providerId, io) {
  try {
    // providerId is interpolated into a PostgREST .or() filter below, so it must
    // be a plain UUID. Anything else could inject extra filter conditions.
    if (!UUID_RE.test(String(providerId))) {
      return { success: false, error: 'Invalid provider' };
    }

    const { data: provider, error: providerLookupError } = await supabase
      .from('users')
      .select('id, full_name, phone, user_type')
      .eq('id', providerId)
      .single();

    if (providerLookupError || !provider || provider.user_type !== 'provider') {
      return { success: false, error: 'Provider not found' };
    }

    const { data: reqRow } = await supabase
      .from('service_requests')
      .select('excluded_provider_ids, service_option_id, variant_id')
      .eq('id', requestId)
      .maybeSingle();

    // A provider the customer cancelled on must not claim the retry, whether
    // through targeted dispatch or the open claim pool. Same message as a
    // taken job, so the provider just sees it as gone.
    if ((reqRow?.excluded_provider_ids || []).map(String).includes(String(providerId))) {
      return { success: false, error: 'Request is no longer available' };
    }

    // The open claim pool must respect what was asked for too: a provider who
    // only sells kerosene cannot take an LPG request. Targeted dispatch has
    // already matched on offerings, so this only ever rejects pool claims.
    if (!(await providerOffers(providerId, reqRow?.service_option_id, reqRow?.variant_id))) {
      return { success: false, error: 'You do not offer the item this customer asked for.' };
    }

    // Atomic claim: this single UPDATE is what makes it race-safe. It
    // succeeds in three cases:
    //   1. Normal dispatch flow: the request was already assigned to this
    //      exact provider (current_provider_id = providerId).
    //   2. Live/broadcast request (never assigned, current_provider_id null):
    //      first provider to accept claims it.
    //   3. Open nearby-claim pool: status 'no_providers'. assignRequest()
    //      now nulls current_provider_id when it moves a request here, so
    //      this is the same null-provider race as case 2: first accept wins.
    // The status filter stops a completed, cancelled, or already-accepted
    // request from being "accepted" again.
    const { data: updated, error: updateError } = await supabase
      .from('service_requests')
      .update({
        status: 'accepted',
        current_provider_id: providerId,
        provider_name: provider.full_name,
      })
      .eq('id', requestId)
      .in('status', CLAIMABLE_STATUSES)
      .or(`current_provider_id.eq.${providerId},current_provider_id.is.null`)
      .select()
      .maybeSingle();

    if (updateError) {
      console.error('❌ Accept update error:', updateError.message);
      return { success: false, error: updateError.message };
    }

    if (!updated) {
      return { success: false, error: 'Request is no longer available' };
    }

    // The provider's tracked job just changed: drop any cached "no active
    // request" so the very next ping reaches the customer.
    activeRequestCache.delete(String(providerId));

    console.log(`✅ Request ${requestId} accepted by ${provider.full_name}`);

    if (updated.user_id) {
      io.to(updated.user_id).emit('job_accepted', {
        requestId,
        providerName: provider.full_name,
        providerPhone: provider.phone,
        eta: updated.eta_minutes,
        distanceKm: updated.distance_km,
      });
    }

    return { success: true };
  } catch (err) {
    console.error('❌ Accept error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Live location helpers
// ─────────────────────────────────────────────────────────────────────────────

// Postgres `timestamp` (no tz) comes back without a trailing Z; treat
// offset-less strings as UTC. Harmless once last_ping_at is timestamptz.
function parseAsUtc(raw) {
  if (!raw) return null;
  const hasOffset = /[zZ]|[+-]\d{2}:\d{2}$/.test(raw);
  const ms = new Date(hasOffset ? raw : `${raw}Z`).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// Phone clocks drift. Accept recordedAt only if it is sane, otherwise "now".
function sanitizeRecordedAt(raw) {
  const now = Date.now();
  const t = raw ? new Date(raw).getTime() : NaN;
  if (!Number.isFinite(t) || t > now || now - t > MAX_FIX_AGE_MS) return new Date(now);
  return new Date(t);
}

function optionalNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function validCoords(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

// The request (if any) this provider is currently being tracked on. Cached
// briefly. Returns undefined when the lookup failed (nothing cached).
async function getActiveRequest(providerId) {
  const cached = activeRequestCache.get(providerId);
  if (cached && cached.expiresAt > Date.now()) return cached.request;

  // .limit(1) instead of .maybeSingle(): maybeSingle errors if a provider
  // ever has more than one matching row.
  const { data, error } = await supabase
    .from('service_requests')
    .select('id, user_id')
    .eq('current_provider_id', providerId)
    .in('status', TRACKED_STATUSES)
    .limit(1);

  if (error) {
    console.error('❌ Active request lookup error (location update):', error.message);
    return undefined;
  }

  const request = data && data[0] ? data[0] : null;
  activeRequestCache.set(providerId, {
    request,
    expiresAt: Date.now() + ACTIVE_CACHE_TTL_MS,
  });
  return request;
}

// ─────────────────────────────────────────────────────────────────────────────
// updateProviderHeartbeat
// Lightweight "I'm alive and here" ping. Persists position + last_ping_at only,
// with no request lookup and no customer broadcast, so it's cheap enough to
// call every 30-60s from an idle-but-online provider. This is what keeps
// last_ping_at fresh so the MAX_PING_AGE_SECONDS filter doesn't exclude
// providers who are simply waiting for work.
//
// Wire it in server.js:
//   socket.on('provider_heartbeat', ({ providerId, latitude, longitude }) =>
//     updateProviderHeartbeat(providerId, latitude, longitude));
//
// Returns true if the write succeeded.
// ─────────────────────────────────────────────────────────────────────────────
async function updateProviderHeartbeat(providerId, latitude, longitude) {
  try {
    if (!providerId || !UUID_RE.test(String(providerId))) return false;

    const patch = { last_ping_at: new Date().toISOString() };

    const lat = Number(latitude);
    const lng = Number(longitude);
    if (latitude != null && longitude != null && validCoords(lat, lng)) {
      patch.current_latitude = lat;
      patch.current_longitude = lng;
    }

    const { error } = await supabase
      .from('users')
      .update(patch)
      .eq('id', providerId)
      .eq('user_type', 'provider');

    if (error) {
      console.error('❌ Provider heartbeat persist error:', error.message);
      return false;
    }

    if (process.env.DISPATCH_DEBUG === 'true') {
      console.log(`📡 heartbeat from provider ${providerId}`);
    }
    return true;
  } catch (err) {
    console.error('❌ Provider heartbeat error:', err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// updateProviderLocation
// Called from POST /providers/:id/location (the foreground-service isolate,
// which only speaks HTTP) AND from server.js's 'provider_location' socket
// handler. Both paths land here, so the customer always gets the instant
// socket push no matter how the ping arrived.
//
//   extra = { speed, heading, accuracy, recordedAt }  (all optional)
//
// Order guard: the position only moves FORWARD in time, using the phone's fix
// timestamp (recordedAt). A slow request that lands after a newer one matches
// no row and is dropped, so the customer's marker never jumps backwards. The
// provider still counts as alive because the newer fix already refreshed
// last_ping_at.
//
// Returns true when the ping was handled (including "ignored: older than what
// we have") and false on a real failure, so the HTTP route can answer 500 and
// the phone's error counter climbs.
//
// Uses .toISOString() (always UTC, suffixed with Z), so it can't reintroduce
// the naive-timestamp parsing bug fixed in GET /requests/:id/provider-location.
//
// Requires users.last_fix_at (timestamptz), current_speed, current_heading and
// current_accuracy (double precision). See the migration in
// backend_live_tracking_patch.md.
// ─────────────────────────────────────────────────────────────────────────────
async function updateProviderLocation(providerId, latitude, longitude, io, extra = {}) {
  try {
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!providerId || !UUID_RE.test(String(providerId)) || !validCoords(lat, lng)) {
      return false;
    }

    const recordedAt = sanitizeRecordedAt(extra.recordedAt);
    const speed = optionalNumber(extra.speed);
    const heading = optionalNumber(extra.heading);
    const accuracy = optionalNumber(extra.accuracy);

    if (process.env.DISPATCH_DEBUG === 'true') {
      console.log(`📡 location ping from provider ${providerId}`);
    }

    const { data: written, error: persistError } = await supabase
      .from('users')
      .update({
        current_latitude: lat,
        current_longitude: lng,
        current_speed: speed,
        current_heading: heading,
        current_accuracy: accuracy,
        last_fix_at: recordedAt.toISOString(),
        last_ping_at: new Date().toISOString(),
      })
      .eq('id', providerId)
      .eq('user_type', 'provider')
      .or(`last_fix_at.is.null,last_fix_at.lt.${recordedAt.toISOString()}`)
      .select('id');

    if (persistError) {
      // Don't bail on the broadcast below just because the write failed. The
      // customer can still get an instant socket update for this tick.
      console.error('❌ Provider location persist error:', persistError.message);
    } else if (!written || written.length === 0) {
      return true; // older than what we have, or not a provider: nothing to broadcast
    }

    const active = await getActiveRequest(String(providerId));
    if (active?.user_id && io) {
      io.to(active.user_id).emit('provider_location', {
        requestId: active.id,
        latitude: lat,
        longitude: lng,
        speed,
        heading,
        accuracy,
        recordedAt: recordedAt.toISOString(),
      });
      // Live again: allow a future outage to alert.
      lostNotified.delete(active.id);
    }

    return !persistError;
  } catch (err) {
    console.error('❌ Provider location update error:', err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracking-lost alerts
// ─────────────────────────────────────────────────────────────────────────────

// Wake-up push to the provider's phone when their location stops arriving
// mid-job. The app should handle FCM `type: 'tracking_lost'` by showing a
// notification such as "Location sharing stopped. Tap to reopen." Never throws.
async function sendTrackingLostPush(providerId, requestId) {
  try {
    const { data: row, error } = await supabase
      .from('users')
      .select('fcm_token')
      .eq('id', providerId)
      .single();

    if (error) {
      console.error(`❌ Tracking-lost push: token lookup failed for provider ${providerId}:`, error.message);
      return;
    }
    if (!row?.fcm_token) {
      console.warn(`⚠️ Tracking-lost push skipped: provider ${providerId} has no fcm_token.`);
      return;
    }

    await admin.messaging().send({
      token: row.fcm_token,
      android: { priority: 'high', ttl: 2 * 60 * 1000 },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { contentAvailable: true } },
      },
      data: { requestId: String(requestId), type: 'tracking_lost' },
    });

    console.log(`📲 Tracking-lost push sent to provider ${providerId}`);
  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered') {
      console.warn(`⚠️ Push: token for provider ${providerId} is no longer valid, clearing it.`);
      await clearStaleFcmToken(providerId);
    } else {
      console.error(`❌ Tracking-lost push error for provider ${providerId}:`, err.code, err.message);
    }
  }
}

// Sweeper pass: for every en_route job whose provider has not pinged for
// TRACKING_LOST_AFTER_MS, tell the customer (socket `provider_location_lost`)
// and the provider (push) ONCE per outage. Never throws.
async function checkTrackingHealth(io) {
  try {
    const { data: jobs, error } = await supabase
      .from('service_requests')
      .select('id, user_id, current_provider_id')
      .eq('status', 'en_route')
      .not('current_provider_id', 'is', null)
      .limit(100);

    if (error) {
      console.error('❌ Tracking health query error:', error.message);
      return;
    }

    // Forget jobs that are no longer en_route so the set can't grow forever.
    const live = new Set((jobs || []).map((j) => j.id));
    for (const id of lostNotified) if (!live.has(id)) lostNotified.delete(id);
    if (!jobs || jobs.length === 0) return;

    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, last_ping_at')
      .in('id', jobs.map((j) => j.current_provider_id));

    if (usersError) {
      console.error('❌ Tracking health users error:', usersError.message);
      return;
    }
    const pingById = new Map((users || []).map((u) => [u.id, u.last_ping_at]));

    for (const job of jobs) {
      const pingMs = parseAsUtc(pingById.get(job.current_provider_id));
      const ageMs = pingMs == null ? null : Date.now() - pingMs;
      const lost = ageMs == null || ageMs > TRACKING_LOST_AFTER_MS;

      if (!lost) {
        lostNotified.delete(job.id);
        continue;
      }
      if (lostNotified.has(job.id)) continue; // already alerted this outage
      lostNotified.add(job.id);

      console.warn(`⚠️ Tracking lost for request ${job.id} (provider ${job.current_provider_id})`);

      if (job.user_id && io) {
        io.to(job.user_id).emit('provider_location_lost', {
          requestId: job.id,
          lastSeenSecondsAgo: ageMs == null ? null : Math.round(ageMs / 1000),
        });
      }
      sendTrackingLostPush(job.current_provider_id, job.id); // fire-and-forget
    }
  } catch (err) {
    console.error('❌ Tracking health error:', err.message);
  }
}

module.exports = {
  assignRequest,
  acceptRequest,
  expireAssignment,
  startAssignmentSweeper,
  findNearestProvider,
  updateProviderLocation,
  updateProviderHeartbeat,
  checkTrackingHealth,
  sendJobRequestPush,
  sendJobRequestSMS,
  sendJobCancelledPush,
  sendTrackingLostPush,
};