// Read-only product tools. Item lookups go through lib/items; sales
// performance reuses the item-wise report and inventory movers.
const { getItem, getItemByCode, listItems } = require('../../items');
const { q, qOne, r2 } = require('../../reportUtils');
const inventoryReports = require('../../reporting/inventory');
const { rangeFromArgs } = require('../context');

function productView(item) {
  if (!item) return null;
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    category: item.category,
    sale_price: item.sale_price,
    mrp: item.mrp,
    stock: r2(item.stock),
    low_stock: item.low_stock,
    unit: item.unit,
    gst_percent: item.gst_percent,
    status: item.stock <= 0 ? 'Out of stock' : item.stock <= item.low_stock ? 'Low' : 'OK'
  };
}

function getProduct(args) {
  const id = parseInt(args.item_id, 10);
  let item = null;
  if (!isNaN(id)) item = getItem(id);
  if (!item && args.code) item = getItemByCode(String(args.code));
  if (!item && args.name) {
    const found = listItems(String(args.name).trim()).filter((i) => i.name.toLowerCase() === String(args.name).trim().toLowerCase());
    item = found[0] || listItems(String(args.name).trim())[0] || null;
  }
  if (!item) return { found: false, product: null };
  return { found: true, product: productView(item) };
}

function searchProducts(args) {
  const term = String(args.query || '').trim();
  if (!term) return { rows: [] };
  const rows = listItems(term, String(args.category || '')).slice(0, 15).map(productView);
  return { query: term, rows };
}

function getProductSales(args) {
  const range = rangeFromArgs(args);
  const term = String(args.query || args.name || '').trim();
  const id = parseInt(args.item_id, 10);
  let itemId = !isNaN(id) ? id : null;
  if (itemId === null && term) {
    const found = listItems(term);
    if (!found.length) return { found: false, note: 'No product matched that name' };
    itemId = found[0].id;
  }
  if (itemId === null) return { found: false, note: 'Give a product name or code' };
  const item = getItem(itemId);
  if (!item) return { found: false, note: 'Product not found' };
  const row = qOne(`
    SELECT COALESCE(SUM(ii.quantity),0) as qty,
      COALESCE(SUM(ii.quantity * ii.price - ii.discount),0) as sales
    FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.id
    WHERE ii.item_id = ? AND i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
  `, [itemId, range.start, range.end]);
  return {
    found: true,
    from: range.from,
    to: range.to,
    product: productView(item),
    qty_sold: r2(row ? row.qty : 0),
    sales_value: r2(row ? row.sales : 0)
  };
}

function getSlowMovingProducts(args) {
  const range = rangeFromArgs(args.period ? args : { period: 'last_30_days' });
  const limit = Math.min(25, Math.max(1, parseInt(args.limit, 10) || 10));
  const rows = inventoryReports.slowMoving(range, limit).rows
    .map((r) => ({ rank: r.rank, item: r.name, code: r.code, qty_sold: r.qty, sales: r.sales, current_stock: r.stock, unit: r.unit }));
  return { from: range.from, to: range.to, note: 'Products that sold, but least, in this period', rows };
}

function getUnsoldProducts(args) {
  const days = Math.min(365, Math.max(7, parseInt(args.days, 10) || 60));
  const d = inventoryReports.deadStock(days);
  return {
    days,
    note: 'Products with stock on hand that had no sale in this many days',
    rows: d.rows.slice(0, 25)
  };
}

// Products about to run out: stock above zero but at/below reorder level,
// or zero - sorted by urgency.
function getProductsRunningOut() {
  const rows = q(`
    SELECT i.id, i.code, i.name, i.category, i.unit, i.stock, i.low_stock, i.sale_price
    FROM items i WHERE i.stock <= i.low_stock
    ORDER BY CASE WHEN i.stock <= 0 THEN 0 ELSE 1 END, i.stock ASC LIMIT 25
  `);
  return {
    rows: rows.map((r) => ({
      ...productView(r),
      needed: r2(Math.max(0, (parseFloat(r.low_stock) || 0) - (parseFloat(r.stock) || 0)))
    }))
  };
}

module.exports = {
  getProduct,
  searchProducts,
  getProductSales,
  getSlowMovingProducts,
  getUnsoldProducts,
  getProductsRunningOut
};
