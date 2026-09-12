const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { getDbPath } = require('./paths');

let db = null;
let SQL = null;

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
    db = new SQL.Database(buffer);
    console.log('Database loaded from file');
    runMigrations();
  } else {
    db = new SQL.Database();
    createTables();
    seedDefaults();
    console.log('Database created, saving...');
    saveDatabase();
    console.log('Database created and saved successfully');
    
    // Reload to verify persistence
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
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
      party_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      method TEXT DEFAULT 'Cash',
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      user_id INTEGER
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
  `;

  db.run(createTablesSQL);
}

function runMigrations() {
  if (!db) return;
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
  ];
  for (const sql of migrations) {
    try {
      db.run(sql);
    } catch (error) {
      // Column likely already exists; ignore
    }
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
      db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('${key}', '${value}')`);
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
  db.run(`INSERT INTO parties (name, phone, type, gstin, opening_balance, created_at, updated_at) VALUES ('Walk-in Customer', '', 'customer', '', 0, '${now}', '${now}')`);
  
  // Default cash account
  db.run(`INSERT INTO accounts (name, type, opening_balance, current_balance, is_default, created_at, updated_at) VALUES ('Cash', 'cash', 0, 0, 1, '${now}', '${now}')`);
}

function saveDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  const dbPath = getDbPath();
  console.log('Saving database to:', dbPath);
  fs.writeFileSync(dbPath, buffer);
  console.log('Database saved successfully');
}

function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

function withTransaction(callback) {
  db.run('BEGIN TRANSACTION');
  try {
    const result = callback(db);
    db.run('COMMIT');
    return result;
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  } finally {
    saveDatabase();
  }
}

function execToObjects(sql) {
  const result = db.exec(sql);
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

function execToObject(sql) {
  const objects = execToObjects(sql);
  return objects.length > 0 ? objects[0] : null;
}

module.exports = {
  initDatabase,
  getDatabase,
  saveDatabase,
  withTransaction,
  execToObjects,
  execToObject
};
