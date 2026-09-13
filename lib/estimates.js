const { getDatabase, withTransaction, execToObjects, execToObject } = require('./database');
const { calculateCartTotals, generateNextNumber } = require('./cart');
const { getItemByCode, getItem } = require('./items');

// Rebuild a client cart with catalogue data: item names/codes come from the
// database, never from client strings, and quantities/prices are validated.
function resolveEstimateCart(cart) {
  const clean = {};
  for (const [code, entry] of Object.entries(cart || {})) {
    let item = null;
    if (code && String(code).trim() !== '') {
      item = getItemByCode(String(code));
    }
    if (!item && entry.item_id) {
      item = getItem(entry.item_id);
    }
    if (!item) {
      throw new Error('Unknown item in estimate');
    }

    const qty = parseFloat(entry.quantity);
    if (!isFinite(qty) || qty <= 0) {
      throw new Error(`Invalid quantity for ${item.name}`);
    }
    const hasPrice = entry.price !== undefined && entry.price !== null && entry.price !== '';
    const price = hasPrice ? parseFloat(entry.price) : parseFloat(item.sale_price);
    if (!isFinite(price) || price < 0) {
      throw new Error(`Invalid price for ${item.name}`);
    }
    const gstRaw = parseFloat(entry.gst_percent);

    clean[item.code] = {
      item_id: item.id,
      name: item.name,
      category: entry.category || item.category || 'General',
      price: price,
      quantity: qty,
      gst_percent: isFinite(gstRaw) ? gstRaw : (parseFloat(item.gst_percent) || 0),
      discount: Math.max(0, parseFloat(entry.discount) || 0),
      purchase_price: parseFloat(item.purchase_price) || 0,
      mrp: parseFloat(item.mrp) || 0,
      stock: item.stock,
      unit: item.unit || 'pcs'
    };
  }
  return clean;
}

function createEstimate(cart, options = {}) {
  const {
    billDiscount = 0,
    partyId = null,
    validUntil = null,
    notes = '',
    userId = null
  } = options;
  let partyName = options.partyName || '';
  let partyPhone = options.partyPhone || '';

  const totals = calculateCartTotals(resolveEstimateCart(cart), billDiscount);
  
  if (!totals.items || totals.items.length === 0) {
    throw new Error('Cart is empty');
  }

  return withTransaction((db) => {
    const estimateNo = generateNextNumber(db, 'estimates', 'estimate_no', 'EST');
    
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
    const validDate = validUntil || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    
    // Insert estimate
    const estimateStmt = db.prepare(`
      INSERT INTO estimates (estimate_no, party_id, party_name, party_phone, subtotal, discount, tax,
        cgst, sgst, igst, total, valid_until, notes, status, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    estimateStmt.run([
      estimateNo,
      partyId,
      partyName,
      partyPhone,
      totals.subtotal,
      totals.discount,
      totals.tax,
      totals.cgst,
      totals.sgst,
      totals.igst,
      totals.total,
      validDate,
      notes,
      'pending',
      userId,
      now,
      now
    ]);
    estimateStmt.free();

    const estimateId = db.prepare('SELECT last_insert_rowid() as id').getAsObject({})[0].id;

    // Insert estimate items
    const itemStmt = db.prepare(`
      INSERT INTO estimate_items (estimate_id, item_id, code, name, quantity, price, gst_percent,
        discount, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of totals.items) {
      itemStmt.run([
        estimateId,
        item.item_id,
        item.code,
        item.name,
        item.quantity,
        item.price,
        item.gst_percent,
        item.discount,
        item.line_total
      ]);
    }
    itemStmt.free();

    // Get complete estimate with items
    const estStmt = db.prepare('SELECT * FROM estimates WHERE id = ?');
    estStmt.bind([estimateId]);
    const estimate = estStmt.getAsObject({})[0];
    estStmt.free();

    const linesStmt = db.prepare('SELECT * FROM estimate_items WHERE estimate_id = ?');
    linesStmt.bind([estimateId]);
    const lines = [];
    while (linesStmt.step()) {
      lines.push(linesStmt.getAsObject());
    }
    linesStmt.free();

    estimate.items = lines;
    return estimate;
  });
}

function listEstimates(limit = 200) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM estimates ORDER BY id DESC LIMIT ?');
  stmt.bind([limit]);
  const estimates = [];
  
  while (stmt.step()) {
    estimates.push(stmt.getAsObject());
  }
  stmt.free();
  return estimates;
}

function getEstimate(estimateId) {
  const db = getDatabase();
  const estStmt = db.prepare('SELECT * FROM estimates WHERE id = ?');
  estStmt.bind([estimateId]);
  const estResult = estStmt.getAsObject();
  estStmt.free();

  if (estResult.length === 0) return null;

  const estimate = estResult[0];

  const itemsStmt = db.prepare('SELECT * FROM estimate_items WHERE estimate_id = ?');
  itemsStmt.bind([estimateId]);
  estimate.items = [];
  while (itemsStmt.step()) {
    estimate.items.push(itemsStmt.getAsObject());
  }
  itemsStmt.free();

  return estimate;
}

function getEstimateByNo(estimateNo) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM estimates WHERE estimate_no = ?');
  stmt.bind([estimateNo]);
  const result = stmt.getAsObject();
  stmt.free();

  if (result.length === 0) return null;
  return getEstimate(result[0].id);
}

function updateEstimate(estimateId, cart, options = {}) {
  const {
    billDiscount = 0,
    validUntil = null,
    notes = '',
    status = null
  } = options;

  const totals = calculateCartTotals(resolveEstimateCart(cart), billDiscount);

  return withTransaction((db) => {
    // Delete existing items
    db.run('DELETE FROM estimate_items WHERE estimate_id = ?', [estimateId]);

    // Insert new items
    const itemStmt = db.prepare(`
      INSERT INTO estimate_items (estimate_id, item_id, code, name, quantity, price, gst_percent,
        discount, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of totals.items) {
      itemStmt.run([
        estimateId,
        item.item_id,
        item.code,
        item.name,
        item.quantity,
        item.price,
        item.gst_percent,
        item.discount,
        item.line_total
      ]);
    }
    itemStmt.free();

    // Update estimate
    const now = new Date().toISOString();
    const updateStmt = db.prepare(`
      UPDATE estimates SET subtotal = ?, discount = ?, tax = ?, cgst = ?, sgst = ?, igst = ?,
        total = ?, valid_until = ?, notes = ?, updated_at = ?
        ${status ? ', status = ?' : ''}
      WHERE id = ?
    `);
    
    const params = [
      totals.subtotal,
      totals.discount,
      totals.tax,
      totals.cgst,
      totals.sgst,
      totals.igst,
      totals.total,
      validUntil,
      notes,
      now
    ];
    
    if (status) {
      params.push(status);
    }
    params.push(estimateId);
    
    updateStmt.run(params);
    updateStmt.free();

    return getEstimate(estimateId);
  });
}

function convertEstimateToInvoice(estimateId, options = {}) {
  const { paymentMethod = 'Cash', paid = null, userId = null } = options;
  
  return withTransaction((db) => {
    const estimate = getEstimate(estimateId);
    if (!estimate) {
      throw new Error('Estimate not found');
    }

    // Reconstruct cart from estimate items, enriched from the items table so
    // cost (purchase_price), mrp and stock are correct for COGS/stock checks
    const cart = {};
    for (const item of estimate.items) {
      const live = item.item_id ? execToObject('SELECT * FROM items WHERE id = ?', [item.item_id]) : null;
      cart[item.code] = {
        item_id: item.item_id,
        name: item.name,
        price: item.price,
        category: (live && live.category) || 'General',
        quantity: item.quantity,
        gst_percent: item.gst_percent,
        discount: item.discount,
        purchase_price: live ? parseFloat(live.purchase_price) || 0 : 0,
        mrp: live ? parseFloat(live.mrp) || 0 : 0,
        stock: live ? parseFloat(live.stock) || 0 : 0,
        unit: (live && live.unit) || 'pcs'
      };
    }

    // Create invoice using existing function
    const { completeSale } = require('./invoices');
    const invoice = completeSale(cart, {
      billDiscount: estimate.discount,
      paymentMethod,
      paid,
      partyId: estimate.party_id,
      partyName: estimate.party_name,
      partyPhone: estimate.party_phone,
      userId
    });

    // Update estimate status
    db.run("UPDATE estimates SET status = 'converted', updated_at = ? WHERE id = ?", [new Date().toISOString(), estimateId]);

    return { invoice, estimate };
  });
}

function deleteEstimate(estimateId) {
  return withTransaction((db) => {
    db.run('DELETE FROM estimate_items WHERE estimate_id = ?', [estimateId]);
    db.run('DELETE FROM estimates WHERE id = ?', [estimateId]);
  });
}

module.exports = {
  createEstimate,
  listEstimates,
  getEstimate,
  getEstimateByNo,
  updateEstimate,
  convertEstimateToInvoice,
  deleteEstimate
};