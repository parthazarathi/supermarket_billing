const crypto = require('crypto');
const { getDatabase, withTransaction, execToObject, execToObjects, scheduleSave } = require('../database');
const { redactSecrets } = require('./gatewayClient');

// Retried indefinitely with capped backoff - an outage must never strand a
// queued bill.
function localBackoffMs(attempt) {
  const base = 30 * 1000;
  const cap = 30 * 60 * 1000;
  return Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
}

function now() {
  return new Date().toISOString();
}

function enqueue({ invoiceId = null, customerId = null, customerPhone = '', normalizedPhone = '', messageType = 'invoice', templateName = 'mart_pos_invoice', idempotencyKey }) {
  const db = getDatabase();
  const key = idempotencyKey || `msg:${crypto.randomUUID()}`;
  const ts = now();
  return withTransaction(() => {
    const existing = execToObject(
      'SELECT message_id, status FROM whatsapp_queue WHERE idempotency_key = ?',
      [key]
    );
    if (existing) {
      return { ok: true, queued: true, messageId: existing.message_id, duplicate: true };
    }
    db.run(
      `INSERT INTO whatsapp_messages
        (invoice_id, customer_id, customer_phone, normalized_phone, message_type,
         template_name, status, attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      [invoiceId, customerId, String(customerPhone || ''), String(normalizedPhone || ''),
        messageType, templateName || '', ts, ts]
    );
    const row = execToObject('SELECT last_insert_rowid() AS id');
    const messageId = row.id;
    db.run(
      `INSERT INTO whatsapp_queue
        (invoice_id, message_id, idempotency_key, status, attempt_count, next_retry_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
      [invoiceId, messageId, key, ts, ts, ts]
    );
    return { ok: true, queued: true, messageId, idempotencyKey: key };
  });
}

function dueJobs(limit = 10) {
  return execToObjects(
    `SELECT q.id AS queue_id, q.attempt_count AS queue_attempts, q.idempotency_key, m.*
     FROM whatsapp_queue q
     JOIN whatsapp_messages m ON m.id = q.message_id
     WHERE q.status = 'pending' AND (q.next_retry_at IS NULL OR q.next_retry_at <= ?)
     ORDER BY q.next_retry_at ASC, q.id ASC
     LIMIT ?`,
    [now(), limit]
  );
}

// Only a remote status update may advance a message to sent/delivered/read.
function markForwarded(queueId, messageId, remoteId) {
  const ts = now();
  withTransaction((db) => {
    db.run(`UPDATE whatsapp_queue SET status = 'forwarded', locked_at = NULL, updated_at = ? WHERE id = ?`, [ts, queueId]);
    db.run(
      `UPDATE whatsapp_messages SET remote_id = ?, status = 'pending',
         attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ?
       WHERE id = ?`,
      [String(remoteId || ''), ts, ts, messageId]
    );
  });
}

function markRemoteRequeued(queueId, messageId) {
  const ts = now();
  withTransaction((db) => {
    db.run(`UPDATE whatsapp_queue SET status = 'forwarded', locked_at = NULL, updated_at = ? WHERE id = ?`, [ts, queueId]);
    db.run(
      `UPDATE whatsapp_messages SET status = 'pending',
         attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ?
       WHERE id = ?`,
      [ts, ts, messageId]
    );
  });
}

function markRetry(queueId, messageId, { code = '', message = '' } = {}) {
  const row = execToObject('SELECT attempt_count FROM whatsapp_queue WHERE id = ?', [queueId]);
  const attempt = (row ? row.attempt_count : 0) + 1;
  const ts = now();
  const nextAt = new Date(Date.now() + localBackoffMs(attempt)).toISOString();
  withTransaction((db) => {
    db.run(
      `UPDATE whatsapp_queue SET status = 'pending', attempt_count = ?, next_retry_at = ?, locked_at = NULL, updated_at = ? WHERE id = ?`,
      [attempt, nextAt, ts, queueId]
    );
    db.run(
      `UPDATE whatsapp_messages SET status = 'pending', error_code = ?, error_message = ?,
         attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ? WHERE id = ?`,
      [String(code).slice(0, 60), String(message || '').slice(0, 300), ts, ts, messageId]
    );
  });
}

function markFailed(queueId, messageId, { code = '', message = '' } = {}) {
  const ts = now();
  withTransaction((db) => {
    db.run(`UPDATE whatsapp_queue SET status = 'failed', locked_at = NULL, updated_at = ? WHERE id = ?`, [ts, queueId]);
    db.run(
      `UPDATE whatsapp_messages SET status = 'failed', error_code = ?, error_message = ?,
         attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ? WHERE id = ?`,
      [String(code).slice(0, 60), String(message || '').slice(0, 300), ts, ts, messageId]
    );
  });
}

function requeueMessage(messageId, normalizedPhone) {
  const ts = now();
  return withTransaction((db) => {
    const r = execToObject(
      `UPDATE whatsapp_messages SET status = 'pending', error_code = '', error_message = '', updated_at = ?
       WHERE id = ? AND status = 'failed' RETURNING id`,
      [ts, messageId]
    );
    if (!r) return false;
    if (normalizedPhone) {
      db.run('UPDATE whatsapp_messages SET normalized_phone = ?, customer_phone = ?, updated_at = ? WHERE id = ?',
        [normalizedPhone, normalizedPhone, ts, messageId]);
    }
    db.run(
      `UPDATE whatsapp_queue SET status = 'pending', next_retry_at = ?, locked_at = NULL, updated_at = ? WHERE message_id = ?`,
      [ts, ts, messageId]
    );
    return true;
  });
}

// Schema-v3 rows win; whatsapp_log only fills invoices that predate it.
// Shapes are deliberately UI-safe: no remote/provider ids.
function latestStatusMap() {
  const map = {};
  try {
    const rows = execToObjects(
      'SELECT id, invoice_id, status, error_message, normalized_phone, attempt_count, created_at FROM whatsapp_messages ORDER BY id DESC'
    );
    for (const r of rows) {
      if (r.invoice_id != null && map[r.invoice_id] === undefined) {
        map[r.invoice_id] = {
          status: r.status, error: r.error_message, at: r.created_at,
          phone: r.normalized_phone || '', attempt_count: r.attempt_count || 0, message_id: r.id
        };
      }
    }
    const legacy = execToObjects(
      'SELECT invoice_id, status, error, phone, retry_count, created_at FROM whatsapp_log ORDER BY id DESC'
    );
    for (const r of legacy) {
      if (r.invoice_id != null && map[r.invoice_id] === undefined) {
        map[r.invoice_id] = {
          status: r.status, error: r.error, at: r.created_at,
          phone: r.phone || '', attempt_count: r.retry_count || 0, message_id: null
        };
      }
    }
  } catch (_) {
    return map;
  }
  return map;
}

function attemptsFor(invoiceId) {
  try {
    const rows = execToObjects(
      `SELECT id, normalized_phone AS phone, status,
              error_message AS error, attempt_count AS retry_count, created_at
       FROM whatsapp_messages WHERE invoice_id = ? ORDER BY id DESC LIMIT 10`,
      [invoiceId]
    );
    const legacy = execToObjects(
      `SELECT phone, status, error, retry_count, created_at
       FROM whatsapp_log WHERE invoice_id = ? ORDER BY id DESC LIMIT 10`,
      [invoiceId]
    );
    return rows.concat(legacy)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 10);
  } catch (_) {
    return [];
  }
}

function latestForInvoice(invoiceId) {
  return execToObject(
    'SELECT * FROM whatsapp_messages WHERE invoice_id = ? ORDER BY id DESC LIMIT 1',
    [invoiceId]
  );
}

const RANK = { pending: 0, sent: 1, delivered: 2, read: 3 };

function applyRemoteUpdate(u) {
  const msg = execToObject('SELECT * FROM whatsapp_messages WHERE remote_id = ?', [String(u.id)]);
  if (!msg) return false;
  const incoming = String(u.status || '');
  const cur = RANK[msg.status] !== undefined ? RANK[msg.status] : 0;
  let next;
  if (incoming === 'failed') {
    next = cur <= RANK.sent ? 'failed' : msg.status;
  } else {
    const rank = RANK[incoming];
    next = rank !== undefined && rank > cur ? incoming : msg.status;
  }
  const ts = now();
  const sets = ['status = ?', 'updated_at = ?'];
  const params = [next, ts];
  if (u.meta_message_id) { sets.push('provider_message_id = ?'); params.push(String(u.meta_message_id)); }
  // Timestamps come from the remote row; COALESCE keeps the earliest so a
  // late/arriving duplicate can never move them backwards.
  for (const [st, col] of [['sent', 'sent_at'], ['delivered', 'delivered_at'], ['read', 'read_at']]) {
    const remoteVal = u[col] || (RANK[next] >= RANK[st] ? (u.updated_at || ts) : null);
    if (RANK[next] >= RANK[st] && remoteVal) { sets.push(`${col} = COALESCE(${col}, ?)`); params.push(String(remoteVal)); }
  }
  if (next !== 'failed') { sets.push(`error_code = ''`, `error_message = ''`); }
  if (next === 'failed') {
    sets.push('error_code = ?', 'error_message = ?');
    params.push(String(u.error_code || 'remote_failed').slice(0, 60),
      redactSecrets(u.error_message || '').slice(0, 300));
  }
  params.push(msg.id);
  getDatabase().run(`UPDATE whatsapp_messages SET ${sets.join(', ')} WHERE id = ?`, params);
  scheduleSave();
  return true;
}

function pendingCount() {
  try {
    const r = execToObject(`SELECT COUNT(*) AS c FROM whatsapp_queue WHERE status = 'pending'`);
    return r ? r.c : 0;
  } catch (_) {
    return 0;
  }
}

function cancelPending() {
  const ts = now();
  try {
    withTransaction((db) => {
      db.run(`UPDATE whatsapp_queue SET status = 'cancelled', updated_at = ? WHERE status = 'pending'`, [ts]);
      db.run(
        `UPDATE whatsapp_messages SET status = 'failed', error_code = 'cancelled',
           error_message = 'WhatsApp was disconnected before this message was sent', updated_at = ?
         WHERE status = 'pending'`,
        [ts]
      );
    });
  } catch (_) { /* disconnect stays safe */ }
}

module.exports = {
  enqueue, dueJobs, markForwarded, markRemoteRequeued, markRetry, markFailed, requeueMessage,
  latestStatusMap, attemptsFor, latestForInvoice, applyRemoteUpdate,
  pendingCount, cancelPending, localBackoffMs
};
