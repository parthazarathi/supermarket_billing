// Read-only purchase tools (manager+). Supplier names are business data;
// contact details are still minimized in tool payloads.
const purchaseReports = require('../../reporting/purchases');
const { getParty } = require('../../parties');
const { q, r2, likeParam } = require('../../reportUtils');
const { rangeFromArgs } = require('../context');
const reorderTools = require('./inventory');

function getRecentPurchases(args) {
  const range = rangeFromArgs(args.period ? args : { period: 'last_30_days' });
  const result = purchaseReports.invoices(range, { q: String(args.query || ''), per_page: 15 });
  return {
    from: range.from,
    to: range.to,
    total: result.total,
    rows: result.rows.map((r) => ({
      purchase_no: r.purchase_no,
      date: r.created_at,
      supplier: r.supplier,
      total: r.total,
      paid: r.paid,
      balance: r.balance,
      status: r.status
    }))
  };
}

function getPurchaseSummary(args) {
  const range = rangeFromArgs(args);
  const s = purchaseReports.summary(range).summary;
  return {
    from: range.from,
    to: range.to,
    purchase_count: s.invoices,
    total_purchases: s.total,
    paid: s.paid,
    returns: s.returns,
    net_purchases: s.net_purchase,
    outstanding_to_suppliers: s.outstanding
  };
}

function getSupplierInformation(args) {
  const term = String(args.query || args.name || '').trim();
  const range = rangeFromArgs(args.period ? args : { period: 'last_30_days' });
  let party = null;
  if (term) {
    const found = q(
      `SELECT id FROM parties WHERE type = 'supplier' AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 1`,
      [likeParam(term)]
    );
    if (found.length) party = getParty(found[0].id);
  }
  if (party) {
    const purch = q(
      `SELECT COUNT(*) as invoices, COALESCE(SUM(total),0) as amount FROM purchases WHERE party_id = ? AND created_at >= ? AND created_at <= ?`,
      [party.id, range.start, range.end]
    )[0] || { invoices: 0, amount: 0 };
    return {
      found: true,
      supplier: party.name,
      outstanding_payable: r2(party.outstanding),
      purchases_in_range: r2(purch.amount),
      purchase_count: purch.invoices,
      from: range.from,
      to: range.to
    };
  }
  // No name given: list supplier-wise purchase totals for the range.
  const d = purchaseReports.supplierWise(range);
  return {
    found: false,
    note: term ? 'Supplier not found - showing supplier totals instead' : 'Supplier totals',
    from: range.from,
    to: range.to,
    rows: d.rows.slice(0, 15)
  };
}

function getSupplierOutstanding() {
  const d = require('../../reporting/parties').supplierOutstanding();
  return {
    total_payable: d.summary.total_outstanding,
    rows: d.rows.slice(0, 25).map((r) => ({ supplier: r.supplier, outstanding: r.outstanding }))
  };
}

// Purchase suggestion = reorder suggestions + supplier grouping hint.
// Recommendations only - nothing is written to purchase_orders.
function generatePurchaseSuggestion(args) {
  const suggestions = reorderTools.calculateReorderSuggestions(args);
  return {
    ...suggestions,
    note: 'AI-generated purchase suggestions - review and create purchase orders manually. Nothing was ordered.',
    action_required: 'Review the list in Purchases and create a purchase order for the quantities you approve.'
  };
}

module.exports = {
  getRecentPurchases,
  getPurchaseSummary,
  getSupplierInformation,
  getSupplierOutstanding,
  generatePurchaseSuggestion
};
