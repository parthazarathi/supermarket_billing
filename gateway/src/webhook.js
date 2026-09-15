const crypto = require('crypto');
const { sha256Hex } = require('./cryptoUtil');
const { applyStatus, RANK } = require('./status');
const { friendlyMetaError } = require('./friendly');

// X-Hub-Signature-256 is "sha256=<hmac-sha256 of the raw body>". Compared in
// constant time; a malformed header is simply invalid.
function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!rawBody || !signatureHeader || !appSecret) return false;
  const sig = String(signatureHeader);
  if (!sig.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', String(appSecret))
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function digestBody(rawBody) {
  return sha256Hex(rawBody);
}

function validatePayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'not an object' };
  if (body.object !== 'whatsapp_business_account') return { ok: false, reason: 'unexpected object' };
  if (!Array.isArray(body.entry)) return { ok: false, reason: 'entry missing' };
  for (const entry of body.entry) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) {
      return { ok: false, reason: 'entry.id missing' };
    }
    if (!Array.isArray(entry.changes)) return { ok: false, reason: 'changes missing' };
    for (const change of entry.changes) {
      if (!change || typeof change !== 'object' || !change.value || typeof change.value !== 'object') {
        return { ok: false, reason: 'change.value missing' };
      }
    }
  }
  return { ok: true };
}

function extractStatusUpdates(body) {
  const updates = [];
  for (const entry of body.entry || []) {
    const wabaId = String(entry.id || '');
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = String((value.metadata || {}).phone_number_id || '');
      for (const st of value.statuses || []) {
        const firstErr = Array.isArray(st.errors) && st.errors.length ? st.errors[0] : null;
        updates.push({
          wabaId,
          phoneNumberId,
          metaMessageId: String(st.id || ''),
          status: String(st.status || ''),
          ts: st.timestamp ? new Date(Number(st.timestamp) * 1000).toISOString() : null,
          errorCode: firstErr ? String(firstErr.code || '') : '',
          errorTitle: firstErr ? String(firstErr.title || '') : ''
        });
      }
    }
  }
  return updates.filter((u) => u.metaMessageId && u.status);
}

// Maps a webhook error code to the fixed friendly strings persisted on the
// message row - raw Meta titles are never stored.
function friendlyWebhookError(code) {
  return friendlyMetaError(code);
}

// Applies updates monotonically. Messages are matched on meta_message_id AND
// the shop resolved from (waba, phone number) so a webhook can never move
// another tenant's rows.
async function applyStatusUpdates(q, updates) {
  let applied = 0;
  for (const u of updates) {
    const conn = await q.query(
      'SELECT shop_id FROM whatsapp_connections WHERE business_account_id = $1 AND phone_number_id = $2',
      [u.wabaId, u.phoneNumberId]
    );
    if (!conn.rowCount) continue;
    const shopId = conn.rows[0].shop_id;

    const found = await q.query(
      'SELECT id, status FROM whatsapp_messages WHERE shop_id = $1 AND meta_message_id = $2',
      [shopId, u.metaMessageId]
    );
    if (!found.rowCount) continue;
    const msg = found.rows[0];
    const next = applyStatus(msg.status, u.status);
    if (next === msg.status && u.status !== 'failed') continue;

    const now = new Date().toISOString();
    const ts = u.ts || now;
    if (next === 'failed') {
      await q.query(
        `UPDATE whatsapp_messages SET status = 'failed', error_code = $2,
         error_message = $3, updated_at = now() WHERE id = $1`,
        [msg.id, u.errorCode || 'meta_failed', friendlyWebhookError(u.errorCode)]
      );
    } else {
      // Backfill the whole progression monotonically: a delivered/read event
      // that overtook its predecessors still fills the earlier columns, and
      // COALESCE keeps the first timestamp ever recorded.
      const cols = [];
      if (RANK[next] >= RANK.sent) cols.push(`sent_at = COALESCE(sent_at, $3::timestamptz)`);
      if (RANK[next] >= RANK.delivered) cols.push(`delivered_at = COALESCE(delivered_at, $3::timestamptz)`);
      if (RANK[next] >= RANK.read) cols.push(`read_at = COALESCE(read_at, $3::timestamptz)`);
      await q.query(
        `UPDATE whatsapp_messages SET status = $2, ${cols.join(', ')}, updated_at = now()
         WHERE id = $1`,
        [msg.id, next, ts]
      );
    }
    applied += 1;
  }
  return applied;
}

module.exports = { verifySignature, digestBody, validatePayload, extractStatusUpdates, applyStatusUpdates, friendlyWebhookError };
