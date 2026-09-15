// Gateway <-> PostgreSQL integration test. Requires a disposable database:
//   TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/martpos_gw_test node qa/gateway_postgres_integration.js
// Rerunnable: schema.sql is applied twice, then all tables are truncated.
// No real Meta calls - a fake Meta client is injected via metaFor.
// Skips cleanly when TEST_DATABASE_URL is not set.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(id, name, ok, detail = '') {
  if (ok) { pass++; console.log(`[PASS] ${id} ${name}`); }
  else { fail++; console.log(`[FAIL] ${id} ${name}${detail ? ' :: ' + String(detail).slice(0, 300) : ''}`); }
}

const URL = process.env.TEST_DATABASE_URL;

(async () => {
  if (!URL) {
    console.log('[SKIP] TEST_DATABASE_URL not set - no disposable PostgreSQL available');
    process.exit(0);
  }
  const { Pool } = require('../gateway/node_modules/pg');
  const pool = new Pool({ connectionString: URL });
  const schema = fs.readFileSync(path.join(__dirname, '..', 'gateway', 'schema.sql'), 'utf8');

  // ---- schema idempotent + clean slate ----
  try {
    await pool.query(schema);
    await pool.query(schema);
    check('PG-001', 'schema.sql applies twice (idempotent)', true);
    await pool.query(`TRUNCATE webhook_events, whatsapp_queue, whatsapp_messages,
      whatsapp_templates, whatsapp_connections, onboarding_sessions, devices, shops, owners
      RESTART IDENTITY CASCADE`);
  } catch (e) {
    check('PG-001', 'schema.sql applies twice (idempotent)', false, e.message);
    await pool.end();
    process.exit(1);
  }

  const config = require('../gateway/src/config').loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: URL, GATEWAY_PUBLIC_URL: 'https://gw.test',
    GATEWAY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    META_APP_ID: 'a', META_APP_SECRET: 's', META_EMBEDDED_SIGNUP_CONFIG_ID: 'c',
    META_WEBHOOK_VERIFY_TOKEN: 'vt',
    GATEWAY_SUPPORT_USERNAME: 'sup',
    GATEWAY_SUPPORT_PASSWORD_HASH: require('bcryptjs').hashSync('pw', 4)
  });

  // Fake Meta: W1 owns PN1, W2 owns PN2. Calls are tracked.
  const metaCalls = [];
  const WABA_NUMBERS = {
    W1: [{ id: 'PN1', display_phone_number: '+919811100001', verified_name: 'Biz A' }],
    W2: [{ id: 'PN2', display_phone_number: '+919822200002', verified_name: 'Biz B' }]
  };
  const fakeMeta = {
    exchangeCode: async () => { metaCalls.push('exchangeCode'); return { access_token: 'EAA_test', expires_in: 7200 }; },
    listPhoneNumbers: async (wabaId) => { metaCalls.push('listPhoneNumbers'); return { data: WABA_NUMBERS[wabaId] || [] }; },
    registerPhone: async () => { metaCalls.push('registerPhone'); return {}; },
    subscribeWaba: async () => { metaCalls.push('subscribeWaba'); return {}; },
    unsubscribeWaba: async () => { metaCalls.push('unsubscribeWaba'); return {}; },
    findMessageTemplate: async () => ({ data: [{ id: 'mt1', status: 'APPROVED' }] }),
    createMessageTemplate: async () => ({ id: 'mt1', status: 'PENDING' }),
    uploadMedia: async () => ({ id: 'media1' }),
    sendTemplate: async (phoneId, t) => { metaCalls.push(`sendTemplate:${phoneId}`); return { messages: [{ id: 'wamid.pg1' }] }; }
  };

  const store = require('../gateway/src/store');
  const { createApp } = require('../gateway/src/app');
  const app = createApp({ config, pool, metaFor: () => fakeMeta });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const api = async (m, p, { token, body, raw, headers } = {}) => {
    const h = { ...(headers || {}) };
    if (token) h.authorization = `Bearer ${token}`;
    const res = await fetch(base + p, { method: m, headers: h, body: raw ? body : (body ? JSON.stringify(body) : undefined) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* html */ }
    return { status: res.status, json, text };
  };
  const q1 = async (sql, params) => (await pool.query(sql, params)).rows;

  try {
    // ---- register + onboard A and B ----
    const regA = await api('POST', '/v1/auth/register', { body: { email: 'a@test.dev', password: 'password1234', shopName: 'Shop A' } });
    const regB = await api('POST', '/v1/auth/register', { body: { email: 'b@test.dev', password: 'password1234', shopName: 'Shop B' } });
    const regC = await api('POST', '/v1/auth/register', { body: { email: 'c@test.dev', password: 'password1234', shopName: 'Shop C' } });
    check('PG-010', 'three owners/shops/devices registered', !!(regA.json?.deviceToken && regB.json?.deviceToken && regC.json?.deviceToken));
    const tokA = regA.json.deviceToken, tokB = regB.json.deviceToken, tokC = regC.json.deviceToken;
    const shopA = regA.json.shop.id, shopB = regB.json.shop.id, shopC = regC.json.shop.id;

    const onboard = async (token, wabaId, phoneNumberId) => {
      const cs = await api('POST', '/v1/whatsapp/connect-session', { token, body: {} });
      const obToken = new URL(cs.json.onboardingUrl).pathname.split('/').pop();
      return api('POST', `/onboarding/${obToken}/complete`, { body: { code: 'oc', wabaId, phoneNumberId, pin: '654321' } });
    };
    let r = await onboard(tokA, 'W1', 'PN1');
    check('PG-011', 'shop A onboarded on PN1', r.status === 200 && r.json.ok === true);
    r = await onboard(tokB, 'W2', 'PN2');
    check('PG-012', 'shop B onboarded on PN2', r.status === 200 && r.json.ok === true);

    // A third shop trying to claim PN1 gets the safe conflict - no connection written.
    r = await onboard(tokC, 'W1', 'PN1');
    check('PG-013', 'shop C claiming PN1 gets safe conflict', r.status === 400 && /already connected to another/i.test(r.json?.error || '') && !/PN1|W1/.test(JSON.stringify(r.json)), JSON.stringify(r.json));
    const cConn = await q1('SELECT COUNT(*) c FROM whatsapp_connections WHERE shop_id = $1', [shopC]);
    check('PG-014', 'no connection row for shop C', Number(cConn[0].c) === 0);

    // ---- enqueue under A; shop_id in body must be ignored ----
    r = await api('POST', '/v1/whatsapp/messages', { token: tokA, body: { idempotency_key: 'pa1', normalized_phone: '+919876543210', message_type: 'invoice', payload: { invoice: { invoice_no: 'A-1' } } } });
    const msgA1 = r.json?.message?.id;
    r = await api('POST', '/v1/whatsapp/messages', { token: tokA, body: { shop_id: shopB, idempotency_key: 'pa2', normalized_phone: '+919876543210', message_type: 'invoice', payload: { invoice: { invoice_no: 'A-2' } } } });
    const msgA2 = r.json?.message?.id;
    const ownerCheck = await q1('SELECT id, shop_id FROM whatsapp_messages WHERE id = ANY($1::text[])', [[msgA1, msgA2].filter(Boolean)]);
    check('PG-020', 'enqueued rows belong to A despite shop_id in body',
      ownerCheck.length === 2 && ownerCheck.every((x) => x.shop_id === shopA), JSON.stringify(ownerCheck));
    const bCount0 = await q1('SELECT COUNT(*) c FROM whatsapp_messages WHERE shop_id = $1', [shopB]);
    check('PG-021', 'nothing written to shop B', Number(bCount0[0].c) === 0);

    r = await api('POST', '/v1/whatsapp/messages', { token: tokB, body: { idempotency_key: 'pb1', normalized_phone: '+919876543210', message_type: 'invoice', payload: { invoice: { invoice_no: 'B-1' } } } });
    const msgB1 = r.json?.message?.id;
    check('PG-022', 'shop B enqueued its own message', !!msgB1);

    // ---- cross-tenant retry rejected ----
    const bBefore = await q1('SELECT status FROM whatsapp_messages WHERE id = $1', [msgB1]);
    r = await api('POST', `/v1/whatsapp/messages/${msgB1}/retry`, { token: tokA, body: {} });
    const bAfter = await q1('SELECT status FROM whatsapp_messages WHERE id = $1', [msgB1]);
    check('PG-030', 'A cannot retry B message uuid', (r.status === 409 || r.status === 404) && bBefore[0].status === bAfter[0].status, `status=${r.status}`);

    // ---- concurrent claimDueJobs: disjoint, complete ----
    const [c1, c2] = await Promise.all([store.claimDueJobs(pool, 10), store.claimDueJobs(pool, 10)]);
    const claimed = [...c1, ...c2];
    const ids = new Set(claimed.map((x) => x.queue_id));
    check('PG-040', 'concurrent claims are disjoint', ids.size === claimed.length);
    check('PG-041', 'all three pending jobs claimed exactly once', ids.size === 3, `claimed=${ids.size}`);

    // ---- process A's first message through the queue worker ----
    const jobA1 = claimed.find((j) => j.id === msgA1);
    const qw = require('../gateway/src/queueWorker');
    await qw.processJob({ pool, config, metaFor: () => fakeMeta }, jobA1);
    const mRow = await q1('SELECT status, meta_message_id FROM whatsapp_messages WHERE id = $1', [msgA1]);
    check('PG-050', 'processJob sent A1 and stored meta_message_id', mRow[0].status === 'sent' && mRow[0].meta_message_id === 'wamid.pg1', JSON.stringify(mRow[0]));

    // ---- webhooks: sent->delivered->read->failed (failed must not downgrade) ----
    const mkWh = (st, ts, err) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W1', changes: [{ value: { metadata: { phone_number_id: 'PN1' }, statuses: [{ id: 'wamid.pg1', status: st, timestamp: ts, ...(err ? { errors: [{ code: 131026, title: 'raw title never persisted' }] } : {}) }] } }] }] });
    const postWh = async (b) => api('POST', '/webhooks/meta', { raw: true, body: b, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', config.meta.appSecret).update(Buffer.from(b)).digest('hex') } });
    r = await api('POST', '/webhooks/meta', { raw: true, body: mkWh('sent', '1700000000'), headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } });
    check('PG-060', 'invalid signature rejected', r.status === 401);
    const bSent = mkWh('sent', '1700000100');
    r = await postWh(bSent);
    check('PG-061', 'sent webhook applied', r.status === 200);
    r = await postWh(bSent);
    check('PG-062', 'duplicate webhook returns duplicate', r.status === 200 && r.json.duplicate === true);
    await postWh(mkWh('delivered', '1700000200'));
    await postWh(mkWh('read', '1700000300'));
    await postWh(mkWh('failed', '1700000400', true));
    const final = await q1('SELECT status, sent_at, delivered_at, read_at, error_message FROM whatsapp_messages WHERE id = $1', [msgA1]);
    check('PG-063', 'failed webhook cannot downgrade read', final[0].status === 'read');
    check('PG-064', 'all progression timestamps present', !!(final[0].sent_at && final[0].delivered_at && final[0].read_at));
    check('PG-065', 'raw Meta title never persisted', !/raw title/i.test(String(final[0].error_message || '')));

    // ---- withTx rollback on real Postgres ----
    const dg = crypto.randomBytes(16).toString('hex');
    let threw = false;
    try {
      await store.withTx(pool, async (q) => {
        await store.insertWebhookEvent(q, dg);
        throw new Error('forced');
      });
    } catch (_) { threw = true; }
    const dgRows = await q1('SELECT COUNT(*) c FROM webhook_events WHERE digest = $1', [dg]);
    check('PG-070', 'failed tx rolls back dedupe insert', threw === true && Number(dgRows[0].c) === 0);
    const dg2 = await store.withTx(pool, async (q) => store.insertWebhookEvent(q, dg));
    const dgRows2 = await q1('SELECT COUNT(*) c FROM webhook_events WHERE digest = $1', [dg]);
    check('PG-071', 'retry inserts the digest after rollback', dg2 === true && Number(dgRows2[0].c) === 1);

    // ---- disconnect A: only A's rows affected ----
    r = await api('POST', '/v1/whatsapp/disconnect', { token: tokA, body: {} });
    check('PG-080', 'A disconnect responds ok', r.status === 200);
    const connA = await q1('SELECT status, access_token_ciphertext FROM whatsapp_connections WHERE shop_id = $1', [shopA]);
    check('PG-081', 'A connection disconnected + token cleared', connA[0].status === 'disconnected' && connA[0].access_token_ciphertext === '');
    const cancA = await q1("SELECT COUNT(*) c FROM whatsapp_queue q JOIN whatsapp_messages m ON m.id = q.message_id WHERE m.shop_id = $1 AND q.status = 'cancelled'", [shopA]);
    check('PG-082', 'A unsent jobs cancelled', Number(cancA[0].c) >= 1);
    const connB = await q1('SELECT status, access_token_ciphertext FROM whatsapp_connections WHERE shop_id = $1', [shopB]);
    check('PG-083', 'B connection untouched', connB[0].status === 'connected' && connB[0].access_token_ciphertext !== '');
    const qB = await q1("SELECT q.status FROM whatsapp_queue q JOIN whatsapp_messages m ON m.id = q.message_id WHERE m.id = $1", [msgB1]);
    check('PG-084', 'B pending job unchanged (still claimable state)', qB[0].status === 'processing' || qB[0].status === 'pending', JSON.stringify(qB[0]));

    // ---- support diagnostics: safe fields only ----
    const basic = 'Basic ' + Buffer.from('sup:pw').toString('base64');
    r = await api('GET', '/v1/support/diagnostics', { headers: { authorization: basic } });
    const raw = JSON.stringify(r.json);
    check('PG-090', 'diagnostics lists shops with masked numbers',
      r.status === 200 && r.json.ok === true && r.json.shops.length === 3 && r.json.shops.every((s) => !String(s.display_number).includes('9811100001')));
    check('PG-091', 'diagnostics contain no ids/tokens/raw numbers',
      !/(shop_id|device_id|meta_message_id|access_token|waba|phone_number_id|ciphertext|mpt_)/i.test(raw), raw.slice(0, 300));
    r = await api('GET', '/v1/support/diagnostics');
    check('PG-092', 'diagnostics requires basic auth', r.status === 401);
  } finally {
    await new Promise((r) => server.close(r));
    await pool.end();
  }

  console.log(`===== SUMMARY ===== total=${pass + fail} pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('gateway integration crashed:', e && e.message); process.exit(2); });
