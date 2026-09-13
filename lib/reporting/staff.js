const { q, r2, pagedQuery, roundRows, pageParams } = require('../reportUtils');
const { listSessions } = require('../cashSessions');
const { listAuditLogs, auditActions, auditModules } = require('../audit');

function cashierSales(range) {
  const rows = q(`
    SELECT i.user_id, COALESCE(u.username, 'Unknown') as cashier,
      COUNT(*) as bills,
      COALESCE(SUM(i.total), 0) as sales,
      COALESCE(SUM(i.discount), 0) as discount
    FROM invoices i LEFT JOIN users u ON i.user_id = u.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY i.user_id ORDER BY sales DESC
  `, [range.start, range.end]);

  const retRows = q(`
    SELECT sr.user_id, COALESCE(SUM(sr.total), 0) as returns
    FROM sale_returns sr WHERE sr.created_at >= ? AND sr.created_at <= ? GROUP BY sr.user_id
  `, [range.start, range.end]);
  const retMap = {};
  retRows.forEach(r => { retMap[r.user_id] = r.returns; });

  return {
    rows: rows.map(r => {
      const sales = parseFloat(r.sales) || 0;
      const returns = parseFloat(retMap[r.user_id]) || 0;
      return {
        cashier: r.cashier,
        bills: r.bills,
        sales: r2(sales),
        discount: r2(r.discount),
        returns: r2(returns),
        net_sales: r2(sales - returns),
        avg_bill: r.bills ? r2(sales / r.bills) : 0
      };
    })
  };
}

function cashierPayments(range) {
  const byUser = {};
  const add = (userId, method, amount) => {
    const key = userId || 0;
    byUser[key] = byUser[key] || {};
    byUser[key][method || 'Cash'] = (byUser[key][method || 'Cash'] || 0) + (parseFloat(amount) || 0);
  };

  q(`
    SELECT i.user_id, COALESCE(i.payment_method,'Cash') as method, COALESCE(SUM(i.paid),0) as amount
    FROM invoices i
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY i.user_id, method
  `, [range.start, range.end]).forEach(r => add(r.user_id, r.method, r.amount));

  q(`
    SELECT p.user_id, COALESCE(p.method,'Cash') as method, COALESCE(SUM(p.amount),0) as amount
    FROM payments p
    WHERE p.created_at >= ? AND p.created_at <= ? AND p.note NOT LIKE 'Invoice %'
      AND COALESCE(p.direction, 'in') = 'in'
    GROUP BY p.user_id, method
  `, [range.start, range.end]).forEach(r => add(r.user_id, r.method, r.amount));

  const users = {};
  q('SELECT id, username FROM users').forEach(u => { users[u.id] = u.username; });

  const methods = [...new Set(Object.values(byUser).flatMap(o => Object.keys(o)))].sort();
  const rows = Object.entries(byUser).map(([uid, byMethod]) => {
    const row = { cashier: users[uid] || 'Unknown' };
    let total = 0;
    methods.forEach(m => { row[m] = r2(byMethod[m] || 0); total += byMethod[m] || 0; });
    row.total = r2(total);
    return row;
  }).sort((a, b) => b.total - a.total);

  return { rows, methods };
}

function cashierDiscounts(range, query) {
  const params = [range.start, range.end];
  const base = `FROM invoices i LEFT JOIN users u ON i.user_id = u.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.discount > 0 AND i.status <> 'cancelled'`;
  return pagedQuery(
    `SELECT COUNT(*) as total ${base}`,
    `SELECT COALESCE(u.username,'Unknown') as cashier, i.invoice_no, i.created_at,
      i.party_name as customer, i.subtotal, i.discount,
      CASE WHEN i.subtotal > 0 THEN ROUND(i.discount*100.0/i.subtotal,2) ELSE 0 END as discount_pct,
      i.total ${base} ORDER BY i.discount DESC`,
    params, query
  );
}

function cashierReturns(range, query) {
  const params = [range.start, range.end];
  const base = `FROM sale_returns sr
    JOIN invoices i ON sr.invoice_id = i.id
    LEFT JOIN users u ON sr.user_id = u.id
    WHERE sr.created_at >= ? AND sr.created_at <= ?`;
  return pagedQuery(
    `SELECT COUNT(*) as total ${base}`,
    `SELECT COALESCE(u.username,'Unknown') as cashier, sr.return_no, i.invoice_no,
      sr.created_at, sr.total, COALESCE(sr.reason,'') as reason
      ${base} ORDER BY sr.id DESC`,
    params, query
  );
}

function sessionsReport(range, query) {
  const filters = { start: range.start, end: range.end };
  if (query.user_id) filters.userId = parseInt(query.user_id, 10);
  const sessions = listSessions(filters);
  return {
    rows: sessions.map(s => ({
      user: s.username || '',
      opened_at: s.opened_at,
      closed_at: s.closed_at || '',
      status: s.status,
      ...s.figures
    }))
  };
}

// Unified returns & adjustments listing
function returnsUnified(range, query) {
  const type = query.type || '';
  const rows = [];

  const userId = query.user_id ? parseInt(query.user_id, 10) : null;

  if (!type || type === 'sale_return') {
    const params = [range.start, range.end];
    let extra = '';
    if (userId) { extra = ' AND sr.user_id = ?'; params.push(userId); }
    q(`
      SELECT sr.return_no as ref, sr.created_at, 'Sales Return' as type,
        i.invoice_no as doc, COALESCE(i.party_name,'') as party,
        sr.total as amount, COALESCE(sr.reason,'') as reason,
        COALESCE(u.username,'') as user
      FROM sale_returns sr JOIN invoices i ON sr.invoice_id = i.id
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE sr.created_at >= ? AND sr.created_at <= ?${extra}
    `, params).forEach(r => rows.push(r));
  }

  if (!type || type === 'purchase_return') {
    const params = [range.start, range.end];
    let extra = '';
    if (userId) { extra = ' AND pr.user_id = ?'; params.push(userId); }
    q(`
      SELECT pr.return_no as ref, pr.created_at, 'Purchase Return' as type,
        p.purchase_no as doc, COALESCE(p.party_name,'') as party,
        pr.total as amount, COALESCE(pr.reason,'') as reason,
        COALESCE(u.username,'') as user
      FROM purchase_returns pr JOIN purchases p ON pr.purchase_id = p.id
      LEFT JOIN users u ON pr.user_id = u.id
      WHERE pr.created_at >= ? AND pr.created_at <= ?${extra}
    `, params).forEach(r => rows.push(r));
  }

  if (!type || type === 'cancelled') {
    const params = [range.start, range.end];
    let extra = '';
    if (userId) { extra = ' AND i.cancelled_by = ?'; params.push(userId); }
    q(`
      SELECT i.invoice_no as ref, COALESCE(i.cancelled_at, i.created_at) as created_at,
        'Cancelled Bill' as type, i.invoice_no as doc,
        COALESCE(i.party_name,'') as party, i.total as amount,
        COALESCE(i.cancel_reason,'') as reason, COALESCE(u.username,'') as user
      FROM invoices i LEFT JOIN users u ON i.cancelled_by = u.id
      WHERE i.status = 'cancelled' AND i.created_at >= ? AND i.created_at <= ?${extra}
    `, params).forEach(r => rows.push(r));
  }

  if (!type || ['adjustment', 'damage', 'wastage'].includes(type)) {
    const params = [range.start, range.end];
    let extra = '';
    if (userId) { extra = ' AND a.user_id = ?'; params.push(userId); }
    if (['adjustment', 'damage', 'wastage'].includes(type)) {
      extra += ' AND a.type = ?';
      params.push(type);
    }
    q(`
      SELECT ('ADJ-' || a.id) as ref, a.created_at,
        CASE a.type WHEN 'damage' THEN 'Damage' WHEN 'wastage' THEN 'Wastage' ELSE 'Stock Adjustment' END as type,
        COALESCE(it.name,'') as doc, '' as party,
        (a.change * COALESCE(it.purchase_price,0)) as amount,
        (a.change || ' units') as reason2, COALESCE(a.reason,'') as reason,
        COALESCE(u.username,'') as user
      FROM stock_adjustments a
      LEFT JOIN items it ON a.item_id = it.id
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.created_at >= ? AND a.created_at <= ?${extra}
    `, params).forEach(r => rows.push(r));
  }

  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return { rows: roundRows(rows) };
}

function auditReport(range, query) {
  const pagination = pageParams(query, 100);
  const filters = {
    start: range.start,
    end: range.end,
    userId: query.user_id ? parseInt(query.user_id, 10) : null,
    module: query.module || '',
    action: query.action || '',
    search: query.q || ''
  };
  const { rows, total } = listAuditLogs(filters, pagination);
  return {
    rows,
    total,
    page: pagination.page,
    per_page: pagination.perPage,
    actions: auditActions(),
    modules: auditModules()
  };
}

// Dropdown data for report pickers/filters
function meta() {
  return {
    items: q('SELECT id, code, name, unit, stock FROM items ORDER BY name'),
    customers: q("SELECT id, name, phone FROM parties WHERE type = 'customer' ORDER BY name"),
    suppliers: q("SELECT id, name, phone FROM parties WHERE type = 'supplier' ORDER BY name"),
    users: q('SELECT id, username, role FROM users ORDER BY username'),
    categories: q("SELECT DISTINCT category FROM items WHERE category IS NOT NULL AND category != '' ORDER BY category").map(r => r.category)
  };
}

module.exports = {
  cashierSales,
  cashierPayments,
  cashierDiscounts,
  cashierReturns,
  sessionsReport,
  returnsUnified,
  auditReport,
  meta
};
