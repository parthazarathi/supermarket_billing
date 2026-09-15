const store = require('./store');
const { MetaClient } = require('./meta');
const { decryptValue } = require('./cryptoUtil');
const { classifyMetaError, nextBackoffMs, MAX_ATTEMPTS } = require('./retry');
const { ensureInvoiceTemplate } = require('./templates');
const { generateInvoicePDF } = require('./invoicePdf');
const { friendlyMetaError, EXPIRED_CONNECTION } = require('./friendly');
const { connectionState } = require('./status');
const { redactText } = require('./redact');

function metaFactory(config) {
  return (opts = {}) => new MetaClient({
    baseUrl: config.meta.graphBaseUrl,
    version: config.meta.graphVersion,
    appId: config.meta.appId,
    appSecret: config.meta.appSecret,
    ...opts
  });
}

// Body parameters for mart_pos_invoice: customer, shop, invoice no, item
// count, subtotal, discount, total, payment method - stored figures only.
function bodyParameters(payload) {
  const invoice = (payload && payload.invoice) || {};
  const settings = (payload && payload.settings) || {};
  const inr = (n) => `INR ${(parseFloat(n) || 0).toFixed(2)}`;
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  return [
    { type: 'text', text: String(invoice.party_name || 'Customer') },
    { type: 'text', text: String(settings.shop_name || 'Mart POS') },
    { type: 'text', text: String(invoice.invoice_no || '') },
    { type: 'text', text: String(items.length) },
    { type: 'text', text: inr(invoice.subtotal) },
    { type: 'text', text: inr(invoice.discount) },
    { type: 'text', text: inr(invoice.total) },
    { type: 'text', text: String(invoice.payment_method || '') }
  ];
}

// document_header templates get the invoice PDF uploaded to /{phoneId}/media
// as a header document; others send the plain utility template.
async function templateComponents(deps, conn, template, message) {
  const body = { type: 'body', parameters: bodyParameters(message.payload) };
  if (!template.document_header) {
    return [body];
  }
  const invoice = (message.payload && message.payload.invoice) || {};
  const pdf = await generateInvoicePDF(invoice, (message.payload && message.payload.settings) || {});
  const filename = `Invoice-${invoice.invoice_no || message.id}.pdf`;
  const uploaded = await deps.meta.uploadMedia(conn.phone_number_id, pdf, filename);
  const mediaId = uploaded && uploaded.id;
  if (!mediaId) {
    const e = new Error('Media upload did not return an id');
    e.status = 0;
    throw e;
  }
  return [
    { type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename } }] },
    body
  ];
}

// Sending is only ever allowed against a Meta-approved template - a pending,
// rejected or errored template fails permanently instead of attempting a send
// Meta would reject (or worse, delivering an unreviewed message).
function approvedOnly(template) {
  if (!template || String(template.status).toUpperCase() !== 'APPROVED') {
    const e = new Error('template not approved');
    e.code = 'template_not_approved';
    throw e;
  }
  return template;
}

async function processJob(deps, row) {
  const { pool } = deps;
  const conn = await store.getConnection(pool, row.shop_id);
  if (!conn || conn.status !== 'connected' || !conn.access_token_ciphertext) {
    await store.failJob(pool, row.queue_id, row.id, {
      code: 'not_connected', message: 'WhatsApp is not connected', attempts: row.queue_attempts || 0
    });
    return;
  }

  const state = connectionState(conn);
  if (state.needs_reconnect) {
    await store.markConnectionError(pool, row.shop_id, 'needs_reconnect', state.friendly);
    await store.failJob(pool, row.queue_id, row.id, {
      code: 'needs_reconnect', message: state.friendly || EXPIRED_CONNECTION, attempts: row.queue_attempts || 0
    });
    return;
  }

  let token;
  try {
    token = decryptValue(
      { ciphertext: conn.access_token_ciphertext, iv: conn.access_token_iv, tag: conn.access_token_tag },
      deps.config.encryptionKey
    );
  } catch (_) {
    await store.markConnectionError(pool, row.shop_id, 'needs_reconnect', 'Stored credentials could not be read - reconnect WhatsApp');
    await store.failJob(pool, row.queue_id, row.id, {
      code: 'needs_reconnect', message: 'Reconnect WhatsApp in the POS settings', attempts: row.queue_attempts || 0
    });
    return;
  }

  try {
    const meta = deps.metaFor({ accessToken: token });
    const template = await ensureInvoiceTemplate(pool, meta, row.shop_id, conn.business_account_id);
    const components = await templateComponents({ ...deps, meta }, conn, approvedOnly(template), row);
    const res = await meta.sendTemplate(conn.phone_number_id, {
      to: row.normalized_phone,
      name: template.name,
      language: template.language || 'en_US',
      components
    });
    const metaMessageId = res && Array.isArray(res.messages) && res.messages[0] ? res.messages[0].id : null;
    await store.finishJob(pool, row.queue_id, row.id, {
      metaMessageId, attempts: (row.queue_attempts || 0) + 1
    });
  } catch (err) {
    const cls = classifyMetaError(err);
    // An auth failure means the stored token stopped working - flag the
    // connection so the POS prompts a reconnect instead of retrying forever.
    if (cls.metaCode === 190 || cls.status === 401 || cls.status === 403) {
      await store.markConnectionError(pool, row.shop_id, 'needs_reconnect', 'WhatsApp authorization expired - reconnect required');
    }
    const attempts = (row.queue_attempts || 0) + 1;
    const friendly = cls.code === 'template_not_approved'
      ? friendlyMetaError('template_not_approved')
      : friendlyMetaError(cls.code);
    if (cls.permanent || attempts >= MAX_ATTEMPTS) {
      await store.failJob(pool, row.queue_id, row.id, {
        code: cls.code || `http_${cls.status || 'err'}`, message: friendly, attempts
      });
      return;
    }
    await store.retryJob(pool, row.queue_id, row.id, {
      attempts,
      nextRetryAt: new Date(Date.now() + (nextBackoffMs(attempts) || 0)).toISOString(),
      code: cls.code || `http_${cls.status || 'err'}`,
      message: friendly
    });
  }
}

async function processDueJobs(deps, limit = 10) {
  const jobs = await store.claimDueJobs(deps.pool, limit);
  for (const job of jobs) {
    try {
      await processJob(deps, job);
    } catch (e) {
      // A processing bug must never kill the loop; release the row back to
      // pending so the next tick retries it.
      (deps.log || console).error('WhatsApp job processing error:', redactText(e.message || 'error'));
      try {
        await store.retryJob(deps.pool, job.queue_id, job.id, {
          attempts: Number(job.queue_attempts || 0),
          nextRetryAt: new Date(Date.now() + 60 * 1000).toISOString(),
          code: 'worker_error',
          message: 'Sending will be retried'
        });
      } catch (_) { /* nothing more we can do */ }
    }
  }
  return jobs.length;
}

function startWorker(deps, intervalMs = 5000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processDueJobs(deps);
    } catch (e) {
      (deps.log || console).error('WhatsApp queue tick failed:', redactText(e.message || 'error'));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}

module.exports = { processDueJobs, processJob, startWorker, metaFactory, templateComponents, approvedOnly };
