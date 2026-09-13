const { withTransaction } = require('./database');
const { generateNextNumber } = require('./cart');
const { adjustStock } = require('./items');
const { q, qOne } = require('./reportUtils');

// Create a return-to-supplier for items on an existing purchase.
function createPurchaseReturn(purchaseId, items, userId = null, reason = '') {
  if (!items || items.length === 0) {
    throw new Error('Return items required');
  }

  return withTransaction((db) => {
    const purchase = qOne('SELECT * FROM purchases WHERE id = ?', [purchaseId]);
    if (!purchase) throw new Error('Purchase not found');

    let total = 0;
    const returnNo = generateNextNumber(db, 'purchase_returns', 'return_no', 'PRET');
    const now = new Date().toISOString();

    const returnStmt = db.prepare(
      'INSERT INTO purchase_returns (purchase_id, return_no, party_id, total, reason, user_id, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)'
    );
    returnStmt.run([purchaseId, returnNo, purchase.party_id, reason || '', userId, now]);
    returnStmt.free();

    const returnId = qOne('SELECT last_insert_rowid() as id').id;

    const itemStmt = db.prepare(`
      INSERT INTO purchase_return_items (return_id, purchase_item_id, item_id, quantity, amount)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const entry of items) {
      const line = qOne('SELECT * FROM purchase_items WHERE id = ? AND purchase_id = ?', [entry.purchase_item_id, purchaseId]);
      if (!line) throw new Error('Purchase line not found');

      const qty = parseFloat(entry.quantity);
      if (!isFinite(qty) || qty <= 0) {
        throw new Error('Invalid return quantity');
      }

      const already = qOne(
        `SELECT COALESCE(SUM(pri.quantity), 0) as returned
         FROM purchase_return_items pri
         JOIN purchase_returns pr ON pri.return_id = pr.id
         WHERE pri.purchase_item_id = ?`,
        [line.id]
      );
      const alreadyReturned = already ? already.returned : 0;

      if (qty + alreadyReturned > parseFloat(line.quantity) + 1e-9) {
        throw new Error(`Cannot return more than purchased for ${line.name}`);
      }

      const unit = parseFloat(line.line_total) / (parseFloat(line.quantity) || 1);
      const amount = Math.round(unit * qty * 100) / 100;
      total += amount;

      itemStmt.run([returnId, line.id, line.item_id, qty, amount]);

      if (line.item_id) {
        const item = qOne('SELECT stock FROM items WHERE id = ?', [line.item_id]);
        const current = item ? parseFloat(item.stock) : 0;
        if (current - qty < -1e-9) {
          throw new Error(`Not enough stock to return ${line.name}`);
        }
        adjustStock(db, line.item_id, -qty);
      }
    }
    itemStmt.free();

    total = Math.round(total * 100) / 100;

    // Split the return value: the part still owed to the supplier becomes
    // account credit, the rest is money received back now.
    const due = Math.max(0, (parseFloat(purchase.total) || 0) - (parseFloat(purchase.paid) || 0));
    const credit = Math.min(total, due);
    const refund = Math.round((total - credit) * 100) / 100;

    db.run('UPDATE purchase_returns SET total = ?, refund_amount = ? WHERE id = ?', [total, refund, returnId]);

    if (refund > 1e-9) {
      const refundStmt = db.prepare("INSERT INTO payments (party_id, amount, method, note, direction, ref_type, ref_id, created_at, user_id) VALUES (?, ?, 'Cash', ?, 'in', 'purchase_return', ?, ?, ?)");
      refundStmt.run([
        purchase.party_id,
        refund,
        `Refund ${returnNo}`,
        returnId,
        now,
        userId
      ]);
      refundStmt.free();
    }

    return getPurchaseReturn(returnId);
  });
}

function getPurchaseReturn(returnId) {
  const result = qOne('SELECT * FROM purchase_returns WHERE id = ?', [returnId]);
  if (!result) return null;
  result.items = q('SELECT * FROM purchase_return_items WHERE return_id = ?', [returnId]);
  return result;
}

function listPurchaseReturns(limit = 200) {
  return q(`
    SELECT pr.*, p.purchase_no, p.party_name, u.username
    FROM purchase_returns pr
    LEFT JOIN purchases p ON pr.purchase_id = p.id
    LEFT JOIN users u ON pr.user_id = u.id
    ORDER BY pr.id DESC LIMIT ?
  `, [limit]);
}

module.exports = {
  createPurchaseReturn,
  getPurchaseReturn,
  listPurchaseReturns
};
