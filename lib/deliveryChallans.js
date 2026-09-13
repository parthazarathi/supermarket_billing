const { getDatabase, withTransaction, execToObjects, execToObject } = require('./database');
const { generateNextNumber } = require('./cart');
const { getItemByCode, getItem } = require('./items');

// Resolve a document line against the items table - client-sent names/codes
// are never trusted, and quantities/prices are validated server-side.
function resolveDocLines(items, notFoundMessage, priceGtZero) {
  const prepared = [];
  for (const line of items) {
    let item = null;
    if (line.code !== undefined && line.code !== null && String(line.code).trim() !== '') {
      item = getItemByCode(String(line.code));
    }
    if (!item && line.item_id) {
      item = getItem(line.item_id);
    }
    if (!item) {
      throw new Error(notFoundMessage);
    }

    const qty = parseFloat(line.quantity);
    if (!isFinite(qty) || qty <= 0) {
      throw new Error(`Invalid quantity for ${item.name}`);
    }
    const hasPrice = line.price !== undefined && line.price !== null && line.price !== '';
    const price = hasPrice ? parseFloat(line.price) : parseFloat(item.sale_price);
    if (!isFinite(price) || price < 0 || (priceGtZero && price <= 0)) {
      throw new Error(`Invalid price for ${item.name}`);
    }

    prepared.push({
      item_id: item.id,
      code: item.code,
      name: item.name,
      quantity: qty,
      price: price,
      line_total: Math.round(price * qty * 100) / 100
    });
  }
  return prepared;
}

function createDeliveryChallan(items, options = {}) {
  const {
    partyId = null,
    invoiceId = null,
    notes = '',
    userId = null
  } = options;
  let partyName = options.partyName || '';
  let partyAddress = options.partyAddress || '';

  if (!items || items.length === 0) {
    throw new Error('Items are required');
  }

  const prepared = resolveDocLines(items, 'Unknown item in challan', false);
  let subtotal = 0;
  let total = 0;

  for (const item of prepared) {
    subtotal += item.line_total;
    total += item.line_total;
  }

  return withTransaction((db) => {
    const challanNo = generateNextNumber(db, 'delivery_challans', 'challan_no', 'DC');
    
    // Get party details if partyId is provided
    if (partyId) {
      const partyStmt = db.prepare('SELECT * FROM parties WHERE id = ?');
      partyStmt.bind([partyId]);
      const party = partyStmt.getAsObject({})[0];
      partyStmt.free();
      
      if (party) {
        partyName = party.name;
        partyAddress = party.address || partyAddress;
      }
    }

    const now = new Date().toISOString();
    
    // Insert delivery challan
    const challanStmt = db.prepare(`
      INSERT INTO delivery_challans (challan_no, party_id, party_name, party_address, invoice_id,
        subtotal, total, notes, status, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    challanStmt.run([
      challanNo,
      partyId,
      partyName,
      partyAddress,
      invoiceId,
      subtotal,
      total,
      notes,
      'pending',
      userId,
      now,
      now
    ]);
    challanStmt.free();

    const challanId = db.prepare('SELECT last_insert_rowid() as id').getAsObject({})[0].id;

    // Insert challan items
    const itemStmt = db.prepare(`
      INSERT INTO challan_items (challan_id, item_id, code, name, quantity, price, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of prepared) {
      itemStmt.run([
        challanId,
        item.item_id,
        item.code,
        item.name,
        item.quantity,
        item.price,
        item.line_total
      ]);
    }
    itemStmt.free();

    // Get complete challan with items
    const dcStmt = db.prepare('SELECT * FROM delivery_challans WHERE id = ?');
    dcStmt.bind([challanId]);
    const challan = dcStmt.getAsObject({})[0];
    dcStmt.free();

    const linesStmt = db.prepare('SELECT * FROM challan_items WHERE challan_id = ?');
    linesStmt.bind([challanId]);
    const lines = [];
    while (linesStmt.step()) {
      lines.push(linesStmt.getAsObject());
    }
    linesStmt.free();

    challan.items = lines;
    return challan;
  });
}

function listDeliveryChallans(limit = 200) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM delivery_challans ORDER BY id DESC LIMIT ?');
  stmt.bind([limit]);
  const challans = [];
  
  while (stmt.step()) {
    challans.push(stmt.getAsObject());
  }
  stmt.free();
  return challans;
}

function getDeliveryChallan(challanId) {
  const db = getDatabase();
  const dcStmt = db.prepare('SELECT * FROM delivery_challans WHERE id = ?');
  dcStmt.bind([challanId]);
  const dcResult = dcStmt.getAsObject();
  dcStmt.free();

  if (dcResult.length === 0) return null;

  const challan = dcResult[0];

  const itemsStmt = db.prepare('SELECT * FROM challan_items WHERE challan_id = ?');
  itemsStmt.bind([challanId]);
  challan.items = [];
  while (itemsStmt.step()) {
    challan.items.push(itemsStmt.getAsObject());
  }
  itemsStmt.free();

  return challan;
}

function getDeliveryChallanByNo(challanNo) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM delivery_challans WHERE challan_no = ?');
  stmt.bind([challanNo]);
  const result = stmt.getAsObject();
  stmt.free();

  if (result.length === 0) return null;
  return getDeliveryChallan(result[0].id);
}

function updateDeliveryChallanStatus(challanId, status) {
  const validStatuses = ['pending', 'delivered', 'cancelled'];
  if (!validStatuses.includes(status)) {
    throw new Error('Invalid status');
  }

  return withTransaction((db) => {
    const now = new Date().toISOString();
    db.run('UPDATE delivery_challans SET status = ?, updated_at = ? WHERE id = ?', [status, now, challanId]);
    return getDeliveryChallan(challanId);
  });
}

function linkChallanToInvoice(challanId, invoiceId) {
  return withTransaction((db) => {
    db.run('UPDATE delivery_challans SET invoice_id = ?, updated_at = ? WHERE id = ?', [invoiceId, new Date().toISOString(), challanId]);
    return getDeliveryChallan(challanId);
  });
}

function deleteDeliveryChallan(challanId) {
  return withTransaction((db) => {
    db.run('DELETE FROM challan_items WHERE challan_id = ?', [challanId]);
    db.run('DELETE FROM delivery_challans WHERE id = ?', [challanId]);
  });
}

module.exports = {
  createDeliveryChallan,
  listDeliveryChallans,
  getDeliveryChallan,
  getDeliveryChallanByNo,
  updateDeliveryChallanStatus,
  linkChallanToInvoice,
  deleteDeliveryChallan
};