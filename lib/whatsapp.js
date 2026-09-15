const crypto = require('crypto');
const { setSecret, hasSecret } = require('./secrets');
const { getSetting, setSettings } = require('./settings');
const outbox = require('./whatsapp/outbox');
const { api: cloudApi, cloudBaseUrl, redactSecrets } = require('./whatsapp/gatewayClient');
const { WhatsAppService } = require('./whatsapp/service');
const { createGatewayProvider } = require('./whatsapp/localProvider');
const { startWhatsAppWorker, stopWhatsAppWorker, getCachedConnection, setCachedConnection, refreshWhatsAppStatus } = require('./whatsapp/worker');

const service = new WhatsAppService(createGatewayProvider());

// ---- number handling -----------------------------------------------------

// Normalizes to '+<digits>' (E.164-ish). Explicit international numbers
// (+... or 00...) with 8-15 digits pass through. Bare 10-digit numbers get
// the configured default country code - +91 keeps the Indian mobile shape
// (6-9xxxxxxxxx); other codes accept a 2-9 first digit. Other bare digit
// strings are ambiguous and rejected. Throws on invalid input.
function normalizeWhatsAppNumber(raw, options = {}) {
  let defaultCountryCode = options.defaultCountryCode;
  if (defaultCountryCode === undefined) {
    try {
      defaultCountryCode = getSetting('whatsapp_default_country_code', '+91') || '+91';
    } catch (_) {
      defaultCountryCode = '+91';
    }
  }
  let v = String(raw || '').trim().replace(/[\s\-().]/g, '');
  if (v.toLowerCase().startsWith('whatsapp:')) v = v.slice(9);
  if (v.startsWith('00')) v = '+' + v.slice(2);
  if (v.startsWith('+')) {
    if (!/^\+\d{8,15}$/.test(v)) {
      throw new Error('Invalid WhatsApp number. Use international format, e.g. +91XXXXXXXXXX');
    }
    return v;
  }
  const cc = String(defaultCountryCode || '').replace(/[^\d]/g, '') || '91';
  const bareOk = cc === '91' ? /^[6-9]\d{9}$/.test(v) : /^[2-9]\d{9}$/.test(v);
  if (bareOk) return `+${cc}${v}`;
  throw new Error('Invalid WhatsApp number. Use international format, e.g. +91XXXXXXXXXX');
}

// +14155238886 -> +1415***886 - for display only, never for sending.
function maskNumber(v) {
  const s = String(v || '').replace(/^whatsapp:/, '');
  if (s.length <= 8) return s ? s.slice(0, 2) + '***' : '';
  return `${s.slice(0, 5)}***${s.slice(-3)}`;
}

// ---- message formatting ------------------------------------------------

const MAX_ITEMS_LISTED = 15;
const MAX_MESSAGE_LEN = 1500; // stay comfortably inside WhatsApp body limits
const RULE = '———————————————';
const inr = (n) => `₹${(parseFloat(n) || 0).toFixed(2)}`;

function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || '');
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}

// Settings lookup that never throws - the bill text must render even if the
// database is momentarily unavailable.
function safeSettings() {
  try {
    return require('./settings').getSettings();
  } catch (_) {
    return {};
  }
}

// Compact bill body without the item table - used for very large invoices
// so the message never exceeds WhatsApp limits. The full bill stays saved
// locally and can be printed/shared from the POS.
function summarizeBill(invoice, settings, customerPhone) {
  const shopName = settings.shop_name || 'Mart POS';
  const lines = [
    `🧾 ${shopName}`,
    `Invoice: ${invoice.invoice_no}`,
    `Date: ${fmtWhen(invoice.created_at)}`
  ];
  if (invoice.party_name) lines.push(`Customer: ${invoice.party_name}`);
  if (customerPhone) lines.push(`Mobile: ${customerPhone}`);
  lines.push(
    RULE,
    `Items: ${(invoice.items || []).length}`,
    `TOTAL: ${inr(invoice.total)}`,
    `Payment: ${invoice.payment_method}`,
    `Paid: ${inr(invoice.paid)}`
  );
  if (invoice.total - invoice.paid > 0.009) {
    lines.push(`Balance due: ${inr(invoice.total - invoice.paid)}`);
  }
  lines.push(RULE, 'Thank you for shopping with us!');
  return lines.join('\n');
}

// Professional, mobile-friendly bill. WhatsApp renders a proportional font,
// so the item list uses "name xqty amount" lines rather than aligned columns.
// All amounts reuse the invoice's stored figures - no recalculation here.
function formatBillText(invoice, customerPhone) {
  const settings = safeSettings();
  const shopName = settings.shop_name || 'Mart POS';
  const items = invoice.items || [];
  const phone = customerPhone || invoice.party_phone || '';

  if (items.length > MAX_ITEMS_LISTED) {
    return summarizeBill(invoice, settings, phone);
  }

  const lines = [
    `🧾 ${shopName}`,
    `Invoice: ${invoice.invoice_no}`,
    `Date: ${fmtWhen(invoice.created_at)}`
  ];
  if (invoice.party_name) lines.push(`Customer: ${invoice.party_name}`);
  if (phone) lines.push(`Mobile: ${phone}`);
  lines.push(RULE, 'Item  Qty  Amount');

  for (const item of items) {
    const qty = parseFloat(item.quantity);
    lines.push(`${item.name}  ×${qty % 1 === 0 ? qty : qty.toFixed(2)}  ${inr(item.line_total)}`);
  }

  lines.push(RULE, `Subtotal  ${inr(invoice.subtotal)}`);
  if (parseFloat(invoice.discount) > 0) {
    lines.push(`Discount  −${inr(invoice.discount)}`);
  }
  if (parseFloat(invoice.tax) > 0) {
    lines.push(`GST  ${inr(invoice.tax)}`);
  }
  lines.push(`TOTAL  ${inr(invoice.total)}`, `Payment: ${invoice.payment_method}`, `Paid: ${inr(invoice.paid)}`);
  if (invoice.total - invoice.paid > 0.009) {
    lines.push(`Balance due: ${inr(invoice.total - invoice.paid)}`);
  }

  lines.push(RULE, 'Thank you for shopping with us!');
  // Shop footer: receipt_header already carries address/phone lines.
  const header = String(settings.receipt_header || '').trim();
  if (header) lines.push(header);
  const shopPhone = String(settings.whatsapp_number || '').trim();
  if (shopPhone) lines.push(`Phone: ${shopPhone}`);

  const message = lines.join('\n');
  // If an unusually long bill still overflows the limit, fall back to the
  // summarized version rather than risk a truncated send.
  return message.length > MAX_MESSAGE_LEN ? summarizeBill(invoice, settings, phone) : message;
}

// ---- errors --------------------------------------------------------------

// Maps provider/network errors to plain-language messages for the UI. The raw
// error is still written to the server log for diagnostics; anything that
// reaches an API response goes through redactSecrets first.
function friendlyError(err) {
  const code = err && (err.code || err.status);
  const msg = String((err && err.message) || err || '');
  if (code === 190 || code === 'device_auth' || code === 401 || code === 403 || /authenticate|unauthorized/i.test(msg)) {
    return 'WhatsApp authorization expired or is invalid. Reconnect WhatsApp in Settings.';
  }
  if (code === 'not_connected' || code === 'needs_reconnect' || code === 409) {
    return 'WhatsApp is not connected. Link it in Settings first.';
  }
  if (code === 'template_not_approved') {
    return 'The WhatsApp bill template is not available yet. Please contact support.';
  }
  if (code === 'not_configured') {
    return 'Cloud messaging is not configured on this machine.';
  }
  if (code === 21211 || code === 21217 || code === 21614 || code === 131026 || code === 131030 || /not a valid|invalid.*(phone|number)/i.test(msg)) {
    return 'The customer number is not a valid WhatsApp number.';
  }
  if (code === 63016 || code === 132001 || code === 132015 || code === 132016 || /outside the allowed window|template/i.test(msg)) {
    return 'WhatsApp blocked this message: the approved invoice template is unavailable or paused.';
  }
  if (code === 63007 || code === 21610 || code === 133010 || /not.*whatsapp|channel/i.test(msg)) {
    return 'This number is not reachable on WhatsApp.';
  }
  if (code === 20429 || code === 429 || code === 130429 || /too many|rate limit/i.test(msg)) {
    return 'Too many messages were sent - please retry in a minute.';
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|socket hang up|network|fetch failed/i.test(msg)) {
    return 'Internet connection is unavailable. The bill is saved - retry when you are back online.';
  }
  return redactSecrets(msg) || 'WhatsApp delivery failed. Please try again.';
}

function cloudStatus() {
  return {
    linked: hasSecret('cloud_device_token'),
    cloud_url_set: !!cloudBaseUrl(),
    shop_name: getSetting('cloud_shop_name', '')
  };
}

// Registration/login go to the gateway without a token; the returned device
// token is written straight into the encrypted secrets store and is never
// included in any local API response.
async function registerCloudOwner({ email, password, shopName, deviceName }) {
  const res = await cloudApi('/v1/auth/register', {
    method: 'POST',
    body: { email, password, shopName, deviceName }
  });
  if (res && res.ok && res.deviceToken) {
    setSecret('cloud_device_token', res.deviceToken);
    setSettings({ cloud_shop_name: (res.shop && res.shop.name) || String(shopName || '') });
  }
  return { ok: true, cloud: cloudStatus() };
}

async function loginCloudOwner({ email, password, deviceName }) {
  const res = await cloudApi('/v1/auth/login', {
    method: 'POST',
    body: { email, password, deviceName }
  });
  if (res && res.ok && res.deviceToken) {
    setSecret('cloud_device_token', res.deviceToken);
    setSettings({ cloud_shop_name: (res.shop && res.shop.name) || '' });
  }
  return { ok: true, cloud: cloudStatus() };
}

// Unlinks this device. The gateway is asked to revoke the device token
// best-effort first; local removal always proceeds even while offline. The
// cloud account and other devices are untouched; queued sends are cancelled.
async function logoutCloudOwner() {
  try {
    if (hasSecret('cloud_device_token')) {
      await cloudApi('/v1/devices/current', { method: 'DELETE' });
    }
  } catch (_) {
    // Revoke is best-effort - local unlink proceeds while offline.
  }
  setSecret('cloud_device_token', '');
  setSettings({ cloud_shop_name: '', whatsapp_updates_since: '', whatsapp_updates_after_id: '' });
  setCachedConnection(null);
  outbox.cancelPending();
  return { ok: true, cloud: cloudStatus() };
}

async function connectWhatsApp() {
  const res = await service.connect({});
  return {
    ok: true,
    url: res && res.onboardingUrl ? res.onboardingUrl : '',
    expires_at: res && res.expiresAt ? res.expiresAt : null
  };
}

async function disconnectWhatsApp() {
  try {
    if (hasSecret('cloud_device_token')) {
      await service.disconnect({});
    }
  } catch (e) {
    console.error('Gateway disconnect call failed:', e.message);
  }
  setCachedConnection({ status: 'disconnected' });
  outbox.cancelPending();
  return { ok: true };
}

// Status for Settings and /api/me. Never includes the device token, WABA id,
// phone-number id, Graph URLs or raw provider errors.
function whatsappStatus() {
  let number = '';
  try {
    number = getSetting('whatsapp_number', '');
  } catch (_) { /* db not ready yet */ }
  const linked = hasSecret('cloud_device_token');
  const remote = getCachedConnection() || {};
  const remoteStatus = linked ? (remote.status || 'unknown') : 'disconnected';
  return {
    provider: 'meta',
    number,
    configured: remoteStatus === 'connected',
    linked,
    cloud_url_set: !!cloudBaseUrl(),
    shop_name: getSetting('cloud_shop_name', ''),
    connection: {
      status: remoteStatus,
      connected: remoteStatus === 'connected',
      needs_reconnect: remoteStatus === 'needs_reconnect',
      phone_masked: remote.display_phone_number ? maskNumber(remote.display_phone_number) : '',
      business_name: remote.business_name || '',
      connected_at: remote.connected_at || null,
      last_error: remote.last_error ? redactSecrets(remote.last_error) : '',
      template: remote.template || null
    },
    queue: { pending: outbox.pendingCount() }
  };
}

function enqueueSend({ invoice, phone, messageType = 'invoice', idempotencyKey }) {
  let normalized;
  try {
    normalized = normalizeWhatsAppNumber(phone);
  } catch (e) {
    return { ok: false, provider: 'meta', error: e.message, friendly: e.message };
  }
  if (!hasSecret('cloud_device_token')) {
    return {
      ok: false, provider: 'meta', code: 'not_linked',
      friendly: 'WhatsApp is not linked. Connect the shop in Settings first.'
    };
  }
  try {
    const result = outbox.enqueue({
      invoiceId: invoice && invoice.id != null ? invoice.id : null,
      customerId: invoice && invoice.party_id != null ? invoice.party_id : null,
      customerPhone: phone,
      normalizedPhone: normalized,
      messageType,
      templateName: 'mart_pos_invoice',
      idempotencyKey: idempotencyKey || `invoice:${invoice && invoice.id}:${normalized}`
    });
    return {
      ok: true, queued: true, provider: 'meta', status: 'pending',
      messageId: result.messageId, duplicate: !!result.duplicate
    };
  } catch (e) {
    console.error('WhatsApp enqueue failed:', e.message);
    return {
      ok: false, provider: 'meta',
      friendly: 'The bill was saved, but WhatsApp could not be queued.'
    };
  }
}

function sendBill(invoice, phone) {
  return enqueueSend({ invoice, phone, messageType: 'invoice' });
}

// In-flight states return as duplicates - a resend must never double-send.
const IN_FLIGHT = new Set(['pending', 'queued', 'processing', 'sent']);

function retryBill(invoice, phone) {
  const latest = outbox.latestForInvoice(invoice && invoice.id);
  let normalized;
  try {
    normalized = normalizeWhatsAppNumber(phone || (latest && latest.normalized_phone) || '');
  } catch (e) {
    return { ok: false, provider: 'meta', error: e.message, friendly: e.message };
  }
  if (latest && IN_FLIGHT.has(latest.status)) {
    return { ok: true, queued: true, provider: 'meta', status: 'pending', messageId: latest.id, duplicate: true };
  }
  if (latest && (latest.status === 'failed' || latest.status === 'cancelled')) {
    if (!hasSecret('cloud_device_token')) {
      return { ok: false, provider: 'meta', code: 'not_linked', friendly: 'WhatsApp is not linked. Connect the shop in Settings first.' };
    }
    if (outbox.requeueMessage(latest.id, normalized)) {
      return { ok: true, queued: true, provider: 'meta', status: 'pending', messageId: latest.id };
    }
  }
  return enqueueSend({
    invoice, phone: normalized, messageType: 'invoice',
    idempotencyKey: `resend:${invoice && invoice.id}:${crypto.randomUUID()}`
  });
}

// Queues a test invoice-template message to the shop's own number (or an
// explicit admin-chosen recipient) - never free-form text.
function sendTestMessage(to) {
  const settings = safeSettings();
  const target = to || settings.whatsapp_number || '';
  if (!target) {
    return {
      ok: false, provider: 'meta',
      error: 'Set the shop WhatsApp number first',
      friendly: 'Set the shop WhatsApp number first'
    };
  }
  return enqueueSend({
    invoice: null, phone: target, messageType: 'test',
    idempotencyKey: `test:${crypto.randomUUID()}`
  });
}

module.exports = {
  formatBillText, normalizeWhatsAppNumber, maskNumber, friendlyError,
  whatsappStatus, registerCloudOwner, loginCloudOwner, logoutCloudOwner,
  connectWhatsApp, disconnectWhatsApp, sendBill, sendTestMessage,
  retryBill, latestStatusMap: outbox.latestStatusMap, attemptsFor: outbox.attemptsFor,
  startWhatsAppWorker, stopWhatsAppWorker, refreshWhatsAppStatus
};
