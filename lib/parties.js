const { getDatabase, withTransaction, execToObject, execToObjects } = require('./database');

function listParties(partyType = '') {
  let query = 'SELECT * FROM parties WHERE 1=1';

  if (partyType) {
    const safeType = partyType.replace(/'/g, "''");
    query += ` AND type = '${safeType}'`;
  }

  query += ' ORDER BY name';

  const parties = execToObjects(query);

  // Calculate outstanding for each party
  for (const party of parties) {
    party.outstanding = calculatePartyOutstanding(party);
  }

  return parties;
}

function getParty(partyId) {
  const party = execToObject(`SELECT * FROM parties WHERE id = ${partyId}`);
  if (party) {
    party.outstanding = calculatePartyOutstanding(party);
  }
  return party;
}

function calculatePartyOutstanding(party) {
  const partyId = party.id;
  const opening = parseFloat(party.opening_balance) || 0;
  let bills = 0;

  if (party.type === 'supplier') {
    const result = execToObject(`SELECT COALESCE(SUM(total - paid), 0) as due FROM purchases WHERE party_id = ${partyId}`);
    if (result) {
      bills = parseFloat(result.due) || 0;
    }
  } else {
    const result = execToObject(`SELECT COALESCE(SUM(total - paid), 0) as due FROM invoices WHERE party_id = ${partyId}`);
    if (result) {
      bills = parseFloat(result.due) || 0;
    }
  }

  const paymentResult = execToObject(`SELECT COALESCE(SUM(amount), 0) as paid FROM payments WHERE party_id = ${partyId}`);
  const paidExtra = paymentResult ? parseFloat(paymentResult.paid) || 0 : 0;

  return Math.round((opening + bills - paidExtra) * 100) / 100;
}

function saveParty(data, partyId = null) {
  const name = (data.name || '').trim().replace(/'/g, "''");
  if (!name) {
    throw new Error('Party name is required');
  }

  const validTypes = ['customer', 'supplier'];
  const partyType = validTypes.includes(data.type) ? data.type : 'customer';
  const phone = (data.phone || '').replace(/'/g, "''");
  const email = (data.email || '').replace(/'/g, "''");
  const gstin = (data.gstin || '').replace(/'/g, "''");
  const pan = (data.pan || '').replace(/'/g, "''");
  const address = (data.address || '').replace(/'/g, "''");
  const city = (data.city || '').replace(/'/g, "''");
  const state = (data.state || '').replace(/'/g, "''");
  const pincode = (data.pincode || '').replace(/'/g, "''");
  const openingBalance = parseFloat(data.opening_balance) || 0;
  const creditLimit = parseFloat(data.credit_limit) || 0;
  const creditDays = parseInt(data.credit_days) || 30;
  const billingName = (data.billing_name || '').replace(/'/g, "''");
  const billingAddress = (data.billing_address || '').replace(/'/g, "''");
  const billingGstin = (data.billing_gstin || '').replace(/'/g, "''");

  return withTransaction((db) => {
    const now = new Date().toISOString();
    if (partyId) {
      db.run(`UPDATE parties SET name='${name}', phone='${phone}', email='${email}', type='${partyType}', gstin='${gstin}', pan='${pan}', address='${address}', city='${city}', state='${state}', pincode='${pincode}', opening_balance=${openingBalance}, credit_limit=${creditLimit}, credit_days=${creditDays}, billing_name='${billingName}', billing_address='${billingAddress}', billing_gstin='${billingGstin}', updated_at='${now}' WHERE id=${partyId}`);
      return getParty(partyId);
    } else {
      db.run(`INSERT INTO parties (name, phone, email, type, gstin, pan, address, city, state, pincode, opening_balance, credit_limit, credit_days, billing_name, billing_address, billing_gstin, created_at, updated_at) VALUES ('${name}', '${phone}', '${email}', '${partyType}', '${gstin}', '${pan}', '${address}', '${city}', '${state}', '${pincode}', ${openingBalance}, ${creditLimit}, ${creditDays}, '${billingName}', '${billingAddress}', '${billingGstin}', '${now}', '${now}')`);
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
    db.run(`DELETE FROM parties WHERE id = ${partyId}`);
  });
}

function addPartyPayment(partyId, amount, method = 'Cash', note = '') {
  const now = new Date().toISOString();
  const safeNote = (note || '').replace(/'/g, "''");
  
  return withTransaction((db) => {
    // Check if party exists
    const party = execToObject(`SELECT * FROM parties WHERE id = ${partyId}`);
    if (!party) {
      throw new Error('Party not found');
    }

    db.run(`INSERT INTO payments (party_id, amount, method, note, created_at) VALUES (${partyId}, ${parseFloat(amount)}, '${method}', '${safeNote}', '${now}')`);

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
