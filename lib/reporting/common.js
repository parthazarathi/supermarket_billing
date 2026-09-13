const { qOne, r2 } = require('../reportUtils');

// Aggregated sales figures for a date range (cancelled bills excluded).
// gross: taxable value before bill discount (invoice.subtotal is already net of
// line discounts). grand: invoice total incl. tax. returnsNet: return value
// excluding tax. returnsCost: purchase cost of returned items.
function salesAggregates(range) {
  const inv = qOne(`
    SELECT COUNT(*) as bills,
      COALESCE(SUM(subtotal), 0) as gross,
      COALESCE(SUM(discount), 0) as discount,
      COALESCE(SUM(tax), 0) as tax,
      COALESCE(SUM(cgst), 0) as cgst,
      COALESCE(SUM(sgst), 0) as sgst,
      COALESCE(SUM(igst), 0) as igst,
      COALESCE(SUM(total), 0) as grand,
      COALESCE(SUM(paid), 0) as paid
    FROM invoices
    WHERE created_at >= ? AND created_at <= ? AND status <> 'cancelled'
  `, [range.start, range.end]);

  const items = qOne(`
    SELECT COALESCE(SUM(ii.quantity), 0) as qty,
      COALESCE(SUM(ii.quantity * COALESCE(ii.purchase_price, 0)), 0) as cogs
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
  `, [range.start, range.end]);

  const ret = qOne(`
    SELECT COALESCE(SUM(sri.amount), 0) as gross,
      COALESCE(SUM(sri.amount / (1 + COALESCE(ii.gst_percent, 0) / 100.0)), 0) as net,
      COALESCE(SUM(sri.quantity * COALESCE(ii.purchase_price, 0)), 0) as cost,
      COUNT(DISTINCT sr.id) as count
    FROM sale_return_items sri
    JOIN sale_returns sr ON sri.return_id = sr.id
    LEFT JOIN invoice_items ii ON sri.invoice_item_id = ii.id
    WHERE sr.created_at >= ? AND sr.created_at <= ?
  `, [range.start, range.end]);

  const gross = parseFloat(inv.gross) || 0;
  const discount = parseFloat(inv.discount) || 0;
  const returnsGross = parseFloat(ret.gross) || 0;
  const returnsNet = parseFloat(ret.net) || 0;
  const cogs = (parseFloat(items.cogs) || 0) - (parseFloat(ret.cost) || 0);
  const netSales = gross - discount - returnsNet;

  return {
    bills: inv.bills || 0,
    gross_sales: r2(gross),
    discounts: r2(discount),
    tax: r2(parseFloat(inv.tax)),
    cgst: r2(parseFloat(inv.cgst)),
    sgst: r2(parseFloat(inv.sgst)),
    igst: r2(parseFloat(inv.igst)),
    grand_total: r2(parseFloat(inv.grand)),
    paid: r2(parseFloat(inv.paid)),
    items_sold: r2((parseFloat(items.qty) || 0)),
    sales_returns: r2(returnsGross),
    returns_count: ret.count || 0,
    cogs: r2(cogs),
    net_sales: r2(netSales),
    gross_profit: r2(netSales - cogs),
    avg_bill: inv.bills ? r2(parseFloat(inv.grand) / inv.bills) : 0
  };
}

function purchaseAggregates(range) {
  const row = qOne(`
    SELECT COUNT(*) as invoices,
      COALESCE(SUM(subtotal), 0) as subtotal,
      COALESCE(SUM(discount), 0) as discount,
      COALESCE(SUM(tax), 0) as tax,
      COALESCE(SUM(total), 0) as total,
      COALESCE(SUM(paid), 0) as paid
    FROM purchases
    WHERE created_at >= ? AND created_at <= ?
  `, [range.start, range.end]);

  const ret = qOne(`
    SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count
    FROM purchase_returns WHERE created_at >= ? AND created_at <= ?
  `, [range.start, range.end]);

  const total = parseFloat(row.total) || 0;
  const returns = parseFloat(ret.total) || 0;

  return {
    invoices: row.invoices || 0,
    subtotal: r2(row.subtotal),
    discount: r2(row.discount),
    tax: r2(row.tax),
    total: r2(total),
    paid: r2(row.paid),
    returns: r2(returns),
    returns_count: ret.count || 0,
    net_purchase: r2(total - returns),
    outstanding: r2(total - parseFloat(row.paid || 0))
  };
}

function expenseAggregates(range) {
  const row = qOne(`
    SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
    FROM expenses WHERE created_at >= ? AND created_at <= ?
  `, [range.start, range.end]);
  return { total: r2(row.total), count: row.count || 0 };
}

module.exports = {
  salesAggregates,
  purchaseAggregates,
  expenseAggregates
};
