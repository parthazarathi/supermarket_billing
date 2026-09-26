const { withTransaction, execToObject, execToObjects } = require('./database');

function listParties(partyType = '') {
  let query = 'SELECT * FROM parties WHERE 1=1';
  const params = [];

  if (partyType) {
    query += ' AND type = ?';
    params.push(partyType);
  }

  query += ' ORDER BY name';

  const parties = execToObjects(query, params);

  // Calculate outstanding for each party
  for (const party of parties) {
    party.outstanding = calculatePartyOutstanding(party);
  }

  return parties;
}

function getParty(partyId) {
  const party = execToObject('SELECT * FROM parties WHERE id = ?', [partyId]);
  if (party) {
    party.outstanding = calculatePartyOutstanding(party);
  }
  return party;
}

const WALK_IN_CUSTOMER_NAME = 'Walk-in Customer';

// The default counter-sale customer. Older walk-in bills were stored with no
// party at all, so this may need to create the row on legacy databases.
function getOrCreateWalkInParty(db) {
  const party = execToObject(
    "SELECT * FROM parties WHERE type = 'customer' AND LOWER(TRIM(name)) IN ('walk-in customer', 'walk-in') ORDER BY CASE WHEN LOWER(TRIM(name)) = 'walk-in customer' THEN 0 ELSE 1 END, id LIMIT 1"
  );
  if (party) {
    return party;
  }
  const now = new Date().toISOString();
  db.run(
    'INSERT INTO parties (name, phone, type, gstin, opening_balance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [WALK_IN_CUSTOMER_NAME, '', 'customer', '', 0, now, now]
  );
  return execToObject('SELECT * FROM parties WHERE id = last_insert_rowid()');
}

function listPartyBills(party, includeProfit = false) {
  if (party.type === 'supplier') {
    return execToObjects(
      'SELECT id, purchase_no AS bill_no, created_at, total, paid FROM purchases WHERE party_id = ? ORDER BY id DESC',
      [party.id]
    );
  }
  if (!includeProfit) {
    return execToObjects(
      'SELECT id, invoice_no AS bill_no, created_at, total, paid, status FROM invoices WHERE party_id = ? ORDER BY id DESC',
      [party.id]
    );
  }
  return execToObjects(`
    WITH costs AS (
      SELECT invoice_id, SUM(quantity * COALESCE(purchase_price, 0)) AS cogs
      FROM invoice_items GROUP BY invoice_id
    ), returned AS (
      SELECT sr.invoice_id,
        SUM(sri.amount / (1 + COALESCE(ii.gst_percent, 0) / 100.0)) AS return_net,
        SUM(sri.quantity * COALESCE(ii.purchase_price, 0)) AS return_cost
      FROM sale_returns sr
      JOIN sale_return_items sri ON sri.return_id = sr.id
      LEFT JOIN invoice_items ii ON ii.id = sri.invoice_item_id
      GROUP BY sr.invoice_id
    )
    SELECT i.id, i.invoice_no AS bill_no, i.created_at, i.total, i.paid, i.status,
      CASE WHEN i.status = 'cancelled' THEN 0 ELSE ROUND(
        (i.subtotal - i.discount - COALESCE(r.return_net, 0))
        - (COALESCE(c.cogs, 0) - COALESCE(r.return_cost, 0)), 2
      ) END AS profit
    FROM invoices i
    LEFT JOIN costs c ON c.invoice_id = i.id
    LEFT JOIN returned r ON r.invoice_id = i.id
    WHERE i.party_id = ? ORDER BY i.id DESC
  `, [party.id]);
}

// Full account history for a party, oldest first, with a running balance.
// Customers: debit = billed (they owe more), credit = received/credited.
// Suppliers: credit = billed (we owe more), debit = paid/adjusted.
// The final balance equals the party outstanding.
function partyLedger(party, includeProfit = false) {
  const isSupplier = party.type === 'supplier';
  const events = [];

  // Bill-linked payment rows settle bills created earlier, so each linked
  // payment gets its own dated entry. The remainder of the bill's paid amount
  // was collected at billing and is folded into the bill row's Received/Paid
  // column instead of a separate "Paid at billing" entry.
  const linked = {};
  execToObjects(
    "SELECT ref_id, SUM(amount) AS amt FROM payments WHERE party_id = ? AND ref_type = ? AND ref_id IS NOT NULL GROUP BY ref_id",
    [party.id, isSupplier ? 'purchase' : 'invoice']
  ).forEach(r => { linked[r.ref_id] = parseFloat(r.amt) || 0; });

  for (const bill of listPartyBills(party, includeProfit)) {
    const paid = parseFloat(bill.paid) || 0;
    const cancelled = !isSupplier && bill.status === 'cancelled';
    const status = isSupplier
      ? paid >= parseFloat(bill.total) - 0.009 ? 'paid' : paid > 0 ? 'partial' : 'unpaid'
      : bill.status;
    const paidAtBilling = Math.max(0, paid - (linked[bill.id] || 0));
    events.push({
      date: bill.created_at,
      type: isSupplier ? 'Purchase' : 'Sale',
      ref: bill.bill_no,
      bill_id: bill.id,
      status,
      profit: bill.profit,
      debit: isSupplier ? paidAtBilling : bill.total,
      credit: isSupplier ? bill.total : paidAtBilling,
      kind: 'bill',
      seq: 0
    });
    if (cancelled) {
      events.push({ date: bill.created_at, type: 'Cancelled', ref: bill.bill_no, debit: 0, credit: bill.total, kind: 'cancelled', seq: 2 });
    }
  }

  execToObjects('SELECT * FROM payments WHERE party_id = ? ORDER BY created_at, id', [party.id]).forEach(p => {
    const amt = parseFloat(p.amount) || 0;
    if (p.ref_type === 'sale_return' || p.ref_type === 'invoice_refund') {
      events.push({ date: p.created_at, type: 'Refund', ref: p.note || 'Refund', debit: amt, credit: 0, kind: 'refund', seq: 1 });
    } else if (p.ref_type === 'purchase_return') {
      events.push({ date: p.created_at, type: 'Refund received', ref: p.note || 'Refund', debit: 0, credit: amt, kind: 'refund', seq: 1 });
    } else {
      events.push({
        date: p.created_at,
        type: isSupplier ? 'Payment' : 'Receipt',
        ref: p.note || 'Payment',
        debit: isSupplier ? amt : 0,
        credit: isSupplier ? 0 : amt,
        kind: 'payment',
        seq: 1
      });
    }
  });

  if (isSupplier) {
    execToObjects('SELECT return_no, total, created_at FROM purchase_returns WHERE party_id = ?', [party.id])
      .forEach(r => events.push({ date: r.created_at, type: 'Purchase return', ref: r.return_no, debit: r.total, credit: 0, kind: 'return', seq: 1 }));
  } else {
    execToObjects(
      'SELECT sr.return_no, sr.total, sr.created_at FROM sale_returns sr JOIN invoices i ON sr.invoice_id = i.id WHERE i.party_id = ?',
      [party.id]
    ).forEach(r => events.push({ date: r.created_at, type: 'Sales return', ref: r.return_no, debit: 0, credit: r.total, kind: 'return', seq: 1 }));
  }

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.seq || 0) - (b.seq || 0)));

  const opening = parseFloat(party.opening_balance) || 0;
  let balance = opening;
  const rows = [{ date: '', type: 'Opening balance', ref: '', debit: 0, credit: 0, balance: Math.round(balance * 100) / 100, kind: 'opening' }];
  for (const e of events) {
    balance += isSupplier ? (parseFloat(e.credit) - parseFloat(e.debit)) : (parseFloat(e.debit) - parseFloat(e.credit));
    rows.push({ ...e, debit: Math.round(e.debit * 100) / 100, credit: Math.round(e.credit * 100) / 100, balance: Math.round(balance * 100) / 100 });
  }
  return rows;
}

function outstandingBreakdown(party) {
  const partyId = party.id;
  const opening = parseFloat(party.opening_balance) || 0;
  let bills = 0;
  let returnCredit = 0;

  if (party.type === 'supplier') {
    const result = execToObject('SELECT COALESCE(SUM(total - paid), 0) as due FROM purchases WHERE party_id = ?', [partyId]);
    if (result) {
      bills = parseFloat(result.due) || 0;
    }
    const ret = execToObject('SELECT COALESCE(SUM(pr.total - pr.refund_amount), 0) as credit FROM purchase_returns pr WHERE pr.party_id = ?', [partyId]);
    if (ret) {
      returnCredit = parseFloat(ret.credit) || 0;
    }
  } else {
    const result = execToObject("SELECT COALESCE(SUM(total - paid), 0) as due FROM invoices WHERE party_id = ? AND status <> 'cancelled'", [partyId]);
    if (result) {
      bills = parseFloat(result.due) || 0;
    }
    const ret = execToObject(`SELECT COALESCE(SUM(sr.total - sr.refund_amount), 0) as credit
      FROM sale_returns sr JOIN invoices i ON sr.invoice_id = i.id WHERE i.party_id = ?`, [partyId]);
    if (ret) {
      returnCredit = parseFloat(ret.credit) || 0;
    }
  }

  // Only standalone receipts reduce outstanding - invoice-linked payments are
  // already reflected in invoices.paid, and refund rows (sale_return,
  // purchase_return, invoice_refund) are netted inside the return credit.
  const paymentResult = execToObject(
    "SELECT COALESCE(SUM(amount), 0) as paid FROM payments WHERE party_id = ? AND (ref_type = 'standalone' OR (ref_type = '' AND note NOT LIKE 'Invoice %'))",
    [partyId]
  );
  const paidExtra = paymentResult ? parseFloat(paymentResult.paid) || 0 : 0;

  return {
    opening_balance: Math.round(opening * 100) / 100,
    bills_due: Math.round(bills * 100) / 100,
    return_credit: Math.round(returnCredit * 100) / 100,
    standalone_paid: Math.round(paidExtra * 100) / 100,
    outstanding: Math.round((opening + bills - returnCredit - paidExtra) * 100) / 100
  };
}

function calculatePartyOutstanding(party) {
  return outstandingBreakdown(party).outstanding;
}

function saveParty(data, partyId = null) {
  const name = (data.name || '').trim();
  if (!name) {
    throw new Error('Party name is required');
  }

  const validTypes = ['customer', 'supplier'];
  const partyType = validTypes.includes(data.type) ? data.type : 'customer';
  const phone = data.phone || '';
  const email = data.email || '';
  const gstin = data.gstin || '';
  const pan = data.pan || '';
  const address = data.address || '';
  const city = data.city || '';
  const state = data.state || '';
  const pincode = data.pincode || '';
  const openingRaw = data.opening_balance;
  const openingBalance = (openingRaw === undefined || openingRaw === null || openingRaw === '') ? 0 : parseFloat(openingRaw);
  if (!isFinite(openingBalance) || openingBalance < 0) {
    throw new Error('Invalid opening balance');
  }
  const creditRaw = data.credit_limit;
  const creditLimit = (creditRaw === undefined || creditRaw === null || creditRaw === '') ? 0 : parseFloat(creditRaw);
  if (!isFinite(creditLimit) || creditLimit < 0) {
    throw new Error('Invalid credit limit');
  }
  const creditDays = parseInt(data.credit_days) || 30;
  const billingName = data.billing_name || '';
  const billingAddress = data.billing_address || '';
  const billingGstin = data.billing_gstin || '';

  // Reject duplicate names (case-insensitive) within the same party type
  const dup = execToObject(
    'SELECT id FROM parties WHERE type = ? AND LOWER(TRIM(name)) = LOWER(?) AND id <> ?',
    [partyType, name, partyId || -1]
  );
  if (dup) {
    throw new Error(`A ${partyType} with this name already exists`);
  }

  return withTransaction((db) => {
    const now = new Date().toISOString();
    if (partyId) {
      db.run('UPDATE parties SET name=?, phone=?, email=?, type=?, gstin=?, pan=?, address=?, city=?, state=?, pincode=?, opening_balance=?, credit_limit=?, credit_days=?, billing_name=?, billing_address=?, billing_gstin=?, updated_at=? WHERE id=?',
        [name, phone, email, partyType, gstin, pan, address, city, state, pincode, openingBalance, creditLimit, creditDays, billingName, billingAddress, billingGstin, now, partyId]);
      return getParty(partyId);
    } else {
      db.run('INSERT INTO parties (name, phone, email, type, gstin, pan, address, city, state, pincode, opening_balance, credit_limit, credit_days, billing_name, billing_address, billing_gstin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [name, phone, email, partyType, gstin, pan, address, city, state, pincode, openingBalance, creditLimit, creditDays, billingName, billingAddress, billingGstin, now, now]);
      const result = execToObject('SELECT * FROM parties WHERE id = last_insert_rowid()');
      if (result) {
        result.outstanding = calculatePartyOutstanding(result);
      }
      return result;
    }
  });
}

function deleteParty(partyId) {
  return withTransaction((db) => {
    const refs = execToObject(
      `SELECT (SELECT COUNT(*) FROM invoices WHERE party_id = ?) +
              (SELECT COUNT(*) FROM purchases WHERE party_id = ?) +
              (SELECT COUNT(*) FROM payments WHERE party_id = ?) as refs`,
      [partyId, partyId, partyId]
    );
    if (refs && refs.refs > 0) {
      throw new Error('Party has transaction history and cannot be deleted');
    }
    db.run('DELETE FROM parties WHERE id = ?', [partyId]);
  });
}

function addPartyPayment(partyId, amount, method = 'Cash', note = '', userId = null) {
  const now = new Date().toISOString();

  const amountNum = parseFloat(amount);
  if (!isFinite(amountNum) || amountNum <= 0) {
    throw new Error('Invalid payment amount');
  }

  const validMethods = ['Cash', 'UPI', 'Card', 'Bank Transfer'];
  if (!validMethods.includes(method)) {
    throw new Error('Invalid payment method');
  }

  return withTransaction((db) => {
    // Check if party exists
    const party = execToObject('SELECT * FROM parties WHERE id = ?', [partyId]);
    if (!party) {
      throw new Error('Party not found');
    }

    const isSupplier = party.type === 'supplier';
    // Money in from customers, money out to suppliers
    const direction = isSupplier ? 'out' : 'in';
    const uid = userId === null || userId === undefined ? null : parseInt(userId, 10);
    let remaining = amountNum;
    const applied = [];

    // Apply the amount to pending bills first, oldest bill first. Linked
    // payment rows are excluded from the standalone sum in
    // outstandingBreakdown() so they are not double-counted.
    const billStmt = isSupplier
      ? db.prepare('SELECT id, purchase_no AS bill_no, total, paid FROM purchases WHERE party_id = ? AND total - paid > 0.009 ORDER BY id ASC')
      : db.prepare("SELECT id, invoice_no AS bill_no, total, paid FROM invoices WHERE party_id = ? AND status <> 'cancelled' AND total - paid > 0.009 ORDER BY id ASC");
    billStmt.bind([partyId]);
    while (billStmt.step() && remaining > 0.009) {
      const bill = billStmt.getAsObject();
      const due = parseFloat(bill.total) - parseFloat(bill.paid);
      const portion = Math.min(remaining, due);
      const newPaid = Math.round((parseFloat(bill.paid) + portion) * 100) / 100;
      if (isSupplier) {
        db.run('UPDATE purchases SET paid = ? WHERE id = ?', [newPaid, bill.id]);
      } else {
        const status = newPaid >= parseFloat(bill.total) - 0.009 ? 'paid' : 'partial';
        db.run('UPDATE invoices SET paid = ?, status = ?, payment_method = ? WHERE id = ?', [newPaid, status, method, bill.id]);
      }
      db.run(
        "INSERT INTO payments (party_id, amount, method, note, created_at, user_id, direction, ref_type, ref_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [partyId, Math.round(portion * 100) / 100, method, `${isSupplier ? 'Purchase' : 'Invoice'} ${bill.bill_no}`, now, uid, direction, isSupplier ? 'purchase' : 'invoice', bill.id]
      );
      applied.push({ bill_id: bill.id, bill_no: bill.bill_no, amount: Math.round(portion * 100) / 100 });
      remaining -= portion;
    }
    billStmt.free();

    // Anything left over after all bills are settled reduces the opening
    // balance / becomes an advance on the party account.
    let payment = null;
    if (remaining > 0.009) {
      db.run("INSERT INTO payments (party_id, amount, method, note, created_at, user_id, direction, ref_type) VALUES (?, ?, ?, ?, ?, ?, ?, 'standalone')",
        [partyId, Math.round(remaining * 100) / 100, method, note || '', now, uid, direction]);
      payment = execToObject('SELECT * FROM payments WHERE id = last_insert_rowid()');
    }

    return { payment, applied, advance: Math.round(Math.max(0, remaining) * 100) / 100 };
  });
}

function checkCreditLimit(partyId, additionalAmount = 0) {
  const party = getParty(partyId);
  if (!party) {
    throw new Error('Party not found');
  }

  const creditLimit = parseFloat(party.credit_limit) || 0;
  const outstanding = parseFloat(party.outstanding) || 0;
  const newOutstanding = outstanding + parseFloat(additionalAmount);

  return {
    withinLimit: creditLimit === 0 || newOutstanding <= creditLimit,
    currentOutstanding: outstanding,
    creditLimit: creditLimit,
    remainingCredit: Math.max(0, creditLimit - outstanding),
    newOutstanding: newOutstanding,
    exceedsBy: Math.max(0, newOutstanding - creditLimit)
  };
}

module.exports = {
  WALK_IN_CUSTOMER_NAME,
  listParties,
  getParty,
  getOrCreateWalkInParty,
  listPartyBills,
  partyLedger,
  outstandingBreakdown,
  saveParty,
  deleteParty,
  addPartyPayment,
  checkCreditLimit
};
