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

function formatBillText(invoice) {
  const settings = require('./settings').getSettings();
  const shopName = settings.shop_name || 'Mart POS';

  let lines = [
    shopName,
    `Invoice: ${invoice.invoice_no}`,
    `Date: ${invoice.created_at}`,
    ''
  ];

  if (invoice.party_name) {
    lines.push(`Customer: ${invoice.party_name}`, '');
  }

  lines.push('Items:');

  const items = invoice.items || [];
  for (const item of items) {
    const line = `- ${item.name} x ${item.quantity} @ ${parseFloat(item.price).toFixed(2)} = ${parseFloat(item.line_total).toFixed(2)}`;
    lines.push(line);
  }

  lines.push(
    '',
    `Subtotal: ${parseFloat(invoice.subtotal).toFixed(2)}`,
    `Discount: ${parseFloat(invoice.discount || 0).toFixed(2)}`,
    `GST: ${parseFloat(invoice.tax).toFixed(2)}`,
    `Total: ${parseFloat(invoice.total).toFixed(2)}`,
    `Paid (${invoice.payment_method}): ${parseFloat(invoice.paid).toFixed(2)}`,
    '',
    'Thank you for shopping with us!'
  );

  return lines.join('\n');
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
    return { ok: false, error: error.message, provider: 'twilio' };
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
      provider: 'twilio'
    };
  }
}

// Sends a clearly identifiable test message. Defaults to the shop's own
// configured WhatsApp number - never a customer number.
async function sendTestMessage(to) {
  const settings = require('./settings').getSettings();
  const target = to || settings.whatsapp_number || '';
  if (!target) {
    return { ok: false, error: 'Set the shop WhatsApp number first', provider: 'twilio' };
  }
  const shop = settings.shop_name || 'Mart POS';
  const stamp = new Date().toLocaleString('en-IN');
  return sendWhatsAppMessage(
    target,
    `MartPOS test message from ${shop} (${stamp}). WhatsApp billing is configured correctly.`
  );
}

module.exports = {
  formatBillText,
  sendWhatsAppMessage,
  sendTestMessage,
  normalizeWhatsAppNumber,
  whatsappStatus
};
