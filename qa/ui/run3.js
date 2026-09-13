// run3: POS retests (with items), receipt print, reports interactions, items form, cashier role
const cdp = require('./cdp');
const fs = require('fs');
const BASE = 'http://localhost:5056';
const out = [];
const log = (...a) => { const s = a.join(' '); console.log(s); out.push(s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const statusText = () => cdp.evaljs(`document.querySelector('.status')?.textContent?.trim() || ''`);
const cart = () => cdp.evaljs(`JSON.stringify(state.cart)`).then(JSON.parse);

async function login(u, p) {
  if (await cdp.evaljs(`!!document.getElementById('loginForm')`)) {
    await cdp.evaljs(`document.querySelector('[name=username]').value=${JSON.stringify(u)};document.querySelector('[name=password]').value=${JSON.stringify(p)};document.getElementById('loginForm').requestSubmit();void 0`);
    await sleep(1500);
  }
}
async function addItem(code) {
  await cdp.evaljs(`(()=>{const s=document.getElementById('productSearch');s.value='${code}';s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return 1})()`);
  await sleep(700);
}

(async () => {
  const proc = await cdp.launch();
  cdp.onEvent(d => {
    if (d.method === 'Page.javascriptDialogOpening') {
      log('DIALOG:', d.params.type, d.params.message);
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  });
  await cdp.setViewport(1366, 768);
  await cdp.goto(BASE + '/'); await sleep(1200);
  await login('admin', 'admin');
  log('user:', await cdp.evaljs(`state.user && state.user.username`));
  await cdp.evaljs(`switchView('pos'); void 0`); await sleep(900);

  // === POS with real cart ===
  await addItem('TEST-UI-001');
  await addItem('TEST-UI-001'); // qty 2
  let c = await cart();
  log('CART', JSON.stringify(c.items.map(i => `${i.code}x${i.quantity}`)), 'subtotal', c.subtotal, 'total', c.total);

  // bill discount
  await cdp.evaljs(`(()=>{const d=document.getElementById('billDiscount');d.value='10';d.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`); await sleep(600);
  c = await cart();
  log('BILL-DISCOUNT discount:', c.discount, 'total:', c.total);

  // paid > total
  const tot = c.total;
  await cdp.evaljs(`(()=>{const p=document.getElementById('paidInput');p.value='500';p.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`); await sleep(300);
  log('PAID> TOTAL(total=' + tot + ') change shown:', await cdp.evaljs(`document.querySelector('.change-amount')?.textContent?.trim()`));

  // UPI QR
  await cdp.evaljs(`document.querySelector('[data-pay="UPI"]').click(); void 0`); await sleep(500);
  log('UPI qr shown:', await cdp.evaljs(`!!document.querySelector('.qr-section img')`), 'src:', await cdp.evaljs(`document.querySelector('.qr-section img')?.src||''`));
  await cdp.shot('pos-upi-qr');
  await cdp.evaljs(`document.querySelector('[data-pay="Cash"]').click(); void 0`); await sleep(300);

  // paid < total → charge → invoice status
  await cdp.evaljs(`(()=>{const p=document.getElementById('paidInput');p.value='50';p.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`); await sleep(200);
  await cdp.evaljs(`document.getElementById('payBtn').click(); void 0`); await sleep(1500);
  log('PAID<TOTAL status:', await statusText());
  const partialInv = await cdp.evaljs(`api('/api/invoices').then(d=>JSON.stringify(d.invoices[d.invoices.length-1]))`, true);
  log('  invoice:', partialInv);

  // mid-cart refresh
  await addItem('TEST-UI-001');
  c = await cart();
  log('cart pre-refresh:', JSON.stringify(c.items.map(i => `${i.code}x${i.quantity}`)));
  await cdp.goto(BASE + '/'); await sleep(1600);
  await cdp.evaljs(`switchView('pos'); void 0`); await sleep(900);
  c = await cart();
  log('REFRESH-MID-CART preserved:', JSON.stringify(c.items.map(i => `${i.code}x${i.quantity}`)));

  // === receipt print path: capture iframe HTML on Print of last invoice ===
  const invJson = await cdp.evaljs(`api('/api/invoices').then(d=>d.invoices[d.invoices.length-2].id).then(id=>api('/api/invoices/'+id)).then(d=>JSON.stringify(d.invoice))`, true);
  await cdp.evaljs(`ReceiptPrinter.print(${invJson}); void 0`);
  await sleep(1000);
  const frameHtml = await cdp.evaljs(`(()=>{const f=[...document.querySelectorAll('iframe')].pop();return f?f.contentDocument.documentElement.outerHTML:''})()`);
  fs.writeFileSync(__dirname + '/receipt-print-frame.html', frameHtml);
  const inv2 = JSON.parse(invJson);
  log('RECEIPT-PRINT iframe html len:', frameHtml.length, '| inv_no:', frameHtml.includes(inv2.invoice_no), '| paid<total Due line:', /Balance Due/.test(frameHtml), '| paymethod:', frameHtml.includes('Paid (' + (inv2.payment_method || 'Cash') + ')'));
  // clear leftover cart for later
  await cdp.evaljs(`(()=>{const i=document.querySelector('[data-qty="TEST-UI-001"]');if(i){i.value=0;i.dispatchEvent(new Event('change',{bubbles:true}));}return 1})()`); await sleep(500);

  // === reports ===
  await cdp.evaljs(`switchView('reports'); void 0`); await sleep(1500);
  await cdp.shot('reports-default');
  // custom range: fill From and To then Show
  await cdp.evaljs(`(()=>{const f=document.getElementById('rptFrom'),t=document.getElementById('rptTo');if(!f)return 'nofields';f.value='2026-09-01';f.dispatchEvent(new Event('change',{bubbles:true}));t.value='2026-09-13';t.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('rptShow').click();return 'ok'})()`);
  await sleep(1200);
  log('RPT custom-range status:', await statusText());
  // From > To
  await cdp.evaljs(`(()=>{const f=document.getElementById('rptFrom'),t=document.getElementById('rptTo');f.value='2026-09-13';f.dispatchEvent(new Event('change',{bubbles:true}));t.value='2026-09-01';t.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('rptShow').click();return 1})()`);
  await sleep(800);
  log('RPT from>to status:', await statusText());
  // presets
  for (const [name, sel] of [['Yesterday', '[data-preset="yesterday"]'], ['ThisMonth', '[data-preset="this_month"]'], ['Today', '[data-preset="today"]']]) {
    await cdp.evaljs(`document.querySelector('${sel}')?.click(); void 0`); await sleep(900);
    log(`RPT preset ${name} status:`, await statusText());
  }
  // CSV export: capture blob
  await cdp.evaljs(`(()=>{window.__csv='';const old=URL.createObjectURL;URL.createObjectURL=(b)=>{b.text().then(t=>window.__csv=t);return old.call(URL,b)};return 1})()`);
  await cdp.evaljs(`document.getElementById('rptCsv')?.click(); void 0`); await sleep(1200);
  const csv = await cdp.evaljs(`window.__csv`);
  fs.writeFileSync(__dirname + '/export-sample.csv', csv || '');
  log('RPT CSV len:', (csv || '').length, 'status:', await statusText(), 'head:', (csv || '').split('\n').slice(0, 3).join(' | '));
  // on-screen totals row vs csv totals
  const tableTxt = await cdp.evaljs(`document.querySelector('.rpt-table, table')?.innerText?.slice(0,400) || ''`);
  log('RPT on-screen table head:', JSON.stringify(tableTxt.slice(0, 200)));
  // print report: stub window.open
  await cdp.evaljs(`(()=>{window.__print='';window.open=()=>({document:{write:(h)=>{window.__print+=h},close(){}},focus(){},print(){window.__printed=true}});return 1})()`);
  await cdp.evaljs(`document.getElementById('rptPrint')?.click(); void 0`); await sleep(1200);
  log('RPT print popup html len:', (await cdp.evaljs(`window.__print.length`)), 'printed:', await cdp.evaljs(`!!window.__printed`), 'status:', await statusText());
  // switch report tabs & a few reports
  const cats = await cdp.evaljs(`JSON.stringify([...document.querySelectorAll('[data-cat]')].map(b=>b.dataset.cat))`);
  log('RPT categories:', cats);
  for (const cat of JSON.parse(cats)) {
    cdp.resetNet();
    await cdp.evaljs(`document.querySelector('[data-cat="${cat}"]')?.click(); void 0`); await sleep(900);
    const err = await statusText();
    const reports = await cdp.evaljs(`JSON.stringify([...document.querySelectorAll('[data-report]')].map(b=>b.dataset.report||b.textContent.trim()))`);
    log(`RPT cat=${cat} status='${err}' reports=${reports} bad=${JSON.stringify(cdp.badResponses)} consoleErr=${cdp.consoleErrors.length}`);
  }
  // click every report chip
  const allReports = await cdp.evaljs(`JSON.stringify([...new Set([...document.querySelectorAll('[data-report]')].map(b=>b.dataset.report))])`);
  // iterate report keys via module registry instead: click each visible [data-report] after re-render per category is complex; do via registry keys if exposed
  log('RPT keys visible in last cat:', allReports);

  // === items form validation ===
  await cdp.evaljs(`switchView('items'); void 0`); await sleep(900);
  await cdp.evaljs(`document.getElementById('newItem').click(); void 0`); await sleep(400);
  const formErr = () => cdp.evaljs(`document.getElementById('itemFormError')?.textContent || ''`);
  // empty submit
  await cdp.evaljs(`document.getElementById('saveModal').click(); void 0`); await sleep(400);
  log('ITEM empty-submit msg:', await formErr());
  const fill = (o) => cdp.evaljs(`(()=>{const f=document.getElementById('itemForm');${Object.entries(o).map(([k, v]) => `f.elements['${k}'].value=${JSON.stringify(v)};`).join('')}return 1})()`);
  // negative price
  await fill({ code: 'TEST-UI-NEG', name: 'TEST-UI-NEG', purchase_price: -5, mrp: 10, stock: 10, sale_price: 8 });
  await cdp.evaljs(`document.getElementById('saveModal').click(); void 0`); await sleep(400);
  log('ITEM negative-price msg:', await formErr());
  // sale < purchase
  await fill({ code: 'TEST-UI-NEG', name: 'TEST-UI-NEG', purchase_price: 50, mrp: 100, stock: 10, sale_price: 40 });
  await cdp.evaljs(`document.getElementById('saveModal').click(); void 0`); await sleep(400);
  log('ITEM sale<purchase msg:', await formErr());
  // duplicate code
  await fill({ code: 'TEST-UI-001', name: 'TEST-UI-DUP', purchase_price: 10, mrp: 20, stock: 10, sale_price: 15 });
  await cdp.evaljs(`document.getElementById('saveModal').click(); void 0`); await sleep(600);
  log('ITEM dup-code msg:', await formErr());
  await cdp.evaljs(`document.getElementById('closeModal')?.click(); void 0`);

  // === cashier user via UI ===
  await cdp.evaljs(`switchView('settings'); void 0`); await sleep(900);
  await cdp.evaljs(`(()=>{const f=document.getElementById('userForm');f.elements['username'].value='TEST-UI-CASHIER';f.elements['password'].value='cashier123';f.elements['role'].value='cashier';f.requestSubmit();return 1})()`);
  await sleep(1000);
  log('CASHIER created, users:', await cdp.evaljs(`JSON.stringify((state.users||[]).map(u=>u.username+':'+u.role))`));

  // logout, login as cashier
  await cdp.evaljs(`document.getElementById('logoutBtn').click(); void 0`); await sleep(1000);
  await login('TEST-UI-CASHIER', 'cashier123');
  log('CASHIER login user:', await cdp.evaljs(`state.user && state.user.username + ':' + state.user.role`));
  log('CASHIER nav items:', await cdp.evaljs(`JSON.stringify([...document.querySelectorAll('[data-view]')].map(b=>b.dataset.view))`));
  await cdp.shot('cashier-nav');
  // try admin-only views by direct switchView
  for (const v of ['settings', 'reports', 'purchases', 'expenses']) {
    cdp.resetNet();
    await cdp.evaljs(`switchView('${v}').catch(e=>{window.__e=String(e)}); void 0`).catch(() => {});
    await sleep(1000);
    log(`CASHIER switchView('${v}') view=`, await cdp.evaljs(`state.view`), 'status:', await statusText(), 'bad:', JSON.stringify(cdp.badResponses.slice(0, 3)), 'err:', await cdp.evaljs(`window.__e||''`));
    await cdp.shot(`cashier-${v}`);
  }
  // back to pos for cashier screenshot
  await cdp.evaljs(`switchView('pos').catch(()=>{}); void 0`); await sleep(800);
  await cdp.shot('cashier-pos');

  fs.writeFileSync(__dirname + '/out3.txt', out.join('\n'));
  proc.kill(); process.exit(0);
})().catch(e => { console.error('FATAL', e); fs.writeFileSync(__dirname + '/out3.txt', out.join('\n')); process.exit(1); });
