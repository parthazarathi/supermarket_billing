const { withTransaction, execToObjects, execToObject } = require('./database');

function listAccounts() {
  const accounts = execToObjects('SELECT * FROM accounts ORDER BY is_default DESC, name');
  
  // Calculate current balance for each account
  for (const account of accounts) {
    account.current_balance = calculateAccountBalance(account.id);
  }
  
  return accounts;
}

function getAccount(accountId) {
  const account = execToObject('SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (account) {
    account.current_balance = calculateAccountBalance(account.id);
  }
  return account;
}

function calculateAccountBalance(accountId) {
  const account = execToObject('SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!account) return 0;

  const opening = parseFloat(account.opening_balance) || 0;

  const transactions = execToObjects(
    'SELECT transaction_type, amount FROM account_transactions WHERE account_id = ?',
    [accountId]
  );
  
  let balance = opening;
  for (const tx of transactions) {
    const amount = parseFloat(tx.amount) || 0;
    if (tx.transaction_type === 'credit') {
      balance += amount;
    } else if (tx.transaction_type === 'debit') {
      balance -= amount;
    }
  }
  
  return Math.round(balance * 100) / 100;
}

function saveAccount(data, accountId = null) {
  const name = (data.name || '').trim();
  if (!name) {
    throw new Error('Account name is required');
  }

  const validTypes = ['cash', 'bank'];
  const accountType = validTypes.includes(data.type) ? data.type : 'cash';
  const accountNumber = data.account_number || '';
  const bankName = data.bank_name || '';
  const branch = data.branch || '';
  const ifsc = data.ifsc || '';
  const openingBalance = parseFloat(data.opening_balance) || 0;
  const isDefault = data.is_default ? 1 : 0;

  return withTransaction((db) => {
    const now = new Date().toISOString();
    
    if (isDefault) {
      // Remove default from other accounts
      db.run("UPDATE accounts SET is_default = 0");
    }
    
    if (accountId) {
      db.run('UPDATE accounts SET name=?, type=?, account_number=?, bank_name=?, branch=?, ifsc=?, opening_balance=?, is_default=?, updated_at=? WHERE id=?',
        [name, accountType, accountNumber, bankName, branch, ifsc, openingBalance, isDefault, now, accountId]);
      return getAccount(accountId);
    } else {
      db.run('INSERT INTO accounts (name, type, account_number, bank_name, branch, ifsc, opening_balance, current_balance, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [name, accountType, accountNumber, bankName, branch, ifsc, openingBalance, openingBalance, isDefault, now, now]);
      const result = execToObject('SELECT * FROM accounts WHERE id = last_insert_rowid()');
      if (result) {
        result.current_balance = calculateAccountBalance(result.id);
      }
      return result;
    }
  });
}

function deleteAccount(accountId) {
  const account = getAccount(accountId);
  if (!account) {
    throw new Error('Account not found');
  }
  
  if (account.is_default) {
    throw new Error('Cannot delete default account');
  }
  
  return withTransaction((db) => {
    db.run('DELETE FROM account_transactions WHERE account_id = ?', [accountId]);
    db.run('DELETE FROM accounts WHERE id = ?', [accountId]);
  });
}

function createTransaction(data) {
  const {
    accountId,
    transactionType,
    amount,
    referenceType = '',
    referenceId = 0,
    partyId = null,
    notes = ''
  } = data;

  if (!accountId || !transactionType || !amount) {
    throw new Error('Account, transaction type, and amount are required');
  }

  const validTypes = ['credit', 'debit'];
  if (!validTypes.includes(transactionType)) {
    throw new Error('Invalid transaction type');
  }

  return withTransaction((db) => {
    const now = new Date().toISOString();

    db.run(
      'INSERT INTO account_transactions (account_id, transaction_type, amount, reference_type, reference_id, party_id, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [accountId, transactionType, parseFloat(amount), referenceType, referenceId, partyId || null, notes || '', now]
    );

    // Update account current balance
    const account = getAccount(accountId);
    const newBalance = calculateAccountBalance(accountId);
    db.run('UPDATE accounts SET current_balance = ?, updated_at = ? WHERE id = ?', [newBalance, now, accountId]);

    return execToObject('SELECT * FROM account_transactions WHERE id = last_insert_rowid()');
  });
}

function listAccountTransactions(accountId, limit = 100) {
  const transactions = execToObjects(
    'SELECT * FROM account_transactions WHERE account_id = ? ORDER BY id DESC LIMIT ?',
    [accountId, limit]
  );

  // Add party details where available
  for (const tx of transactions) {
    if (tx.party_id) {
      const party = execToObject('SELECT name FROM parties WHERE id = ?', [tx.party_id]);
      if (party) {
        tx.party_name = party.name;
      }
    }
  }
  
  return transactions;
}

function getDefaultAccount() {
  const account = execToObject("SELECT * FROM accounts WHERE is_default = 1 LIMIT 1");
  if (account) {
    account.current_balance = calculateAccountBalance(account.id);
  }
  return account;
}

module.exports = {
  listAccounts,
  getAccount,
  calculateAccountBalance,
  saveAccount,
  deleteAccount,
  createTransaction,
  listAccountTransactions,
  getDefaultAccount
};