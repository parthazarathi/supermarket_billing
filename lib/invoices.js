const { getDatabase, withTransaction, execToObject } = require('./database');
const { calculateCartTotals, generateNextNumber } = require('./cart');
const { adjustStock } = require('./items');
const { checkCreditLimit } = require('./parties');

function completeSale(cart, options = {}) {
  const {
    billDiscount = 0,
    paymentMethod = 'Cash',
    paid = null,
    partyId = null,
    userId = null
  } = options;
  let { partyName = '', partyPhone = '' } = options;

  const totals = calculateCartTotals(cart, billDiscount);

  if (!totals.items || totals.items.length === 0) {
    throw new Error('Cart is empty');
  }

  const validMethods = ['Cash', 'UPI', 'Card', 'Credit'];
  if (!validMethods.includes(paymentMethod)) {
    throw new Error('Invalid payment method');
  }

  const total = totals.total;
  let paidAmount;
  if (paid === null || paid === undefined || paid === '') {
    paidAmount = total;
  } else {
    paidAmount = parseFloat(paid);
    if (!isFinite(paidAmount) || paidAmount < 0) {
      throw new Error('Invalid paid amount');
    }
  }
  paidAmount = Math.min(paidAmount, total);

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
    // Re-validate every line against live stock inside the transaction
    for (const item of totals.items) {
      const qty = parseFloat(item.quantity);
      const price = parseFloat(item.price);
      if (!isFinite(qty) || qty <= 0) {
        throw new Error(`Invalid quantity for ${item.name}`);
      }
      if (!isFinite(price) || price <= 0) {
        throw new Error(`Invalid price for ${item.name}`);
      }
      if (item.item_id) {
        const stockStmt = db.prepare('SELECT stock FROM items WHERE id = ?');
        stockStmt.bind([item.item_id]);
        const stockResult = stockStmt.getAsObject();
        stockStmt.free();
        const stock = stockResult.length > 0 ? parseFloat(stockResult[0].stock) || 0 : 0;
        if (qty > stock + 1e-9) {
          throw new Error(`Insufficient stock for ${item.name}`);
        }
      }
    }

    const invoiceNo = generateNextNumber(db, 'invoices', 'invoice_no', 'INV');

    // Get party details if partyId is provided
    let party = null;
    if (partyId) {
      const partyStmt = db.prepare('SELECT * FROM parties WHERE id = ?');
      partyStmt.bind([partyId]);
      party = partyStmt.getAsObject({})[0] || null;
      partyStmt.free();

      if (party) {
        partyName = party.name;
        partyPhone = party.phone || partyPhone;
      }
    }

    // Credit limit check when the bill is not fully paid
    if (status !== 'paid' && party && (parseFloat(party.credit_limit) || 0) > 0) {
      const check = checkCreditLimit(party.id, total - paidAmount);
      if (!check.withinLimit) {
        throw new Error(`Credit limit exceeded for ${party.name}`);
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
    const invStmt = db.prepare('SELECT i.*, u.username as cashier FROM invoices i LEFT JOIN users u ON i.user_id = u.id WHERE i.id = ?');
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

// Optional `range` = { start, end } ISO bounds on created_at (see
// reportUtils.parseRange). No range -> newest `limit` invoices.
function listInvoices(limit = 200, range = null) {
  const db = getDatabase();
  const sql = range
    ? 'SELECT * FROM invoices WHERE created_at >= ? AND created_at <= ? ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM invoices ORDER BY id DESC LIMIT ?';
  const stmt = db.prepare(sql);
  stmt.bind(range ? [range.start, range.end, limit] : [limit]);
  const invoices = [];
  
  while (stmt.step()) {
    invoices.push(stmt.getAsObject());
  }
  stmt.free();
  return invoices;
}

function getInvoice(invoiceId) {
  const db = getDatabase();
  const invStmt = db.prepare('SELECT i.*, u.username as cashier FROM invoices i LEFT JOIN users u ON i.user_id = u.id WHERE i.id = ?');
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

function recordInvoicePayment(invoiceId, amount, method = 'Cash', userId = null) {
  return withTransaction((db) => {
    const invStmt = db.prepare('SELECT * FROM invoices WHERE id = ?');
    invStmt.bind([invoiceId]);
    const invResult = invStmt.getAsObject();
    invStmt.free();

    if (invResult.length === 0) {
      throw new Error('Invoice not found');
    }

    const invoice = invResult[0];
    if (invoice.status === 'cancelled') {
      throw new Error('Cannot collect payment on a cancelled bill');
    }

    const amountNum = parseFloat(amount);
    if (!isFinite(amountNum) || amountNum <= 0) {
      throw new Error('Invalid payment amount');
    }

    const currentPaid = parseFloat(invoice.paid) || 0;
    const total = parseFloat(invoice.total) || 0;
    if (amountNum > (total - currentPaid) + 1e-9) {
      throw new Error('Amount exceeds outstanding due');
    }
    const newPaid = Math.min(total, currentPaid + amountNum);

    const status = newPaid >= total - 0.009 ? 'paid' : 'partial';

    const updateStmt = db.prepare('UPDATE invoices SET paid = ?, status = ?, payment_method = ? WHERE id = ?');
    updateStmt.run([newPaid, status, method, invoiceId]);
    updateStmt.free();

    // Add payment record if party exists
    if (invoice.party_id) {
      const paymentStmt = db.prepare("INSERT INTO payments (party_id, amount, method, note, created_at, user_id, direction, ref_type, ref_id) VALUES (?, ?, ?, ?, ?, ?, 'in', 'invoice', ?)");
      paymentStmt.run([
        invoice.party_id,
        amountNum,
        method,
        `Invoice ${invoice.invoice_no}`,
        new Date().toISOString(),
        userId,
        invoiceId
      ]);
      paymentStmt.free();
    }

    return getInvoice(invoiceId);
  });
}

function createSaleReturn(invoiceId, items, userId = null, reason = '') {
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
    if (invoice.status === 'cancelled') {
      throw new Error('Cannot return items on a cancelled bill');
    }

    // Bill-level discount is prorated across lines: the refund unit price is
    // line_total scaled by (invoice.total / sum of line_totals).
    const lineSumRow = db.prepare('SELECT COALESCE(SUM(line_total), 0) as s FROM invoice_items WHERE invoice_id = ?');
    lineSumRow.bind([invoiceId]);
    const lineSumResult = lineSumRow.getAsObject();
    lineSumRow.free();
    const lineSum = lineSumResult.length > 0 ? parseFloat(lineSumResult[0].s) || 0 : 0;
    const ratio = lineSum > 0 ? (parseFloat(invoice.total) || 0) / lineSum : 1;

    let total = 0;
    const returnNo = generateNextNumber(db, 'sale_returns', 'return_no', 'RET');
    const now = new Date().toISOString();

    // Create sale return record
    const returnStmt = db.prepare('INSERT INTO sale_returns (invoice_id, return_no, total, user_id, created_at, reason) VALUES (?, ?, 0, ?, ?, ?)');
    returnStmt.run([invoiceId, returnNo, userId, now, reason || '']);
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
      const qty = parseFloat(entry.quantity);
      if (!isFinite(qty) || qty <= 0) {
        throw new Error('Invalid return quantity');
      }

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

      const unit = (parseFloat(line.line_total) / (parseFloat(line.quantity) || 1)) * ratio;
      const amount = Math.round(unit * qty * 100) / 100;
      total += amount;

      itemStmt.run([returnId, line.id, line.item_id, qty, amount]);

      if (line.item_id) {
        adjustStock(db, line.item_id, qty);
      }
    }
    itemStmt.free();

    total = Math.round(total * 100) / 100;

    // Split the return value: the part still owed by the customer becomes
    // account credit, the rest is cash refunded now.
    const due = Math.max(0, (parseFloat(invoice.total) || 0) - (parseFloat(invoice.paid) || 0));
    const credit = Math.min(total, due);
    const refund = Math.round((total - credit) * 100) / 100;

    // Update return total and refunded portion
    const updateStmt = db.prepare('UPDATE sale_returns SET total = ?, refund_amount = ? WHERE id = ?');
    updateStmt.run([total, refund, returnId]);
    updateStmt.free();

    if (refund > 1e-9) {
      const refundStmt = db.prepare("INSERT INTO payments (party_id, amount, method, note, direction, ref_type, ref_id, created_at, user_id) VALUES (?, ?, ?, ?, 'out', 'sale_return', ?, ?, ?)");
      refundStmt.run([
        invoice.party_id,
        refund,
        invoice.payment_method || 'Cash',
        `Refund ${returnNo}`,
        returnId,
        now,
        userId
      ]);
      refundStmt.free();
    }

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

// Cancel a bill: restores stock and marks the invoice cancelled.
// The record is kept for audit; reports exclude cancelled invoices.
function cancelInvoice(invoiceId, userId = null, reason = '') {
  return withTransaction((db) => {
    const invStmt = db.prepare('SELECT * FROM invoices WHERE id = ?');
    invStmt.bind([invoiceId]);
    const invResult = invStmt.getAsObject();
    invStmt.free();

    if (invResult.length === 0) {
      throw new Error('Invoice not found');
    }
    const invoice = invResult[0];
    if (invoice.status === 'cancelled') {
      throw new Error('Invoice is already cancelled');
    }

    // Restore stock for each sold line
    const linesStmt = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?');
    linesStmt.bind([invoiceId]);
    const lines = [];
    while (linesStmt.step()) {
      lines.push(linesStmt.getAsObject());
    }
    linesStmt.free();

    for (const line of lines) {
      if (line.item_id) {
        const alreadyStmt = db.prepare(`
          SELECT COALESCE(SUM(sri.quantity), 0) as returned
          FROM sale_return_items sri
          JOIN sale_returns sr ON sri.return_id = sr.id
          WHERE sri.invoice_item_id = ?
        `);
        alreadyStmt.bind([line.id]);
        const already = alreadyStmt.getAsObject()[0].returned || 0;
        alreadyStmt.free();
        adjustStock(db, line.item_id, parseFloat(line.quantity) - parseFloat(already));
      }
    }

    const now = new Date().toISOString();
    const upd = db.prepare("UPDATE invoices SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ?");
    upd.run([userId, now, reason || '', invoiceId]);
    upd.free();

    // Record the money returned to the customer. invoices.paid is left
    // untouched - reports already exclude cancelled bills.
    const paidAmount = parseFloat(invoice.paid) || 0;
    if (paidAmount > 0) {
      const refundStmt = db.prepare("INSERT INTO payments (party_id, amount, method, note, direction, ref_type, ref_id, created_at, user_id) VALUES (?, ?, ?, ?, 'out', 'invoice_refund', ?, ?, ?)");
      refundStmt.run([
        invoice.party_id,
        paidAmount,
        invoice.payment_method || 'Cash',
        `Refund on cancelled ${invoice.invoice_no}`,
        invoiceId,
        now,
        userId
      ]);
      refundStmt.free();
    }

    return getInvoice(invoiceId);
  });
}

// Edit an existing bill: reverses old stock, rebuilds lines and totals.
function updateInvoice(invoiceId, payload = {}, userId = null) {
  return withTransaction((db) => {
    const invoice = getInvoice(invoiceId);
    if (!invoice) {
      throw new Error('Invoice not found');
    }
    if (invoice.status === 'cancelled') {
      throw new Error('Cancelled bills cannot be edited.');
    }
    if (invoice.returns && invoice.returns.length > 0) {
      throw new Error('Bill has returns and cannot be edited.');
    }

    const lines = payload.items || [];
    if (lines.length === 0) {
      throw new Error('Bill must have at least one item');
    }

    // Reverse stock for the old lines; remember each line's recorded cost so
    // historical COGS stays fixed for items that remain on the bill
    const originalCost = {};
    for (const line of invoice.items) {
      if (line.item_id) {
        adjustStock(db, line.item_id, parseFloat(line.quantity));
      }
      originalCost[line.code] = parseFloat(line.purchase_price) || 0;
    }
    db.run('DELETE FROM invoice_items WHERE invoice_id = ?', [invoiceId]);

    // Build a cart for calculateCartTotals, taking catalogue fields from items
    const cart = {};
    for (const entry of lines) {
      const code = String(entry.code || '').trim();
      const item = execToObject('SELECT * FROM items WHERE code = ?', [code]);
      if (!item) {
        throw new Error(`Item ${code} not found`);
      }
      const qty = parseFloat(entry.quantity);
      const price = parseFloat(entry.price);
      const lineDisc = parseFloat(entry.discount) || 0;
      if (!(qty > 0)) {
        throw new Error(`Quantity must be greater than 0 for ${item.name}`);
      }
      if (!(price >= 0)) {
        throw new Error(`Price cannot be negative for ${item.name}`);
      }
      cart[code] = {
        item_id: item.id,
        name: item.name,
        category: item.category || 'General',
        price: price,
        quantity: qty,
        gst_percent: parseFloat(item.gst_percent) || 0,
        discount: Math.max(0, lineDisc),
        purchase_price: code in originalCost ? originalCost[code] : (parseFloat(item.purchase_price) || 0),
        mrp: parseFloat(item.mrp) || 0,
        stock: item.stock,
        unit: item.unit || 'pcs'
      };
    }

    const billDiscount = Math.max(0, parseFloat(payload.bill_discount) || 0);
    const totals = calculateCartTotals(cart, billDiscount);
    const total = totals.total;

    const paymentMethod = payload.payment_method || invoice.payment_method || 'Cash';
    let paidAmount;
    if (payload.paid !== undefined && payload.paid !== null && payload.paid !== '') {
      paidAmount = parseFloat(payload.paid);
      if (!isFinite(paidAmount) || paidAmount < 0) {
        throw new Error('Paid amount cannot be negative');
      }
    } else {
      paidAmount = parseFloat(invoice.paid) || 0;
    }
    paidAmount = Math.min(paidAmount, total);

    let status;
    if (paidAmount >= total - 0.009) {
      status = 'paid';
      paidAmount = total;
    } else if (paidAmount > 0) {
      status = 'partial';
    } else {
      status = 'unpaid';
    }

    let partyId = payload.party_id || null;
    let partyName = payload.party_name || '';
    let partyPhone = payload.party_phone || '';
    if (partyId) {
      const party = execToObject('SELECT * FROM parties WHERE id = ?', [partyId]);
      if (party) {
        partyName = party.name;
        partyPhone = party.phone || partyPhone;
      }
    }

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

    db.run(
      'UPDATE invoices SET party_id = ?, party_name = ?, party_phone = ?, subtotal = ?, discount = ?, tax = ?, cgst = ?, sgst = ?, igst = ?, total = ?, paid = ?, payment_method = ?, status = ? WHERE id = ?',
      [partyId, partyName, partyPhone, totals.subtotal, totals.discount, totals.tax,
        totals.cgst, totals.sgst, totals.igst, total, paidAmount, paymentMethod, status, invoiceId]
    );

    return getInvoice(invoiceId);
  });
}

// Delete a bill: restores stock (unless already cancelled) and removes all rows.
function deleteInvoice(invoiceId, userId = null) {
  return withTransaction((db) => {
    const invoice = getInvoice(invoiceId);
    if (!invoice) {
      throw new Error('Invoice not found');
    }
    if (invoice.returns && invoice.returns.length > 0) {
      throw new Error('Bill has returns and cannot be deleted. Cancel it instead.');
    }

    if (invoice.status !== 'cancelled') {
      for (const line of invoice.items) {
        if (line.item_id) {
          adjustStock(db, line.item_id, parseFloat(line.quantity));
        }
      }
    }

    db.run("DELETE FROM payments WHERE (ref_type = 'invoice' AND ref_id = ?) OR note = ?", [invoiceId, `Invoice ${invoice.invoice_no}`]);
    db.run('DELETE FROM invoice_items WHERE invoice_id = ?', [invoiceId]);
    db.run('DELETE FROM invoices WHERE id = ?', [invoiceId]);

    return invoice;
  });
}

module.exports = {
  completeSale,
  listInvoices,
  getInvoice,
  getInvoiceByNo,
  recordInvoicePayment,
  createSaleReturn,
  cancelInvoice,
  updateInvoice,
  deleteInvoice
};
