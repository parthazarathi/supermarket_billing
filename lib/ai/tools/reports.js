// Composite report tools - compact business summaries the assistant uses for
// "how is my store doing" questions and factual why-analysis.
const financeReports = require('../../reporting/finance');
const salesReports = require('../../reporting/sales');
const { salesAggregates, expenseAggregates } = require('../../reporting/common');
const partyReports = require('../../reporting/parties');
const inventoryReports = require('../../reporting/inventory');
const { r2 } = require('../../reportUtils');
const { rangeFromArgs, namedRange } = require('../context');
const inventoryTools = require('./inventory');

function generateSalesSummary(args) {
  const range = rangeFromArgs(args);
  const s = salesAggregates(range);
  const topItems = salesReports.itemWise(range).rows
    .sort((a, b) => b.sales - a.sales).slice(0, 5)
    .map((r) => ({ item: r.item, qty: r.qty, sales: r.sales }));
  const topCats = salesReports.categoryWise(range).rows.slice(0, 5)
    .map((r) => ({ category: r.category, sales: r.sales, margin: r.margin }));
  return {
    from: range.from,
    to: range.to,
    total_sales: s.grand_total,
    net_sales: s.net_sales,
    bills: s.bills,
    average_bill: s.avg_bill,
    items_sold: s.items_sold,
    discounts: s.discounts,
    returns: s.sales_returns,
    collected: s.paid,
    credit_sales: r2(s.grand_total - s.paid),
    top_items: topItems,
    top_categories: topCats
  };
}

function generateProfitSummary(args) {
  const range = rangeFromArgs(args);
  const pl = financeReports.profitLoss(range).summary;
  return { from: range.from, to: range.to, ...pl };
}

// Full daily business summary: sales, profit, stock alerts, credit - the
// data behind "give me a summary of my store" and the dashboard widget.
function generateDailyBusinessSummary(args) {
  const range = rangeFromArgs((args && (args.period || args.from || args.date)) ? args : { period: 'today' });
  const s = salesAggregates(range);
  const e = expenseAggregates(range);
  const cust = partyReports.customerOutstanding();
  const low = inventoryReports.lowStock().rows.length;
  const out = inventoryReports.outOfStock().rows.length;

  // Same-day comparison against the immediately previous day when the range
  // is a single day (today/yesterday questions).
  let prev = null;
  if (range.from === range.to) {
    const d = new Date(`${range.from}T00:00:00`);
    d.setDate(d.getDate() - 1);
    const p = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const prevAgg = salesAggregates(require('../../reportUtils').parseRange({ from: p, to: p }));
    prev = {
      day: p,
      total_sales: prevAgg.grand_total,
      bills: prevAgg.bills,
      change_percent: prevAgg.grand_total > 0 ? r2(((s.grand_total - prevAgg.grand_total) / prevAgg.grand_total) * 100) : null
    };
  }

  return {
    from: range.from,
    to: range.to,
    sales: {
      total: s.grand_total,
      net: s.net_sales,
      bills: s.bills,
      average_bill: s.avg_bill,
      items_sold: s.items_sold
    },
    profit: {
      gross: s.gross_profit,
      expenses: e.total,
      net: r2(s.gross_profit - e.total)
    },
    inventory: {
      low_stock_products: low,
      out_of_stock_products: out
    },
    credit: {
      customer_outstanding: cust.summary.total_outstanding,
      customers_with_dues: cust.rows.length
    },
    previous_day: prev
  };
}

// Factual inputs for "why are sales lower" analysis - the assistant narrates
// these numbers; it must never invent causes beyond what the data shows.
function getSalesDropAnalysis() {
  const cur = namedRange('this_week');
  const prev = namedRange('last_week');
  const curAgg = salesAggregates(cur);
  const prevAgg = salesAggregates(prev);

  const curCats = {};
  salesReports.categoryWise(cur).rows.forEach((r) => { curCats[r.category] = r; });
  const prevCats = {};
  salesReports.categoryWise(prev).rows.forEach((r) => { prevCats[r.category] = r; });
  const catCompare = Object.keys({ ...curCats, ...prevCats }).map((c) => {
    const a = curCats[c] || { sales: 0 };
    const b = prevCats[c] || { sales: 0 };
    const diff = r2(a.sales - b.sales);
    return {
      category: c,
      this_week: a.sales,
      last_week: b.sales,
      change: diff,
      change_percent: b.sales > 0 ? r2((diff / b.sales) * 100) : null
    };
  }).sort((x, y) => x.change - y.change).slice(0, 8);

  return {
    this_week: { from: cur.from, to: cur.to, sales: curAgg.grand_total, bills: curAgg.bills, avg_bill: curAgg.avg_bill, items_sold: curAgg.items_sold },
    last_week: { from: prev.from, to: prev.to, sales: prevAgg.grand_total, bills: prevAgg.bills, avg_bill: prevAgg.avg_bill, items_sold: prevAgg.items_sold },
    change: {
      sales: r2(curAgg.grand_total - prevAgg.grand_total),
      percent: prevAgg.grand_total > 0 ? r2(((curAgg.grand_total - prevAgg.grand_total) / prevAgg.grand_total) * 100) : null,
      bills: curAgg.bills - prevAgg.bills,
      avg_bill: r2(curAgg.avg_bill - prevAgg.avg_bill)
    },
    category_changes: catCompare,
    note: 'Only causes visible in this data may be stated - do not speculate beyond these numbers.'
  };
}

function generateInventorySummary() {
  return inventoryTools.getInventorySummary();
}

module.exports = {
  generateSalesSummary,
  generateProfitSummary,
  generateDailyBusinessSummary,
  getSalesDropAnalysis,
  generateInventorySummary
};
