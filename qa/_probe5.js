const B='http://127.0.0.1:5055';
(async()=>{
 let r=await fetch(B+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'admin'})});
 const cookie=r.headers.get('set-cookie').split(';')[0];
 const H={'content-type':'application/json',cookie};
 const post=async(u,b)=>{const x=await fetch(B+u,{method:'POST',headers:H,body:JSON.stringify(b)});return{status:x.status,text:await x.text()}};
 console.log('clear',await post('/api/cart/clear',{}));
 console.log('item',await post('/api/items',{code:'TEST-HOLD-002',name:'TEST hold item 2',purchase_price:10,sale_price:20,mrp:22,stock:100,gst_percent:0}));
 console.log('add',await post('/add_to_cart',{code:'TEST-HOLD-002',quantity:3}));
 console.log('hold',await post('/api/cart/hold',{name:'TEST hold'}));
})();
