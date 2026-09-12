const fs = require('fs');
const { google } = require('googleapis');
const { getCredentialsPath, getTokenPath, getDbPath } = require('./paths');

const DRIVE_FOLDER_NAME = 'MartPOS Backups';
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

class DriveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DriveError';
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
    folder: DRIVE_FOLDER_NAME
  };
}

async function buildService() {
  try {
    const { google } = require('googleapis');
    const credentialsPath = getCredentialsPath();
    const tokenPath = getTokenPath();
    
    if (!fs.existsSync(tokenPath)) {
      throw new DriveError('Google Drive is not connected');
    }

    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    oAuth2Client.setCredentials(token);

    // Refresh token if expired
    if (token.expiry_date && token.expiry_date < Date.now()) {
      try {
        const { credentials: newCredentials } = await oAuth2Client.refreshAccessToken();
        fs.writeFileSync(tokenPath, JSON.stringify(newCredentials));
        oAuth2Client.setCredentials(newCredentials);
      } catch (refreshError) {
        throw new DriveError('Failed to refresh access token');
      }
    }

    return google.drive({ version: 'v3', auth: oAuth2Client });
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      throw new DriveError('Google Drive libraries are not installed');
    }
    throw new DriveError(error.message);
  }
}

async function connectOAuth() {
  try {
    const { google } = require('googleapis');
    const http = require('http');
    const url = require('url');
    
    const credentialsPath = getCredentialsPath();
    if (!fs.existsSync(credentialsPath)) {
      throw new DriveError(`Place Google OAuth credentials.json at ${credentialsPath}`);
    }

    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    // Create a simple local server for OAuth callback
    const port = 3000;
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES
    });

    console.log('Authorize this app by visiting this URL:', authUrl);
    console.log('Waiting for authorization code...');

    // Try to open browser automatically
    try {
      const open = require('open');
      await open(authUrl);
    } catch (e) {
      console.log('Could not open browser automatically. Please visit the URL manually.');
    }

    // Exchange code for tokens
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const query = url.parse(req.url, true).query;
          const code = query.code;

          if (code) {
            const { tokens } = await oAuth2Client.getToken(code);
            oAuth2Client.setCredentials(tokens);
            
            const tokenPath = getTokenPath();
            fs.writeFileSync(tokenPath, JSON.stringify(tokens));

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Authentication successful! You can close this window.</h1>');
            
            server.close();
            resolve(status());
          } else {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<h1>No authorization code found</h1>');
            server.close();
            reject(new DriveError('No authorization code received'));
          }
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end('<h1>Authentication failed</h1>');
          server.close();
          reject(new DriveError(error.message));
        }
      });

      server.listen(port, () => {
        console.log(`OAuth callback server listening on port ${port}`);
      });
    });
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      throw new DriveError('Google Drive libraries are not installed');
    }
    throw new DriveError(error.message);
  }
}

function disconnect() {
  const tokenPath = getTokenPath();
  if (fs.existsSync(tokenPath)) {
    fs.unlinkSync(tokenPath);
  }
}

async function getOrCreateFolder(service) {
  const query = `name = '${DRIVE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  
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
    name: DRIVE_FOLDER_NAME,
    mimeType: 'application/vnd.google-apps.folder'
  };

  const folder = await service.files.create({
    resource: fileMetadata,
    fields: 'id'
  });

  return folder.data.id;
}

async function backupDatabase() {
  try {
    const service = await buildService();
    const folderId = await getOrCreateFolder(service);
    const dbPath = getDbPath();

    if (!fs.existsSync(dbPath)) {
      throw new DriveError('Local database not found');
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const stampedName = `pos-${stamp}.db`;

    // Upload timestamped backup
    const fileMetadata = {
      name: stampedName,
      parents: [folderId]
    };

    const media = {
      mimeType: 'application/octet-stream',
      body: fs.createReadStream(dbPath)
    };

    const stampedFile = await service.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, createdTime, size'
    });

    // Update or create latest.db
    const latestQuery = `name = 'latest.db' and '${folderId}' in parents and trashed = false`;
    const existingFiles = await service.files.list({
      q: latestQuery,
      spaces: 'drive',
      fields: 'files(id)'
    });

    const latestData = fs.readFileSync(dbPath);
    const latestMedia = {
      mimeType: 'application/octet-stream',
      body: Buffer.from(latestData)
    };

    let latestFile;
    if (existingFiles.data.files && existingFiles.data.files.length > 0) {
      const existingId = existingFiles.data.files[0].id;
      latestFile = await service.files.update({
        fileId: existingId,
        media: latestMedia,
        fields: 'id, name'
      });
    } else {
      const latestMetadata = {
        name: 'latest.db',
        parents: [folderId]
      };
      latestFile = await service.files.create({
        resource: latestMetadata,
        media: latestMedia,
        fields: 'id, name'
      });
    }

    return {
      ok: true,
      file: stampedFile.data,
      latest: latestFile.data,
      folder: DRIVE_FOLDER_NAME
    };
  } catch (error) {
    throw new DriveError(error.message);
  }
}

async function listBackups() {
  try {
    const service = await buildService();
    const folderId = await getOrCreateFolder(service);

    const response = await service.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      spaces: 'drive',
      fields: 'files(id, name, createdTime, size, modifiedTime)',
      orderBy: 'createdTime desc'
    });

    return response.data.files || [];
  } catch (error) {
    throw new DriveError(error.message);
  }
}

async function restoreDatabase(fileId) {
  try {
    const service = await buildService();
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
  connectOAuth,
  disconnect,
  backupDatabase,
  listBackups,
  restoreDatabase,
  tryAutoBackup
};
