// Read-only sales tools. All figures reuse lib/reporting aggregates - the
// same math the dashboard and reports use, never hand-rolled SQL.
const { salesAggregates } = require('../../reporting/common');
const salesReports = require('../../reporting/sales');
const { r2, parseRange } = require('../../reportUtils');
const { namedRange, rangeFromArgs, dateFromArg } = require('../context');

function salesPayload(range) {
  const s = salesAggregates(range);
  return {
    from: range.from,
    to: range.to,
    total_sales: s.grand_total,
    net_sales: s.net_sales,
    bill_count: s.bills,
    average_bill_value: s.avg_bill,
    items_sold: s.items_sold,
    discounts: s.discounts,
    tax_collected: s.tax,
    sales_returns: s.sales_returns,
    collected: s.paid
  };
}

function getSalesSummary(args) {
  return salesPayload(rangeFromArgs(args));
}

function getSalesByDate(args) {
  const d = dateFromArg(args.date);
  return salesPayload(parseRange({ from: d, to: d }));
}

function getSalesComparison(args) {
  const a = namedRange(args.period_a || 'this_week') || rangeFromArgs(args.period_a || {});
  const b = namedRange(args.period_b || 'last_week') || rangeFromArgs(args.period_b || {});
  const cur = salesAggregates(a);
  const prev = salesAggregates(b);
  const delta = cur.grand_total - prev.grand_total;
  return {
    period_a: { from: a.from, to: a.to, total_sales: cur.grand_total, bills: cur.bills, avg_bill: cur.avg_bill },
    period_b: { from: b.from, to: b.to, total_sales: prev.grand_total, bills: prev.bills, avg_bill: prev.avg_bill },
    change_amount: r2(delta),
    change_percent: prev.grand_total > 0 ? r2((delta / prev.grand_total) * 100) : null,
    bill_change: cur.bills - prev.bills,
    avg_bill_change: r2(cur.avg_bill - prev.avg_bill)
  };
}

function getTopSellingProducts(args) {
  const range = rangeFromArgs(args);
  const limit = Math.min(25, Math.max(1, parseInt(args.limit, 10) || 10));
  const rows = salesReports.itemWise(range).rows
    .sort((x, y) => y.qty - x.qty)
    .slice(0, limit)
    .map((r, i) => ({ rank: i + 1, item: r.item, category: r.category, qty: r.qty, sales: r.sales, profit: r.profit }));
  return { from: range.from, to: range.to, rows };
}

function getSalesByCategory(args) {
  const range = rangeFromArgs(args);
  return { from: range.from, to: range.to, rows: salesReports.categoryWise(range).rows };
}

function getDailySalesBreakdown(args) {
  const range = rangeFromArgs(args);
  return { from: range.from, to: range.to, rows: salesReports.dayWise(range).rows };
}

function getPaymentCollection(args) {
  const financeReports = require('../../reporting/finance');
  const range = rangeFromArgs(args);
  const p = financeReports.paymentSummary(range);
  return { from: range.from, to: range.to, methods: p.rows, collected: p.summary.collected, credit_sales: p.summary.credit_sales };
}

module.exports = {
  getSalesSummary,
  getSalesByDate,
  getSalesComparison,
  getTopSellingProducts,
  getSalesByCategory,
  getDailySalesBreakdown,
  getPaymentCollection
};
