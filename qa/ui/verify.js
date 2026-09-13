// Targeted re-verification of the frontend QA fixes (post-fix run). v2
const cdp = require('./cdp');
const BASE = 'http://127.0.0.1:5055';
const out = [];
const rec = (id, name, pass, info) => { out.push({ id, name, pass, info }); console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name} ${info ? '| ' + info : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cartLen = () => cdp.evaljs(`api('/cart').then(c=>c.cart.items.length).catch(e=>'ERR '+e.message)`, true);

(async () => {
  await cdp.launch();
  await cdp.setViewport(1366, 768);
  await cdp.goto(BASE + '/');
  await sleep(1200);

  const u = await cdp.evaljs(`document.querySelector('#username')?.value`);
  const p = await cdp.evaljs(`document.querySelector('#password')?.value`);
  rec('UI-LOGIN-prefill', 'login fields not prefilled', u === '' && p === '', `u='${u}' p='${p}'`);

  await cdp.evaljs(`document.querySelector('#username').value='admin';document.querySelector('#password').value='admin';document.getElementById('loginForm').requestSubmit();void 0`);
  await sleep(1800);
  const loggedIn = await cdp.evaljs(`state.user && state.user.role`);
  rec('UI-LOGIN', 'admin login', loggedIn === 'admin', `role=${loggedIn}`);

  // POS add item: no /add_item 404, item lands in cart
  cdp.resetNet();
  await cdp.evaljs(`switchView('pos'); void 0`);
  await sleep(1200);
  await cdp.evaljs(`(()=>{const s=document.getElementById('productSearch');s.value='TEST-MILK-001';s.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('addBtn').click();return 1})()`);
  await sleep(1000);
  const cl1 = await cartLen();
  const badReq = cdp.badResponses.filter(x => x.includes('add_item')).length;
  const consoleErr = cdp.consoleErrors.filter(e => /add_item|Not found/i.test(e)).length;
  rec('UI-POS-add', 'add via button works, item in cart', cl1 >= 1, `items=${JSON.stringify(cl1)}`);
  rec('UI-POS-add-404', 'no 404 /add_item request or console error', badReq === 0 && consoleErr === 0, `badReq=${badReq} consoleErr=${consoleErr}`);

  // Remove button + clear button
  const hasRemove = await cdp.evaljs(`!!document.querySelector('[data-remove]')`);
  rec('UI-POS-removebtn', 'per-line remove button exists', hasRemove === true);
  if (hasRemove) {
    await cdp.evaljs(`document.querySelector('[data-remove]').click(); void 0`);
    await sleep(900);
    const len2 = await cartLen();
    rec('UI-POS-remove', 'remove button deletes line', len2 === 0, `items=${JSON.stringify(len2)}`);
  }
  const clearBtn = await cdp.evaljs(`[...document.querySelectorAll('button')].filter(b=>/clear/i.test(b.textContent)).map(b=>b.textContent.trim()).join(',')`);
  rec('UI-POS-clearbtn', 'clear cart button exists', clearBtn !== '', `btn='${clearBtn}'`);
  // exercise it
  await cdp.evaljs(`(()=>{const s=document.getElementById('productSearch');s.value='TEST-MILK-001';s.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('addBtn').click();return 1})()`);
  await sleep(900);
  await cdp.evaljs(`[...document.querySelectorAll('button')].find(b=>/clear/i.test(b.textContent))?.click(); void 0`);
  await sleep(900);
  const lenC = await cartLen();
  rec('UI-POS-clear', 'clear button empties cart', lenC === 0, `items=${JSON.stringify(lenC)}`);

  // Qty minus at 1 removes line
  await cdp.evaljs(`(()=>{const s=document.getElementById('productSearch');s.value='TEST-MILK-001';s.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('addBtn').click();return 1})()`);
  await sleep(900);
  await cdp.evaljs(`document.querySelector('[data-qty-minus]')?.click(); void 0`);
  await sleep(900);
  const len3 = await cartLen();
  rec('UI-POS-minus-zero', 'minus at qty 1 removes line', len3 === 0, `items=${JSON.stringify(len3)}`);

  // favicon
  cdp.resetNet();
  await cdp.goto(BASE + '/');
  await sleep(1200);
  const favicon404 = cdp.badResponses.filter(x => x.includes('favicon')).length;
  rec('UI-FAVICON', 'no favicon 404', favicon404 === 0, `hits=${favicon404}`);

  // re-login if needed, then settings add-user keeps list
  const needLogin = await cdp.evaljs(`!state.user`);
  if (needLogin) {
    await cdp.evaljs(`document.querySelector('#username').value='admin';document.querySelector('#password').value='admin';document.getElementById('loginForm').requestSubmit();void 0`);
    await sleep(1800);
  }
  await cdp.evaljs(`switchView('settings'); void 0`);
  await sleep(1200);
  const before = await cdp.evaljs(`document.querySelectorAll('#view table tbody tr').length`);
  await cdp.evaljs(`
    const f = [...document.querySelectorAll('form')].find(f=>f.querySelector('[name=username]'));
    if (f) { f.querySelector('[name=username]').value='TEST-UI-USER3'; f.querySelector('[name=password]').value='Test@1234';
      const r=f.querySelector('[name=role]'); if(r) r.value='cashier';
      f.requestSubmit(); } void 0`);
  await sleep(1500);
  const after = await cdp.evaljs(`document.querySelectorAll('#view table tbody tr').length`);
  rec('UI-USER-list', 'user list still renders after add user', after >= before, `rows ${before} -> ${after}`);

  // Reports overflow at 1024
  await cdp.setViewport(1024, 768);
  await cdp.evaljs(`switchView('reports'); void 0`);
  await sleep(1500);
  const ow = await cdp.evaljs(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  rec('UI-RPT-1024', 'reports view no horizontal overflow at 1024px', ow <= 0, `overflow=${ow}px`);
  await cdp.setViewport(1366, 768);

  // Cashier gating: fresh page + login as TEST-CASHIER
  await cdp.goto(BASE + '/');
  await sleep(1000);
  await cdp.evaljs(`fetch('/api/logout',{method:'POST'}); void 0`);
  await sleep(1000);
  await cdp.goto(BASE + '/');
  await sleep(1200);
  const hasForm = await cdp.evaljs(`!!document.getElementById('loginForm')`);
  if (hasForm) {
    await cdp.evaljs(`document.querySelector('#username').value='TEST-CASHIER';document.querySelector('#password').value='Test@123';document.getElementById('loginForm').requestSubmit();void 0`);
    await sleep(1800);
  }
  const role = await cdp.evaljs(`state.user && state.user.role`);
  if (role !== 'cashier') {
    rec('UI-CASHIER-gate', 'cashier settings view blocked', false, `login role=${role} hasForm=${hasForm}`);
  } else {
    await cdp.evaljs(`switchView('settings'); void 0`);
    await sleep(900);
    const view = await cdp.evaljs(`state.view`);
    const hasUserForm = await cdp.evaljs(`!!document.querySelector('#view [name=username]')`);
    const statusTxt = await cdp.evaljs(`document.querySelector('.status')?.textContent?.trim() || ''`);
    rec('UI-CASHIER-gate', 'cashier cannot open settings view', view !== 'settings' && hasUserForm === false, `view=${view} hasUserForm=${hasUserForm} status='${statusTxt}'`);
    await cdp.evaljs(`switchView('purchases'); void 0`);
    await sleep(900);
    const view2 = await cdp.evaljs(`state.view`);
    rec('UI-CASHIER-gate2', 'cashier cannot open purchases view', view2 !== 'purchases', `view=${view2}`);
  }

  const fails = out.filter(x => !x.pass).length;
  console.log(`\n===== UI VERIFY: ${out.length - fails}/${out.length} pass, ${fails} fail =====`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
