const { getSetting } = require('./settings');

function calculateCartTotals(cart, billDiscount = 0) {
  const gstType = getSetting('gst_type', 'intra');
  const items = [];
  let subtotal = 0;
  let tax = 0;

  for (const [code, entry] of Object.entries(cart)) {
    const qty = parseFloat(entry.quantity) || 1;
    const price = parseFloat(entry.price) || 0;
    const gstPercent = parseFloat(entry.gst_percent) || 0;
    const lineDisc = parseFloat(entry.discount) || 0;
    
    const taxable = Math.max(0, qty * price - lineDisc);
    const lineTax = Math.round(taxable * gstPercent / 100 * 100) / 100;
    const lineTotal = Math.round((taxable + lineTax) * 100) / 100;

    subtotal += taxable;
    tax += lineTax;

    items.push({
      code: code,
      item_id: entry.item_id,
      name: entry.name,
      category: entry.category,
      price: price,
      quantity: qty,
      gst_percent: gstPercent,
      discount: lineDisc,
      purchase_price: parseFloat(entry.purchase_price) || 0,
      mrp: parseFloat(entry.mrp) || 0,
      line_tax: lineTax,
      line_total: lineTotal,
      stock: entry.stock,
      unit: entry.unit || 'pcs'
    });
  }

  billDiscount = Math.max(0, parseFloat(billDiscount) || 0);
  const afterDisc = Math.max(0, subtotal - billDiscount);

  if (subtotal > 0 && billDiscount > 0) {
    const ratio = afterDisc / subtotal;
    tax = Math.round(tax * ratio * 100) / 100;
  } else {
    tax = Math.round(tax * 100) / 100;
  }

  let cgst, sgst, igst;
  if (gstType === 'inter') {
    cgst = 0;
    sgst = 0;
    igst = tax;
  } else {
    const half = Math.round(tax / 2 * 100) / 100;
    cgst = half;
    sgst = Math.round((tax - half) * 100) / 100;
    igst = 0;
  }

  const total = Math.round((afterDisc + tax) * 100) / 100;

  return {
    items: items,
    subtotal: Math.round(subtotal * 100) / 100,
    discount: Math.round(billDiscount * 100) / 100,
    tax: tax,
    cgst: cgst,
    sgst: sgst,
    igst: igst,
    gst_type: gstType,
    total: total
  };
}

function generateNextNumber(db, table, column, prefix) {
  const today = new Date();
  const dayPrefix = today.getFullYear().toString() +
    String(today.getMonth() + 1).padStart(2, '0') +
    String(today.getDate()).padStart(2, '0');
  
  const likePattern = `${prefix}-${dayPrefix}-%`;
  const result = db.exec(`SELECT ${column} FROM ${table} WHERE ${column} LIKE '${likePattern}' ORDER BY id DESC LIMIT 1`);
  
  let seq = 1;
  if (result.length > 0 && result[0].values.length > 0) {
    const row = result[0].values[0];
    const colIndex = result[0].columns.indexOf(column);
    const parts = row[colIndex].split('-');
    const lastSeq = parseInt(parts[parts.length - 1]);
    if (!isNaN(lastSeq)) {
      seq = lastSeq + 1;
    }
  }

  return `${prefix}-${dayPrefix}-${String(seq).padStart(4, '0')}`;
}

module.exports = {
  calculateCartTotals,
  generateNextNumber
};
