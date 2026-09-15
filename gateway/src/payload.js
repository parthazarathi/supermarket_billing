// Only the whitelisted snapshot fields are stored - arbitrary nested caller
// JSON is dropped.

const MAX_ITEMS = 500;

function capStr(v, max) {
  return String(v === null || v === undefined ? '' : v).slice(0, max);
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function sanitizeItem(it) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
  return {
    name: capStr(it.name, 200),
    quantity: num(it.quantity),
    price: num(it.price),
    gst_percent: num(it.gst_percent),
    discount: num(it.discount),
    line_total: num(it.line_total)
  };
}

function sanitizeInvoice(inv) {
  return {
    invoice_no: capStr(inv.invoice_no, 80),
    party_name: capStr(inv.party_name, 160),
    party_phone: capStr(inv.party_phone, 40),
    created_at: capStr(inv.created_at, 40),
    subtotal: num(inv.subtotal),
    discount: num(inv.discount),
    tax: num(inv.tax),
    cgst: num(inv.cgst),
    sgst: num(inv.sgst),
    igst: num(inv.igst),
    total: num(inv.total),
    paid: num(inv.paid),
    payment_method: capStr(inv.payment_method, 40),
    items: (Array.isArray(inv.items) ? inv.items : []).map(sanitizeItem).filter(Boolean)
  };
}

function sanitizeSettings(s) {
  const src = s && typeof s === 'object' ? s : {};
  return {
    shop_name: capStr(src.shop_name, 160),
    gstin: capStr(src.gstin, 40),
    receipt_header: capStr(src.receipt_header, 300),
    whatsapp_number: capStr(src.whatsapp_number, 40)
  };
}

function sanitizeMessagePayload(messageType, payload) {
  if (payload === undefined || payload === null) {
    if (messageType === 'invoice' || messageType === 'test') {
      return { ok: false, error: 'payload.invoice is required' };
    }
    return { ok: true, value: null };
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }
  const needsInvoice = messageType === 'invoice' || messageType === 'test';
  if (needsInvoice) {
    const inv = payload.invoice;
    if (!inv || typeof inv !== 'object' || Array.isArray(inv)) {
      return { ok: false, error: 'payload.invoice is required' };
    }
    if (capStr(inv.invoice_no, 1000).length > 80) {
      return { ok: false, error: 'payload.invoice.invoice_no is too long' };
    }
    if (Array.isArray(inv.items) && inv.items.length > MAX_ITEMS) {
      return { ok: false, error: `payload.invoice.items is limited to ${MAX_ITEMS} entries` };
    }
  }
  const value = { settings: sanitizeSettings(payload.settings) };
  if (payload.invoice && typeof payload.invoice === 'object' && !Array.isArray(payload.invoice)) {
    if (Array.isArray(payload.invoice.items) && payload.invoice.items.length > MAX_ITEMS) {
      return { ok: false, error: `payload.invoice.items is limited to ${MAX_ITEMS} entries` };
    }
    value.invoice = sanitizeInvoice(payload.invoice);
  }
  return { ok: true, value };
}

module.exports = { sanitizeMessagePayload, MAX_ITEMS };
