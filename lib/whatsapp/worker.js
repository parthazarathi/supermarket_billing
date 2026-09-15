// Gateway/Meta failures stay inside this worker - they never propagate into
// sale completion.
const outbox = require('./outbox');
const client = require('./gatewayClient');
const { WhatsAppService } = require('./service');
const { createGatewayProvider } = require('./localProvider');
const { getSetting, setSettings, getSettings } = require('../settings');

const TICK_MS = 10 * 1000;
const MAX_UPDATE_PAGES = 10;
const EPOCH = '1970-01-01T00:00:00.000Z';

let timer = null;
let running = false;
let cachedConnection = null;
let lastStatusRefresh = 0;

let service = new WhatsAppService(createGatewayProvider());

function settingsSnapshot() {
  try {
    const s = getSettings();
    return {
      shop_name: s.shop_name || 'Mart POS',
      gstin: s.gstin || '',
      receipt_header: s.receipt_header || '',
      whatsapp_number: s.whatsapp_number || ''
    };
  } catch (_) {
    return { shop_name: 'Mart POS' };
  }
}

function invoiceSnapshot(message) {
  if (message.message_type === 'test') {
    return {
      invoice_no: `TEST-${Date.now()}`,
      party_name: 'WhatsApp test',
      created_at: new Date().toISOString(),
      subtotal: 0, discount: 0, tax: 0, total: 0, paid: 0,
      payment_method: 'Test',
      items: [{ name: 'Test message', quantity: 1, price: 0, gst_percent: 0, line_total: 0 }]
    };
  }
  try {
    const { getInvoice } = require('../invoices');
    return getInvoice(message.invoice_id) || null;
  } catch (_) {
    return null;
  }
}

// shop_id is deliberately absent: the gateway derives tenancy from the
// device token.
function jobPayload(message) {
  const invoice = invoiceSnapshot(message);
  if (!invoice) return null;
  return {
    idempotency_key: message.idempotency_key,
    invoice_id: message.invoice_id != null ? String(message.invoice_id) : '',
    customer_id: message.customer_id != null ? String(message.customer_id) : '',
    customer_phone: message.customer_phone || '',
    normalized_phone: message.normalized_phone || '',
    message_type: message.message_type || 'invoice',
    template_name: message.template_name || 'mart_pos_invoice',
    payload: { invoice, settings: settingsSnapshot() }
  };
}

function classifyFailure(e) {
  const status = Number(e && e.status) || 0;
  const code = (e && e.code) || '';
  if (status === 401 || status === 403) return { permanent: true, code: 'device_auth', message: 'This device is no longer linked to the cloud account' };
  if (status === 409 || code === 'not_connected') return { permanent: true, code: 'not_connected', message: 'WhatsApp is not connected - link it in Settings' };
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return { permanent: true, code: code || `http_${status}`, message: e.message };
  return { permanent: false, code: code || 'network', message: e.message };
}

async function forwardDueJobs() {
  const jobs = outbox.dueJobs(10);
  for (const job of jobs) {
    // A row with remote_id is retried remotely - posting again would be a
    // duplicate send.
    if (job.remote_id) {
      try {
        await service.retryMessage({}, job.remote_id);
        outbox.markRemoteRequeued(job.queue_id, job.id);
      } catch (e) {
        const cls = classifyFailure(e);
        if (cls.permanent) {
          outbox.markFailed(job.queue_id, job.id, cls);
        } else {
          outbox.markRetry(job.queue_id, job.id, cls);
        }
      }
      continue;
    }
    const payload = jobPayload(job);
    if (!payload) {
      outbox.markFailed(job.queue_id, job.id, { code: 'no_invoice', message: 'The invoice no longer exists' });
      continue;
    }
    try {
      const res = await service.sendInvoice({}, payload);
      const remoteId = res && res.message && res.message.id;
      outbox.markForwarded(job.queue_id, job.id, remoteId);
    } catch (e) {
      const cls = classifyFailure(e);
      if (cls.permanent) {
        outbox.markFailed(job.queue_id, job.id, cls);
      } else {
        outbox.markRetry(job.queue_id, job.id, cls);
      }
    }
  }
}

// The (updated_at, id) cursor only advances to the gateway's `next` after the
// full batch is applied - no server-now watermark can skip rows.
async function pollUpdates() {
  for (let page = 0; page < MAX_UPDATE_PAGES; page += 1) {
    const since = getSetting('whatsapp_updates_since', '') || EPOCH;
    const afterId = getSetting('whatsapp_updates_after_id', '');
    const res = await client.api(
      `/v1/whatsapp/messages/updates?since=${encodeURIComponent(since)}&after_id=${encodeURIComponent(afterId)}`
    );
    if (!res || !res.ok || !Array.isArray(res.updates)) return;
    if (!res.updates.length) return;
    for (const u of res.updates) {
      try { outbox.applyRemoteUpdate(u); } catch (_) { /* keep polling */ }
    }
    if (res.next && res.next.updated_at && res.next.id) {
      setSettings({
        whatsapp_updates_since: String(res.next.updated_at),
        whatsapp_updates_after_id: String(res.next.id)
      });
    }
    if (!res.has_more) return;
  }
}

let statusRefreshPromise = null;

async function refreshStatus() {
  const res = await client.api('/v1/whatsapp/status');
  cachedConnection = res && res.connection ? res.connection : null;
  lastStatusRefresh = Date.now();
}

// Force a status fetch now (Settings polling after onboarding completes).
// Concurrent callers share the single in-flight request.
async function refreshWhatsAppStatus() {
  if (!client.cloudLinked()) return cachedConnection;
  if (!statusRefreshPromise) {
    statusRefreshPromise = refreshStatus()
      .then(() => cachedConnection)
      .finally(() => { statusRefreshPromise = null; });
  }
  return statusRefreshPromise;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    if (!client.cloudLinked()) return;
    await forwardDueJobs();
    await pollUpdates();
    const nowMs = Date.now();
    if (nowMs - lastStatusRefresh > 60 * 1000 || cachedConnection === null) {
      lastStatusRefresh = nowMs;
      await refreshStatus();
    }
  } catch (e) {
    if (!(e && e.code === 'network')) {
      console.error('WhatsApp worker error:', e && e.message);
    }
  } finally {
    running = false;
  }
}

function startWhatsAppWorker() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  tick();
}

function stopWhatsAppWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function getCachedConnection() {
  return cachedConnection;
}

function setCachedConnection(value) {
  cachedConnection = value || null;
}

module.exports = {
  startWhatsAppWorker, stopWhatsAppWorker, getCachedConnection, setCachedConnection,
  refreshWhatsAppStatus,
  tick, forwardDueJobs, pollUpdates,
  _setServiceForTests(s) { service = s; }
};
