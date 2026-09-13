process.env.MARTPOS_DATA_DIR='qa/data-scratch';
(async()=>{
 const {initDatabase}=require('../lib/database');await initDatabase();
 const {execToObject}=require('../lib/database');
 const sup=execToObject("SELECT * FROM parties WHERE type='supplier' LIMIT 1");
 console.log('sup',sup&&sup.id);
 try{
  const po=require('../lib/purchaseOrders').createPurchaseOrder([{code:'X2',item_id:1,name:'M',quantity:5,price:25}],{partyId:sup?sup.id:null,userId:1});
  console.log('ok',po.order_no,po.party_name);
 }catch(e){console.log('THREW',typeof e,e&&e.constructor&&e.constructor.name,String(e),e&&e.message,(e&&e.stack||'').split('\n').slice(0,5).join(' | '));}
})();
