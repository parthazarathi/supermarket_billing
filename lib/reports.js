const { getDatabase } = require('./database');

function dashboard() {
  const db = getDatabase();
  const today = new Date().toISOString().split('T')[0];
  const todayPattern = `${today}%`;

  // Today's sales
  const salesStmt = db.prepare('SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count FROM invoices WHERE created_at LIKE ?');
  salesStmt.bind([todayPattern]);
  const salesResult = salesStmt.getAsObject();
  salesStmt.free();
  const sales = salesResult[0];

  // Today's expenses
  const expensesStmt = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE created_at LIKE ?');
  expensesStmt.bind([todayPattern]);
  const expensesResult = expensesStmt.getAsObject();
  expensesStmt.free();
  const expenses = expensesResult[0];

  // Unpaid dues
  const duesStmt = db.prepare('SELECT COALESCE(SUM(total - paid), 0) as total FROM invoices WHERE total > paid');
  const duesResult = duesStmt.getAsObject();
  duesStmt.free();
  const dues = duesResult[0];

  // Low stock items
  const lowStockStmt = db.prepare('SELECT * FROM items WHERE stock <= low_stock ORDER BY stock ASC LIMIT 20');
  const lowStock = [];
  while (lowStockStmt.step()) {
    lowStock.push(lowStockStmt.getAsObject());
  }
  lowStockStmt.free();

  // Recent invoices
  const recentStmt = db.prepare('SELECT * FROM invoices ORDER BY id DESC LIMIT 8');
  const recent = [];
  while (recentStmt.step()) {
    recent.push(recentStmt.getAsObject());
  }
  recentStmt.free();

  return {
    today_sales: Math.round(parseFloat(sales.total) * 100) / 100,
    today_invoices: sales.count,
    today_expenses: Math.round(parseFloat(expenses.total) * 100) / 100,
    unpaid_dues: Math.round(parseFloat(dues.total) * 100) / 100,
    low_stock: lowStock,
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

module.exports = {
  dashboard,
  reports
};
