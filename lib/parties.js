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

function calculatePartyOutstanding(party) {
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

  return Math.round((opening + bills - returnCredit - paidExtra) * 100) / 100;
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

    // Money in from customers, money out to suppliers
    const direction = party.type === 'supplier' ? 'out' : 'in';
    const uid = userId === null || userId === undefined ? null : parseInt(userId, 10);

    db.run("INSERT INTO payments (party_id, amount, method, note, created_at, user_id, direction, ref_type) VALUES (?, ?, ?, ?, ?, ?, ?, 'standalone')",
      [partyId, amountNum, method, note || '', now, uid, direction]);

    return execToObject('SELECT * FROM payments WHERE id = last_insert_rowid()');
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
  listParties,
  getParty,
  saveParty,
  deleteParty,
  addPartyPayment,
  checkCreditLimit
};
