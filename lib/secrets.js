// Secret store for API credentials (Twilio keys, etc.).
// Secrets live in <data dir>/secrets.json - never in the database, never
// served to the frontend. When running under Electron the values are
// encrypted with Electron safeStorage (DPAPI on Windows), so they are only
// readable by this Windows user account. Plain `node server.js` / pkg builds
// fall back to a permission-restricted file in the (user-profile) data dir.
const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./paths');

function secretsPath() {
  return path.join(getDataDir(), 'secrets.json');
}

function safeStorage() {
  try {
    if (!process.versions.electron) return null;
    const { safeStorage } = require('electron');
    if (safeStorage && safeStorage.isEncryptionAvailable()) return safeStorage;
  } catch (_) {
    // electron not resolvable (plain node / pkg) or encryption unavailable
  }
  return null;
}

function readAll() {
  try {
    const p = secretsPath();
    if (!fs.existsSync(p)) return {};
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeAll(obj) {
  const p = secretsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj), { mode: 0o600 });
}

function getSecret(key) {
  const entry = readAll()[key];
  if (!entry) return '';
  if (entry.enc) {
    const ss = safeStorage();
    if (!ss) return '';
    try {
      return ss.decryptString(Buffer.from(entry.enc, 'base64'));
    } catch (_) {
      return '';
    }
  }
  return entry.v || '';
}

function setSecret(key, value) {
  const all = readAll();
  if (value === undefined || value === null || value === '') {
    delete all[key];
  } else {
    const ss = safeStorage();
    all[key] = ss
      ? { enc: ss.encryptString(String(value)).toString('base64') }
      : { v: String(value) };
  }
  writeAll(all);
}

function hasSecret(key) {
  return getSecret(key) !== '';
}

module.exports = { getSecret, setSecret, hasSecret };
