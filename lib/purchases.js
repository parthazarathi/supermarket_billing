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

    // Determine sale price: explicit sale > MRP (MRP is required)
    const rawMRP = line.mrp !== undefined && line.mrp !== null && !isNaN(parseFloat(line.mrp)) ? parseFloat(line.mrp) : null;
    if (rawMRP === null || rawMRP <= 0) {
      throw new Error(`MRP is required and must be greater than 0 for ${item.name}`);
    }
    if (rawMRP <= price) {
      throw new Error(`MRP must be higher than purchase price for ${item.name}`);
    }

    const rawSale = line.sale_price !== undefined && line.sale_price !== null && !isNaN(parseFloat(line.sale_price)) ? parseFloat(line.sale_price) : null;
    const sale = (rawSale !== null && rawSale > 0) ? rawSale : rawMRP;

    if (sale <= price) {
      throw new Error(`Sale price must be higher than purchase price for ${item.name}`);
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
      sale_price: sale,
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

      // Update item prices and GST
      const fields = ['purchase_price = ?'];
      const values = [line.price];
      const sale = parseFloat(line.sale_price);
      if (!isNaN(sale) && sale >= 0) {
        fields.push('sale_price = ?');
        values.push(sale);
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
