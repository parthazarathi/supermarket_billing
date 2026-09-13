const { q, qOne, r2, pagedQuery, likeParam, roundRows, todayLocal } = require('../reportUtils');
const { purchaseAggregates } = require('./common');

function summary(range) {
  return { summary: purchaseAggregates(range) };
}

function supplierWise(range) {
  const rows = q(`
    SELECT COALESCE(p.party_id, 0) as party_id,
      COALESCE(NULLIF(p.party_name, ''), 'No supplier') as supplier,
      COUNT(*) as invoices,
      COALESCE(SUM(p.total), 0) as amount,
      COALESCE(SUM(p.paid), 0) as paid,
      COALESCE(SUM(p.total - p.paid), 0) as outstanding
    FROM purchases p
    WHERE p.created_at >= ? AND p.created_at <= ?
    GROUP BY party_id, supplier ORDER BY amount DESC
  `, [range.start, range.end]);

  const retRows = q(`
    SELECT COALESCE(pr.party_id, 0) as party_id, COALESCE(SUM(pr.total), 0) as returns
    FROM purchase_returns pr
    WHERE pr.created_at >= ? AND pr.created_at <= ?
    GROUP BY pr.party_id
  `, [range.start, range.end]);
  const retMap = {};
  retRows.forEach(r => { retMap[r.party_id] = r.returns; });

  return {
    rows: rows.map(r => ({
      supplier: r.supplier,
      invoices: r.invoices,
      amount: r2(r.amount),
      returns: r2(retMap[r.party_id] || 0),
      paid: r2(r.paid),
      outstanding: r2(r.outstanding)
    }))
  };
}

function itemWise(range) {
  const rows = q(`
    SELECT pi.item_id, pi.name, pi.code,
      SUM(pi.quantity) as qty,
      SUM(pi.quantity * pi.price) as amount,
      CASE WHEN SUM(pi.quantity) > 0 THEN SUM(pi.quantity * pi.price) / SUM(pi.quantity) ELSE 0 END as avg_cost,
      MAX(pi.price) as last_price
    FROM purchase_items pi
    JOIN purchases p ON pi.purchase_id = p.id
    WHERE p.created_at >= ? AND p.created_at <= ?
    GROUP BY pi.item_id, pi.name ORDER BY amount DESC
  `, [range.start, range.end]);

  // Last purchase price = price on the most recent purchase line
  const lastPrice = {};
  q(`
    SELECT pi.item_id, pi.price FROM purchase_items pi
    JOIN purchases p ON pi.purchase_id = p.id
    ORDER BY p.created_at DESC, pi.id DESC
  `).forEach(r => { if (!(r.item_id in lastPrice)) lastPrice[r.item_id] = r.price; });

  return {
    rows: rows.map(r => ({
      item: r.name,
      code: r.code,
      qty: r2(r.qty),
      amount: r2(r.amount),
      avg_cost: r2(r.avg_cost),
      last_price: r2(lastPrice[r.item_id] !== undefined ? lastPrice[r.item_id] : r.last_price)
    }))
  };
}

function invoices(range, query) {
  const params = [range.start, range.end];
  let where = ' WHERE p.created_at >= ? AND p.created_at <= ?';
  if (query.q) {
    where += ' AND (p.purchase_no LIKE ? OR p.party_name LIKE ?)';
    params.push(likeParam(query.q), likeParam(query.q));
  }
  const base = `FROM purchases p LEFT JOIN users u ON p.user_id = u.id${where}`;
  const result = pagedQuery(
    `SELECT COUNT(*) as total ${base}`,
    `SELECT p.id, p.purchase_no, p.created_at, p.party_name as supplier,
      p.subtotal, COALESCE(p.discount, 0) as discount, p.tax, p.total, p.paid,
      (p.total - p.paid) as balance,
      CASE WHEN p.paid >= p.total - 0.009 THEN 'paid' WHEN p.paid > 0 THEN 'partial' ELSE 'unpaid' END as status,
      COALESCE(u.username, '') as entered_by
      ${base} ORDER BY p.id DESC`,
    params, query
  );
  return result;
}

function returnsReport(range, query) {
  const params = [range.start, range.end];
  const base = `FROM purchase_return_items pri
    JOIN purchase_returns pr ON pri.return_id = pr.id
    JOIN purchases p ON pr.purchase_id = p.id
    LEFT JOIN purchase_items pi ON pri.purchase_item_id = pi.id
    LEFT JOIN users u ON pr.user_id = u.id
    WHERE pr.created_at >= ? AND pr.created_at <= ?`;
  return pagedQuery(
    `SELECT COUNT(*) as total ${base}`,
    `SELECT pr.return_no, p.purchase_no, pr.created_at,
      COALESCE(p.party_name, '') as supplier, COALESCE(pi.name, '') as item,
      pri.quantity, pri.amount, COALESCE(pr.reason, '') as reason,
      COALESCE(u.username, '') as processed_by
      ${base} ORDER BY pr.id DESC, pri.id`,
    params, query
  );
}

// Payments made to suppliers (direction = 'out')
function payments(range, query) {
  const params = [range.start, range.end];
  const base = `FROM payments pay
    JOIN parties pt ON pay.party_id = pt.id
    LEFT JOIN users u ON pay.user_id = u.id
    WHERE pay.created_at >= ? AND pay.created_at <= ? AND pt.type = 'supplier'`;
  return pagedQuery(
    `SELECT COUNT(*) as total ${base}`,
    `SELECT pay.id, pay.created_at, pt.name as supplier, pay.method,
      pay.amount, pay.note, COALESCE(u.username, '') as entered_by
      ${base} ORDER BY pay.id DESC`,
    params, query
  );
}

function pendingPayments() {
  const today = todayLocal();
  const rows = q(`
    SELECT p.purchase_no, p.created_at, COALESCE(p.party_name, 'No supplier') as supplier,
      p.total, p.paid, (p.total - p.paid) as balance,
      CAST(julianday('${today}') - julianday(date(p.created_at, 'localtime')) AS INTEGER) as age
    FROM purchases p
    WHERE p.total > p.paid + 0.009
    ORDER BY age DESC, p.created_at
  `);
  return { rows: roundRows(rows) };
}

function priceHistory(itemId) {
  const item = qOne('SELECT id, name, code FROM items WHERE id = ?', [itemId]);
  if (!item) throw new Error('Item not found');
  const rows = q(`
    SELECT p.created_at, p.purchase_no, COALESCE(p.party_name, '') as supplier,
      pi.quantity, pi.price
    FROM purchase_items pi JOIN purchases p ON pi.purchase_id = p.id
    WHERE pi.item_id = ? ORDER BY p.created_at ASC, pi.id ASC
  `, [itemId]);
  let prev = null;
  return {
    item,
    rows: rows.map(r => {
      const price = parseFloat(r.price) || 0;
      const diff = prev === null ? 0 : price - prev;
      const out = {
        date: r.created_at,
        supplier: r.supplier,
        purchase_no: r.purchase_no,
        qty: r2(r.quantity),
        price: r2(price),
        prev_price: prev === null ? null : r2(prev),
        difference: prev === null ? null : r2(diff)
      };
      prev = price;
      return out;
    }).reverse()
  };
}

module.exports = {
  summary,
  supplierWise,
  itemWise,
  invoices,
  returnsReport,
  payments,
  pendingPayments,
  priceHistory
};
