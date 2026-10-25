const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');

const DOCUMENTS_BUCKET = 'provider-documents';
const SIGNED_URL_TTL_SECONDS = 60 * 10; // detail page: long enough to view/download
const PHOTO_URL_TTL_SECONDS = 60 * 60; // list page may stay open a while

// Profile photo rule (same as GET /providers/profile/:userId):
// individuals -> latest passport_photo, businesses -> first premises_photos.
const PROFILE_PHOTO_DOC_TYPE = {
  individual: 'passport_photo',
  business: 'premises_photos',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]{1,100}$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// 'john   mwangi' / 'JOHN MWANGI' -> 'John Mwangi'
// (This was missing, which crashed GET /providers/:id for any provider that
// has a referral.)
const titleCase = (s = '') =>
  String(s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());

// Log the full error (with stack) so the next failure points at a line.
function fail(res, label, err, message, status = 500) {
  console.error(`${label}:`, err?.stack || err?.message || err);
  return res.status(status).json({ error: message });
}

// Fire-and-forget audit log. A logging failure must never block the actual
// admin action, so errors here are logged and swallowed.
async function logAdminAction(adminId, action, targetTable, targetId, notes = null) {
  try {
    const { error } = await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action,
      target_table: targetTable,
      target_id: String(targetId),
      notes,
    });
    if (error) console.error('Failed to record admin action (non-fatal):', error.message);
  } catch (err) {
    console.error('Failed to record admin action (non-fatal):', err.message);
  }
}

// Validate :id before it reaches Postgres.
//  - GET requests may use a UUID or a provider slug (GET /providers/:id).
//  - Everything else (approve / reject / reopen, documents) must be a UUID.
router.param('id', (req, res, next, id) => {
  const ok = req.method === 'GET' ? SLUG_RE.test(id) : UUID_RE.test(id);
  return ok ? next() : res.status(400).json({ error: 'Invalid id' });
});

// Shared by approve / reject / reopen: sets providers.status and cascades the
// same status to provider_services, then writes the audit log.
async function setProviderStatus(req, res, { status, action, notes = null, label, errorMessage }) {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('providers')
      .update({ status })
      .eq('user_id', id)
      .select()
      .maybeSingle();

    if (error) return fail(res, label, error, errorMessage);
    if (!data) return res.status(404).json({ error: 'Provider not found' });

    const { error: servicesError } = await supabase
      .from('provider_services')
      .update({ status })
      .eq('provider_id', id);
    if (servicesError) {
      console.error(`${label} (provider_services update):`, servicesError.message);
    }

    await logAdminAction(req.admin.id, action, 'providers', id, notes);

    res.json({ success: true, provider: data });
  } catch (err) {
    return fail(res, label, err, errorMessage);
  }
}

// Shared by per-service approve / reject. Reviews ONE service a provider
// added after registration, without touching the provider's overall status
// or its other services.
async function setServiceStatus(req, res, { status, action, label, errorMessage }) {
  const { id, serviceKey } = req.params;

  try {
    const { data: service, error: serviceError } = await supabase
      .from('services')
      .select('id')
      .eq('key', serviceKey)
      .maybeSingle();

    if (serviceError) return fail(res, label, serviceError, errorMessage);
    if (!service) return res.status(404).json({ error: 'Service not found' });

    const { data, error } = await supabase
      .from('provider_services')
      .update({ status })
      .eq('provider_id', id)
      .eq('service_id', service.id)
      .select('service_id')
      .maybeSingle();

    if (error) return fail(res, label, error, errorMessage);
    if (!data) return res.status(404).json({ error: 'Provider does not offer this service' });

    await logAdminAction(req.admin.id, action, 'provider_services', `${id}:${serviceKey}`);

    res.json({ success: true, status });
  } catch (err) {
    return fail(res, label, err, errorMessage);
  }
}

// Shared by panic alert acknowledge / resolve. `from` lists the statuses an
// alert may move out of, so a stale click (someone else already handled it)
// returns 409 instead of silently overwriting.
async function setPanicStatus(req, res, { status, from, action, stamp, label, errorMessage }) {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('panic_alerts')
      .update({
        status,
        [`${stamp}_at`]: new Date().toISOString(),
        [`${stamp}_by`]: req.admin.id,
      })
      .eq('id', id)
      .in('status', from)
      .select()
      .maybeSingle();

    if (error) return fail(res, label, error, errorMessage);

    if (!data) {
      // Either it doesn't exist or it's already past this step.
      const { data: existing } = await supabase
        .from('panic_alerts')
        .select('id, status')
        .eq('id', id)
        .maybeSingle();
      if (!existing) return res.status(404).json({ error: 'Alert not found' });
      return res.status(409).json({ error: `Alert is already ${existing.status}` });
    }

    await logAdminAction(req.admin.id, action, 'panic_alerts', id);
    res.json({ success: true, alert: data });
  } catch (err) {
    return fail(res, label, err, errorMessage);
  }
}

// Shared by document approve / reject.
async function setDocumentStatus(req, res, { status, action, notes = null, label, errorMessage }) {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('provider_documents')
      .update({ status })
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) return fail(res, label, error, errorMessage);
    if (!data) return res.status(404).json({ error: 'Document not found' });

    await logAdminAction(req.admin.id, action, 'provider_documents', id, notes);
    res.json({ success: true, document: data });
  } catch (err) {
    return fail(res, label, err, errorMessage);
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

// GET /admin/providers?status=pending
router.get('/providers', async (req, res) => {
  const status = req.query.status || 'pending';

  try {
    const { data, error } = await supabase
      .from('providers')
      .select(`
        user_id,
        slug,
        email,
        provider_type,
        business_name,
        area_of_operation,
        vehicle_info,
        location,
        status,
        service_type,
        rating,
        created_at,
        rejection_reason,
        user:users!providers_user_id_fkey ( full_name, phone, is_online, last_ping_at )
      `)
      .eq('status', status)
      .order('created_at', { ascending: true });

    if (error) return fail(res, 'Admin providers list error', error, 'Failed to fetch providers');

    res.json({ providers: data || [] });
  } catch (err) {
    return fail(res, 'Admin providers list error', err, 'Failed to fetch providers');
  }
});

// POST /admin/providers/profile-photos  { userIds: string[] }  (max 100)
// -> { photos: { [userId]: signedUrl | null } }
// Declared before the /providers/:id routes for clarity (different method,
// so no actual clash with GET /providers/:id).
router.post('/providers/profile-photos', async (req, res) => {
  const userIds = Array.isArray(req.body?.userIds)
    ? [...new Set(req.body.userIds.filter((id) => typeof id === 'string' && UUID_RE.test(id)))].slice(0, 100)
    : [];

  if (userIds.length === 0) return res.json({ photos: {} });

  try {
    const { data: providerRows, error: providerError } = await supabase
      .from('providers')
      .select('user_id, provider_type')
      .in('user_id', userIds);

    if (providerError) {
      return fail(res, 'Admin photos provider lookup error', providerError, 'Failed to load providers');
    }

    const typeById = Object.fromEntries(
      (providerRows || []).map((p) => [p.user_id, p.provider_type]),
    );

    const { data: docs, error: docsError } = await supabase
      .from('provider_documents')
      .select('provider_id, document_type, storage_path')
      .in('provider_id', userIds)
      .in('document_type', Object.values(PROFILE_PHOTO_DOC_TYPE))
      .order('uploaded_at', { ascending: true });

    if (docsError) {
      return fail(res, 'Admin photos docs lookup error', docsError, 'Failed to load documents');
    }

    const pathById = {};
    for (const d of docs || []) {
      const isBusiness = typeById[d.provider_id] === 'business';
      const wanted = PROFILE_PHOTO_DOC_TYPE[isBusiness ? 'business' : 'individual'];
      if (d.document_type !== wanted) continue;
      // Ascending: businesses keep the first; individuals end on the latest.
      if (isBusiness && pathById[d.provider_id]) continue;
      pathById[d.provider_id] = d.storage_path;
    }

    const paths = [...new Set(Object.values(pathById))];
    const urlByPath = {};
    if (paths.length) {
      const { data: signed, error: signError } = await supabase.storage
        .from(DOCUMENTS_BUCKET)
        .createSignedUrls(paths, PHOTO_URL_TTL_SECONDS);
      if (signError) {
        console.error('Admin photos sign error:', signError.message);
      } else {
        for (const s of signed || []) if (s.signedUrl) urlByPath[s.path] = s.signedUrl;
      }
    }

    const photos = {};
    for (const id of userIds) photos[id] = urlByPath[pathById[id]] ?? null;
    res.json({ photos });
  } catch (err) {
    return fail(res, 'Admin photos route error', err, 'Failed to load photos');
  }
});

// GET /admin/providers/:id
// :id is either providers.user_id (UUID) or providers.slug (e.g. "john-mwangi").
router.get('/providers/:id', async (req, res) => {
  const { id } = req.params;
  const lookupColumn = UUID_RE.test(id) ? 'user_id' : 'slug';

  try {
    // `*` returns every column on providers, so newly added columns don't
    // need to be remembered here.
    const { data: provider, error: providerError } = await supabase
      .from('providers')
      .select(`
        *,
        user:users!providers_user_id_fkey ( full_name, phone, is_online, last_ping_at )
      `)
      .eq(lookupColumn, id)
      .maybeSingle();

    if (providerError) {
      return fail(res, 'Admin provider lookup error', providerError, 'Failed to fetch provider');
    }
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    // From here on always use the real UUID, whichever way we were looked up.
    const providerId = provider.user_id;

    // Services, documents and (optionally) the referral lookups are
    // independent, so run them in parallel.
    const staffId = provider.referred_by_staff_id;
    const [servicesRes, docsRes, roleRes, staffUserRes] = await Promise.all([
      supabase
        .from('provider_services')
        .select('status, services ( key, title, icon )')
        .eq('provider_id', providerId),
      supabase
        .from('provider_documents')
        .select('id, document_type, file_name, storage_path, mime_type, size_bytes, status, uploaded_at')
        .eq('provider_id', providerId)
        .order('uploaded_at', { ascending: true }),
      staffId
        ? supabase.from('staff_roles').select('code, full_name').eq('user_id', staffId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      staffId
        ? supabase.from('users').select('full_name').eq('id', staffId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (servicesRes.error) {
      console.error('Admin provider services error:', servicesRes.error.message);
    }
    if (docsRes.error) {
      return fail(res, 'Admin provider documents error', docsRes.error, 'Failed to fetch documents');
    }
    if (roleRes.error) console.error('Admin referral role lookup error:', roleRes.error.message);
    if (staffUserRes.error) console.error('Admin referral user lookup error:', staffUserRes.error.message);

    // Bucket is private (these are ID docs), so the dashboard gets
    // short-lived signed URLs instead of public ones. One batched call.
    const documents = docsRes.data || [];
    const urlByPath = {};
    if (documents.length) {
      const { data: signed, error: signError } = await supabase.storage
        .from(DOCUMENTS_BUCKET)
        .createSignedUrls(
          documents.map((d) => d.storage_path),
          SIGNED_URL_TTL_SECONDS,
        );
      if (signError) {
        console.error('Admin provider signed URLs error:', signError.message);
      } else {
        for (const s of signed || []) {
          if (s.signedUrl) urlByPath[s.path] = s.signedUrl;
          else if (s.error) console.error(`Signed URL error for ${s.path}:`, s.error);
        }
      }
    }
    const documentsWithUrls = documents.map((doc) => ({
      ...doc,
      url: urlByPath[doc.storage_path] ?? null,
    }));

    // Names live in staff_roles (same as the providers list page); fall back
    // to users for anyone without one. staff_roles wins.
    let referral = null;
    if (staffId) {
      const rawName = roleRes.data?.full_name || staffUserRes.data?.full_name || null;
      referral = {
        staffId,
        full_name: rawName ? titleCase(rawName) : null,
        code: roleRes.data?.code ?? null,
      };
    }

    res.json({
      provider,
      referral,
      services: (servicesRes.data || []).map((s) => ({
        key: s.services?.key,
        title: s.services?.title,
        status: s.status,
      })),
      documents: documentsWithUrls,
    });
  } catch (err) {
    return fail(res, 'Admin provider detail error', err, 'Failed to fetch provider');
  }
});

// PATCH /admin/providers/:id/approve
router.patch('/providers/:id/approve', (req, res) =>
  setProviderStatus(req, res, {
    status: 'approved',
    action: 'provider_approved',
    label: 'Admin approve provider error',
    errorMessage: 'Failed to approve provider',
  }),
);

// PATCH /admin/providers/:id/reject  { reason?: string }
router.patch('/providers/:id/reject', (req, res) => {
  const reason = String(req.body?.reason ?? '').trim() || null;
  return setProviderStatus(req, res, {
    status: 'rejected',
    action: 'provider_rejected',
    notes: reason,
    label: 'Admin reject provider error',
    errorMessage: 'Failed to reject provider',
  });
});

// PATCH /admin/providers/:id/reopen
// Resets a rejected provider's application back to `pending` so it can be
// reviewed again from scratch.
router.patch('/providers/:id/reopen', (req, res) =>
  setProviderStatus(req, res, {
    status: 'pending',
    action: 'provider_reopened',
    label: 'Admin reopen provider error',
    errorMessage: 'Failed to reopen provider',
  }),
);

// PATCH /admin/providers/:id/services/:serviceKey/approve
// Approves ONE service a provider added after registration.
router.patch('/providers/:id/services/:serviceKey/approve', (req, res) =>
  setServiceStatus(req, res, {
    status: 'approved',
    action: 'service_approved',
    label: 'Admin approve service error',
    errorMessage: 'Failed to approve service',
  }),
);

// PATCH /admin/providers/:id/services/:serviceKey/reject
router.patch('/providers/:id/services/:serviceKey/reject', (req, res) =>
  setServiceStatus(req, res, {
    status: 'rejected',
    action: 'service_rejected',
    label: 'Admin reject service error',
    errorMessage: 'Failed to reject service',
  }),
);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// PATCH /admin/documents/:id/approve
router.patch('/documents/:id/approve', (req, res) =>
  setDocumentStatus(req, res, {
    status: 'approved',
    action: 'document_approved',
    label: 'Admin approve document error',
    errorMessage: 'Failed to approve document',
  }),
);

// PATCH /admin/documents/:id/reject  { reason?: string }
router.patch('/documents/:id/reject', (req, res) => {
  const reason = String(req.body?.reason ?? '').trim() || null;
  return setDocumentStatus(req, res, {
    status: 'rejected',
    action: 'document_rejected',
    notes: reason,
    label: 'Admin reject document error',
    errorMessage: 'Failed to reject document',
  });
});

// ---------------------------------------------------------------------------
// Panic alerts (raised from the provider app's SOS button)
// ---------------------------------------------------------------------------

const PANIC_STATUSES = ['open', 'acknowledged', 'resolved'];

// GET /admin/panic-alerts?status=open|acknowledged|resolved   (omit for all)
// -> { alerts: [...], counts: { all, open, acknowledged, resolved } }
router.get('/panic-alerts', async (req, res) => {
  const status = PANIC_STATUSES.includes(req.query.status) ? req.query.status : null;

  try {
    let listQuery = supabase
      .from('panic_alerts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (status) listQuery = listQuery.eq('status', status);

    const countFor = (s) => {
      let q = supabase.from('panic_alerts').select('id', { count: 'exact', head: true });
      if (s) q = q.eq('status', s);
      return q;
    };

    const [listRes, allRes, openRes, ackRes, resolvedRes] = await Promise.all([
      listQuery,
      countFor(null),
      countFor('open'),
      countFor('acknowledged'),
      countFor('resolved'),
    ]);

    if (listRes.error) {
      return fail(res, 'Admin panic list error', listRes.error, 'Failed to fetch panic alerts');
    }

    const alerts = listRes.data || [];

    // Attach each provider's slug so the panel can link to their profile.
    const providerIds = [...new Set(alerts.map((a) => a.provider_id))];
    const slugById = {};
    if (providerIds.length) {
      const { data: provs, error: provError } = await supabase
        .from('providers')
        .select('user_id, slug')
        .in('user_id', providerIds);
      if (provError) console.error('Admin panic slug lookup error:', provError.message);
      for (const p of provs || []) slugById[p.user_id] = p.slug;
    }

    res.json({
      alerts: alerts.map((a) => ({ ...a, provider_slug: slugById[a.provider_id] ?? null })),
      counts: {
        all: allRes.count ?? 0,
        open: openRes.count ?? 0,
        acknowledged: ackRes.count ?? 0,
        resolved: resolvedRes.count ?? 0,
      },
    });
  } catch (err) {
    return fail(res, 'Admin panic list error', err, 'Failed to fetch panic alerts');
  }
});

// PATCH /admin/panic-alerts/:id/acknowledge   (open -> acknowledged)
router.patch('/panic-alerts/:id/acknowledge', (req, res) =>
  setPanicStatus(req, res, {
    status: 'acknowledged',
    from: ['open'],
    stamp: 'acknowledged',
    action: 'panic_acknowledged',
    label: 'Admin acknowledge panic error',
    errorMessage: 'Failed to acknowledge alert',
  }),
);

// PATCH /admin/panic-alerts/:id/resolve   (open | acknowledged -> resolved)
router.patch('/panic-alerts/:id/resolve', (req, res) =>
  setPanicStatus(req, res, {
    status: 'resolved',
    from: ['open', 'acknowledged'],
    stamp: 'resolved',
    action: 'panic_resolved',
    label: 'Admin resolve panic error',
    errorMessage: 'Failed to resolve alert',
  }),
);

module.exports = router;