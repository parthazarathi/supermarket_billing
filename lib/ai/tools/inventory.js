// Read-only inventory tools built on lib/reporting/inventory.
const inventoryReports = require('../../reporting/inventory');
const { q, r2 } = require('../../reportUtils');
const { rangeFromArgs, namedRange } = require('../context');

function getCurrentStock(args) {
  const term = String(args.query || '').trim();
  const result = inventoryReports.currentStock({ q: term, category: String(args.category || '') });
  return {
    query: term,
    total_items: result.summary.items,
    total_units: result.summary.qty,
    rows: result.rows.slice(0, 25).map((r) => ({
      item: r.name, code: r.code, category: r.category,
      stock: r.stock, unit: r.unit, low_stock: r.low_stock, status: r.status
    }))
  };
}

function getLowStockProducts() {
  const d = inventoryReports.lowStock();
  return {
    count: d.rows.length,
    rows: d.rows.slice(0, 25).map((r) => ({
      item: r.name, code: r.code, category: r.category,
      stock: r.stock, unit: r.unit, reorder_level: r.low_stock
    }))
  };
}

function getOutOfStockProducts() {
  const d = inventoryReports.outOfStock();
  return {
    count: d.rows.length,
    rows: d.rows.slice(0, 25).map((r) => ({
      item: r.name, code: r.code, category: r.category, unit: r.unit
    }))
  };
}

function getStockMovement(args) {
  const range = rangeFromArgs(args.period ? args : { period: 'last_7_days' });
  const rows = inventoryReports.stockMovement(range).rows
    .sort((a, b) => Math.abs(b.sold) + Math.abs(b.purchased) - (Math.abs(a.sold) + Math.abs(a.purchased)))
    .slice(0, 25);
  return { from: range.from, to: range.to, rows };
}

// Reorder suggestions: items at/below reorder level, with suggested order
// quantity from average daily sales over the last 30 days (falls back to
// the low_stock level when there is no sales history).
function calculateReorderSuggestions() {
  const range = namedRange('last_30_days');
  const sales = {};
  q(`
    SELECT ii.item_id, SUM(ii.quantity) as qty
    FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY ii.item_id
  `, [range.start, range.end]).forEach((r) => { sales[r.item_id] = parseFloat(r.qty) || 0; });

  const days = 30;
  const rows = q(`
    SELECT i.id, i.code, i.name, i.category, i.unit, i.stock, i.low_stock, i.purchase_price
    FROM items i WHERE i.stock <= i.low_stock
    ORDER BY CASE WHEN i.stock <= 0 THEN 0 ELSE 1 END, i.stock ASC LIMIT 25
  `).map((r) => {
    const sold30 = sales[r.id] || 0;
    const avgDaily = r2(sold30 / days);
    // Cover ~10 days of sales, minimum the configured reorder level.
    const suggested = Math.max(
      Math.ceil(avgDaily * 10),
      Math.ceil(parseFloat(r.low_stock) || 0)
    );
    return {
      item: r.name,
      code: r.code,
      category: r.category,
      unit: r.unit,
      current_stock: r2(r.stock),
      reorder_level: r.low_stock,
      avg_daily_sales: avgDaily,
      suggested_order_qty: suggested,
      estimated_cost: r2(suggested * (parseFloat(r.purchase_price) || 0))
    };
  });

  return {
    generated_by: 'rule-based reorder logic',
    note: 'AI-generated recommendations - review before creating any purchase order',
    basis: 'current stock <= reorder level; suggested qty covers ~10 days of average sales',
    rows
  };
}

function getInventorySummary() {
  const totals = inventoryReports.stockTotals();
  const low = inventoryReports.lowStock().rows.length;
  const out = inventoryReports.outOfStock().rows.length;
  return {
    total_products: totals.items,
    total_units_in_stock: totals.qty,
    stock_cost_value: totals.cost_value,
    stock_sale_value: totals.sale_value,
    potential_profit: totals.potential_profit,
    low_stock_products: low,
    out_of_stock_products: out
  };
}

module.exports = {
  getCurrentStock,
  getLowStockProducts,
  getOutOfStockProducts,
  getStockMovement,
  calculateReorderSuggestions,
  getInventorySummary
};
