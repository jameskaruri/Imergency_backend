const express = require('express');
const multer = require('multer');
const router = express.Router();
const { sendSMS, buildOtpMessage } = require('../services/sms');
const { supabase } = require('../services/supabase');

const AVATAR_BUCKET = 'avatars';
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB
const EMAIL_REGEX = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

const ALLOWED_PHOTO_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Photos are kept in memory just long enough to forward to Supabase Storage.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_PHOTO_TYPES[file.mimetype]) return cb(null, true);
    cb(new Error('INVALID_FILE_TYPE'));
  },
});

// Wraps multer so upload problems come back as JSON `{ error }`,
// which is what the app displays.
function parsePhotoUpload(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Photo is too large. Max 5 MB.' });
    }
    if (err.message === 'INVALID_FILE_TYPE') {
      return res
        .status(400)
        .json({ error: 'Only JPG, PNG or WebP images are allowed.' });
    }
    console.error('Photo upload parse error:', err);
    return res.status(400).json({ error: 'Invalid photo upload' });
  });
}

// Generate random 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

const hasText = (v) => typeof v === 'string' && v.trim().length > 0;

// POST /auth/send-otp
router.post('/send-otp', async (req, res) => {
  const { phone, userType } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Phone number required' });
  }

  try {
    const code = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // Save OTP to database
    const { error: dbError } = await supabase
      .from('otp_codes')
      .insert({
        phone,
        code,
        expires_at: expiresAt,
      });

    if (dbError) {
      console.error('DB error:', dbError);
      return res.status(500).json({ error: 'Failed to generate OTP' });
    }

    // Send OTP via SMS. buildOtpMessage() wraps the code in Google's SMS
    // Retriever format (<#> prefix + app package name + signature hash)
    // so the sending app can autofill it — the package name/hash used
    // depend on which app is requesting (client vs provider), hence
    // passing userType through. Defaults to the client app's config if
    // userType is missing, so existing client callers aren't broken.
    const message = buildOtpMessage(code, userType);
    await sendSMS([phone], message);

    console.log(`📱 OTP ${code} sent to ${phone} (userType: ${userType || 'client'})`);

    res.json({ success: true, message: 'OTP sent successfully' });
  } catch (err) {
    console.error('Send OTP error:', err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// POST /auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  const { phone, code, userType } = req.body;

  if (!phone || !code) {
    return res.status(400).json({ error: 'Phone and code required' });
  }

  try {
    // Find matching OTP
    const { data: otpRecord, error: otpError } = await supabase
      .from('otp_codes')
      .select('*')
      .eq('phone', phone)
      .eq('code', code)
      .eq('verified', false)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (otpError || !otpRecord) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    // Mark OTP as verified
    await supabase
      .from('otp_codes')
      .update({ verified: true })
      .eq('id', otpRecord.id);

    // Find or create user
    let { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .single();

    if (!user) {
      // Create new user. full_name and email are intentionally left unset
      // here — the app collects them in a dedicated step right after OTP
      // verification.
      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert({
          phone,
          user_type: userType || 'customer',
        })
        .select()
        .single();

      if (createError) {
        console.error('Create user error:', createError);
        return res.status(500).json({ error: 'Failed to create user' });
      }
      user = newUser;
    }

    // Does this user still need to provide their name?
    // Covers brand-new rows (full_name null) and old rows seeded with
    // the previous 'New User' placeholder.
    const hasName = !!(
      user.full_name &&
      user.full_name.trim().length > 0 &&
      user.full_name !== 'New User'
    );

    // Does this user still need to provide an email? True for brand-new
    // rows and for existing users who registered before email was required.
    const hasEmail = hasText(user.email);

    // For providers, resolve where they stand in the registration/approval
    // pipeline so the app can route them correctly after login.
    let providerStatus = null;
    if (userType === 'provider') {
      const { data: providerRecord, error: providerLookupError } = await supabase
        .from('providers')
        .select('status')
        .eq('user_id', user.id)
        .maybeSingle();

      if (providerLookupError) {
        console.error('Provider status lookup error:', providerLookupError);
      }

      providerStatus = providerRecord ? providerRecord.status : 'not_registered';
    }

    console.log(`✅ User ${phone} logged in successfully`);

    res.json({ success: true, user, hasName, hasEmail, providerStatus });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// POST /auth/update-profile
// Called right after OTP verification when the user is missing a name
// and/or email. Both are REQUIRED.
router.post('/update-profile', async (req, res) => {
  const { userId, fullName, email } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }
  if (!hasText(fullName)) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (fullName.trim().length > 100) {
    return res.status(400).json({ error: 'Name is too long' });
  }
  if (!hasText(email)) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const cleanEmail = email.trim().toLowerCase();
  if (cleanEmail.length > 254 || !EMAIL_REGEX.test(cleanEmail)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }

  try {
    const { data: user, error } = await supabase
      .from('users')
      .update({ full_name: fullName.trim(), email: cleanEmail })
      .eq('id', userId)
      .select()
      .maybeSingle();

    if (error) {
      // 23505 = unique_violation (the unique index on lower(email)).
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Email already in use' });
      }
      console.error('Update profile error:', error);
      return res.status(500).json({ error: 'Failed to update profile' });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true, user });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /auth/upload-photo   (multipart/form-data: userId + file field "photo")
// OPTIONAL step — the app treats failures here as non-fatal.
router.post('/upload-photo', parsePhotoUpload, async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Photo file is required' });
  }

  try {
    const { data: existing, error: lookupError } = await supabase
      .from('users')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    if (lookupError) {
      console.error('Upload photo lookup error:', lookupError);
      return res.status(500).json({ error: 'Failed to upload photo' });
    }
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    const ext = ALLOWED_PHOTO_TYPES[req.file.mimetype];
    const path = `${userId}/avatar.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(path, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      return res.status(500).json({ error: 'Failed to upload photo' });
    }

    const { data: urlData } = supabase.storage
      .from(AVATAR_BUCKET)
      .getPublicUrl(path);

    // Same path is reused on re-upload, so bust any cached copy.
    const avatarUrl = `${urlData.publicUrl}?v=${Date.now()}`;

    const { data: user, error: updateError } = await supabase
      .from('users')
      .update({ avatar_url: avatarUrl })
      .eq('id', userId)
      .select()
      .single();

    if (updateError) {
      console.error('Save avatar URL error:', updateError);
      return res.status(500).json({ error: 'Failed to save photo' });
    }

    res.json({ success: true, user });
  } catch (err) {
    console.error('Upload photo error:', err);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

// POST /auth/update-name
// Legacy endpoint, kept so older installed app versions keep working.
// New app versions use /auth/update-profile instead.
router.post('/update-name', async (req, res) => {
  const { userId, fullName } = req.body;

  if (!userId || !fullName || !fullName.trim()) {
    return res.status(400).json({ error: 'userId and fullName are required' });
  }

  try {
    const { data: user, error } = await supabase
      .from('users')
      .update({ full_name: fullName.trim() })
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      console.error('Update name error:', error);
      return res.status(500).json({ error: 'Failed to update name' });
    }

    res.json({ success: true, user });
  } catch (err) {
    console.error('Update name error:', err);
    res.status(500).json({ error: 'Failed to update name' });
  }
});

module.exports = router;