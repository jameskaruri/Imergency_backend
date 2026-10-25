// ─────────────────────────────────────────────────────────────────────────────
// Paste into routes/requests.js, above the "Helpers" section.
// Requires the request_ratings table (request_ratings.sql).
// ─────────────────────────────────────────────────────────────────────────────

// Must match _positiveTags / _negativeTags in rate_provider_screen.dart.
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
// customer who made the request (the app doesn't send it today — add it to the
// client body, or put real auth in front of this route, since otherwise anyone
// with a request id could rate it).
//
// providers.rating is recalculated by the trigger on request_ratings.
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
// Optional: let the app know if a job is already rated, so the rating screen
// isn't shown twice. Add `rated` to GET /requests/status/:id, e.g.:
//
//   const { data: ratingRow } = await supabase
//     .from('request_ratings').select('id').eq('request_id', data.id).maybeSingle();
//   ...res.json({ ...rest, rated: !!ratingRow, ... });
// ─────────────────────────────────────────────────────────────────────────────
