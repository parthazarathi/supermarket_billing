// Read-only customer tools. PII minimization: tools return name + business
// figures only - phone/email/address stay out of provider payloads unless a
// question specifically needs them (none of these do).
const partyReports = require('../../reporting/parties');
const { getParty } = require('../../parties');
const { q, r2, likeParam } = require('../../reportUtils');
const { rangeFromArgs } = require('../context');

function searchCustomer(args) {
  const term = String(args.query || args.name || '').trim();
  if (!term) return { rows: [] };
  // Customers only - supplier payables stay behind the manager+ tools.
  const rows = q(
    `SELECT id, name, type, credit_limit FROM parties
     WHERE type = 'customer' AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 15`,
    [likeParam(term)]
  ).map((p) => {
    const party = getParty(p.id);
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      credit_limit: r2(p.credit_limit),
      outstanding: party ? r2(party.outstanding) : 0
    };
  });
  return { query: term, rows };
}

function getCustomerBalance(args) {
  const term = String(args.query || args.name || '').trim();
  const id = parseInt(args.customer_id, 10);
  let party = null;
  if (!isNaN(id)) party = getParty(id);
  if (!party && term) {
    const found = q(
      `SELECT id FROM parties WHERE type = 'customer' AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 1`,
      [likeParam(term)]
    );
    if (found.length) party = getParty(found[0].id);
  }
  if (!party || party.type !== 'customer') {
    return { found: false, note: 'Customer not found' };
  }
  return {
    found: true,
    customer: party.name,
    outstanding_balance: r2(party.outstanding),
    credit_limit: r2(party.credit_limit),
    credit_days: party.credit_days,
    over_limit: party.credit_limit > 0 ? r2(party.outstanding - party.credit_limit) : 0
  };
}

function getOutstandingCredit() {
  const d = partyReports.customerOutstanding();
  return {
    total_outstanding: d.summary.total_outstanding,
    customer_count: d.rows.length,
    rows: d.rows.slice(0, 25).map((r) => ({
      customer: r.customer,
      outstanding: r.outstanding,
      credit_limit: r.credit_limit
    }))
  };
}

function getTopCreditCustomers(args) {
  const limit = Math.min(25, Math.max(1, parseInt(args.limit, 10) || 10));
  const d = partyReports.customerOutstanding();
  return {
    total_outstanding: d.summary.total_outstanding,
    rows: d.rows.slice(0, limit).map((r, i) => ({
      rank: i + 1,
      customer: r.customer,
      outstanding: r.outstanding,
      credit_limit: r.credit_limit
    }))
  };
}

function getCustomerPurchaseHistory(args) {
  const term = String(args.query || args.name || '').trim();
  const id = parseInt(args.customer_id, 10);
  let partyId = !isNaN(id) ? id : null;
  if (partyId === null && term) {
    const found = q(
      `SELECT id FROM parties WHERE type = 'customer' AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 1`,
      [likeParam(term)]
    );
    if (found.length) partyId = found[0].id;
  }
  if (partyId === null) return { found: false, note: 'Customer not found' };
  const range = rangeFromArgs(args.period ? args : { period: 'last_30_days' });
  const hist = partyReports.customerHistory(partyId, range, { per_page: 15 });
  return {
    found: true,
    customer: hist.party.name,
    from: range.from,
    to: range.to,
    total_bills: hist.total,
    rows: hist.rows.map((r) => ({
      invoice_no: r.invoice_no,
      date: r.created_at,
      total: r.total,
      paid: r.paid,
      payment_method: r.payment_method,
      items: r.items
    }))
  };
}

function getTopCustomers(args) {
  const range = rangeFromArgs(args.period ? args : { period: 'this_month' });
  const limit = Math.min(25, Math.max(1, parseInt(args.limit, 10) || 10));
  const d = partyReports.topCustomers(range, limit);
  return {
    from: range.from,
    to: range.to,
    rows: d.rows.map((r) => ({
      rank: r.rank, customer: r.customer, bills: r.bills, sales: r.sales, avg_bill: r.avg_bill
    }))
  };
}

module.exports = {
  searchCustomer,
  getCustomerBalance,
  getOutstandingCredit,
  getTopCreditCustomers,
  getCustomerPurchaseHistory,
  getTopCustomers
};
