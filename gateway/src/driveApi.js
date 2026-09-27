// Minimal Google Drive client for the MartPOS backup pipeline.
//
// The gateway is the only component that ever holds a customer's Google
// refresh token (encrypted at rest in drive_links). This client wraps the
// handful of Google endpoints the backup flow needs:
//
//   oauth2.googleapis.com/token        refresh_token -> access_token
//   oauth2.googleapis.com/revoke       best-effort grant revocation
//   oauth2.googleapis.com/tokeninfo    id_token verification
//   www.googleapis.com/drive/v3/files  folder + backup metadata
//   www.googleapis.com/upload/...      multipart backup upload
//
// Only the narrow https://www.googleapis.com/auth/drive.file scope is used -
// the app can only see files/folders it created itself. The fetch
// implementation is injectable so tests never reach Google.
const { redactText } = require('./redact');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const BACKUP_FOLDER_NAME = 'MARTPOS Backups';
const BACKUP_NAME_RE = /^MartPOS-backup-[\w.-]+\.\w+$/i;
const KEEP_BACKUPS = 30;

class DriveApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(redactText(message || 'Google Drive request failed'));
    this.name = 'DriveApiError';
    this.status = status;
    this.code = code;
  }
}

// Re-verify a Google id_token server-side (signature, expiry, issuer and our
// client_id audience) before trusting the identity. Same contract as the AI
// link verification in app.js.
async function verifyGoogleIdToken({ idToken, expectedAud, fetchImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (!expectedAud || !idToken) return null;
  let res;
  try {
    res = await fetchFn(
      `${TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`,
      { signal: AbortSignal.timeout(10000) }
    );
  } catch (_) {
    return null;
  }
  if (!res.ok) return null;
  const p = await res.json().catch(() => null);
  if (!p || p.aud !== expectedAud) return null;
  if (p.iss !== 'accounts.google.com' && p.iss !== 'https://accounts.google.com') return null;
  if (p.email_verified !== 'true' && p.email_verified !== true) return null;
  if (p.exp && Number(p.exp) * 1000 < Date.now()) return null;
  if (!p.sub || !p.email) return null;
  return { sub: String(p.sub), email: String(p.email), name: String(p.name || '') };
}

class DriveApi {
  constructor({ clientId = '', clientSecret = '', fetchImpl } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async json(res, what) {
    let body = null;
    try { body = await res.json(); } catch (_) { /* non-json */ }
    if (!res.ok) {
      const msg = (body && body.error && (body.error.message || body.error)) || `HTTP ${res.status}`;
      throw new DriveApiError(`${what}: ${msg}`, { status: res.status, code: (body && body.error && body.error.status) || '' });
    }
    return body;
  }

  // Exchanges a stored refresh token for a fresh access token. Called on
  // every Drive operation - access tokens expire within the hour and are
  // never persisted, so refreshing per call keeps behavior obvious.
  async refreshAccessToken(refreshToken) {
    let res;
    try {
      res = await this.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        }).toString(),
        signal: AbortSignal.timeout(15000)
      });
    } catch (e) {
      throw new DriveApiError(e.message || 'network error');
    }
    const body = await this.json(res, 'Google token refresh failed');
    if (!body || !body.access_token) {
      throw new DriveApiError('Google token refresh failed: no access token returned');
    }
    return { accessToken: body.access_token, expiresIn: body.expires_in || 0 };
  }

  // Best-effort revocation - failures are swallowed by the caller.
  async revokeToken(token) {
    let res;
    try {
      res = await this.fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
        signal: AbortSignal.timeout(10000)
      });
    } catch (e) {
      throw new DriveApiError(e.message || 'network error');
    }
    if (!res.ok) throw new DriveApiError(`Token revoke failed: HTTP ${res.status}`, { status: res.status });
    return true;
  }

  async request(accessToken, method, path, { query, body, headers = {}, upload = false, raw = false } = {}) {
    const base = upload ? UPLOAD_BASE : DRIVE_BASE;
    const qs = query
      ? '?' + Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
      : '';
    const h = { authorization: `Bearer ${accessToken}`, ...headers };
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    let res;
    try {
      res = await this.fetch(`${base}${path}${qs}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)),
        signal: AbortSignal.timeout(raw ? 120000 : 30000)
      });
    } catch (e) {
      throw new DriveApiError(e.message || 'network error');
    }
    if (raw) {
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = (j && j.error && j.error.message) || msg; } catch (_) { /* ignore */ }
        throw new DriveApiError(`Drive download failed: ${msg}`, { status: res.status });
      }
      return Buffer.from(await res.arrayBuffer());
    }
    return this.json(res, 'Google Drive request failed');
  }

  // Identity of the connected Google account, as seen by Drive itself.
  async aboutGet(accessToken) {
    const data = await this.request(accessToken, 'GET', '/about', { query: { fields: 'user' } });
    const user = (data && data.user) || {};
    return { email: user.emailAddress || '', displayName: user.displayName || '' };
  }

  async findFolder(accessToken, name, parentId = '') {
    let q = `name = '${String(name).replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    if (parentId) q += ` and '${parentId}' in parents`;
    const data = await this.request(accessToken, 'GET', '/files', {
      query: { q, spaces: 'drive', fields: 'files(id, name)' }
    });
    const files = (data && data.files) || [];
    return files.length ? files[0].id : '';
  }

  async createFolder(accessToken, name, parentId = '') {
    const meta = { name, mimeType: FOLDER_MIME };
    if (parentId) meta.parents = [parentId];
    const data = await this.request(accessToken, 'POST', '/files', {
      query: { fields: 'id' },
      body: meta
    });
    return data.id;
  }

  // Locate or create the customer-visible backup folder in My Drive.
  async ensureBackupFolder(accessToken, name = BACKUP_FOLDER_NAME) {
    const existing = await this.findFolder(accessToken, name);
    if (existing) return { id: existing, created: false };
    const id = await this.createFolder(accessToken, name);
    return { id, created: true };
  }

  // Multipart/related upload: metadata + encrypted content in one request.
  async uploadBackup(accessToken, { name, parentId, mimeType = 'application/octet-stream', buffer }) {
    const boundary = `martpos_${Date.now().toString(36)}`;
    const meta = JSON.stringify({ name, parents: parentId ? [parentId] : undefined });
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const payload = Buffer.concat([Buffer.from(head, 'utf8'), buffer, Buffer.from(tail, 'utf8')]);
    return this.request(accessToken, 'POST', '/files', {
      upload: true,
      query: { uploadType: 'multipart', fields: 'id, name, createdTime, size' },
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body: payload
    });
  }

  // Backup files visible under the drive.file scope: only files this app
  // created. Sorted newest-first for display and pruning.
  async listBackups(accessToken) {
    const data = await this.request(accessToken, 'GET', '/files', {
      query: {
        q: `trashed = false and mimeType != '${FOLDER_MIME}' and name contains 'MartPOS-backup-'`,
        spaces: 'drive',
        fields: 'files(id, name, createdTime, modifiedTime, size)',
        orderBy: 'createdTime desc',
        pageSize: 200
      }
    });
    return (data && data.files) || [];
  }

  async getFileMeta(accessToken, fileId) {
    return this.request(accessToken, 'GET', `/files/${encodeURIComponent(fileId)}`, {
      query: { fields: 'id, name, createdTime, modifiedTime, size, mimeType' }
    });
  }

  async downloadFile(accessToken, fileId) {
    return this.request(accessToken, 'GET', `/files/${encodeURIComponent(fileId)}`, {
      query: { alt: 'media' },
      raw: true
    });
  }

  async deleteFile(accessToken, fileId) {
    return this.request(accessToken, 'DELETE', `/files/${encodeURIComponent(fileId)}`);
  }
}

// Retention: keep the newest KEEP_BACKUPS in the Drive folder. Only
// app-created files are ever visible under drive.file.
async function pruneBackups(drive, accessToken, keep = KEEP_BACKUPS) {
  const files = await drive.listBackups(accessToken);
  const extra = files.filter((f) => BACKUP_NAME_RE.test(f.name || '')).slice(keep);
  for (const f of extra) {
    try { await drive.deleteFile(accessToken, f.id); } catch (_) { /* best effort */ }
  }
  return extra.length;
}

module.exports = {
  DriveApi,
  DriveApiError,
  verifyGoogleIdToken,
  pruneBackups,
  BACKUP_FOLDER_NAME,
  KEEP_BACKUPS
};
