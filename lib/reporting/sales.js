const { q, r2, pagedQuery, likeParam, DAY_EXPR, HOUR_EXPR } = require('../reportUtils');
const { salesAggregates } = require('./common');

function summary(range) {
  return { summary: salesAggregates(range) };
}

// Day-wise sales with items sold, returns and profit merged in JS
function dayWise(range) {
  const days = q(`
    SELECT ${DAY_EXPR('i')} as day, COUNT(*) as bills,
      COALESCE(SUM(i.subtotal), 0) as gross,
      COALESCE(SUM(i.discount), 0) as discount,
      COALESCE(SUM(i.total), 0) as total,
      COALESCE(SUM(i.tax), 0) as tax
    FROM invoices i
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY day ORDER BY day
  `, [range.start, range.end]);

  const itemRows = q(`
    SELECT ${DAY_EXPR('i')} as day,
      COALESCE(SUM(ii.quantity), 0) as items,
      COALESCE(SUM(ii.quantity * COALESCE(ii.purchase_price, 0)), 0) as cogs
    FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY day
  `, [range.start, range.end]);

  const returnRows = q(`
    SELECT ${DAY_EXPR('sr')} as day, COALESCE(SUM(sr.total), 0) as returns,
      COALESCE(SUM(sri.amount / (1 + COALESCE(ii.gst_percent, 0) / 100.0)), 0) as returns_net,
      COALESCE(SUM(sri.quantity * COALESCE(ii.purchase_price, 0)), 0) as returns_cost
    FROM sale_returns sr
    LEFT JOIN sale_return_items sri ON sri.return_id = sr.id
    LEFT JOIN invoice_items ii ON sri.invoice_item_id = ii.id
    WHERE sr.created_at >= ? AND sr.created_at <= ?
    GROUP BY day
  `, [range.start, range.end]);

  const itemsByDay = {};
  itemRows.forEach(r => { itemsByDay[r.day] = r; });
  const returnsByDay = {};
  returnRows.forEach(r => { returnsByDay[r.day] = r; });

  const rows = days.map(d => {
    const it = itemsByDay[d.day] || { items: 0, cogs: 0 };
    const rt = returnsByDay[d.day] || { returns: 0, returns_net: 0, returns_cost: 0 };
    const netSales = (parseFloat(d.gross) - parseFloat(d.discount) - parseFloat(rt.returns_net)) || 0;
    const cogs = (parseFloat(it.cogs) - parseFloat(rt.returns_cost)) || 0;
    return {
      day: d.day,
      bills: d.bills,
      items: r2(it.items),
      gross: r2(d.gross),
      discount: r2(d.discount),
      returns: r2(rt.returns),
      net_sales: r2(netSales),
      profit: r2(netSales - cogs)
    };
  });

  return { rows };
}

function billWise(range, query) {
  const params = [range.start, range.end];
  let where = ' WHERE i.created_at >= ? AND i.created_at <= ?';
  if (query.q) {
    where += ' AND (i.invoice_no LIKE ? OR i.party_name LIKE ? OR u.username LIKE ?)';
    const like = likeParam(query.q);
    params.push(like, like, like);
  }
  if (query.status) {
    where += ' AND i.status = ?';
    params.push(query.status);
  }
  if (query.payment) {
    where += ' AND i.payment_method = ?';
    params.push(query.payment);
  }
  const base = `FROM invoices i LEFT JOIN users u ON i.user_id = u.id${where}`;
  return pagedQuery(
    `SELECT COUNT(*) as total ${base}`,
    `SELECT i.id, i.invoice_no, i.created_at, i.party_name, i.party_phone,
      COALESCE(u.username, '') as cashier, i.payment_method, i.subtotal, i.discount,
      i.tax, i.total, i.paid, (i.total - i.paid) as due, i.status
      ${base} ORDER BY i.id DESC`,
    params, query
  );
}

// Item-wise sales net of returns
function itemWise(range) {
  const rows = q(`
    SELECT ii.item_id, ii.name, ii.code, COALESCE(it.category, 'General') as category,
      SUM(ii.quantity) as qty,
      SUM(ii.quantity * ii.price - ii.discount) as sales,
      SUM(ii.quantity * COALESCE(ii.purchase_price, 0)) as cost
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    LEFT JOIN items it ON ii.item_id = it.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY ii.item_id, ii.name, ii.code
  `, [range.start, range.end]);

  const returns = q(`
    SELECT sri.item_id, SUM(sri.quantity) as rqty,
      SUM(sri.amount / (1 + COALESCE(ii.gst_percent, 0) / 100.0)) as rnet,
      SUM(sri.quantity * COALESCE(ii.purchase_price, 0)) as rcost
    FROM sale_return_items sri
    JOIN sale_returns sr ON sri.return_id = sr.id
    LEFT JOIN invoice_items ii ON sri.invoice_item_id = ii.id
    WHERE sr.created_at >= ? AND sr.created_at <= ?
    GROUP BY sri.item_id
  `, [range.start, range.end]);

  const retByItem = {};
  returns.forEach(r => { retByItem[r.item_id] = r; });

  const out = rows.map(row => {
    const rt = retByItem[row.item_id] || { rqty: 0, rnet: 0, rcost: 0 };
    const qty = (parseFloat(row.qty) || 0) - (parseFloat(rt.rqty) || 0);
    const sales = (parseFloat(row.sales) || 0) - (parseFloat(rt.rnet) || 0);
    const cost = (parseFloat(row.cost) || 0) - (parseFloat(rt.rcost) || 0);
    const profit = sales - cost;
    return {
      item_id: row.item_id,
      item: row.name,
      code: row.code,
      category: row.category,
      qty: r2(qty),
      sales: r2(sales),
      cost: r2(cost),
      profit: r2(profit),
      margin: sales > 0 ? r2(profit * 100 / sales) : 0
    };
  }).filter(r => r.qty !== 0 || r.sales !== 0);

  out.sort((a, b) => b.sales - a.sales);
  return { rows: out };
}

function categoryWise(range) {
  const rows = q(`
    SELECT COALESCE(it.category, 'General') as category,
      SUM(ii.quantity) as qty,
      SUM(ii.quantity * ii.price - ii.discount) as sales,
      SUM(ii.quantity * COALESCE(ii.purchase_price, 0)) as cost
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    LEFT JOIN items it ON ii.item_id = it.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY category ORDER BY sales DESC
  `, [range.start, range.end]);

  return {
    rows: rows.map(r => {
      const sales = parseFloat(r.sales) || 0;
      const cost = parseFloat(r.cost) || 0;
      const profit = sales - cost;
      return {
        category: r.category,
        qty: r2(r.qty),
        sales: r2(sales),
        cost: r2(cost),
        profit: r2(profit),
        margin: sales > 0 ? r2(profit * 100 / sales) : 0
      };
    })
  };
}

function customerWise(range) {
  const rows = q(`
    SELECT COALESCE(i.party_id, 0) as party_id,
      COALESCE(NULLIF(i.party_name, ''), 'Walk-in Customer') as customer,
      COUNT(*) as bills,
      COALESCE(SUM(i.total), 0) as sales,
      COALESCE(SUM(i.paid), 0) as paid,
      COALESCE(SUM(i.total - i.paid), 0) as due
    FROM invoices i
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY party_id, customer ORDER BY sales DESC
  `, [range.start, range.end]);

  const itemRows = q(`
    SELECT COALESCE(i.party_id, 0) as party_id, COALESCE(NULLIF(i.party_name, ''), 'Walk-in Customer') as customer,
      COALESCE(SUM(ii.quantity), 0) as items
    FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY party_id, customer
  `, [range.start, range.end]);

  const returnRows = q(`
    SELECT COALESCE(i.party_id, 0) as party_id, COALESCE(NULLIF(i.party_name, ''), 'Walk-in Customer') as customer,
      COALESCE(SUM(sr.total), 0) as returns
    FROM sale_returns sr JOIN invoices i ON sr.invoice_id = i.id
    WHERE sr.created_at >= ? AND sr.created_at <= ?
    GROUP BY party_id, customer
  `, [range.start, range.end]);

  const key = r => `${r.party_id}|${r.customer}`;
  const itemsMap = {};
  itemRows.forEach(r => { itemsMap[key(r)] = r.items; });
  const retMap = {};
  returnRows.forEach(r => { retMap[key(r)] = r.returns; });

  return {
    rows: rows.map(r => {
      const sales = parseFloat(r.sales) || 0;
      const returns = parseFloat(retMap[key(r)]) || 0;
      return {
        customer: r.customer,
        bills: r.bills,
        items: r2(itemsMap[key(r)] || 0),
        sales: r2(sales),
        returns: r2(returns),
        net_sales: r2(sales - returns),
        paid: r2(r.paid),
        outstanding: r2(r.due)
      };
    })
  };
}

function cashierWise(range) {
  const rows = q(`
    SELECT i.user_id, COALESCE(u.username, 'Unknown') as cashier,
      COUNT(*) as bills,
      COALESCE(SUM(i.total), 0) as sales,
      COALESCE(SUM(i.discount), 0) as discount
    FROM invoices i LEFT JOIN users u ON i.user_id = u.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY i.user_id ORDER BY sales DESC
  `, [range.start, range.end]);

  const itemRows = q(`
    SELECT i.user_id, COALESCE(SUM(ii.quantity), 0) as items
    FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY i.user_id
  `, [range.start, range.end]);

  const returnRows = q(`
    SELECT sr.user_id, COALESCE(SUM(sr.total), 0) as returns
    FROM sale_returns sr
    WHERE sr.created_at >= ? AND sr.created_at <= ?
    GROUP BY sr.user_id
  `, [range.start, range.end]);

  const itemsMap = {};
  itemRows.forEach(r => { itemsMap[r.user_id] = r.items; });
  const retMap = {};
  returnRows.forEach(r => { retMap[r.user_id] = r.returns; });

  return {
    rows: rows.map(r => {
      const sales = parseFloat(r.sales) || 0;
      const returns = parseFloat(retMap[r.user_id]) || 0;
      return {
        cashier: r.cashier,
        bills: r.bills,
        items: r2(itemsMap[r.user_id] || 0),
        sales: r2(sales),
        discount: r2(r.discount),
        returns: r2(returns),
        net_sales: r2(sales - returns),
        avg_bill: r.bills ? r2(sales / r.bills) : 0
      };
    })
  };
}

function paymentWise(range) {
  const rows = q(`
    SELECT COALESCE(i.payment_method, 'Cash') as method,
      COUNT(*) as bills, COALESCE(SUM(i.total), 0) as amount
    FROM invoices i
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY method ORDER BY amount DESC
  `, [range.start, range.end]);

  const grand = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  return {
    rows: rows.map(r => ({
      method: r.method,
      bills: r.bills,
      amount: r2(r.amount),
      percent: grand > 0 ? r2(parseFloat(r.amount) * 100 / grand) : 0
    }))
  };
}

function hourly(range) {
  const rows = q(`
    SELECT CAST(${HOUR_EXPR('i')} AS INTEGER) as hour,
      COUNT(*) as bills, COALESCE(SUM(i.total), 0) as sales
    FROM invoices i
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY hour ORDER BY hour
  `, [range.start, range.end]);

  const fmtHour = h => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
  return {
    rows: rows.map(r => ({
      hour: `${fmtHour(r.hour)} - ${fmtHour((r.hour + 1) % 24)}`,
      bills: r.bills,
      sales: r2(r.sales),
      avg_bill: r.bills ? r2(parseFloat(r.sales) / r.bills) : 0
    }))
  };
}

function discounts(range, query) {
  const params = [range.start, range.end];
  const base = `FROM invoices i LEFT JOIN users u ON i.user_id = u.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.discount > 0 AND i.status <> 'cancelled'`;
  return pagedQuery(
    `SELECT COUNT(*) as total ${base}`,
    `SELECT i.invoice_no, i.created_at, COALESCE(u.username, '') as cashier,
      i.party_name as customer, i.subtotal, i.discount,
      CASE WHEN i.subtotal > 0 THEN ROUND(i.discount * 100.0 / i.subtotal, 2) ELSE 0 END as discount_pct,
      i.total ${base} ORDER BY i.discount DESC, i.id DESC`,
    params, query
  );
}

function cancelled(range, query) {
  const params = [range.start, range.end];
  const base = `FROM invoices i
    LEFT JOIN users u ON i.user_id = u.id
    LEFT JOIN users cb ON i.cancelled_by = cb.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status = 'cancelled'`;
  return pagedQuery(
    `SELECT COUNT(*) as total ${base}`,
    `SELECT i.invoice_no, i.created_at, COALESCE(u.username, '') as cashier,
      i.party_name as customer, i.total, i.paid,
      COALESCE(cb.username, '') as cancelled_by, i.cancelled_at, i.cancel_reason
      ${base} ORDER BY i.id DESC`,
    params, query
  );
}

function returnsReport(range, query) {
  const params = [range.start, range.end];
  const base = `FROM sale_return_items sri
    JOIN sale_returns sr ON sri.return_id = sr.id
    JOIN invoices i ON sr.invoice_id = i.id
    LEFT JOIN invoice_items ii ON sri.invoice_item_id = ii.id
    LEFT JOIN users u ON sr.user_id = u.id
    WHERE sr.created_at >= ? AND sr.created_at <= ?`;
  return pagedQuery(
    `SELECT COUNT(*) as total ${base}`,
    `SELECT sr.return_no, i.invoice_no, sr.created_at,
      COALESCE(i.party_name, 'Walk-in Customer') as customer,
      COALESCE(ii.name, '') as item, sri.quantity, sri.amount,
      COALESCE(sr.reason, '') as reason, COALESCE(u.username, '') as processed_by
      ${base} ORDER BY sr.id DESC, sri.id`,
    params, query
  );
}

module.exports = {
  summary,
  dayWise,
  billWise,
  itemWise,
  categoryWise,
  customerWise,
  cashierWise,
  paymentWise,
  hourly,
  discounts,
  cancelled,
  returnsReport
};
