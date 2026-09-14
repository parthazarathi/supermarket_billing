const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { getDbPath } = require('./paths');

let db = null;
let SQL = null;

// Compatibility shim: this codebase calls stmt.getAsObject() in two ways -
//  1) fetch-style: stmt.getAsObject() -> array of all rows (uses [0], .length)
//  2) cursor-style: while (stmt.step()) rows.push(stmt.getAsObject()) -> single row
// sql.js only supports (2). This wrapper returns all rows when getAsObject is
// called before any step(), and the current row once stepping has begun.
function patchStatement(stmt) {
  let stepped = false;
  const origStep = stmt.step.bind(stmt);
  const origGet = stmt.getAsObject.bind(stmt);
  const origBind = stmt.bind.bind(stmt);
  const origReset = stmt.reset ? stmt.reset.bind(stmt) : null;

  stmt.step = () => {
    stepped = true;
    return origStep();
  };
  stmt.bind = (params) => {
    stepped = false;
    return origBind(params);
  };
  if (origReset) {
    stmt.reset = () => {
      stepped = false;
      return origReset();
    };
  }
  stmt.getAsObject = (params) => {
    // Empty params are a no-op - callers often bind() first then pass {}
    const hasParams = params !== undefined &&
      (Array.isArray(params) ? params.length > 0 : Object.keys(params).length > 0);
    if (hasParams) stmt.bind(params);
    if (stepped) return origGet();
    const rows = [];
    while (origStep()) {
      rows.push(origGet());
    }
    return rows;
  };
  return stmt;
}

function patchDatabase(database) {
  const origPrepare = database.prepare.bind(database);
  database.prepare = (...args) => patchStatement(origPrepare(...args));
  return database;
}

async function initDatabase() {
  if (db) return db;

  SQL = await initSqlJs();
  const dbPath = getDbPath();
  const dbDir = path.dirname(dbPath);
  
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = patchDatabase(new SQL.Database(buffer));
    console.log('Database loaded from file');
    runMigrations();
  } else {
    db = patchDatabase(new SQL.Database());
    createTables();
    seedDefaults();
    console.log('Database created, saving...');
    saveDatabase();
    console.log('Database created and saved successfully');
    
    // Reload to verify persistence
    const buffer = fs.readFileSync(dbPath);
    db = patchDatabase(new SQL.Database(buffer));
    console.log('Database reloaded after save');
  }

  // Verify admin user exists
  const userCheckResult = db.exec('SELECT * FROM users WHERE username = "admin"');
  console.log('Admin user after init:', userCheckResult.length > 0 ? 'exists' : 'does not exist');
  if (userCheckResult.length > 0) {
    console.log('Admin user data:', userCheckResult[0]);
  }

  return db;
}

function createTables() {
  const createTablesSQL = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier',
      created_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'General',
      hsn TEXT DEFAULT '',
      gst_percent REAL NOT NULL DEFAULT 18,
      purchase_price REAL NOT NULL DEFAULT 0,
      mrp REAL NOT NULL DEFAULT 0,
      sale_price REAL NOT NULL,
      stock REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'pcs',
      low_stock REAL NOT NULL DEFAULT 5,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      type TEXT NOT NULL DEFAULT 'customer',
      gstin TEXT DEFAULT '',
      pan TEXT DEFAULT '',
      address TEXT DEFAULT '',
      city TEXT DEFAULT '',
      state TEXT DEFAULT '',
      pincode TEXT DEFAULT '',
      opening_balance REAL NOT NULL DEFAULT 0,
      credit_limit REAL NOT NULL DEFAULT 0,
      credit_days INTEGER NOT NULL DEFAULT 30,
      billing_name TEXT DEFAULT '',
      billing_address TEXT DEFAULT '',
      billing_gstin TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT UNIQUE NOT NULL,
      party_id INTEGER,
      party_name TEXT DEFAULT '',
      party_phone TEXT DEFAULT '',
      subtotal REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL DEFAULT 0,
      cgst REAL NOT NULL DEFAULT 0,
      sgst REAL NOT NULL DEFAULT 0,
      igst REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      paid REAL NOT NULL DEFAULT 0,
      payment_method TEXT DEFAULT 'Cash',
      status TEXT NOT NULL DEFAULT 'paid',
      cancelled_by INTEGER,
      cancelled_at TEXT,
      cancel_reason TEXT DEFAULT '',
      user_id INTEGER,
      created_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      item_id INTEGER,
      code TEXT,
      name TEXT,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      gst_percent REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL,
      purchase_price REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id)
    );
    
    CREATE TABLE IF NOT EXISTS sale_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      return_no TEXT UNIQUE NOT NULL,
      total REAL NOT NULL DEFAULT 0,
      reason TEXT DEFAULT '',
      refund_method TEXT DEFAULT 'Cash',
      refund_amount REAL NOT NULL DEFAULT 0,
      user_id INTEGER,
      created_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS sale_return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id INTEGER NOT NULL,
      invoice_item_id INTEGER,
      item_id INTEGER,
      quantity REAL NOT NULL,
      amount REAL NOT NULL,
      FOREIGN KEY (return_id) REFERENCES sale_returns(id)
    );
    
    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_no TEXT UNIQUE NOT NULL,
      party_id INTEGER,
      party_name TEXT DEFAULT '',
      subtotal REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      paid REAL NOT NULL DEFAULT 0,
      user_id INTEGER,
      created_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER NOT NULL,
      item_id INTEGER,
      code TEXT,
      name TEXT,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      gst_percent REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL,
      FOREIGN KEY (purchase_id) REFERENCES purchases(id)
    );
    
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      user_id INTEGER
    );
    
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_id INTEGER,
      amount REAL NOT NULL,
      method TEXT DEFAULT 'Cash',
      note TEXT DEFAULT '',
      direction TEXT DEFAULT 'in',
      ref_type TEXT DEFAULT '',
      ref_id INTEGER,
      created_at TEXT NOT NULL,
      user_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS number_sequences (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS held_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cart_json TEXT NOT NULL,
      user_id INTEGER,
      created_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS estimates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      estimate_no TEXT UNIQUE NOT NULL,
      party_id INTEGER,
      party_name TEXT DEFAULT '',
      party_phone TEXT DEFAULT '',
      subtotal REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL DEFAULT 0,
      cgst REAL NOT NULL DEFAULT 0,
      sgst REAL NOT NULL DEFAULT 0,
      igst REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      valid_until TEXT,
      notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      user_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS estimate_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      estimate_id INTEGER NOT NULL,
      item_id INTEGER,
      code TEXT,
      name TEXT,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      gst_percent REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL,
      FOREIGN KEY (estimate_id) REFERENCES estimates(id)
    );
    
    CREATE TABLE IF NOT EXISTS delivery_challans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challan_no TEXT UNIQUE NOT NULL,
      party_id INTEGER,
      party_name TEXT DEFAULT '',
      party_address TEXT DEFAULT '',
      invoice_id INTEGER,
      subtotal REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      user_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS challan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challan_id INTEGER NOT NULL,
      item_id INTEGER,
      code TEXT,
      name TEXT,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      line_total REAL NOT NULL,
      FOREIGN KEY (challan_id) REFERENCES delivery_challans(id)
    );
    
    CREATE TABLE IF NOT EXISTS credit_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credit_note_no TEXT UNIQUE NOT NULL,
      party_id INTEGER,
      party_name TEXT DEFAULT '',
      invoice_id INTEGER,
      subtotal REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      reason TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      user_id INTEGER,
      created_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS credit_note_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credit_note_id INTEGER NOT NULL,
      item_id INTEGER,
      code TEXT,
      name TEXT,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      gst_percent REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL,
      FOREIGN KEY (credit_note_id) REFERENCES credit_notes(id)
    );
    
    CREATE TABLE IF NOT EXISTS debit_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      debit_note_no TEXT UNIQUE NOT NULL,
      party_id INTEGER,
      party_name TEXT DEFAULT '',
      invoice_id INTEGER,
      subtotal REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      reason TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      user_id INTEGER,
      created_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS debit_note_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      debit_note_id INTEGER NOT NULL,
      item_id INTEGER,
      code TEXT,
      name TEXT,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      gst_percent REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL,
      FOREIGN KEY (debit_note_id) REFERENCES debit_notes(id)
    );
    
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE NOT NULL,
      party_id INTEGER,
      party_name TEXT DEFAULT '',
      subtotal REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      expected_date TEXT,
      notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      user_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      item_id INTEGER,
      code TEXT,
      name TEXT,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      gst_percent REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES purchase_orders(id)
    );
    
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'cash',
      account_number TEXT DEFAULT '',
      bank_name TEXT DEFAULT '',
      branch TEXT DEFAULT '',
      ifsc TEXT DEFAULT '',
      opening_balance REAL NOT NULL DEFAULT 0,
      current_balance REAL NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS account_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      transaction_type TEXT NOT NULL,
      amount REAL NOT NULL,
      reference_type TEXT DEFAULT '',
      reference_id INTEGER DEFAULT 0,
      party_id INTEGER,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER NOT NULL,
      return_no TEXT UNIQUE NOT NULL,
      party_id INTEGER,
      total REAL NOT NULL DEFAULT 0,
      reason TEXT DEFAULT '',
      refund_amount REAL NOT NULL DEFAULT 0,
      user_id INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (purchase_id) REFERENCES purchases(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id INTEGER NOT NULL,
      purchase_item_id INTEGER,
      item_id INTEGER,
      quantity REAL NOT NULL,
      amount REAL NOT NULL,
      FOREIGN KEY (return_id) REFERENCES purchase_returns(id)
    );

    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'adjustment',
      old_qty REAL NOT NULL DEFAULT 0,
      change REAL NOT NULL DEFAULT 0,
      new_qty REAL NOT NULL DEFAULT 0,
      reason TEXT DEFAULT '',
      user_id INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES items(id)
    );

    CREATE TABLE IF NOT EXISTS cash_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      opening_cash REAL NOT NULL DEFAULT 0,
      closing_cash REAL,
      expected_cash REAL,
      note TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT DEFAULT '',
      action TEXT NOT NULL,
      module TEXT DEFAULT '',
      reference TEXT DEFAULT '',
      old_value TEXT DEFAULT '',
      new_value TEXT DEFAULT '',
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices(created_at);
    CREATE INDEX IF NOT EXISTS idx_invoices_party ON invoices(party_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_invoice_items_item ON invoice_items(item_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_created ON purchases(created_at);
    CREATE INDEX IF NOT EXISTS idx_purchases_party ON purchases(party_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_items_item ON purchase_items(item_id);
    CREATE INDEX IF NOT EXISTS idx_sale_returns_created ON sale_returns(created_at);
    CREATE INDEX IF NOT EXISTS idx_sale_return_items_return ON sale_return_items(return_id);
    CREATE INDEX IF NOT EXISTS idx_sale_return_items_item ON sale_return_items(item_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_returns_created ON purchase_returns(created_at);
    CREATE INDEX IF NOT EXISTS idx_expenses_created ON expenses(created_at);
    CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);
    CREATE INDEX IF NOT EXISTS idx_payments_party ON payments(party_id);
    CREATE INDEX IF NOT EXISTS idx_stock_adj_item ON stock_adjustments(item_id);
    CREATE INDEX IF NOT EXISTS idx_stock_adj_created ON stock_adjustments(created_at);
    CREATE INDEX IF NOT EXISTS idx_cash_sessions_user ON cash_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
  `;

  db.run(createTablesSQL);
}

function runMigrations() {
  if (!db) return;
  // Ensure tables added in newer versions exist on older database files
  createTables();
  const migrations = [
    "ALTER TABLE parties ADD COLUMN email TEXT DEFAULT ''",
    "ALTER TABLE parties ADD COLUMN pan TEXT DEFAULT ''",
    "ALTER TABLE parties ADD COLUMN address TEXT DEFAULT ''",
    "ALTER TABLE parties ADD COLUMN city TEXT DEFAULT ''",
    "ALTER TABLE parties ADD COLUMN state TEXT DEFAULT ''",
    "ALTER TABLE parties ADD COLUMN pincode TEXT DEFAULT ''",
    "ALTER TABLE parties ADD COLUMN opening_balance REAL NOT NULL DEFAULT 0",
    "ALTER TABLE parties ADD COLUMN credit_limit REAL NOT NULL DEFAULT 0",
    "ALTER TABLE parties ADD COLUMN credit_days INTEGER NOT NULL DEFAULT 30",
    "ALTER TABLE parties ADD COLUMN billing_name TEXT DEFAULT ''",
    "ALTER TABLE parties ADD COLUMN billing_address TEXT DEFAULT ''",
    "ALTER TABLE parties ADD COLUMN created_at TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE parties ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE items ADD COLUMN mrp REAL NOT NULL DEFAULT 0",
    "ALTER TABLE sale_returns ADD COLUMN reason TEXT DEFAULT ''",
    "ALTER TABLE sale_returns ADD COLUMN refund_method TEXT DEFAULT 'Cash'",
    "ALTER TABLE purchases ADD COLUMN discount REAL NOT NULL DEFAULT 0",
    "ALTER TABLE payments ADD COLUMN user_id INTEGER",
    "ALTER TABLE payments ADD COLUMN direction TEXT DEFAULT 'in'",
    "ALTER TABLE invoices ADD COLUMN cancelled_by INTEGER",
    "ALTER TABLE invoices ADD COLUMN cancelled_at TEXT",
    "ALTER TABLE invoices ADD COLUMN cancel_reason TEXT DEFAULT ''",
    "ALTER TABLE payments ADD COLUMN ref_type TEXT DEFAULT ''",
    "ALTER TABLE payments ADD COLUMN ref_id INTEGER",
    "ALTER TABLE sale_returns ADD COLUMN refund_amount REAL NOT NULL DEFAULT 0",
    "ALTER TABLE purchase_returns ADD COLUMN refund_amount REAL NOT NULL DEFAULT 0",
  ];
  for (const sql of migrations) {
    try {
      db.run(sql);
    } catch (error) {
      // Column likely already exists; ignore
    }
  }

  // Older databases declare payments.party_id NOT NULL, but refund rows for
  // walk-in bills have no party. Rebuild the table once to relax the column.
  try {
    const info = db.exec('PRAGMA table_info(payments)');
    if (info.length > 0) {
      const cols = info[0].columns;
      const nameIdx = cols.indexOf('name');
      const notNullIdx = cols.indexOf('notnull');
      const partyCol = info[0].values.find((r) => r[nameIdx] === 'party_id');
      if (partyCol && Number(partyCol[notNullIdx]) === 1) {
        db.run(`
          CREATE TABLE payments_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            party_id INTEGER,
            amount REAL NOT NULL,
            method TEXT DEFAULT 'Cash',
            note TEXT DEFAULT '',
            direction TEXT DEFAULT 'in',
            ref_type TEXT DEFAULT '',
            ref_id INTEGER,
            created_at TEXT NOT NULL,
            user_id INTEGER
          )
        `);
        db.run(`INSERT INTO payments_new (id, party_id, amount, method, note, direction, ref_type, ref_id, created_at, user_id)
          SELECT id, party_id, amount, method, note, direction, ref_type, ref_id, created_at, user_id FROM payments`);
        db.run('DROP TABLE payments');
        db.run('ALTER TABLE payments_new RENAME TO payments');
        db.run('CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at)');
        db.run('CREATE INDEX IF NOT EXISTS idx_payments_party ON payments(party_id)');
      }
    }
  } catch (error) {
    console.error('payments table rebuild failed:', error);
  }

  // Idempotent backfills: tag legacy payment rows with their reference type.
  try {
    db.run("UPDATE payments SET ref_type='invoice' WHERE ref_type='' AND note LIKE 'Invoice %'");
    db.run("UPDATE payments SET ref_type='standalone' WHERE ref_type='' AND party_id IS NOT NULL");
  } catch (error) {
    console.error('payments backfill failed:', error);
  }

  saveDatabase();
}

function seedDefaults() {
  const now = new Date().toISOString();
  
  // Default settings
  const defaults = {
    shop_name: 'Mart POS',
    gstin: '',
    upi_vpa: 'merchant@upi',
    upi_name: 'Mart POS',
    gst_type: 'intra',
    default_gst: '18',
    drive_auto_backup: '0',
    must_change_password: '1'
  };

  for (const [key, value] of Object.entries(defaults)) {
    try {
      db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    } catch (error) {
      console.log('Setting already exists:', key);
    }
  }

  // Default admin user
  const bcrypt = require('bcryptjs');
  console.log('Creating admin user...');
  const passwordHash = bcrypt.hashSync('admin', 10);
  console.log('Password hash:', passwordHash);
  
  // Use parameters for the hash to avoid SQL issues with special characters
  const stmt = db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)');
  stmt.run(['admin', passwordHash, 'admin', now]);
  stmt.free();
  
  console.log('Admin user created successfully');
  
  // Verify it was created
  const verifyResult = db.exec('SELECT * FROM users WHERE username = "admin"');
  console.log('Verification after creation:', verifyResult);

  // Default walk-in customer
  db.run('INSERT INTO parties (name, phone, type, gstin, opening_balance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['Walk-in Customer', '', 'customer', '', 0, now, now]);

  // Default cash account
  db.run('INSERT INTO accounts (name, type, opening_balance, current_balance, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['Cash', 'cash', 0, 0, 1, now, now]);
}

function saveDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  const dbPath = getDbPath();
  const tmpPath = `${dbPath}.tmp`;
  fs.writeFileSync(tmpPath, buffer);
  fs.renameSync(tmpPath, dbPath);
}

let saveTimer = null;

function scheduleSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveDatabase();
  }, 1500);
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    saveDatabase();
  }
}

function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

// Flushes any debounced save to pos.db, then returns a consistent snapshot
// of the in-memory database as a Buffer. Used by Drive backup so the upload
// always reflects the latest state without touching the live database file.
function exportSnapshot() {
  flushSave();
  return Buffer.from(getDatabase().export());
}

// Re-reads pos.db from disk and swaps it in as the live database. Used after
// a Drive restore replaced the file underneath us. Pending saves are
// cancelled first so the restored file is not overwritten by stale memory.
function reloadDatabase() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const buffer = fs.readFileSync(getDbPath());
  const fresh = patchDatabase(new SQL.Database(buffer));
  const old = db;
  db = fresh;
  txDepth = 0;
  try {
    if (old) old.close();
  } catch (_) {
    // closing the old in-memory db must never break a restore
  }
  return db;
}

// Reentrant transactions: nested calls join the outer transaction. Only the
// outermost call issues BEGIN/COMMIT/ROLLBACK - an inner throw propagates to
// the outer catch, which rolls back the whole unit of work.
let txDepth = 0;

function withTransaction(callback) {
  if (txDepth > 0) {
    return callback(db);
  }
  db.run('BEGIN TRANSACTION');
  txDepth += 1;
  try {
    const result = callback(db);
    db.run('COMMIT');
    return result;
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch (rollbackError) {
      // Transaction may already be rolled back; ignore
    }
    throw error;
  } finally {
    txDepth -= 1;
    scheduleSave();
  }
}

function execToObjects(sql, params = []) {
  const result = db.exec(sql, params);
  const objects = [];
  
  if (result.length > 0 && result[0].values.length > 0) {
    const columns = result[0].columns;
    result[0].values.forEach(row => {
      const obj = {};
      columns.forEach((col, index) => {
        obj[col] = row[index];
      });
      objects.push(obj);
    });
  }
  
  return objects;
}

function execToObject(sql, params = []) {
  const objects = execToObjects(sql, params);
  return objects.length > 0 ? objects[0] : null;
}

module.exports = {
  initDatabase,
  getDatabase,
  saveDatabase,
  scheduleSave,
  flushSave,
  exportSnapshot,
  reloadDatabase,
  withTransaction,
  execToObjects,
  execToObject
};
