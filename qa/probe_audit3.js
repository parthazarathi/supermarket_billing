// Probe suite for gaps not covered by t1/t2/t3:
//  - invoice edit: stock check, price 0, payment method whitelist, party handling
//  - sale/party: dangling party_id, supplier-as-customer
//  - invoice payment: method whitelist
//  - purchase edit/delete: negative stock when goods already sold
//  - settings: default_gst / gst_type validation
//  - cash session: opening/closing cash validation, credit-return refund math
//  - password reset: min length
//  - update_item: stock cap parity with add_to_cart
const { Client, record, check, checkNear, db, rows, one, summary } = require('./harness');

const PASSCODE = '1234';

async function stockOf(code) {
  const d = await db();
  const r = one(d, 'SELECT stock FROM items WHERE code = ?', [code]);
  d.close();
  return r ? parseFloat(r.stock) : null;
}

async function makeItem(admin, code, stock) {
  const list = await admin.get(`/api/items?q=${encodeURIComponent(code)}`);
  const found = (list.json.items || []).find(i => i.code === code);
  if (found) {
    await admin.put(`/api/items/${found.id}`, {
      code, name: `QA ${code}`, category: 'TEST', gst_percent: 0,
      purchase_price: 50, mrp: 120, sale_price: 100, stock, unit: 'pcs'
    });
    return { status: 200, json: { item: found } };
  }
  return admin.post('/api/items', {
    code, name: `QA ${code}`, category: 'TEST', gst_percent: 0,
    purchase_price: 50, mrp: 120, sale_price: 100, stock, unit: 'pcs'
  });
}

async function makeSale(client, code, qty, extra = {}) {
  await client.post('/api/cart/clear');
  await client.post('/add_to_cart', { code, quantity: qty });
  return client.post('/api/sale', { payment_method: 'Cash', ...extra });
}

(async () => {
  const admin = new Client('admin');
  const lr = await admin.login('admin', 'admin');
  if (!lr.json || !lr.json.ok) { console.log('LOGIN FAILED'); process.exit(1); }

  // Make sure a bill passcode exists for edit/delete probes
  const pc = await admin.post('/api/settings', { bill_passcode: PASSCODE });
  record('SETUP', 'setup', 'bill passcode set for probes', true, !!(pc.json && pc.json.ok));

  // Fresh parties
  const allParties = await admin.get('/api/parties');
  const existing = allParties.json.parties || [];
  const sup = existing.find(p => p.name === 'QA-SUP-1')
    ? { json: { party: existing.find(p => p.name === 'QA-SUP-1') } }
    : await admin.post('/api/parties', { name: 'QA-SUP-1', type: 'supplier' });
  const supId = sup.json.party.id;
  const cust = existing.find(p => p.name === 'QA-CUST-1')
    ? { json: { party: existing.find(p => p.name === 'QA-CUST-1') } }
    : await admin.post('/api/parties', { name: 'QA-CUST-1', type: 'customer' });
  const custId = cust.json.party.id;

  // ---------- sale: party validation ----------
  await makeItem(admin, 'QA-STK1', 10);
  const danglingBefore = one(await db(), "SELECT COUNT(*) c FROM invoices WHERE party_id = 99999");
  let r = await makeSale(admin, 'QA-STK1', 1, { party_id: 99999 });
  check('SALE-PARTY-404', 'sales', 'sale with nonexistent party_id rejected', 400, r.status);
  const invCount1 = one(await db(), "SELECT COUNT(*) c FROM invoices WHERE party_id = 99999");
  check('SALE-PARTY-404b', 'sales', 'no new dangling invoice rows for bad party', danglingBefore.c, invCount1.c);

  r = await makeSale(admin, 'QA-STK1', 1, { party_id: supId });
  check('SALE-PARTY-SUP', 'sales', 'sale to a supplier rejected', 400, r.status);

  r = await admin.post('/api/cart/party', { party_id: supId });
  check('CART-PARTY-SUP', 'sales', 'supplier cannot be set as bill customer', 400, r.status);

  r = await makeSale(admin, 'QA-STK1', 1, { party_id: custId });
  check('SALE-PARTY-OK', 'sales', 'sale to a real customer works', 200, r.status);
  const custInv = r.json.invoice;

  // ---------- invoice edit ----------
  // invoice for customer, qty 3 of QA-STK2 (stock 10 -> 7)
  await makeItem(admin, 'QA-STK2', 10);
  r = await makeSale(admin, 'QA-STK2', 3, { party_id: custId });
  const editInv = r.json.invoice;
  check('INVEDIT-SETUP', 'sales', 'customer bill created', custId, editInv.party_id);

  r = await admin.put(`/api/invoices/${editInv.id}`, { passcode: PASSCODE, items: [{ code: 'QA-STK2', quantity: 15, price: 100 }] });
  check('INVEDIT-STOCK', 'sales', 'edit exceeding stock rejected', 400, r.status);
  checkNear('INVEDIT-STOCK-b', 'sales', 'stock unchanged after rejected edit', 7, await stockOf('QA-STK2'));

  r = await admin.put(`/api/invoices/${editInv.id}`, { passcode: PASSCODE, items: [{ code: 'QA-STK2', quantity: 8, price: 100 }] });
  check('INVEDIT-STOCK-ok', 'sales', 'edit within (restored) stock allowed', 200, r.status);
  checkNear('INVEDIT-STOCK-c', 'sales', 'stock after valid edit', 2, await stockOf('QA-STK2'));

  r = await admin.put(`/api/invoices/${editInv.id}`, { passcode: PASSCODE, items: [{ code: 'QA-STK2', quantity: 1, price: 0 }] });
  check('INVEDIT-PRICE0', 'sales', 'edit with price 0 rejected', 400, r.status);

  r = await admin.put(`/api/invoices/${editInv.id}`, { passcode: PASSCODE, items: [{ code: 'QA-STK2', quantity: 1, price: 100 }], payment_method: 'Bitcoin' });
  check('INVEDIT-METHOD', 'sales', 'edit with invalid payment method rejected', 400, r.status);

  r = await admin.put(`/api/invoices/${editInv.id}`, { passcode: PASSCODE, items: [{ code: 'QA-STK2', quantity: 1, price: 100 }], party_id: 99999 });
  check('INVEDIT-PARTY-404', 'sales', 'edit with nonexistent party rejected', 400, r.status);

  r = await admin.put(`/api/invoices/${editInv.id}`, { passcode: PASSCODE, items: [{ code: 'QA-STK2', quantity: 1, price: 100 }], party_id: supId });
  check('INVEDIT-PARTY-SUP', 'sales', 'edit to a supplier rejected', 400, r.status);

  // omitting party_id entirely must not silently re-file the bill
  r = await admin.put(`/api/invoices/${editInv.id}`, { passcode: PASSCODE, items: [{ code: 'QA-STK2', quantity: 2, price: 100 }] });
  check('INVEDIT-PARTY-KEEP', 'sales', 'edit without party_id keeps the customer', custId, r.json && r.json.invoice ? r.json.invoice.party_id : 'no invoice');
  checkNear('INVEDIT-STOCK-d', 'sales', 'stock after keep-party edit', 8, await stockOf('QA-STK2'));

  // ---------- invoice payment method ----------
  r = await makeSale(admin, 'QA-STK1', 1, { paid: 0 });
  const unpaidInv = r.json.invoice;
  r = await admin.post(`/api/invoices/${unpaidInv.id}/payment`, { amount: 10, method: 'Bitcoin' });
  check('PAY-METHOD', 'payments', 'payment with bogus method rejected', 400, r.status);
  r = await admin.post(`/api/invoices/${unpaidInv.id}/payment`, { amount: 10, method: 'UPI' });
  check('PAY-METHOD-ok', 'payments', 'payment with valid method accepted', 200, r.status);

  // ---------- purchase edit/delete with sold stock ----------
  await makeItem(admin, 'QA-STK3', 0);
  r = await admin.post('/api/purchases', { items: [{ code: 'QA-STK3', quantity: 10, price: 50, mrp: 120 }], party_id: supId, paid: 0 });
  const pur = r.json.purchase;
  check('PUR-SETUP', 'purchases', 'purchase created', 200, r.status);
  checkNear('PUR-STOCK0', 'purchases', 'stock after purchase', 10, await stockOf('QA-STK3'));

  await makeSale(admin, 'QA-STK3', 8);
  checkNear('PUR-STOCK1', 'purchases', 'stock after selling 8', 2, await stockOf('QA-STK3'));

  r = await admin.req('DELETE', `/api/purchases/${pur.id}`, { passcode: PASSCODE });
  check('PUR-DEL-SOLD', 'purchases', 'delete purchase whose stock was sold rejected', 400, r.status);
  checkNear('PUR-DEL-STOCK', 'purchases', 'stock unchanged after rejected delete', 2, await stockOf('QA-STK3'));

  r = await admin.put(`/api/purchases/${pur.id}`, { passcode: PASSCODE, items: [{ code: 'QA-STK3', quantity: 2, price: 50, mrp: 120 }] });
  check('PUR-EDIT-SOLD', 'purchases', 'edit purchase below sold qty rejected', 400, r.status);

  r = await admin.put(`/api/purchases/${pur.id}`, { passcode: PASSCODE, items: [{ code: 'QA-STK3', quantity: 8, price: 50, mrp: 120 }] });
  check('PUR-EDIT-ok', 'purchases', 'edit purchase to exactly-sold qty allowed', 200, r.status);
  checkNear('PUR-EDIT-STOCK', 'purchases', 'stock after valid purchase edit', 0, await stockOf('QA-STK3'));

  // ---------- settings validation ----------
  r = await admin.post('/api/settings', { default_gst: '999' });
  check('SET-GST-999', 'settings', 'default_gst 999 rejected', 400, r.status);
  r = await admin.post('/api/settings', { default_gst: 'abc' });
  check('SET-GST-abc', 'settings', 'default_gst non-numeric rejected', 400, r.status);
  r = await admin.post('/api/settings', { default_gst: '-5' });
  check('SET-GST-neg', 'settings', 'default_gst negative rejected', 400, r.status);
  r = await admin.post('/api/settings', { gst_type: 'bogus' });
  check('SET-GSTTYPE', 'settings', 'invalid gst_type rejected', 400, r.status);
  r = await admin.post('/api/settings', { default_gst: '5', gst_type: 'intra' });
  check('SET-GST-ok', 'settings', 'valid default_gst accepted', 200, r.status);
  await admin.post('/api/settings', { default_gst: '0' }); // restore

  // ---------- cash session validation + refund math ----------
  // ensure no open session for admin
  await admin.post('/api/cash-session/close', { closing_cash: 0 }).catch(() => {});
  r = await admin.post('/api/cash-session/open', { opening_cash: -100 });
  check('CASH-OPEN-NEG', 'cash', 'negative opening cash rejected', 400, r.status);
  r = await admin.post('/api/cash-session/open', { opening_cash: 'abc' });
  check('CASH-OPEN-NAN', 'cash', 'non-numeric opening cash rejected', 400, r.status);
  r = await admin.post('/api/cash-session/open', { opening_cash: 100 });
  check('CASH-OPEN-ok', 'cash', 'valid opening cash accepted', 200, r.status);

  // credit sale (paid 0), then return -> no cash should leave the drawer
  await makeItem(admin, 'QA-STK4', 5);
  const creditSale = await makeSale(admin, 'QA-STK4', 1, { paid: 0 });
  const creditInv = creditSale.json.invoice;
  r = await admin.post(`/api/invoices/${creditInv.id}/return`, { items: [{ invoice_item_id: creditInv.items[0].id, quantity: 1 }] });
  check('CASH-RET-SETUP', 'cash', 'return created', 200, r.status);
  check('CASH-RET-REFUND0', 'cash', 'credit sale return has no cash refund', 0, r.json.return.refund_amount);
  const sess = await admin.get('/api/cash-session');
  check('CASH-REFUND-FIG', 'cash', 'credit return not counted as cash out', 0, sess.json.session.figures.cash_refunds);
  check('CASH-EXPECTED', 'cash', 'expected cash still 100', 100, sess.json.session.figures.expected_cash);

  r = await admin.post('/api/cash-session/close', { closing_cash: 'abc' });
  check('CASH-CLOSE-NAN', 'cash', 'non-numeric closing cash rejected', 400, r.status);
  r = await admin.post('/api/cash-session/close', { closing_cash: -5 });
  check('CASH-CLOSE-NEG', 'cash', 'negative closing cash rejected', 400, r.status);
  r = await admin.post('/api/cash-session/close', { closing_cash: 100 });
  check('CASH-CLOSE-ok', 'cash', 'valid close accepted', 200, r.status);

  // ---------- password reset validation ----------
  const users = await admin.get('/api/users');
  const existingCash = (users.json.users || []).find(u => u.username === 'QA-CASH1');
  const qaCashId = existingCash
    ? existingCash.id
    : (await admin.post('/api/users', { username: 'QA-CASH1', password: 'cash123', role: 'cashier' })).json.user.id;
  r = await admin.put(`/api/users/${qaCashId}/password`, { password: '' });
  check('PWD-EMPTY', 'users', 'empty password rejected', 400, r.status);
  r = await admin.put(`/api/users/${qaCashId}/password`, { password: 'ab' });
  check('PWD-SHORT', 'users', 'password < 4 rejected', 400, r.status);
  r = await admin.put(`/api/users/${qaCashId}/password`, { password: 'newpass1' });
  check('PWD-OK', 'users', 'valid password accepted', 200, r.status);
  const cash = new Client('qa-cash');
  const cl = await cash.login('QA-CASH1', 'newpass1');
  check('PWD-LOGIN', 'users', 'login with new password works', true, !!(cl.json && cl.json.ok));

  // ---------- update_item stock parity ----------
  await cash.post('/api/cart/clear');
  await cash.post('/add_to_cart', { code: 'QA-STK1', quantity: 1 });
  r = await cash.post('/update_item', { code: 'QA-STK1', quantity: 9999 });
  check('CART-QTY-STOCK', 'pos', 'update_item qty above stock rejected', 400, r.status);

  // ---------- duplicate sale ----------
  await cash.post('/api/cart/clear');
  await cash.post('/add_to_cart', { code: 'QA-STK1', quantity: 1 });
  const s1 = await cash.post('/api/sale', { payment_method: 'Cash' });
  const s2 = await cash.post('/api/sale', { payment_method: 'Cash' });
  check('SALE-DUP', 'pos', 'second submit of same cart rejected', 400, s2.status);
  check('SALE-DUP2', 'pos', 'first sale succeeded once', 200, s1.status);

  summary();
})().catch(e => { console.error('PROBE CRASHED', e); process.exit(1); });
