// run2: POS functional tests
const cdp = require('./cdp');
const fs = require('fs');
const BASE = 'http://localhost:5056';
const out = [];
const log = (...a) => { const s = a.join(' '); console.log(s); out.push(s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const statusText = () => cdp.evaljs(`document.querySelector('.status')?.textContent?.trim() || ''`);
const cart = () => cdp.evaljs(`JSON.stringify(state.cart)`).then(JSON.parse);
const E = (x) => JSON.stringify(x);

(async () => {
  const proc = await cdp.launch();
  cdp.onEvent(d => {
    if (d.method === 'Page.javascriptDialogOpening') {
      log('DIALOG:', d.params.type, d.params.message);
      cdp.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    }
  });
  await cdp.setViewport(1366, 768);
  await cdp.goto(BASE + '/'); await sleep(1200);
  if (await cdp.evaljs(`!!document.getElementById('loginForm')`)) {
    await cdp.evaljs(`document.querySelector('[name=username]').value='admin';document.querySelector('[name=password]').value='admin';document.getElementById('loginForm').requestSubmit();void 0`);
    await sleep(1500);
  }
  log('logged in:', await cdp.evaljs(`state.user && state.user.username`));

  // create TEST-UI item via UI-visible API, then reload items
  const itemRes = await cdp.evaljs(`api('/api/items',{method:'POST',body:{code:'TEST-UI-001',name:'TEST-UI-WIDGET',category:'General',hsn:'',sale_price:80,purchase_price:50,mrp:90,gst_percent:0,stock:100,unit:'pcs',low_stock:5}}).then(r=>'ok').catch(e=>'ERR '+e.message)`, true);
  log('create TEST-UI item:', E(itemRes));
  await cdp.evaljs(`loadItems(false); void 0`); await sleep(500);

  await cdp.evaljs(`switchView('pos'); void 0`); await sleep(1000);

  // --- add via search box + Enter (tests duplicate-listener double add)
  await cdp.evaljs(`(()=>{const s=document.getElementById('productSearch');s.value='TEST-UI-001';s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return 1})()`);
  await sleep(800);
  let c1 = await cart();
  const it1 = c1.items.find(i => i.code === 'TEST-UI-001');
  log('ADD-VIA-ENTER cart items:', c1.items.length, 'TEST-UI-001 qty:', it1 && it1.quantity);

  // --- add via Add button (also has two listeners)
  const qBefore = it1 ? it1.quantity : 0;
  await cdp.evaljs(`(()=>{const s=document.getElementById('productSearch');s.value='TEST-UI';s.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('addBtn').click();return 1})()`);
  await sleep(800);
  let c2 = await cart();
  const it2 = c2.items.find(i => i.code === 'TEST-UI-001');
  log('ADD-VIA-BTN qty delta:', (it2 ? it2.quantity : 0) - qBefore, 'total:', it2 && it2.quantity);
  await cdp.shot('pos-cart');

  // --- qty + button
  await cdp.evaljs(`document.querySelector('[data-qty-plus="TEST-UI-001"]').click(); void 0`); await sleep(600);
  let c3 = await cart();
  log('QTY-PLUS qty:', c3.items.find(i => i.code === 'TEST-UI-001')?.quantity);

  // --- qty minus repeatedly to try to remove
  for (let i = 0; i < 5; i++) { await cdp.evaljs(`document.querySelector('[data-qty-minus="TEST-UI-001"]')?.click(); void 0`); await sleep(300); }
  let c4 = await cart();
  log('QTY-MINUS x5 qty:', c4.items.find(i => i.code === 'TEST-UI-001')?.quantity, 'items:', c4.items.length);
  // try setting qty input to 0 directly
  await cdp.evaljs(`(()=>{const i=document.querySelector('[data-qty="TEST-UI-001"]');i.value=0;i.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`); await sleep(600);
  let c5 = await cart();
  const it5 = c5.items.find(i => i.code === 'TEST-UI-001');
  log('QTY-SET-0 result qty:', it5 && it5.quantity, 'still in cart:', !!it5, 'status:', await statusText());

  // --- mid-cart refresh: is cart preserved?
  await cdp.goto(BASE + '/'); await sleep(1500);
  await cdp.evaljs(`switchView('pos'); void 0`); await sleep(800);
  let c6 = await cart();
  log('REFRESH-MID-CART items preserved:', JSON.stringify(c6.items.map(i => `${i.code}x${i.quantity}`)));

  // --- bill discount
  await cdp.evaljs(`(()=>{const d=document.getElementById('billDiscount');d.value=5;d.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`); await sleep(600);
  let c7 = await cart();
  log('BILL-DISCOUNT discount:', c7.discount, 'total:', c7.total);

  // --- paid > total → change shown?
  await cdp.evaljs(`(()=>{const p=document.getElementById('paidInput');p.value=String(${`1000`});p.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`); await sleep(300);
  log('PAID> TOTAL change display:', await cdp.evaljs(`document.querySelector('.change-amount')?.textContent?.trim()`));

  // --- payment modes
  for (const m of ['UPI', 'Card', 'Cash']) {
    await cdp.evaljs(`document.querySelector('[data-pay="${m}"]').click(); void 0`); await sleep(400);
    const qr = await cdp.evaljs(`!!document.querySelector('.qr-section img')`);
    log(`PAYMODE ${m} active=${await cdp.evaljs(`state.payment`)} qrShown=${qr}`);
  }

  // --- paid < total → charge → status
  await cdp.evaljs(`(()=>{const p=document.getElementById('paidInput');p.value='10';p.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`); await sleep(300);
  const invBefore = await cdp.evaljs(`api('/api/invoices').then(d=>d.invoices.length)`, true);
  await cdp.evaljs(`document.getElementById('payBtn').click(); void 0`); await sleep(1200);
  log('PAID<TOTAL charge status:', await statusText());
  const lastInv = await cdp.evaljs(`api('/api/invoices').then(d=>{const i=d.invoices[0]||d.invoices[d.invoices.length-1];return JSON.stringify(i)})`, true);
  log('  last invoice:', lastInv);

  // --- double-click Charge rapidly: count invoices
  const b0 = await cdp.evaljs(`api('/api/invoices').then(d=>d.invoices.length)`, true);
  // re-add item to cart (cart cleared after sale)
  await cdp.evaljs(`(()=>{const s=document.getElementById('productSearch');s.value='TEST-UI-001';s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return 1})()`);
  await sleep(800);
  const cc = await cart();
  log('cart before double-click:', JSON.stringify(cc.items.map(i => `${i.code}x${i.quantity}`)), 'total:', cc.total);
  await cdp.evaljs(`(()=>{const b=document.getElementById('payBtn');b.click();b.click();b.click();return 1})()`);
  await sleep(2500);
  const b1 = await cdp.evaljs(`api('/api/invoices').then(d=>d.invoices.length)`, true);
  log('DOUBLE-CLICK charge invoices before:', b0, 'after:', b1, 'delta:', b1 - b0, 'status:', await statusText());

  // --- receipt HTML via ReceiptPrinter.buildHtml on last invoice
  const invForPrint = await cdp.evaljs(`api('/api/invoices').then(d=>d.invoices[d.invoices.length-1].id)`, true);
  const full = await cdp.evaljs(`api('/api/invoices/'+${invForPrint}).then(d=>JSON.stringify(d.invoice))`, true);
  const html = await cdp.evaljs(`ReceiptPrinter.buildHtml(${full}, ReceiptPrinter.config(), state.settings)`);
  fs.writeFileSync(__dirname + '/receipt.html', html);
  const checks = ['shop', 'invoice_no', 'Qty', 'TOTAL', 'Paid', 'Change', 'Balance Due'];
  const inv = JSON.parse(full);
  log('RECEIPT fields: invoice_no present=', html.includes(inv.invoice_no), '| shop present=', html.includes('Bharathi'), '| TOTAL=', /TOTAL/.test(html), '| Paid=', /Paid \(/.test(html), '| Change=', /Change/.test(html), '| Due=', /Balance Due/.test(html), '| width=', /size:\s*\d+mm/.exec(html)?.[0]);
  // render receipt html in a new tab-ish: replace body temporarily for screenshot
  await cdp.evaljs(`(()=>{window.__saved=document.body.innerHTML;document.body.innerHTML=${E(html)};document.title='receipt';return 1})()`);
  await sleep(400);
  await cdp.setViewport(500, 800);
  await cdp.shot('receipt-rendered');
  const clip = await cdp.evaljs(`JSON.stringify({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,rpW:document.querySelector('.rp')?.scrollWidth})`);
  log('RECEIPT render clip check:', clip);
  await cdp.setViewport(1366, 768);
  await cdp.goto(BASE + '/'); await sleep(1500);

  fs.writeFileSync(__dirname + '/out2.txt', out.join('\n'));
  proc.kill(); process.exit(0);
})().catch(e => { console.error('FATAL', e); fs.writeFileSync(__dirname + '/out2.txt', out.join('\n')); process.exit(1); });
