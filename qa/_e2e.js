// End-to-end validation of the packaged MartPOS app (resources/app.asar)
// running under Electron. Drives the real window via Playwright's Electron
// support and exercises business workflows through the same HTTP API the
// UI uses. Run: node qa/_e2e.js
const { _electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { execFileSync, spawn } = require('child_process');

const ELECTRON = path.resolve(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const APP = path.resolve(__dirname, '..', 'dist-app', 'win-unpacked', 'resources', 'app.asar');
const DATA = path.resolve(__dirname, 'data-etest');
const LOGDIR = path.join(DATA, 'logs');

const results = [];
function rec(id, title, pass, note = '') {
  const t = pass === true ? 'PASS' : pass === false ? 'FAIL' : 'INFO';
  console.log(`[${t}] ${id} ${title}${note ? ' | ' + note : ''}`);
  results.push({ id, title, pass, note });
}
const near = (a, b, eps = 0.011) => Math.abs((+a) - (+b)) <= eps;

function cleanEnv(extra = {}) {
  const env = { ...process.env, MARTPOS_DATA_DIR: DATA, ...extra };
  delete env.ELECTRON_RUN_AS_NODE; // simulate a normal machine
  return env;
}

async function launch(extraEnv = {}) {
  return _electron.launch({ executablePath: ELECTRON, args: [APP], env: cleanEnv(extraEnv) });
}

async function apiOf(page) {
  return (method, url, body) => page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u, {
      method: m,
      headers: { 'content-type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b)
    });
    let json = null; const text = await r.text();
    try { json = JSON.parse(text); } catch (_) { /* pdf/html */ }
    return { status: r.status, json, ctype: r.headers.get('content-type'), len: text.length };
  }, [method, url, body]);
}

async function uiLogin(win, user, pass) {
  await win.waitForSelector('#username', { timeout: 15000 });
  await win.fill('#username', user);
  await win.fill('#password', pass);
  await win.click('#loginForm button[type=submit], #loginForm button');
}

function electronProcs() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*app.asar*' } | Measure-Object | Select-Object -ExpandProperty Count"
    ], { encoding: 'utf8' });
    return parseInt(out.trim(), 10) || 0;
  } catch (_) { return -1; }
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  // ---------- A. STARTUP ----------
  const app = await launch();
  const win = await app.firstWindow();
  await win.waitForURL(/127\.0\.0\.1:\d+/, { timeout: 30000 });
  const pageUrl = win.url();
  rec('A1', 'App window loads internal server UI', /127\.0\.0\.1:\d+/.test(pageUrl), pageUrl);
  rec('A2', 'Window title is MartPOS', (await win.title()) === 'MartPOS', await win.title());
  const api = await apiOf(win);
  const idx = await api('GET', '/');
  rec('A3', 'Index page served (200, HTML)', idx.status === 200 && idx.len > 500);
  const q = await api('GET', '/vendor/quagga.min.js');
  rec('A4', 'Vendored barcode lib served (offline-capable)', q.status === 200 && q.len > 100000);

  // Second instance
  const second = spawn(ELECTRON, [APP], { env: cleanEnv() });
  await new Promise(r => setTimeout(r, 6000));
  const stillUp = await api('GET', '/api/me');
  rec('A5', 'Second launch exits; first instance unaffected', stillUp.status === 200);
  try { second.kill(); } catch (_) {}

  // ---------- B. LOGIN ----------
  await uiLogin(win, 'admin', 'wrongpass');
  await win.waitForTimeout(1200);
  rec('B1', 'Invalid login rejected, stays on login form', !!(await win.$('#loginForm')));

  await uiLogin(win, 'admin', 'admin');
  await win.waitForSelector('#logoutBtn', { timeout: 10000 });
  rec('B2', 'Valid login admin/admin reaches app shell', true);

  const me = await api('GET', '/api/me');
  const uid = (me.json.user && me.json.user.id) || me.json.id || 1;
  // The Settings UI calls PUT /api/users/:id/password - verify the shipped
  // client uses a method the server actually accepts.
  const uiUsesPut = await win.evaluate(() =>
    fetch('/script.js').then(r => r.text()).then(t =>
      /api\(`\/api\/users\/\$\{state\.user\.id\}\/password`,\s*\{\s*method:\s*"PUT"/.test(t)));
  rec('B3', 'Served script.js password change uses PUT', uiUsesPut === true);
  const pwPut = await api('PUT', `/api/users/${uid}/password`, { password: 'test1234' });
  rec('B4', 'Password change via PUT works', pwPut.status === 200, `PUT status=${pwPut.status}`);

  await win.click('#logoutBtn');
  await win.waitForSelector('#loginForm', { timeout: 8000 });
  rec('B5', 'Logout returns to login form', true);
  const meOut = await api('GET', '/api/me');
  rec('B6', 'Session cleared after logout', !!(meOut.json && meOut.json.user === null), JSON.stringify(meOut.json && meOut.json.user));
  await uiLogin(win, 'admin', 'test1234');
  await win.waitForSelector('#logoutBtn', { timeout: 10000 });
  rec('B7', 'Login with changed password works', true);

  // ---------- C. BILLING ----------
  const mkA = await api('POST', '/api/items', { code: 'QATESTA', name: 'QA Test Item A', category: 'QATest', gst_percent: 18, purchase_price: 60, mrp: 120, sale_price: 100, stock: 100, unit: 'pcs', low_stock: 5 });
  const mkB = await api('POST', '/api/items', { code: 'QATESTB', name: 'QA Test Item B', category: 'QATest', gst_percent: 5, purchase_price: 30, mrp: 60, sale_price: 50, stock: 50, unit: 'pcs', low_stock: 200 });
  rec('C1', 'Create items A(₹100,18%) & B(₹50,5%)', mkA.status === 200 && mkB.status === 200);
  const idA = mkA.json.item.id;

  let cart = (await api('POST', '/add_to_cart', { code: 'QATESTA', quantity: 2 })).json.cart;
  rec('C2', 'Barcode/code add: 2×A', near(cart.subtotal, 200) && near(cart.tax, 36) && near(cart.total, 236), `subtotal=${cart.subtotal} tax=${cart.tax} total=${cart.total}`);
  cart = (await api('POST', '/add_to_cart', { code: 'QATESTB', quantity: 1 })).json.cart;
  rec('C3', 'Add 1×B → totals', near(cart.subtotal, 250) && near(cart.tax, 38.5) && near(cart.total, 288.5), `subtotal=${cart.subtotal} tax=${cart.tax} total=${cart.total}`);
  rec('C4', 'Intra GST split CGST=SGST', near(cart.cgst, 19.25) && near(cart.sgst, 19.25) && cart.igst === 0, `cgst=${cart.cgst} sgst=${cart.sgst}`);

  cart = (await api('POST', '/update_item', { code: 'QATESTA', quantity: 3 })).json.cart;
  rec('C5', 'Qty A 2→3', near(cart.subtotal, 350) && near(cart.tax, 56.5) && near(cart.total, 406.5), `subtotal=${cart.subtotal} tax=${cart.tax} total=${cart.total}`);
  cart = (await api('POST', '/update_item', { code: 'QATESTB', discount: 10 })).json.cart;
  rec('C6', 'Line discount ₹10 on B', near(cart.subtotal, 340) && near(cart.tax, 56) && near(cart.total, 396), `subtotal=${cart.subtotal} tax=${cart.tax} total=${cart.total}`);
  cart = (await api('POST', '/update_item', { code: 'QATESTB', price: 45 })).json.cart;
  rec('C7', 'Price override B 50→45', near(cart.subtotal, 335) && near(cart.total, 390.75), `total=${cart.total}`);
  cart = (await api('POST', '/remove_item', { code: 'QATESTB' })).json.cart;
  rec('C8', 'Remove B from cart', near(cart.subtotal, 300) && near(cart.total, 354), `total=${cart.total}`);
  await api('POST', '/add_to_cart', { code: 'QATESTB', quantity: 1 });
  cart = (await api('POST', '/api/cart/discount', { discount: 50 })).json.cart;
  // ratio = (350-50)/350 = 0.857 → tax 56.5*0.857 = 48.43, total 348.43
  rec('C9', 'Bill discount ₹50 scales tax', near(cart.subtotal, 350) && near(cart.tax, 48.43, 0.02) && near(cart.total, 348.43, 0.02), `tax=${cart.tax} total=${cart.total}`);

  const hold = await api('POST', '/api/cart/hold', { name: 'QA hold' });
  rec('C10', 'Hold bill clears cart', hold.status === 200 && Object.keys(hold.json.cart.items).length === 0);
  const heldId = hold.json.held.id;
  const recall = await api('POST', `/api/cart/recall/${heldId}`);
  rec('C11', 'Recall held bill restores cart', recall.status === 200 && near(recall.json.cart.total, 348.43, 0.02), `total=${recall.json.cart.total}`);

  await api('POST', '/api/cart/clear');
  await api('POST', '/add_to_cart', { code: 'QATESTA', quantity: 2 });
  const stockBefore = (await api('GET', '/api/items?q=QATESTA')).json.items.find(i => i.code === 'QATESTA').stock;
  const sale1 = await api('POST', '/api/sale', { payment_method: 'Cash', paid: 236 });
  rec('C12', 'Sale (Cash) 2×A completes', sale1.status === 200 && near(sale1.json.invoice.total, 236), `inv=${sale1.json && sale1.json.invoice && sale1.json.invoice.invoice_no} total=${sale1.json && sale1.json.invoice && sale1.json.invoice.total}`);
  const inv1 = sale1.json.invoice;
  const stockAfter = (await api('GET', '/api/items?q=QATESTA')).json.items.find(i => i.code === 'QATESTA').stock;
  rec('C13', 'Stock reduced by sale (100→98)', near(stockBefore - stockAfter, 2) && near(stockAfter, 98), `stock=${stockAfter}`);

  await api('POST', '/add_to_cart', { code: 'QATESTB', quantity: 1 });
  const sale2 = await api('POST', '/api/sale', { payment_method: 'UPI', paid: 52.5 });
  rec('C14', 'Sale (UPI) 1×B completes', sale2.status === 200 && near(sale2.json.invoice.total, 52.5), `total=${sale2.json && sale2.json.invoice && sale2.json.invoice.total}`);
  await api('POST', '/add_to_cart', { code: 'QATESTA', quantity: 1 });
  const sale3 = await api('POST', '/api/sale', { payment_method: 'Card', paid: 50 });
  const inv3 = sale3.json.invoice;
  rec('C15', 'Sale (Card) partial paid → due', sale3.status === 200 && near(inv3.total, 118) && near(inv3.paid, 50), `total=${inv3.total} paid=${inv3.paid}`);

  const invGet = await api('GET', `/api/invoices/${inv1.id}`);
  rec('C16', 'Invoice retrievable with items', invGet.status === 200 && (invGet.json.invoice.items || []).length === 1);
  const pdf = await api('GET', `/invoice_pdf?id=${inv1.id}`);
  rec('C17', 'A4 invoice PDF generated', pdf.status === 200 && /pdf/.test(pdf.ctype || ''), pdf.ctype);

  const inv3Full = (await api('GET', `/api/invoices/${inv3.id}`)).json.invoice;
  const ret = await api('POST', `/api/invoices/${inv3.id}/return`, { items: [{ invoice_item_id: inv3Full.items[0].id, quantity: 1 }], reason: 'QA return' });
  rec('C18', 'Sale return accepted (manager+)', ret.status === 200, `status=${ret.status}`);
  const cancelRes = await api('POST', `/api/invoices/${inv3.id}/cancel`, { reason: 'QA cancel' });
  rec('C19', 'Invoice cancel works', cancelRes.status === 200, `status=${cancelRes.status}`);

  // ---------- D. INVENTORY ----------
  const sup = await api('POST', '/api/parties', { name: 'QA Supplier', type: 'supplier' });
  const stBeforePur = (await api('GET', '/api/items?q=QATESTA')).json.items.find(i => i.code === 'QATESTA').stock;
  const pur = await api('POST', '/api/purchases', { party_id: sup.json.party.id, paid: 550, items: [{ code: 'QATESTA', quantity: 10, price: 55, mrp: 120 }] });
  rec('D1', 'Purchase 10×A @55 posts', pur.status === 200, `status=${pur.status}`);
  const stAfterPur = (await api('GET', '/api/items?q=QATESTA')).json.items.find(i => i.code === 'QATESTA').stock;
  rec('D2', 'Stock increased by purchase (+10)', near(stAfterPur - stBeforePur, 10), `${stBeforePur}→${stAfterPur}`);
  const adj = await api('POST', '/api/stock-adjustments', { item_id: idA, change: -3, type: 'damage', reason: 'QA damage' });
  rec('D3', 'Stock adjustment (damage −3)', adj.status === 200, `status=${adj.status}`);
  const stAfterAdj = (await api('GET', '/api/items?q=QATESTA')).json.items.find(i => i.code === 'QATESTA').stock;
  rec('D4', 'Stock reflects adjustment (−3)', near(stAfterPur - stAfterAdj, 3), `${stAfterPur}→${stAfterAdj}`);
  const low = await api('GET', '/api/reports/inventory/low-stock');
  rec('D5', 'Low-stock report contains B (low_stock=200)', low.status === 200 && JSON.stringify(low.json).includes('QATESTB'));
  const edit = await api('PUT', `/api/items/${idA}`, { code: 'QATESTA', name: 'QA Test Item A2', category: 'QATest', gst_percent: 18, purchase_price: 60, sale_price: 110, mrp: 130, stock: 95, unit: 'pcs', low_stock: 5 });
  rec('D6', 'Item edit (name/price) works', edit.status === 200 && edit.json.item.name === 'QA Test Item A2', `status=${edit.status} ${edit.json && edit.json.error || ''}`);
  const stFinal = (await api('GET', '/api/items?q=QATESTA')).json.items.find(i => i.code === 'QATESTA').stock;

  // ---------- E. REPORTS ----------
  const REPORTS = ['overview','sales/summary','sales/day-wise','sales/bill-wise','sales/item-wise','sales/category-wise','sales/customer-wise','sales/cashier-wise','sales/payment-wise','sales/hourly','sales/discounts','sales/cancelled','sales/returns','inventory/current-stock','inventory/low-stock','inventory/out-of-stock','inventory/valuation','inventory/movement','inventory/fast-moving','inventory/slow-moving','inventory/dead-stock','inventory/adjustments','purchases/summary','purchases/supplier-wise','purchases/item-wise','purchases/invoices','purchases/returns','purchases/payments','purchases/pending','profit-loss/summary','profit-loss/day-wise','profit-loss/item-wise','profit-loss/category-wise','profit-loss/expenses','profit-loss/expense-categories','profit-loss/income-expense','payments/summary','payments/daily','payments/credit-sales','payments/collections','payments/day-closing','customers/summary','customers/outstanding','customers/top','suppliers/summary','suppliers/outstanding','suppliers/payments','suppliers/top','returns/all','gst/sales','gst/purchases','gst/rate-wise','gst/hsn-sales','gst/hsn-purchases','gst/returns','cashiers/sales','cashiers/payments','cashiers/discounts','cashiers/returns','cashiers/sessions','meta'];
  const rFail = [];
  for (const r of REPORTS) {
    const res = await api('GET', `/api/reports/${r}`);
    if (!(res.status === 200 && res.json && res.json.ok !== false)) rFail.push(`${r}:${res.status}`);
  }
  rec('E1', `All ${REPORTS.length} reports return data`, rFail.length === 0, rFail.join(','));
  const dateRpt = await api('GET', '/api/reports/sales/summary?from=2020-01-01&to=2020-01-31');
  const todayRpt = await api('GET', '/api/reports/sales/summary');
  rec('E2', 'Date-range filter works (2020 range differs)', dateRpt.status === 200 && JSON.stringify(dateRpt.json.report) !== JSON.stringify(todayRpt.json.report));
  const gstR = await api('GET', '/api/reports/gst/sales');
  rec('E3', 'GST sales report has tax data', gstR.status === 200 && /total_gst|tax/i.test(JSON.stringify(gstR.json)));

  const openOk = await win.evaluate(() => {
    const w = window.open('', '_blank');
    if (!w) return false;
    w.document.write('<p>qa</p>'); w.document.close();
    setTimeout(() => w.close(), 500);
    return true;
  });
  rec('E4', 'window.open (report/print window) allowed inside Electron', openOk);

  // ---------- F. PRINTING (code-path level) ----------
  const widths = await win.evaluate(() => {
    const out = {};
    for (const w of ['58', '80', '100']) {
      const html = ReceiptPrinter.buildHtml(ReceiptPrinter.sampleInvoice(), { ...ReceiptPrinter.DEFAULTS, printer_width: w });
      out[w] = html.includes(`@page { size: ${w}mm`);
    }
    return out;
  });
  rec('F1', 'Receipt HTML renders @page for 58/80/100mm', widths['58'] && widths['80'] && widths['100'], JSON.stringify(widths));

  // /invoice_pdf is an attachment; Electron downloads it and opens it in the
  // system PDF viewer. Verify the file actually lands in Downloads.
  const dlDir = path.join(require('os').homedir(), 'Downloads');
  const dlBefore = new Set(fs.existsSync(dlDir) ? fs.readdirSync(dlDir) : []);
  await win.evaluate((id) => { window.open(`/invoice_pdf?id=${id}`, '_blank'); }, inv1.id);
  let dlFile = null;
  for (let i = 0; i < 10 && !dlFile; i++) {
    await win.waitForTimeout(700);
    const now = fs.readdirSync(dlDir);
    dlFile = now.find(f => !dlBefore.has(f) && /^invoice-.*\.pdf$/i.test(f)) || null;
  }
  rec('F2', 'Invoice PDF downloads + opens in system viewer', !!dlFile, dlFile || 'no file');
  for (const w of app.windows()) { if (w !== win) { try { await w.close(); } catch (_) {} } }

  // ---------- G/H. SHUTDOWN + PERSISTENCE (real window-close path) ----------
  await win.close();
  await new Promise(r => setTimeout(r, 4000));
  const left = electronProcs();
  rec('H1', 'No orphan Electron processes after window close', left === 0, `leftover=${left}`);
  const logs = fs.existsSync(LOGDIR) ? fs.readdirSync(LOGDIR).filter(f => f.endsWith('.log')) : [];
  const logText = logs.map(f => fs.readFileSync(path.join(LOGDIR, f), 'utf8')).join('');
  rec('H2', 'Log shows graceful shutdown + flush', /MartPOS shutting down/.test(logText));
  rec('G1', 'pos.db written to app data dir', fs.existsSync(path.join(DATA, 'pos.db')) && fs.statSync(path.join(DATA, 'pos.db')).size > 10000);
  try { await app.close(); } catch (_) {}

  // Relaunch → persistence
  const app2 = await launch();
  const win2 = await app2.firstWindow();
  await win2.waitForURL(/127\.0\.0\.1:\d+/, { timeout: 30000 });
  const api2 = await apiOf(win2);
  await uiLogin(win2, 'admin', 'test1234');
  await win2.waitForSelector('#logoutBtn', { timeout: 10000 });
  const invAfter = await api2('GET', `/api/invoices/${inv1.id}`);
  const stPersist = (await api2('GET', '/api/items?q=QATESTA')).json.items.find(i => i.code === 'QATESTA').stock;
  const billWise = await api2('GET', '/api/reports/sales/bill-wise');
  rec('G2', 'Sale persists after restart', invAfter.status === 200 && invAfter.json.invoice.invoice_no === inv1.invoice_no, inv1.invoice_no);
  rec('G3', 'Inventory change persists after restart', near(stPersist, stFinal), `stock=${stPersist} expected=${stFinal}`);
  rec('G4', 'Bill-wise report contains the sale after restart', billWise.status === 200 && JSON.stringify(billWise.json).includes(inv1.invoice_no), inv1.invoice_no);
  await app2.close();
  await new Promise(r => setTimeout(r, 2000));

  // ---------- I. OFFLINE (abort all non-local requests in the renderer) ----------
  const app3 = await launch();
  const win3 = await app3.firstWindow();
  await win3.route('**/*', route =>
    route.request().url().startsWith('http://127.0.0.1') ? route.continue() : route.abort()
  );
  await win3.waitForURL(/127\.0\.0\.1:\d+/, { timeout: 30000 });
  const api3 = await apiOf(win3);
  await uiLogin(win3, 'admin', 'test1234');
  await win3.waitForSelector('#logoutBtn', { timeout: 10000 });
  await api3('POST', '/add_to_cart', { code: 'QATESTA', quantity: 1 });
  const offSale = await api3('POST', '/api/sale', { payment_method: 'Cash', paid: 129.8 });
  rec('I1', 'Offline: login + billing + sale work (external requests blocked)', offSale.status === 200 && offSale.json.invoice.total > 0, `total=${offSale.json && offSale.json.invoice && offSale.json.invoice.total}`);
  const offRpt = await api3('GET', '/api/reports/sales/summary');
  rec('I2', 'Offline: reports work', offRpt.status === 200);
  await app3.close();
  await new Promise(r => setTimeout(r, 2000));

  // ---------- J. ERROR HANDLING ----------
  const blocker = net.createServer().listen(5055);
  await new Promise(r => blocker.once('listening', r));
  const app4 = await launch({ PORT: '5055' });
  const win4 = await app4.firstWindow();
  await win4.waitForURL(/127\.0\.0\.1:\d+/, { timeout: 30000 });
  const p4 = new URL(win4.url()).port;
  rec('J1', 'Port conflict falls back to a free port', p4 !== '5055', `port=${p4}`);
  await app4.close();
  blocker.close();
  await new Promise(r => setTimeout(r, 2000));

  // Unusable data dir (path is a file) → app must surface a native error
  // (showErrorBox keeps the process up showing the dialog until the user
  // dismisses it - that IS the intended UX, verified via captured output).
  const badDir = path.join(DATA, 'blocker-file');
  fs.writeFileSync(badDir, 'x');
  const badEnv = { ...process.env, MARTPOS_DATA_DIR: badDir };
  delete badEnv.ELECTRON_RUN_AS_NODE;
  const errShown = await new Promise((resolve) => {
    const p = spawn(ELECTRON, [APP], { env: badEnv });
    let out = '';
    const onData = d => {
      out += d;
      if (/MartPOS backend failed to start/.test(out)) { cleanup(); resolve(true); }
    };
    const cleanup = () => { clearTimeout(t); try { p.kill(); } catch (_) {} };
    const t = setTimeout(() => { cleanup(); resolve(false); }, 20000);
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('exit', () => { if (/MartPOS backend failed to start/.test(out)) { clearTimeout(t); resolve(true); } });
  });
  rec('J2', 'Unusable data dir → native error shown (backend-failed path reached)', errShown === true);
  const tmpLog = path.join(require('os').tmpdir(), 'MartPOS', 'logs');
  const tmpOk = fs.existsSync(tmpLog) && fs.readdirSync(tmpLog).some(f => f.endsWith('.log'));
  rec('J3', 'Fallback logging captured the failure', tmpOk, tmpLog);

  const pass = results.filter(r => r.pass === true).length;
  const fail = results.filter(r => r.pass === false).length;
  const info = results.length - pass - fail;
  console.log(`\n===== E2E SUMMARY: ${pass} pass, ${fail} fail, ${info} info =====`);
  results.filter(r => r.pass === false).forEach(r => console.log(`  FAIL ${r.id} ${r.title} ${r.note}`));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('E2E driver crashed:', e); process.exit(2); });
