const { getDatabase, withTransaction, execToObject } = require('./database');
const { generateNextNumber } = require('./cart');
const { getItemByCode, getItem, adjustStock } = require('./items');

// Validate purchase lines and compute per-line + bill totals.
// When allowItemDefaults is set (bill edit), a missing mrp falls back to the
// item's catalogue MRP instead of being required on the line.
function preparePurchaseLines(lines, { allowItemDefaults = false } = {}) {
  if (!lines || lines.length === 0) {
    throw new Error('Purchase has no items');
  }

  let subtotal = 0;
  let tax = 0;
  const prepared = [];

  for (const line of lines) {
    let item = getItemByCode(String(line.code || ''));
    if (!item && line.item_id) {
      item = getItem(line.item_id);
    }

    if (!item) {
      throw new Error('Unknown item in purchase');
    }

    const qty = parseFloat(line.quantity);
    if (!isFinite(qty) || qty <= 0) {
      throw new Error(`Invalid quantity for ${item.name}`);
    }

    const hasPrice = line.price !== undefined && line.price !== null && line.price !== '';
    const price = hasPrice ? parseFloat(line.price) : parseFloat(item.purchase_price);
    if (!isFinite(price) || price <= 0) {
      throw new Error(`Invalid purchase price for ${item.name}`);
    }

    const gstRaw = line.gst_percent !== undefined && line.gst_percent !== null && line.gst_percent !== '' ? parseFloat(line.gst_percent) : NaN;
    const GST_SLABS = [0, 0.25, 3, 5, 12, 18, 28];
    const gst = isFinite(gstRaw) ? gstRaw : (parseFloat(item.gst_percent) || 0);
    if (!GST_SLABS.includes(gst)) {
      throw new Error(`GST percent must be one of 0, 0.25, 3, 5, 12, 18, 28 for ${item.name}`);
    }

    // Determine sale price: explicit sale > MRP (MRP is required)
    let rawMRP = line.mrp !== undefined && line.mrp !== null && !isNaN(parseFloat(line.mrp)) ? parseFloat(line.mrp) : null;
    if (rawMRP === null && allowItemDefaults) {
      rawMRP = parseFloat(item.mrp) || parseFloat(item.sale_price) || null;
    }
    if (rawMRP === null || rawMRP <= 0) {
      throw new Error(`MRP is required and must be greater than 0 for ${item.name}`);
    }
    if (rawMRP <= price) {
      throw new Error(`MRP must be higher than purchase price for ${item.name}`);
    }

    const rawSale = line.sale_price !== undefined && line.sale_price !== null && !isNaN(parseFloat(line.sale_price)) ? parseFloat(line.sale_price) : null;
    const sale = (rawSale !== null && rawSale > 0) ? rawSale : rawMRP;

    if (sale <= 0) {
      throw new Error(`Sale price must be greater than 0 for ${item.name}`);
    }
    if (sale <= price) {
      throw new Error(`Sale price must be higher than purchase price for ${item.name}`);
    }
    if (sale > rawMRP) {
      throw new Error(`Sale price cannot be greater than MRP for ${item.name}`);
    }

    const taxable = qty * price;
    const lineTax = Math.round(taxable * gst / 100 * 100) / 100;
    const lineTotal = Math.round((taxable + lineTax) * 100) / 100;

    subtotal += taxable;
    tax += lineTax;

    prepared.push({
      item_id: item.id,
      code: item.code,
      name: item.name,
      quantity: qty,
      price: price,
      mrp: rawMRP,
      // Only an explicit sale_price is written back to the catalogue -
      // otherwise the item's existing sale_price is preserved.
      sale_price: (rawSale !== null && rawSale > 0) ? rawSale : null,
      gst_percent: gst,
      line_total: lineTotal
    });
  }

  const total = Math.round((subtotal + tax) * 100) / 100;
  return {
    prepared,
    subtotal: Math.round(subtotal * 100) / 100,
    tax: Math.round(tax * 100) / 100,
    total
  };
}

// Insert purchase_items rows, add the purchased stock, and write catalogue
// prices/GST back - shared by create and edit.
function insertPurchaseLines(db, purchaseId, prepared, now) {
  const itemStmt = db.prepare(`
    INSERT INTO purchase_items (purchase_id, item_id, code, name, quantity, price, gst_percent, line_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const line of prepared) {
    itemStmt.run([
      purchaseId,
      line.item_id,
      line.code,
      line.name,
      line.quantity,
      line.price,
      line.gst_percent,
      line.line_total
    ]);

    adjustStock(db, line.item_id, parseFloat(line.quantity));

    // Update item prices and GST
    const fields = ['purchase_price = ?'];
    const values = [line.price];
    const sale = parseFloat(line.sale_price);
    if (!isNaN(sale) && sale >= 0) {
      fields.push('sale_price = ?');
      values.push(sale);
    }
    const mrp = parseFloat(line.mrp);
    if (!isNaN(mrp) && mrp >= 0) {
      fields.push('mrp = ?');
      values.push(mrp);
    }
    const gst = parseFloat(line.gst_percent);
    if (!isNaN(gst) && gst >= 0) {
      fields.push('gst_percent = ?');
      values.push(gst);
    }
    values.push(now, line.item_id);
    const updateStmt = db.prepare(`UPDATE items SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`);
    updateStmt.run(values);
    updateStmt.free();
  }
  itemStmt.free();
}

function purchaseHasReturns(db, purchaseId) {
  const r = db.exec('SELECT COUNT(*) FROM purchase_returns WHERE purchase_id = ?', [purchaseId]);
  return r.length > 0 && r[0].values[0][0] > 0;
}

function completePurchase(lines, options = {}) {
  const {
    partyId = null,
    paid = null,
    userId = null
  } = options;
  let partyName = options.partyName || '';

  const { prepared, subtotal, tax, total } = preparePurchaseLines(lines);

  let paidAmount;
  if (paid === null || paid === undefined || paid === '') {
    paidAmount = total;
  } else {
    paidAmount = parseFloat(paid);
    if (!isFinite(paidAmount) || paidAmount < 0) {
      throw new Error('Invalid paid amount');
    }
    if (paidAmount > total) {
      throw new Error('Paid amount cannot exceed purchase total');
    }
  }

  return withTransaction((db) => {
    const purchaseNo = generateNextNumber(db, 'purchases', 'purchase_no', 'PUR');

    // Get party details if partyId is provided
    if (partyId !== null && partyId !== undefined && partyId !== '') {
      const partyStmt = db.prepare('SELECT * FROM parties WHERE id = ?');
      partyStmt.bind([partyId]);
      const party = partyStmt.getAsObject({})[0];
      partyStmt.free();

      if (!party) {
        throw new Error('Supplier not found');
      }
      if (party.type !== 'supplier') {
        throw new Error('Party is not a supplier');
      }
      partyName = party.name;
    }

    const now = new Date().toISOString();

    // Insert purchase
    const purchaseStmt = db.prepare(`
      INSERT INTO purchases (purchase_no, party_id, party_name, subtotal, tax, total, paid, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    purchaseStmt.run([
      purchaseNo,
      (partyId === undefined || partyId === '') ? null : partyId,
      partyName,
      subtotal,
      tax,
      total,
      paidAmount,
      userId,
      now
    ]);
    purchaseStmt.free();

    const purchaseId = db.prepare('SELECT last_insert_rowid() as id').getAsObject({})[0].id;

    insertPurchaseLines(db, purchaseId, prepared, now);

    // Get complete purchase with items
    const purchaseStmt2 = db.prepare('SELECT * FROM purchases WHERE id = ?');
    purchaseStmt2.bind([purchaseId]);
    const purchase = purchaseStmt2.getAsObject({})[0];
    purchaseStmt2.free();

    const linesStmt = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ?');
    linesStmt.bind([purchaseId]);
    purchase.items = [];
    while (linesStmt.step()) {
      purchase.items.push(linesStmt.getAsObject());
    }
    linesStmt.free();

    return purchase;
  });
}

// Optional `range` = { start, end } ISO bounds on created_at (see
// reportUtils.parseRange). No range -> newest `limit` purchases.
function listPurchases(limit = 200, range = null) {
  const db = getDatabase();
  const sql = range
    ? 'SELECT * FROM purchases WHERE created_at >= ? AND created_at <= ? ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM purchases ORDER BY id DESC LIMIT ?';
  const stmt = db.prepare(sql);
  stmt.bind(range ? [range.start, range.end, limit] : [limit]);
  const purchases = [];
  
  while (stmt.step()) {
    purchases.push(stmt.getAsObject());
  }
  stmt.free();
  return purchases;
}

function getPurchase(purchaseId) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM purchases WHERE id = ?');
  stmt.bind([purchaseId]);
  const result = stmt.getAsObject();
  stmt.free();

  if (result.length === 0) return null;

  const purchase = result[0];
  const itemsStmt = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ?');
  itemsStmt.bind([purchaseId]);
  purchase.items = [];
  while (itemsStmt.step()) {
    purchase.items.push(itemsStmt.getAsObject());
  }
  itemsStmt.free();

  return purchase;
}

// Edit a purchase bill: reverses the old stock, revalidates the new lines
// (missing MRP falls back to the item's catalogue MRP), restocks, and updates
// supplier/totals/paid. Blocked when the bill has returns recorded.
function updatePurchase(purchaseId, payload = {}) {
  return withTransaction((db) => {
    const purchase = getPurchase(purchaseId);
    if (!purchase) {
      throw new Error('Purchase not found');
    }
    if (purchaseHasReturns(db, purchaseId)) {
      throw new Error('Purchase has returns and cannot be edited.');
    }

    const lines = payload.items || [];
    if (lines.length === 0) {
      throw new Error('Purchase has no items');
    }

    // Reverse the old stock before re-applying the new lines
    for (const line of purchase.items) {
      if (line.item_id) {
        adjustStock(db, line.item_id, -parseFloat(line.quantity));
      }
    }
    db.run('DELETE FROM purchase_items WHERE purchase_id = ?', [purchaseId]);

    const { prepared, subtotal, tax, total } = preparePurchaseLines(lines, { allowItemDefaults: true });

    // Supplier: explicit party_id wins; '' clears it to a walk-in purchase.
    let partyId = purchase.party_id;
    let partyName = purchase.party_name;
    if (payload.party_id !== undefined) {
      if (payload.party_id === null || payload.party_id === '') {
        partyId = null;
        partyName = '';
      } else {
        const rec = execToObject('SELECT * FROM parties WHERE id = ?', [payload.party_id]);
        if (!rec) {
          throw new Error('Supplier not found');
        }
        if (rec.type !== 'supplier') {
          throw new Error('Party is not a supplier');
        }
        partyId = rec.id;
        partyName = rec.name;
      }
    }

    let paidAmount;
    if (payload.paid !== undefined && payload.paid !== null && payload.paid !== '') {
      paidAmount = parseFloat(payload.paid);
      if (!isFinite(paidAmount) || paidAmount < 0) {
        throw new Error('Paid amount cannot be negative');
      }
    } else {
      paidAmount = parseFloat(purchase.paid) || 0;
    }
    paidAmount = Math.min(paidAmount, total);

    const now = new Date().toISOString();
    insertPurchaseLines(db, purchaseId, prepared, now);

    db.run(
      'UPDATE purchases SET party_id = ?, party_name = ?, subtotal = ?, tax = ?, total = ?, paid = ? WHERE id = ?',
      [partyId, partyName, subtotal, tax, total, paidAmount, purchaseId]
    );

    return getPurchase(purchaseId);
  });
}

// Delete a purchase bill: removes the stock it added, any linked payment
// rows, and the purchase itself. Blocked when returns exist.
function deletePurchase(purchaseId) {
  return withTransaction((db) => {
    const purchase = getPurchase(purchaseId);
    if (!purchase) {
      throw new Error('Purchase not found');
    }
    if (purchaseHasReturns(db, purchaseId)) {
      throw new Error('Purchase has returns and cannot be deleted.');
    }

    for (const line of purchase.items) {
      if (line.item_id) {
        adjustStock(db, line.item_id, -parseFloat(line.quantity));
      }
    }

    db.run("DELETE FROM payments WHERE (ref_type = 'purchase' AND ref_id = ?) OR note = ?", [purchaseId, `Purchase ${purchase.purchase_no}`]);
    db.run('DELETE FROM purchase_items WHERE purchase_id = ?', [purchaseId]);
    db.run('DELETE FROM purchases WHERE id = ?', [purchaseId]);

    return purchase;
  });
}

module.exports = {
  completePurchase,
  updatePurchase,
  deletePurchase,
  listPurchases,
  getPurchase
};
