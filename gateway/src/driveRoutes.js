// Google Drive backup routes for the MartPOS gateway.
//
// The customer-facing flow is: desktop POS runs the Google loopback OAuth
// (offline access, drive.file scope) with the vendored developer client,
// then POSTs the resulting id_token + refresh_token here. The gateway
// re-verifies identity, proves the refresh token works, creates the
// "MARTPOS Backups" folder, encrypts the refresh token at rest, and only
// then reports the link as connected.
//
// After linking, the POS authenticates with the drive grant token
// (Bearer mpt_drv_...) returned by /v1/drive/link - or with its WhatsApp
// device token when the link was made under a registered shop. Google
// access/refresh tokens are NEVER returned to callers, logged, or stored
// in plaintext.
const express = require('express');
const store = require('./store');
const { sha256Hex, randomToken, encryptValue, decryptValue } = require('./cryptoUtil');
const { redactText } = require('./redact');
const { verifyGoogleIdToken, pruneBackups, BACKUP_FOLDER_NAME } = require('./driveApi');

const MAX_BACKUP_BYTES = '64mb';
const FILE_ID_RE = /^[\w-]{1,200}$/;
const BACKUP_NAME_RE = /^MartPOS-backup-[\w.-]{1,120}$/i;

function driveRoutes(app, { pool, config, drive, linkLimiter }) {
  const cfg = config.drive || {};

  // Bearer -> drive link. The POS presents its drive grant; a device token
  // resolves to the shop's live link instead. No request-input identity.
  async function resolveBearer(req) {
    const m = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const tokenHash = sha256Hex(m[1].trim());
    const link = await store.findDriveLinkByGrantHash(pool, tokenHash);
    if (link) return { link };
    const found = await store.findDeviceByTokenHash(pool, tokenHash);
    if (!found || found.shop.status !== 'active') return null;
    const shopLink = await store.findDriveLinkForShop(pool, found.shop.id);
    if (!shopLink) return null;
    return { link: shopLink, device: found.device, shop: found.shop };
  }

  async function driveAuth(req, res, next) {
    try {
      const resolved = await resolveBearer(req);
      if (!resolved) {
        return res.status(401).json({ ok: false, error: 'Drive grant or device token required' });
      }
      req.driveLink = resolved.link;
      req.device = resolved.device;
      req.shop = resolved.shop;
      next();
    } catch (e) {
      console.error('drive auth failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Auth error' });
    }
  }

  // Fresh access token for a link row: decrypts the stored refresh token,
  // exchanges it with Google, discards the plaintext immediately after.
  async function accessTokenFor(link) {
    const refreshToken = decryptValue({
      ciphertext: link.refresh_token_ciphertext,
      iv: link.refresh_token_iv,
      tag: link.refresh_token_tag
    }, config.encryptionKey);
    const t = await drive.refreshAccessToken(refreshToken);
    return t.accessToken;
  }

  // Map Drive/Google failures to friendly, non-secret responses.
  function driveError(res, e, { markError = null } = {}) {
    const status = (e && e.status) || 0;
    const msg = redactText((e && e.message) || 'Google Drive request failed');
    if (markError) markError(msg);
    if (status === 401 || /invalid_grant|unauthorized/i.test(msg)) {
      return res.status(409).json({
        ok: false, code: 'reconnect_required',
        error: 'Google Drive authorization expired - reconnect the account in MartPOS Settings.'
      });
    }
    if (status === 403) {
      return res.status(502).json({ ok: false, code: 'drive_denied', error: 'Google Drive denied the request - check Drive access and try again.' });
    }
    if (status === 404) {
      return res.status(404).json({ ok: false, code: 'not_found', error: 'Backup file was not found on Google Drive (it may have been deleted).' });
    }
    if (!status || /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up|network|fetch failed/i.test(msg)) {
      return res.status(503).json({ ok: false, code: 'offline', error: 'Google Drive is unreachable right now - the backup will be retried automatically.' });
    }
    return res.status(502).json({ ok: false, code: 'drive_error', error: 'Google Drive request failed - try again later.' });
  }

  const recordLinkError = (link) => (msg) =>
    store.markDriveLinkBackup(pool, link.id, { error: msg }).catch(() => {});

  // ---- public OAuth client vending -------------------------------------
  // The same developer-owned OAuth "Desktop app" client as AI sign-in.
  // Public by design (RFC 8252 installed-app clients are not confidential);
  // this is what removes any customer-side Google Cloud setup.
  app.get('/v1/drive/oauth-client', (req, res) => {
    if (!cfg.googleClientId) {
      return res.status(503).json({ ok: false, code: 'not_provisioned', error: 'Google Drive backup is not provisioned' });
    }
    return res.json({
      ok: true,
      google_client_id: cfg.googleClientId,
      google_client_secret: cfg.googleClientSecret || undefined
    });
  });

  // ---- link a Google Drive account --------------------------------------
  // The POS forwards the refresh_token + id_token obtained in its loopback
  // OAuth flow. Verified end-to-end here before anything is stored:
  //   id_token -> verified Google identity
  //   refresh token -> live Google exchange -> Drive about.get -> the Drive
  //   user's email must match the identity -> "MARTPOS Backups" folder
  //   created/found -> only then is the link persisted.
  app.post('/v1/drive/link', async (req, res) => {
    if (linkLimiter && linkLimiter(req.ip)) {
      return res.status(429).json({ ok: false, error: 'Too many attempts - try again later' });
    }
    if (!cfg.googleClientId || !config.encryptionKey) {
      return res.status(503).json({ ok: false, code: 'not_provisioned', error: 'Google Drive backup is not provisioned' });
    }
    const b = req.body || {};
    const idToken = String(b.id_token || '');
    const refreshToken = String(b.refresh_token || '');
    if (!idToken || !refreshToken) {
      return res.status(400).json({ ok: false, error: 'id_token and refresh_token are required' });
    }
    const identity = await verifyGoogleIdToken({ idToken, expectedAud: cfg.googleClientId });
    if (!identity) {
      return res.status(401).json({ ok: false, error: 'Google identity could not be verified' });
    }

    // Optional shop binding: a valid device token links this Drive
    // authorization to the shop so the device token can also call /v1/drive/*.
    let shopId = null;
    const bearer = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (bearer) {
      try {
        const found = await store.findDeviceByTokenHash(pool, sha256Hex(bearer[1].trim()));
        if (found && found.shop.status === 'active') shopId = found.shop.id;
      } catch (_) { /* unbound link is still valid */ }
    }

    try {
      const { accessToken } = await drive.refreshAccessToken(refreshToken);
      const driveUser = await drive.aboutGet(accessToken);
      if (driveUser.email && identity.email &&
          driveUser.email.toLowerCase() !== identity.email.toLowerCase()) {
        return res.status(400).json({ ok: false, error: 'The Drive account does not match the signed-in Google account' });
      }
      const folder = await drive.ensureBackupFolder(accessToken, BACKUP_FOLDER_NAME);
      const grantToken = `mpt_drv_${randomToken(32)}`;
      const refreshTokenEnc = encryptValue(refreshToken, config.encryptionKey);
      const link = await store.upsertDriveLink(pool, {
        shopId,
        googleSub: identity.sub,
        email: driveUser.email || identity.email,
        name: identity.name || driveUser.displayName,
        grantTokenHash: sha256Hex(grantToken),
        refreshTokenEnc,
        folderId: folder.id,
        folderName: BACKUP_FOLDER_NAME
      });
      // Return the escrowed backup key when one exists so a fresh install on
      // a new machine can decrypt its existing Drive backups.
      let escrowedKey = null;
      if (link.escrowedKey) {
        try { escrowedKey = decryptValue(link.escrowedKey, config.encryptionKey); } catch (_) { escrowedKey = null; }
      }
      return res.json({
        ok: true,
        drive_token: grantToken,
        email: driveUser.email || identity.email,
        name: identity.name || driveUser.displayName || '',
        folder_name: BACKUP_FOLDER_NAME,
        backup_key: escrowedKey || undefined
      });
    } catch (e) {
      console.error('drive link failed:', redactText(e.message || 'error'));
      return driveError(res, e);
    }
  });

  // ---- status -----------------------------------------------------------
  app.get('/v1/drive/status', driveAuth, (req, res) => {
    const l = req.driveLink;
    return res.json({
      ok: true,
      connected: l.status === 'connected',
      email: l.email || '',
      name: l.name || '',
      folder_name: l.folder_name || BACKUP_FOLDER_NAME,
      last_backup_at: l.last_backup_at || null,
      last_error: l.last_error || '',
      connected_at: l.created_at || null
    });
  });

  // ---- backup upload ----------------------------------------------------
  // The POS sends the already-encrypted backup as a raw octet-stream; the
  // gateway never sees plaintext shop data and keeps nothing after upload.
  app.post('/v1/drive/backup', driveAuth, express.raw({ type: 'application/octet-stream', limit: MAX_BACKUP_BYTES }), async (req, res) => {
    const link = req.driveLink;
    const name = String(req.get('x-backup-name') || '');
    if (!BACKUP_NAME_RE.test(name)) {
      return res.status(400).json({ ok: false, error: 'A valid x-backup-name header is required' });
    }
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ ok: false, error: 'Encrypted backup content is required' });
    }
    try {
      const accessToken = await accessTokenFor(link);
      const folderId = link.folder_id ||
        (await drive.ensureBackupFolder(accessToken, BACKUP_FOLDER_NAME)).id;
      const file = await drive.uploadBackup(accessToken, {
        name,
        parentId: folderId,
        mimeType: 'application/octet-stream',
        buffer
      });
      const backedUpAt = new Date().toISOString();
      await store.markDriveLinkBackup(pool, link.id, { at: backedUpAt }).catch(() => {});
      pruneBackups(drive, accessToken).catch(() => {});
      return res.json({
        ok: true,
        file: { id: file.id, name: file.name, createdTime: file.createdTime, size: file.size },
        folder_name: link.folder_name || BACKUP_FOLDER_NAME,
        backed_up_at: backedUpAt
      });
    } catch (e) {
      console.error('drive backup failed:', redactText(e.message || 'error'));
      return driveError(res, e, { markError: recordLinkError(link) });
    }
  });

  // ---- list backups ------------------------------------------------------
  app.get('/v1/drive/backups', driveAuth, async (req, res) => {
    try {
      const accessToken = await accessTokenFor(req.driveLink);
      const files = await drive.listBackups(accessToken);
      return res.json({
        ok: true,
        files: files.map((f) => ({
          id: f.id, name: f.name,
          createdTime: f.createdTime, modifiedTime: f.modifiedTime,
          size: f.size ? Number(f.size) : 0
        }))
      });
    } catch (e) {
      console.error('drive list failed:', redactText(e.message || 'error'));
      return driveError(res, e, { markError: recordLinkError(req.driveLink) });
    }
  });

  // ---- backup metadata ---------------------------------------------------
  app.get('/v1/drive/backup/:id', driveAuth, async (req, res) => {
    const fileId = String(req.params.id || '');
    if (!FILE_ID_RE.test(fileId)) {
      return res.status(400).json({ ok: false, error: 'Invalid backup id' });
    }
    try {
      const accessToken = await accessTokenFor(req.driveLink);
      const f = await drive.getFileMeta(accessToken, fileId);
      return res.json({
        ok: true,
        file: { id: f.id, name: f.name, createdTime: f.createdTime, modifiedTime: f.modifiedTime, size: f.size ? Number(f.size) : 0 }
      });
    } catch (e) {
      console.error('drive meta failed:', redactText(e.message || 'error'));
      return driveError(res, e);
    }
  });

  // ---- restore (download the encrypted backup) ---------------------------
  // The blob is returned as-is - the POS decrypts and validates it locally
  // before anything touches the live database.
  app.post('/v1/drive/restore', driveAuth, async (req, res) => {
    const fileId = String((req.body || {}).file_id || '');
    if (!FILE_ID_RE.test(fileId)) {
      return res.status(400).json({ ok: false, error: 'file_id is required' });
    }
    try {
      const accessToken = await accessTokenFor(req.driveLink);
      const meta = await drive.getFileMeta(accessToken, fileId).catch(() => null);
      const blob = await drive.downloadFile(accessToken, fileId);
      res.setHeader('content-type', 'application/octet-stream');
      if (meta && meta.name) res.setHeader('x-backup-name', String(meta.name));
      return res.send(blob);
    } catch (e) {
      console.error('drive restore failed:', redactText(e.message || 'error'));
      return driveError(res, e);
    }
  });

  // ---- escrow the device's backup-encryption key --------------------------
  // Stored encrypted at rest like the refresh token. Returned by
  // POST /v1/drive/link to installs that re-link the same account, which is
  // what makes disaster recovery onto a new machine possible.
  app.post('/v1/drive/backup-key', driveAuth, async (req, res) => {
    const key = String((req.body || {}).backup_key || '');
    let decoded;
    try { decoded = Buffer.from(key, 'base64'); } catch (_) { decoded = null; }
    if (!decoded || decoded.length !== 32) {
      return res.status(400).json({ ok: false, error: 'backup_key must be a base64-encoded 32-byte key' });
    }
    try {
      await store.setDriveLinkBackupKey(pool, req.driveLink.id, encryptValue(key, config.encryptionKey));
      return res.json({ ok: true });
    } catch (e) {
      console.error('drive backup-key failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Could not store the backup key' });
    }
  });

  // ---- disconnect ---------------------------------------------------------
  // Revokes the Google grant best-effort and deletes the stored credentials.
  // The customer's backup files on Drive are deliberately left alone.
  app.delete('/v1/drive/link', driveAuth, async (req, res) => {
    const link = req.driveLink;
    try {
      const refreshToken = decryptValue({
        ciphertext: link.refresh_token_ciphertext,
        iv: link.refresh_token_iv,
        tag: link.refresh_token_tag
      }, config.encryptionKey);
      await drive.revokeToken(refreshToken).catch(() => {});
    } catch (_) { /* revoke best-effort */ }
    try {
      await store.revokeDriveLink(pool, link.id);
      return res.json({ ok: true });
    } catch (e) {
      console.error('drive unlink failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Unlink failed' });
    }
  });
}

module.exports = { driveRoutes };
