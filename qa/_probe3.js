const initSqlJs=require('sql.js');const fs=require('fs');
(async()=>{const SQL=await initSqlJs();const d=new SQL.Database(fs.readFileSync('qa/data-scratch/pos.db'));
console.log('purchase_orders:',d.exec("SELECT id,order_no,total FROM purchase_orders")[0]?.values);
console.log('po_items:',d.exec("SELECT order_id,code FROM purchase_order_items")[0]?.values);
})();
