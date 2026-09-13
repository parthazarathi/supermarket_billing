const { getDatabase, withTransaction, execToObjects, execToObject } = require('./database');
const { generateNextNumber } = require('./cart');

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

  for (const item of items) {
    const lineTotal = (parseFloat(item.price) || 0) * (parseFloat(item.quantity) || 0);
    const itemTax = lineTotal * ((parseFloat(item.gst_percent) || 0) / 100);
    subtotal += lineTotal;
    tax += itemTax;
    total += lineTotal + itemTax;
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

    for (const item of items) {
      const lineTotal = (parseFloat(item.price) || 0) * (parseFloat(item.quantity) || 0);
      itemStmt.run([
        orderId,
        item.item_id,
        item.code,
        item.name,
        item.quantity,
        item.price,
        item.gst_percent || 0,
        lineTotal
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
    db.run(`UPDATE purchase_orders SET status = '${status}', updated_at = '${now}' WHERE id = ${orderId}`);
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

    // Reconstruct items from purchase order items
    const items = [];
    for (const item of purchaseOrder.items) {
      items.push({
        item_id: item.item_id,
        code: item.code,
        name: item.name,
        quantity: item.quantity,
        price: item.price,
        gst_percent: item.gst_percent
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
    db.run(`UPDATE purchase_orders SET status = 'received', updated_at = '${new Date().toISOString()}' WHERE id = ${orderId}`);

    return { purchase, purchaseOrder };
  });
}

function deletePurchaseOrder(orderId) {
  return withTransaction((db) => {
    db.run(`DELETE FROM purchase_order_items WHERE order_id = ${orderId}`);
    db.run(`DELETE FROM purchase_orders WHERE id = ${orderId}`);
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