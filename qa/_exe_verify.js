const B='http://127.0.0.1:5000';
(async()=>{
 let r=await fetch(B+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'admin'})});
 const cookie=r.headers.get('set-cookie').split(';')[0];
 console.log('login',r.status,(await r.json()).user?.role);
 const H={'content-type':'application/json',cookie};
 r=await fetch(B+'/api/items',{method:'POST',headers:H,body:JSON.stringify({code:'EXE-TEST-1',name:'Exe Test Item',purchase_price:10,sale_price:20,mrp:22,stock:50,gst_percent:5})});
 console.log('item create',r.status,(await r.json()).ok);
 r=await fetch(B+'/add_to_cart',{method:'POST',headers:H,body:JSON.stringify({code:'EXE-TEST-1',quantity:2})});
 console.log('add_to_cart',r.status);
 r=await fetch(B+'/api/sale',{method:'POST',headers:H,body:JSON.stringify({payment_method:'Cash'})});
 const inv=(await r.json()).invoice;
 console.log('sale',r.status,inv?.invoice_no,inv?.total);
 r=await fetch(B+`/invoice_pdf?id=${inv.id}`,{headers:H});
 const buf=Buffer.from(await r.arrayBuffer());
 console.log('pdf',r.status,buf.slice(0,5).toString(),buf.length,'bytes');
 r=await fetch(B+'/api/dashboard',{headers:H});
 console.log('dashboard',r.status,(await r.json()).ok);
})();
