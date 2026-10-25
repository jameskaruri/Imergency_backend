// firebase-admin-init.js
//
// firebase-admin v12+ moved to a modular API (initializeApp/cert imported
// from 'firebase-admin/app', getMessaging from 'firebase-admin/messaging')
// — the old `require('firebase-admin')` default export no longer exposes
// `.credential.cert(...)` the way older major versions did. This file
// uses the correct modular imports, then exports a small compatibility
// object shaped like the old `admin` namespace (just `.messaging()`) so
// dispatch.js's existing `admin.messaging().send(...)` calls don't need
// to change at all.

const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error(
    'FIREBASE_SERVICE_ACCOUNT env var is not set. Paste the full service ' +
    'account JSON (as a single-line string) into your .env / server config.'
  );
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

const app = initializeApp({
  credential: cert(serviceAccount),
});

// Shaped like the old namespace-style `admin` export so existing call
// sites (admin.messaging().send(...)) keep working unmodified.
module.exports = {
  messaging: () => getMessaging(app),
};