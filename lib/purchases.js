const { getDatabase, withTransaction } = require('./database');
const { generateNextNumber } = require('./cart');
const { getItemByCode, getItem, adjustStock } = require('./items');

function completePurchase(lines, options = {}) {
  const {
    partyId = null,
    partyName = '',
    paid = null,
    userId = null
  } = options;

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

    const qty = parseFloat(line.quantity) || 0;
    const price = line.price !== undefined ? parseFloat(line.price) : parseFloat(item.purchase_price);
    const gst = line.gst_percent !== undefined ? parseFloat(line.gst_percent) : parseFloat(item.gst_percent);
    
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
      gst_percent: gst,
      line_total: lineTotal
    });
  }

  const total = Math.round((subtotal + tax) * 100) / 100;
  const paidAmount = paid === null ? total : parseFloat(paid);

  return withTransaction((db) => {
    const purchaseNo = generateNextNumber(db, 'purchases', 'purchase_no', 'PUR');

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

    // Insert purchase
    const purchaseStmt = db.prepare(`
      INSERT INTO purchases (purchase_no, party_id, party_name, subtotal, tax, total, paid, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    purchaseStmt.run([
      purchaseNo,
      partyId,
      partyName,
      Math.round(subtotal * 100) / 100,
      Math.round(tax * 100) / 100,
      total,
      paidAmount,
      userId,
      now
    ]);
    purchaseStmt.free();

    const purchaseId = db.prepare('SELECT last_insert_rowid() as id').getAsObject({})[0].id;

    // Insert purchase items and adjust stock
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

      // Update purchase price and sale price
      const updatePurStmt = db.prepare('UPDATE items SET purchase_price = ?, updated_at = ? WHERE id = ?');
      updatePurStmt.run([line.price, now, line.item_id]);
      updatePurStmt.free();

      if (line.sale_price !== undefined && !isNaN(parseFloat(line.sale_price)) && parseFloat(line.sale_price) >= 0) {
        const updateSaleStmt = db.prepare('UPDATE items SET sale_price = ?, updated_at = ? WHERE id = ?');
        updateSaleStmt.run([parseFloat(line.sale_price), now, line.item_id]);
        updateSaleStmt.free();
      }
    }
    itemStmt.free();

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

function listPurchases(limit = 200) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM purchases ORDER BY id DESC LIMIT ?');
  stmt.bind([limit]);
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

module.exports = {
  completePurchase,
  listPurchases,
  getPurchase
};
