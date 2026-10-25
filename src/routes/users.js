const express = require('express');
const router = express.Router();
const multer = require('multer');
const { supabase } = require('../services/supabase');

// PROFILE_FIELDS is shared by every read below, so avatar_url shows up
// anywhere a user profile is fetched (Profile screen, PATCH response,
// etc.) without each route needing to remember to ask for it.
const PROFILE_FIELDS =
  'id, full_name, phone, user_type, vehicle_info, medical_notes, avatar_url, created_at';

// Public Storage bucket — create this once in the dashboard (Storage → New
// bucket → name "avatars", Public ON). Public, unlike provider-documents,
// because a profile picture is meant to be visible to other users (e.g. a
// customer seeing their assigned provider's photo) rather than gated
// behind a review flow.
const AVATARS_BUCKET = 'avatars';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB — plenty for a profile photo
  fileFilter: (req, file, cb) => {
    const allowed = file.mimetype.startsWith('image/');
    cb(allowed ? null : new Error('Only image files are allowed'), allowed);
  },
});

// GET /users/:id -> a user's profile (used by the Profile screen on load)
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select(PROFILE_FIELDS)
      .eq('id', req.params.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: data });
  } catch (err) {
    console.error('Failed to fetch user:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// PATCH /users/:id -> update editable fields only (phone/id/user_type stay fixed)
router.patch('/:id', async (req, res) => {
  const { full_name, vehicle_info, medical_notes } = req.body;

  try {
    const { data, error } = await supabase
      .from('users')
      .update({ full_name, vehicle_info, medical_notes })
      .eq('id', req.params.id)
      .select(PROFILE_FIELDS)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: data });
  } catch (err) {
    console.error('Failed to update user:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// POST /users/:id/avatar -> upload/replace a profile picture
// multipart/form-data, single field named "avatar". Replaces whatever
// picture the user had before — old file is removed from Storage first so
// orphaned images don't pile up in the bucket.
router.post('/:id/avatar', upload.single('avatar'), async (req, res) => {
  const { id } = req.params;

  if (!req.file) {
    return res.status(400).json({ error: 'No image file was provided' });
  }

  try {
    const { data: existing, error: lookupError } = await supabase
      .from('users')
      .select('avatar_url')
      .eq('id', id)
      .maybeSingle();

    if (lookupError) {
      console.error('Avatar lookup error:', lookupError);
      return res.status(500).json({ error: 'Failed to upload avatar' });
    }
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    // One fixed-name file per user (avatar.<ext>), overwritten in place —
    // this keeps the same public URL stable across re-uploads (no stale
    // links cached on other people's devices) and avoids the bucket
    // filling up with old versions the way a timestamped filename would.
    const ext = (req.file.mimetype.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '');
    const storagePath = `${id}/avatar.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(AVATARS_BUCKET)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      console.error('Avatar upload error:', uploadError.message);
      return res.status(500).json({ error: 'Failed to upload avatar' });
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from(AVATARS_BUCKET).getPublicUrl(storagePath);

    // Cache-bust so the new photo shows immediately even though the path
    // (and therefore the URL) didn't change — clients otherwise keep
    // showing a cached copy of the old image at the same URL.
    const avatarUrl = `${publicUrl}?v=${Date.now()}`;

    const { data: updated, error: updateError } = await supabase
      .from('users')
      .update({ avatar_url: avatarUrl })
      .eq('id', id)
      .select(PROFILE_FIELDS)
      .single();

    if (updateError) {
      console.error('Avatar URL save error:', updateError);
      return res.status(500).json({ error: 'Failed to save avatar' });
    }

    res.json({ success: true, user: updated });
  } catch (err) {
    console.error('Avatar upload error:', err);
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
});

// DELETE /users/:id/avatar -> remove the profile picture, reverting to
// whatever default/placeholder the client shows for avatar_url == null.
router.delete('/:id/avatar', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: existing, error: lookupError } = await supabase
      .from('users')
      .select('avatar_url')
      .eq('id', id)
      .maybeSingle();

    if (lookupError) {
      console.error('Avatar lookup error:', lookupError);
      return res.status(500).json({ error: 'Failed to remove avatar' });
    }
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!existing.avatar_url) {
      return res.status(400).json({ error: 'No avatar to remove' });
    }

    // Best-effort cleanup of both possible extensions we might have
    // written in POST /:id/avatar — upsert overwrites same-extension
    // re-uploads in place, but a user who uploaded a .png and later a
    // .jpg would otherwise leave the older file behind.
    await supabase.storage
      .from(AVATARS_BUCKET)
      .remove([`${id}/avatar.jpg`, `${id}/avatar.jpeg`, `${id}/avatar.png`, `${id}/avatar.webp`]);

    const { data: updated, error: updateError } = await supabase
      .from('users')
      .update({ avatar_url: null })
      .eq('id', id)
      .select(PROFILE_FIELDS)
      .single();

    if (updateError) {
      console.error('Avatar removal save error:', updateError);
      return res.status(500).json({ error: 'Failed to remove avatar' });
    }

    res.json({ success: true, user: updated });
  } catch (err) {
    console.error('Avatar removal error:', err);
    res.status(500).json({ error: 'Failed to remove avatar' });
  }
});

// Router-level error handler — same reasoning as providers.js: Multer
// errors (oversized file, disallowed mimetype from fileFilter above)
// come back as clean 400 JSON instead of an unhandled exception.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('❌ Multer error:', err.code, err.field);
    return res.status(400).json({ error: `Upload error: ${err.message}`, field: err.field });
  }
  if (err) {
    console.error('❌ Upload error:', err.message);
    return res.status(400).json({ error: err.message });
  }
  next();
});

module.exports = router;