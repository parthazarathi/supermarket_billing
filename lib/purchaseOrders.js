const { getDatabase, withTransaction } = require('./database');
const { generateNextNumber } = require('./cart');
const { getItemByCode, getItem } = require('./items');

// Resolve a document line against the items table. Client-sent names/codes
// are never trusted - the catalogue row is authoritative.
function resolveDocItem(line, notFoundMessage) {
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
  return item;
}

function createPurchaseOrder(items, options = {}) {
  const {
    partyId = null,
    expectedDate = null,
    notes = '',
    userId = null
  } = options;
  let partyName = options.partyName || '';

  if (!items || items.length === 0) {
    throw new Error('Items are required');
  }

  let subtotal = 0;
  let tax = 0;
  let total = 0;
  const prepared = [];

  for (const line of items) {
    const item = resolveDocItem(line, 'Unknown item in order');

    const qty = parseFloat(line.quantity);
    if (!isFinite(qty) || qty <= 0) {
      throw new Error(`Invalid quantity for ${item.name}`);
    }

    const hasPrice = line.price !== undefined && line.price !== null && line.price !== '';
    const price = hasPrice ? parseFloat(line.price) : parseFloat(item.purchase_price);
    if (!isFinite(price) || price <= 0) {
      throw new Error(`Invalid price for ${item.name}`);
    }

    const gstRaw = line.gst_percent !== undefined && line.gst_percent !== null && line.gst_percent !== '' ? parseFloat(line.gst_percent) : NaN;
    const gst = isFinite(gstRaw) ? gstRaw : (parseFloat(item.gst_percent) || 0);

    const lineTotal = Math.round(price * qty * 100) / 100;
    const itemTax = Math.round(lineTotal * gst / 100 * 100) / 100;
    subtotal += lineTotal;
    tax += itemTax;
    total += lineTotal + itemTax;

    prepared.push({
      item_id: item.id,
      code: item.code,
      name: item.name,
      quantity: qty,
      price: price,
      gst_percent: gst,
      line_total: lineTotal
    });
  }

  return withTransaction((db) => {
    const orderNo = generateNextNumber(db, 'purchase_orders', 'order_no', 'PO');
    
    // Get party details if partyId is provided
    if (partyId) {
      const partyStmt = db.prepare('SELECT * FROM parties WHERE id = ?');
      partyStmt.bind([partyId]);
      const party = partyStmt.getAsObject({})[0];
      partyStmt.free();
      
      if (party) {
        partyName = party.name;
      }
    }

    const now = new Date().toISOString();
    const expected = expectedDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    
    // Insert purchase order
    const poStmt = db.prepare(`
      INSERT INTO purchase_orders (order_no, party_id, party_name, subtotal, tax, total,
        expected_date, notes, status, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    poStmt.run([
      orderNo,
      partyId,
      partyName,
      subtotal,
      tax,
      total,
      expected,
      notes,
      'pending',
      userId,
      now,
      now
    ]);
    poStmt.free();

    const orderId = db.prepare('SELECT last_insert_rowid() as id').getAsObject({})[0].id;

    // Insert purchase order items
    const itemStmt = db.prepare(`
      INSERT INTO purchase_order_items (order_id, item_id, code, name, quantity, price, gst_percent, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of prepared) {
      itemStmt.run([
        orderId,
        item.item_id,
        item.code,
        item.name,
        item.quantity,
        item.price,
        item.gst_percent,
        item.line_total
      ]);
    }
    itemStmt.free();

    // Get complete purchase order with items
    const poStmt2 = db.prepare('SELECT * FROM purchase_orders WHERE id = ?');
    poStmt2.bind([orderId]);
    const purchaseOrder = poStmt2.getAsObject({})[0];
    poStmt2.free();

    const linesStmt = db.prepare('SELECT * FROM purchase_order_items WHERE order_id = ?');
    linesStmt.bind([orderId]);
    const lines = [];
    while (linesStmt.step()) {
      lines.push(linesStmt.getAsObject());
    }
    linesStmt.free();

    purchaseOrder.items = lines;
    return purchaseOrder;
  });
}

function listPurchaseOrders(limit = 200) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM purchase_orders ORDER BY id DESC LIMIT ?');
  stmt.bind([limit]);
  const orders = [];
  
  while (stmt.step()) {
    orders.push(stmt.getAsObject());
  }
  stmt.free();
  return orders;
}

function getPurchaseOrder(orderId) {
  const db = getDatabase();
  const poStmt = db.prepare('SELECT * FROM purchase_orders WHERE id = ?');
  poStmt.bind([orderId]);
  const poResult = poStmt.getAsObject();
  poStmt.free();

  if (poResult.length === 0) return null;

  const purchaseOrder = poResult[0];

  const itemsStmt = db.prepare('SELECT * FROM purchase_order_items WHERE order_id = ?');
  itemsStmt.bind([orderId]);
  purchaseOrder.items = [];
  while (itemsStmt.step()) {
    purchaseOrder.items.push(itemsStmt.getAsObject());
  }
  itemsStmt.free();

  return purchaseOrder;
}

function getPurchaseOrderByNo(orderNo) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM purchase_orders WHERE order_no = ?');
  stmt.bind([orderNo]);
  const result = stmt.getAsObject();
  stmt.free();

  if (result.length === 0) return null;
  return getPurchaseOrder(result[0].id);
}

function updatePurchaseOrderStatus(orderId, status) {
  const validStatuses = ['pending', 'ordered', 'received', 'cancelled'];
  if (!validStatuses.includes(status)) {
    throw new Error('Invalid status');
  }

  return withTransaction((db) => {
    const now = new Date().toISOString();
    db.run('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?', [status, now, orderId]);
    return getPurchaseOrder(orderId);
  });
}

function convertPurchaseOrderToPurchase(orderId, options = {}) {
  const { userId = null } = options;
  
  return withTransaction((db) => {
    const purchaseOrder = getPurchaseOrder(orderId);
    if (!purchaseOrder) {
      throw new Error('Purchase order not found');
    }

    // Reconstruct items from purchase order items; purchase validation
    // requires MRP/sale fields, so pull them from the current catalogue.
    const items = [];
    for (const line of purchaseOrder.items) {
      let catalogue = null;
      if (line.code) {
        catalogue = getItemByCode(String(line.code));
      }
      if (!catalogue && line.item_id) {
        catalogue = getItem(line.item_id);
      }
      items.push({
        item_id: line.item_id,
        code: line.code,
        quantity: line.quantity,
        price: line.price,
        gst_percent: line.gst_percent,
        mrp: catalogue ? catalogue.mrp : undefined,
        sale_price: catalogue ? catalogue.sale_price : undefined
      });
    }

    // Create purchase using existing function
    const { completePurchase } = require('./purchases');
    const purchase = completePurchase(items, {
      partyId: purchaseOrder.party_id,
      partyName: purchaseOrder.party_name,
      userId
    });

    // Update purchase order status
    db.run("UPDATE purchase_orders SET status = 'received', updated_at = ? WHERE id = ?", [new Date().toISOString(), orderId]);

    return { purchase, purchaseOrder };
  });
}

function deletePurchaseOrder(orderId) {
  return withTransaction((db) => {
    db.run('DELETE FROM purchase_order_items WHERE order_id = ?', [orderId]);
    db.run('DELETE FROM purchase_orders WHERE id = ?', [orderId]);
  });
}

module.exports = {
  createPurchaseOrder,
  listPurchaseOrders,
  getPurchaseOrder,
  getPurchaseOrderByNo,
  updatePurchaseOrderStatus,
  convertPurchaseOrderToPurchase,
  deletePurchaseOrder
};