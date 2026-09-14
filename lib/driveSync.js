const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getCredentialsPath, getTokenPath, getDataDir, getDbPath } = require('./paths');

const DRIVE_FOLDER_NAME = 'MartPOS Backups';
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const BACKUP_INTERVALS = { '6h': 6 * 60 * 60 * 1000, 'daily': 24 * 60 * 60 * 1000, 'on_exit': Infinity };

class DriveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DriveError';
  }
}

// Plain-language version of a Google/network failure for the UI. The raw
// error is still written to the server log.
function friendlyMessage(err) {
  const msg = String((err && err.message) || err || '');
  const code = err && (err.code || (err.response && err.response.status) || (err.errors && err.errors[0] && err.errors[0].reason));
  if (/invalid_grant|invalid_client|unauthorized_client/i.test(msg) || code === 401) {
    return 'Unable to connect to Google Drive. Please reconnect your Google account.';
  }
  if (code === 403 || /insufficient|forbidden|accessNotConfigured|quotaExceeded/i.test(msg)) {
    return 'Google Drive access was denied. Reconnect the Google account in Settings.';
  }
  if (code === 404 || /file not found|notFound/i.test(msg)) {
    return 'The backup file was not found on Google Drive (it may have been deleted).';
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|socket hang up|network|fetch failed/i.test(msg)) {
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

function credentialsPresent() {
  return fs.existsSync(getCredentialsPath());
}

function tokenPresent() {
  return fs.existsSync(getTokenPath());
}

function status() {
  const interval = readSetting('drive_backup_interval', 'daily');
  const lastAt = readSetting('drive_last_backup_at', '');
  const autoOn = readSetting('drive_auto_backup', '0') === '1';
  const connected = tokenPresent();

  // When the next automatic upload is expected. 'on_exit' has no clock-based
  // next time; with no prior backup the first due check happens right away.
  let nextBackupAt = null;
  if (autoOn && connected && interval !== 'on_exit') {
    const last = Date.parse(lastAt || '') || 0;
    nextBackupAt = last
      ? new Date(last + (BACKUP_INTERVALS[interval] || BACKUP_INTERVALS.daily)).toISOString()
      : new Date().toISOString();
  }

  // Most recent Drive outcome from the backup history table.
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
    credentials: credentialsPresent(),
    connected,
    credentials_path: getCredentialsPath(),
    token_path: getTokenPath(),
    folder: DRIVE_FOLDER_NAME,
    email: readSetting('drive_email', ''),
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
    if (!tokenPresent()) return false;
    const last = Date.parse(readSetting('drive_last_backup_at', '') || '') || 0;
    return Date.now() - last >= backupIntervalMs();
  } catch (_) {
    return false;
  }
}

function loadOAuthClient(redirectUri) {
  const credentials = JSON.parse(fs.readFileSync(getCredentialsPath(), 'utf8'));
  const { client_secret, client_id } = credentials.installed || credentials.web;
  return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

async function buildService() {
  try {
    const tokenPath = getTokenPath();

    if (!fs.existsSync(tokenPath)) {
      throw new DriveError('Please connect a Google Drive account first.');
    }

    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    const oAuth2Client = loadOAuthClient();
    oAuth2Client.setCredentials(token);

    // Refresh token if expired
    if (token.expiry_date && token.expiry_date < Date.now()) {
      try {
        const { credentials: newCredentials } = await oAuth2Client.refreshAccessToken();
        fs.writeFileSync(tokenPath, JSON.stringify(newCredentials), { mode: 0o600 });
        oAuth2Client.setCredentials(newCredentials);
      } catch (refreshError) {
        throw new DriveError(
          /invalid_grant|unauthorized/i.test(String(refreshError && refreshError.message))
            ? 'Unable to connect to Google Drive. Please reconnect your Google account.'
            : friendlyMessage(refreshError)
        );
      }
    }

    return google.drive({ version: 'v3', auth: oAuth2Client });
  } catch (error) {
    if (error instanceof DriveError) throw error;
    if (error.code === 'MODULE_NOT_FOUND') {
      throw new DriveError('Google Drive libraries are not installed');
    }
    throw new DriveError(friendlyMessage(error));
  }
}

// Loopback-IP OAuth flow (RFC 8252): spins up a one-shot listener on a
// random 127.0.0.1 port, opens the system browser for Google sign-in, and
// captures the redirect. Google allows any loopback port for Desktop-app
// OAuth clients, so nothing needs to be pre-registered per machine.
async function connectOAuth() {
  try {
    const http = require('http');
    const url = require('url');

    const credentialsPath = getCredentialsPath();
    if (!fs.existsSync(credentialsPath)) {
      throw new DriveError(`Place Google OAuth credentials.json at ${credentialsPath}`);
    }
    // Validate the file before asking the user to sign in.
    loadOAuthClient();

    return await new Promise((resolve, reject) => {
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
            throw new DriveError(`Google sign-in was denied (${query.error})`);
          }
          const { tokens } = await oAuth2Client.getToken(query.code);
          oAuth2Client.setCredentials(tokens);
          fs.writeFileSync(getTokenPath(), JSON.stringify(tokens), { mode: 0o600 });

          // Record which Google account was connected for the Settings page.
          let email = '';
          try {
            const drive = google.drive({ version: 'v3', auth: oAuth2Client });
            const about = await drive.about.get({ fields: 'user' });
            email = (about.data.user && about.data.user.emailAddress) || '';
          } catch (e) {
            console.error('Could not read Google account email:', e.message);
          }
          try {
            require('./settings').setSettings({ drive_email: email });
          } catch (e) {
            console.error('Could not save Google account email:', e.message);
          }

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>MartPOS connected to Google Drive.</h1><p>You can close this window and return to MartPOS.</p>');
          finish(resolve, status());
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end('<h1>Authentication failed</h1><p>You can close this window.</p>');
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
          oAuth2Client = loadOAuthClient(`http://127.0.0.1:${port}`);
          const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
            prompt: 'consent'
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
  } catch (error) {
    if (error instanceof DriveError) throw error;
    if (error.code === 'MODULE_NOT_FOUND') {
      throw new DriveError('Google Drive libraries are not installed');
    }
    throw new DriveError(friendlyMessage(error));
  }
}

// Revokes the OAuth grant, removes the stored token and connected email, and
// turns automatic backup off. Local POS data and existing Drive backups are
// left untouched.
async function disconnect() {
  const tokenPath = getTokenPath();
  try {
    if (fs.existsSync(tokenPath)) {
      const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      const oAuth2Client = loadOAuthClient();
      await oAuth2Client.revokeToken(token.refresh_token || token.access_token);
    }
  } catch (e) {
    // Revocation is best-effort - still clear local state.
    console.error('Drive token revocation failed:', e.message);
  }
  try { fs.unlinkSync(tokenPath); } catch (_) { /* already gone */ }
  try {
    require('./settings').setSettings({ drive_email: '', drive_auto_backup: '0' });
  } catch (e) {
    console.error('Could not clear Drive settings:', e.message);
  }
}

async function getOrCreateFolder(service, name = DRIVE_FOLDER_NAME, parentId = null) {
  let query = `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  if (parentId) {
    query += ` and '${parentId}' in parents`;
  }

  const response = await service.files.list({
    q: query,
    spaces: 'drive',
    fields: 'files(id, name)'
  });

  const files = response.data.files || [];
  if (files.length > 0) {
    return files[0].id;
  }

  const fileMetadata = {
    name,
    mimeType: 'application/vnd.google-apps.folder'
  };
  if (parentId) {
    fileMetadata.parents = [parentId];
  }

  const folder = await service.files.create({
    resource: fileMetadata,
    fields: 'id'
  });

  return folder.data.id;
}

async function backupDatabase(trigger = 'manual') {
  const stampForLog = new Date().toISOString();
  try {
    const service = await buildService();

    // Flush pending changes, then export a consistent in-memory snapshot.
    // pos.db itself is never read or overwritten for the upload.
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
    const yyyy = String(now.getFullYear());
    const mm = pad(now.getMonth() + 1);
    const day = `${yyyy}-${mm}-${pad(now.getDate())}`;
    const stamp = `${day}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    // MartPOS Backups / YYYY / MM / YYYY-MM-DD /
    const rootId = await getOrCreateFolder(service, DRIVE_FOLDER_NAME);
    const yearId = await getOrCreateFolder(service, yyyy, rootId);
    const monthId = await getOrCreateFolder(service, mm, yearId);
    const dayId = await getOrCreateFolder(service, day, monthId);

    const media = {
      mimeType: 'application/octet-stream',
      body: snapshot
    };

    const stampedFile = await service.files.create({
      resource: { name: `MartPOS-backup-${stamp}.db`, parents: [dayId] },
      media: media,
      fields: 'id, name, createdTime, size'
    });

    // Update or create latest.db at the root for quick identification
    const latestQuery = `name = 'latest.db' and '${rootId}' in parents and trashed = false`;
    const existingFiles = await service.files.list({
      q: latestQuery,
      spaces: 'drive',
      fields: 'files(id)'
    });

    let latestFile;
    if (existingFiles.data.files && existingFiles.data.files.length > 0) {
      latestFile = await service.files.update({
        fileId: existingFiles.data.files[0].id,
        media: media,
        fields: 'id, name'
      });
    } else {
      latestFile = await service.files.create({
        resource: { name: 'latest.db', parents: [rootId] },
        media: media,
        fields: 'id, name'
      });
    }

    const backedUpAt = now.toISOString();
    try {
      require('./settings').setSettings({ drive_last_backup_at: backedUpAt });
    } catch (e) {
      console.error('Could not record backup time:', e.message);
    }

    try {
      require('./backup').recordHistory({
        type: trigger, location: 'drive', name: stampedFile.data.name,
        status: 'success', size: snapshot.length
      });
    } catch (_) { /* history must not fail the backup */ }
    console.log(`Drive backup uploaded: ${stampedFile.data.name}`);

    return {
      ok: true,
      file: stampedFile.data,
      latest: latestFile.data,
      folder: DRIVE_FOLDER_NAME,
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
  try {
    const service = await buildService();
    await getOrCreateFolder(service, DRIVE_FOLDER_NAME);

    // Under the drive.file scope only files this app created are visible,
    // so a name filter across Drive finds backups inside the nested
    // YYYY/MM/DD folders as well as latest.db and legacy pos-*.db files.
    const response = await service.files.list({
      q: `trashed = false and (name contains 'MartPOS-backup-' or name = 'latest.db' or (name contains 'pos-' and name contains '.db'))`,
      spaces: 'drive',
      fields: 'files(id, name, createdTime, size, modifiedTime)',
      orderBy: 'createdTime desc'
    });

    return response.data.files || [];
  } catch (error) {
    if (error instanceof DriveError) throw error;
    throw new DriveError(friendlyMessage(error));
  }
}

// Validates credentials + Drive reachability and confirms the backup folder
// is accessible, without creating any files. Used by Settings -> Test
// connection. getOrCreateFolder reuses the existing folder, so repeated
// tests never create duplicates.
async function testConnection() {
  const service = await buildService();
  let email = '';
  try {
    const about = await service.about.get({ fields: 'user' });
    email = (about.data.user && about.data.user.emailAddress) || '';
  } catch (error) {
    throw new DriveError(friendlyMessage(error));
  }
  let folderId = null;
  try {
    folderId = await getOrCreateFolder(service, DRIVE_FOLDER_NAME);
  } catch (error) {
    throw new DriveError(friendlyMessage(error));
  }
  return { ok: true, email, folder: DRIVE_FOLDER_NAME, folder_id: folderId };
}

// Downloads a Drive backup into <data dir>/restores/ and validates it before
// anything touches the live database. Returns details for the confirm step.
async function prepareRestore(fileId) {
  const service = await buildService();

  const dir = path.join(getDataDir(), 'restores');
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `drive-${String(fileId).replace(/[^\w-]/g, '')}-${Date.now()}.db`);

  let driveName = '';
  try {
    const meta = await service.files.get({ fileId, fields: 'name, createdTime, size' });
    driveName = (meta.data && meta.data.name) || '';
    const response = await service.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    const dest = fs.createWriteStream(tmpPath);
    response.data.pipe(dest);
    await new Promise((resolve, reject) => {
      dest.on('finish', resolve);
      dest.on('error', reject);
      response.data.on('error', reject);
    });
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* nothing downloaded */ }
    throw new DriveError(friendlyMessage(error));
  }

  const { describeBackupFile } = require('./backup');
  const details = await describeBackupFile(tmpPath, driveName || path.basename(tmpPath));
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
  credentialsPresent,
  tokenPresent,
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
  friendlyMessage
};
