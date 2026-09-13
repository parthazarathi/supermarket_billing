const B='http://127.0.0.1:5055';
(async()=>{
 let r=await fetch(B+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'admin'})});
 const cookie=r.headers.get('set-cookie').split(';')[0];
 const H={'content-type':'application/json',cookie};
 const items=(await (await fetch(B+'/api/items',{headers:H})).json()).items;
 const milk=items.find(i=>i.code==='TEST-MILK-001')||items[0];
 const parties=(await (await fetch(B+'/api/parties?type=supplier',{headers:H})).json()).parties;
 const sup=parties[0];
 r=await fetch(B+'/api/purchase-orders',{method:'POST',headers:H,body:JSON.stringify({party_id:sup?.id,items:[{code:milk.code,item_id:milk.id,quantity:5,price:25}]})});
 console.log('PO create',r.status,await r.text());
})();
