process.env.MARTPOS_DATA_DIR='qa/data-scratch';
(async()=>{
 const {initDatabase}=require('../lib/database');await initDatabase();
 try{
  const po=require('../lib/purchaseOrders').createPurchaseOrder([{code:'X1',item_id:1,name:'M',quantity:5,price:25}],{partyId:null,userId:1});
  console.log('ok',po.order_no);
 }catch(e){console.log('THREW type=',typeof e,'ctor=',e&&e.constructor&&e.constructor.name,'val=',String(e),'msg=',e&&e.message, 'stack=',(e&&e.stack||'').split('\n').slice(0,4).join('|'));}
})();
