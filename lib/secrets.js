// Secret store for API credentials (device token, cloud keys, etc.).
// Secrets live in <data dir>/secrets.json - never in the database, never
// served to the frontend. Three on-disk shapes exist:
//   {enc: <base64>}  - Electron safeStorage (DPAPI on Windows); readable only
//                      by this Windows user account. Preferred when available.
//   {gcm: <base64>}  - AES-256-GCM with MARTPOS_SECRET_KEY (base64, 32 bytes);
//                      the entry packs iv|tag|ciphertext. Fallback for
//                      `node server.js` / pkg builds.
//   {v: <string>}    - legacy plaintext. Still readable so existing installs
//                      keep working, but new writes are never plaintext: with
//                      no DPAPI and no MARTPOS_SECRET_KEY, writes throw.
// Secret values are never logged.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDataDir } = require('./paths');

const NO_SECURE_STORAGE =
  'Secure credential storage is not available on this machine. ' +
  'Set MARTPOS_SECRET_KEY (a base64-encoded 32-byte key) in the environment, ' +
  'or run inside the MartPOS desktop app.';

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

// MARTPOS_SECRET_KEY: base64-encoded 32 bytes. Returns null when unset or
// malformed - callers then refuse to write rather than storing plaintext.
function gcmKey() {
  const raw = String(process.env.MARTPOS_SECRET_KEY || '').trim();
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, 'base64');
    return key.length === 32 ? key : null;
  } catch (_) {
    return null;
  }
}

function gcmEncrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function gcmDecrypt(packed, key) {
  const raw = Buffer.from(packed, 'base64');
  if (raw.length < 12 + 16) return null;
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
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
  if (entry.gcm) {
    const key = gcmKey();
    if (!key) return '';
    try {
      return gcmDecrypt(entry.gcm, key) || '';
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
    if (ss) {
      all[key] = { enc: ss.encryptString(String(value)).toString('base64') };
    } else {
      const key32 = gcmKey();
      if (!key32) {
        throw new Error(NO_SECURE_STORAGE);
      }
      all[key] = { gcm: gcmEncrypt(String(value), key32) };
    }
  }
  writeAll(all);
}

function hasSecret(key) {
  return getSecret(key) !== '';
}

module.exports = { getSecret, setSecret, hasSecret, NO_SECURE_STORAGE };
