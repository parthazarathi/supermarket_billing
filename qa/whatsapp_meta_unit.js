// Unit tests for the Meta/gateway WhatsApp pipeline. No real Meta calls and
// no production DB: the local DB runs against a scratch MARTPOS_DATA_DIR and
// the gateway modules under test are pure or dependency-injected.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'martpos-wa-'));
process.env.MARTPOS_DATA_DIR = scratch;

const results = [];
let failures = 0;
function check(id, title, cond, note = '') {
  const pass = !!cond;
  if (!pass) failures += 1;
  results.push({ id, title, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${title}${pass ? '' : ` :: ${note}`}`);
}

(async () => {
  // ---------- provider abstraction delegation ----------
  const { WhatsAppService } = require('../lib/whatsapp/service');
  const calls = [];
  const mock = {};
  for (const m of ['connect', 'disconnect', 'getConnectionStatus', 'sendInvoice', 'sendText',
    'sendDocument', 'sendTemplate', 'getMessageStatus', 'retryMessage', 'validateNumber']) {
    mock[m] = (...args) => { calls.push([m, args]); return `r:${m}`; };
  }
  const svc = new WhatsAppService(mock);
  check('WU-SVC-001', 'connect delegates', svc.connect('ctx') === 'r:connect' && calls[0][1][0] === 'ctx');
  svc.disconnect('ctx'); svc.getConnectionStatus('ctx');
  svc.sendInvoice('ctx', { id: 1 }); svc.sendText('ctx', 'hi'); svc.sendDocument('ctx', { id: 2 });
  svc.sendTemplate('ctx', { name: 't' }); svc.getMessageStatus('ctx', 'm1');
  svc.retryMessage('ctx', 'm1', { a: 1 }); svc.validateNumber('999', { x: 1 });
  const got = calls.map((c) => c[0]);
  check('WU-SVC-002', 'all 10 methods delegate in order',
    JSON.stringify(got) === JSON.stringify(['connect', 'disconnect', 'getConnectionStatus', 'sendInvoice',
      'sendText', 'sendDocument', 'sendTemplate', 'getMessageStatus', 'retryMessage', 'validateNumber']),
    JSON.stringify(got));
  check('WU-SVC-003', 'retryMessage forwards options arg', calls[8][1][2].a === 1);

  // ---------- number normalization ----------
  const wa = require('../lib/whatsapp');
  check('WU-NUM-001', '+91 spaced number normalizes', wa.normalizeWhatsAppNumber('+91 98765 43210') === '+919876543210');
  check('WU-NUM-002', 'bare 10-digit Indian gets +91', wa.normalizeWhatsAppNumber('9876543210') === '+919876543210');
  check('WU-NUM-003', '00-prefix converts to +', wa.normalizeWhatsAppNumber('0091 98765 43210') === '+919876543210');
  check('WU-NUM-004', 'explicit + number preserved', wa.normalizeWhatsAppNumber('+14155238886') === '+14155238886');
  check('WU-NUM-005', 'custom default country code', wa.normalizeWhatsAppNumber('9876543210', { defaultCountryCode: '+1' }) === '+19876543210');
  check('WU-NUM-006', 'whatsapp: prefix tolerated', wa.normalizeWhatsAppNumber('whatsapp:+919876543210') === '+919876543210');
  let threw = false;
  try { wa.normalizeWhatsAppNumber('14155238886'); } catch (_) { threw = true; }
  check('WU-NUM-007', 'ambiguous bare 11-digit rejected', threw);
  threw = false;
  try { wa.normalizeWhatsAppNumber('12345'); } catch (_) { threw = true; }
  check('WU-NUM-008', 'short bare number rejected', threw);
  threw = false;
  try { wa.normalizeWhatsAppNumber('+91-98'); } catch (_) { threw = true; }
  check('WU-NUM-009', 'short + number rejected', threw);
  check('WU-NUM-010', 'maskNumber hides middle', wa.maskNumber('+919876543210') === '+9198***210');

  // ---------- template vs free-form policy ----------
  const { createGatewayProvider } = require('../lib/whatsapp/localProvider');
  const provider = createGatewayProvider();
  const svc2 = new WhatsAppService(provider);
  const textRes = await svc2.sendText({}, { to: '+919876543210', body: 'hi' });
  check('WU-POL-001', 'sendText returns policy-safe error, never sends',
    textRes.ok === false && textRes.code === 'policy_unsupported', JSON.stringify(textRes));
  const docRes = await svc2.sendDocument({}, { to: '+9198', url: 'x' });
  check('WU-POL-002', 'sendDocument returns policy-safe error',
    docRes.ok === false && docRes.code === 'policy_unsupported');
  const stRes = await svc2.getMessageStatus({}, 'abc');
  check('WU-POL-003', 'getMessageStatus returns policy-safe error', stRes.ok === false);
  const vn = await svc2.validateNumber('9876543210');
  check('WU-POL-004', 'validateNumber normalizes locally', vn.ok === true && vn.normalized === '+919876543210');

  // ---------- error redaction ----------
  const { redactSecrets } = require('../lib/whatsapp/gatewayClient');
  const dirty = 'GET https://graph.facebook.com/v26.0/x?access_token=EAAGSECRET123&sig=abc123 failed: Bearer mpt_DEADBEEF99';
  const clean = redactSecrets(dirty);
  check('WU-RED-001', 'access_token param redacted', !clean.includes('EAAGSECRET123'), clean);
  check('WU-RED-002', 'bearer token redacted', !clean.includes('DEADBEEF99'), clean);
  const fe = wa.friendlyError(new Error('Meta error: access_token=EAAGSECRET123 more'));
  check('WU-RED-003', 'friendlyError redacts tokens in fallback', !String(fe).includes('EAAGSECRET123'), fe);
  check('WU-RED-004', 'friendlyError maps network errors', /internet/i.test(wa.friendlyError(new Error('fetch failed ENOTFOUND'))));
  check('WU-RED-005', 'friendlyError maps auth errors', /reconnect|authorization/i.test(wa.friendlyError(Object.assign(new Error('x'), { code: 190 }))));

  // ---------- secrets: AES-GCM roundtrip, no plaintext ----------
  const secrets = require('../lib/secrets');
  const TEST_KEY = crypto.randomBytes(32).toString('base64');
  process.env.MARTPOS_SECRET_KEY = TEST_KEY;
  secrets.setSecret('cloud_device_token', 'mpt_testtoken_abcdef123456');
  const rawStore = fs.readFileSync(path.join(scratch, 'secrets.json'), 'utf8');
  check('WU-SEC-001', 'stored entry is GCM-encrypted, no plaintext value',
    !rawStore.includes('mpt_testtoken_abcdef123456') && JSON.parse(rawStore).cloud_device_token.gcm);
  check('WU-SEC-002', 'GCM roundtrip decrypts', secrets.getSecret('cloud_device_token') === 'mpt_testtoken_abcdef123456');
  // Legacy plaintext entries remain readable for backward compatibility.
  const storePath = path.join(scratch, 'secrets.json');
  const storeObj = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  storeObj.legacy_plain = { v: 'legacy_sid_value' };
  fs.writeFileSync(storePath, JSON.stringify(storeObj));
  check('WU-SEC-003', 'legacy plaintext entry still readable', secrets.getSecret('legacy_plain') === 'legacy_sid_value');
  // Without DPAPI and without the key, writes must throw - never plaintext.
  delete process.env.MARTPOS_SECRET_KEY;
  let writeThrew = false;
  try { secrets.setSecret('another', 'x'); } catch (e) { writeThrew = /secure credential storage/i.test(e.message); }
  check('WU-SEC-004', 'write without key throws friendly config error', writeThrew);
  process.env.MARTPOS_SECRET_KEY = TEST_KEY;
  check('WU-SEC-005', 'stored token still decrypts after key restore',
    secrets.getSecret('cloud_device_token') === 'mpt_testtoken_abcdef123456');

  // ---------- webhook signature / payload / status helpers ----------
  const { verifySignature, digestBody, validatePayload, extractStatusUpdates } = require('../gateway/src/webhook');
  const { applyStatus } = require('../gateway/src/status');
  const appSecret = 'test-app-secret';
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '111', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '222' }, statuses: [{ id: 'wamid.A', status: 'delivered', timestamp: '1700000000', recipient_id: '9198' }] } }] }]
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', appSecret).update(Buffer.from(body)).digest('hex');
  check('WU-WH-001', 'valid signature accepted', verifySignature(Buffer.from(body), sig, appSecret) === true);
  check('WU-WH-002', 'wrong signature rejected', verifySignature(Buffer.from(body), sig.replace(/.$/, '0'), appSecret) === false);
  check('WU-WH-003', 'missing signature rejected', verifySignature(Buffer.from(body), '', appSecret) === false);
  check('WU-WH-004', 'tampered body rejected', verifySignature(Buffer.from(body + ' '), sig, appSecret) === false);
  check('WU-WH-005', 'payload validates', validatePayload(JSON.parse(body)).ok === true);
  check('WU-WH-006', 'wrong object rejected', validatePayload({ object: 'page', entry: [] }).ok === false);
  check('WU-WH-007', 'missing entry rejected', validatePayload({ object: 'whatsapp_business_account' }).ok === false);
  const ups = extractStatusUpdates(JSON.parse(body));
  check('WU-WH-008', 'status extraction maps waba+phone+message', ups.length === 1 && ups[0].wabaId === '111' && ups[0].phoneNumberId === '222' && ups[0].metaMessageId === 'wamid.A' && ups[0].status === 'delivered', JSON.stringify(ups));
  check('WU-WH-009', 'same body -> same dedupe digest', digestBody(Buffer.from(body)) === digestBody(Buffer.from(body)));
  check('WU-WH-010', 'different body -> different digest', digestBody(Buffer.from(body)) !== digestBody(Buffer.from(body + '1')));
  check('WU-WH-011', 'status monotonic: delivered after sent', applyStatus('sent', 'delivered') === 'delivered');
  check('WU-WH-012', 'status monotonic: sent cannot downgrade read', applyStatus('read', 'sent') === 'read');
  check('WU-WH-013', 'failed cannot downgrade delivered', applyStatus('delivered', 'failed') === 'delivered');
  check('WU-WH-014', 'failed applies from sent', applyStatus('sent', 'failed') === 'failed');

  // ---------- retry classification / backoff ----------
  const { classifyMetaError, nextBackoffMs, MAX_ATTEMPTS, BACKOFF_MS } = require('../gateway/src/retry');
  check('WU-RET-001', 'HTTP 429 transient', classifyMetaError({ status: 429 }).permanent === false);
  check('WU-RET-002', 'HTTP 500 transient', classifyMetaError({ status: 503 }).permanent === false);
  check('WU-RET-003', 'HTTP 408 transient', classifyMetaError({ status: 408 }).permanent === false);
  check('WU-RET-004', 'network error (no status) transient', classifyMetaError(new Error('fetch failed')).permanent === false);
  check('WU-RET-005', 'Meta 190 auth permanent', classifyMetaError({ status: 401, metaCode: 190 }).permanent === true);
  check('WU-RET-006', 'Meta invalid-recipient permanent', classifyMetaError({ status: 400, metaCode: 131030 }).permanent === true);
  check('WU-RET-007', 'Meta template-missing permanent', classifyMetaError({ status: 400, metaCode: 132001 }).permanent === true);
  check('WU-RET-008', 'Meta rate-limit code transient', classifyMetaError({ status: 400, metaCode: 130429 }).permanent === false);
  check('WU-RET-009', 'HTTP 400 permanent', classifyMetaError({ status: 400 }).permanent === true);
  check('WU-RET-010', 'backoff 30s then 2m then exhausted',
    nextBackoffMs(1) === 30000 && nextBackoffMs(2) === 120000 && nextBackoffMs(3) === null,
    JSON.stringify([nextBackoffMs(1), nextBackoffMs(2), nextBackoffMs(3)]));
  check('WU-RET-011', 'backoff schedule is 30s/2m, max 3 attempts',
    JSON.stringify(BACKOFF_MS) === JSON.stringify([30000, 120000]) && MAX_ATTEMPTS === 3);
  check('WU-RET-012', 'template_not_approved is permanent',
    classifyMetaError({ code: 'template_not_approved' }).permanent === true);

  // ---------- gateway env validation ----------
  const { loadConfig } = require('../gateway/src/config');
  const goodEnv = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x', GATEWAY_PUBLIC_URL: 'https://gw.example.com',
    GATEWAY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    META_APP_ID: 'a', META_APP_SECRET: 's', META_EMBEDDED_SIGNUP_CONFIG_ID: 'c',
    META_WEBHOOK_VERIFY_TOKEN: 'v'
  };
  const cfg = loadConfig({ ...goodEnv, META_GRAPH_BASE_URL: 'http://127.0.0.1:9' });
  check('WU-ENV-001', 'graph version defaults to v26.0', cfg.meta.graphVersion === 'v26.0');
  check('WU-ENV-002', 'test base URL honored under NODE_ENV=test', cfg.meta.graphBaseUrl === 'http://127.0.0.1:9');
  const cfgProd = loadConfig({ ...goodEnv, NODE_ENV: 'production', META_GRAPH_BASE_URL: 'http://evil.example' });
  check('WU-ENV-003', 'custom base URL ignored in production', cfgProd.meta.graphBaseUrl === 'https://graph.facebook.com');
  threw = false;
  try { loadConfig({ ...goodEnv, GATEWAY_ENCRYPTION_KEY: 'not-base64-32' }); } catch (_) { threw = true; }
  check('WU-ENV-004', 'bad encryption key rejected', threw);
  threw = false;
  try { loadConfig({ DATABASE_URL: 'x' }); } catch (e) { threw = /META_APP_ID/.test(e.message); }
  check('WU-ENV-005', 'missing vars reported', threw);
  threw = false;
  try { loadConfig({ ...goodEnv, NODE_ENV: 'production', GATEWAY_PUBLIC_URL: 'http://gw.example.com' }); } catch (_) { threw = true; }
  check('WU-ENV-006', 'non-https public URL rejected in production', threw);

  // ---------- local enqueue idempotency + remote updates ----------
  await require('../lib/database').initDatabase();
  const outbox = require('../lib/whatsapp/outbox');
  const e1 = outbox.enqueue({ invoiceId: 42, customerPhone: 'x', normalizedPhone: '+919876543210', idempotencyKey: 'invoice:42:+919876543210' });
  const e2 = outbox.enqueue({ invoiceId: 42, customerPhone: 'x', normalizedPhone: '+919876543210', idempotencyKey: 'invoice:42:+919876543210' });
  check('WU-OUT-001', 'first enqueue returns message id', e1.ok === true && !!e1.messageId);
  check('WU-OUT-002', 'repeat enqueue is a dedupe hit', e2.duplicate === true && e2.messageId === e1.messageId);
  const qRows = require('../lib/database').execToObjects("SELECT * FROM whatsapp_queue WHERE idempotency_key = 'invoice:42:+919876543210'");
  check('WU-OUT-003', 'exactly one queue row for the key', qRows.length === 1);
  const due = outbox.dueJobs(10);
  check('WU-OUT-004', 'due job is picked up', due.length === 1 && due[0].normalized_phone === '+919876543210');
  outbox.markForwarded(due[0].queue_id, due[0].id, 'remote-1');
  let fwdMsg = require('../lib/database').execToObject('SELECT status, sent_at FROM whatsapp_messages WHERE remote_id = ?', ['remote-1']);
  check('WU-OUT-004b', 'forwarded message stays pending, no sent_at yet', fwdMsg.status === 'pending' && !fwdMsg.sent_at);
  outbox.applyRemoteUpdate({ id: 'remote-1', status: 'sent', sent_at: '2026-01-01T00:00:00.000Z' });
  let sentMsg = require('../lib/database').execToObject('SELECT status, sent_at FROM whatsapp_messages WHERE remote_id = ?', ['remote-1']);
  check('WU-OUT-004c', 'remote sent sets status + sent_at', sentMsg.status === 'sent' && sentMsg.sent_at === '2026-01-01T00:00:00.000Z');
  outbox.applyRemoteUpdate({ id: 'remote-1', status: 'delivered', delivered_at: new Date().toISOString() });
  let msg = require('../lib/database').execToObject('SELECT * FROM whatsapp_messages WHERE remote_id = ?', ['remote-1']);
  check('WU-OUT-005', 'remote delivered applied', msg.status === 'delivered' && !!msg.delivered_at);
  outbox.applyRemoteUpdate({ id: 'remote-1', status: 'failed', error_code: 'x' });
  msg = require('../lib/database').execToObject('SELECT status FROM whatsapp_messages WHERE remote_id = ?', ['remote-1']);
  check('WU-OUT-006', 'remote failed does not downgrade delivered', msg.status === 'delivered');
  outbox.applyRemoteUpdate({ id: 'remote-1', status: 'read', read_at: new Date().toISOString() });
  msg = require('../lib/database').execToObject('SELECT status FROM whatsapp_messages WHERE remote_id = ?', ['remote-1']);
  check('WU-OUT-007', 'remote read upgrades delivered', msg.status === 'read');
  const statusMap = outbox.latestStatusMap();
  check('WU-OUT-008', 'latestStatusMap exposes invoice status', statusMap[42] && statusMap[42].status === 'read');
  const attempts = outbox.attemptsFor(42);
  check('WU-OUT-009', 'attemptsFor returns safe history rows',
    attempts.length === 1 && attempts[0].status === 'read' && attempts[0].retry_count === 1 &&
    !('provider' in attempts[0]) && !('remote_id' in attempts[0]) && !('message_sid' in attempts[0]),
    JSON.stringify(attempts));
  const iid = require('../lib/database').execToObject("SELECT value FROM settings WHERE key='installation_id'");
  check('WU-OUT-010', 'installation_id generated at startup', !!(iid && iid.value));

  // ---------- sendBill enqueue + token hygiene ----------
  const fakeInvoice = { id: 77, invoice_no: 'INV-77', total: 10 };
  const send = wa.sendBill(fakeInvoice, '9876543210');
  check('WU-SND-001', 'sendBill enqueues pending meta message',
    send.ok === true && send.queued === true && send.provider === 'meta' && send.status === 'pending' && !!send.messageId,
    JSON.stringify(send));
  const sendDup = wa.sendBill(fakeInvoice, '9876543210');
  check('WU-SND-002', 'same invoice+phone dedupes', sendDup.duplicate === true && sendDup.messageId === send.messageId);
  const badSend = wa.sendBill(fakeInvoice, 'not-a-number');
  check('WU-SND-003', 'bad number fails without queueing', badSend.ok === false);

  const statusJson = JSON.stringify(wa.whatsappStatus());
  check('WU-TOK-001', 'device token never appears in whatsappStatus', !statusJson.includes('mpt_testtoken_abcdef123456'), statusJson.slice(0, 300));
  const { setCachedConnection } = require('../lib/whatsapp/worker');
  check('WU-TOK-002', 'linked but not connected -> configured false',
    wa.whatsappStatus().linked === true && wa.whatsappStatus().configured === false && wa.whatsappStatus().provider === 'meta');
  setCachedConnection({ status: 'connected', display_phone_number: '+919876543210' });
  check('WU-TOK-002b', 'cached connected -> configured true', wa.whatsappStatus().configured === true);
  check('WU-TOK-002c', 'remote phone masked in status', wa.whatsappStatus().connection.phone_masked === '+9198***210');
  setCachedConnection(null);
  check('WU-TOK-002d', 'cache invalidation drops configured', wa.whatsappStatus().configured === false);
  check('WU-TOK-003', 'queue pending count visible', wa.whatsappStatus().queue.pending >= 1);

  // ---------- gateway MetaClient with injected fetch ----------
  const { MetaClient } = require('../gateway/src/meta');
  const fetchCalls = [];
  const fakeFetch = async (url, opts) => {
    fetchCalls.push({ url, method: opts.method });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.X' }] }) };
  };
  const meta = new MetaClient({ baseUrl: 'https://graph.facebook.com', version: 'v26.0', accessToken: 'T', fetchImpl: fakeFetch });
  const sendRes = await meta.sendTemplate('PNID', { to: '+91 98765 43210', name: 'mart_pos_invoice', components: [] });
  check('WU-META-001', 'sendTemplate hits /{version}/{phoneId}/messages',
    fetchCalls[0].url === 'https://graph.facebook.com/v26.0/PNID/messages' && fetchCalls[0].method === 'POST', fetchCalls[0] && fetchCalls[0].url);
  check('WU-META-002', 'sendTemplate returns message id', sendRes.messages[0].id === 'wamid.X');
  const errFetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad', code: 132001 } }) });
  const metaErr = new MetaClient({ baseUrl: 'https://graph.facebook.com', version: 'v26.0', accessToken: 'T', fetchImpl: errFetch });
  let mErr = null;
  try { await metaErr.sendTemplate('P', { to: '1', name: 'x' }); } catch (e) { mErr = e; }
  check('WU-META-003', 'Meta error carries status + metaCode', mErr && mErr.status === 400 && mErr.metaCode === 132001);

  // ---------- onboarding page + completion ----------
  const onboarding = require('../gateway/src/onboarding');
  const page = onboarding.renderOnboardingPage({ token: 'tok', appId: 'app1', configId: 'cfg1', version: 'v26.0' });
  check('WU-ONB-001', 'FB.login uses extras setup:{} and no v4 flag',
    /extras:\s*\{\s*setup:\s*\{\s*\}\s*\}/.test(page) && !page.includes("version: 'v4'"));
  check('WU-ONB-002', 'page collects a 6-digit PIN securely',
    /type="password"/.test(page) && /inputmode="numeric"/.test(page) && /pattern="\\d\{6\}"/.test(page) && /Create or enter your 6-digit/.test(page));
  check('WU-ONB-003', 'PIN help text present', /existing PIN/i.test(page) && /memorable 6 digits/i.test(page));
  const onbSrc = fs.readFileSync(path.join(__dirname, '..', 'gateway', 'src', 'onboarding.js'), 'utf8');
  check('WU-ONB-004', 'no server-side PIN generation', !/randomInt/.test(onbSrc));

  const ENC_KEY = crypto.randomBytes(32);
  const gwStore = require('../gateway/src/store');
  const consumeSql = [];
  const poolForConsume = {
    connect: async () => ({
      query: async (sql, params) => {
        consumeSql.push(sql);
        if (/RETURNING id, shop_id/.test(sql)) return { rows: [{ id: 'sess1', shop_id: 'shop1' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release() {}
    })
  };
  const consumed = await gwStore.consumeOnboardingSession(poolForConsume, 'hashx');
  check('WU-ONB-005', 'consume is a single atomic UPDATE',
    consumed && consumed.shop_id === 'shop1' &&
    consumeSql.filter((s) => /UPDATE onboarding_sessions SET used_at/.test(s) && /RETURNING/.test(s) && /used_at IS NULL/.test(s)).length === 1,
    JSON.stringify(consumeSql));

  function fakeOnbDeps(overrides = {}) {
    const metaCalls = [];
    const fakeMeta = {
      exchangeCode: async () => { metaCalls.push('exchangeCode'); return { access_token: 'EAA_live', expires_in: 3600 }; },
      listPhoneNumbers: async () => { metaCalls.push('listPhoneNumbers'); return { data: [{ id: 'PN1', display_phone_number: '+919811122233', verified_name: 'Shop' }] }; },
      registerPhone: async () => { metaCalls.push('registerPhone'); return {}; },
      subscribeWaba: async () => { metaCalls.push('subscribeWaba'); return {}; },
      createMessageTemplate: async () => ({ id: 't1', status: 'PENDING' }),
      findMessageTemplate: async () => ({ data: [] }),
      ...overrides
    };
    const pool = {
      connect: async () => ({
        query: async (sql) => {
          if (/RETURNING id, shop_id/.test(sql)) return { rows: [{ id: 'sess1', shop_id: 'shop1' }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release() {}
      }),
      query: async () => ({ rows: [], rowCount: 0 })
    };
    return { deps: { pool, config: { encryptionKey: ENC_KEY }, metaFor: () => fakeMeta }, metaCalls };
  }

  let r1 = await (async () => {
    const { deps, metaCalls } = fakeOnbDeps();
    let consumeCalled = false;
    const origConnect = deps.pool.connect;
    deps.pool.connect = async () => { consumeCalled = true; return origConnect(); };
    const r = await onboarding.completeOnboarding(deps, 'tok', { code: 'c', wabaId: 'W1', phoneNumberId: 'PN1', pin: '123' });
    return { r, metaCalls, consumeCalled };
  })();
  check('WU-ONB-006', 'invalid PIN rejected before code exchange', r1.r.ok === false && !r1.metaCalls.includes('exchangeCode'));
  check('WU-ONB-006b', 'invalid PIN rejected before session consume', r1.consumeCalled === false);
  r1 = await (async () => { const { deps, metaCalls } = fakeOnbDeps(); const r = await onboarding.completeOnboarding(deps, 'tok', { code: 'c', wabaId: 'W1', phoneNumberId: 'PN1' }); return { r, metaCalls }; })();
  check('WU-ONB-007', 'missing PIN rejected before code exchange', r1.r.ok === false && !r1.metaCalls.includes('exchangeCode'));
  r1 = await (async () => {
    const { deps, metaCalls } = fakeOnbDeps({ listPhoneNumbers: async () => { metaCalls.push('listPhoneNumbers'); return { data: [{ id: 'OTHER' }] }; } });
    const r = await onboarding.completeOnboarding(deps, 'tok', { code: 'c', wabaId: 'W1', phoneNumberId: 'PN1', pin: '112233' });
    return { r, metaCalls };
  })();
  check('WU-ONB-008', 'phone id not under WABA rejected before register',
    r1.r.ok === false && r1.metaCalls.includes('listPhoneNumbers') && !r1.metaCalls.includes('registerPhone'));
  r1 = await (async () => {
    const { deps, metaCalls } = fakeOnbDeps();
    const r = await onboarding.completeOnboarding(deps, 'tok', { code: 'c', wabaId: 'W1', phoneNumberId: 'PN1', pin: '112233' });
    return { r, metaCalls };
  })();
  check('WU-ONB-009', 'happy path registers user PIN + subscribes',
    r1.r.ok === true && r1.metaCalls.includes('registerPhone') && r1.metaCalls.includes('subscribeWaba'));

  // ---------- phone-number tenancy conflict ----------
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'gateway', 'schema.sql'), 'utf8');
  check('WU-ONB-010', 'schema enforces one-shop-per-phone-number-id',
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_connections_phone_unique\s+ON whatsapp_connections\(phone_number_id\) WHERE phone_number_id <> ''/.test(schemaSql));
  const origUpConn = gwStore.upsertConnection;
  gwStore.upsertConnection = async () => { const e = new Error('dup'); e.code = '23505'; e.constraint = 'idx_wa_connections_phone_unique'; throw e; };
  r1 = await (async () => { const { deps, metaCalls } = fakeOnbDeps(); const r = await onboarding.completeOnboarding(deps, 'tok', { code: 'c', wabaId: 'W1', phoneNumberId: 'PN1', pin: '112233' }); return { r, metaCalls }; })();
  check('WU-ONB-011', 'phone-id conflict maps to safe friendly error (no ids leaked)',
    r1.r.ok === false && r1.r.error === 'This WhatsApp number is already connected to another MartPOS shop.' && !/W1|PN1/.test(r1.r.error));
  gwStore.upsertConnection = async () => { const e = new Error('other dup'); e.code = '23505'; e.constraint = 'some_other_constraint'; throw e; };
  threw = false;
  try { const { deps } = fakeOnbDeps(); await onboarding.completeOnboarding(deps, 'tok', { code: 'c', wabaId: 'W1', phoneNumberId: 'PN1', pin: '112233' }); }
  catch (_) { threw = true; }
  check('WU-ONB-012', 'unrelated unique violation not remapped', threw);
  gwStore.upsertConnection = origUpConn;

  // ---------- pre-check: number already claimed by another shop ----------
  r1 = await (async () => {
    const { deps, metaCalls } = fakeOnbDeps();
    const origQ = deps.pool.query;
    deps.pool.query = async (sql, params) => {
      if (/FROM whatsapp_connections WHERE phone_number_id/.test(sql)) {
        return { rows: [{ shop_id: 'other-shop', status: 'connected' }], rowCount: 1 };
      }
      return origQ(sql, params);
    };
    const r = await onboarding.completeOnboarding(deps, 'tok', { code: 'c', wabaId: 'W1', phoneNumberId: 'PN1', pin: '112233' });
    return { r, metaCalls };
  })();
  check('WU-ONB-013', 'foreign-shop claim short-circuits before register/subscribe/template',
    r1.r.ok === false && r1.r.error === 'This WhatsApp number is already connected to another MartPOS shop.' &&
    !r1.metaCalls.some((c) => /registerPhone|subscribeWaba|createMessageTemplate/.test(c)) &&
    !/W1|PN1|other-shop/.test(r1.r.error));
  r1 = await (async () => {
    const { deps, metaCalls } = fakeOnbDeps();
    const origQ = deps.pool.query;
    deps.pool.query = async (sql, params) => {
      if (/FROM whatsapp_connections WHERE phone_number_id/.test(sql)) {
        return { rows: [{ shop_id: 'shop1', status: 'disconnected' }], rowCount: 1 };
      }
      return origQ(sql, params);
    };
    const r = await onboarding.completeOnboarding(deps, 'tok', { code: 'c', wabaId: 'W1', phoneNumberId: 'PN1', pin: '112233' });
    return { r, metaCalls };
  })();
  check('WU-ONB-014', 'same-shop reconnect allowed', r1.r.ok === true && r1.metaCalls.includes('registerPhone'));

  // ---------- template approval gate ----------
  const tpl = require('../gateway/src/templates');
  const tplRows = { template: { shop_id: 's1', name: 'mart_pos_invoice', status: 'PENDING', document_header: true, category: 'UTILITY' } };
  let refreshCalls = 0;
  const tplPool = { query: async (sql) => {
    if (/SELECT \* FROM whatsapp_templates/.test(sql)) return { rows: [tplRows.template], rowCount: 1 };
    if (/INSERT INTO whatsapp_templates/.test(sql)) { tplRows.template = { ...tplRows.template, status: 'APPROVED' }; return { rows: [], rowCount: 0 }; }
    return { rows: [], rowCount: 0 };
  } };
  const tplMeta = { findMessageTemplate: async () => { refreshCalls += 1; return { data: [{ id: 'mt1', status: 'APPROVED', components: [{ type: 'HEADER', format: 'DOCUMENT' }] }] }; } };
  const tplRow = await tpl.ensureInvoiceTemplate(tplPool, tplMeta, 's1', 'W1');
  check('WU-TPL-001', 'non-APPROVED template refreshed from Meta', refreshCalls === 1 && tplRow.status === 'APPROVED');
  check('WU-TPL-002', 'document_header preserved from stored definition', tplRow.document_header === true);

  const qw = require('../gateway/src/queueWorker');
  const { encryptValue } = require('../gateway/src/cryptoUtil');
  const tokEnc = encryptValue('tok', ENC_KEY);
  const sendCalls = [];
  const origGetConn = gwStore.getConnection, origGetTpl = gwStore.getTemplate, origUpsertTpl = gwStore.upsertTemplate, origFail = gwStore.failJob;
  gwStore.getConnection = async () => ({ status: 'connected', access_token_ciphertext: tokEnc.ciphertext, access_token_iv: tokEnc.iv, access_token_tag: tokEnc.tag, business_account_id: 'W1', phone_number_id: 'PN1' });
  gwStore.getTemplate = async () => ({ name: 'mart_pos_invoice', language: 'en_US', status: 'PENDING', document_header: true });
  gwStore.upsertTemplate = async (q, t) => ({ name: t.name, language: t.language, status: t.status, document_header: t.documentHeader });
  gwStore.failJob = async (q, qid, mid, o) => { sendCalls.push(['failJob', o.code, o.message]); };
  const fakeMetaNoSend = {
    findMessageTemplate: async () => ({ data: [{ id: 'mt1', status: 'PENDING' }] }),
    uploadMedia: async () => { sendCalls.push(['uploadMedia']); return { id: 'm' }; },
    sendTemplate: async () => { sendCalls.push(['sendTemplate']); return { messages: [{ id: 'wamid' }] }; }
  };
  await qw.processJob(
    { pool: {}, config: { encryptionKey: ENC_KEY }, metaFor: () => fakeMetaNoSend },
    { queue_id: 'q1', id: 'm1', shop_id: 's1', queue_attempts: 0, normalized_phone: '+9198', payload: { invoice: { invoice_no: 'I1' } } }
  );
  check('WU-TPL-003', 'PENDING template: no media upload or send',
    !sendCalls.some((c) => c[0] === 'uploadMedia') && !sendCalls.some((c) => c[0] === 'sendTemplate'), JSON.stringify(sendCalls));
  check('WU-TPL-004', 'PENDING template fails with exact friendly message',
    sendCalls.some((c) => c[0] === 'failJob' && c[1] === 'template_not_approved' && c[2] === 'The WhatsApp bill template is not available yet. Please contact support.'),
    JSON.stringify(sendCalls));
  gwStore.getConnection = origGetConn; gwStore.getTemplate = origGetTpl; gwStore.upsertTemplate = origUpsertTpl; gwStore.failJob = origFail;
  check('WU-TPL-005', 'friendlyError maps template_not_approved exactly',
    wa.friendlyError({ code: 'template_not_approved' }) === 'The WhatsApp bill template is not available yet. Please contact support.');

  // ---------- webhook tx + app-level checks over loopback ----------
  const { createApp } = require('../gateway/src/app');
  const gwConfig = loadConfig(goodEnv);
  const gwQueries = [];
  const inserted = new Set();
  let txSnapshot = null;
  let failStatusSelect = false;
  let updatesRows = [];
  let revoked = false;
  const gwHandler = async (sql, params = []) => {
    if (/^BEGIN/.test(sql)) { txSnapshot = new Set(inserted); return { rows: [], rowCount: 0 }; }
    if (/^COMMIT/.test(sql)) { txSnapshot = null; return { rows: [], rowCount: 0 }; }
    if (/^ROLLBACK/.test(sql)) { inserted.clear(); if (txSnapshot) txSnapshot.forEach((d) => inserted.add(d)); txSnapshot = null; return { rows: [], rowCount: 0 }; }
    if (/FROM whatsapp_connections WHERE business_account_id/.test(sql)) {
      if (failStatusSelect) throw new Error('simulated processing failure');
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO webhook_events/.test(sql)) {
      const d = params[1];
      if (inserted.has(d)) return { rows: [], rowCount: 0 };
      inserted.add(d);
      return { rows: [{ id: 'ev1' }], rowCount: 1 };
    }
    if (/SELECT d\.id AS device_id/.test(sql)) return { rows: [{ device_id: 'dev1', device_name: 'POS', shop_id: 'shop1', shop_name: 'S', shop_status: 'active' }], rowCount: 1 };
    if (/UPDATE devices SET revoked_at/.test(sql)) { revoked = true; return { rows: [], rowCount: 0 }; }
    if (/FROM whatsapp_connections WHERE shop_id/.test(sql)) {
      return { rows: [{ status: 'connected', display_phone_number: '+919812345678', business_name: 'Biz Mart', token_expires_at: '2099-01-01T00:00:00.000Z', last_error: '', connected_at: '2026-01-01T00:00:00.000Z' }], rowCount: 1 };
    }
    if (/FROM whatsapp_templates WHERE shop_id/.test(sql)) {
      return { rows: [{ name: 'mart_pos_invoice', status: 'APPROVED', document_header: false, meta_template_id: 'mt_secret', components: [{ type: 'BODY' }] }], rowCount: 1 };
    }
    if (/FROM shops s/.test(sql)) {
      return { rows: [{ shop_name: 'Corner Store', business_name: 'Corner Biz', display_phone_number: '+919812345678', connection_status: 'connected', template_status: 'APPROVED', last_error: '', messages_today: '4', failed_today: '1' }], rowCount: 1 };
    }
    if (/COUNT\(\*\) AS c/.test(sql)) return { rows: [{ c: '3' }], rowCount: 1 };
    if (/FROM whatsapp_messages\n?\s+WHERE shop_id = \$1 AND \(updated_at/.test(sql) || /WHERE shop_id = \$1 AND \(updated_at/.test(sql)) {
      return { rows: updatesRows, rowCount: updatesRows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const gwPool = {
    query: (sql, params) => { gwQueries.push(sql); return gwHandler(sql, params); },
    connect: async () => ({ query: (sql, params) => { gwQueries.push(sql); return gwHandler(sql, params); }, release() {} })
  };
  const gwApp = createApp({ config: gwConfig, pool: gwPool });
  const gwServer = await new Promise((resolve) => { const s = gwApp.listen(0, () => resolve(s)); });
  const gwPort = gwServer.address().port;
  const gw = async (method, p, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    const res = await fetch(`http://127.0.0.1:${gwPort}${p}`, { method, headers, body: opts.raw ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined) });
    let json = null; const text = await res.text(); try { json = JSON.parse(text); } catch (_) { /* html */ }
    return { status: res.status, json, text };
  };
  try {
    const secret = gwConfig.meta.appSecret;
    const mkSig = (b) => 'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(b)).digest('hex');
    const whBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W1', changes: [{ value: { metadata: { phone_number_id: 'PN1' }, statuses: [{ id: 'wamid.9', status: 'delivered', timestamp: '1700000000' }] } }] }] });
    let wr = await gw('POST', '/webhooks/meta', { raw: true, body: whBody, headers: { 'content-type': 'application/json', 'x-hub-signature-256': mkSig(whBody) } });
    check('WU-WHTX-001', 'valid webhook processed', wr.status === 200 && wr.json.ok === true);
    wr = await gw('POST', '/webhooks/meta', { raw: true, body: whBody, headers: { 'content-type': 'application/json', 'x-hub-signature-256': mkSig(whBody) } });
    check('WU-WHTX-002', 'valid duplicate returns 200', wr.status === 200 && wr.json.duplicate === true);
    const whBody2 = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W1', changes: [{ value: { metadata: { phone_number_id: 'PN1' }, statuses: [{ id: 'wamid.10', status: 'read', timestamp: '1700000001' }] } }] }] });
    const digest2 = crypto.createHash('sha256').update(Buffer.from(whBody2)).digest('hex');
    failStatusSelect = true;
    wr = await gw('POST', '/webhooks/meta', { raw: true, body: whBody2, headers: { 'content-type': 'application/json', 'x-hub-signature-256': mkSig(whBody2) } });
    check('WU-WHTX-003', 'processing failure -> 500 and ROLLBACK', wr.status === 500 && gwQueries.some((s) => /^ROLLBACK/.test(s)));
    check('WU-WHTX-004', 'rollback released the dedupe row', !inserted.has(digest2));
    failStatusSelect = false;
    wr = await gw('POST', '/webhooks/meta', { raw: true, body: whBody2, headers: { 'content-type': 'application/json', 'x-hub-signature-256': mkSig(whBody2) } });
    check('WU-WHTX-005', 'Meta retry inserts again after rollback', wr.status === 200 && inserted.has(digest2));
    wr = await gw('POST', '/webhooks/meta', { raw: true, body: whBody2, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=bad' } });
    check('WU-WHTX-006', 'bad signature rejected', wr.status === 401);

    updatesRows = [
      { id: 'r2', meta_message_id: 'wamid.1', status: 'delivered', error_code: '', error_message: '', attempt_count: 1, sent_at: null, delivered_at: '2026-01-02T00:00:00.000Z', read_at: null, updated_at: '2026-01-02T00:00:00.000Z' },
      { id: 'r9', meta_message_id: 'wamid.2', status: 'read', error_code: '', error_message: '', attempt_count: 1, sent_at: null, delivered_at: null, read_at: '2026-01-02T00:00:01.000Z', updated_at: '2026-01-02T00:00:00.000Z' }
    ];
    let ur = await gw('GET', '/v1/whatsapp/messages/updates?since=2026-01-01T00:00:00.000Z&after_id=r1', { bearer: 'mpt_devtoken' });
    check('WU-CUR-001', 'updates endpoint returns rows + next cursor',
      ur.status === 200 && ur.json.updates.length === 2 && ur.json.next && ur.json.next.id === 'r9' && ur.json.next.updated_at === '2026-01-02T00:00:00.000Z' && ur.json.has_more === false,
      JSON.stringify(ur.json && ur.json.next));
    check('WU-CUR-002', 'updates SQL uses (updated_at,id) cursor',
      gwQueries.some((s) => /updated_at = \$2::timestamptz AND id > \$3/.test(s) && /ORDER BY updated_at ASC, id ASC/.test(s)));
    const dr = await gw('DELETE', '/v1/devices/current', { bearer: 'mpt_devtoken' });
    check('WU-DEV-001', 'device revoke endpoint works', dr.status === 200 && dr.json.ok === true && revoked === true);
    const noAuth = await gw('DELETE', '/v1/devices/current');
    check('WU-DEV-002', 'device revoke requires bearer', noAuth.status === 401);
    const badMsg = await gw('POST', '/v1/whatsapp/messages', { bearer: 'mpt_devtoken', body: { idempotency_key: 'k:abcdefghij', normalized_phone: '+919876543210', message_type: 'invoice' } });
    check('WU-PAY-001', 'missing payload.invoice rejected', badMsg.status === 400);

    const statR = await gw('GET', '/v1/whatsapp/status', { bearer: 'mpt_devtoken' });
    check('WU-GST-001', 'gateway status returns safe template fields only',
      statR.status === 200 && statR.json.connection.template.name === 'mart_pos_invoice' &&
      statR.json.connection.template.status === 'APPROVED' && statR.json.connection.template.document_enabled === false &&
      !('meta_template_id' in statR.json.connection.template) && !('components' in statR.json.connection.template) &&
      !('business_account_id' in statR.json.connection) && !('phone_number_id' in statR.json.connection),
      JSON.stringify(statR.json && statR.json.connection));
  } finally {
    await new Promise((resolve) => gwServer.close(resolve));
  }

  // ---------- support diagnostics ----------
  const supConfig = { ...gwConfig, support: { username: 'sup', passwordHash: require('bcryptjs').hashSync('pw', 4) } };
  const supApp = createApp({ config: supConfig, pool: gwPool });
  const supServer = await new Promise((resolve) => { const s = supApp.listen(0, () => resolve(s)); });
  try {
    const supPort = supServer.address().port;
    const basic = 'Basic ' + Buffer.from('sup:pw').toString('base64');
    const noAuth = await fetch(`http://127.0.0.1:${supPort}/v1/support/diagnostics`);
    check('WU-SUP-001', 'diagnostics requires basic auth', noAuth.status === 401);
    const dr = await fetch(`http://127.0.0.1:${supPort}/v1/support/diagnostics`, { headers: { authorization: basic } });
    const dj = await dr.json();
    const djRaw = JSON.stringify(dj);
    check('WU-SUP-002', 'diagnostics rows masked, no ids/tokens/raw numbers',
      dr.status === 200 && dj.ok === true && dj.shops[0].display_number.includes('*') &&
      !djRaw.includes('+919812345678') &&
      !/(shop_id|device_id|meta_message_id|access_token|waba|phone_number_id|ciphertext)/i.test(djRaw),
      djRaw.slice(0, 300));
    const pg = await fetch(`http://127.0.0.1:${supPort}/support`, { headers: { authorization: basic } });
    const html = await pg.text();
    check('WU-SUP-003', 'support dashboard renders cards + masked table',
      pg.status === 200 && html.includes('Connected Shops') && html.includes('Connection Issues') &&
      html.includes('Corner Store') && !html.includes('+919812345678'), html.slice(0, 200));
  } finally {
    await new Promise((resolve) => supServer.close(resolve));
  }

  // ---------- payload sanitizer ----------
  const { sanitizeMessagePayload } = require('../gateway/src/payload');
  check('WU-PAY-002', 'invoice message without payload rejected', sanitizeMessagePayload('invoice', null).ok === false);
  check('WU-PAY-003', 'non-object payload rejected', sanitizeMessagePayload('invoice', 'str').ok === false);
  check('WU-PAY-004', 'oversized invoice_no rejected', sanitizeMessagePayload('invoice', { invoice: { invoice_no: 'x'.repeat(81) } }).ok === false);
  check('WU-PAY-005', '>500 items rejected', sanitizeMessagePayload('invoice', { invoice: { items: new Array(501).fill({ name: 'a' }) } }).ok === false);
  const sane = sanitizeMessagePayload('invoice', { invoice: { invoice_no: 'I1', items: [{ name: 'x'.repeat(300), quantity: '2', extra: { nested: 1 } }] }, settings: { shop_name: 'S', evil: '<script>' } });
  check('WU-PAY-006', 'snapshot keeps only whitelisted fields',
    sane.ok === true && sane.value.invoice.items[0].name.length === 200 && sane.value.invoice.items[0].extra === undefined && sane.value.settings.evil === undefined && sane.value.invoice.items[0].quantity === 2);

  // ---------- webhook friendly mapping ----------
  const { friendlyWebhookError } = require('../gateway/src/webhook');
  check('WU-FWH-001', 'invalid recipient maps friendly', /not a valid WhatsApp recipient/.test(friendlyWebhookError(131030)));
  check('WU-FWH-002', 'template codes map friendly', /template is not available yet/.test(friendlyWebhookError(132001)));
  check('WU-FWH-003', 'auth code maps to reconnect', /reconnect/.test(friendlyWebhookError(190)));
  check('WU-FWH-004', 'unknown code maps generic', friendlyWebhookError(999999) === 'WhatsApp delivery failed.');

  // ---------- redactor ----------
  const { redact } = require('../lib/redact');
  const dirtyObj = { nested: { auth: 'Bearer mpt_ABC123', u: 'https://x?code=SECRET&sig=s1', e: new Error('boom access_token=EAA999') } };
  const cleanObj = redact(dirtyObj);
  const cleanStr = JSON.stringify(cleanObj);
  check('WU-RED-010', 'redactor handles nested object', !cleanStr.includes('mpt_ABC123') && !cleanStr.includes('SECRET') && !cleanStr.includes('EAA999'), cleanStr);
  check('WU-RED-011', 'redactor preserves Error message sans secret', cleanObj.nested.e instanceof Error && /boom/.test(cleanObj.nested.e.message));
  check('WU-RED-012', 'URL query code/sig/token redacted', /<redacted>/.test(cleanObj.nested.u) && /code=<redacted>/.test(cleanObj.nested.u));
  const plain = { access_token: 'plain-secret', nested: { pin: '123456' }, keep: 'fine' };
  const red1 = redact(plain);
  check('WU-RED-013', 'secret-shaped object keys replaced regardless of value',
    red1.access_token === '<redacted>' && red1.nested.pin === '<redacted>' && red1.keep === 'fine');
  check('WU-RED-014', 'input object is never mutated',
    plain.access_token === 'plain-secret' && plain.nested.pin === '123456');
  const circ = { a: 1, token: 'mpt_loop' };
  circ.self = circ;
  const redCirc = redact(circ);
  check('WU-RED-015', 'circular structures safe + serializable',
    redCirc.self === '[Circular]' && redCirc.token === '<redacted>' && !!JSON.stringify(redCirc));
  const origErr = new Error('failure access_token=EAA777');
  origErr.status = 400;
  origErr.metaCode = 132001;
  const redErr = redact(origErr);
  check('WU-RED-016', 'Error cloned: fields preserved+redacted, original untouched',
    redErr instanceof Error && /failure/.test(redErr.message) && !redErr.message.includes('EAA777') &&
    redErr.status === 400 && redErr.metaCode === 132001 && origErr.message.includes('EAA777'));
  const pwObj = redact({ password: 'hunter2', deviceToken: 'mpt_x', device_token: 'mpt_y', VERIFY_TOKEN: 'zz' });
  check('WU-RED-017', 'password/device token keys redacted case-insensitively',
    pwObj.password === '<redacted>' && pwObj.deviceToken === '<redacted>' && pwObj.device_token === '<redacted>' && pwObj.VERIFY_TOKEN === '<redacted>');

  // ---------- cloudBaseUrl https rule ----------
  const gwClient = require('../lib/whatsapp/gatewayClient');
  process.env.MARTPOS_CLOUD_URL = 'http://gateway.example.com';
  delete process.env.NODE_ENV;
  check('WU-URL-001', 'plain http cloud URL refused in production', gwClient.cloudBaseUrl() === '');
  process.env.NODE_ENV = 'test';
  process.env.MARTPOS_CLOUD_URL = 'http://127.0.0.1:9';
  check('WU-URL-002', 'loopback http allowed under NODE_ENV=test', gwClient.cloudBaseUrl() === 'http://127.0.0.1:9');
  process.env.MARTPOS_CLOUD_URL = 'http://example.evil';
  check('WU-URL-003', 'non-loopback http refused even in test', gwClient.cloudBaseUrl() === '');
  process.env.MARTPOS_CLOUD_URL = 'https://gw.example.com/';
  check('WU-URL-004', 'https cloud URL accepted', gwClient.cloudBaseUrl() === 'https://gw.example.com');

  // ---------- local outbox semantics ----------
  const dbmod = require('../lib/database');
  dbmod.getDatabase().run(
    "INSERT INTO whatsapp_log (invoice_id, invoice_no, phone, status, provider, created_at) VALUES (77, 'INV-77', 'x', 'sent', 'legacy', '2020-01-01')"
  );
  let stMap = outbox.latestStatusMap();
  check('WU-MAP-001', 'Meta row wins over legacy whatsapp_log', stMap[77] && stMap[77].status === 'pending');
  const legacyOnly = 555;
  dbmod.getDatabase().run(
    "INSERT INTO whatsapp_log (invoice_id, invoice_no, phone, status, provider, created_at) VALUES (555, 'INV-555', 'x', 'sent', 'legacy', '2020-01-01')"
  );
  stMap = outbox.latestStatusMap();
  check('WU-MAP-002', 'legacy row fills invoices without Meta rows', stMap[legacyOnly] && stMap[legacyOnly].status === 'sent');

  // infinite local retry: force high attempt count then markRetry stays pending
  dbmod.getDatabase().run("UPDATE whatsapp_queue SET attempt_count = 50, status = 'pending' WHERE idempotency_key = 'invoice:42:+919876543210'");
  const q42 = dbmod.execToObject("SELECT id, message_id FROM whatsapp_queue WHERE idempotency_key = 'invoice:42:+919876543210'");
  outbox.markRetry(q42.id, q42.message_id, { code: 'network', message: 'offline' });
  const q42b = dbmod.execToObject('SELECT status, next_retry_at FROM whatsapp_queue WHERE id = ?', [q42.id]);
  check('WU-RTY-001', 'local forwarding retries indefinitely (capped backoff)', q42b.status === 'pending' && !!q42b.next_retry_at);

  // retryBill transitions
  const inv = { id: 42, invoice_no: 'I-42', total: 5 };
  const rPending = wa.retryBill(inv, '+919876543210');
  check('WU-RTY-002', 'pending message -> duplicate, no resend', rPending.duplicate === true && rPending.messageId === q42.message_id);
  dbmod.getDatabase().run("UPDATE whatsapp_messages SET status = 'failed' WHERE id = ?", [q42.message_id]);
  const rFailed = wa.retryBill(inv, '+919876543210');
  check('WU-RTY-003', 'failed message requeues same message id', rFailed.queued === true && rFailed.messageId === q42.message_id);
  const stillRemote = dbmod.execToObject('SELECT remote_id FROM whatsapp_messages WHERE id = ?', [q42.message_id]);
  check('WU-RTY-004', 'requeue keeps remote_id', stillRemote.remote_id === 'remote-1');
  dbmod.getDatabase().run("UPDATE whatsapp_messages SET status = 'delivered' WHERE id = ?", [q42.message_id]);
  const rDelivered = wa.retryBill(inv, '+919876543210');
  check('WU-RTY-005', 'delivered creates explicit new resend', rDelivered.queued === true && rDelivered.messageId !== q42.message_id);
  dbmod.getDatabase().run("UPDATE whatsapp_messages SET status = 'sent' WHERE id = (SELECT MAX(id) FROM whatsapp_messages WHERE invoice_id = 42)");
  const rSent = wa.retryBill(inv, '+919876543210');
  check('WU-RTY-006', 'sent is in-flight -> duplicate', rSent.duplicate === true);

  // worker: remote retry path uses retryMessage, never re-posts
  const worker = require('../lib/whatsapp/worker');
  const providerCalls = [];
  worker._setServiceForTests({
    sendInvoice: async () => { providerCalls.push('sendInvoice'); return { message: { id: 'rx' } }; },
    retryMessage: async (ctx, id) => { providerCalls.push(['retryMessage', id]); return { ok: true }; }
  });
  dbmod.getDatabase().run("UPDATE whatsapp_queue SET status = 'pending', next_retry_at = '2020-01-01T00:00:00.000Z' WHERE message_id = ?", [q42.message_id]);
  dbmod.getDatabase().run("UPDATE whatsapp_messages SET status = 'pending' WHERE id = ?", [q42.message_id]);
  await worker.forwardDueJobs();
  check('WU-RTY-007', 'remote_id job uses retryMessage not sendInvoice',
    providerCalls.some((c) => Array.isArray(c) && c[0] === 'retryMessage' && c[1] === 'remote-1') && !providerCalls.includes('sendInvoice'),
    JSON.stringify(providerCalls));
  const requeuedQ = dbmod.execToObject('SELECT status FROM whatsapp_queue WHERE message_id = ?', [q42.message_id]);
  check('WU-RTY-008', 'remote requeue leaves job forwarded/pending', requeuedQ.status === 'forwarded');
  worker._setServiceForTests(new (require('../lib/whatsapp/service').WhatsAppService)(require('../lib/whatsapp/localProvider').createGatewayProvider()));

  // cursor polling: two pages, equal-timestamp continuation
  const client = require('../lib/whatsapp/gatewayClient');
  const origApi = client.api;
  const apiCalls = [];
  const pages = [
    { ok: true, updates: [{ id: 'remote-1', status: 'read', read_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z' }], next: { updated_at: '2026-02-01T00:00:00.000Z', id: 'remote-1' }, has_more: true },
    { ok: true, updates: [{ id: 'remote-1', status: 'read', read_at: '2026-02-01T00:00:01.000Z', updated_at: '2026-02-01T00:00:00.000Z' }], next: { updated_at: '2026-02-01T00:00:00.000Z', id: 'remote-2' }, has_more: false }
  ];
  client.api = async (p) => { apiCalls.push(p); return pages.shift() || { ok: true, updates: [], next: null, has_more: false }; };
  dbmod.getDatabase().run("UPDATE settings SET value = '2026-01-01T00:00:00.000Z' WHERE key = 'whatsapp_updates_since'");
  dbmod.getDatabase().run("UPDATE settings SET value = '' WHERE key = 'whatsapp_updates_after_id'");
  await worker.pollUpdates();
  check('WU-CUR-003', 'cursor pages forward with after_id',
    apiCalls.length === 2 && /after_id=remote-1/.test(apiCalls[1]), JSON.stringify(apiCalls));
  check('WU-CUR-004', 'cursor persisted from response next',
    require('../lib/settings').getSetting('whatsapp_updates_since') === '2026-02-01T00:00:00.000Z' &&
    require('../lib/settings').getSetting('whatsapp_updates_after_id') === 'remote-2');
  apiCalls.length = 0;
  client.api = async (p) => { apiCalls.push(p); return { ok: true, updates: [], next: null, has_more: false }; };
  dbmod.getDatabase().run("UPDATE settings SET value = '2026-02-01T00:00:00.000Z' WHERE key = 'whatsapp_updates_since'");
  await worker.pollUpdates();
  check('WU-CUR-005', 'empty page leaves cursor unchanged',
    require('../lib/settings').getSetting('whatsapp_updates_since') === '2026-02-01T00:00:00.000Z' && apiCalls.length === 1);
  client.api = origApi;

  // ---------- default template is text-only with examples ----------
  const def = tpl.invoiceTemplateDefinition();
  check('WU-DEF-001', 'default template has no document header',
    !def.components.some((c) => c.type === 'HEADER'));
  const defBody = def.components.find((c) => c.type === 'BODY');
  check('WU-DEF-002', 'default template declares 8-value body_text examples',
    Array.isArray(defBody.example.body_text) && defBody.example.body_text[0].length === 8);
  check('WU-DEF-002b', 'default body has 8 positional params',
    (defBody.text.match(/\{\{\d\}\}/g) || []).length === 8);
  const upArgs = [];
  const origUpsert = gwStore.upsertTemplate;
  gwStore.upsertTemplate = async (q, t) => { upArgs.push(t); return t; };
  const createMeta = { createMessageTemplate: async () => ({ id: 't9', status: 'PENDING' }), findMessageTemplate: async () => ({ data: [] }) };
  await tpl.ensureInvoiceTemplate({ query: async () => ({ rows: [], rowCount: 0 }) }, createMeta, 's1', 'W1');
  gwStore.upsertTemplate = origUpsert;
  check('WU-DEF-003', 'default template persists document_header=false',
    upArgs.length === 1 && upArgs[0].documentHeader === false, JSON.stringify(upArgs));

  // APPROVED text-only template send makes no media upload
  const sendCalls2 = [];
  const oGC = gwStore.getConnection, oGT = gwStore.getTemplate, oUT = gwStore.upsertTemplate, oFJ = gwStore.failJob;
  gwStore.getConnection = async () => ({ status: 'connected', access_token_ciphertext: tokEnc.ciphertext, access_token_iv: tokEnc.iv, access_token_tag: tokEnc.tag, business_account_id: 'W1', phone_number_id: 'PN1' });
  gwStore.getTemplate = async () => ({ name: 'mart_pos_invoice', language: 'en_US', status: 'APPROVED', document_header: false });
  const metaTxt = {
    sendTemplate: async (pid, t) => { sendCalls2.push(['sendTemplate', t.components]); return { messages: [{ id: 'wamid.T' }] }; },
    uploadMedia: async () => { sendCalls2.push(['uploadMedia']); return { id: 'x' }; }
  };
  const finCalls = [];
  const oFin = gwStore.finishJob;
  gwStore.finishJob = async (q, qid, mid, o) => { finCalls.push(o); };
  await qw.processJob(
    { pool: {}, config: { encryptionKey: ENC_KEY }, metaFor: () => metaTxt },
    { queue_id: 'q1', id: 'm1', shop_id: 's1', queue_attempts: 0, normalized_phone: '+9198', payload: { invoice: { invoice_no: 'I1', total: 5 } } }
  );
  check('WU-DEF-004', 'text template send makes no media upload',
    !sendCalls2.some((c) => c[0] === 'uploadMedia') && sendCalls2.some((c) => c[0] === 'sendTemplate'));
  check('WU-DEF-005', 'text template sends body-only components',
    sendCalls2[0] && sendCalls2[0][1].every((c) => c.type === 'body'));

  // bodyParameters order: customer, shop, invoice_no, count, subtotal, discount, total, payment
  const sentBodies = [];
  const metaCap = { sendTemplate: async (pid, t) => { sentBodies.push(t.components.find((c) => c.type === 'body').parameters.map((p) => p.text)); return { messages: [{ id: 'wamid.T' }] }; } };
  await qw.processJob(
    { pool: {}, config: { encryptionKey: ENC_KEY }, metaFor: () => metaCap },
    { queue_id: 'q3', id: 'm3', shop_id: 's1', queue_attempts: 0, normalized_phone: '+9198',
      payload: { invoice: { invoice_no: 'I-9', party_name: 'Ravi', subtotal: 1000, discount: 50, total: 950, payment_method: 'Cash', items: Array.from({ length: 48 }, () => ({ name: 'x' })) }, settings: { shop_name: 'Corner' } } }
  );
  check('WU-DEF-006', 'body params exact order (48-item invoice)',
    JSON.stringify(sentBodies[0]) === JSON.stringify(['Ravi', 'Corner', 'I-9', '48', 'INR 1000.00', 'INR 50.00', 'INR 950.00', 'Cash']),
    JSON.stringify(sentBodies[0]));
  await qw.processJob(
    { pool: {}, config: { encryptionKey: ENC_KEY }, metaFor: () => metaCap },
    { queue_id: 'q4', id: 'm4', shop_id: 's1', queue_attempts: 0, normalized_phone: '+9198',
      payload: { invoice: { invoice_no: 'I-10', subtotal: 20, discount: 0, total: 20, payment_method: 'UPI', items: [] }, settings: {} } }
  );
  check('WU-DEF-007', 'empty items + UPI + customer fallback',
    JSON.stringify(sentBodies[1]) === JSON.stringify(['Customer', 'Mart POS', 'I-10', '0', 'INR 20.00', 'INR 0.00', 'INR 20.00', 'UPI']),
    JSON.stringify(sentBodies[1]));
  await qw.processJob(
    { pool: {}, config: { encryptionKey: ENC_KEY }, metaFor: () => metaCap },
    { queue_id: 'q5', id: 'm5', shop_id: 's1', queue_attempts: 0, normalized_phone: '+9198',
      payload: { invoice: { invoice_no: 'I-11', payment_method: 'Card', total: 7.5 }, settings: { shop_name: 'S' } } }
  );
  check('WU-DEF-008', 'Card payment string + missing figures default to 0.00',
    sentBodies[2][7] === 'Card' && sentBodies[2][4] === 'INR 0.00' && sentBodies[2][6] === 'INR 7.50',
    JSON.stringify(sentBodies[2]));
  gwStore.getConnection = oGC; gwStore.getTemplate = oGT; gwStore.upsertTemplate = oUT; gwStore.failJob = oFJ; gwStore.finishJob = oFin;

  // ---------- connection expiry ----------
  const { connectionState } = require('../gateway/src/status');
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 3600e3).toISOString();
  check('WU-EXP-001', 'expired connected -> needs_reconnect',
    connectionState({ status: 'connected', token_expires_at: past }).needs_reconnect === true);
  check('WU-EXP-002', 'expired friendly message exact',
    connectionState({ status: 'connected', token_expires_at: past }).friendly === 'WhatsApp connection expired. Please reconnect WhatsApp.');
  check('WU-EXP-003', 'valid token stays connected',
    connectionState({ status: 'connected', token_expires_at: future }).connected === true);
  check('WU-EXP-004', 'no expiry recorded stays connected',
    connectionState({ status: 'connected', token_expires_at: null }).connected === true);
  check('WU-EXP-005', 'null conn is disconnected', connectionState(null).status === 'disconnected');

  const expCalls = [];
  gwStore.getConnection = async () => ({ status: 'connected', token_expires_at: past, access_token_ciphertext: tokEnc.ciphertext, access_token_iv: tokEnc.iv, access_token_tag: tokEnc.tag, business_account_id: 'W1', phone_number_id: 'PN1' });
  const oMCE = gwStore.markConnectionError;
  gwStore.markConnectionError = async (q, s, st, m) => { expCalls.push(['connErr', st, m]); };
  gwStore.failJob = async (q, qid, mid, o) => { expCalls.push(['failJob', o.code, o.message]); };
  const metaNever = { sendTemplate: async () => { expCalls.push(['sendTemplate']); }, uploadMedia: async () => { expCalls.push(['uploadMedia']); }, findMessageTemplate: async () => ({ data: [] }) };
  await qw.processJob(
    { pool: {}, config: { encryptionKey: ENC_KEY }, metaFor: () => metaNever },
    { queue_id: 'q2', id: 'm2', shop_id: 's1', queue_attempts: 0, normalized_phone: '+9198', payload: { invoice: { invoice_no: 'I2' } } }
  );
  check('WU-EXP-006', 'expired conn fails job before any Meta call',
    expCalls.some((c) => c[0] === 'connErr' && c[1] === 'needs_reconnect') &&
    expCalls.some((c) => c[0] === 'failJob' && c[2] === 'WhatsApp connection expired. Please reconnect WhatsApp.') &&
    !expCalls.some((c) => c[0] === 'sendTemplate' || c[0] === 'uploadMedia'),
    JSON.stringify(expCalls));
  gwStore.getConnection = oGC; gwStore.markConnectionError = oMCE; gwStore.failJob = oFJ;

  // ---------- webhook timestamp backfill ----------
  const wh = require('../gateway/src/webhook');
  const whQueries = [];
  const fakeQ = { query: async (sql, params = []) => {
    whQueries.push(sql);
    if (/FROM whatsapp_connections/.test(sql)) return { rows: [{ shop_id: 's1' }], rowCount: 1 };
    if (/FROM whatsapp_messages WHERE shop_id/.test(sql)) return { rows: [{ id: 'm1', status: 'pending' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  await wh.applyStatusUpdates(fakeQ, [{ wabaId: 'W1', phoneNumberId: 'PN1', metaMessageId: 'wamid.R', status: 'read', ts: '2026-03-01T00:00:00.000Z' }]);
  const readSql = whQueries.find((s) => /UPDATE whatsapp_messages SET status/.test(s));
  check('WU-WB-001', 'read backfills sent_at+delivered_at+read_at via COALESCE',
    /sent_at = COALESCE\(sent_at/.test(readSql) && /delivered_at = COALESCE\(delivered_at/.test(readSql) && /read_at = COALESCE\(read_at/.test(readSql), readSql);
  whQueries.length = 0;
  await wh.applyStatusUpdates(fakeQ, [{ wabaId: 'W1', phoneNumberId: 'PN1', metaMessageId: 'wamid.R', status: 'delivered', ts: '2026-03-01T00:00:00.000Z' }]);
  const delSql = whQueries.find((s) => /UPDATE whatsapp_messages SET status/.test(s));
  check('WU-WB-002', 'delivered backfills sent_at+delivered_at, not read_at',
    /sent_at = COALESCE/.test(delSql) && /delivered_at = COALESCE/.test(delSql) && !/read_at = COALESCE/.test(delSql), delSql);

  // ---------- trust proxy + security headers ----------
  threw = false;
  try { loadConfig({ ...goodEnv, GATEWAY_TRUST_PROXY: 'yes' }); } catch (_) { threw = true; }
  check('WU-TP-001', 'non-numeric trust proxy rejected', threw);
  threw = false;
  try { loadConfig({ ...goodEnv, GATEWAY_TRUST_PROXY: '9' }); } catch (_) { threw = true; }
  check('WU-TP-002', 'trust proxy >5 rejected', threw);
  check('WU-TP-003', 'trust proxy accepts 1-5/false/0',
    loadConfig({ ...goodEnv, GATEWAY_TRUST_PROXY: '3' }).trustProxy === 3 &&
    loadConfig({ ...goodEnv, GATEWAY_TRUST_PROXY: 'false' }).trustProxy === false &&
    loadConfig({ ...goodEnv }).trustProxy === 1);

  const hdrQueries = [];
  const hdrPool = {
    query: (sql, p) => { hdrQueries.push(sql); return gwHandler(sql, p); },
    connect: async () => ({ query: (sql, p) => { hdrQueries.push(sql); return gwHandler(sql, p); }, release() {} })
  };
  const hdrApp = createApp({ config: gwConfig, pool: hdrPool });
  const hdrServer = await new Promise((resolve) => { const s = hdrApp.listen(0, () => resolve(s)); });
  const hdrPort = hdrServer.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${hdrPort}/`);
    check('WU-HDR-001', 'security headers on JSON routes',
      r.headers.get('x-content-type-options') === 'nosniff' &&
      r.headers.get('referrer-policy') === 'no-referrer' &&
      r.headers.get('x-frame-options') === 'DENY');
    const sessPool = {
      query: async (sql, p) => {
        if (/FROM onboarding_sessions/.test(sql)) return { rows: [{ id: 's1', shop_id: 'shop1' }], rowCount: 1 };
        return gwHandler(sql, p);
      }
    };
    const onbApp = createApp({ config: gwConfig, pool: sessPool });
    const onbServer = await new Promise((resolve) => { const s = onbApp.listen(0, () => resolve(s)); });
    try {
      const or = await fetch(`http://127.0.0.1:${onbServer.address().port}/onboarding/sometoken`);
      const csp = or.headers.get('content-security-policy') || '';
      const html = await or.text();
      check('WU-HDR-002', 'onboarding CSP allows only fb sdk + graph',
        /script-src 'self' 'nonce-[^']+' https:\/\/connect\.facebook\.net/.test(csp) &&
        /connect-src 'self' https:\/\/graph\.facebook\.com/.test(csp) &&
        /style-src 'unsafe-inline'/.test(csp) && !csp.includes("*"), csp);
      check('WU-HDR-003', 'inline script carries the nonce',
        /<script nonce="[^"]+"/.test(html));
    } finally {
      await new Promise((resolve) => onbServer.close(resolve));
    }
  } finally {
    await new Promise((resolve) => hdrServer.close(resolve));
  }

  // ---------- forced status refresh ----------
  const origApi2 = client.api;
  client.api = async () => ({
    ok: true,
    connection: {
      status: 'connected', connected: true, needs_reconnect: false,
      display_phone_number: '+919800011122', business_name: 'Biz Mart',
      phone_number_id: 'PN-secret', business_account_id: 'W-secret',
      template: { name: 'mart_pos_invoice', status: 'APPROVED', document_enabled: false }
    }
  });
  const ref = await wa.refreshWhatsAppStatus();
  check('WU-RFS-001', 'refreshWhatsAppStatus fetches + returns cached connection',
    ref && ref.status === 'connected' && ref.template.status === 'APPROVED');
  const stAfter = wa.whatsappStatus();
  check('WU-RFS-002', 'local status masks number, drops Meta ids, keeps template',
    stAfter.configured === true && stAfter.connection.connected === true &&
    !JSON.stringify(stAfter).includes('+919800011122') &&
    !JSON.stringify(stAfter).includes('PN-secret') && !JSON.stringify(stAfter).includes('W-secret') &&
    stAfter.connection.template.document_enabled === false,
    JSON.stringify(stAfter.connection));
  let statusCalls = 0;
  client.api = async () => { statusCalls++; await new Promise((r) => setTimeout(r, 30)); return { ok: true, connection: { status: 'connected', connected: true } }; };
  const [ra, rb] = await Promise.all([wa.refreshWhatsAppStatus(), wa.refreshWhatsAppStatus()]);
  check('WU-RFS-003', 'concurrent refreshes share one gateway request',
    statusCalls === 1 && ra && ra.status === 'connected' && rb.status === 'connected', `calls=${statusCalls}`);
  client.api = origApi2;
  worker.setCachedConnection(null);

  // ---------- default country code ----------
  dbmod.getDatabase().run("INSERT OR REPLACE INTO settings (key, value) VALUES ('whatsapp_default_country_code', '+971')");
  check('WU-CC-001', 'bare 10-digit uses configured default country code',
    wa.normalizeWhatsAppNumber('9876543210') === '+9719876543210');
  check('WU-CC-002', 'explicit option overrides the setting',
    wa.normalizeWhatsAppNumber('9876543210', { defaultCountryCode: '+61' }) === '+619876543210');
  check('WU-CC-003', 'explicit international number unaffected by setting',
    wa.normalizeWhatsAppNumber('+14155552671') === '+14155552671');
  dbmod.getDatabase().run("UPDATE settings SET value = '+91' WHERE key = 'whatsapp_default_country_code'");
  check('WU-CC-004', 'setting restored', wa.normalizeWhatsAppNumber('9876543210') === '+919876543210');
  dbmod.getDatabase().run("UPDATE settings SET value = '+1' WHERE key = 'whatsapp_default_country_code'");
  check('WU-CC-005', 'non-Indian default accepts 2-9 bare 10-digit', wa.normalizeWhatsAppNumber('4155550123') === '+14155550123');
  check('WU-CC-006', 'explicit international unaffected under +1', wa.normalizeWhatsAppNumber('+14155552671') === '+14155552671');
  dbmod.getDatabase().run("UPDATE settings SET value = '+91' WHERE key = 'whatsapp_default_country_code'");
  threw = false;
  try { wa.normalizeWhatsAppNumber('4155550123'); } catch (_) { threw = true; }
  check('WU-CC-007', 'non-Indian-shape bare number rejected under +91', threw);

  // disconnect invalidates the cached connection immediately
  process.env.MARTPOS_CLOUD_URL = 'http://127.0.0.1:9';
  worker.setCachedConnection({ status: 'connected' });
  await wa.disconnectWhatsApp();
  check('WU-DISC-001', 'disconnect clears cached connection',
    wa.whatsappStatus().connection.status === 'disconnected' && wa.whatsappStatus().configured === false);

  // ---------- platform config baking ----------
  const bpc = require('../build-platform-config');
  const { validateCloudBaseUrl } = require('../lib/whatsapp/gatewayClient');
  const tmpCfg = path.join(os.tmpdir(), `mpcfg-${process.pid}.json`);
  bpc.writePlatformConfig({ env: { MARTPOS_CLOUD_URL: 'https://gw.example.com/' }, outputPath: tmpCfg });
  check('WU-PC-001', 'https url baked, trailing slash stripped',
    JSON.parse(fs.readFileSync(tmpCfg, 'utf8')).cloudGatewayUrl === 'https://gw.example.com');
  bpc.writePlatformConfig({ env: {}, outputPath: tmpCfg });
  check('WU-PC-002', 'empty env writes empty config file',
    JSON.parse(fs.readFileSync(tmpCfg, 'utf8')).cloudGatewayUrl === '');
  fs.unlinkSync(tmpCfg);
  threw = false;
  try { bpc.writePlatformConfig({ env: { MARTPOS_CLOUD_URL: 'http://evil.example', NODE_ENV: 'production' }, outputPath: tmpCfg }); }
  catch (_) { threw = true; }
  check('WU-PC-003', 'production http url rejected, nothing written', threw && !fs.existsSync(tmpCfg));
  check('WU-PC-004', 'loopback http accepted in test env', validateCloudBaseUrl('http://127.0.0.1:8080', 'test') === 'http://127.0.0.1:8080');
  check('WU-PC-005', 'http non-loopback rejected in production', validateCloudBaseUrl('http://gw.example', 'production') === '');
  check('WU-PC-006', 'http non-loopback rejected in dev', validateCloudBaseUrl('http://gw.example', 'development') === '');
  check('WU-PC-007', 'empty value normalized to empty', validateCloudBaseUrl('', 'production') === '' && validateCloudBaseUrl('  ', 'test') === '');

  console.log(`\n===== SUMMARY ===== total=${results.length} pass=${results.length - failures} fail=${failures}`);
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('unit test crashed:', e);
  process.exit(2);
});
