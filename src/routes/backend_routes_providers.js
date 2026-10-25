// ─────────────────────────────────────────────────────────────────────────
// Add this to your EXISTING routes/providers.js (the one that already has
// POST /:id/location) — this is an addition, not a new router.
//
// GET /providers/nearby?type=mechanic&lat=-1.286&lng=36.817&radius=15
//
// Reuses the same find_nearest_provider() RPC that dispatch.js's
// findNearestProvider() calls, so "who's nearby" in the UI matches "who
// dispatch would actually pick" — no separate/guessed matching logic to
// drift out of sync. We just don't slice to data[0] like dispatch does;
// we keep the whole ordered list for the preview.
// ─────────────────────────────────────────────────────────────────────────

const { supabase } = require('../services/supabase');

const DEFAULT_RADIUS_KM = 15;
const MAX_RESULTS = 20;
const AVG_SPEED_KMH = 28; // rough urban average, for a *display-only* ETA estimate

router.get('/nearby', async (req, res) => {
  const { type } = req.query;
  const latitude = Number(req.query.lat);
  const longitude = Number(req.query.lng);
  const radiusKm = Number(req.query.radius) > 0 ? Number(req.query.radius) : DEFAULT_RADIUS_KM;

  if (!type) {
    return res.status(400).json({ error: 'type is required' });
  }
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return res.status(400).json({ error: 'Valid lat and lng are required' });
  }

  try {
    // Same RPC dispatch.js uses — ordered by distance, already filtered to
    // online + approved-for-this-service providers.
    const { data: ranked, error: rpcError } = await supabase.rpc('find_nearest_provider', {
      request_lat: latitude,
      request_lng: longitude,
      service_type: type,
      excluded_ids: [],
    });

    if (rpcError) {
      console.error('❌ Nearby providers RPC error:', rpcError.message);
      return res.status(500).json({ error: 'Failed to fetch nearby providers', detail: rpcError.message });
    }

    const withinRadius = (ranked || []).filter(
      (p) => p.distance_km === null || p.distance_km === undefined || p.distance_km <= radiusKm
    );

    // ⚠️ CHECK THIS: I don't know exactly which columns find_nearest_provider
    // returns beyond id, full_name and distance_km (those are the only ones
    // dispatch.js reads off it). If it already includes current_latitude/
    // current_longitude/rating/vehicle info, delete this extra lookup and
    // map `ranked` directly below — it'll be faster with one fewer query.
    const ids = withinRadius.map((p) => p.id);
    let detailsById = {};
    if (ids.length > 0) {
      const { data: details, error: detailsError } = await supabase
        .from('users')
        .select('id, current_latitude, current_longitude, rating, vehicle_make, vehicle_model, avatar_url')
        .in('id', ids);

      if (detailsError) {
        console.error('❌ Provider details lookup error:', detailsError.message);
        // Non-fatal — fall back to whatever the RPC gave us.
      } else {
        detailsById = Object.fromEntries((details || []).map((d) => [d.id, d]));
      }
    }

    const result = withinRadius.slice(0, MAX_RESULTS).map((p) => {
      const extra = detailsById[p.id] || {};
      const distanceKm = p.distance_km ?? null;
      return {
        id: p.id,
        name: p.full_name || 'Provider',
        latitude: extra.current_latitude ?? p.current_latitude ?? null,
        longitude: extra.current_longitude ?? p.current_longitude ?? null,
        distanceKm,
        etaMinutes:
          distanceKm !== null
            ? Math.max(3, Math.round((distanceKm / AVG_SPEED_KMH) * 60))
            : null,
        rating: extra.rating ?? null,
        vehicleInfo: [extra.vehicle_make, extra.vehicle_model].filter(Boolean).join(' ') || null,
        avatarUrl: extra.avatar_url ?? null,
      };
    });

    res.json({ success: true, data: result, count: result.length });
  } catch (err) {
    console.error('❌ Nearby providers error:', err.message);
    res.status(500).json({ error: 'Failed to fetch nearby providers' });
  }
});
