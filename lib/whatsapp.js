const twilio = require('twilio');
const { getSecret } = require('./secrets');

// Twilio credentials are entered in Settings and stored via lib/secrets
// (DPAPI-encrypted under Electron). Environment variables remain as a
// fallback for the legacy server-mode deployment.
function twilioCreds() {
  return {
    accountSid: getSecret('twilio_account_sid') || process.env.TWILIO_ACCOUNT_SID || '',
    authToken: getSecret('twilio_auth_token') || process.env.TWILIO_AUTH_TOKEN || '',
    from: getSecret('twilio_whatsapp_from') || process.env.TWILIO_WHATSAPP_FROM || ''
  };
}

// Normalizes to '+<digits>' (E.164). Accepts international format with or
// without the leading '+', 'whatsapp:' prefixes, and bare 10-digit Indian
// mobiles (6-9xxxxxxxxxx -> +91). Throws on anything else.
function normalizeWhatsAppNumber(raw) {
  let v = String(raw || '').trim().replace(/[\s\-().]/g, '');
  if (v.toLowerCase().startsWith('whatsapp:')) v = v.slice(9);
  if (v.startsWith('00')) v = '+' + v.slice(2);
  if (v.startsWith('+')) {
    if (!/^\+\d{8,15}$/.test(v)) {
      throw new Error('Invalid WhatsApp number. Use international format, e.g. +91XXXXXXXXXX');
    }
    return v;
  }
  if (/^[6-9]\d{9}$/.test(v)) return `+91${v}`;
  if (/^\d{8,15}$/.test(v)) return `+${v}`;
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
const MAX_MESSAGE_LEN = 1500; // stay comfortably inside Twilio's 1600 limit
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

// ---- attempt log -------------------------------------------------------

// Maps provider/network errors to plain-language messages for the UI. The
// raw error is still written to the server log for diagnostics.
function friendlyError(err) {
  const code = err && (err.code || err.status);
  const msg = String((err && err.message) || err || '');
  if (code === 20003 || code === 401 || /authenticate|unauthorized/i.test(msg)) {
    return 'WhatsApp credentials are invalid. Check your Twilio configuration.';
  }
  if (code === 21211 || code === 21217 || code === 21614 || /not a valid|invalid.*(phone|number)/i.test(msg)) {
    return 'The customer number is not a valid WhatsApp number.';
  }
  if (code === 63016 || /outside the allowed window|template/i.test(msg)) {
    return 'WhatsApp blocked this message: the customer has not messaged the business within 24 hours.';
  }
  if (code === 63007 || code === 21610 || /not.*whatsapp|channel/i.test(msg)) {
    return 'This number is not reachable on WhatsApp.';
  }
  if (code === 20429 || code === 429 || /too many|rate limit/i.test(msg)) {
    return 'Too many messages were sent - please retry in a minute.';
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|socket hang up|network|fetch failed/i.test(msg)) {
    return 'Internet connection is unavailable. The bill is saved - retry when you are back online.';
  }
  return msg || 'WhatsApp delivery failed. Please try again.';
}

// One row per send attempt in whatsapp_log. Never throws - logging must not
// break the send flow.
function recordAttempt(invoice, phone, result) {
  try {
    const { withTransaction, execToObject } = require('./database');
    const prior = invoice && invoice.id
      ? execToObject('SELECT COUNT(*) AS c FROM whatsapp_log WHERE invoice_id = ?', [invoice.id])
      : null;
    // Simulated sends are recorded as failed (nothing was delivered) so the
    // invoice list does not show a false "Sent" badge on unconfigured setups.
    const status = result.ok && result.provider !== 'simulated' ? 'sent' : 'failed';
    withTransaction((db) => {
      db.run(
        'INSERT INTO whatsapp_log (invoice_id, invoice_no, phone, status, provider, message_sid, error, retry_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          invoice && invoice.id ? invoice.id : null,
          (invoice && invoice.invoice_no) || '',
          String(phone || ''),
          status,
          result.provider || 'twilio',
          result.messageSid || '',
          result.ok && result.provider !== 'simulated'
            ? ''
            : String(result.friendly || result.error || result.note || 'WhatsApp not configured').slice(0, 500),
          prior ? prior.c : 0,
          new Date().toISOString()
        ]
      );
    });
  } catch (e) {
    console.error('Could not record WhatsApp attempt:', e.message);
  }
}

// invoice_id -> latest attempt {status, created_at, error} for list views.
function latestStatusMap() {
  try {
    const { execToObjects } = require('./database');
    const rows = execToObjects('SELECT invoice_id, status, error, created_at FROM whatsapp_log ORDER BY id DESC');
    const map = {};
    for (const r of rows) {
      if (r.invoice_id != null && map[r.invoice_id] === undefined) {
        map[r.invoice_id] = { status: r.status, error: r.error, at: r.created_at };
      }
    }
    return map;
  } catch (_) {
    return {};
  }
}

function attemptsFor(invoiceId) {
  try {
    const { execToObjects } = require('./database');
    return execToObjects(
      'SELECT phone, status, provider, message_sid, error, retry_count, created_at FROM whatsapp_log WHERE invoice_id = ? ORDER BY id DESC LIMIT 10',
      [invoiceId]
    );
  } catch (_) {
    return [];
  }
}

// Status shown on the Settings page. "configured" means the Twilio API
// credentials exist; it does not prove delivery - use sendTestMessage.
function whatsappStatus() {
  let number = '';
  try {
    number = require('./settings').getSetting('whatsapp_number', '');
  } catch (_) { /* db not ready yet */ }
  const creds = twilioCreds();
  const configured = !!(creds.accountSid && creds.authToken && creds.from);
  return {
    number,
    configured,
    provider: configured ? 'twilio' : 'none',
    sender_masked: creds.from ? maskNumber(creds.from) : '',
    fields: {
      account_sid: !!creds.accountSid,
      auth_token: !!creds.authToken,
      from: !!creds.from
    }
  };
}

async function sendWhatsAppMessage(phone, message, mediaUrl = null) {
  let to;
  try {
    to = normalizeWhatsAppNumber(phone);
  } catch (error) {
    return { ok: false, error: error.message, friendly: error.message, provider: 'twilio' };
  }

  const { accountSid, authToken, from } = twilioCreds();

  // Check if Twilio credentials are configured
  if (!accountSid || !authToken || !from) {
    console.log(`WhatsApp send simulated. To ${to}: ${message}`);
    return {
      ok: true,
      provider: 'simulated',
      note: 'Twilio credentials not configured'
    };
  }

  const fromNumber = from.startsWith('whatsapp:') ? from : `whatsapp:${from}`;

  try {
    const client = twilio(accountSid, authToken);

    const messageOptions = {
      from: fromNumber,
      to: `whatsapp:${to}`,
      body: message
    };

    if (mediaUrl) {
      messageOptions.mediaUrl = [mediaUrl];
    }

    const twilioMessage = await client.messages.create(messageOptions);

    return {
      ok: true,
      provider: 'twilio',
      messageSid: twilioMessage.sid
    };
  } catch (error) {
    console.error('Twilio WhatsApp error:', error);
    return {
      ok: false,
      error: error.message,
      friendly: friendlyError(error),
      provider: 'twilio'
    };
  }
}

// Sends the formatted bill for a saved invoice and records the attempt in
// whatsapp_log. This is the single entry point used by the sale flow and the
// retry endpoints, so status tracking is consistent everywhere.
async function sendBill(invoice, phone) {
  // Log the normalized number so history shows what was actually dialled.
  let normalized = phone;
  try { normalized = normalizeWhatsAppNumber(phone); } catch (_) { /* send reports the error */ }
  const billText = formatBillText(invoice, normalized);
  const result = await sendWhatsAppMessage(phone, billText);
  recordAttempt(invoice, normalized, result);
  if (result.ok) {
    console.log(`WhatsApp bill ${invoice.invoice_no} sent to ${maskNumber(phone)} (${result.provider})`);
  } else {
    console.error(`WhatsApp bill ${invoice.invoice_no} failed: ${result.error}`);
  }
  return result;
}

// Sends a clearly identifiable test message. Defaults to the shop's own
// configured WhatsApp number - never a customer number.
async function sendTestMessage(to) {
  const settings = safeSettings();
  const target = to || settings.whatsapp_number || '';
  if (!target) {
    return { ok: false, error: 'Set the shop WhatsApp number first', friendly: 'Set the shop WhatsApp number first', provider: 'twilio' };
  }
  const shop = settings.shop_name || 'Mart POS';
  const stamp = new Date().toLocaleString('en-IN');
  return sendWhatsAppMessage(
    target,
    `MartPOS test message from ${shop} (${stamp}). WhatsApp billing is configured correctly.`
  );
}

// Validates the saved Twilio credentials against the API without sending
// anything (fetches the account resource). Used by Settings -> Test
// connection; a test message is only sent when a target number is provided.
async function testConnection(testTo) {
  const { accountSid, authToken, from } = twilioCreds();
  if (!accountSid || !authToken || !from) {
    return { ok: false, error: 'Twilio credentials are not configured', friendly: 'Enter the Twilio credentials and sender number first.' };
  }
  try {
    const client = twilio(accountSid, authToken);
    await client.api.accounts(accountSid).fetch();
  } catch (error) {
    console.error('Twilio credential check failed:', error);
    return { ok: false, error: error.message, friendly: friendlyError(error) };
  }
  if (testTo) {
    const sent = await sendTestMessage(testTo);
    return sent.ok
      ? { ok: true, sent: true, provider: sent.provider }
      : { ok: false, sent: false, error: sent.error, friendly: sent.friendly || sent.error };
  }
  return { ok: true, sent: false };
}

module.exports = {
  formatBillText,
  sendWhatsAppMessage,
  sendBill,
  sendTestMessage,
  testConnection,
  normalizeWhatsAppNumber,
  whatsappStatus,
  latestStatusMap,
  attemptsFor,
  friendlyError,
  maskNumber
};
