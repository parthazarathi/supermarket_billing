// Unit tests for Google Drive backup via the MartPOS gateway.
//
// Covers the whole redesigned flow without real Google calls:
//   POS loopback OAuth (offline access, drive.file) -> /v1/drive/link ->
//   encrypted refresh token at rest -> encrypted backup upload ->
//   restore validation -> change-account safety -> disconnect.
// The gateway runs as a real Express app on loopback with an in-memory
// pool and an injected fake Google Drive client.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'martpos-drv-'));
process.env.MARTPOS_DATA_DIR = scratch;
process.env.MARTPOS_SECRET_KEY = crypto.randomBytes(32).toString('base64');
process.env.NODE_ENV = 'test';

const results = [];
let failures = 0;
function check(id, title, cond, note = '') {
  const pass = !!cond;
  if (!pass) failures += 1;
  results.push({ id, title, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${title}${pass ? '' : ` :: ${note}`}`);
}

const CLIENT_ID = 'cid.apps.googleusercontent.com';
const ENC_KEY = crypto.randomBytes(32);

function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}
const ID_TOKEN_1 = jwt({ sub: 'sub-1', email: 'owner@gmail.com', email_verified: true, name: 'Shop Owner' });
const ID_TOKEN_2 = jwt({ sub: 'sub-2', email: 'other@gmail.com', email_verified: true, name: 'Other Owner' });

(async () => {
  await require('../lib/database').initDatabase();
  const { exportSnapshot, validateDatabaseBuffer, execToObjects } = require('../lib/database');
  const secrets = require('../lib/secrets');
  const driveSync = require('../lib/driveSync');
  const { loadConfig } = require('../gateway/src/config');
  const { createApp } = require('../gateway/src/app');
  const { sha256Hex, decryptValue } = require('../gateway/src/cryptoUtil');
  const { createLocalBackup } = require('../lib/backup');

  // ---------- in-memory gateway pool (drive_links + devices) ----------
  const links = new Map(); // id -> row
  const deviceByHash = new Map();
  deviceByHash.set(sha256Hex('mpt_dev1'), {
    device_id: 'dev-1', device_name: 'POS', shop_id: 'shop-1', shop_name: 'Corner Store', shop_status: 'active'
  });
  const liveLinks = () => [...links.values()].filter((r) => !r.revoked_at);
  const sqlLog = [];
  const handler = async (sql, params = []) => {
    sqlLog.push(sql);
    if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [], rowCount: 0 };
    if (/UPDATE devices SET last_seen_at/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT d\.id AS device_id/.test(sql)) {
      const d = deviceByHash.get(params[0]);
      return { rows: d ? [d] : [], rowCount: d ? 1 : 0 };
    }
    if (/SELECT id, backup_key_ciphertext.*FROM drive_links\s+WHERE shop_id = \$1/s.test(sql)) {
      const r = liveLinks().filter((x) => x.shop_id === params[0]).sort((a, b) => b.seq - a.seq);
      return { rows: r, rowCount: r.length };
    }
    if (/FROM drive_links\s+WHERE google_sub = \$1 AND shop_id IS NULL/s.test(sql)) {
      const r = liveLinks().filter((x) => x.google_sub === params[0] && !x.shop_id).sort((a, b) => b.seq - a.seq);
      return { rows: r, rowCount: r.length };
    }
    if (/FROM drive_links WHERE grant_token_hash = \$1 AND revoked_at IS NULL/s.test(sql)) {
      const r = liveLinks().filter((x) => x.grant_token_hash === params[0]);
      return { rows: r, rowCount: r.length };
    }
    if (/FROM drive_links WHERE shop_id = \$1 AND revoked_at IS NULL ORDER BY created_at DESC/s.test(sql)) {
      const r = liveLinks().filter((x) => x.shop_id === params[0]).sort((a, b) => b.seq - a.seq);
      return { rows: r.slice(0, 1), rowCount: r.length ? 1 : 0 };
    }
    if (/UPDATE drive_links SET grant_token_hash = \$2/.test(sql)) {
      const r = links.get(params[0]);
      const names = ['grant_token_hash', 'google_sub', 'email', 'name',
        'refresh_token_ciphertext', 'refresh_token_iv', 'refresh_token_tag',
        'folder_id', 'folder_name', 'status'];
      names.forEach((n, i) => { r[n] = params[i + 1]; });
      r.shop_id = params[11] || null;
      r.revoked_at = null;
      r.last_error = '';
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO drive_links/.test(sql)) {
      const names = ['grant_token_hash', 'google_sub', 'email', 'name',
        'refresh_token_ciphertext', 'refresh_token_iv', 'refresh_token_tag',
        'folder_id', 'folder_name', 'status'];
      const row = { id: params[0], seq: seqNo++, revoked_at: null, last_error: '', last_backup_at: null, created_at: new Date().toISOString() };
      names.forEach((n, i) => { row[n] = params[i + 1]; });
      row.shop_id = params[11] || null;
      row.backup_key_ciphertext = row.backup_key_iv = row.backup_key_tag = '';
      links.set(row.id, row);
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE drive_links SET last_seen_at/.test(sql)) return { rows: [], rowCount: 1 };
    if (/UPDATE drive_links SET backup_key_ciphertext = \$2/.test(sql)) {
      const r = links.get(params[0]);
      r.backup_key_ciphertext = params[1]; r.backup_key_iv = params[2]; r.backup_key_tag = params[3];
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE drive_links SET last_backup_at = \$2/.test(sql)) {
      links.get(params[0]).last_backup_at = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE drive_links SET last_error = \$2/.test(sql)) {
      links.get(params[0]).last_error = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE drive_links SET revoked_at = now\(\), grant_token_hash = NULL/.test(sql)) {
      const r = links.get(params[0]);
      r.revoked_at = new Date().toISOString();
      r.grant_token_hash = null;
      r.refresh_token_ciphertext = r.refresh_token_iv = r.refresh_token_tag = '';
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  let seqNo = 1;
  const gwPool = {
    query: (sql, params) => handler(sql, params),
    connect: async () => ({ query: (sql, params) => handler(sql, params), release() {} })
  };

  // ---------- fake Google Drive client ----------
  const driveCalls = [];
  const driveFiles = new Map(); // id -> {id,name,buffer,createdTime,size}
  let fileSeq = 1;
  const fakeDrive = {
    refreshAccessToken: async (rt) => {
      driveCalls.push(['refresh', rt]);
      if (rt === 'rt-good') return { accessToken: 'at-1', expiresIn: 3600 };
      throw Object.assign(new Error('invalid_grant'), { status: 400 });
    },
    aboutGet: async (at) => { driveCalls.push(['about', at]); return { email: 'owner@gmail.com', displayName: 'Shop Owner' }; },
    ensureBackupFolder: async (at, name) => { driveCalls.push(['ensureFolder', name]); return { id: 'folder-1', created: true }; },
    uploadBackup: async (at, { name, parentId, buffer }) => {
      driveCalls.push(['upload', name, parentId]);
      const f = { id: `f-${fileSeq++}`, name, buffer, createdTime: '2026-09-27T10:00:00.000Z', size: String(buffer.length) };
      driveFiles.set(f.id, f);
      return { id: f.id, name: f.name, createdTime: f.createdTime, size: f.size };
    },
    listBackups: async () => [...driveFiles.values()].map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime, modifiedTime: f.createdTime, size: f.size })),
    getFileMeta: async (at, id) => {
      const f = driveFiles.get(id);
      if (!f) throw Object.assign(new Error('file not found'), { status: 404 });
      return { id: f.id, name: f.name, createdTime: f.createdTime, size: f.size };
    },
    downloadFile: async (at, id) => {
      const f = driveFiles.get(id);
      if (!f) throw Object.assign(new Error('file not found'), { status: 404 });
      return f.buffer;
    },
    deleteFile: async (at, id) => { driveCalls.push(['delete', id]); driveFiles.delete(id); return {}; },
    revokeToken: async (t) => { driveCalls.push(['revoke', t]); return true; }
  };

  const gwConfig = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x',
    GATEWAY_PUBLIC_URL: 'https://gw.example.com',
    GATEWAY_ENCRYPTION_KEY: ENC_KEY.toString('base64'),
    META_APP_ID: 'a', META_APP_SECRET: 's', META_EMBEDDED_SIGNUP_CONFIG_ID: 'c',
    META_WEBHOOK_VERIFY_TOKEN: 'v',
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: 'cs-secret'
  });
  const gwApp = createApp({ config: gwConfig, pool: gwPool, driveFor: () => fakeDrive });
  const gwServer = await new Promise((resolve) => { const s = gwApp.listen(0, '127.0.0.1', () => resolve(s)); });
  const gwPort = gwServer.address().port;
  process.env.MARTPOS_CLOUD_URL = `http://127.0.0.1:${gwPort}`;

  // ---------- network stubs ----------
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      const idToken = new URL(u).searchParams.get('id_token');
      const claims = idToken ? JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()) : null;
      if (!claims) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify({
        aud: CLIENT_ID, iss: 'accounts.google.com', email_verified: 'true',
        exp: String(Math.floor(Date.now() / 1000) + 3600),
        sub: claims.sub, email: claims.email, name: claims.name || ''
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, opts);
  };

  // Patch the OAuth2 code exchange (deterministic tokens per connect attempt)
  // and the browser opener (captures the auth URL + simulates the redirect).
  const { google } = require('googleapis');
  const tokenQueue = [];
  const origGetToken = google.auth.OAuth2.prototype.getToken;
  google.auth.OAuth2.prototype.getToken = async function () {
    const t = tokenQueue.length ? tokenQueue.shift() : {
      access_token: 'at-pos', refresh_token: 'rt-good', id_token: ID_TOKEN_1
    };
    this.setCredentials(t);
    return { tokens: t };
  };
  let capturedAuthUrl = '';
  const openPath = require.resolve('open');
  const origOpen = require('open');
  require.cache[openPath].exports = async (url) => {
    capturedAuthUrl = url;
    const ru = new URL(url);
    const redirect = ru.searchParams.get('redirect_uri');
    const state = ru.searchParams.get('state');
    await realFetch(`${redirect}?code=test-code&state=${encodeURIComponent(state)}`);
  };

  // Log capture for the token-hygiene checks.
  const logLines = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => logLines.push(a.map(String).join(' '));
  console.error = (...a) => logLines.push(a.map(String).join(' '));

  try {
    // ---------- DRIVE-014 / DRIVE-015 / DRIVE-016: pre-connect hygiene ----------
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'driveSync.js'), 'utf8');
    check('DRIVE-014', 'drive flow never reads credentials.json or token.json',
      !/getCredentialsPath|getTokenPath/.test(src) && !fs.existsSync(path.join(scratch, 'credentials.json')));
    check('DRIVE-014b', 'status() works with zero local credentials',
      driveSync.status().connected === false && driveSync.status().available === true);

    // ---------- DRIVE-001: OAuth client resolution ----------
    const gwStatus = await realFetch(`http://127.0.0.1:${gwPort}/v1/drive/oauth-client`).then((r) => r.json());
    check('DRIVE-001a', 'gateway vendors the OAuth client publicly',
      gwStatus.ok === true && gwStatus.google_client_id === CLIENT_ID);
    const cfg = await driveSync.fetchDriveOAuthClient();
    check('DRIVE-001b', 'POS resolves vendored OAuth client via gateway',
      cfg && cfg.client_id === CLIENT_ID);

    // ---------- connect flow ----------
    secrets.setSecret('cloud_device_token', 'mpt_dev1'); // binds the link to shop-1
    let connected = null;
    try { connected = await driveSync.connectOAuth(); } catch (e) { connected = { error: e.message }; }

    check('DRIVE-002', 'OAuth requests offline access for a refresh token',
      /access_type=offline/.test(capturedAuthUrl), capturedAuthUrl.slice(0, 200));
    const scopeParam = decodeURIComponent(new URL(capturedAuthUrl).searchParams.get('scope') || '');
    const scopes = scopeParam.split(' ');
    check('DRIVE-003', 'scope is drive.file only - no full-drive or unrelated scopes',
      scopes.includes('https://www.googleapis.com/auth/drive.file') &&
      !scopes.includes('https://www.googleapis.com/auth/drive') &&
      scopes.includes('openid') && scopes.includes('email') && scopes.includes('profile'), scopeParam);
    check('DRIVE-002b', 'account picker shown for connect/change',
      /select_account/.test(new URL(capturedAuthUrl).searchParams.get('prompt') || ''));
    check('DRIVE-002c', 'connect completes and marks status connected',
      connected && connected.connected === true && connected.email === 'owner@gmail.com',
      JSON.stringify(connected).slice(0, 200));

    // ---------- link verification + folder + encrypted storage ----------
    check('DRIVE-005a', 'gateway verified Drive access before linking',
      driveCalls.some((c) => c[0] === 'refresh' && c[1] === 'rt-good') &&
      driveCalls.some((c) => c[0] === 'about' && c[1] === 'at-1'));
    check('DRIVE-006', 'MARTPOS Backups folder created/found during link',
      driveCalls.some((c) => c[0] === 'ensureFolder' && c[1] === 'MARTPOS Backups'));
    const linkRow = [...links.values()][0];
    check('DRIVE-005b', 'link bound to the shop via device token', linkRow && linkRow.shop_id === 'shop-1');
    check('DRIVE-004a', 'refresh token stored encrypted - no plaintext at rest',
      linkRow && linkRow.refresh_token_ciphertext && linkRow.refresh_token_ciphertext !== 'rt-good' &&
      !JSON.stringify(linkRow).includes('rt-good'));
    check('DRIVE-004b', 'stored ciphertext decrypts to the refresh token',
      decryptValue({ ciphertext: linkRow.refresh_token_ciphertext, iv: linkRow.refresh_token_iv, tag: linkRow.refresh_token_tag }, ENC_KEY) === 'rt-good');
    check('DRIVE-004c', 'refresh token never persisted locally',
      !fs.existsSync(path.join(scratch, 'token.json')) &&
      !JSON.stringify(fs.existsSync(path.join(scratch, 'secrets.json')) ? JSON.parse(fs.readFileSync(path.join(scratch, 'secrets.json'), 'utf8')) : {}).includes('rt-good'));
    const grant = secrets.getSecret('drive_gateway_grant');
    check('DRIVE-015a', 'POS holds only an opaque drive grant in secrets',
      /^mpt_drv_/.test(grant));
    const statusJson = JSON.stringify(driveSync.status());
    check('DRIVE-015b', 'status() exposes account metadata only - no tokens/grants/key',
      !statusJson.includes('rt-good') && !statusJson.includes(grant) && !statusJson.includes('sub-1') &&
      !statusJson.includes(secrets.getSecret('drive_backup_key')));

    // escrowed backup key pushed to the gateway, encrypted at rest
    check('DRIVE-004d', 'backup key escrowed encrypted on the gateway',
      linkRow.backup_key_ciphertext &&
      decryptValue({ ciphertext: linkRow.backup_key_ciphertext, iv: linkRow.backup_key_iv, tag: linkRow.backup_key_tag }, ENC_KEY) === secrets.getSecret('drive_backup_key'));

    // ---------- backup upload ----------
    const refSnapshot = exportSnapshot();
    const bk = await driveSync.backupDatabase('manual');
    check('DRIVE-007a', 'backup upload succeeds through the gateway',
      bk.ok === true && bk.file && /^MartPOS-backup-/.test(bk.file.name));
    check('DRIVE-010', 'gateway refreshes the Google access token for uploads',
      driveCalls.filter((c) => c[0] === 'refresh' && c[1] === 'rt-good').length >= 2);
    const uploaded = driveFiles.get(bk.file.id);
    check('DRIVE-008a', 'uploaded blob is ciphertext - not the raw database',
      uploaded && !uploaded.buffer.equals(refSnapshot) && uploaded.buffer.subarray(0, 4).toString('latin1') === 'MPBK');
    const plain = driveSync.decryptBackup(uploaded.buffer, driveSync.localBackupKey());
    check('DRIVE-008b', 'backup decrypts locally to the exact snapshot', plain.equals(refSnapshot));
    const vchk = await validateDatabaseBuffer(plain);
    check('DRIVE-008c', 'decrypted backup is a valid MartPOS database', vchk.ok === true);
    check('DRIVE-007b', 'last_backup_at recorded locally', !!driveSync.status().last_backup_at);
    const hist = execToObjects("SELECT * FROM backup_log WHERE location='drive' ORDER BY id DESC LIMIT 1");
    check('DRIVE-007c', 'drive backup recorded in history', hist.length === 1 && hist[0].status === 'success');

    // listBackups surfaces gateway metadata
    const lb = await driveSync.listBackups();
    check('DRIVE-007d', 'listBackups returns Drive files', lb.length === 1 && lb[0].id === bk.file.id);

    // device-token bearer can also query gateway status (shop-bound link)
    const devStatus = await realFetch(`http://127.0.0.1:${gwPort}/v1/drive/status`, { headers: { authorization: 'Bearer mpt_dev1' } }).then((r) => r.json());
    check('DRIVE-005c', 'device token resolves the shop drive link',
      devStatus.ok === true && devStatus.connected === true && devStatus.email === 'owner@gmail.com' &&
      !JSON.stringify(devStatus).includes('rt-good') && !JSON.stringify(devStatus).includes(grant));

    // ---------- gateway outage must not break POS ----------
    const savedUrl = process.env.MARTPOS_CLOUD_URL;
    process.env.MARTPOS_CLOUD_URL = 'http://127.0.0.1:9';
    const auto = await driveSync.tryAutoBackup();
    check('DRIVE-009a', 'gateway outage -> backup fails softly with retry note',
      auto.ok === false && /internet|unavailable/i.test(auto.error), auto.error);
    const localBk = await createLocalBackup('automatic');
    check('DRIVE-009b', 'local backup + POS unaffected by outage',
      localBk.ok === true && driveSync.driveLinked() === true);
    process.env.MARTPOS_CLOUD_URL = savedUrl;

    // ---------- change account: failure preserves the existing link ----------
    tokenQueue.push({ access_token: 'at-pos2', refresh_token: 'rt-bad', id_token: ID_TOKEN_2 });
    let changeErr = '';
    try { await driveSync.connectOAuth(); } catch (e) { changeErr = e.message; }
    check('DRIVE-011a', 'failed change-account surfaces an error', /reconnect|unable/i.test(changeErr), changeErr);
    const stAfterFail = driveSync.status();
    check('DRIVE-011b', 'existing account preserved after failed change',
      stAfterFail.connected === true && stAfterFail.email === 'owner@gmail.com' &&
      secrets.getSecret('drive_gateway_grant') === grant);
    check('DRIVE-011c', 'no second link row created on failure', liveLinks().length === 1);

    // link with a garbage refresh token is rejected at the gateway - nothing stored
    const badLink = await realFetch(`http://127.0.0.1:${gwPort}/v1/drive/link`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id_token: ID_TOKEN_2, refresh_token: 'rt-bad' })
    }).then((r) => ({ s: r.status, j: r.json() }));
    check('DRIVE-005d', 'unverifiable Drive authorization never links',
      (await badLink).s === 409 && liveLinks().length === 1);

    // ---------- restore validates before replacing live data ----------
    driveFiles.set('f-bad', { id: 'f-bad', name: 'MartPOS-backup-bad.mpbak', buffer: Buffer.from('not a backup'), createdTime: 'x', size: '13' });
    let badRestore = '';
    try { await driveSync.prepareRestore('f-bad'); } catch (e) { badRestore = e.message; }
    check('DRIVE-013a', 'undecryptable backup rejected before staging', /not usable|encrypted backup|decrypted/i.test(badRestore), badRestore);
    const dbBefore = fs.readFileSync(path.join(scratch, 'pos.db'));
    const tampered = Buffer.from(driveSync.encryptBackup(refSnapshot, driveSync.localBackupKey()));
    tampered[tampered.length - 1] ^= 0xff;
    driveFiles.set('f-tampered', { id: 'f-tampered', name: 'MartPOS-backup-tamp.mpbak', buffer: tampered, createdTime: 'x', size: '0' });
    let tampErr = '';
    try { await driveSync.prepareRestore('f-tampered'); } catch (e) { tampErr = e.message; }
    check('DRIVE-013b', 'tampered ciphertext rejected by GCM auth', !!tampErr);
    check('DRIVE-013c', 'live database untouched by failed prepares',
      fs.readFileSync(path.join(scratch, 'pos.db')).equals(dbBefore));

    const goodBlob = driveSync.encryptBackup(refSnapshot, driveSync.localBackupKey());
    driveFiles.set('f-good', { id: 'f-good', name: 'MartPOS-backup-good.mpbak', buffer: goodBlob, createdTime: 'x', size: String(goodBlob.length) });
    const prepared = await driveSync.prepareRestore('f-good');
    check('DRIVE-013d', 'valid backup decrypts + validates + stages',
      prepared.ok === true && fs.existsSync(prepared.staging_path) && prepared.tables > 0);
    const applied = await driveSync.applyStagedRestore(prepared.staging_path, prepared.name);
    check('DRIVE-013e', 'restore applies with pre-restore safety backup',
      applied.ok === true && !!applied.safety_backup);

    // ---------- disconnect ----------
    await driveSync.disconnect();
    const stOff = driveSync.status();
    check('DRIVE-012a', 'disconnect clears local link + account metadata',
      stOff.connected === false && stOff.email === '' && secrets.getSecret('drive_gateway_grant') === '');
    check('DRIVE-012b', 'backend authorization revoked (grant tombstoned)',
      liveLinks().length === 0 && [...links.values()][0].revoked_at &&
      [...links.values()][0].refresh_token_ciphertext === '');
    check('DRIVE-012c', 'google grant revoked best-effort at the provider',
      driveCalls.some((c) => c[0] === 'revoke' && c[1] === 'rt-good'));
    check('DRIVE-012d', 'customer Drive files are never deleted on disconnect',
      !driveCalls.some((c) => c[0] === 'delete') && driveFiles.size >= 2);

    // ---------- token hygiene ----------
    const allLogs = logLines.join('\n');
    check('DRIVE-016', 'no Google refresh token, grant or backup key ever logged',
      !allLogs.includes('rt-good') && !allLogs.includes(grant) &&
      !allLogs.includes(secrets.getSecret('drive_backup_key') || 'unlikely') &&
      !allLogs.includes('mpt_drv_'), allLogs.slice(0, 300));
  } finally {
    console.log = origLog;
    console.error = origErr;
    google.auth.OAuth2.prototype.getToken = origGetToken;
    require.cache[openPath].exports = origOpen;
    globalThis.fetch = realFetch;
    delete process.env.MARTPOS_CLOUD_URL;
    await new Promise((resolve) => gwServer.close(resolve));
  }

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('Drive test run failed:', e);
  process.exit(1);
});
