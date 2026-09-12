const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

async function testDatabase() {
  console.log('Testing database initialization...');
  
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, 'data', 'pos.db');
  const dbDir = path.dirname(dbPath);
  
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  
  // Create fresh database
  const db = new SQL.Database();
  
  // Create users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier',
      created_at TEXT NOT NULL
    );
  `);
  
  // Create admin user
  const now = new Date().toISOString();
  const passwordHash = bcrypt.hashSync('admin', 10);
  
  console.log('Creating admin user with hash:', passwordHash);
  
  db.run('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
    ['admin', passwordHash, 'admin', now]);
  
  // Save database
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
  
  console.log('Database saved to:', dbPath);
  
  // Reload and verify
  const buffer2 = fs.readFileSync(dbPath);
  const db2 = new SQL.Database(buffer2);
  
  const stmt = db2.prepare('SELECT * FROM users WHERE username = ?');
  stmt.bind(['admin']);
  const user = stmt.getAsObject({})[0];
  stmt.free();
  
  console.log('User retrieved from database:', user);
  
  if (user) {
    const isValid = bcrypt.compareSync('admin', user.password_hash);
    console.log('Password verification:', isValid);
  }
  
  console.log('Test completed');
}

testDatabase().catch(console.error);
