// Google Drive backup via the MartPOS gateway.
//
// Customer experience: Settings -> Google Drive -> Connect Google Drive ->
// pick a Google account -> authorize -> connected. The customer NEVER
// creates a Google Cloud project, downloads credentials.json, enters a
// client id/secret, or touches the command line.
//
// Architecture (same model as AI provisioning):
//   POS -- loopback OAuth (vendored developer client) --> Google
//   POS -- id_token + refresh_token (one shot) ---------> gateway /v1/drive/link
//   gateway -- refresh token encrypted at rest --------> drive_links table
//   POS -- encrypted backup blob ---------------------> gateway --> Google Drive
//
// Long-term access: the OAuth flow uses access_type 'offline' so Google
// returns a refresh token. That token is forwarded to the gateway ONCE and
// is then dropped locally - it is never written to disk, renderer state,
// logs or IPC. The POS keeps only a gateway grant (mpt_drv_...) in the
// encrypted secrets store.
//
// Scope: only https://www.googleapis.com/auth/drive.file - the narrow
// scope that can create and manage the app-owned "MARTPOS Backups" folder.
// No full-drive, Gmail, Calendar, Contacts or YouTube scope is requested.
//
// Backup encryption: snapshots are encrypted locally with AES-256-GCM
// before they leave the machine - the gateway only transports ciphertext.
// The 32-byte key lives in the encrypted secrets store (DPAPI under
// Electron, MARTPOS_SECRET_KEY elsewhere) and is escrowed - encrypted at
// rest - on the gateway under the drive link, so a reinstall on a new PC
// that re-links the same Google account can still decrypt old backups.
// RECOVERY NOTE: if the device key is lost AND the gateway link is gone,
// existing Drive backups cannot be decrypted - backups are then only
// restorable as long as one of the two survives.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getDataDir } = require('./paths');
const { api: cloudApi, cloudBaseUrl } = require('./whatsapp/gatewayClient');
const { getSecret, setSecret } = require('./secrets');

const DRIVE_FOLDER_NAME = 'MARTPOS Backups';
const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'];
const BACKUP_INTERVALS = { '6h': 6 * 60 * 60 * 1000, 'daily': 24 * 60 * 60 * 1000, 'on_exit': Infinity };
const BACKUP_MAGIC = 'MPBK';
const BACKUP_VERSION = 1;
const BACKUP_EXT = '.mpbak';

class DriveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DriveError';
  }
}

// Plain-language version of a Google/network/gateway failure for the UI.
// The raw error is still written to the server log.
function friendlyMessage(err) {
  const code = err && err.code;
  const status = err && err.status;
  const msg = String((err && err.message) || err || '');
  if (code === 'not_configured') {
    return 'Cloud backup is not configured on this installation. Link the shop\'s MartPOS account or contact your POS provider.';
  }
  if (code === 'reconnect_required' || /invalid_grant|invalid_client|unauthorized_client/i.test(msg) || status === 401) {
    return 'Unable to connect to Google Drive. Please reconnect your Google account.';
  }
  if (status === 404 || code === 'not_found' || /file not found|notFound/i.test(msg)) {
    return 'The backup file was not found on Google Drive (it may have been deleted).';
  }
  if (status === 403 || code === 'drive_denied' || /insufficient|forbidden|accessNotConfigured|quotaExceeded/i.test(msg)) {
    return 'Google Drive access was denied. Reconnect the Google account in Settings.';
  }
  if (code === 'offline' || code === 'network' ||
      /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|socket hang up|network|fetch failed/i.test(msg)) {
    return 'Internet connection is unavailable. The backup will be retried automatically.';
  }
  return msg;
}

// Settings reads are wrapped so status() is safe before the db is initialized.
function readSetting(key, fallback) {
  try {
    return require('./settings').getSetting(key, fallback);
  } catch (_) {
    return fallback;
  }
}

// The only Drive credential held locally: the gateway grant. No Google
// refresh/access tokens are ever persisted on the POS.
function driveGrant() {
  return getSecret('drive_gateway_grant') || '';
}

function driveLinked() {
  return !!driveGrant();
}

function status() {
  const interval = readSetting('drive_backup_interval', 'daily');
  const lastAt = readSetting('drive_last_backup_at', '');
  const autoOn = readSetting('drive_auto_backup', '0') === '1';
  const connected = driveLinked();

  let nextBackupAt = null;
  if (autoOn && connected && interval !== 'on_exit') {
    const last = Date.parse(lastAt || '') || 0;
    nextBackupAt = last
      ? new Date(last + (BACKUP_INTERVALS[interval] || BACKUP_INTERVALS.daily)).toISOString()
      : new Date().toISOString();
  }

  let lastStatus = '';
  let lastError = '';
  try {
    const { listHistory } = require('./backup');
    const row = listHistory(50).find((r) => r.location === 'drive' && r.type !== 'restore');
    if (row) {
      lastStatus = row.status;
      lastError = row.error || '';
    }
  } catch (_) { /* history unavailable */ }

  return {
    connected,
    available: !!cloudBaseUrl(),
    email: readSetting('drive_email', ''),
    name: readSetting('drive_name', ''),
    connected_at: readSetting('drive_connected_at', ''),
    folder: DRIVE_FOLDER_NAME,
    auto_backup: autoOn,
    backup_interval: interval,
    last_backup_at: lastAt,
    next_backup_at: nextBackupAt,
    last_status: lastStatus,
    last_error: lastError
  };
}

function backupIntervalMs() {
  const f = readSetting('drive_backup_interval', 'daily');
  return BACKUP_INTERVALS[f] !== undefined ? BACKUP_INTERVALS[f] : BACKUP_INTERVALS.daily;
}

// True when automatic backup is enabled, Drive is connected, and the
// configured interval has elapsed since the last successful backup.
function isBackupDue() {
  try {
    if (readSetting('drive_auto_backup', '0') !== '1') return false;
    if (!driveLinked()) return false;
    const last = Date.parse(readSetting('drive_last_backup_at', '') || '') || 0;
    return Date.now() - last >= backupIntervalMs();
  } catch (_) {
    return false;
  }
}

// Public endpoint - no token required: the developer-owned OAuth "Desktop
// app" client is vendored so installs sign in with zero local configuration.
async function fetchDriveOAuthClient() {
  try {
    if (!cloudBaseUrl()) return null;
    const res = await cloudApi('/v1/drive/oauth-client', { token: '' });
    const clientId = String((res && res.google_client_id) || '').trim();
    if (!clientId) return null;
    return { client_id: clientId, client_secret: String(res.google_client_secret || '') };
  } catch (_) {
    return null;
  }
}

// ---- backup encryption key ----------------------------------------------
// Device-generated AES-256 key for encrypting backups before upload. Stored
// in the encrypted secrets store; also escrowed (encrypted at rest) on the
// gateway so a re-linked install can recover it.

function localBackupKey() {
  const raw = getSecret('drive_backup_key');
  if (!raw) return null;
  try {
    const k = Buffer.from(raw, 'base64');
    return k.length === 32 ? k : null;
  } catch (_) {
    return null;
  }
}

function ensureLocalBackupKey() {
  const existing = localBackupKey();
  if (existing) return existing;
  const k = crypto.randomBytes(32);
  setSecret('drive_backup_key', k.toString('base64'));
  return k;
}

// ---- backup blob format ---------------------------------------------------
// MPBK | version(1) | iv(12) | tag(16) | ciphertext - AES-256-GCM.
// The magic+version lets restore distinguish a MartPOS-encrypted backup
// from a plain database file before touching the live db.

function encryptBackup(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from(BACKUP_MAGIC, 'latin1'), Buffer.from([BACKUP_VERSION]), iv, cipher.getAuthTag(), ct]);
}

function decryptBackup(blob, key) {
  if (!Buffer.isBuffer(blob) || blob.length < BACKUP_MAGIC.length + 1 + 12 + 16) {
    throw new DriveError('Downloaded backup is not usable: file is too small');
  }
  if (blob.subarray(0, BACKUP_MAGIC.length).toString('latin1') !== BACKUP_MAGIC ||
      blob[BACKUP_MAGIC.length] !== BACKUP_VERSION) {
    throw new DriveError('Downloaded backup is not a MartPOS encrypted backup');
  }
  const off = BACKUP_MAGIC.length + 1;
  const iv = blob.subarray(off, off + 12);
  const tag = blob.subarray(off + 12, off + 28);
  const ct = blob.subarray(off + 28);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (_) {
    throw new DriveError('Downloaded backup could not be decrypted - it may be corrupt or belong to a different installation');
  }
}

// Decode (not verify) the JWT payload for a fast local sanity check. The
// gateway cryptographically re-verifies the token before storing anything,
// so skipping local signature verification is safe.
function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

// After OAuth succeeds locally, hand the credential to the gateway. The
// gateway verifies identity + Drive access + folder before it answers, so a
// successful response IS a verified connection. The local drive grant is
// replaced only on success - a failed Change Account keeps the old link.
async function linkDriveAccount({ idToken, refreshToken }) {
  let res;
  try {
    // Bearer defaults to the device token when this install is
    // cloud-registered, binding the Drive link to the shop server-side.
    res = await cloudApi('/v1/drive/link', {
      method: 'POST',
      body: { id_token: idToken, refresh_token: refreshToken },
      timeoutMs: 30000
    });
  } catch (e) {
    throw new DriveError(friendlyMessage(e));
  }
  if (!res || !res.ok || !res.drive_token) {
    throw new DriveError('Could not link the Google Drive account');
  }

  setSecret('drive_gateway_grant', res.drive_token);
  try {
    require('./settings').setSettings({
      drive_email: res.email || '',
      drive_name: res.name || '',
      drive_connected_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('Could not save Drive account details:', e.message);
  }

  // Backup-key escrow: adopt the key the gateway already holds for this
  // account (covers reinstalls on a new machine). Otherwise upload ours.
  if (res.backup_key) {
    try {
      const k = Buffer.from(String(res.backup_key), 'base64');
      if (k.length === 32) setSecret('drive_backup_key', res.backup_key);
    } catch (_) { /* keep existing key */ }
  } else {
    try {
      const key = ensureLocalBackupKey();
      await cloudApi('/v1/drive/backup-key', {
        method: 'POST',
        body: { backup_key: key.toString('base64') },
        token: res.drive_token
      });
    } catch (_) { /* escrow is best-effort - the local key still works */ }
  }
  return res;
}

// Loopback-IP OAuth flow (RFC 8252): spins up a one-shot listener on a
// random 127.0.0.1 port, opens the system browser for Google sign-in, and
// captures the redirect. The OAuth client is vendored by the gateway - the
// customer configures nothing.
let connectInFlight = null;
function connectOAuth() {
  if (connectInFlight) return connectInFlight;
  connectInFlight = runConnect().finally(() => { connectInFlight = null; });
  return connectInFlight;
}

async function runConnect() {
  const cfg = await fetchDriveOAuthClient();
  if (!cfg) {
    throw new DriveError(
      cloudBaseUrl()
        ? 'The backup service is unavailable right now. Try again later.'
        : 'Cloud backup is not configured on this installation. Link the shop\'s MartPOS account or contact your POS provider.'
    );
  }

  const http = require('http');
  const url = require('url');
  const state = crypto.randomBytes(16).toString('hex');

  return new Promise((resolve, reject) => {
    let oAuth2Client = null;
    let done = false;

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { server.close(); } catch (_) { /* already closed */ }
      fn(value);
    };

    const server = http.createServer(async (req, res) => {
      const query = url.parse(req.url, true).query;
      // Ignore incidental requests (favicon etc.) - only an OAuth redirect
      // carrying 'code' or 'error' completes the flow.
      if (!query.code && !query.error) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      try {
        if (query.error) {
          throw new DriveError(`Google sign-in was cancelled or denied (${query.error})`);
        }
        if (!query.state || query.state !== state) {
          throw new DriveError('Invalid sign-in state - please try again');
        }
        const { tokens } = await oAuth2Client.getToken(query.code);
        if (!tokens || !tokens.id_token) {
          throw new DriveError('Google did not return an identity token');
        }
        // Offline access must yield a refresh token - it is what lets
        // automatic backups run while the customer is away.
        if (!tokens.refresh_token) {
          throw new DriveError('Google did not grant offline access. Try Connect again.');
        }
        const claims = decodeJwtPayload(tokens.id_token);
        if (!claims || !claims.sub || !claims.email) {
          throw new DriveError('Google account did not provide a verifiable identity');
        }
        if (claims.email_verified === false) {
          throw new DriveError('That Google account email is not verified by Google');
        }

        // One-shot hand-off: the refresh token and id_token go to the
        // gateway over TLS and are never stored on this machine.
        await linkDriveAccount({ idToken: tokens.id_token, refreshToken: tokens.refresh_token });

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>MartPOS connected to Google Drive.</h1><p>You can close this window and return to MartPOS.</p>');
        finish(resolve, status());
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>Connection failed</h1><p>You can close this window and try again in MartPOS.</p>');
        finish(reject, error instanceof DriveError ? error : new DriveError(error.message));
      }
    });

    const timer = setTimeout(() => {
      finish(reject, new DriveError('Google sign-in timed out. Try Connect again.'));
    }, 5 * 60 * 1000);

    server.on('error', (err) => finish(reject, new DriveError(err.message)));
    server.listen(0, '127.0.0.1', async () => {
      try {
        const port = server.address().port;
        oAuth2Client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, `http://127.0.0.1:${port}`);
        const authUrl = oAuth2Client.generateAuthUrl({
          access_type: 'offline', // long-lived backups need a refresh token
          scope: SCOPES,
          state,
          // select_account keeps the account picker for Connect and Change
          // Account; consent is included so Google returns a refresh token
          // even for accounts that have authorized this client before.
          prompt: 'select_account consent'
        });
        try {
          const open = require('open');
          await open(authUrl);
        } catch (e) {
          console.log(`Open this URL to connect Google Drive: ${authUrl}`);
        }
      } catch (e) {
        finish(reject, new DriveError(e.message));
      }
    });
  });
}

// Disconnect: revoke the grant + Google authorization server-side
// (best-effort), clear the local grant and account metadata, and turn
// automatic backup off. The customer's Drive files are never deleted, and
// the device backup key is kept so previously downloaded backups remain
// restorable and re-linking the same account keeps backup continuity.
async function disconnect() {
  const grant = driveGrant();
  if (grant && cloudBaseUrl()) {
    try {
      await cloudApi('/v1/drive/link', { method: 'DELETE', token: grant });
    } catch (_) { /* offline - local cleanup still proceeds */ }
  }
  try { setSecret('drive_gateway_grant', ''); } catch (_) { /* best effort */ }
  try {
    require('./settings').setSettings({
      drive_email: '', drive_name: '', drive_connected_at: '', drive_auto_backup: '0'
    });
  } catch (e) {
    console.error('Could not clear Drive settings:', e.message);
  }
}

// Local snapshot -> validate -> encrypt -> gateway -> Google Drive.
// The plaintext database bytes never leave this machine.
async function backupDatabase(trigger = 'manual') {
  const stampForLog = new Date().toISOString();
  try {
    const grant = driveGrant();
    if (!grant) {
      throw new DriveError('Please connect a Google Drive account first.');
    }

    const { exportSnapshot, validateDatabaseBuffer } = require('./database');
    const snapshot = exportSnapshot();
    if (!snapshot || snapshot.length === 0) {
      throw new DriveError('Local database not found');
    }

    // Never upload a corrupt image: the snapshot must be a readable MartPOS
    // database before it leaves the machine.
    const check = await validateDatabaseBuffer(snapshot);
    if (!check.ok) {
      throw new DriveError(`Backup validation failed: ${check.error}`);
    }

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const name = `MartPOS-backup-${stamp}${BACKUP_EXT}`;

    // Authenticated encryption BEFORE transmission - the gateway only
    // ferries ciphertext to the customer's Drive folder.
    const blob = encryptBackup(snapshot, ensureLocalBackupKey());

    let res;
    try {
      res = await cloudApi('/v1/drive/backup', {
        method: 'POST',
        body: blob,
        rawBody: true,
        token: grant,
        headers: { 'x-backup-name': name },
        timeoutMs: 120000
      });
    } catch (e) {
      throw new DriveError(friendlyMessage(e));
    }
    if (!res || !res.ok) {
      throw new DriveError('Backup upload failed');
    }

    const backedUpAt = res.backed_up_at || now.toISOString();
    try {
      require('./settings').setSettings({ drive_last_backup_at: backedUpAt });
    } catch (e) {
      console.error('Could not record backup time:', e.message);
    }

    try {
      require('./backup').recordHistory({
        type: trigger, location: 'drive', name,
        status: 'success', size: blob.length
      });
    } catch (_) { /* history must not fail the backup */ }
    console.log(`Drive backup uploaded: ${name}`);

    return {
      ok: true,
      file: res.file || { name },
      folder: res.folder_name || DRIVE_FOLDER_NAME,
      backed_up_at: backedUpAt
    };
  } catch (error) {
    const err = error instanceof DriveError ? error : new DriveError(friendlyMessage(error));
    try {
      require('./backup').recordHistory({
        type: trigger, location: 'drive', name: `MartPOS-backup-${stampForLog.slice(0, 10)}`,
        status: 'failed', error: err.message
      });
    } catch (_) { /* ignore */ }
    console.error('Drive backup failed:', error.message || error);
    throw err;
  }
}

async function listBackups() {
  const grant = driveGrant();
  if (!grant) {
    throw new DriveError('Please connect a Google Drive account first.');
  }
  try {
    const res = await cloudApi('/v1/drive/backups', { token: grant, timeoutMs: 30000 });
    return (res && res.files) || [];
  } catch (e) {
    throw new DriveError(friendlyMessage(e));
  }
}

// Verifies the stored grant and that the gateway can reach the Drive
// account. Used by Settings -> test / health checks.
async function testConnection() {
  const grant = driveGrant();
  if (!grant) {
    throw new DriveError('Please connect a Google Drive account first.');
  }
  try {
    const res = await cloudApi('/v1/drive/status', { token: grant });
    return {
      ok: !!(res && res.connected),
      email: (res && res.email) || '',
      folder: (res && res.folder_name) || DRIVE_FOLDER_NAME
    };
  } catch (e) {
    throw new DriveError(friendlyMessage(e));
  }
}

// Downloads an encrypted Drive backup, decrypts it locally and validates it
// before anything touches the live database. Returns details for the
// confirm step plus the staged file path.
async function prepareRestore(fileId) {
  const grant = driveGrant();
  if (!grant) {
    throw new DriveError('Please connect a Google Drive account first.');
  }

  let name = '';
  try {
    const meta = await cloudApi(`/v1/drive/backup/${encodeURIComponent(fileId)}`, { token: grant });
    name = (meta && meta.file && meta.file.name) || '';
  } catch (_) { /* name is cosmetic - continue */ }

  let blob;
  try {
    blob = await cloudApi('/v1/drive/restore', {
      method: 'POST',
      body: { file_id: fileId },
      token: grant,
      rawResponse: true,
      timeoutMs: 120000
    });
  } catch (e) {
    throw new DriveError(friendlyMessage(e));
  }

  const key = localBackupKey();
  if (!key) {
    throw new DriveError('The backup encryption key is unavailable on this machine. Reconnect Google Drive to recover it.');
  }
  const plain = decryptBackup(blob, key);

  const { validateDatabaseBuffer } = require('./database');
  const check = await validateDatabaseBuffer(plain);
  if (!check.ok) {
    throw new DriveError(`Downloaded backup is not usable: ${check.error}`);
  }

  const dir = path.join(getDataDir(), 'restores');
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `drive-${String(fileId).replace(/[^\w-]/g, '')}-${Date.now()}.db`);
  try {
    fs.writeFileSync(tmpPath, plain);
  } catch (e) {
    throw new DriveError(`Could not stage the downloaded backup: ${e.message}`);
  }

  const { describeBackupFile } = require('./backup');
  const details = await describeBackupFile(tmpPath, name || path.basename(tmpPath));
  if (!details.ok) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* discard bad download */ }
    throw new DriveError(`Downloaded backup is not usable: ${details.error}`);
  }
  details.staging_path = tmpPath;
  return details;
}

// Applies a previously staged download (from prepareRestore) to the live
// database with a safety backup. Kept thin - lib/backup does the work.
async function applyStagedRestore(stagingPath, label) {
  const { applyRestoreFile } = require('./backup');
  const result = await applyRestoreFile(stagingPath, label || path.basename(stagingPath));
  try { fs.unlinkSync(stagingPath); } catch (_) { /* staging cleaned on next run */ }
  return result;
}

// Compatibility wrapper: prepare + apply in one call.
async function restoreDatabase(fileId) {
  const prepared = await prepareRestore(fileId);
  return applyStagedRestore(prepared.staging_path, prepared.name);
}

async function tryAutoBackup() {
  try {
    return await backupDatabase('automatic');
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// Removes staged restore downloads older than a day - leftovers from an
// abandoned or crashed restore must not accumulate.
function cleanupStaging() {
  try {
    const dir = path.join(getDataDir(), 'restores');
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch (_) { /* skip unreadable entries */ }
    }
  } catch (_) { /* best effort */ }
}

module.exports = {
  DriveError,
  driveGrant,
  driveLinked,
  status,
  isBackupDue,
  connectOAuth,
  disconnect,
  backupDatabase,
  listBackups,
  prepareRestore,
  applyStagedRestore,
  restoreDatabase,
  testConnection,
  tryAutoBackup,
  cleanupStaging,
  friendlyMessage,
  fetchDriveOAuthClient,
  encryptBackup,
  decryptBackup,
  localBackupKey,
  SCOPES,
  DRIVE_FOLDER_NAME,
  BACKUP_EXT
};
