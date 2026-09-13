// Seeds qa/data-perf/pos.db (copy of qa/data/pos.db) with a large synthetic dataset. Server must NOT be running on it.
const initSqlJs = require('sql.js');
const fs = require('fs'); const path = require('path');
const src = path.join(__dirname, 'data', 'pos.db'); const dir = path.join(__dirname, 'data-perf'); const dst = path.join(dir, 'pos.db');
(async () => {
  fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(src, dst);
  const SQL = await initSqlJs(); const db = new SQL.Database(fs.readFileSync(dst));
  const now = Date.now(); const iso = (d) => new Date(d).toISOString();
  db.run('BEGIN');
  for (let i = 0; i < 1000; i++) db.run('INSERT INTO items (code,name,category,hsn,gst_percent,purchase_price,mrp,sale_price,stock,unit,low_stock,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [`PERF-${i}`, `PERF Item ${i}`, `PERF-Cat-${i % 20}`, '', [0, 5, 12, 18, 28][i % 5], 10 + i % 50, 20 + i % 50, 15 + i % 50, 1000, 'pcs', 5, iso(now), iso(now)]);
  const custIds = [], supIds = [];
  for (let i = 0; i < 500; i++) { db.run("INSERT INTO parties (name,phone,type,opening_balance,created_at,updated_at) VALUES (?,?,?,?,?,?)", [`PERF-CUST-${i}`, `98${String(i).padStart(8, '0')}`, 'customer', 0, iso(now), iso(now)]); custIds.push(db.exec('select last_insert_rowid()')[0].values[0][0]); }
  for (let i = 0; i < 100; i++) { db.run("INSERT INTO parties (name,phone,type,opening_balance,created_at,updated_at) VALUES (?,?,?,?,?,?)", [`PERF-SUP-${i}`, `97${String(i).padStart(8, '0')}`, 'supplier', 0, iso(now), iso(now)]); supIds.push(db.exec('select last_insert_rowid()')[0].values[0][0]); }
  const itemRows = db.exec("SELECT id, code, name, sale_price, purchase_price, gst_percent FROM items WHERE code LIKE 'PERF-%'")[0].values;
  for (let b = 0; b < 1000; b++) {
    const day = now - (b % 60) * 86400000; const created = iso(day - (b % 1000) * 1000);
    const n = 10; let subtotal = 0, tax = 0; const lines = [];
    for (let k = 0; k < n; k++) { const it = itemRows[(b * 7 + k * 13) % itemRows.length]; const qty = 1 + (k % 3); const taxable = qty * it[3]; const lt = Math.round(taxable * it[5]) / 100; subtotal += taxable; tax += lt; lines.push([it, qty, Math.round((taxable + lt) * 100) / 100]); }
    tax = Math.round(tax * 100) / 100; const total = Math.round((subtotal + tax) * 100) / 100; const half = Math.round(tax / 2 * 100) / 100;
    const invNo = `INV-PERF-${String(b).padStart(5, '0')}`; const pid = b % 3 === 0 ? custIds[b % custIds.length] : null;
    db.run('INSERT INTO invoices (invoice_no,party_id,party_name,party_phone,subtotal,discount,tax,cgst,sgst,igst,total,paid,payment_method,status,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [invNo, pid, pid ? `PERF-CUST-${b % 500}` : 'Walk-in Customer', '', subtotal, 0, tax, half, Math.round((tax - half) * 100) / 100, 0, total, b % 5 === 0 ? 0 : total, ['Cash', 'UPI', 'Card', 'Credit'][b % 4], b % 5 === 0 ? 'unpaid' : 'paid', 1, created]);
    const invId = db.exec('select last_insert_rowid()')[0].values[0][0];
    for (const [it, qty, lt] of lines) { db.run('INSERT INTO invoice_items (invoice_id,item_id,code,name,quantity,price,gst_percent,discount,line_total,purchase_price) VALUES (?,?,?,?,?,?,?,?,?,?)', [invId, it[0], it[1], it[2], qty, it[3], it[5], 0, lt, it[4]]); db.run('UPDATE items SET stock = stock - ? WHERE id = ?', [qty, it[0]]); }
  }
  for (let p = 0; p < 200; p++) { const created = iso(now - (p % 60) * 86400000); db.run('INSERT INTO purchases (purchase_no,party_id,party_name,subtotal,tax,total,paid,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)', [`PUR-PERF-${p}`, supIds[p % 100], `PERF-SUP-${p % 100}`, 1000, 50, 1050, p % 2 ? 1050 : 0, 1, created]); const pidr = db.exec('select last_insert_rowid()')[0].values[0][0]; const it = itemRows[p % itemRows.length]; db.run('INSERT INTO purchase_items (purchase_id,item_id,code,name,quantity,price,gst_percent,line_total) VALUES (?,?,?,?,?,?,?,?)', [pidr, it[0], it[1], it[2], 100, 10, 5, 1050]); }
  for (let e = 0; e < 300; e++) db.run('INSERT INTO expenses (category,amount,note,created_at,user_id) VALUES (?,?,?,?,?)', [`PERF-Exp-${e % 5}`, 100 + e, 'perf', iso(now - (e % 60) * 86400000), 1]);
  db.run('COMMIT');
  fs.writeFileSync(dst, Buffer.from(db.export()));
  const c = (t) => db.exec(`select count(*) from ${t}`)[0].values[0][0];
  console.log({ items: c('items'), parties: c('parties'), invoices: c('invoices'), invoice_items: c('invoice_items'), purchases: c('purchases'), expenses: c('expenses'), size_kb: Math.round(fs.statSync(dst).size / 1024) });
})();
