const { getDatabase, withTransaction } = require('./database');
const { calculateCartTotals, generateNextNumber } = require('./cart');
const { adjustStock } = require('./items');

function completeSale(cart, options = {}) {
  const {
    billDiscount = 0,
    paymentMethod = 'Cash',
    paid = null,
    partyId = null,
    partyName = '',
    partyPhone = '',
    userId = null
  } = options;

  const totals = calculateCartTotals(cart, billDiscount);
  
  if (!totals.items || totals.items.length === 0) {
    throw new Error('Cart is empty');
  }

  const total = totals.total;
  const paidAmount = paid === null ? total : parseFloat(paid);
  
  let status;
  if (paidAmount >= total - 0.009) {
    status = 'paid';
    paidAmount = total;
  } else if (paidAmount > 0) {
    status = 'partial';
  } else {
    status = 'unpaid';
  }

  return withTransaction((db) => {
    const invoiceNo = generateNextNumber(db, 'invoices', 'invoice_no', 'INV');
    
    // Get party details if partyId is provided
    if (partyId) {
      const partyStmt = db.prepare('SELECT * FROM parties WHERE id = ?');
      partyStmt.bind([partyId]);
      const party = partyStmt.getAsObject({})[0];
      partyStmt.free();
      
      if (party) {
        partyName = party.name;
        partyPhone = party.phone || partyPhone;
      }
    }

    const now = new Date().toISOString();
    
    // Insert invoice
    const invoiceStmt = db.prepare(`
      INSERT INTO invoices (invoice_no, party_id, party_name, party_phone, subtotal, discount, tax,
        cgst, sgst, igst, total, paid, payment_method, status, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    invoiceStmt.run([
      invoiceNo,
      partyId,
      partyName,
      partyPhone,
      totals.subtotal,
      totals.discount,
      totals.tax,
      totals.cgst,
      totals.sgst,
      totals.igst,
      total,
      paidAmount,
      paymentMethod,
      status,
      userId,
      now
    ]);
    invoiceStmt.free();

    const invoiceId = db.prepare('SELECT last_insert_rowid() as id').getAsObject({})[0].id;

    // Insert invoice items and adjust stock
    const itemStmt = db.prepare(`
      INSERT INTO invoice_items (invoice_id, item_id, code, name, quantity, price, gst_percent,
        discount, line_total, purchase_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of totals.items) {
      itemStmt.run([
        invoiceId,
        item.item_id,
        item.code,
        item.name,
        item.quantity,
        item.price,
        item.gst_percent,
        item.discount,
        item.line_total,
        item.purchase_price || 0
      ]);

      if (item.item_id) {
        adjustStock(db, item.item_id, -parseFloat(item.quantity));
      }
    }
    itemStmt.free();

    // Get complete invoice with items
    const invStmt = db.prepare('SELECT * FROM invoices WHERE id = ?');
    invStmt.bind([invoiceId]);
    const invoice = invStmt.getAsObject({})[0];
    invStmt.free();

    const linesStmt = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?');
    linesStmt.bind([invoiceId]);
    const lines = [];
    while (linesStmt.step()) {
      lines.push(linesStmt.getAsObject());
    }
    linesStmt.free();

    invoice.items = lines;
    return invoice;
  });
}

function listInvoices(limit = 200) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM invoices ORDER BY id DESC LIMIT ?');
  stmt.bind([limit]);
  const invoices = [];
  
  while (stmt.step()) {
    invoices.push(stmt.getAsObject());
  }
  stmt.free();
  return invoices;
}

function getInvoice(invoiceId) {
  const db = getDatabase();
  const invStmt = db.prepare('SELECT * FROM invoices WHERE id = ?');
  invStmt.bind([invoiceId]);
  const invResult = invStmt.getAsObject();
  invStmt.free();

  if (invResult.length === 0) return null;

  const invoice = invResult[0];

  const itemsStmt = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?');
  itemsStmt.bind([invoiceId]);
  invoice.items = [];
  while (itemsStmt.step()) {
    invoice.items.push(itemsStmt.getAsObject());
  }
  itemsStmt.free();

  const returnsStmt = db.prepare('SELECT * FROM sale_returns WHERE invoice_id = ?');
  returnsStmt.bind([invoiceId]);
  invoice.returns = [];
  while (returnsStmt.step()) {
    invoice.returns.push(returnsStmt.getAsObject());
  }
  returnsStmt.free();

  return invoice;
}

function getInvoiceByNo(invoiceNo) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM invoices WHERE invoice_no = ?');
  stmt.bind([invoiceNo]);
  const result = stmt.getAsObject();
  stmt.free();

  if (result.length === 0) return null;
  return getInvoice(result[0].id);
}

function recordInvoicePayment(invoiceId, amount, method = 'Cash') {
  return withTransaction((db) => {
    const invStmt = db.prepare('SELECT * FROM invoices WHERE id = ?');
    invStmt.bind([invoiceId]);
    const invResult = invStmt.getAsObject();
    invStmt.free();

    if (invResult.length === 0) {
      throw new Error('Invoice not found');
    }

    const invoice = invResult[0];
    const currentPaid = parseFloat(invoice.paid) || 0;
    const total = parseFloat(invoice.total) || 0;
    const newPaid = Math.min(total, currentPaid + parseFloat(amount));
    
    const status = newPaid >= total - 0.009 ? 'paid' : 'partial';

    const updateStmt = db.prepare('UPDATE invoices SET paid = ?, status = ?, payment_method = ? WHERE id = ?');
    updateStmt.run([newPaid, status, method, invoiceId]);
    updateStmt.free();

    // Add payment record if party exists
    if (invoice.party_id) {
      const paymentStmt = db.prepare('INSERT INTO payments (party_id, amount, method, note, created_at) VALUES (?, ?, ?, ?, ?)');
      paymentStmt.run([
        invoice.party_id,
        parseFloat(amount),
        method,
        `Invoice ${invoice.invoice_no}`,
        new Date().toISOString()
      ]);
      paymentStmt.free();
    }

    return getInvoice(invoiceId);
  });
}

function createSaleReturn(invoiceId, items, userId = null) {
  if (!items || items.length === 0) {
    throw new Error('Return items required');
  }

  return withTransaction((db) => {
    const invStmt = db.prepare('SELECT * FROM invoices WHERE id = ?');
    invStmt.bind([invoiceId]);
    const invResult = invStmt.getAsObject();
    invStmt.free();

    if (invResult.length === 0) {
      throw new Error('Invoice not found');
    }

    const invoice = invResult[0];
    let total = 0;
    const returnNo = generateNextNumber(db, 'sale_returns', 'return_no', 'RET');
    const now = new Date().toISOString();

    // Create sale return record
    const returnStmt = db.prepare('INSERT INTO sale_returns (invoice_id, return_no, total, user_id, created_at) VALUES (?, ?, 0, ?, ?)');
    returnStmt.run([invoiceId, returnNo, userId, now]);
    returnStmt.free();

    const returnIdResult = db.prepare('SELECT last_insert_rowid() as id').getAsObject();
    const returnId = returnIdResult[0].id;

    // Process return items
    const itemStmt = db.prepare(`
      INSERT INTO sale_return_items (return_id, invoice_item_id, item_id, quantity, amount)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const entry of items) {
      const lineStmt = db.prepare('SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ?');
      lineStmt.bind([entry.invoice_item_id, invoiceId]);
      const lineResult = lineStmt.getAsObject();
      lineStmt.free();

      if (lineResult.length === 0) {
        throw new Error('Invoice line not found');
      }

      const line = lineResult[0];
      const qty = parseFloat(entry.quantity) || 0;
      if (qty <= 0) continue;

      // Check if already returned
      const alreadyStmt = db.prepare(`
        SELECT COALESCE(SUM(sri.quantity), 0) as returned
        FROM sale_return_items sri
        JOIN sale_returns sr ON sri.return_id = sr.id
        WHERE sri.invoice_item_id = ?
      `);
      alreadyStmt.bind([line.id]);
      const alreadyResult = alreadyStmt.getAsObject();
      alreadyStmt.free();
      const alreadyReturned = alreadyResult[0].returned || 0;

      if (qty + alreadyReturned > parseFloat(line.quantity) + 1e-9) {
        throw new Error(`Cannot return more than sold for ${line.name}`);
      }

      const unit = parseFloat(line.line_total) / (parseFloat(line.quantity) || 1);
      const amount = Math.round(unit * qty * 100) / 100;
      total += amount;

      itemStmt.run([returnId, line.id, line.item_id, qty, amount]);

      if (line.item_id) {
        adjustStock(db, line.item_id, qty);
      }
    }
    itemStmt.free();

    // Update return total
    const updateStmt = db.prepare('UPDATE sale_returns SET total = ? WHERE id = ?');
    updateStmt.run([Math.round(total * 100) / 100, returnId]);
    updateStmt.free();

    // Get complete return record
    const resultStmt = db.prepare('SELECT * FROM sale_returns WHERE id = ?');
    resultStmt.bind([returnId]);
    const resultResult = resultStmt.getAsObject();
    resultStmt.free();

    const result = resultResult[0];
    const linesStmt = db.prepare('SELECT * FROM sale_return_items WHERE return_id = ?');
    linesStmt.bind([returnId]);
    result.items = [];
    while (linesStmt.step()) {
      result.items.push(linesStmt.getAsObject());
    }
    linesStmt.free();

    return result;
  });
}

module.exports = {
  completeSale,
  listInvoices,
  getInvoice,
  getInvoiceByNo,
  recordInvoicePayment,
  createSaleReturn
};
