const axios = require('axios');
const qs = require('querystring');

const HOSTPINNACLE_URL = 'https://smsportal.hostpinnacle.co.ke/SMSApi/send';

const {
  HOSTPINNACLE_USERID,
  HOSTPINNACLE_PASSWORD,
  HOSTPINNACLE_SENDERID,
  HOSTPINNACLE_APIKEY,
} = process.env;

// Each app (client vs provider) has its own Android applicationId and its
// own SMS Retriever signature hash (the hash is derived from the app's
// signing certificate, so it differs per app AND per debug/release build).
// buildOtpMessage() below picks the right pair based on `userType` so the
// SMS Retriever on each app only fires for messages actually addressed to
// it — sending the wrong package name/hash means codeUpdated() silently
// never fires on that app, even though the SMS still arrives fine.
//
// TODO: replace with the real applicationId + 11-char hash for EACH app.
// Get the hash by running `await SmsAutofill().getAppSignature` from
// within that exact app build (debug hash and release hash differ unless
// release is signed with the debug key, as imergency_provider currently is).
const ANDROID_APP_CONFIG = {
  client: {
    packageName: 'com.example.imergency_client',
    hash: 'FA+9qCX9VSu',
  },
  provider: {
    packageName: 'com.example.imergency_provider',
    hash: '3cBDdzrm5Lx',
  },
};

// GSM 03.38 basic character set + national language shift table characters.
// Anything outside this set (emoji, curly quotes, em dashes, most non-Latin
// scripts, etc.) is NOT valid GSM-7 text and must be sent as msgType
// 'unicode' instead of 'text' — sending it as 'text' is what HostPinnacle
// rejects with "Msg Text and MsgType Mismatch".
const GSM_7_REGEX =
  /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\\[~\]|€]*$/;

function isGsm7(text) {
  return GSM_7_REGEX.test(text);
}

async function sendSMS(recipients, message) {
  // Accept either a single number (string) or an array, like the AT version did.
  const numbers = Array.isArray(recipients) ? recipients : [recipients];

  // HostPinnacle expects numbers without a leading '+', comma-separated.
  const mobile = numbers.map((n) => n.replace(/^\+/, '')).join(',');

  // msgType must match the actual content: 'text' for GSM-7-safe strings,
  // 'unicode' for anything else (emoji, smart quotes, em dashes, non-Latin
  // scripts). Mismatching these two is what triggers the HostPinnacle error.
  const msgType = isGsm7(message) ? 'text' : 'unicode';

  const payload = qs.stringify({
    userid: HOSTPINNACLE_USERID,
    password: HOSTPINNACLE_PASSWORD,
    senderid: HOSTPINNACLE_SENDERID,
    sendMethod: 'quick',
    msgType,
    mobile,
    msg: message,
    duplicatecheck: 'true',
    output: 'json',
  });

  try {
    const { data } = await axios.post(HOSTPINNACLE_URL, payload, {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        apikey: HOSTPINNACLE_APIKEY,
      },
    });

    if (data.status !== 'success') {
      throw new Error(data.reason || 'Unknown HostPinnacle error');
    }

    console.log('✅ SMS sent:', data);
    return data;
  } catch (err) {
    console.error('❌ SMS error:', err.response?.data || err.message);
    throw err;
  }
}

function buildSOSMessage(name, address, latitude, longitude) {
  const mapsLink = `https://maps.google.com/?q=${latitude},${longitude}`;
  return `🚨 EMERGENCY ALERT!\n${name} needs help urgently.\nLocation: ${address}\nMap: ${mapsLink}\nPlease contact them immediately!`;
}

// Covers every service type in routes/requests.js's ETA map. Unknown types
// fall back to the raw type string instead of printing "undefined".
const CONFIRMATION_LABELS = {
  breakdown: 'mechanic',
  mechanic: 'mechanic',
  fuel: 'fuel delivery',
  tyre: 'tyre technician',
  tow: 'tow truck',
  medical: 'ambulance',
  ambulance: 'ambulance',
  jumpstart: 'jumpstart',
  ev: 'EV charging',
  traffic: 'traffic assistance',
  security: 'security',
  insurance: 'insurance assistance',
};

function buildConfirmationMessage(type, eta) {
  const label = CONFIRMATION_LABELS[type] || type;
  return `✅ imergency: Your ${type} request received. Help is on the way — ETA ${eta} minutes. Stay safe!`;
}

// Sent to a provider when a job is assigned to them directly.
// Plain GSM-7 text on purpose (no emoji or em dashes), so it goes out as a
// single cheap 'text' SMS instead of 'unicode'. The short ref keeps messages
// unique, because sendSMS uses duplicatecheck: 'true'.
function buildJobRequestMessage(type, address, expiresInSeconds, requestId) {
  const shortAddress = address ? String(address).slice(0, 60) : 'a nearby location';
  const ref = String(requestId).slice(0, 6);
  return `imergency: New ${type} job at ${shortAddress}. Open the app and accept within ${expiresInSeconds}s. Ref ${ref}`;
}

// Must match Google's SMS Retriever format exactly:
// - starts with "<#>"
// - contains the app's package name
// - ends with the 11-char app signature hash on its own line
// - no extra text after the hash
// - whole message must stay under 140 bytes
//
// `userType` selects which app (client/provider) this OTP is for, so the
// message is stamped with THAT app's package name + hash. Defaults to
// 'client' only to stay backward-compatible with any caller that hasn't
// been updated to pass userType yet — every caller should pass it
// explicitly going forward.
function buildOtpMessage(otp, userType = 'client') {
  const app = ANDROID_APP_CONFIG[userType];
  if (!app) {
    throw new Error(
      `buildOtpMessage: unknown userType "${userType}" — expected one of: ${Object.keys(ANDROID_APP_CONFIG).join(', ')}`
    );
  }
  return `<#> Your imergency verification code is ${otp}\n${app.packageName}\n${app.hash}`;
}

module.exports = {
  sendSMS,
  buildSOSMessage,
  buildConfirmationMessage,
  buildJobRequestMessage,
  buildOtpMessage,
};