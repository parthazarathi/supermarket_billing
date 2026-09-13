const { q, qOne, r2, pagedQuery, roundRows } = require('../reportUtils');

// Outstanding = opening + unpaid bills - net return credit - standalone payments.
// Invoice-linked payment rows (ref_type 'invoice' / legacy note 'Invoice %')
// are already reflected in invoices.paid, and refund payments are netted
// inside the return credit, so only standalone receipts count here.
const STANDALONE_PAYMENT_FILTER = "(ref_type = 'standalone' OR (ref_type = '' AND note NOT LIKE 'Invoice %'))";

function partyOutstanding(party) {
  const isSupplier = party.type === 'supplier';
  const bills = qOne(
    `SELECT COALESCE(SUM(total - paid), 0) as due FROM ${isSupplier ? 'purchases' : 'invoices'} WHERE party_id = ? ${isSupplier ? '' : "AND status <> 'cancelled'"}`,
    [party.id]
  );
  const returns = isSupplier
    ? qOne('SELECT COALESCE(SUM(pr.total - pr.refund_amount), 0) as credit FROM purchase_returns pr WHERE pr.party_id = ?', [party.id])
    : qOne(`SELECT COALESCE(SUM(sr.total - sr.refund_amount), 0) as credit
        FROM sale_returns sr JOIN invoices i ON sr.invoice_id = i.id WHERE i.party_id = ?`, [party.id]);
  const pays = qOne(
    `SELECT COALESCE(SUM(amount), 0) as paid FROM payments WHERE party_id = ? AND ${STANDALONE_PAYMENT_FILTER}`,
    [party.id]
  );
  return r2((parseFloat(party.opening_balance) || 0) + (parseFloat(bills.due) || 0)
    - (parseFloat(returns.credit) || 0) - (parseFloat(pays.paid) || 0));
}

function customerSummary(range) {
  const customers = q(`SELECT * FROM parties WHERE type = 'customer' ORDER BY name`);
  const sales = {};
  q(`
    SELECT i.party_id, COUNT(*) as bills, COALESCE(SUM(i.total),0) as sales,
      COALESCE(SUM(i.paid),0) as paid
    FROM invoices i
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled' AND i.party_id IS NOT NULL
    GROUP BY i.party_id
  `, [range.start, range.end]).forEach(r => { sales[r.party_id] = r; });

  const rows = customers.map(c => {
    const s = sales[c.id] || { bills: 0, sales: 0, paid: 0 };
    return {
      id: c.id,
      customer: c.name,
      phone: c.phone || '',
      bills: s.bills,
      sales: r2(s.sales),
      paid: r2(s.paid),
      outstanding: partyOutstanding(c)
    };
  });
  rows.sort((a, b) => b.sales - a.sales);
  return { rows };
}

function customerLedger(partyId, range) {
  const party = qOne(`SELECT * FROM parties WHERE id = ? AND type = 'customer'`, [partyId]);
  if (!party) throw new Error('Customer not found');

  const events = [];
  q(`
    SELECT i.created_at, i.cancelled_at, i.invoice_no, i.total, i.paid, i.status
    FROM invoices i WHERE i.party_id = ? ORDER BY i.created_at
  `, [partyId]).forEach(i => {
    events.push({ date: i.created_at, type: 'Sale', ref: i.invoice_no, debit: i.total, credit: 0 });
    const paidAtSale = parseFloat(i.paid) || 0;
    if (paidAtSale > 0) {
      events.push({ date: i.created_at, type: 'Payment', ref: i.invoice_no, debit: 0, credit: paidAtSale });
    }
    if (i.status === 'cancelled') {
      // Reversal entry keeps the ledger balanced: the bill no longer counts
      // toward outstanding, so the sale (and its refund, below) net to zero.
      events.push({ date: i.cancelled_at || i.created_at, type: 'Cancelled', ref: i.invoice_no, debit: 0, credit: i.total });
    }
  });

  q(`
    SELECT p.created_at, p.amount, p.note FROM payments p
    WHERE p.party_id = ? AND ${STANDALONE_PAYMENT_FILTER} ORDER BY p.created_at
  `, [partyId]).forEach(p => {
    events.push({ date: p.created_at, type: 'Receipt', ref: p.note || 'Payment', debit: 0, credit: p.amount });
  });

  // The return credit reduces what the customer owes; the cash-refunded part
  // is posted as a separate Refund debit (money paid back to the customer).
  q(`
    SELECT sr.created_at, sr.return_no, sr.total, sr.refund_amount FROM sale_returns sr
    JOIN invoices i ON sr.invoice_id = i.id WHERE i.party_id = ? ORDER BY sr.created_at
  `, [partyId]).forEach(r => {
    events.push({ date: r.created_at, type: 'Sales Return', ref: r.return_no, debit: 0, credit: r.total });
  });

  q(`
    SELECT p.created_at, p.amount, p.note FROM payments p
    WHERE p.party_id = ? AND p.ref_type IN ('sale_return', 'invoice_refund') ORDER BY p.created_at
  `, [partyId]).forEach(p => {
    events.push({ date: p.created_at, type: 'Refund', ref: p.note || 'Refund', debit: p.amount, credit: 0 });
  });

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const opening = parseFloat(party.opening_balance) || 0;
  let balance = opening;
  const rows = [
    { date: '', type: 'Opening Balance', ref: '', debit: opening > 0 ? r2(opening) : 0, credit: opening < 0 ? r2(-opening) : 0, balance: r2(balance) }
  ];
  events
    .filter(e => e.date >= range.start && e.date <= range.end)
    .forEach(e => {
      balance += (parseFloat(e.debit) || 0) - (parseFloat(e.credit) || 0);
      rows.push({ ...e, debit: r2(e.debit), credit: r2(e.credit), balance: r2(balance) });
    });

  return { party: { id: party.id, name: party.name, phone: party.phone }, rows };
}

function customerOutstanding() {
  const customers = q(`SELECT * FROM parties WHERE type = 'customer' ORDER BY name`);
  const rows = customers
    .map(c => ({
      id: c.id,
      customer: c.name,
      phone: c.phone || '',
      credit_limit: r2(c.credit_limit),
      outstanding: partyOutstanding(c)
    }))
    .filter(r => r.outstanding > 0)
    .sort((a, b) => b.outstanding - a.outstanding);
  return { rows, summary: { total_outstanding: r2(rows.reduce((s, r) => s + r.outstanding, 0)) } };
}

function customerHistory(partyId, range, query) {
  const party = qOne('SELECT * FROM parties WHERE id = ?', [partyId]);
  if (!party) throw new Error('Customer not found');
  const params = [partyId, range.start, range.end];
  const base = `FROM invoices i
    WHERE i.party_id = ? AND i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'`;
  const result = pagedQuery(
    `SELECT COUNT(*) as total ${base}`,
    `SELECT i.invoice_no, i.created_at, i.total, i.paid, i.payment_method, i.status,
      (SELECT COALESCE(SUM(ii.quantity),0) FROM invoice_items ii WHERE ii.invoice_id = i.id) as items
      ${base} ORDER BY i.id DESC`,
    params, query
  );
  result.party = { id: party.id, name: party.name, phone: party.phone };
  return result;
}

function topCustomers(range, limit = 20) {
  const rows = q(`
    SELECT COALESCE(NULLIF(i.party_name,''),'Walk-in Customer') as customer,
      COALESCE(pt.phone, i.party_phone, '') as phone,
      COUNT(*) as bills, COALESCE(SUM(i.total),0) as sales,
      COALESCE(SUM(i.total),0)/COUNT(*) as avg_bill
    FROM invoices i LEFT JOIN parties pt ON i.party_id = pt.id
    WHERE i.created_at >= ? AND i.created_at <= ? AND i.status <> 'cancelled'
    GROUP BY customer ORDER BY sales DESC LIMIT ?
  `, [range.start, range.end, limit]);
  return { rows: roundRows(rows.map((r, i) => ({ rank: i + 1, ...r }))) };
}

function supplierSummary(range) {
  const suppliers = q(`SELECT * FROM parties WHERE type = 'supplier' ORDER BY name`);
  const purch = {};
  q(`
    SELECT p.party_id, COUNT(*) as invoices, COALESCE(SUM(p.total),0) as amount,
      COALESCE(SUM(p.paid),0) as paid
    FROM purchases p
    WHERE p.created_at >= ? AND p.created_at <= ? AND p.party_id IS NOT NULL
    GROUP BY p.party_id
  `, [range.start, range.end]).forEach(r => { purch[r.party_id] = r; });

  const rows = suppliers.map(s => {
    const p = purch[s.id] || { invoices: 0, amount: 0, paid: 0 };
    return {
      id: s.id,
      supplier: s.name,
      phone: s.phone || '',
      invoices: p.invoices,
      purchases: r2(p.amount),
      paid: r2(p.paid),
      outstanding: partyOutstanding(s)
    };
  });
  rows.sort((a, b) => b.purchases - a.purchases);
  return { rows };
}

function supplierLedger(partyId, range) {
  const party = qOne(`SELECT * FROM parties WHERE id = ? AND type = 'supplier'`, [partyId]);
  if (!party) throw new Error('Supplier not found');

  const events = [];
  q(`SELECT p.created_at, p.purchase_no, p.total, p.paid FROM purchases p WHERE p.party_id = ? ORDER BY p.created_at`, [partyId])
    .forEach(p => {
      events.push({ date: p.created_at, type: 'Purchase', ref: p.purchase_no, debit: 0, credit: p.total });
      const paidNow = parseFloat(p.paid) || 0;
      if (paidNow > 0) events.push({ date: p.created_at, type: 'Payment', ref: p.purchase_no, debit: paidNow, credit: 0 });
    });

  q(`SELECT p.created_at, p.amount, p.note FROM payments p WHERE p.party_id = ? AND ${STANDALONE_PAYMENT_FILTER} ORDER BY p.created_at`, [partyId])
    .forEach(p => events.push({ date: p.created_at, type: 'Payment', ref: p.note || 'Payment', debit: p.amount, credit: 0 }));

  // The return reduces what we owe the supplier; money received back is a
  // separate 'Refund Received' credit so the net effect is total - refund.
  q(`SELECT pr.created_at, pr.return_no, pr.total, pr.refund_amount FROM purchase_returns pr WHERE pr.party_id = ? ORDER BY pr.created_at`, [partyId])
    .forEach(r => events.push({ date: r.created_at, type: 'Purchase Return', ref: r.return_no, debit: r.total, credit: 0 }));

  q(`SELECT p.created_at, p.amount, p.note FROM payments p WHERE p.party_id = ? AND p.ref_type = 'purchase_return' ORDER BY p.created_at`, [partyId])
    .forEach(p => events.push({ date: p.created_at, type: 'Refund Received', ref: p.note || 'Refund', debit: 0, credit: p.amount }));

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const opening = parseFloat(party.opening_balance) || 0;
  let balance = opening;
  const rows = [
    { date: '', type: 'Opening Balance', ref: '', debit: 0, credit: 0, balance: r2(balance) }
  ];
  events
    .filter(e => e.date >= range.start && e.date <= range.end)
    .forEach(e => {
      balance += (parseFloat(e.credit) || 0) - (parseFloat(e.debit) || 0);
      rows.push({ ...e, debit: r2(e.debit), credit: r2(e.credit), balance: r2(balance) });
    });

  return { party: { id: party.id, name: party.name, phone: party.phone }, rows };
}

function supplierOutstanding() {
  const suppliers = q(`SELECT * FROM parties WHERE type = 'supplier' ORDER BY name`);
  const rows = suppliers
    .map(s => ({ id: s.id, supplier: s.name, phone: s.phone || '', outstanding: partyOutstanding(s) }))
    .filter(r => r.outstanding > 0)
    .sort((a, b) => b.outstanding - a.outstanding);
  return { rows, summary: { total_outstanding: r2(rows.reduce((s, r) => s + r.outstanding, 0)) } };
}

function supplierPayments(range, query) {
  const params = [range.start, range.end];
  const base = `FROM payments p JOIN parties pt ON p.party_id = pt.id
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.created_at >= ? AND p.created_at <= ? AND pt.type = 'supplier'`;
  return pagedQuery(
    `SELECT COUNT(*) as total ${base}`,
    `SELECT p.id, p.created_at, pt.name as supplier, p.method, p.amount, p.note,
      COALESCE(u.username,'') as entered_by ${base} ORDER BY p.id DESC`,
    params, query
  );
}

function topSuppliers(range, limit = 20) {
  const rows = q(`
    SELECT COALESCE(NULLIF(p.party_name,''),'No supplier') as supplier,
      COUNT(*) as invoices, COALESCE(SUM(p.total),0) as amount
    FROM purchases p
    WHERE p.created_at >= ? AND p.created_at <= ?
    GROUP BY supplier ORDER BY amount DESC LIMIT ?
  `, [range.start, range.end, limit]);
  return { rows: roundRows(rows.map((r, i) => ({ rank: i + 1, ...r }))) };
}

module.exports = {
  customerSummary,
  customerLedger,
  customerOutstanding,
  customerHistory,
  topCustomers,
  supplierSummary,
  supplierLedger,
  supplierOutstanding,
  supplierPayments,
  topSuppliers
};
