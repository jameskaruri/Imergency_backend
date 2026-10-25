// scripts/set-firebase-env.js
//
// Reads a Firebase service account JSON file straight off disk and writes
// it into .env as a single, correctly-escaped line. This exists because
// hand-editing a multi-line JSON secret into a .env file is extremely easy
// to get wrong (real newlines vs \n, missing quotes, stray characters from
// clipboard tools) — JSON.stringify() below does the escaping correctly,
// every time, with zero manual editing.
//
// Usage (from the backend/ folder):
//   node scripts/set-firebase-env.js "C:\Users\JACKSON\Downloads\nusuriatech-firebase-adminsdk-xxxxx.json"
//
// What it does:
//   1. Reads and JSON.parse()s the file you point it at — this alone will
//      fail loudly with a clear error if the downloaded file itself is
//      corrupted, so you know immediately if the problem is upstream.
//   2. Removes any existing FIREBASE_SERVICE_ACCOUNT=... line from your
//      .env (however malformed it currently is — multi-line junk and all).
//   3. Appends a new, single-line, correctly-escaped
//      FIREBASE_SERVICE_ACCOUNT=... line.
//
// Never prints the secret to the console — only confirms success/failure.

const fs = require('fs');
const path = require('path');

const jsonPath = process.argv[2];
const envPath = path.join(__dirname, '..', '.env');

if (!jsonPath) {
  console.error('Usage: node scripts/set-firebase-env.js "C:\\path\\to\\downloaded-key.json"');
  process.exit(1);
}

if (!fs.existsSync(jsonPath)) {
  console.error(`File not found: ${jsonPath}`);
  process.exit(1);
}

let serviceAccount;
try {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  serviceAccount = JSON.parse(raw);
} catch (err) {
  console.error('❌ The file at that path is not valid JSON:', err.message);
  console.error('   Double-check you pointed this at the downloaded service account .json file.');
  process.exit(1);
}

if (serviceAccount.type !== 'service_account' || !serviceAccount.private_key) {
  console.error('❌ This JSON does not look like a Firebase service account key ' +
    '(missing "type": "service_account" or "private_key" field).');
  console.error('   Make sure you downloaded it from Project Settings → Service accounts → ' +
    'Generate new private key, not google-services.json.');
  process.exit(1);
}

// JSON.stringify() collapses the object to one line and correctly escapes
// the \n characters inside private_key as literal backslash-n sequences —
// exactly what a .env value needs, with no manual escaping required.
const oneLineJson = JSON.stringify(serviceAccount);
const newLine = `FIREBASE_SERVICE_ACCOUNT=${oneLineJson}`;

let envContents = '';
if (fs.existsSync(envPath)) {
  envContents = fs.readFileSync(envPath, 'utf8');
}

// Strip any existing FIREBASE_SERVICE_ACCOUNT entry, including malformed
// multi-line remnants from previous manual edits. This finds the line
// starting with FIREBASE_SERVICE_ACCOUNT= and removes it along with any
// subsequent lines that are clearly part of a broken multi-line JSON blob
// (lines that don't themselves look like KEY=value or a comment/blank line).
const lines = envContents.split(/\r?\n/);
const cleaned = [];
let skipping = false;
for (const line of lines) {
  if (/^FIREBASE_SERVICE_ACCOUNT=/.test(line)) {
    skipping = true;
    continue;
  }
  if (skipping) {
    // Once we hit a line that looks like a normal env line, a comment, or
    // is blank, assume the broken multi-line blob has ended.
    const looksLikeNormalLine = /^\s*$/.test(line) || /^\s*#/.test(line) || /^[A-Z_][A-Z0-9_]*=/.test(line);
    if (looksLikeNormalLine) {
      skipping = false;
    } else {
      continue; // still inside the broken blob — discard this line too
    }
  }
  cleaned.push(line);
}

let result = cleaned.join('\n').replace(/\n{3,}/g, '\n\n'); // collapse excess blank lines
if (!result.endsWith('\n')) result += '\n';
result += `${newLine}\n`;

fs.writeFileSync(envPath, result, 'utf8');

console.log('✅ FIREBASE_SERVICE_ACCOUNT written to .env successfully.');
console.log(`   project_id: ${serviceAccount.project_id}`);
console.log(`   client_email: ${serviceAccount.client_email}`);
console.log(`   private_key_id: ${serviceAccount.private_key_id}`);
console.log('   (values above are safe to share — the private key itself was not printed)');
