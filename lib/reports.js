const { getDatabase } = require('./database');
const { salesAggregates, purchaseAggregates, expenseAggregates } = require('./reporting/common');
const { q, qOne, r2, parseRange, todayLocal } = require('./reportUtils');
const salesReports = require('./reporting/sales');
const inventoryReports = require('./reporting/inventory');
const purchaseReports = require('./reporting/purchases');
const financeReports = require('./reporting/finance');
const partyReports = require('./reporting/parties');
const gstReports = require('./reporting/gst');
const staffReports = require('./reporting/staff');

// Parties with positive outstanding (single aggregate query each)
function outstandingSummary(type) {
  const billsTable = type === 'supplier' ? 'purchases' : 'invoices';
  const statusClause = type === 'supplier' ? '' : "AND status <> 'cancelled'";
  const r = qOne(`
    SELECT COUNT(*) as parties, COALESCE(SUM(due), 0) as total FROM (
      SELECT p.id, (
        p.opening_balance
        + COALESCE((SELECT SUM(total - paid) FROM ${billsTable} WHERE party_id = p.id ${statusClause}), 0)
        - COALESCE((SELECT SUM(amount) FROM payments WHERE party_id = p.id AND note NOT LIKE 'Invoice %'), 0)
      ) as due
      FROM parties p WHERE p.type = ?
    ) WHERE due > 0
  `, [type]);
  return { parties: r.parties || 0, total: r2(r.total) };
}

// Sales dashboard - reuses the same report aggregates (no separate math).
// range = { from, to, start, end }; trend = '7' | '30' | 'month'
function dashboard(range, trend = '7') {
  if (!range) range = parseRange({});
  const s = salesAggregates(range);
  const e = expenseAggregates(range);

  // Previous comparable period (same length, immediately before)
  const fromDate = new Date(`${range.from}T00:00:00`);
  const toDate = new Date(`${range.to}T00:00:00`);
  const lenDays = Math.round((toDate - fromDate) / 86400000) + 1;
  const prevTo = new Date(fromDate.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - (lenDays - 1) * 86400000);
  const prevRange = parseRange({
    from: `${prevFrom.getFullYear()}-${String(prevFrom.getMonth() + 1).padStart(2, '0')}-${String(prevFrom.getDate()).padStart(2, '0')}`,
    to: `${prevTo.getFullYear()}-${String(prevTo.getMonth() + 1).padStart(2, '0')}-${String(prevTo.getDate()).padStart(2, '0')}`
  });
  const sp = salesAggregates(prevRange);

  const pctChange = sp.grand_total > 0
    ? r2(((s.grand_total - sp.grand_total) / sp.grand_total) * 100)
    : null;
  const prevLabel = lenDays === 1 ? 'yesterday' : `previous ${lenDays} days`;

  // Sales trend (own range selector, default last 7 days)
  const today = todayLocal();
  let tFrom, tTo = today;
  if (trend === 'month') {
    tFrom = `${today.slice(0, 7)}-01`;
  } else {
    const n = trend === '30' ? 30 : 7;
    const d = new Date(`${today}T00:00:00`);
    d.setDate(d.getDate() - (n - 1));
    tFrom = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const trendRows = salesReports.dayWise(parseRange({ from: tFrom, to: tTo })).rows;

  // Payment collection for the selected range (shared report logic)
  const payments = financeReports.paymentSummary(range);

  // Top selling items in range (same query as the item-wise report)
  const topItems = salesReports.itemWise(range).rows
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  // Stock alerts - current state (not date-bound)
  const stockAlerts = q(`
    SELECT id, code, name, category, stock, low_stock, unit
    FROM items WHERE stock <= low_stock
    ORDER BY CASE WHEN stock <= 0 THEN 0 ELSE 1 END, stock ASC LIMIT 15
  `).map(i => ({
    ...i,
    status: parseFloat(i.stock) <= 0 ? 'Critical' : 'Low'
  }));
  const lowStockCount = qOne('SELECT COUNT(*) as n FROM items WHERE stock <= low_stock').n || 0;
  const outStockCount = qOne('SELECT COUNT(*) as n FROM items WHERE stock <= 0').n || 0;

  // Recent bills - current state, latest 8
  const recent = q(`
    SELECT i.id, i.invoice_no, i.created_at, i.party_name, i.payment_method,
      i.total, i.paid, i.status,
      EXISTS(SELECT 1 FROM sale_returns sr WHERE sr.invoice_id = i.id) as has_return
    FROM invoices i ORDER BY i.id DESC LIMIT 8
  `).map(i => ({
    ...i,
    status: i.status === 'cancelled' ? 'cancelled'
        : i.has_return ? 'returned'
        : i.paid >= i.total - 0.009 ? 'paid'
        : i.paid > 0 ? 'partial' : 'unpaid'
  }));

  const custOut = outstandingSummary('customer');
  const suppOut = outstandingSummary('supplier');
  const netProfit = r2(s.gross_profit - e.total);

  return {
    range: { from: range.from, to: range.to },
    trend_key: trend,
    kpi: {
      sales: { value: s.grand_total, sub: pctChange !== null ? pctChange : null, prev_label: prevLabel },
      bills: { value: s.bills, sub: `Avg Bill ₹ ${s.avg_bill}` },
      gross_profit: { value: s.gross_profit, sub: `Margin ${s.net_sales > 0 ? r2(s.gross_profit * 100 / s.net_sales) : 0}%` },
      customer_outstanding: { value: custOut.total, sub: `${custOut.parties} customers` },
      expenses: { value: e.total, sub: `${e.count} entries` },
      sales_returns: { value: s.sales_returns, sub: `${s.returns_count} returns` },
      items_sold: { value: s.items_sold, sub: 'units' },
      low_stock: { value: lowStockCount, sub: `${outStockCount} out of stock` },
    },
    payments: { rows: payments.rows, collected: payments.summary.collected, credit: payments.summary.credit_sales },
    trend: trendRows,
    top_items: topItems,
    stock_alerts: stockAlerts,
    recent_bills: recent,
    business: {
      gross_sales: s.gross_sales,
      sales_returns: s.sales_returns,
      discounts: s.discounts,
      net_sales: s.net_sales,
      cogs: s.cogs,
      gross_profit: s.gross_profit,
      expenses: e.total,
      net_profit: netProfit,
      gross_margin: s.net_sales > 0 ? r2(s.gross_profit * 100 / s.net_sales) : 0,
      net_margin: s.net_sales > 0 ? r2(netProfit * 100 / s.net_sales) : 0,
    },
    outstanding: {
      customers: custOut,
      suppliers: suppOut,
    },
    // Legacy keys kept for compatibility
    today_sales: s.grand_total,
    today_invoices: s.bills,
    today_expenses: e.total,
    unpaid_dues: custOut.total,
    low_stock: stockAlerts,
    recent_invoices: recent
  };
}

function reports(dateFrom, dateTo) {
  const db = getDatabase();
  const start = `${dateFrom}T00:00:00`;
  const end = `${dateTo}T23:59:59`;

  // Sales data
  const salesStmt = db.prepare(`
    SELECT COALESCE(SUM(total), 0) as total, COALESCE(SUM(tax), 0) as tax,
           COALESCE(SUM(paid), 0) as paid, COUNT(*) as count
    FROM invoices WHERE created_at >= ? AND created_at <= ?
  `);
  salesStmt.bind([start, end]);
  const salesResult = salesStmt.getAsObject();
  salesStmt.free();
  const sales = salesResult[0];

  // Cost of goods sold
  const cogsStmt = db.prepare(`
    SELECT COALESCE(SUM(ii.purchase_price * ii.quantity), 0) as cogs
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.created_at >= ? AND i.created_at <= ?
  `);
  cogsStmt.bind([start, end]);
  const cogsResult = cogsStmt.getAsObject();
  cogsStmt.free();
  const cogs = cogsResult[0];

  // Purchases
  const purchasesStmt = db.prepare('SELECT COALESCE(SUM(total), 0) as total FROM purchases WHERE created_at >= ? AND created_at <= ?');
  purchasesStmt.bind([start, end]);
  const purchasesResult = purchasesStmt.getAsObject();
  purchasesStmt.free();
  const purchases = purchasesResult[0];

  // Expenses
  const expensesStmt = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE created_at >= ? AND created_at <= ?');
  expensesStmt.bind([start, end]);
  const expensesResult = expensesStmt.getAsObject();
  expensesStmt.free();
  const expenses = expensesResult[0];

  // Returns
  const returnsStmt = db.prepare('SELECT COALESCE(SUM(total), 0) as total FROM sale_returns WHERE created_at >= ? AND created_at <= ?');
  returnsStmt.bind([start, end]);
  const returnsResult = returnsStmt.getAsObject();
  returnsStmt.free();
  const returns = returnsResult[0];

  // Outstanding dues
  const duesStmt = db.prepare('SELECT COALESCE(SUM(total - paid), 0) as total FROM invoices WHERE total > paid');
  const duesResult = duesStmt.getAsObject();
  duesStmt.free();
  const dues = duesResult[0];

  // Sales by day
  const byDayStmt = db.prepare(`
    SELECT substr(created_at, 1, 10) as day, SUM(total) as total, COUNT(*) as count
    FROM invoices WHERE created_at >= ? AND created_at <= ?
    GROUP BY substr(created_at, 1, 10) ORDER BY day
  `);
  byDayStmt.bind([start, end]);
  const byDay = [];
  while (byDayStmt.step()) {
    byDay.push(byDayStmt.getAsObject());
  }
  byDayStmt.free();

  const salesTotal = parseFloat(sales.total) || 0;
  const cogsTotal = parseFloat(cogs.cogs) || 0;
  const expensesTotal = parseFloat(expenses.total) || 0;
  const returnsTotal = parseFloat(returns.total) || 0;
  const profit = salesTotal - cogsTotal - expensesTotal - returnsTotal;

  return {
    date_from: dateFrom,
    date_to: dateTo,
    sales: Math.round(salesTotal * 100) / 100,
    sales_count: sales.count,
    tax: Math.round(parseFloat(sales.tax) * 100) / 100,
    paid: Math.round(parseFloat(sales.paid) * 100) / 100,
    cogs: Math.round(cogsTotal * 100) / 100,
    purchases: Math.round(parseFloat(purchases.total) * 100) / 100,
    expenses: Math.round(expensesTotal * 100) / 100,
    returns: Math.round(returnsTotal * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    dues: Math.round(parseFloat(dues.total) * 100) / 100,
    by_day: byDay
  };
}

// High-level overview for a date range (drives the Overview report tab)
function overview(range) {
  const s = salesAggregates(range);
  const p = purchaseAggregates(range);
  const e = expenseAggregates(range);

  const custDue = qOne(`
    SELECT COALESCE(SUM(total - paid), 0) as due FROM invoices WHERE status <> 'cancelled' AND total > paid
  `);
  const custOpening = qOne(`SELECT COALESCE(SUM(opening_balance),0) as ob FROM parties WHERE type = 'customer'`);
  const custPays = qOne(`
    SELECT COALESCE(SUM(p.amount),0) as amt FROM payments p
    JOIN parties pt ON p.party_id = pt.id
    WHERE pt.type = 'customer' AND p.note NOT LIKE 'Invoice %'
  `);
  const suppDue = qOne(`SELECT COALESCE(SUM(total - paid), 0) as due FROM purchases WHERE total > paid`);
  const suppOpening = qOne(`SELECT COALESCE(SUM(opening_balance),0) as ob FROM parties WHERE type = 'supplier'`);
  const suppPays = qOne(`
    SELECT COALESCE(SUM(p.amount),0) as amt FROM payments p
    JOIN parties pt ON p.party_id = pt.id
    WHERE pt.type = 'supplier' AND p.note NOT LIKE 'Invoice %'
  `);

  const netProfit = s.gross_profit - e.total;

  return {
    summary: {
      total_sales: s.grand_total,
      net_sales: s.net_sales,
      total_purchase: p.total,
      gross_profit: s.gross_profit,
      expenses: e.total,
      net_profit: r2(netProfit),
      bills: s.bills,
      items_sold: s.items_sold,
      avg_bill: s.avg_bill,
      sales_returns: s.sales_returns,
      purchase_returns: p.returns,
      discounts: s.discounts,
      tax_collected: s.tax,
      customer_outstanding: r2((parseFloat(custDue.due) || 0) + (parseFloat(custOpening.ob) || 0) - (parseFloat(custPays.amt) || 0)),
      supplier_outstanding: r2((parseFloat(suppDue.due) || 0) + (parseFloat(suppOpening.ob) || 0) - (parseFloat(suppPays.amt) || 0))
    },
    by_day: salesReports.dayWise(range).rows
  };
}

module.exports = {
  dashboard,
  reports,
  overview,
  salesReports,
  inventoryReports,
  purchaseReports,
  financeReports,
  partyReports,
  gstReports,
  staffReports
};
