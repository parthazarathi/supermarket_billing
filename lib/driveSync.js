const fs = require('fs');
const { google } = require('googleapis');
const { getCredentialsPath, getTokenPath } = require('./paths');

const DRIVE_FOLDER_NAME = 'MartPOS Backups';
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const BACKUP_INTERVALS = { '6h': 6 * 60 * 60 * 1000, 'daily': 24 * 60 * 60 * 1000, 'on_exit': Infinity };

class DriveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DriveError';
  }
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
  return {
    credentials: credentialsPresent(),
    connected: tokenPresent(),
    credentials_path: getCredentialsPath(),
    token_path: getTokenPath(),
    folder: DRIVE_FOLDER_NAME,
    email: readSetting('drive_email', ''),
    auto_backup: readSetting('drive_auto_backup', '0') === '1',
    backup_interval: readSetting('drive_backup_interval', 'daily'),
    last_backup_at: readSetting('drive_last_backup_at', '')
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
        throw new DriveError('Failed to refresh access token');
      }
    }

    return google.drive({ version: 'v3', auth: oAuth2Client });
  } catch (error) {
    if (error instanceof DriveError) throw error;
    if (error.code === 'MODULE_NOT_FOUND') {
      throw new DriveError('Google Drive libraries are not installed');
    }
    throw new DriveError(error.message);
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
    throw new DriveError(error.message);
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

async function backupDatabase() {
  try {
    const service = await buildService();

    // Flush pending changes, then export a consistent in-memory snapshot.
    // pos.db itself is never read or overwritten for the upload.
    const { exportSnapshot } = require('./database');
    const snapshot = exportSnapshot();
    if (!snapshot || snapshot.length === 0) {
      throw new DriveError('Local database not found');
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

    return {
      ok: true,
      file: stampedFile.data,
      latest: latestFile.data,
      folder: DRIVE_FOLDER_NAME,
      backed_up_at: backedUpAt
    };
  } catch (error) {
    if (error instanceof DriveError) throw error;
    throw new DriveError(error.message);
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
    throw new DriveError(error.message);
  }
}

async function restoreDatabase(fileId) {
  try {
    const service = await buildService();
    const { getDbPath } = require('./paths');
    const dbPath = getDbPath();
    const tmpPath = dbPath + '.restore';

    const response = await service.files.get({
      fileId: fileId,
      alt: 'media'
    }, { responseType: 'stream' });

    const dest = fs.createWriteStream(tmpPath);
    response.data.pipe(dest);

    await new Promise((resolve, reject) => {
      dest.on('finish', resolve);
      dest.on('error', reject);
    });

    fs.renameSync(tmpPath, dbPath);

    return { ok: true, path: dbPath };
  } catch (error) {
    if (error instanceof DriveError) throw error;
    throw new DriveError(error.message);
  }
}

async function tryAutoBackup() {
  try {
    return await backupDatabase();
  } catch (error) {
    return { ok: false, error: error.message };
  }
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
  restoreDatabase,
  tryAutoBackup
};
