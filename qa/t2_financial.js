const H = require('./harness');
const { Client, check, checkNear, record, summary, db, rows, one, near } = H;
const r2 = n => Math.round(n * 100) / 100;

// Independent re-implementation of the documented bill formula (exclusive GST, line disc, prorated bill disc)
function expectBill(lines, billDisc = 0, gstType = 'intra') {
  let subtotal = 0, tax = 0; const out = [];
  for (const l of lines) {
    const taxable = Math.max(0, l.qty * l.price - (l.disc || 0));
    const lt = r2(taxable * l.gst / 100);
    out.push({ taxable, lt, line_total: r2(taxable + lt) });
    subtotal += taxable; tax += lt;
  }
  const after = Math.max(0, subtotal - billDisc);
  tax = subtotal > 0 && billDisc > 0 ? r2(tax * after / subtotal) : r2(tax);
  const half = r2(tax / 2);
  return { subtotal: r2(subtotal), discount: r2(billDisc), tax, cgst: gstType === 'inter' ? 0 : half, sgst: gstType === 'inter' ? 0 : r2(tax - half), igst: gstType === 'inter' ? tax : 0, total: r2(after + tax), lines: out };
}

async function itemByCode(c, code) { const r = await c.get(`/api/items?q=${encodeURIComponent(code)}`); return r.json.items.find(i => i.code === code); }
async function party(c, name) { const r = await c.get('/api/parties'); return r.json.parties.find(p => p.name === name); }
async function sell(c, lines, opts = {}) {
  await c.post('/api/cart/clear', {});
  for (const l of lines) {
    const r = await c.post('/add_to_cart', { code: l.code, quantity: l.qty });
    if (!r.json?.ok) return r;
    if (l.disc || l.price) await c.post('/update_item', { code: l.code, discount: l.disc, price: l.price });
  }
  if (opts.billDisc) await c.post('/api/cart/discount', { discount: opts.billDisc });
  if (opts.partyId) await c.post('/api/cart/party', { party_id: opts.partyId });
  else await c.post('/api/cart/party', { party_name: 'Walk-in Customer' });
  const cartBefore = (await c.get('/cart')).json.cart;
  const r = await c.post('/api/sale', { payment_method: opts.method || 'Cash', paid: opts.paid });
  r.cart = cartBefore;
  return r;
}

(async () => {
  const admin = new Client('admin'); await admin.login('admin', 'admin');
  const cust1 = await party(admin, 'TEST-CUSTOMER-001');
  const cust2 = await party(admin, 'TEST-CUSTOMER-002');
  const sup1 = await party(admin, 'TEST-SUPPLIER-001');
  const sup2 = await party(admin, 'TEST-SUPPLIER-002');
  const today = new Date(); const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const rng = `from=${ymd}&to=${ymd}`;

  // Baselines for delta comparisons
  const dash0 = (await admin.get(`/api/dashboard?${rng}`)).json.dashboard;
  const pl0 = (await admin.get(`/api/reports/profit-loss/summary?${rng}`)).json.report.summary;

  // ================= PHASE 6: PURCHASES =================
  let rice = await itemByCode(admin, 'TEST-RICE-001');
  check('TC-PUR-000', 'purchases', 'rice opening stock', 100, rice.stock);
  const sup1Out0 = sup1.outstanding;

  let r = await admin.post('/api/purchases', { party_id: sup1.id, paid: 0, items: [{ code: 'TEST-RICE-001', quantity: 50, price: 40, mrp: 55, sale_price: 50, gst_percent: 5 }] });
  const pur1 = r.json?.purchase;
  check('TC-PUR-001', 'purchases', 'create credit purchase 50 rice @40 gst5', { ok: true, subtotal: 2000, tax: 100, total: 2100, paid: 0 }, { ok: r.json?.ok, subtotal: pur1?.subtotal, tax: pur1?.tax, total: pur1?.total, paid: pur1?.paid }, r.text.slice(0, 200));
  rice = await itemByCode(admin, 'TEST-RICE-001');
  check('TC-PUR-001-stock', 'purchases', 'stock 100+50', 150, rice.stock);
  let s1 = await party(admin, 'TEST-SUPPLIER-001');
  checkNear('TC-PUR-007', 'purchases', 'supplier outstanding +2100 after credit purchase', sup1Out0 + 2100, s1.outstanding);

  r = await admin.post('/api/purchases', { party_id: sup2.id, paid: 500, items: [
    { code: 'TEST-SUGAR-001', quantity: 20, price: 42, mrp: 50, sale_price: 48, gst_percent: 5 },
    { code: 'TEST-MILK-001', quantity: 30, price: 25, mrp: 30, sale_price: 30, gst_percent: 0 }] });
  const pur2 = r.json?.purchase;
  // sugar 840 + tax 42 = 882 ; milk 750 + 0 = 750 ; total 1632
  check('TC-PUR-002/008', 'purchases', 'multi-item partial-paid purchase totals', { subtotal: 1590, tax: 42, total: 1632, paid: 500 }, { subtotal: pur2?.subtotal, tax: pur2?.tax, total: pur2?.total, paid: pur2?.paid }, r.text.slice(0, 200));
  let s2 = await party(admin, 'TEST-SUPPLIER-002');
  checkNear('TC-PUR-008-out', 'purchases', 'supplier2 outstanding = opening 250 + 1132', 250 + 1132, s2.outstanding);
  r = await admin.post(`/api/parties/${sup2.id}/payment`, { amount: 632, method: 'Cash', note: 'TEST supplier payment' });
  s2 = await party(admin, 'TEST-SUPPLIER-002');
  checkNear('TC-SUP-pay', 'suppliers', 'supplier2 outstanding after 632 payment = 750', 750, s2.outstanding);

  r = await admin.post('/api/purchases', { party_id: sup1.id, items: [{ code: 'TEST-RICE-001', quantity: 0, price: 40, mrp: 55 }] });
  record('TC-PUR-010', 'purchases', 'zero quantity purchase rejected', 'reject', r.json?.ok ? `ACCEPTED ${r.json.purchase.purchase_no} total=${r.json.purchase.total}` : r.text, r.json?.ok ? false : true);
  r = await admin.post('/api/purchases', { party_id: sup1.id, items: [{ code: 'TEST-RICE-001', quantity: -5, price: 40, mrp: 55 }] });
  record('TC-PUR-011', 'purchases', 'negative quantity purchase rejected', 'reject', r.json?.ok ? `ACCEPTED ${r.json.purchase.purchase_no} total=${r.json.purchase.total} (stock reduced!)` : r.text, r.json?.ok ? false : true);
  rice = await itemByCode(admin, 'TEST-RICE-001');
  record('TC-PUR-011-stock', 'purchases', 'rice stock after negative-qty purchase attempt (should stay 150)', 150, rice.stock, rice.stock === 150);
  r = await admin.post('/api/purchases', { party_id: sup1.id, items: [{ code: 'TEST-RICE-001', quantity: 1, price: -40, mrp: 55 }] });
  record('TC-PUR-012', 'purchases', 'negative price purchase rejected', 'reject', r.json?.ok ? `ACCEPTED total=${r.json.purchase.total}` : r.text, r.json?.ok ? false : true);
  r = await admin.post('/api/purchases', { party_id: sup1.id, items: [{ code: 'TEST-RICE-001', quantity: 'abc', price: 40, mrp: 55 }] });
  record('TC-PUR-009', 'purchases', 'invalid quantity "abc" rejected', 'reject', r.json?.ok ? `ACCEPTED qty=${r.json.purchase.items[0].quantity}` : r.text, r.json?.ok ? false : true);
  r = await admin.post('/api/purchases', { party_id: sup1.id, paid: 99999, items: [{ code: 'TEST-BREAD-001', quantity: 1, price: 30, mrp: 45, sale_price: 40 }] });
  record('TC-PUR-paid-over', 'purchases', 'paid > total on purchase (over-payment) rejected/capped', 'cap or reject', r.json?.ok ? `ACCEPTED paid=${r.json.purchase.paid} total=${r.json.purchase.total}` : r.text, r.json?.ok ? false : true);
  r = await admin.post('/api/purchases', { party_id: sup1.id, paid: -100, items: [{ code: 'TEST-BREAD-001', quantity: 1, price: 30, mrp: 45, sale_price: 40 }] });
  record('TC-PUR-paid-neg', 'purchases', 'negative paid on purchase rejected', 'reject', r.json?.ok ? `ACCEPTED paid=${r.json.purchase.paid}` : r.text, r.json?.ok ? false : true);
  r = await admin.post('/api/purchases', { party_id: sup1.id, items: [{ code: 'NOPE-XYZ', quantity: 1, price: 1, mrp: 2 }] });
  check('TC-PUR-unknown', 'purchases', 'unknown item -> 400', 400, r.status, r.text);
  r = await admin.post('/api/purchases', { party_id: 999999, items: [{ code: 'TEST-BREAD-001', quantity: 1, price: 30, mrp: 45 }] });
  record('TC-PUR-badparty', 'purchases', 'nonexistent supplier id accepted?', 'reject', r.json?.ok ? `ACCEPTED party_id=${r.json.purchase.party_id} name='${r.json.purchase.party_name}'` : r.text, r.json?.ok ? false : true);
  r = await admin.post('/api/purchases', { party_id: cust1.id, items: [{ code: 'TEST-BREAD-001', quantity: 1, price: 30, mrp: 45 }] });
  record('TC-PUR-custparty', 'purchases', 'purchase from a CUSTOMER-type party accepted?', 'reject', r.json?.ok ? `ACCEPTED` : r.text, r.json?.ok ? false : true);
  // purchase updates catalogue prices
  const bread = await itemByCode(admin, 'TEST-BREAD-001');
  record('TC-PUR-priceupd', 'purchases', 'purchase updated item purchase/sale/mrp', 'info', { pp: bread.purchase_price, sp: bread.sale_price, mrp: bread.mrp, stock: bread.stock }, 'info');

  // ================= PHASE 7/8: POS BILLING =================
  // Scenario: multi-item, multi GST, line discount, bill discount
  const lines = [{ code: 'TEST-RICE-001', qty: 2, price: 50, gst: 5 }, { code: 'TEST-BREAD-001', qty: 1, price: 40, gst: 18 }, { code: 'TEST-BISCUIT-001', qty: 3, price: 10.99, gst: 12 }];
  let exp = expectBill(lines, 10);
  r = await sell(admin, lines.map(l => ({ code: l.code, qty: l.qty })), { billDisc: 10, method: 'Cash' });
  let inv = r.json?.invoice;
  check('TC-POS-multi', 'pos', 'multi-item + bill discount totals (server)', { subtotal: exp.subtotal, discount: exp.discount, tax: exp.tax, cgst: exp.cgst, sgst: exp.sgst, total: exp.total }, inv && { subtotal: inv.subtotal, discount: inv.discount, tax: inv.tax, cgst: inv.cgst, sgst: inv.sgst, total: inv.total }, r.text.slice(0, 200));
  check('TC-POS-cart-vs-invoice', 'pos', 'cart preview totals == saved invoice totals', { subtotal: r.cart.subtotal, tax: r.cart.tax, total: r.cart.total }, inv && { subtotal: inv.subtotal, tax: inv.tax, total: inv.total });
  check('TC-POS-lines', 'pos', 'line totals', exp.lines.map(l => l.line_total), inv?.items.map(i => i.line_total));
  check('TC-CALC-invariant', 'calc', 'subtotal - discount + tax == total', true, near(inv.subtotal - inv.discount + inv.tax, inv.total));
  check('TC-CALC-gstsplit', 'calc', 'cgst + sgst == tax', true, near(inv.cgst + inv.sgst, inv.tax));
  check('TC-POS-status-paid', 'pos', 'paid=null -> full paid', { paid: exp.total, status: 'paid' }, { paid: inv.paid, status: inv.status });
  const multiInv = inv;
  // DB stored total matches
  let d = await db();
  let dbinv = one(d, 'SELECT * FROM invoices WHERE id=?', [inv.id]);
  check('TC-CALC-db', 'calc', 'DB stored total == API total', inv.total, dbinv.total);
  let dbsum = one(d, 'SELECT SUM(line_total) s FROM invoice_items WHERE invoice_id=?', [inv.id]);
  record('TC-CALC-lines-vs-total', 'calc', 'sum(line_total) vs invoice total (differs by bill discount 10 + tax proration)', r2(inv.total), r2(dbsum.s), 'info');
  // PDF
  r = await admin.get(`/invoice_pdf?id=${inv.id}`);
  check('TC-PRINT-pdf', 'printing', 'PDF generated for invoice', true, r.status === 200 && r.text.startsWith('%PDF'));

  // Rounding cases
  for (const [price, qty, gst] of [[10.00, 1, 18], [10.50, 1, 18], [10.99, 1, 18], [0.01, 1, 18], [0.01, 3, 5], [99999.99, 7, 28]]) {
    r = await admin.post('/api/items', { code: `TEST-R-${price}-${gst}`, name: `TEST round ${price} ${gst}`, purchase_price: 0.001, sale_price: price, mrp: price, gst_percent: gst, stock: 1000 });
    if (!r.json?.ok) { record(`TC-CALC-round-${price}`, 'calc', `create rounding item ${price}`, 'ok', r.text, false); continue; }
    exp = expectBill([{ qty, price, gst }]);
    const sr = await sell(admin, [{ code: r.json.item.code, qty }]);
    inv = sr.json?.invoice;
    check(`TC-CALC-round-${price}x${qty}@${gst}`, 'calc', `rounding ${qty} x ${price} @ ${gst}%`, { subtotal: exp.subtotal, tax: exp.tax, total: exp.total }, inv && { subtotal: inv.subtotal, tax: inv.tax, total: inv.total }, sr.text.slice(0, 150));
  }

  // Same item added twice merges
  await admin.post('/api/cart/clear', {});
  await admin.post('/add_to_cart', { code: 'TEST-MILK-001', quantity: 1 });
  await admin.post('/add_to_cart', { code: 'TEST-MILK-001', quantity: 2 });
  let cart = (await admin.get('/cart')).json.cart;
  check('TC-POS-merge', 'pos', 'same item twice merges qty', 3, cart.items[0]?.quantity);
  r = await admin.post('/update_item', { code: 'TEST-MILK-001', quantity: 5 });
  check('TC-POS-qty', 'pos', 'change qty', 5, r.json.cart.items[0].quantity);
  r = await admin.post('/update_item', { code: 'TEST-MILK-001', quantity: -3 });
  check('TC-POS-negqty', 'pos', 'negative qty removes line (no negative sale)', 0, r.json.cart.items.length);
  await admin.post('/add_to_cart', { code: 'TEST-MILK-001', quantity: -4 });
  cart = (await admin.get('/cart')).json.cart;
  record('TC-POS-addneg', 'pos', 'add_to_cart with negative quantity', 'reject', cart.items[0] ? `qty=${cart.items[0].quantity}` : 'no line', !cart.items[0] || cart.items[0].quantity > 0);
  await admin.post('/api/cart/clear', {});
  await admin.post('/add_to_cart', { code: 'TEST-MILK-001', quantity: 1 });
  await admin.post('/add_to_cart', { code: 'TEST-MILK-001', quantity: -0.5 });
  cart = (await admin.get('/cart')).json.cart;
  record('TC-POS-addneg2', 'pos', 'add existing item with negative qty reduces below 1', 'reject', cart.items[0]?.quantity, cart.items[0]?.quantity === 1);
  r = await admin.post('/update_item', { code: 'TEST-MILK-001', price: -10 });
  record('TC-POS-negprice', 'pos', 'update_item price=-10', 'reject', r.json?.ok ? r.json?.cart?.items[0]?.price : 'rejected: ' + r.text, !r.json?.ok || r.json?.cart?.items[0]?.price > 0);
  r = await admin.post('/update_item', { code: 'TEST-MILK-001', price: 1 });
  record('TC-POS-price-below-cost', 'pos', 'cashier can override price to 1 (below cost 25) via update_item', 'design: restrict?', r.json?.cart?.items[0]?.price, 'info');
  r = await admin.post('/update_item', { code: 'TEST-MILK-001', price: 30, discount: 1000 });
  cart = r.json.cart;
  record('TC-POS-disc-gt-line', 'pos', 'line discount 1000 > line value 30 -> taxable clamps to 0, total', cart.total, cart.total, cart.total === 0);
  r = await admin.post('/api/cart/discount', { discount: 1000 });
  check('TC-POS-billdisc-gt', 'pos', 'bill discount > subtotal clamps total to 0 (no negative)', 0, r.json.cart.total);
  r = await admin.post('/remove_item', { code: 'TEST-MILK-001' });
  check('TC-POS-remove', 'pos', 'remove item', 0, r.json.cart.items.length);
  r = await admin.post('/api/sale', { payment_method: 'Cash' });
  check('TC-POS-empty', 'pos', 'sale with empty cart -> 400', 400, r.status);
  r = await admin.post('/add_to_cart', { code: 'NOPE' });
  check('TC-POS-notfound', 'pos', 'unknown code -> 404', 404, r.status);
  r = await admin.post('/add_to_cart', {});
  check('TC-POS-nocode', 'pos', 'missing code -> 400', 400, r.status);

  // Payment scenarios
  const milkExp = expectBill([{ qty: 2, price: 30, gst: 0 }]); // 60
  r = await sell(admin, [{ code: 'TEST-MILK-001', qty: 2 }], { method: 'Cash', paid: 100 });
  inv = r.json.invoice;
  check('TC-PAY-over', 'payments', 'pays 100 for 60 -> paid capped to total, status paid (change = 40 client-side)', { paid: 60, status: 'paid' }, { paid: inv.paid, status: inv.status });
  r = await sell(admin, [{ code: 'TEST-MILK-001', qty: 2 }], { method: 'Cash', paid: 25, partyId: cust1.id });
  inv = r.json.invoice; const partialInv = inv;
  check('TC-PAY-partial', 'payments', 'pays 25 of 60 -> partial', { paid: 25, status: 'partial', total: 60 }, { paid: inv.paid, status: inv.status, total: inv.total });
  r = await sell(admin, [{ code: 'TEST-MILK-001', qty: 2 }], { method: 'Credit', paid: 0, partyId: cust1.id });
  inv = r.json.invoice; const creditInv = inv;
  check('TC-PAY-credit', 'payments', 'credit sale paid 0 -> unpaid', { paid: 0, status: 'unpaid', method: 'Credit' }, { paid: inv.paid, status: inv.status, method: inv.payment_method });
  r = await sell(admin, [{ code: 'TEST-MILK-001', qty: 1 }], { method: 'Cash', paid: -50 });
  inv = r.json?.invoice;
  record('TC-PAY-neg', 'payments', 'negative paid amount (-50) accepted?', 'reject', inv ? `ACCEPTED paid=${inv.paid} status=${inv.status}` : r.text, inv ? false : true);
  const negInv = inv;
  r = await sell(admin, [{ code: 'TEST-MILK-001', qty: 1 }], { method: 'Cash', paid: 'abc' });
  inv = r.json?.invoice;
  record('TC-PAY-nan', 'payments', 'paid="abc" -> stored as?', 'reject or treat as full', inv ? `paid=${inv.paid} status=${inv.status}` : r.text, !inv || inv.paid === inv.total ? true : false);
  r = await sell(admin, [{ code: 'TEST-MILK-001', qty: 1 }], { method: 'Bitcoin', paid: 30 });
  record('TC-PAY-method', 'payments', 'arbitrary payment_method "Bitcoin" accepted?', 'reject', r.json?.invoice?.payment_method, r.json?.invoice ? false : true);
  for (const m of ['UPI', 'Card']) {
    r = await sell(admin, [{ code: 'TEST-MILK-001', qty: 1 }], { method: m, paid: 30 });
    check(`TC-PAY-${m}`, 'payments', `${m} payment recorded`, { m, paid: 30, status: 'paid' }, { m: r.json.invoice.payment_method, paid: r.json.invoice.paid, status: r.json.invoice.status });
  }
  // Walk-in without customer
  r = await sell(admin, [{ code: 'TEST-MILK-001', qty: 1 }]);
  check('TC-POS-walkin', 'pos', 'walk-in customer name', 'Walk-in Customer', r.json.invoice.party_name);
  // Credit limit enforcement: cust2 limit 500, opening 100
  r = await sell(admin, [{ code: 'TEST-RICE-001', qty: 20 }], { method: 'Credit', paid: 0, partyId: cust2.id }); // 1050
  inv = r.json?.invoice;
  record('TC-PAY-creditlimit', 'payments', 'credit sale of 1050 to customer with limit 500 (server-side enforcement)', 'reject', inv ? `ACCEPTED ${inv.invoice_no}` : r.text, inv ? false : true);
  const cust2Inv = inv;

  // Collect dues on partial invoice
  r = await admin.post(`/api/invoices/${partialInv.id}/payment`, { amount: 35, method: 'UPI' });
  check('TC-PAY-collect', 'payments', 'collect remaining 35 -> paid', { paid: 60, status: 'paid' }, { paid: r.json.invoice.paid, status: r.json.invoice.status });
  r = await admin.post(`/api/invoices/${partialInv.id}/payment`, { amount: 100, method: 'Cash' });
  d = await db();
  let payrows = rows(d, "SELECT amount FROM payments WHERE note = ?", [`Invoice ${partialInv.invoice_no}`]);
  record('TC-PAY-collect-over', 'payments', 'collecting 100 more on already-paid invoice: payments rows recorded', '[35]', payrows.map(p => p.amount), JSON.stringify(payrows.map(p => p.amount)) === '[35]');
  r = await admin.post(`/api/invoices/${creditInv.id}/payment`, { amount: -20, method: 'Cash' });
  record('TC-PAY-collect-neg', 'payments', 'negative due collection rejected', 'reject', r.json?.invoice ? `ACCEPTED paid=${r.json.invoice.paid}` : r.text, r.json?.invoice ? false : true);
  r = await admin.post(`/api/invoices/${creditInv.id}/payment`, { amount: 'x', method: 'Cash' });
  record('TC-PAY-collect-nan', 'payments', 'NaN due collection rejected', 'reject', r.json?.invoice ? `ACCEPTED paid=${r.json.invoice.paid} status=${r.json.invoice.status}` : r.text, r.json?.invoice ? false : true);
  let c1 = await party(admin, 'TEST-CUSTOMER-001');
  // cust1: partial (paid) + credit 60 unpaid (+ whatever negative collection did)
  record('TC-CUST-outstanding', 'customers', 'cust1 outstanding after credit sale 60 (expect 60 if bad payments rejected)', 60, c1.outstanding, near(c1.outstanding, 60));

  // Insufficient stock
  const cola = await itemByCode(admin, 'TEST-COLA-001');
  r = await sell(admin, [{ code: 'TEST-COLA-001', qty: cola.stock + 100 }]);
  const cola2 = await itemByCode(admin, 'TEST-COLA-001');
  record('TC-POS-insufficient', 'stock', `sell ${cola.stock + 100} of stock ${cola.stock}`, 'reject', r.json?.ok ? `ACCEPTED -> stock now ${cola2.stock}` : r.text, r.json?.ok ? false : true);
  if (r.json?.ok) { await admin.post(`/api/invoices/${r.json.invoice.id}/cancel`, { reason: 'TEST undo oversell' }); }
  r = await sell(admin, [{ code: 'TEST-COLA-001', qty: 1e9 }]);
  record('TC-POS-hugeqty', 'stock', 'sell 1e9 units', 'reject', r.json?.ok ? `ACCEPTED total=${r.json.invoice.total}` : r.text, r.json?.ok ? false : true);
  if (r.json?.ok) { await admin.post(`/api/invoices/${r.json.invoice.id}/cancel`, { reason: 'TEST undo' }); }

  // Double submit: same session, two concurrent /api/sale
  await admin.post('/api/cart/clear', {});
  await admin.post('/add_to_cart', { code: 'TEST-SOAP-001', quantity: 1 });
  const soap0 = (await itemByCode(admin, 'TEST-SOAP-001')).stock;
  const invCount0 = (await admin.get('/api/invoices')).json.invoices.length;
  const dbl = await Promise.all([admin.post('/api/sale', { payment_method: 'Cash' }), admin.post('/api/sale', { payment_method: 'Cash' }), admin.post('/api/sale', { payment_method: 'Cash' })]);
  const okCount = dbl.filter(x => x.json?.ok).length;
  const soap1 = (await itemByCode(admin, 'TEST-SOAP-001')).stock;
  check('TC-DBL-001', 'concurrency', 'triple-submit of one cart -> exactly 1 invoice', 1, okCount, dbl.map(x => x.status + ':' + (x.json?.error || x.json?.invoice?.invoice_no)).join(', '));
  check('TC-DBL-002', 'concurrency', 'stock deducted once', soap0 - 1, soap1);

  // Concurrency: 3 sessions x 4 sales same item simultaneously
  const sess = [new Client('a'), new Client('b'), new Client('c')];
  for (const s of sess) await s.login('admin', 'admin');
  const biscuit0 = (await itemByCode(admin, 'TEST-BISCUIT-001')).stock;
  const jobs = [];
  for (const s of sess) for (let i = 0; i < 4; i++) jobs.push((async () => {
    const c = new Client('x'); await c.login('admin', 'admin');
    await c.post('/add_to_cart', { code: 'TEST-BISCUIT-001', quantity: 2 });
    return c.post('/api/sale', { payment_method: 'Cash' });
  })());
  const res = await Promise.all(jobs);
  const nos = res.map(x => x.json?.invoice?.invoice_no).filter(Boolean);
  check('TC-CONC-001', 'concurrency', '12 concurrent sales all succeed', 12, nos.length, res.filter(x => !x.json?.ok).map(x => x.text).join(' | '));
  check('TC-CONC-002', 'concurrency', 'invoice numbers unique', 12, new Set(nos).size);
  check('TC-CONC-003', 'concurrency', 'stock reduced by exactly 24', biscuit0 - 24, (await itemByCode(admin, 'TEST-BISCUIT-001')).stock);
  d = await db();
  const dupNos = rows(d, 'SELECT invoice_no, COUNT(*) c FROM invoices GROUP BY invoice_no HAVING c > 1');
  check('TC-INVNO-unique', 'invoice_no', 'no duplicate invoice numbers in DB', 0, dupNos.length);
  const todaysNos = rows(d, "SELECT invoice_no FROM invoices WHERE invoice_no LIKE ? ORDER BY id", [`INV-${ymd.replace(/-/g, '')}-%`]).map(x => +x.invoice_no.split('-')[2]);
  const sequential = todaysNos.every((n, i) => i === 0 || n === todaysNos[i - 1] + 1);
  record('TC-INVNO-seq', 'invoice_no', 'today invoice numbers sequential w/o gaps', true, sequential, sequential, `first=${todaysNos[0]} last=${todaysNos[todaysNos.length - 1]} n=${todaysNos.length}`);

  // ================= PHASE 9/10/11/30: RECONCILIATION on TEST-RICE-001 =================
  // Fresh reconciliation item to keep numbers clean
  r = await admin.post('/api/items', { code: 'TEST-RECON-001', name: 'TEST Recon Item', category: 'TEST-Grocery', purchase_price: 40, sale_price: 50, mrp: 60, gst_percent: 5, stock: 100 });
  const recon = r.json.item;
  const t0 = new Date().toISOString();
  r = await admin.post('/api/purchases', { party_id: sup1.id, paid: 0, items: [{ code: 'TEST-RECON-001', quantity: 50, price: 40, mrp: 60, sale_price: 50, gst_percent: 5 }] });
  const rp = r.json.purchase;
  r = await sell(admin, [{ code: 'TEST-RECON-001', qty: 30 }], { method: 'Credit', paid: 0, partyId: cust1.id });
  const rinv = r.json.invoice;
  check('TC-RECON-sale', 'reconciliation', 'sale 30 x 50 @5%: taxable 1500 tax 75 total 1575', { subtotal: 1500, tax: 75, total: 1575 }, { subtotal: rinv.subtotal, tax: rinv.tax, total: rinv.total });
  const c1before = (await party(admin, 'TEST-CUSTOMER-001')).outstanding;
  r = await admin.post(`/api/invoices/${rinv.id}/return`, { items: [{ invoice_item_id: rinv.items[0].id, quantity: 5 }], reason: 'TEST return' });
  const ret = r.json.return;
  check('TC-RETURN-002', 'returns', 'partial return 5 of 30 -> refund 262.50 (incl. tax)', 262.5, ret?.total, r.text.slice(0, 150));
  const c1after = (await party(admin, 'TEST-CUSTOMER-001')).outstanding;
  record('TC-RETURN-credit-outstanding', 'returns', 'return on UNPAID credit invoice reduces customer outstanding by 262.50', r2(c1before - 262.5), c1after, near(c1before - 262.5, c1after));
  const rinv2 = (await admin.get(`/api/invoices/${rinv.id}`)).json.invoice;
  record('TC-RETURN-invoice-state', 'returns', 'invoice after return: total/paid/status unchanged (no credit note)', 'total reduced or credit recorded', { total: rinv2.total, paid: rinv2.paid, status: rinv2.status }, 'info');
  r = await admin.post(`/api/invoices/${rinv.id}/return`, { items: [{ invoice_item_id: rinv.items[0].id, quantity: 26 }] });
  check('TC-RETURN-005', 'returns', 'return 26 more (>25 remaining) rejected', 400, r.status, r.text);
  r = await admin.post(`/api/invoices/${rinv.id}/return`, { items: [{ invoice_item_id: rinv.items[0].id, quantity: -3 }] });
  record('TC-RETURN-neg', 'returns', 'negative return qty', 'reject', r.json?.ok ? `ACCEPTED total=${r.json.return.total} items=${r.json.return.items.length}` : r.text, r.json?.ok ? false : true);
  r = await admin.post(`/api/invoices/${rinv.id}/return`, { items: [{ invoice_item_id: 999999, quantity: 1 }] });
  check('TC-RETURN-badline', 'returns', 'foreign invoice_item_id rejected', 400, r.status);
  r = await admin.post(`/api/invoices/${rinv.id}/return`, { items: [] });
  check('TC-RETURN-empty', 'returns', 'empty return rejected', 400, r.status);
  // purchase return 10
  r = await admin.post(`/api/purchases/${rp.id}/return`, { items: [{ purchase_item_id: rp.items[0].id, quantity: 10 }], reason: 'TEST pret' });
  const pret = r.json.return;
  check('TC-PRET-001', 'purchase_returns', 'purchase return 10 x (2100/50=42) = 420', 420, pret?.total, r.text.slice(0, 150));
  const s1b = await party(admin, 'TEST-SUPPLIER-001');
  record('TC-PRET-outstanding', 'purchase_returns', 'supplier outstanding reduced by 420 after purchase return', r2(s1.outstanding + 2100 - 420), s1b.outstanding, near(s1.outstanding + 2100 - 420, s1b.outstanding), `before=${s1.outstanding + 2100}`);
  r = await admin.post(`/api/purchases/${rp.id}/return`, { items: [{ purchase_item_id: rp.items[0].id, quantity: 41 }] });
  check('TC-PRET-over', 'purchase_returns', 'return 41 more (>40 remaining) rejected', 400, r.status, r.text);
  // adjustments
  r = await admin.post('/api/stock-adjustments', { item_id: recon.id, change: 3, type: 'adjustment', reason: 'TEST +3' });
  check('TC-ADJ-001', 'stock', 'adjustment +3', true, r.json?.ok, r.text.slice(0, 120));
  r = await admin.post('/api/stock-adjustments', { item_id: recon.id, change: -2, type: 'damage', reason: 'TEST damage' });
  check('TC-ADJ-002', 'stock', 'damage -2', true, r.json?.ok, r.text.slice(0, 120));
  r = await admin.post('/api/stock-adjustments', { item_id: recon.id, change: 5, type: 'damage' });
  check('TC-ADJ-003', 'stock', 'positive damage rejected', 400, r.status);
  r = await admin.post('/api/stock-adjustments', { item_id: recon.id, change: 0 });
  check('TC-ADJ-004', 'stock', 'zero adjustment rejected', 400, r.status);
  r = await admin.post('/api/stock-adjustments', { item_id: recon.id, change: -99999, type: 'wastage' });
  check('TC-ADJ-005', 'stock', 'adjustment below zero rejected', 400, r.status);

  const reconNow = await itemByCode(admin, 'TEST-RECON-001');
  check('TC-RECON-stock', 'reconciliation', 'closing stock 100+50-30+5-10+3-2', 116, reconNow.stock);
  const ledger = (await admin.get(`/api/reports/inventory/ledger?item_id=${recon.id}&${rng}`)).json.report;
  check('TC-RECON-ledger', 'reconciliation', 'stock ledger closing == 116 and opening == 100', { opening: 100, closing: 116 }, { opening: ledger.opening, closing: ledger.rows[ledger.rows.length - 1]?.closing }, JSON.stringify(ledger.rows.map(x => `${x.type}:${x.stock_in}/${x.stock_out}`)));
  const cs = (await admin.get(`/api/reports/inventory/current-stock?q=TEST-RECON`)).json.report;
  check('TC-RECON-currentstock', 'reconciliation', 'current stock report == 116', 116, cs.rows.find(x => x.code === 'TEST-RECON-001')?.stock);
  const mv = (await admin.get(`/api/reports/inventory/movement?${rng}`)).json.report;
  const mvr = mv.rows.find(x => x.code === 'TEST-RECON-001' || x.item_id === recon.id);
  record('TC-RECON-movement', 'reconciliation', 'stock movement report row for recon item', { closing: 116 }, mvr, mvr && near(mvr.closing, 116));

  // Financial reconciliation via P&L delta (today) - use a fresh isolated expectation:
  // Contribution of recon item: net sales 1500 - 250 = 1250; cogs 1200 - 200 = 1000; GP 250
  // Sum all TEST invoices today from DB and compare with reports
  d = await db();
  const dbSales = one(d, "SELECT COUNT(*) bills, COALESCE(SUM(subtotal),0) gross, COALESCE(SUM(discount),0) disc, COALESCE(SUM(tax),0) tax, COALESCE(SUM(total),0) grand FROM invoices WHERE date(created_at,'localtime')=? AND status<>'cancelled'", [ymd]);
  const dbCogs = one(d, "SELECT COALESCE(SUM(ii.quantity*ii.purchase_price),0) cogs FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE date(i.created_at,'localtime')=? AND i.status<>'cancelled'", [ymd]);
  const dbRet = one(d, "SELECT COALESCE(SUM(sri.amount),0) gross, COALESCE(SUM(sri.amount/(1+ii.gst_percent/100.0)),0) net, COALESCE(SUM(sri.quantity*ii.purchase_price),0) cost FROM sale_return_items sri JOIN sale_returns sr ON sr.id=sri.return_id JOIN invoice_items ii ON ii.id=sri.invoice_item_id WHERE date(sr.created_at,'localtime')=?", [ymd]);
  const dbExp = one(d, "SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE date(created_at,'localtime')=?", [ymd]);
  const pl = (await admin.get(`/api/reports/profit-loss/summary?${rng}`)).json.report.summary;
  const dash = (await admin.get(`/api/dashboard?${rng}`)).json.dashboard;
  const ss = (await admin.get(`/api/reports/sales/summary?${rng}`)).json.report.summary;
  const ov = (await admin.get(`/api/reports/overview?${rng}`)).json.report.summary;
  const expNet = r2(dbSales.gross - dbSales.disc - dbRet.net);
  const expCogs = r2(dbCogs.cogs - dbRet.cost);
  check('TC-PL-netsales', 'reports', 'P&L net sales == DB (gross - disc - returns net)', expNet, pl.net_sales);
  check('TC-PL-cogs', 'reports', 'P&L COGS == DB (cogs - returned cost)', expCogs, pl.cogs);
  check('TC-PL-gp', 'reports', 'P&L gross profit == net sales - cogs', r2(expNet - expCogs), pl.gross_profit);
  check('TC-PL-np', 'reports', 'P&L net profit == GP - expenses', r2(expNet - expCogs - dbExp.t), pl.net_profit);
  check('TC-DASH-vs-PL', 'dashboard', 'dashboard business block == P&L summary', { ns: pl.net_sales, cogs: pl.cogs, gp: pl.gross_profit, np: pl.net_profit, ret: pl.sales_returns }, { ns: dash.business.net_sales, cogs: dash.business.cogs, gp: dash.business.gross_profit, np: dash.business.net_profit, ret: dash.business.sales_returns });
  check('TC-DASH-sales', 'dashboard', 'dashboard sales KPI == DB SUM(total) today', r2(dbSales.grand), dash.kpi.sales.value);
  check('TC-DASH-bills', 'dashboard', 'dashboard bills KPI == DB count', dbSales.bills, dash.kpi.bills.value);
  check('TC-SALES-summary', 'reports', 'sales summary vs DB', { grand: r2(dbSales.grand), bills: dbSales.bills }, { grand: ss.grand_total ?? ss.total_sales ?? ss.sales, bills: ss.bills }, JSON.stringify(ss));
  check('TC-OVERVIEW', 'reports', 'overview vs P&L', { ns: pl.net_sales, np: pl.net_profit }, { ns: ov.net_sales, np: ov.net_profit });
  record('TC-PL-recon-contrib', 'reconciliation', 'recon item alone: net sales 1250, COGS 1000, GP 250 (manual)', { ns: 1250, cogs: 1000, gp: 250 }, 'see item-wise below', 'info');
  const iw = (await admin.get(`/api/reports/sales/item-wise?${rng}`)).json.report.rows.find(x => x.code === 'TEST-RECON-001');
  record('TC-ITEMWISE-recon', 'reports', 'item-wise row for recon item (qty sold 30, does it net returns?)', 'qty=30 or 25; profit consistent', iw, 'info');

  // Item-wise / category-wise sum vs summary
  const iwAll = (await admin.get(`/api/reports/sales/item-wise?${rng}`)).json.report;
  const cw = (await admin.get(`/api/reports/sales/category-wise?${rng}`)).json.report;
  const dw = (await admin.get(`/api/reports/sales/day-wise?${rng}`)).json.report;
  const pw = (await admin.get(`/api/reports/sales/payment-wise?${rng}`)).json.report;
  const bw = (await admin.get(`/api/reports/sales/bill-wise?${rng}&per_page=1000`)).json.report;
  const sumOf = (arr, k) => r2(arr.reduce((s, x) => s + (parseFloat(x[k]) || 0), 0));
  record('TC-REP-itemwise-sum', 'reports', 'item-wise sum(amount-ish) vs sales grand', r2(dbSales.grand), { keys: Object.keys(iwAll.rows[0] || {}), sums: Object.fromEntries(Object.keys(iwAll.rows[0] || {}).filter(k => typeof iwAll.rows[0][k] === 'number').map(k => [k, sumOf(iwAll.rows, k)])) }, 'info');
  record('TC-REP-catwise-sum', 'reports', 'category-wise sums', 'consistent with item-wise', Object.fromEntries(Object.keys(cw.rows[0] || {}).filter(k => typeof cw.rows[0][k] === 'number').map(k => [k, sumOf(cw.rows, k)])), 'info');
  check('TC-REP-daywise', 'reports', 'day-wise today total == DB grand', r2(dbSales.grand), r2(dw.rows.find(x => x.day === ymd)?.total ?? dw.rows.find(x => x.day === ymd)?.sales), JSON.stringify(dw.rows));
  record('TC-REP-paywise', 'reports', 'payment-wise sum == grand?', r2(dbSales.grand), { rows: pw.rows, summary: pw.summary }, 'info');
  check('TC-REP-billwise-count', 'reports', 'bill-wise non-cancelled row count == DB bills', dbSales.bills, bw.rows.filter(x => x.status !== 'cancelled').length, `rows=${bw.rows.length} incl cancelled`);

  // GST reports
  const gs = (await admin.get(`/api/reports/gst/sales?${rng}`)).json.report;
  const rw = (await admin.get(`/api/reports/gst/rate-wise?${rng}`)).json.report;
  record('TC-GST-sales', 'gst', 'gst sales summary tax == DB tax', r2(dbSales.tax), gs.summary, near(dbSales.tax, gs.summary?.tax ?? gs.summary?.total_tax ?? gs.summary?.total_gst ?? -1));
  record('TC-GST-ratewise', 'gst', 'rate-wise rows sum tax == DB tax', r2(dbSales.tax), { sum: sumOf(rw.rows, 'tax') || sumOf(rw.rows, 'total_tax'), rows: rw.rows }, near(dbSales.tax, sumOf(rw.rows, 'tax') || sumOf(rw.rows, 'total_tax')));

  // Customer ledger check for cust1
  const cl = (await admin.get(`/api/reports/customers/ledger?party_id=${cust1.id}&${rng}`)).json.report;
  const c1now = await party(admin, 'TEST-CUSTOMER-001');
  record('TC-CUST-ledger', 'customers', 'customer ledger closing == party outstanding', c1now.outstanding, { closing: cl.closing ?? cl.summary?.closing ?? cl.rows?.[cl.rows.length - 1]?.balance, keys: Object.keys(cl) }, near(c1now.outstanding, cl.closing ?? cl.summary?.closing ?? cl.rows?.[cl.rows.length - 1]?.balance ?? NaN));
  const co = (await admin.get('/api/reports/customers/outstanding')).json.report;
  const coRow = co.rows.find(x => x.name === 'TEST-CUSTOMER-001' || x.party_name === 'TEST-CUSTOMER-001');
  record('TC-CUST-outstanding-report', 'customers', 'outstanding report row == party outstanding', c1now.outstanding, coRow, coRow && near(c1now.outstanding, coRow.outstanding ?? coRow.due ?? coRow.balance ?? NaN));
  const sl = (await admin.get(`/api/reports/suppliers/ledger?party_id=${sup1.id}&${rng}`)).json.report;
  const s1now = await party(admin, 'TEST-SUPPLIER-001');
  record('TC-SUP-ledger', 'suppliers', 'supplier ledger closing == party outstanding', s1now.outstanding, { closing: sl.closing ?? sl.summary?.closing ?? sl.rows?.[sl.rows.length - 1]?.balance, keys: Object.keys(sl) }, near(s1now.outstanding, sl.closing ?? sl.summary?.closing ?? sl.rows?.[sl.rows.length - 1]?.balance ?? NaN));

  // Cancel invoice restores stock; then edits/returns blocked
  const bisc0 = (await itemByCode(admin, 'TEST-BISCUIT-001')).stock;
  r = await sell(admin, [{ code: 'TEST-BISCUIT-001', qty: 4 }]);
  const cinv = r.json.invoice;
  r = await admin.post(`/api/invoices/${cinv.id}/cancel`, { reason: 'TEST cancel' });
  check('TC-CANCEL-001', 'sales', 'cancel restores stock', bisc0, (await itemByCode(admin, 'TEST-BISCUIT-001')).stock);
  r = await admin.post(`/api/invoices/${cinv.id}/cancel`, { reason: 'again' });
  check('TC-CANCEL-002', 'sales', 'double cancel rejected', 400, r.status);
  r = await admin.post(`/api/invoices/${cinv.id}/return`, { items: [{ invoice_item_id: cinv.items[0].id, quantity: 1 }] });
  record('TC-CANCEL-003', 'sales', 'return on CANCELLED invoice rejected', 'reject', r.json?.ok ? `ACCEPTED ${r.json.return.return_no} (stock inflated!)` : r.text, r.json?.ok ? false : true);
  record('TC-CANCEL-003-stock', 'sales', 'stock after return-on-cancelled', bisc0, (await itemByCode(admin, 'TEST-BISCUIT-001')).stock, (await itemByCode(admin, 'TEST-BISCUIT-001')).stock === bisc0);
  r = await admin.post(`/api/invoices/${cinv.id}/payment`, { amount: 10 });
  record('TC-CANCEL-004', 'sales', 'payment on CANCELLED invoice rejected', 'reject', r.json?.ok ? `ACCEPTED paid=${r.json.invoice.paid} status=${r.json.invoice.status}` : r.text, r.json?.ok ? false : true);

  // Bill discount + return over-refund check: sell 2 milk (60) with bill disc 20 -> total 40; return 1 milk
  r = await sell(admin, [{ code: 'TEST-MILK-001', qty: 2 }], { billDisc: 20 });
  const dinv = r.json.invoice;
  r = await admin.post(`/api/invoices/${dinv.id}/return`, { items: [{ invoice_item_id: dinv.items[0].id, quantity: 1 }] });
  const ret1 = r.json?.return?.total || 0;
  record('TC-RETURN-billdisc', 'returns', 'return 1 of 2 on bill (60 - 20 disc = 40 paid): refund should be 20 (paid share), not 30', 20, ret1, near(20, ret1));
  r = await admin.post(`/api/invoices/${dinv.id}/return`, { items: [{ invoice_item_id: dinv.items[0].id, quantity: 1 }] });
  record('TC-RETURN-billdisc-full', 'returns', 'total refunded on full return vs total paid 40', 40, r2((r.json?.return?.total || 0) + ret1), near(40, (r.json?.return?.total || 0) + ret1));

  // Expenses
  r = await admin.post('/api/expenses', { category: 'TEST-Rent', amount: 500, note: 'TEST expense' });
  check('TC-EXP-001', 'expenses', 'create expense', 500, r.json?.expense?.amount);
  const expId = r.json?.expense?.id;
  r = await admin.post('/api/expenses', { category: 'TEST-Zero', amount: 0 });
  record('TC-EXP-zero', 'expenses', 'zero expense', 'reject', r.json?.ok ? 'ACCEPTED' : r.text, r.json?.ok ? false : true);
  if (r.json?.expense) await admin.del(`/api/expenses/${r.json.expense.id}`);
  r = await admin.post('/api/expenses', { category: 'TEST-Neg', amount: -100 });
  record('TC-EXP-neg', 'expenses', 'negative expense', 'reject', r.json?.ok ? `ACCEPTED amount=${r.json.expense.amount}` : r.text, r.json?.ok ? false : true);
  if (r.json?.expense) await admin.del(`/api/expenses/${r.json.expense.id}`);
  r = await admin.post('/api/expenses', { category: 'TEST-NaN', amount: 'abc' });
  record('TC-EXP-nan', 'expenses', 'NaN expense', 'reject', r.json?.ok ? `ACCEPTED amount=${r.json.expense.amount}` : r.text, r.json?.ok ? false : true);
  if (r.json?.expense) await admin.del(`/api/expenses/${r.json.expense.id}`);
  r = await admin.post('/api/expenses', { amount: 10 });
  record('TC-EXP-nocat', 'expenses', 'missing category -> General', 'General', r.json?.expense?.category, r.json?.expense?.category === 'General');
  if (r.json?.expense) await admin.del(`/api/expenses/${r.json.expense.id}`);
  const pl2 = (await admin.get(`/api/reports/profit-loss/summary?${rng}`)).json.report.summary;
  checkNear('TC-EXP-pl', 'expenses', 'P&L expenses increased by 500', r2(pl.expenses + 500), pl2.expenses);
  const dash2 = (await admin.get(`/api/dashboard?${rng}`)).json.dashboard;
  checkNear('TC-EXP-dash', 'expenses', 'dashboard expenses == P&L expenses', pl2.expenses, dash2.kpi.expenses.value);
  r = await admin.del(`/api/expenses/${expId}`);
  check('TC-EXP-del', 'expenses', 'delete expense', 200, r.status);
  r = await admin.del('/api/expenses/999999');
  record('TC-EXP-del404', 'expenses', 'delete nonexistent expense', 404, r.status, r.status === 404);

  // Date range tests
  r = await admin.get('/api/reports/sales/summary?from=2026-09-13&to=2026-09-01');
  check('TC-DATE-from>to', 'dates', 'from > to -> 400', 400, r.status, r.text);
  r = await admin.get('/api/reports/sales/summary?from=2026-09-13');
  check('TC-DATE-missing-to', 'dates', 'missing to -> defaults to today (200)', 200, r.status, r.text.slice(0, 100));
  r = await admin.get('/api/reports/sales/summary');
  check('TC-DATE-both-missing', 'dates', 'both missing -> today (200, not "required" error)', 200, r.status, r.text.slice(0, 100));
  r = await admin.get('/api/reports/sales/summary?from=2026-02-30&to=2026-02-31');
  record('TC-DATE-invalid', 'dates', 'invalid calendar dates 2026-02-30', 'reject or normalize', `${r.status} ${r.text.slice(0, 120)}`, r.status < 500);
  r = await admin.get('/api/reports/sales/summary?from=abc&to=xyz');
  check('TC-DATE-garbage', 'dates', 'garbage dates -> falls back to today', 200, r.status);
  r = await admin.get('/api/reports/sales/summary?from=1900-01-01&to=2099-12-31');
  check('TC-DATE-wide', 'dates', 'very wide range ok', 200, r.status);
  // boundary: invoice created today must be in today range and not in yesterday
  const y = new Date(today); y.setDate(y.getDate() - 1); const ymdY = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  const bwY = (await admin.get(`/api/reports/sales/bill-wise?from=${ymdY}&to=${ymdY}&per_page=1000`)).json.report;
  check('TC-DATE-boundary', 'dates', 'today\'s multi invoice not in yesterday range', false, bwY.rows.some(x => x.invoice_no === multiInv.invoice_no));
  check('TC-DATE-boundary2', 'dates', 'today\'s multi invoice in today range', true, bw.rows.some(x => x.invoice_no === multiInv.invoice_no));

  // Cashier attribution
  const cashier = new Client('cashier'); await cashier.login('TEST-CASHIER', 'Test@123');
  r = await sell(cashier, [{ code: 'TEST-MILK-001', qty: 1 }]);
  check('TC-CASHIER-sale', 'cashier', 'cashier can bill', true, r.json?.ok, r.text.slice(0, 100));
  const cw2 = (await admin.get(`/api/reports/sales/cashier-wise?${rng}`)).json.report;
  const crow = cw2.rows.find(x => (x.cashier || x.username) === 'TEST-CASHIER');
  record('TC-CASHIER-report', 'cashier', 'cashier-wise report has TEST-CASHIER with 1 bill of 30', { bills: 1, total: 30 }, crow, crow && crow.bills === 1);
  r = await cashier.post(`/api/invoices/${r.json.invoice.id}/cancel`, { reason: 'x' });
  check('TC-CASHIER-cancel', 'cashier', 'cashier cannot cancel bills', 403, r.status);
  r = await cashier.post(`/api/invoices/${multiInv.id}/return`, { items: [] });
  check('TC-CASHIER-return', 'cashier', 'cashier cannot create returns', 403, r.status);
  r = await cashier.post('/api/cart/discount', { discount: 100 });
  record('TC-CASHIER-discount', 'cashier', 'cashier can apply unlimited bill discount (no approval)', 'design: restrict', r.json?.cart?.discount, 'info');
  await cashier.post('/api/cart/clear', {});

  // Bill passcode edit/delete
  r = await admin.put(`/api/invoices/${multiInv.id}`, { passcode: '0000', items: multiInv.items.map(i => ({ code: i.code, quantity: i.quantity, price: i.price })) });
  check('TC-EDIT-passcode', 'sales', 'edit with wrong passcode -> 401', 401, r.status, r.text);
  r = await admin.del(`/api/invoices/${multiInv.id}`, { passcode: '0000' });
  check('TC-DEL-passcode', 'sales', 'delete with wrong passcode -> 401/429', true, [401, 429].includes(r.status), r.text);

  // Stock: negative stock check overall
  d = await db();
  const negStock = rows(d, 'SELECT code, stock FROM items WHERE stock < 0');
  record('TC-DBI-negstock', 'db_integrity', 'items with negative stock in DB', [], negStock, negStock.length === 0);
  const orphanLines = rows(d, 'SELECT COUNT(*) c FROM invoice_items ii LEFT JOIN invoices i ON i.id=ii.invoice_id WHERE i.id IS NULL')[0].c;
  check('TC-DBI-orphan-lines', 'db_integrity', 'orphan invoice_items', 0, orphanLines);
  const orphanItemRefs = rows(d, 'SELECT COUNT(*) c FROM invoice_items ii LEFT JOIN items it ON it.id=ii.item_id WHERE ii.item_id IS NOT NULL AND it.id IS NULL')[0].c;
  record('TC-DBI-orphan-itemrefs', 'db_integrity', 'invoice_items referencing deleted items (soft orphans)', 0, orphanItemRefs, 'info');
  const badTotals = rows(d, "SELECT invoice_no, subtotal, discount, tax, total FROM invoices WHERE abs((subtotal - discount + tax) - total) > 0.011");
  check('TC-DBI-totals', 'db_integrity', 'invoices where subtotal-discount+tax != total', [], badTotals);
  const badPaid = rows(d, "SELECT invoice_no, paid, total, status FROM invoices WHERE paid < 0 OR paid > total + 0.011");
  record('TC-DBI-paid', 'db_integrity', 'invoices with paid<0 or paid>total', [], badPaid, badPaid.length === 0);
  const fk = rows(d, 'PRAGMA foreign_keys');
  record('TC-DBI-fk', 'db_integrity', 'PRAGMA foreign_keys enabled at file level (sql.js default off)', 1, fk[0]?.foreign_keys, 'info');
  const nanRows = rows(d, "SELECT id, amount FROM payments WHERE amount IS NULL OR typeof(amount) <> 'real' AND typeof(amount) <> 'integer'");
  record('TC-DBI-paynan', 'db_integrity', 'payments with NULL/non-numeric amount', [], nanRows, nanRows.length === 0);
  const nanExp = rows(d, "SELECT id, amount FROM expenses WHERE amount IS NULL OR (typeof(amount) <> 'real' AND typeof(amount) <> 'integer')");
  record('TC-DBI-expnan', 'db_integrity', 'expenses with NULL/non-numeric amount', [], nanExp, nanExp.length === 0);

  summary();
})().catch(e => { console.error(e); process.exit(1); });
