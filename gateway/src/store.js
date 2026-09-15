// Every function takes a queryable `q` (Pool or tx client) so handlers stay
// thin and tests can inject a fake.
const crypto = require('crypto');

async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw e;
  } finally {
    client.release();
  }
}


async function findOwnerByEmail(q, email) {
  const r = await q.query('SELECT id, email, password_hash FROM owners WHERE lower(email) = lower($1)', [email]);
  return r.rows[0] || null;
}

async function createAccount(pool, { email, passwordHash, shopName, deviceName, tokenHash }) {
  return withTx(pool, async (q) => {
    const ownerId = crypto.randomUUID();
    const shopId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    await q.query('INSERT INTO owners (id, email, password_hash) VALUES ($1, $2, $3)', [ownerId, email, passwordHash]);
    await q.query('INSERT INTO shops (id, owner_id, name) VALUES ($1, $2, $3)', [shopId, ownerId, shopName]);
    await q.query('INSERT INTO devices (id, shop_id, name, token_hash) VALUES ($1, $2, $3, $4)',
      [deviceId, shopId, deviceName || 'POS device', tokenHash]);
    return { ownerId, shop: { id: shopId, name: shopName } };
  });
}

async function createDevice(q, { shopId, name, tokenHash }) {
  const id = crypto.randomUUID();
  await q.query('INSERT INTO devices (id, shop_id, name, token_hash) VALUES ($1, $2, $3, $4)',
    [id, shopId, name || 'POS device', tokenHash]);
  return { id, shop_id: shopId, name };
}

// Bearer-token lookup. Returns {device, shop} or null - shop identity is
// derived exclusively from the token hash, never from request input.
async function findDeviceByTokenHash(q, tokenHash) {
  const r = await q.query(
    `SELECT d.id AS device_id, d.name AS device_name, d.shop_id, s.name AS shop_name, s.status AS shop_status
     FROM devices d JOIN shops s ON s.id = d.shop_id
     WHERE d.token_hash = $1 AND d.revoked_at IS NULL`,
    [tokenHash]
  );
  if (!r.rowCount) return null;
  const row = r.rows[0];
  await q.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [row.device_id]).catch(() => {});
  return {
    device: { id: row.device_id, name: row.device_name },
    shop: { id: row.shop_id, name: row.shop_name, status: row.shop_status }
  };
}


async function getConnection(q, shopId) {
  const r = await q.query('SELECT * FROM whatsapp_connections WHERE shop_id = $1', [shopId]);
  return r.rows[0] || null;
}

// Ownership pre-check for onboarding: which shop (if any) already claims a
// Meta phone number id. Minimal columns only.
async function findConnectionByPhoneNumberId(q, phoneNumberId) {
  const r = await q.query(
    'SELECT shop_id, status FROM whatsapp_connections WHERE phone_number_id = $1',
    [String(phoneNumberId || '')]
  );
  return r.rows[0] || null;
}

async function upsertConnection(q, shopId, fields) {
  const cols = [
    'provider', 'business_account_id', 'phone_number_id', 'display_phone_number',
    'business_name', 'access_token_ciphertext', 'access_token_iv', 'access_token_tag',
    'token_expires_at', 'status', 'connected_at', 'last_error'
  ];
  const values = cols.map((c) => fields[c] !== undefined ? fields[c] : null);
  await q.query(
    `INSERT INTO whatsapp_connections (id, shop_id, ${cols.join(', ')})
     VALUES ($1, $2, ${cols.map((_, i) => '$' + (i + 3)).join(', ')})
     ON CONFLICT (shop_id) DO UPDATE SET
       ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = now()`,
    [crypto.randomUUID(), shopId, ...values]
  );
}

async function markConnectionError(q, shopId, status, lastError) {
  await q.query(
    `UPDATE whatsapp_connections SET status = $2, last_error = $3, updated_at = now() WHERE shop_id = $1`,
    [shopId, status, String(lastError || '').slice(0, 300)]
  );
}

// Disconnect: tombstone the connection and clear token material. Messages,
// sales and history rows are left untouched.
async function markDisconnected(q, shopId) {
  await q.query(
    `UPDATE whatsapp_connections SET status = 'disconnected',
       access_token_ciphertext = '', access_token_iv = '', access_token_tag = '',
       token_expires_at = NULL, updated_at = now()
     WHERE shop_id = $1`,
    [shopId]
  );
}


async function createOnboardingSession(q, { shopId, tokenHash, expiresAt }) {
  const id = crypto.randomUUID();
  await q.query(
    'INSERT INTO onboarding_sessions (id, token_hash, shop_id, expires_at) VALUES ($1, $2, $3, $4)',
    [id, tokenHash, shopId, expiresAt]
  );
  return id;
}

async function getOnboardingSession(q, tokenHash) {
  const r = await q.query(
    `SELECT id, shop_id, expires_at, used_at FROM onboarding_sessions
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash]
  );
  return r.rows[0] || null;
}

// Atomically consume a session: one UPDATE that only succeeds for a live,
// unused row, so a concurrent submit loses the race outright.
async function consumeOnboardingSession(pool, tokenHash) {
  return withTx(pool, async (q) => {
    const r = await q.query(
      `UPDATE onboarding_sessions SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING id, shop_id`,
      [tokenHash]
    );
    return r.rows[0] || null;
  });
}

async function revokeDevice(q, deviceId) {
  await q.query('UPDATE devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [deviceId]);
}


async function getTemplate(q, shopId, name, language = 'en_US') {
  const r = await q.query(
    'SELECT * FROM whatsapp_templates WHERE shop_id = $1 AND name = $2 AND language = $3',
    [shopId, name, language]
  );
  return r.rows[0] || null;
}

async function upsertTemplate(q, { shopId, name, language = 'en_US', category = 'UTILITY', metaTemplateId = '', status = 'UNKNOWN', documentHeader = false, components = null }) {
  await q.query(
    `INSERT INTO whatsapp_templates (id, shop_id, name, language, category, meta_template_id, status, document_header, components)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (shop_id, name, language) DO UPDATE SET
       meta_template_id = EXCLUDED.meta_template_id,
       status = EXCLUDED.status,
       document_header = EXCLUDED.document_header,
       components = EXCLUDED.components,
       updated_at = now()`,
    [crypto.randomUUID(), shopId, name, language, category, metaTemplateId, status, documentHeader,
      components ? JSON.stringify(components) : null]
  );
  return getTemplate(q, shopId, name, language);
}


async function findMessageByIdempotency(q, shopId, key) {
  const r = await q.query(
    'SELECT id, status FROM whatsapp_messages WHERE shop_id = $1 AND idempotency_key = $2',
    [shopId, key]
  );
  return r.rows[0] || null;
}

async function createMessageWithQueue(pool, m) {
  return withTx(pool, async (q) => {
    const messageId = crypto.randomUUID();
    await q.query(
      `INSERT INTO whatsapp_messages
        (id, shop_id, invoice_id, customer_id, customer_phone, normalized_phone,
         message_type, template_name, status, payload, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)`,
      [messageId, m.shopId, m.invoiceId || '', m.customerId || '', m.customerPhone || '',
        m.normalizedPhone || '', m.messageType || 'invoice', m.templateName || '',
        m.payload ? JSON.stringify(m.payload) : null, m.idempotencyKey]
    );
    await q.query(
      `INSERT INTO whatsapp_queue (id, shop_id, message_id, status, next_retry_at)
       VALUES ($1, $2, $3, 'pending', now())`,
      [crypto.randomUUID(), m.shopId, messageId]
    );
    return messageId;
  });
}

async function getMessage(q, shopId, id) {
  const r = await q.query('SELECT * FROM whatsapp_messages WHERE shop_id = $1 AND id = $2', [shopId, id]);
  return r.rows[0] || null;
}

async function requeueMessage(pool, shopId, messageId) {
  return withTx(pool, async (q) => {
    const r = await q.query(
      `UPDATE whatsapp_messages SET status = 'pending', error_code = '', error_message = '',
         attempt_count = 0, updated_at = now()
       WHERE shop_id = $1 AND id = $2 AND status = 'failed' RETURNING id`,
      [shopId, messageId]
    );
    if (!r.rowCount) return false;
    await q.query(
      `UPDATE whatsapp_queue SET status = 'pending', attempt_count = 0, next_retry_at = now(),
         locked_at = NULL, updated_at = now() WHERE message_id = $1`,
      [messageId]
    );
    return true;
  });
}

// Status rows for the local POS to fold into its outbox. Ids are the
// gateway-side message ids which the POS stores as remote_id. The cursor is
// (updated_at, id) so rows sharing a timestamp are never skipped.
async function messageUpdatesSince(q, shopId, since, afterId) {
  const r = await q.query(
    `SELECT id, meta_message_id, status, error_code, error_message, attempt_count,
            sent_at, delivered_at, read_at, updated_at
     FROM whatsapp_messages
     WHERE shop_id = $1 AND (updated_at > $2::timestamptz OR (updated_at = $2::timestamptz AND id > $3))
     ORDER BY updated_at ASC, id ASC LIMIT 500`,
    [shopId, since, afterId || '']
  );
  return r.rows;
}

// Claim due jobs. FOR UPDATE SKIP LOCKED keeps concurrent workers honest;
// jobs are moved to 'processing' inside the same transaction.
async function claimDueJobs(pool, limit = 10) {
  return withTx(pool, async (q) => {
    const r = await q.query(
      `SELECT q.id AS queue_id, q.attempt_count AS queue_attempts, m.*
       FROM whatsapp_queue q
       JOIN whatsapp_messages m ON m.id = q.message_id
       WHERE (q.status = 'pending' AND (q.next_retry_at IS NULL OR q.next_retry_at <= now()))
          OR (q.status = 'processing' AND q.locked_at < now() - interval '5 minutes')
       ORDER BY q.next_retry_at ASC
       LIMIT $1
       FOR UPDATE OF q SKIP LOCKED`,
      [limit]
    );
    const rows = r.rows;
    for (const row of rows) {
      await q.query(
        `UPDATE whatsapp_queue SET status = 'processing', locked_at = now(), updated_at = now() WHERE id = $1`,
        [row.queue_id]
      );
    }
    return rows;
  });
}

// `attempts` is the authoritative send-attempt count (from the queue row).
async function finishJob(q, queueId, messageId, { metaMessageId, attempts }) {
  await q.query(
    `UPDATE whatsapp_queue SET status = 'done', attempt_count = $2, updated_at = now() WHERE id = $1`,
    [queueId, attempts]
  );
  await q.query(
    `UPDATE whatsapp_messages SET status = 'sent', sent_at = COALESCE(sent_at, now()),
       meta_message_id = $2, attempt_count = $3, last_attempt_at = now(), updated_at = now()
     WHERE id = $1`,
    [messageId, metaMessageId || null, attempts]
  );
}

async function failJob(q, queueId, messageId, { code, message, attempts }) {
  await q.query(
    `UPDATE whatsapp_queue SET status = 'failed', attempt_count = $2, updated_at = now() WHERE id = $1`,
    [queueId, attempts]
  );
  await q.query(
    `UPDATE whatsapp_messages SET status = 'failed', error_code = $2, error_message = $3,
       attempt_count = $4, last_attempt_at = now(), updated_at = now()
     WHERE id = $1`,
    [messageId, String(code || 'failed').slice(0, 60), String(message || '').slice(0, 300), attempts]
  );
}

async function retryJob(q, queueId, messageId, { attempts, nextRetryAt, code, message }) {
  await q.query(
    `UPDATE whatsapp_queue SET status = 'pending', attempt_count = $2, next_retry_at = $3,
       locked_at = NULL, updated_at = now() WHERE id = $1`,
    [queueId, attempts, nextRetryAt]
  );
  await q.query(
    `UPDATE whatsapp_messages SET error_code = $2, error_message = $3,
       attempt_count = $4, last_attempt_at = now(), updated_at = now()
     WHERE id = $1`,
    [messageId, String(code || 'retry').slice(0, 60), String(message || '').slice(0, 300), attempts]
  );
}

async function cancelPendingJobs(q, shopId) {
  await q.query(
    `UPDATE whatsapp_queue SET status = 'cancelled', updated_at = now()
     WHERE shop_id = $1 AND status IN ('pending', 'processing')`,
    [shopId]
  );
  await q.query(
    `UPDATE whatsapp_messages m SET status = 'failed', error_code = 'cancelled',
       error_message = 'WhatsApp was disconnected before this message was sent', updated_at = now()
     WHERE m.shop_id = $1 AND m.status = 'pending'`,
    [shopId]
  );
}

async function insertWebhookEvent(q, digest) {
  const r = await q.query(
    `INSERT INTO webhook_events (id, digest) VALUES ($1, $2) ON CONFLICT (digest) DO NOTHING RETURNING id`,
    [crypto.randomUUID(), digest]
  );
  return r.rowCount > 0;
}

async function markWebhookProcessed(q, digest) {
  await q.query('UPDATE webhook_events SET processed_at = now() WHERE digest = $1', [digest]);
}

// ---- support summary -----------------------------------------------------------

function maskPhoneNumber(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length < 6) return d ? '***' : '';
  return `+${d.slice(0, 4)}***${d.slice(-3)}`;
}

// Support diagnostics: per-shop health rows. Display numbers are masked here
// so raw numbers, ids and tokens can never reach the response.
async function supportDiagnostics(q) {
  const r = await q.query(
    `SELECT s.name AS shop_name,
            c.business_name, c.display_phone_number, c.status AS connection_status, c.last_error,
            t.status AS template_status,
            (SELECT COUNT(*) FROM whatsapp_messages m WHERE m.shop_id = s.id AND m.created_at >= CURRENT_DATE) AS messages_today,
            (SELECT COUNT(*) FROM whatsapp_messages m WHERE m.shop_id = s.id AND m.status = 'failed' AND m.created_at >= CURRENT_DATE) AS failed_today
     FROM shops s
     LEFT JOIN whatsapp_connections c ON c.shop_id = s.id
     LEFT JOIN whatsapp_templates t ON t.shop_id = s.id AND t.name = 'mart_pos_invoice' AND t.language = 'en_US'
     ORDER BY s.created_at DESC LIMIT 200`
  );
  return r.rows.map((row) => ({
    shop_name: row.shop_name,
    business_name: row.business_name || '',
    display_number: maskPhoneNumber(row.display_phone_number),
    connection_status: row.connection_status || 'disconnected',
    template_status: row.template_status || '',
    messages_today: Number(row.messages_today) || 0,
    failed_today: Number(row.failed_today) || 0,
    last_error: row.last_error || ''
  }));
}

async function supportSummary(q) {
  const one = async (sql, params = []) => {
    const r = await q.query(sql, params);
    return r.rowCount ? Number(r.rows[0].c) : 0;
  };
  return {
    connected_shops: await one(`SELECT COUNT(*) AS c FROM whatsapp_connections WHERE status = 'connected'`),
    messages_today: await one(`SELECT COUNT(*) AS c FROM whatsapp_messages WHERE created_at >= date_trunc('day', now())`),
    delivered_today: await one(`SELECT COUNT(*) AS c FROM whatsapp_messages WHERE delivered_at >= date_trunc('day', now())`),
    read_today: await one(`SELECT COUNT(*) AS c FROM whatsapp_messages WHERE read_at >= date_trunc('day', now())`),
    failed_today: await one(`SELECT COUNT(*) AS c FROM whatsapp_messages WHERE status = 'failed' AND updated_at >= date_trunc('day', now())`),
    connection_issues: await one(`SELECT COUNT(*) AS c FROM whatsapp_connections WHERE status = 'needs_reconnect' OR (status <> 'disconnected' AND last_error <> '')`)
  };
}

module.exports = {
  withTx,
  findOwnerByEmail, createAccount, createDevice, findDeviceByTokenHash, revokeDevice,
  getConnection, findConnectionByPhoneNumberId, upsertConnection, markConnectionError, markDisconnected,
  createOnboardingSession, getOnboardingSession, consumeOnboardingSession,
  getTemplate, upsertTemplate,
  findMessageByIdempotency, createMessageWithQueue, getMessage, requeueMessage,
  messageUpdatesSince, claimDueJobs, finishJob, failJob, retryJob, cancelPendingJobs,
  insertWebhookEvent, markWebhookProcessed,
  supportSummary, supportDiagnostics, maskPhoneNumber
};
