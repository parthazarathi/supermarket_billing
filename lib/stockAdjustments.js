const { withTransaction } = require('./database');
const { q, qOne } = require('./reportUtils');

const VALID_TYPES = ['adjustment', 'damage', 'wastage'];

// Record a stock change outside of purchase/sale flows.
// change > 0 adds stock, change < 0 removes stock.
function createStockAdjustment(data = {}) {
  const itemId = parseInt(data.item_id, 10);
  const change = parseFloat(data.change);
  const type = VALID_TYPES.includes(data.type) ? data.type : 'adjustment';
  const reason = String(data.reason || '').trim();
  const userId = data.userId || null;

  if (!itemId) throw new Error('Item is required');
  if (!isFinite(change) || change === 0) throw new Error('Adjustment quantity cannot be zero');
  if (type !== 'adjustment' && change > 0) {
    throw new Error('Damage and wastage reduce stock - enter a negative quantity');
  }

  return withTransaction((db) => {
    const item = qOne('SELECT * FROM items WHERE id = ?', [itemId]);
    if (!item) throw new Error('Item not found');

    const oldQty = parseFloat(item.stock) || 0;
    const newQty = oldQty + change;
    if (newQty < 0) throw new Error('Stock cannot go below zero');

    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO stock_adjustments (item_id, type, old_qty, change, new_qty, reason, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run([itemId, type, oldQty, change, newQty, reason, userId, now]);
    stmt.free();

    db.run('UPDATE items SET stock = ?, updated_at = ? WHERE id = ?', [newQty, now, itemId]);

    return qOne(`
      SELECT a.*, i.name as item_name, i.code as item_code, u.username
      FROM stock_adjustments a
      LEFT JOIN items i ON a.item_id = i.id
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.id = last_insert_rowid()
    `);
  });
}

function listStockAdjustments(filters = {}, limit = 500) {
  let where = ' WHERE 1=1';
  const params = [];
  if (filters.start && filters.end) {
    where += ' AND a.created_at >= ? AND a.created_at <= ?';
    params.push(filters.start, filters.end);
  }
  if (filters.type) {
    where += ' AND a.type = ?';
    params.push(filters.type);
  }
  if (filters.itemId) {
    where += ' AND a.item_id = ?';
    params.push(filters.itemId);
  }
  if (filters.userId) {
    where += ' AND a.user_id = ?';
    params.push(filters.userId);
  }
  return q(`
    SELECT a.*, i.name as item_name, i.code as item_code, i.purchase_price, u.username
    FROM stock_adjustments a
    LEFT JOIN items i ON a.item_id = i.id
    LEFT JOIN users u ON a.user_id = u.id
    ${where}
    ORDER BY a.id DESC
    LIMIT ?
  `, [...params, limit]);
}

module.exports = {
  createStockAdjustment,
  listStockAdjustments,
  VALID_TYPES
};
