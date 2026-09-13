const initSqlJs=require('sql.js');const fs=require('fs');
(async()=>{const SQL=await initSqlJs();const d=new SQL.Database(fs.readFileSync(process.argv[2]));
for(const t of ['users','items','parties','invoices','invoice_items','sale_returns','purchases','purchase_returns','expenses','payments','stock_adjustments','audit_logs','estimates','purchase_orders']){const r=d.exec(`SELECT COUNT(*) c, MIN(created_at) mn, MAX(created_at) mx FROM ${t}`);console.log(t.padEnd(20),JSON.stringify(r[0].values[0]));}
console.log(d.exec("SELECT username, role FROM users")[0].values);
console.log(d.exec("SELECT code FROM items WHERE code LIKE 'TEST%'")[0]?.values?.length, 'TEST items');
})();
