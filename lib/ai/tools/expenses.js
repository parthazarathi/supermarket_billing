// Read-only expense tools (manager+ - mirrors /api/expenses route guard).
const financeReports = require('../../reporting/finance');
const { expenseAggregates } = require('../../reporting/common');
const { rangeFromArgs } = require('../context');

function getExpenses(args) {
  const range = rangeFromArgs(args);
  const result = financeReports.expenseReport(range, {
    q: String(args.query || ''),
    per_page: 20
  });
  return {
    from: range.from,
    to: range.to,
    total_amount: result.summary.total,
    entry_count: result.total,
    rows: result.rows.map((r) => ({
      date: r.created_at,
      category: r.category,
      description: r.description,
      amount: r.amount
    }))
  };
}

function getExpenseSummary(args) {
  const range = rangeFromArgs(args);
  const agg = expenseAggregates(range);
  const cats = financeReports.expenseCategories(range);
  return {
    from: range.from,
    to: range.to,
    total: agg.total,
    count: agg.count,
    by_category: cats.rows
  };
}

module.exports = { getExpenses, getExpenseSummary };
