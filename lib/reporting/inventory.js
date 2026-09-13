const { q, qOne, r2, roundRows, likeParam } = require('../reportUtils');
const { listStockAdjustments } = require('../stockAdjustments');

function stockStatus(stock, lowStock) {
  if (stock <= 0) return 'Out of stock';
  if (stock <= lowStock) return 'Low';
  return 'OK';
}

function currentStock(query) {
  const params = [];
  let where = ' WHERE 1=1';
  if (query.q) {
    where += " AND (i.name LIKE ? ESCAPE '\\' OR i.code LIKE ? ESCAPE '\\')";
    params.push(likeParam(query.q), likeParam(query.q));
  }
  if (query.category) {
    where += ' AND i.category = ?';
    params.push(query.category);
  }
  const rows = q(`
    SELECT i.id, i.code, i.name, i.category, i.unit, i.purchase_price, i.sale_price,
      i.stock, i.low_stock, i.stock * i.purchase_price as stock_value
    FROM items i${where} ORDER BY i.name
  `, params);
  return {
    rows: rows.map(r => ({
      ...r,
      stock: r2(r.stock),
      stock_value: r2(r.stock_value),
      status: stockStatus(parseFloat(r.stock) || 0, parseFloat(r.low_stock) || 0)
    })),
    summary: stockTotals()
  };
}

function stockTotals() {
  const t = qOne(`
    SELECT COUNT(*) as items,
      COALESCE(SUM(stock), 0) as qty,
      COALESCE(SUM(stock * purchase_price), 0) as cost_value,
      COALESCE(SUM(stock * sale_price), 0) as sale_value
    FROM items
  `);
  return {
    items: t.items || 0,
    qty: r2(t.qty),
    cost_value: r2(t.cost_value),
    sale_value: r2(t.sale_value),
    potential_profit: r2(parseFloat(t.sale_value) - parseFloat(t.cost_value))
  };
}

function lowStock() {
  const rows = q(`
    SELECT i.id, i.code, i.name, i.category, i.unit, i.purchase_price, i.sale_price,
      i.stock, i.low_stock, i.stock * i.purchase_price as stock_value
    FROM items i WHERE i.stock <= i.low_stock AND i.stock > 0 ORDER BY i.stock ASC
  `);
  return { rows: rows.map(r => ({ ...r, stock: r2(r.stock), stock_value: r2(r.stock_value), status: 'Low' })) };
}

function outOfStock() {
  const rows = q(`
    SELECT i.id, i.code, i.name, i.category, i.unit, i.purchase_price, i.sale_price,
      i.stock, i.low_stock, 0 as stock_value
    FROM items i WHERE i.stock <= 0 ORDER BY i.name
  `);
  return { rows: rows.map(r => ({ ...r, stock: r2(r.stock), status: 'Out of stock' })) };
}

function valuation() {
  const rows = q(`
    SELECT i.id, i.code, i.name, i.category, i.stock, i.purchase_price, i.sale_price,
      i.stock * i.purchase_price as cost_value,
      i.stock * i.sale_price as sale_value,
      i.stock * (i.sale_price - i.purchase_price) as profit
    FROM items i ORDER BY cost_value DESC
  `);
  return { rows: roundRows(rows), summary: stockTotals() };
}

// All stock movement events for an item, oldest first, with running balance.
function stockLedger(itemId, range) {
  const item = qOne('SELECT * FROM items WHERE id = ?', [itemId]);
  if (!item) throw new Error('Item not found');

  const events = [];

  q(`
    SELECT p.created_at, p.purchase_no as ref, pi.quantity as qty, pi.price as rate
    FROM purchase_items pi JOIN purchases p ON pi.purchase_id = p.id
    WHERE pi.item_id = ?
  `, [itemId]).forEach(r => events.push({ date: r.created_at, type: 'Purchase', ref: r.ref, in: r.qty, out: 0 }));

  q(`
    SELECT i.created_at, i.invoice_no as ref, ii.quantity as qty, ii.price as rate
    FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.id
    WHERE ii.item_id = ? AND i.status <> 'cancelled'
  `, [itemId]).forEach(r => events.push({ date: r.created_at, type: 'Sale', ref: r.ref, in: 0, out: r.qty }));

  q(`
    SELECT sr.created_at, sr.return_no as ref, sri.quantity as qty
    FROM sale_return_items sri JOIN sale_returns sr ON sri.return_id = sr.id
    WHERE sri.item_id = ?
  `, [itemId]).forEach(r => events.push({ date: r.created_at, type: 'Sales Return', ref: r.ref, in: r.qty, out: 0 }));

  q(`
    SELECT pr.created_at, pr.return_no as ref, pri.quantity as qty
    FROM purchase_return_items pri JOIN purchase_returns pr ON pri.return_id = pr.id
    WHERE pri.item_id = ?
  `, [itemId]).forEach(r => events.push({ date: r.created_at, type: 'Purchase Return', ref: r.ref, in: 0, out: r.qty }));

  q(`
    SELECT a.created_at, a.id, a.type, a.change, a.reason
    FROM stock_adjustments a WHERE a.item_id = ?
  `, [itemId]).forEach(r => events.push({
    date: r.created_at,
    type: r.type === 'damage' ? 'Damage' : r.type === 'wastage' ? 'Wastage' : 'Adjustment',
    ref: `ADJ-${r.id}`,
    in: r.change > 0 ? r.change : 0,
    out: r.change < 0 ? -r.change : 0,
    note: r.reason
  }));

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const currentStock = parseFloat(item.stock) || 0;
  const totalDelta = events.reduce((s, e) => s + e.in - e.out, 0);
  const initialStock = currentStock - totalDelta;

  // Opening balance = stock held just before the range start
  const deltaBefore = events
    .filter(e => e.date < range.start)
    .reduce((s, e) => s + e.in - e.out, 0);
  let balance = initialStock + deltaBefore;

  const rows = events
    .filter(e => e.date >= range.start && e.date <= range.end)
    .map(e => {
      const opening = balance;
      balance += e.in - e.out;
      return {
        date: e.date,
        type: e.type,
        ref: e.ref,
        opening: r2(opening),
        stock_in: r2(e.in),
        stock_out: r2(e.out),
        closing: r2(balance),
        note: e.note || ''
      };
    });

  return {
    item: { id: item.id, name: item.name, code: item.code, unit: item.unit, stock: r2(currentStock) },
    opening: r2(initialStock + deltaBefore),
    rows
  };
}

// Per-item movement totals inside the range plus opening/closing balances.
function stockMovement(range) {
  const items = q('SELECT id, code, name, category, unit, stock FROM items ORDER BY name');

  const purchased = {};
  q(`
    SELECT pi.item_id, SUM(pi.quantity) as qty FROM purchase_items pi
    JOIN purchases p ON pi.purchase_id = p.id
    WHERE p.created_at >= ? AND p.created_at <= ? GROUP BY pi.item_id
  `, [range.start, range.end]).forEach(r => { purchased[r.item_id] = r.qty; });

  const sold = {};
  q(`
    SELECT ii.item_id, SUM(ii.quantity) as qty FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY ii.item_id
  `, [range.start, range.end]).forEach(r => { sold[r.item_id] = r.qty; });

  const saleRet = {};
  q(`
    SELECT sri.item_id, SUM(sri.quantity) as qty FROM sale_return_items sri
    JOIN sale_returns sr ON sri.return_id = sr.id
    WHERE sr.created_at >= ? AND sr.created_at <= ? GROUP BY sri.item_id
  `, [range.start, range.end]).forEach(r => { saleRet[r.item_id] = r.qty; });

  const purRet = {};
  q(`
    SELECT pri.item_id, SUM(pri.quantity) as qty FROM purchase_return_items pri
    JOIN purchase_returns pr ON pri.return_id = pr.id
    WHERE pr.created_at >= ? AND pr.created_at <= ? GROUP BY pri.item_id
  `, [range.start, range.end]).forEach(r => { purRet[r.item_id] = r.qty; });

  const adjIn = {};
  const adjOut = {};
  q(`
    SELECT item_id, SUM(CASE WHEN change > 0 THEN change ELSE 0 END) as ain,
      SUM(CASE WHEN change < 0 THEN -change ELSE 0 END) as aout
    FROM stock_adjustments
    WHERE created_at >= ? AND created_at <= ? GROUP BY item_id
  `, [range.start, range.end]).forEach(r => { adjIn[r.item_id] = r.ain; adjOut[r.item_id] = r.aout; });

  // Net movement before the range (for opening balance)
  const before = {};
  const addDelta = (itemId, delta) => { before[itemId] = (before[itemId] || 0) + delta; };
  q(`SELECT pi.item_id, pi.quantity as qty, p.created_at FROM purchase_items pi JOIN purchases p ON pi.purchase_id = p.id WHERE p.created_at < ?`, [range.start])
    .forEach(r => addDelta(r.item_id, r.qty));
  q(`SELECT ii.item_id, ii.quantity as qty FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.id WHERE i.created_at < ? AND i.status <> 'cancelled'`, [range.start])
    .forEach(r => addDelta(r.item_id, -r.qty));
  q(`SELECT sri.item_id, sri.quantity as qty FROM sale_return_items sri JOIN sale_returns sr ON sri.return_id = sr.id WHERE sr.created_at < ?`, [range.start])
    .forEach(r => addDelta(r.item_id, r.qty));
  q(`SELECT pri.item_id, pri.quantity as qty FROM purchase_return_items pri JOIN purchase_returns pr ON pri.return_id = pr.id WHERE pr.created_at < ?`, [range.start])
    .forEach(r => addDelta(r.item_id, -r.qty));
  q(`SELECT item_id, change FROM stock_adjustments WHERE created_at < ?`, [range.start])
    .forEach(r => addDelta(r.item_id, r.change));

  // All-time net movement to derive initial stock
  const allDelta = {};
  const addAll = (itemId, delta) => { allDelta[itemId] = (allDelta[itemId] || 0) + delta; };
  q(`SELECT item_id, SUM(quantity) as qty FROM purchase_items GROUP BY item_id`).forEach(r => addAll(r.item_id, r.qty));
  q(`SELECT ii.item_id, SUM(ii.quantity) as qty FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.id WHERE i.status <> 'cancelled' GROUP BY ii.item_id`).forEach(r => addAll(r.item_id, -r.qty));
  q(`SELECT item_id, SUM(quantity) as qty FROM sale_return_items GROUP BY item_id`).forEach(r => addAll(r.item_id, r.qty));
  q(`SELECT item_id, SUM(quantity) as qty FROM purchase_return_items GROUP BY item_id`).forEach(r => addAll(r.item_id, -r.qty));
  q(`SELECT item_id, SUM(change) as qty FROM stock_adjustments GROUP BY item_id`).forEach(r => addAll(r.item_id, r.qty));

  const rows = items.map(item => {
    const initial = (parseFloat(item.stock) || 0) - (allDelta[item.id] || 0);
    const opening = initial + (before[item.id] || 0);
    const closing = opening + (purchased[item.id] || 0) + (saleRet[item.id] || 0)
      - (sold[item.id] || 0) - (purRet[item.id] || 0)
      + (adjIn[item.id] || 0) - (adjOut[item.id] || 0);
    return {
      item: item.name,
      code: item.code,
      category: item.category,
      opening: r2(opening),
      purchased: r2(purchased[item.id] || 0),
      sales_return: r2(saleRet[item.id] || 0),
      sold: r2(sold[item.id] || 0),
      purchase_return: r2(purRet[item.id] || 0),
      adj_in: r2(adjIn[item.id] || 0),
      adj_out: r2(adjOut[item.id] || 0),
      closing: r2(closing)
    };
  });

  return { rows: rows.filter(r => r.opening !== 0 || r.purchased !== 0 || r.sold !== 0 || r.sales_return !== 0 || r.purchase_return !== 0 || r.adj_in !== 0 || r.adj_out !== 0 || r.closing !== 0) };
}

function fastMoving(range, limit = 50) {
  const rows = q(`
    SELECT ii.item_id, ii.name, ii.code, COALESCE(it.stock, 0) as stock, COALESCE(it.unit, 'pcs') as unit,
      SUM(ii.quantity) as qty, SUM(ii.quantity * ii.price - ii.discount) as sales
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    LEFT JOIN items it ON ii.item_id = it.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY ii.item_id ORDER BY qty DESC LIMIT ?
  `, [range.start, range.end, limit]);
  return { rows: roundRows(rows.map((r, i) => ({ rank: i + 1, ...r }))) };
}

function slowMoving(range, limit = 50) {
  const rows = q(`
    SELECT ii.item_id, ii.name, ii.code, COALESCE(it.stock, 0) as stock, COALESCE(it.unit, 'pcs') as unit,
      SUM(ii.quantity) as qty, SUM(ii.quantity * ii.price - ii.discount) as sales
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    LEFT JOIN items it ON ii.item_id = it.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY ii.item_id ORDER BY qty ASC LIMIT ?
  `, [range.start, range.end, limit]);
  return { rows: roundRows(rows.map((r, i) => ({ rank: i + 1, ...r }))) };
}

function deadStock(days = 60) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = q(`
    SELECT i.id, i.code, i.name, i.category, i.stock, i.purchase_price,
      i.stock * i.purchase_price as stock_value,
      (SELECT MAX(inv.created_at) FROM invoice_items ii JOIN invoices inv ON ii.invoice_id = inv.id
        WHERE ii.item_id = i.id AND inv.status <> 'cancelled') as last_sale
    FROM items i
    WHERE i.stock > 0 AND (
      NOT EXISTS (SELECT 1 FROM invoice_items ii JOIN invoices inv ON ii.invoice_id = inv.id
        WHERE ii.item_id = i.id AND inv.status <> 'cancelled' AND inv.created_at >= ?)
    )
    ORDER BY stock_value DESC
  `, [cutoff]);
  return {
    days,
    rows: rows.map(r => ({
      item: r.name,
      code: r.code,
      category: r.category,
      stock: r2(r.stock),
      stock_value: r2(r.stock_value),
      last_sale: r.last_sale || '',
      days_since_sale: r.last_sale ? Math.floor((Date.now() - new Date(r.last_sale).getTime()) / 86400000) : null
    }))
  };
}

function adjustments(range, filters = {}) {
  const rows = listStockAdjustments({ ...filters, start: range.start, end: range.end });
  return {
    rows: rows.map(r => ({
      date: r.created_at,
      item: r.item_name || '',
      code: r.item_code || '',
      type: r.type,
      old_qty: r2(r.old_qty),
      change: r2(r.change),
      new_qty: r2(r.new_qty),
      cost_value: r2(Math.abs(r.change) * (parseFloat(r.purchase_price) || 0)),
      reason: r.reason || '',
      user: r.username || ''
    }))
  };
}

module.exports = {
  currentStock,
  lowStock,
  outOfStock,
  valuation,
  stockLedger,
  stockMovement,
  fastMoving,
  slowMoving,
  deadStock,
  adjustments
};
