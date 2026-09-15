// Approval status is whatever Meta reports and is refreshed while not
// APPROVED - this code never claims approval itself.
const store = require('./store');

const INVOICE_TEMPLATE = 'mart_pos_invoice';
const INVOICE_TEMPLATE_LANGUAGE = 'en_US';

// Text-only on purpose: a BODY with example.body_text is approvable without a
// Resumable Upload sample handle. A separately configured approved media
// template can still drive the document-header send path. Positional body
// parameters: {{1}} customer, {{2}} shop, {{3}} invoice no, {{4}} item count,
// {{5}} subtotal, {{6}} discount, {{7}} total, {{8}} payment method.
function invoiceTemplateDefinition() {
  return {
    name: INVOICE_TEMPLATE,
    category: 'UTILITY',
    language: INVOICE_TEMPLATE_LANGUAGE,
    components: [
      {
        type: 'BODY',
        text:
          'Hello {{1}},\n\n' +
          'Thank you for shopping with {{2}}.\n\n' +
          'Invoice: {{3}}\n' +
          'Items: {{4}}\n' +
          'Subtotal: {{5}}\n' +
          'Discount: {{6}}\n' +
          'Amount: {{7}}\n' +
          'Payment: {{8}}\n\n' +
          'Thank you for shopping with us!',
        example: {
          body_text: [['QA Customer', 'Bharathi Supermarket', 'INV-1001', '3', 'INR 890.00', 'INR 40.00', 'INR 850.00', 'UPI']]
        }
      }
    ]
  };
}

function hasDocumentHeader(components) {
  const list = Array.isArray(components) ? components : (() => { try { return JSON.parse(components); } catch (_) { return []; } })();
  return list.some((c) => c && String(c.type).toUpperCase() === 'HEADER' && String(c.format).toUpperCase() === 'DOCUMENT');
}

async function createAtMeta(q, meta, shopId, wabaId) {
  let status = 'UNKNOWN';
  let metaId = '';
  try {
    const created = await meta.createMessageTemplate(wabaId, invoiceTemplateDefinition());
    metaId = created && created.id ? String(created.id) : '';
    status = (created && created.status) || 'PENDING';
  } catch (e) {
    try {
      const found = await meta.findMessageTemplate(wabaId, INVOICE_TEMPLATE);
      const row = found && Array.isArray(found.data) ? found.data[0] : null;
      if (row) {
        metaId = String(row.id || '');
        status = row.status || 'UNKNOWN';
      } else {
        status = 'ERROR';
      }
    } catch (_) {
      status = 'ERROR';
    }
  }
  return store.upsertTemplate(q, {
    shopId,
    name: INVOICE_TEMPLATE,
    language: INVOICE_TEMPLATE_LANGUAGE,
    category: 'UTILITY',
    metaTemplateId: metaId,
    status,
    documentHeader: false,
    components: invoiceTemplateDefinition().components
  });
}

async function ensureInvoiceTemplate(q, meta, shopId, wabaId) {
  const existing = await store.getTemplate(q, shopId, INVOICE_TEMPLATE, INVOICE_TEMPLATE_LANGUAGE);
  if (!existing) return createAtMeta(q, meta, shopId, wabaId);
  if (String(existing.status).toUpperCase() === 'APPROVED') return existing;

  try {
    const found = await meta.findMessageTemplate(wabaId, INVOICE_TEMPLATE);
    const row = found && Array.isArray(found.data) && found.data.length ? found.data[0] : null;
    if (!row) return existing;
    return store.upsertTemplate(q, {
      shopId,
      name: INVOICE_TEMPLATE,
      language: INVOICE_TEMPLATE_LANGUAGE,
      category: existing.category || 'UTILITY',
      metaTemplateId: String(row.id || existing.meta_template_id || ''),
      status: row.status || existing.status,
      documentHeader: hasDocumentHeader(row.components) || !!existing.document_header,
      components: row.components || existing.components || null
    });
  } catch (_) {
    return existing;
  }
}

module.exports = { ensureInvoiceTemplate, invoiceTemplateDefinition, INVOICE_TEMPLATE, INVOICE_TEMPLATE_LANGUAGE };
