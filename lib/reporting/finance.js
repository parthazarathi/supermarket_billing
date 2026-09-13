const { q, qOne, r2, pagedQuery, DAY_EXPR } = require('../reportUtils');
const { salesAggregates, expenseAggregates } = require('./common');
const { listSessions } = require('../cashSessions');

function profitLoss(range) {
  const s = salesAggregates(range);
  const exp = expenseAggregates(range);
  const netProfit = s.gross_profit - exp.total;
  return {
    summary: {
      gross_sales: s.gross_sales,
      sales_returns: s.sales_returns,
      discounts: s.discounts,
      net_sales: s.net_sales,
      cogs: s.cogs,
      gross_profit: s.gross_profit,
      expenses: exp.total,
      net_profit: r2(netProfit),
      gross_margin: s.net_sales > 0 ? r2(s.gross_profit * 100 / s.net_sales) : 0,
      net_margin: s.net_sales > 0 ? r2(netProfit * 100 / s.net_sales) : 0
    }
  };
}

function dayWiseProfit(range) {
  const sales = q(`
    SELECT ${DAY_EXPR('i')} as day,
      COALESCE(SUM(i.subtotal - i.discount), 0) as net_sales
    FROM invoices i
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY day
  `, [range.start, range.end]);

  const cogsRows = q(`
    SELECT ${DAY_EXPR('i')} as day,
      COALESCE(SUM(ii.quantity * COALESCE(ii.purchase_price, 0)), 0) as cogs
    FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY day
  `, [range.start, range.end]);

  const retRows = q(`
    SELECT ${DAY_EXPR('sr')} as day,
      COALESCE(SUM(sri.amount / (1 + COALESCE(ii.gst_percent, 0) / 100.0)), 0) as returns_net,
      COALESCE(SUM(sri.quantity * COALESCE(ii.purchase_price, 0)), 0) as returns_cost
    FROM sale_returns sr
    LEFT JOIN sale_return_items sri ON sri.return_id = sr.id
    LEFT JOIN invoice_items ii ON sri.invoice_item_id = ii.id
    WHERE sr.created_at >= ? AND sr.created_at <= ?
    GROUP BY day
  `, [range.start, range.end]);

  const expRows = q(`
    SELECT ${DAY_EXPR('e')} as day, COALESCE(SUM(e.amount), 0) as expenses
    FROM expenses e
    WHERE e.created_at >= ? AND e.created_at <= ?
    GROUP BY day
  `, [range.start, range.end]);

  const map = {};
  const ensure = d => (map[d] = map[d] || { day: d, sales: 0, returns_net: 0, cogs: 0, returns_cost: 0, expenses: 0 });
  sales.forEach(r => { ensure(r.day).sales = parseFloat(r.net_sales) || 0; });
  cogsRows.forEach(r => { ensure(r.day).cogs = parseFloat(r.cogs) || 0; });
  retRows.forEach(r => { const e = ensure(r.day); e.returns_net = parseFloat(r.returns_net) || 0; e.returns_cost = parseFloat(r.returns_cost) || 0; });
  expRows.forEach(r => { ensure(r.day).expenses = parseFloat(r.expenses) || 0; });

  const rows = Object.values(map).sort((a, b) => a.day < b.day ? -1 : 1).map(d => {
    const netSales = d.sales - d.returns_net;
    const cogs = d.cogs - d.returns_cost;
    const gross = netSales - cogs;
    return {
      day: d.day,
      sales: r2(netSales),
      cogs: r2(cogs),
      gross_profit: r2(gross),
      expenses: r2(d.expenses),
      net_profit: r2(gross - d.expenses)
    };
  });
  return { rows };
}

function expenseReport(range, query) {
  const params = [range.start, range.end];
  let where = ' WHERE e.created_at >= ? AND e.created_at <= ?';
  if (query.q) {
    where += ' AND (e.category LIKE ? OR e.note LIKE ?)';
    const like = `%${query.q}%`;
    params.push(like, like);
  }
  const base = `FROM expenses e LEFT JOIN users u ON e.user_id = u.id${where}`;
  const result = pagedQuery(
    `SELECT COUNT(*) as total ${base}`,
    `SELECT e.id, e.created_at, e.category, e.note as description, e.amount,
      'Cash' as payment_mode, COALESCE(u.username, '') as entered_by
      ${base} ORDER BY e.id DESC`,
    params, query
  );
  result.summary = { total: r2((qOne(`SELECT COALESCE(SUM(e.amount),0) as t ${base}`, params) || {}).t) };
  return result;
}

function expenseCategories(range) {
  const rows = q(`
    SELECT e.category, COUNT(*) as transactions, COALESCE(SUM(e.amount), 0) as amount
    FROM expenses e
    WHERE e.created_at >= ? AND e.created_at <= ?
    GROUP BY e.category ORDER BY amount DESC
  `, [range.start, range.end]);
  const total = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  return {
    rows: rows.map(r => ({
      category: r.category,
      transactions: r.transactions,
      amount: r2(r.amount),
      percent: total > 0 ? r2(parseFloat(r.amount) * 100 / total) : 0
    })),
    summary: { total: r2(total) }
  };
}

// Day-wise income (net sales incl. tax collected) vs expenses
function incomeExpense(range) {
  const income = q(`
    SELECT ${DAY_EXPR('i')} as day, COALESCE(SUM(i.total), 0) as income
    FROM invoices i
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY day
  `, [range.start, range.end]);
  const exp = q(`
    SELECT ${DAY_EXPR('e')} as day, COALESCE(SUM(e.amount), 0) as expenses
    FROM expenses e WHERE e.created_at >= ? AND e.created_at <= ? GROUP BY day
  `, [range.start, range.end]);

  const map = {};
  income.forEach(r => { map[r.day] = { day: r.day, income: r.income, expenses: 0 }; });
  exp.forEach(r => { (map[r.day] = map[r.day] || { day: r.day, income: 0, expenses: 0 }).expenses = r.expenses; });

  const rows = Object.values(map).sort((a, b) => a.day < b.day ? -1 : 1).map(d => ({
    day: d.day,
    income: r2(d.income),
    expenses: r2(d.expenses),
    net: r2(parseFloat(d.income) - parseFloat(d.expenses))
  }));
  const ti = rows.reduce((s, r) => s + r.income, 0);
  const te = rows.reduce((s, r) => s + r.expenses, 0);
  return { rows, summary: { income: r2(ti), expenses: r2(te), net: r2(ti - te) } };
}

// Collection summary by payment method: invoice receipts + standalone party payments
function paymentSummary(range) {
  const byMethod = {};
  const add = (method, amount) => {
    const m = method || 'Cash';
    byMethod[m] = (byMethod[m] || 0) + (parseFloat(amount) || 0);
  };

  q(`
    SELECT payment_method, COALESCE(SUM(paid), 0) as amount
    FROM invoices
    WHERE created_at >= ? AND created_at <= ? AND status <> 'cancelled'
    GROUP BY payment_method
  `, [range.start, range.end]).forEach(r => add(r.payment_method, r.amount));

  // Standalone party receipts (invoice-linked ones are already inside
  // invoices.paid; direction 'out' supplier payments are excluded)
  q(`
    SELECT method, COALESCE(SUM(amount), 0) as amount
    FROM payments
    WHERE created_at >= ? AND created_at <= ? AND note NOT LIKE 'Invoice %'
      AND COALESCE(direction, 'in') = 'in'
    GROUP BY method
  `, [range.start, range.end]).forEach(r => add(r.method, r.amount));

  const credit = qOne(`
    SELECT COALESCE(SUM(total - paid), 0) as due FROM invoices
    WHERE created_at >= ? AND created_at <= ? AND status <> 'cancelled' AND total > paid
  `, [range.start, range.end]);

  const total = Object.values(byMethod).reduce((s, v) => s + v, 0);
  const rows = Object.entries(byMethod).map(([method, amount]) => ({
    method, amount: r2(amount), percent: total > 0 ? r2(amount * 100 / total) : 0
  })).sort((a, b) => b.amount - a.amount);

  return {
    rows,
    summary: { collected: r2(total), credit_sales: r2(credit ? credit.due : 0) }
  };
}

function dailyCollections(range) {
  const rows = q(`
    SELECT ${DAY_EXPR('i')} as day, COALESCE(i.payment_method, 'Cash') as method,
      COALESCE(SUM(i.paid), 0) as amount
    FROM invoices i
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY day, method
  `, [range.start, range.end]);

  q(`
    SELECT ${DAY_EXPR('p')} as day, COALESCE(p.method, 'Cash') as method,
      COALESCE(SUM(p.amount), 0) as amount
    FROM payments p
    WHERE p.created_at >= ? AND p.created_at <= ? AND p.note NOT LIKE 'Invoice %'
      AND COALESCE(p.direction, 'in') = 'in'
    GROUP BY day, method
  `, [range.start, range.end]).forEach(r => rows.push(r));

  const methods = [...new Set(rows.map(r => r.method))].sort();
  const byDay = {};
  rows.forEach(r => {
    byDay[r.day] = byDay[r.day] || { day: r.day };
    byDay[r.day][r.method] = r2((byDay[r.day][r.method] || 0) + parseFloat(r.amount));
  });

  const out = Object.values(byDay).sort((a, b) => a.day < b.day ? -1 : 1).map(d => {
    const row = { day: d.day };
    let total = 0;
    methods.forEach(m => { row[m] = r2(d[m] || 0); total += d[m] || 0; });
    row.total = r2(total);
    return row;
  });

  return { rows: out, methods };
}

// Open credit (unpaid/partial) invoices
function creditSales(range, query) {
  const params = [range.start, range.end];
  const base = `FROM invoices i LEFT JOIN parties pt ON i.party_id = pt.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled' AND i.total > i.paid + 0.009`;
  return pagedQuery(
    `SELECT COUNT(*) as total ${base}`,
    `SELECT i.invoice_no, i.created_at, COALESCE(NULLIF(i.party_name,''),'Walk-in Customer') as customer,
      pt.phone as phone, i.total, i.paid, (i.total - i.paid) as balance,
      CAST(julianday('now','localtime') - julianday(date(i.created_at,'localtime')) AS INTEGER) as age
      ${base} ORDER BY balance DESC`,
    params, query
  );
}

// Standalone customer receipts + invoice due payments recorded in payments table
function customerCollections(range, query) {
  const params = [range.start, range.end];
  const base = `FROM payments p
    JOIN parties pt ON p.party_id = pt.id
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.created_at >= ? AND p.created_at <= ? AND pt.type = 'customer'`;
  return pagedQuery(
    `SELECT COUNT(*) as total ${base}`,
    `SELECT p.id, p.created_at, pt.name as customer, p.note as reference,
      p.method, p.amount, COALESCE(u.username, '') as collected_by
      ${base} ORDER BY p.id DESC`,
    params, query
  );
}

function dayClosing(range, query) {
  const filters = { start: range.start, end: range.end };
  if (query.user_id) filters.userId = parseInt(query.user_id, 10);
  const sessions = listSessions(filters);
  return {
    rows: sessions.map(s => ({
      id: s.id,
      user: s.username || '',
      opened_at: s.opened_at,
      closed_at: s.closed_at || '',
      status: s.status,
      ...s.figures
    }))
  };
}

module.exports = {
  profitLoss,
  dayWiseProfit,
  expenseReport,
  expenseCategories,
  incomeExpense,
  paymentSummary,
  dailyCollections,
  creditSales,
  customerCollections,
  dayClosing
};
