const H = require('./harness');
const { Client, check, record, summary } = H;

(async () => {
  const anon = new Client('anon');
  const admin = new Client('admin');
  const cashier = new Client('cashier');

  // ---------- AUTH ----------
  let r = await admin.login('admin', 'admin');
  check('TC-AUTH-001', 'auth', 'valid admin login', { status: 200, ok: true, role: 'admin' }, { status: r.status, ok: r.json?.ok, role: r.json?.user?.role });
  check('TC-AUTH-001b', 'auth', 'login response does not expose password_hash', false, JSON.stringify(r.json).includes('password_hash'));

  r = await anon.post('/api/login', { username: 'nouser', password: 'x' });
  check('TC-AUTH-003', 'auth', 'invalid username -> 401', 401, r.status);
  r = await anon.post('/api/login', { username: 'admin', password: 'wrong' });
  check('TC-AUTH-004', 'auth', 'invalid password -> 401', 401, r.status);
  r = await anon.post('/api/login', { username: '', password: 'x' });
  check('TC-AUTH-005', 'auth', 'empty username -> 4xx (not 500)', true, r.status >= 400 && r.status < 500, `status=${r.status} body=${r.text}`);
  r = await anon.post('/api/login', { username: 'admin', password: '' });
  check('TC-AUTH-006', 'auth', 'empty password -> 4xx (not 500)', true, r.status >= 400 && r.status < 500, `status=${r.status} body=${r.text}`);
  r = await anon.post('/api/login', {});
  check('TC-AUTH-007', 'auth', 'both missing -> 4xx (not 500)', true, r.status >= 400 && r.status < 500, `status=${r.status} body=${r.text}`);
  r = await anon.post('/api/login', { username: { $ne: 1 }, password: ['x'] });
  check('TC-AUTH-007b', 'auth', 'wrong types -> 4xx (not 500)', true, r.status >= 400 && r.status < 500, `status=${r.status} body=${r.text}`);

  r = await anon.get('/api/items');
  check('TC-AUTH-010', 'auth', 'protected API without login -> 401', 401, r.status);
  r = await anon.get('/api/dashboard');
  check('TC-AUTH-010b', 'auth', 'dashboard without login -> 401', 401, r.status);
  r = await anon.get('/api/settings');
  check('TC-AUTH-010c', 'auth', 'settings without login -> 401', 401, r.status);
  r = await anon.get('/invoice_pdf?id=1');
  check('TC-AUTH-010d', 'auth', 'invoice pdf without login -> 401', 401, r.status);
  r = await anon.get('/api/me');
  check('TC-AUTH-010e', 'auth', '/api/me anonymous exposes only public settings (no passcode hash)', false, JSON.stringify(r.json).includes('bill_passcode_hash'), r.text.slice(0, 200));

  // ---------- TEST USERS ----------
  r = await admin.post('/api/users', { username: 'TEST-CASHIER', password: 'Test@123', role: 'cashier' });
  if (!r.json?.ok && /UNIQUE/.test(r.text)) r = { status: 200, json: { ok: true } };
  check('TC-USER-001', 'users', 'create TEST-CASHIER', true, r.json?.ok, r.text.slice(0, 200));
  r = await admin.post('/api/users', { username: 'TEST-ADMIN', password: 'Test@123', role: 'admin' });
  if (!r.json?.ok && /UNIQUE/.test(r.text)) r = { status: 200, json: { ok: true } };
  check('TC-USER-002', 'users', 'create TEST-ADMIN', true, r.json?.ok, r.text.slice(0, 200));
  r = await admin.post('/api/users', { username: 'TEST-CASHIER', password: 'Test@123', role: 'cashier' });
  check('TC-USER-003', 'users', 'duplicate username -> 400 friendly error (no raw SQL text)', true, r.status === 400 && !/UNIQUE constraint/.test(r.text), `status=${r.status} body=${r.text}`);
  r = await admin.post('/api/users', { username: '', password: '', role: 'cashier' });
  check('TC-USER-004', 'users', 'empty username/password rejected', true, r.status >= 400, `status=${r.status} body=${r.text}`);
  r = await admin.post('/api/users', { username: 'TEST-SUPER', password: 'Test@123', role: 'superadmin' });
  check('TC-USER-005', 'users', 'invalid role falls back to cashier (documented) ', 'cashier', r.json?.user?.role, r.text.slice(0, 150));
  if (r.json?.user?.id) await admin.del(`/api/users/${r.json.user.id}`);

  r = await cashier.login('TEST-CASHIER', 'Test@123');
  check('TC-AUTH-002', 'auth', 'valid cashier login', { status: 200, role: 'cashier' }, { status: r.status, role: r.json?.user?.role });

  // ---------- ROLE RESTRICTIONS ----------
  r = await cashier.get('/api/purchases');
  check('TC-AUTH-014a', 'auth', 'cashier GET purchases -> 403', 403, r.status);
  r = await cashier.post('/api/items', { code: 'X', name: 'X', purchase_price: 1, sale_price: 2, stock: 1 });
  check('TC-AUTH-014b', 'auth', 'cashier create item -> 403', 403, r.status);
  r = await cashier.get('/api/reports/sales/summary');
  check('TC-AUTH-014c', 'auth', 'cashier reports -> 403', 403, r.status);
  r = await cashier.get('/api/users');
  check('TC-AUTH-014d', 'auth', 'cashier list users -> 403', 403, r.status);
  r = await cashier.post('/api/settings', { shop_name: 'HACKED' });
  check('TC-AUTH-014e', 'auth', 'cashier change settings -> 403', 403, r.status);
  r = await cashier.get('/api/expenses');
  check('TC-AUTH-014f', 'auth', 'cashier list expenses -> 403', 403, r.status);
  r = await cashier.get('/api/invoices');
  check('TC-AUTH-014g', 'auth', 'cashier can list invoices (allowed) -> 200', 200, r.status);
  r = await cashier.put('/api/users/1/password', { password: 'pwned' });
  check('TC-AUTH-014h', 'auth', 'cashier cannot change admin password -> 403', 403, r.status);
  r = await cashier.post('/api/parties/1/payment', { amount: 10 });
  check('TC-AUTH-014i', 'auth', 'cashier record party payment -> 403', 403, r.status);
  r = await cashier.post('/api/invoices/1/payment', { amount: 1 });
  record('TC-AUTH-014j', 'auth', 'cashier can collect invoice dues (loginRequired only)', 'design: allowed', r.status, r.status, 'informational');
  r = await cashier.get('/api/settings');
  check('TC-AUTH-014k', 'auth', 'cashier GET settings does not include users/db_path', false, !!(r.json?.users || r.json?.db_path), r.text.slice(0, 200));
  r = await cashier.get('/api/accounts');
  record('TC-AUTH-014l', 'auth', 'cashier can read bank/cash accounts + balances', 'design decision', r.status, 'info', r.text.slice(0, 200));

  // ---------- LOGOUT ----------
  const tmp = new Client('tmp'); await tmp.login('TEST-CASHIER', 'Test@123');
  r = await tmp.post('/api/logout');
  check('TC-AUTH-008', 'auth', 'logout ok', 200, r.status);
  r = await tmp.get('/api/items');
  check('TC-AUTH-009', 'auth', 'after logout, same cookie is rejected', 401, r.status);
  r = await admin.get('/api/me');
  check('TC-AUTH-012', 'auth', 'session persists across requests (refresh)', 'admin', r.json?.user?.username);
  const admin2 = new Client('admin2'); r = await admin2.login('admin', 'admin');
  const r2 = await admin.get('/api/me');
  check('TC-AUTH-013', 'auth', 'second browser login does not kill first session', 'admin', r2.json?.user?.username);

  // ---------- TEST DATA: parties ----------
  const parties = {};
  for (const p of [
    { name: 'TEST-CUSTOMER-001', type: 'customer', phone: '9000000001', credit_limit: 0 },
    { name: 'TEST-CUSTOMER-002', type: 'customer', phone: '9000000002', opening_balance: 100, credit_limit: 500 },
    { name: 'TEST-SUPPLIER-001', type: 'supplier', phone: '9000000011', gstin: '29ABCDE1234F1Z5' },
    { name: 'TEST-SUPPLIER-002', type: 'supplier', phone: '9000000012', opening_balance: 250 },
  ]) {
    r = await admin.post('/api/parties', p);
    parties[p.name] = r.json?.party;
    check(`TC-PARTY-create-${p.name}`, 'parties', `create ${p.name}`, true, r.json?.ok, r.text.slice(0, 120));
  }
  r = await admin.post('/api/parties', { name: 'TEST-CUSTOMER-001', type: 'customer' });
  record('TC-PARTY-dup', 'parties', 'duplicate customer name accepted?', 'reject or warn', r.json?.ok ? 'accepted (duplicate created)' : 'rejected', r.json?.ok ? false : true);
  if (r.json?.party?.id) await admin.del(`/api/parties/${r.json.party.id}`);
  r = await admin.post('/api/parties', { name: '   ', type: 'customer' });
  check('TC-PARTY-empty', 'parties', 'empty party name rejected', 400, r.status);
  r = await admin.post('/api/parties', { name: '<script>alert(1)</script>', type: 'customer' });
  check('TC-PARTY-xss', 'parties', 'script name stored verbatim (escaping is client side) - no crash', 200, r.status);
  if (r.json?.party?.id) await admin.del(`/api/parties/${r.json.party.id}`);
  r = await admin.post('/api/parties', { name: "TEST-SQLI' OR '1'='1", type: 'customer' });
  check('TC-PARTY-sqli', 'parties', 'sql-like name handled by params', 200, r.status);
  if (r.json?.party?.id) await admin.del(`/api/parties/${r.json.party.id}`);
  r = await admin.post('/api/parties', { name: 'TEST-NEG', type: 'customer', opening_balance: -50, credit_limit: -10 });
  record('TC-PARTY-neg', 'parties', 'negative opening balance/credit limit accepted', 'validate', r.json?.party ? `ob=${r.json.party.opening_balance} cl=${r.json.party.credit_limit}` : r.text, r.json?.party ? false : true);
  if (r.json?.party?.id) await admin.del(`/api/parties/${r.json.party.id}`);
  r = await admin.post('/api/parties', { name: 'TEST-TYPE', type: 'employee' });
  check('TC-PARTY-type', 'parties', 'invalid type coerced to customer', 'customer', r.json?.party?.type);
  if (r.json?.party?.id) await admin.del(`/api/parties/${r.json.party.id}`);
  r = await admin.get('/api/parties?type=supplier');
  check('TC-PARTY-filter', 'parties', 'filter suppliers only', true, r.json.parties.every(p => p.type === 'supplier'));

  // ---------- TEST DATA: items ----------
  const items = [
    { code: 'TEST-RICE-001', name: 'TEST Rice 1kg', category: 'TEST-Grocery', purchase_price: 40, sale_price: 50, mrp: 55, gst_percent: 5, stock: 100, unit: 'kg', hsn: '1006' },
    { code: 'TEST-SUGAR-001', name: 'TEST Sugar 1kg', category: 'TEST-Grocery', purchase_price: 42, sale_price: 48, mrp: 50, gst_percent: 5, stock: 50, unit: 'kg' },
    { code: 'TEST-MILK-001', name: 'TEST Milk 500ml', category: 'TEST-Dairy', purchase_price: 25, sale_price: 30, mrp: 30, gst_percent: 0, stock: 40, unit: 'pcs' },
    { code: 'TEST-BREAD-001', name: 'TEST Bread', category: 'TEST-Bakery', purchase_price: 30, sale_price: 40, mrp: 45, gst_percent: 18, stock: 30, unit: 'pcs' },
    { code: 'TEST-BISCUIT-001', name: 'TEST Biscuit', category: 'TEST-Bakery', purchase_price: 8, sale_price: 10.99, mrp: 12, gst_percent: 12, stock: 200, unit: 'pcs' },
    { code: 'TEST-SOAP-001', name: 'TEST Soap', category: 'TEST-Personal Care', purchase_price: 20, sale_price: 28, mrp: 30, gst_percent: 28, stock: 60, unit: 'pcs' },
    { code: 'TEST-COLA-001', name: 'TEST Cola 1L', category: 'TEST-Beverages', purchase_price: 30, sale_price: 10.5 + 29.5, mrp: 45, gst_percent: 12, stock: 24, unit: 'pcs' },
  ];
  const created = {};
  for (const it of items) {
    r = await admin.post('/api/items', it);
    if (!r.json?.ok) { // maybe exists from earlier run
      const l = await admin.get(`/api/items?q=${it.code}`);
      created[it.code] = l.json.items.find(i => i.code === it.code);
    } else created[it.code] = r.json.item;
    check(`TC-ITEM-001-${it.code}`, 'items', `create ${it.code}`, true, !!created[it.code], r.text.slice(0, 120));
  }

  r = await admin.post('/api/items', {});
  check('TC-ITEM-003', 'items', 'empty item form -> 400', 400, r.status, r.text);
  r = await admin.post('/api/items', { code: 'TEST-MIN-001', name: 'TEST Min', purchase_price: 10, sale_price: 12, stock: 1 });
  check('TC-ITEM-002', 'items', 'minimum fields item created', true, r.json?.ok, r.text.slice(0, 150));
  const minItem = r.json?.item;
  r = await admin.post('/api/items', { code: 'TEST-DUPNAME', name: 'TEST Rice 1kg', purchase_price: 10, sale_price: 12, stock: 1 });
  check('TC-ITEM-004', 'items', 'duplicate item name -> 400', 400, r.status, r.text);
  r = await admin.post('/api/items', { code: 'TEST-RICE-001', name: 'TEST other', purchase_price: 10, sale_price: 12, stock: 1 });
  check('TC-ITEM-005/006', 'items', 'duplicate code/barcode -> 400', 400, r.status, r.text);
  r = await admin.post('/api/items', { code: 'TEST-BADP', name: 'TEST bad price', purchase_price: 10, sale_price: 'abc', stock: 1 });
  record('TC-ITEM-007', 'items', 'invalid sale price "abc" (falls back to purchase*1.2?)', 'reject', r.json?.item ? `accepted sale=${r.json.item.sale_price}` : r.text, r.json?.item ? false : true);
  if (r.json?.item) await admin.del(`/api/items/${r.json.item.id}`);
  r = await admin.post('/api/items', { code: 'TEST-NEGP', name: 'TEST neg price', purchase_price: 10, sale_price: -5, stock: 1 });
  check('TC-ITEM-008', 'items', 'negative price -> 400', 400, r.status, r.text);
  r = await admin.post('/api/items', { code: 'TEST-ZEROP', name: 'TEST zero price', purchase_price: 10, sale_price: 0, mrp: 0, stock: 1 });
  record('TC-ITEM-009', 'items', 'zero sale price silently replaced by purchase*1.2?', 'reject or explicit', r.json?.item ? `accepted sale=${r.json.item.sale_price} mrp=${r.json.item.mrp}` : r.text, r.json?.item ? false : true);
  if (r.json?.item) await admin.del(`/api/items/${r.json.item.id}`);
  r = await admin.post('/api/items', { code: 'TEST-NEGS', name: 'TEST neg stock', purchase_price: 10, sale_price: 12, stock: -5 });
  check('TC-ITEM-010', 'items', 'negative stock -> 400', 400, r.status, r.text);
  r = await admin.post('/api/items', { code: 'TEST-DEC', name: 'TEST dec qty', purchase_price: 10, sale_price: 12, stock: 2.5, unit: 'pcs' });
  record('TC-ITEM-011', 'items', 'decimal stock for pcs unit accepted', 'design (REAL column)', r.json?.item?.stock, 'info');
  if (r.json?.item) await admin.del(`/api/items/${r.json.item.id}`);
  r = await admin.post('/api/items', { code: 'TEST-BIG', name: 'TEST big qty', purchase_price: 10, sale_price: 12, stock: 1e12 });
  check('TC-ITEM-012', 'items', 'large quantity ok', 1e12, r.json?.item?.stock);
  if (r.json?.item) await admin.del(`/api/items/${r.json.item.id}`);
  r = await admin.post('/api/items', { code: 'TEST-SPéc!@#$%', name: 'TEST 特殊 🍚 <b>x</b> \' OR 1=1', purchase_price: 10, sale_price: 12, stock: 1 });
  check('TC-ITEM-013', 'items', 'special chars/unicode/emoji stored', true, r.json?.ok, r.text.slice(0, 200));
  if (r.json?.item) await admin.del(`/api/items/${r.json.item.id}`);
  r = await admin.post('/api/items', { code: 'TEST-LONG', name: 'TEST ' + 'A'.repeat(5000), purchase_price: 10, sale_price: 12, stock: 1 });
  record('TC-ITEM-014', 'items', 'very long name (5000 chars) accepted without limit', 'length limit', r.json?.ok ? 'accepted' : r.text, 'info');
  if (r.json?.item) await admin.del(`/api/items/${r.json.item.id}`);
  r = await admin.post('/api/items', { code: 'TEST-GST', name: 'TEST gst 99', purchase_price: 10, sale_price: 12, stock: 1, gst_percent: 99 });
  record('TC-ITEM-gst', 'items', 'gst_percent 99 accepted (no allowed-slab validation)', 'restrict to 0/5/12/18/28', r.json?.item?.gst_percent, r.json?.item ? false : true);
  if (r.json?.item) await admin.del(`/api/items/${r.json.item.id}`);
  r = await admin.post('/api/items', { code: 'TEST-GSTNEG', name: 'TEST gst neg', purchase_price: 10, sale_price: 12, stock: 1, gst_percent: -5 });
  record('TC-ITEM-gstneg', 'items', 'negative gst_percent accepted', 'reject', r.json?.item?.gst_percent ?? r.text, r.json?.item ? false : true);
  if (r.json?.item) await admin.del(`/api/items/${r.json.item.id}`);

  // Edit
  const rice = created['TEST-RICE-001'];
  r = await admin.put(`/api/items/${rice.id}`, { ...rice, name: 'TEST Rice 1kg (edited)' });
  check('TC-ITEM-015', 'items', 'edit item', 'TEST Rice 1kg (edited)', r.json?.item?.name, r.text.slice(0, 150));
  await admin.put(`/api/items/${rice.id}`, { ...rice });
  // Edit item whose stock is 0 (sold out) -> should be allowed
  r = await admin.post('/api/items', { code: 'TEST-SOLDOUT', name: 'TEST soldout', purchase_price: 10, sale_price: 12, stock: 1 });
  const so = r.json.item;
  await admin.post('/api/cart/clear', {});
  await admin.post('/add_to_cart', { code: 'TEST-SOLDOUT', quantity: 1 });
  await admin.post('/api/sale', { payment_method: 'Cash' });
  let l = await admin.get('/api/items?q=TEST-SOLDOUT');
  check('TC-ITEM-soldout-stock', 'items', 'stock after selling the only unit = 0', 0, l.json.items[0].stock);
  r = await admin.put(`/api/items/${so.id}`, { ...l.json.items[0], name: 'TEST soldout renamed' });
  check('TC-ITEM-015b', 'items', 'edit a sold-out item (stock 0) must be allowed', 200, r.status, r.text);

  // Search / filter
  r = await admin.get('/api/items?q=TEST-RICE');
  check('TC-ITEM-018', 'items', 'search by code', true, r.json.items.some(i => i.code === 'TEST-RICE-001'));
  r = await admin.get('/api/items?q=Sugar');
  check('TC-ITEM-018b', 'items', 'search by name', true, r.json.items.some(i => i.code === 'TEST-SUGAR-001'));
  r = await admin.get('/api/items?category=TEST-Dairy');
  check('TC-ITEM-019', 'items', 'filter by category', true, r.json.items.length > 0 && r.json.items.every(i => i.category === 'TEST-Dairy'));
  r = await admin.get('/api/items?q=%25');
  record('TC-ITEM-018c', 'items', 'search "%" wildcard not escaped -> returns all items', 'escape LIKE wildcards', r.json.items.length, 'info');

  // Delete item used in transactions
  r = await admin.del(`/api/items/${so.id}`);
  check('TC-ITEM-017', 'items', 'delete item that has invoice lines is blocked (no orphans)', 400, r.status, 'item had a sale; deletion refused to protect invoice history');
  const inv = await admin.get('/api/invoices');
  const last = inv.json.invoices[0];
  const invd = await admin.get(`/api/invoices/${last.id}`);
  check('TC-ITEM-017b', 'items', 'invoice keeps line after item deleted', true, invd.json.invoice.items.length === 1 && invd.json.invoice.items[0].code === 'TEST-SOLDOUT');
  // delete of nonexistent id
  r = await admin.del('/api/items/999999');
  record('TC-ITEM-016b', 'items', 'delete nonexistent item returns', '404', r.status, r.status === 404);
  if (minItem) await admin.del(`/api/items/${minItem.id}`);

  // Categories: derived from items (no CRUD)
  r = await admin.get('/api/items');
  check('TC-CAT-001', 'categories', 'categories list derived includes TEST-Grocery', true, r.json.categories.includes('TEST-Grocery'));

  summary();
})().catch(e => { console.error(e); process.exit(1); });
