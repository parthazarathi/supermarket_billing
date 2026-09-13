const { withTransaction } = require('./database');
const { q, qOne, r2 } = require('./reportUtils');

// A cash session tracks the cash drawer for one user between open and close.
function openSession(userId, openingCash = 0) {
  const existing = qOne("SELECT * FROM cash_sessions WHERE user_id = ? AND status = 'open'", [userId]);
  if (existing) {
    throw new Error('You already have an open cash session');
  }
  const now = new Date().toISOString();
  return withTransaction((db) => {
    const stmt = db.prepare(
      "INSERT INTO cash_sessions (user_id, opened_at, opening_cash, status) VALUES (?, ?, ?, 'open')"
    );
    stmt.run([userId, now, parseFloat(openingCash) || 0]);
    stmt.free();
    return qOne('SELECT * FROM cash_sessions WHERE id = last_insert_rowid()');
  });
}

function closeSession(userId, closingCash = null, note = '') {
  const session = qOne("SELECT * FROM cash_sessions WHERE user_id = ? AND status = 'open'", [userId]);
  if (!session) {
    throw new Error('No open cash session found');
  }
  const now = new Date().toISOString();
  const figures = computeSessionFigures(session, now);
  return withTransaction((db) => {
    const stmt = db.prepare(
      "UPDATE cash_sessions SET closed_at = ?, closing_cash = ?, expected_cash = ?, note = ?, status = 'closed' WHERE id = ?"
    );
    stmt.run([now, closingCash === null ? null : parseFloat(closingCash), figures.expected_cash, note || '', session.id]);
    stmt.free();
    return qOne('SELECT * FROM cash_sessions WHERE id = ?', [session.id]);
  });
}

function currentSession(userId) {
  const session = qOne(`
    SELECT s.*, u.username FROM cash_sessions s
    LEFT JOIN users u ON s.user_id = u.id
    WHERE s.user_id = ? AND s.status = 'open'
  `, [userId]);
  if (session) {
    session.figures = computeSessionFigures(session, new Date().toISOString());
  }
  return session;
}

// Compute expected drawer cash for a session window.
// Assumptions (documented): invoice paid amounts are collected at billing time;
// standalone party payments in the window count as collections; expenses and
// purchase payments are treated as cash out; sale returns are cash refunds.
function computeSessionFigures(session, endTime) {
  const start = session.opened_at;
  const end = session.closed_at || endTime;
  const userId = session.user_id;

  const sales = qOne(`
    SELECT COALESCE(SUM(paid), 0) as total, COUNT(*) as bills
    FROM invoices
    WHERE user_id = ? AND payment_method = 'Cash' AND status <> 'cancelled'
      AND created_at >= ? AND created_at <= ?
  `, [userId, start, end]);

  // Cash received against earlier dues recorded in payments (invoice-linked
  // payments are already counted via invoices.paid above).
  const collections = qOne(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM payments
    WHERE user_id = ? AND method = 'Cash' AND COALESCE(direction, 'in') = 'in'
      AND note NOT LIKE 'Invoice %'
      AND created_at >= ? AND created_at <= ?
  `, [userId, start, end]);

  const expenses = qOne(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM expenses WHERE user_id = ? AND created_at >= ? AND created_at <= ?
  `, [userId, start, end]);

  const purchasePayments = qOne(`
    SELECT COALESCE(SUM(paid), 0) as total
    FROM purchases WHERE user_id = ? AND created_at >= ? AND created_at <= ?
  `, [userId, start, end]);

  // Standalone cash payments made to suppliers (direction 'out')
  const supplierOut = qOne(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM payments
    WHERE user_id = ? AND method = 'Cash' AND COALESCE(direction, 'in') = 'out'
      AND created_at >= ? AND created_at <= ?
  `, [userId, start, end]);

  const refunds = qOne(`
    SELECT COALESCE(SUM(total), 0) as total
    FROM sale_returns WHERE user_id = ? AND created_at >= ? AND created_at <= ?
  `, [userId, start, end]);

  const cancelledPaid = qOne(`
    SELECT COALESCE(SUM(paid), 0) as total
    FROM invoices
    WHERE user_id = ? AND payment_method = 'Cash' AND status = 'cancelled'
      AND created_at >= ? AND created_at <= ?
  `, [userId, start, end]);

  const opening = parseFloat(session.opening_cash) || 0;
  const cashSales = parseFloat(sales.total) || 0;
  const cashCollections = parseFloat(collections.total) || 0;
  const cashExpenses = parseFloat(expenses.total) || 0;
  const cashPurchases = (parseFloat(purchasePayments.total) || 0) + (parseFloat(supplierOut.total) || 0);
  const cashRefunds = (parseFloat(refunds.total) || 0) + (parseFloat(cancelledPaid.total) || 0);

  const expected = opening + cashSales + cashCollections - cashExpenses - cashPurchases - cashRefunds;
  const actual = session.closing_cash === null || session.closing_cash === undefined
    ? null : parseFloat(session.closing_cash);

  return {
    opening_cash: r2(opening),
    cash_sales: r2(cashSales),
    cash_collections: r2(cashCollections),
    cash_purchase_payments: r2(cashPurchases),
    cash_expenses: r2(cashExpenses),
    cash_refunds: r2(cashRefunds),
    expected_cash: r2(expected),
    actual_cash: actual === null ? null : r2(actual),
    difference: actual === null ? null : r2(actual - expected),
    bills: sales.bills
  };
}

function listSessions(filters = {}, limit = 300) {
  let where = ' WHERE 1=1';
  const params = [];
  if (filters.start && filters.end) {
    where += ' AND s.opened_at >= ? AND s.opened_at <= ?';
    params.push(filters.start, filters.end);
  }
  if (filters.userId) {
    where += ' AND s.user_id = ?';
    params.push(filters.userId);
  }
  const sessions = q(`
    SELECT s.*, u.username FROM cash_sessions s
    LEFT JOIN users u ON s.user_id = u.id
    ${where} ORDER BY s.id DESC LIMIT ?
  `, [...params, limit]);
  for (const s of sessions) {
    s.figures = computeSessionFigures(s, new Date().toISOString());
  }
  return sessions;
}

module.exports = {
  openSession,
  closeSession,
  currentSession,
  computeSessionFigures,
  listSessions
};
