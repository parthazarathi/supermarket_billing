const H = require('./harness');
const { Client, check, record, summary, db, rows, one, near } = H;

(async () => {
  const admin = new Client('admin'); await admin.login('admin', 'admin');
  const anon = new Client('anon');
  const cashier = new Client('cashier'); await cashier.login('TEST-CASHIER', 'Test@123');
  const items = (await admin.get('/api/items?q=TEST-')).json.items;
  const milk = items.find(i => i.code === 'TEST-MILK-001');
  const rice = items.find(i => i.code === 'TEST-RICE-001');
  const parties = (await admin.get('/api/parties')).json.parties;
  const cust1 = parties.find(p => p.name === 'TEST-CUSTOMER-001');
  let r;

  // ---------- Unauthenticated access to every mutating endpoint ----------
  const mut = [['POST', '/api/items'], ['PUT', '/api/items/1'], ['DELETE', '/api/items/1'], ['POST', '/api/parties'], ['POST', '/api/sale'], ['POST', '/add_to_cart'], ['POST', '/api/purchases'], ['POST', '/api/expenses'], ['POST', '/api/settings'], ['POST', '/api/users'], ['POST', '/api/invoices/1/cancel'], ['POST', '/api/invoices/1/return'], ['PUT', '/api/invoices/1'], ['DELETE', '/api/invoices/1'], ['POST', '/api/stock-adjustments'], ['POST', '/api/drive/restore'], ['GET', '/api/reports/audit'], ['GET', '/upi_qr?am=1'], ['GET', '/api/accounts'], ['POST', '/api/estimates']];
  for (const [m, u] of mut) {
    r = await anon.req(m, u, {});
    check(`TC-SEC-anon-${m}-${u}`, 'security', `anon ${m} ${u} -> 401`, 401, r.status, r.text.slice(0, 80));
  }
  // Cashier on manager/admin endpoints
  for (const [m, u] of [['POST', '/api/purchases'], ['POST', '/api/stock-adjustments'], ['GET', '/api/purchase-returns'], ['GET', '/api/stock-adjustments'], ['GET', '/api/reports/audit'], ['GET', '/api/drive/status'], ['POST', '/api/drive/restore'], ['DELETE', '/api/users/1'], ['DELETE', '/api/expenses/1'], ['DELETE', '/api/parties/1'], ['PUT', '/api/invoices/1'], ['DELETE', '/api/invoices/1'], ['POST', '/api/accounts'], ['POST', '/api/accounts/1/transactions']]) {
    r = await cashier.req(m, u, {});
    check(`TC-SEC-cashier-${m}-${u}`, 'security', `cashier ${m} ${u} -> 403`, 403, r.status, r.text.slice(0, 80));
  }
  // Cashier-accessible but sensitive?
  r = await cashier.get('/api/estimates');
  record('TC-SEC-cashier-estimates', 'security', 'cashier can read estimates', 200, r.status, 'info');
  r = await cashier.post('/api/estimates', { cart: {} });
  check('TC-SEC-cashier-estimates-post', 'security', 'cashier cannot create estimates', 403, r.status);
  r = await cashier.get('/api/accounts/1/transactions');
  record('TC-SEC-cashier-acct-tx', 'security', 'cashier can read account transactions', 'design', r.status, 'info');
  r = await cashier.get(`/api/parties/${cust1.id}/credit-check?amount=10`);
  record('TC-SEC-cashier-credit-check', 'security', 'cashier can query credit check (needed for POS)', 200, r.status, r.status === 200);

  // IDOR: cashier changing own password OK, another user's -> 403 (tested). Cashier reading another cashier's held bills?
  r = await cashier.get('/api/cart/held');
  check('TC-SEC-held-own', 'security', 'held bills scoped to user', 200, r.status);
  await admin.post('/api/cart/clear', {});
  await admin.post('/add_to_cart', { code: 'TEST-MILK-001', quantity: 1 });
  r = await admin.post('/api/cart/hold', { name: 'TEST admin held' });
  const heldId = r.json?.held?.id;
  r = await cashier.post(`/api/cart/recall/${heldId}`, {});
  record('TC-SEC-IDOR-held', 'security', 'cashier can recall ANOTHER user\'s held bill by id (IDOR)', 'reject', r.status === 200 ? `ACCEPTED (${r.json.cart.items.length} items)` : r.status, r.status !== 200);
  await cashier.post('/api/cart/clear', {});

  // Injection-style inputs across endpoints
  const nasty = ["' OR '1'='1", "\"; DROP TABLE items; --", '<script>alert(1)</script>', '%', '_', '\u0000', 'A'.repeat(10000)];
  for (const n of nasty) {
    r = await admin.get(`/api/items?q=${encodeURIComponent(n)}`);
    check(`TC-SEC-search-${n.slice(0, 12)}`, 'security', `items search with hostile input no 500`, true, r.status === 200, `status=${r.status}`);
    r = await admin.get(`/api/reports/sales/bill-wise?q=${encodeURIComponent(n)}`);
    check(`TC-SEC-report-q-${n.slice(0, 12)}`, 'security', `bill-wise q hostile no 500`, true, r.status === 200, `status=${r.status} ${r.text.slice(0, 80)}`);
  }
  d = await db();
  check('TC-SEC-tables-intact', 'security', 'items table still exists', true, rows(d, "SELECT name FROM sqlite_master WHERE name='items'").length === 1);

  // Malformed JSON
  r = await admin.req('POST', '/api/items', '{bad json', { raw: true });
  record('TC-API-badjson', 'api', 'malformed JSON body -> 400 JSON error (not HTML stack)', '400 json', `${r.status} ${r.text.slice(0, 120)}`, r.status === 400 && !/<pre>|at .*\.js:\d+/.test(r.text));
  // Report param types
  r = await admin.get('/api/reports/inventory/ledger?item_id=abc');
  record('TC-API-ledger-nan', 'api', 'ledger with item_id=abc', '400', `${r.status} ${r.text.slice(0, 100)}`, r.status === 400);
  r = await admin.get('/api/reports/inventory/ledger');
  record('TC-API-ledger-missing', 'api', 'ledger with no item_id', '400', `${r.status} ${r.text.slice(0, 100)}`, r.status === 400);
  r = await admin.get('/api/reports/customers/ledger?party_id=999999');
  check('TC-API-ledger-404', 'api', 'ledger for nonexistent party -> 400/404', true, [400, 404].includes(r.status));
  r = await admin.get('/api/reports/customers/ledger?party_id=' + parties.find(p => p.type === 'supplier').id);
  check('TC-API-ledger-type', 'api', 'customer ledger for a supplier id -> error', true, r.status >= 400);
  r = await admin.get('/api/reports/sales/bill-wise?page=-1&per_page=0');
  check('TC-API-paging', 'api', 'bad paging params clamp', 200, r.status);
  r = await admin.get('/api/reports/sales/bill-wise?per_page=100000');
  record('TC-API-paging-max', 'api', 'per_page=100000 accepted (DoS surface)', 'cap ~500', r.json?.report?.per_page, 'info');
  r = await admin.get('/api/reports/nope/nope');
  check('TC-API-unknown-report', 'api', 'unknown report -> 404', 404, r.status);
  r = await admin.get('/api/invoices/abc');
  check('TC-API-inv-nan', 'api', 'invoice id abc -> 404', 404, r.status);
  r = await admin.get('/api/invoices/999999');
  check('TC-API-inv-404', 'api', 'nonexistent invoice -> 404', 404, r.status);
  r = await admin.post('/api/invoices/999999/payment', { amount: 1 });
  check('TC-API-pay-404', 'api', 'payment on nonexistent invoice -> 400/404', true, [400, 404].includes(r.status));
  r = await admin.post('/api/parties/999999/payment', { amount: 1 });
  check('TC-API-partypay-404', 'api', 'payment for nonexistent party -> 400/404', true, [400, 404].includes(r.status));
  r = await admin.post(`/api/parties/${cust1.id}/payment`, { amount: -500 });
  record('TC-API-partypay-neg', 'api', 'negative party payment accepted?', 'reject', r.json?.ok ? `ACCEPTED amount=${r.json.payment.amount}` : r.text, r.json?.ok ? false : true);
  r = await admin.post(`/api/parties/${cust1.id}/payment`, { amount: 'abc' });
  record('TC-API-partypay-nan', 'api', 'NaN party payment', 'reject', r.json?.ok ? `ACCEPTED amount=${JSON.stringify(r.json.payment.amount)}` : r.text.slice(0, 100), r.json?.ok ? false : true);
  r = await admin.post(`/api/parties/${cust1.id}/payment`, {});
  record('TC-API-partypay-missing', 'api', 'missing amount party payment', 'reject', r.json?.ok ? `ACCEPTED amount=${JSON.stringify(r.json.payment.amount)}` : r.text.slice(0, 100), r.json?.ok ? false : true);
  r = await admin.post(`/api/parties/${cust1.id}/payment`, { amount: 10, note: 'Invoice FAKE-1' });
  record('TC-API-partypay-note', 'api', 'party payment with note "Invoice ..." is EXCLUDED from outstanding by design of NOT LIKE filter', 'should still count', 'accepted; verify via outstanding below', 'info');
  const c1a = (await admin.get('/api/parties')).json.parties.find(p => p.id === cust1.id).outstanding;
  r = await admin.post(`/api/parties/${cust1.id}/payment`, { amount: 10, note: 'Invoice FAKE-2' });
  const c1b = (await admin.get('/api/parties')).json.parties.find(p => p.id === cust1.id).outstanding;
  record('TC-PAY-note-exclusion', 'payments', 'a standalone receipt whose note starts with "Invoice " does not reduce outstanding', 'outstanding -10', `${c1a} -> ${c1b}`, near(c1a - 10, c1b));

  // Item ID/type fuzz
  r = await admin.put('/api/items/abc', { code: 'X', name: 'X', purchase_price: 1, sale_price: 2, stock: 1 });
  record('TC-API-item-put-nan', 'api', 'PUT /api/items/abc', '404', `${r.status} ${r.text.slice(0, 100)}`, r.status === 404);
  r = await admin.put('/api/items/999999', { code: 'TEST-GHOST', name: 'TEST ghost', purchase_price: 1, sale_price: 2, stock: 1 });
  record('TC-API-item-put-404', 'api', 'PUT nonexistent item', '404', `${r.status} ${r.text.slice(0, 100)}`, r.status === 404);
  r = await admin.post('/api/items', { code: 'TEST-TYPES', name: ['arr'], purchase_price: { a: 1 }, sale_price: true, stock: [5] });
  record('TC-API-item-types', 'api', 'wrong data types in item', '400', `${r.status} ${r.text.slice(0, 100)}`, r.status === 400);
  if (r.json?.item) await admin.del(`/api/items/${r.json.item.id}`);
  r = await admin.post('/api/items', { code: 'TEST-INF', name: 'TEST inf', purchase_price: 1, sale_price: 1e309, stock: 1 });
  record('TC-API-item-inf', 'api', 'Infinity sale price (JSON nullifies to absent -> finite fallback, no Infinity stored)', 'finite or reject', `${r.status} ${r.text.slice(0, 100)}`, !r.json?.ok || isFinite(r.json?.item?.sale_price));
  if (r.json?.item) await admin.del(`/api/items/${r.json.item.id}`);
  r = await admin.post('/api/stock-adjustments', { item_id: rice.id, change: '1e400' });
  check('TC-API-adj-inf', 'api', 'adjustment infinity rejected', 400, r.status);
  r = await admin.post('/api/stock-adjustments', { item_id: rice.id, change: 0.0000001 });
  record('TC-API-adj-tiny', 'api', 'adjustment 1e-7 accepted', 'reject/round', r.status, 'info');

  // Stack traces / info leak
  r = await admin.get('/api/settings');
  record('TC-SEC-settings-paths', 'security', 'admin settings exposes data_dir/db_path (filesystem paths)', 'ok for local desktop app', { data_dir: r.json.data_dir, db_path: r.json.db_path }, 'info');
  check('TC-SEC-settings-hash', 'security', 'settings never returns bill_passcode_hash', false, r.text.includes('bill_passcode_hash'));
  r = await admin.get('/api/users');
  check('TC-SEC-users-hash', 'security', 'user list has no password_hash', false, r.text.includes('password_hash'));
  r = await admin.get('/api/reports/audit?from=2000-01-01&to=2099-01-01&per_page=5');
  record('TC-SEC-audit', 'security', 'audit report accessible; check old/new values don\'t include hashes', false, r.text.includes('password_hash') || r.text.includes('$2a$'), !(r.text.includes('password_hash') || r.text.includes('$2a$')));

  // Passcode brute-force limiter
  const inv = (await admin.get('/api/invoices')).json.invoices.find(i => i.status !== 'cancelled');
  let statuses = [];
  for (let i = 0; i < 7; i++) { r = await admin.del(`/api/invoices/${inv.id}`, { passcode: String(1000 + i) }); statuses.push(r.status); }
  record('TC-SEC-passcode-limit', 'security', 'passcode limiter locks after 5 failures', '401 x5 then 429', statuses.join(','), statuses.slice(5).every(s => s === 429));
  // Login limiter (10 failures) - use unique IP? all same; test quickly then stop before locking admin out of tests: skip actual lockout
  record('TC-SEC-login-limit', 'security', 'login limiter present (10/15min per IP) - code-verified, not exercised to avoid locking test session', 'present', 'present', 'info');

  // Settings validation
  r = await admin.post('/api/settings', { gst_type: 'martian', default_gst: '-5', receipt_printer_width: 'abc', shop_name: '<script>x</script>' });
  record('TC-SET-validation', 'settings', 'settings accept arbitrary gst_type/default_gst/printer width', 'validate', r.json?.settings && { gst_type: r.json.settings.gst_type, default_gst: r.json.settings.default_gst, w: r.json.settings.receipt_printer_width }, 'info');
  await admin.post('/api/settings', { gst_type: 'intra', default_gst: '0', receipt_printer_width: '80', shop_name: 'Bharathi Supermarket' });
  r = await admin.post('/api/settings', { bill_passcode: '12' });
  check('TC-SET-passcode-short', 'settings', 'passcode too short rejected', 400, r.status);
  r = await admin.post('/api/settings', { bill_passcode_hash: 'x' });
  check('TC-SET-passcode-hash-direct', 'settings', 'cannot set hash directly (not in allowlist)', true, (await admin.get('/api/me')).json.settings.bill_passcode_set === true);

  // IGST mode calculation
  await admin.post('/api/settings', { gst_type: 'inter' });
  await admin.post('/api/cart/clear', {});
  await admin.post('/add_to_cart', { code: 'TEST-SOAP-001', quantity: 1 }); // 28 @28% -> tax 7.84
  r = await admin.post('/api/sale', { payment_method: 'Cash' });
  check('TC-GST-igst', 'gst', 'inter-state: igst = tax, cgst=sgst=0', { igst: 7.84, cgst: 0, sgst: 0, total: 35.84 }, r.json?.invoice && { igst: r.json.invoice.igst, cgst: r.json.invoice.cgst, sgst: r.json.invoice.sgst, total: r.json.invoice.total }, r.text.slice(0, 120));
  await admin.post('/api/settings', { gst_type: 'intra' });
  // Zero tax item
  await admin.post('/api/cart/clear', {});
  await admin.post('/add_to_cart', { code: 'TEST-MILK-001', quantity: 1 });
  r = await admin.post('/api/sale', { payment_method: 'Cash' });
  check('TC-GST-zero', 'gst', 'zero-tax item', { tax: 0, total: 30 }, { tax: r.json.invoice.tax, total: r.json.invoice.total });
  // GST returns report & HSN
  const today = new Date(); const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  r = await admin.get(`/api/reports/gst/hsn-sales?from=${ymd}&to=${ymd}`);
  record('TC-GST-hsn', 'gst', 'HSN report rows (blank HSN grouping?)', 'rows', r.json.report.rows.slice(0, 3), 'info');
  r = await admin.get(`/api/reports/gst/returns?from=${ymd}&to=${ymd}`);
  record('TC-GST-returns', 'gst', 'GST returns summary', 'rows', r.json.report.summary || r.json.report.rows?.slice(0, 2), 'info');

  // ---------- Bill edit (passcode) ----------
  await admin.post('/api/settings', { bill_passcode: '4321' });
  await new Promise(res => setTimeout(res, 100));
  // Wait: limiter may still be locked for admin from the brute-force test (10 min). Use TEST-ADMIN instead.
  const admin2 = new Client('admin2'); await admin2.login('TEST-ADMIN', 'Test@123');
  await admin2.post('/api/cart/clear', {});
  await admin2.post('/add_to_cart', { code: 'TEST-RICE-001', quantity: 2 });
  r = await admin2.post('/api/sale', { payment_method: 'Cash' });
  const einv = r.json.invoice;
  const riceStock0 = (await admin2.get('/api/items?q=TEST-RICE-001')).json.items[0].stock;
  r = await admin2.put(`/api/invoices/${einv.id}`, { passcode: '4321', items: [{ code: 'TEST-RICE-001', quantity: 5, price: rice.sale_price }, { code: 'TEST-MILK-001', quantity: 1, price: 30 }], bill_discount: 0, paid: einv.total });
  const einv2 = r.json?.invoice;
  check('TC-EDIT-001', 'sales', 'edit bill: qty 2->5 + add milk', true, r.json?.ok, r.text.slice(0, 200));
  const riceStock1 = (await admin2.get('/api/items?q=TEST-RICE-001')).json.items[0].stock;
  check('TC-EDIT-stock', 'sales', 'edit adjusts stock by delta (-3)', riceStock0 - 3, riceStock1);
  record('TC-EDIT-paid', 'sales', 'edit: paid kept at old total, status becomes partial (was fully paid)', 'explicit', einv2 && { total: einv2.total, paid: einv2.paid, status: einv2.status }, 'info');
  r = await admin2.put(`/api/invoices/${einv.id}`, { passcode: '4321', items: [{ code: 'TEST-RICE-001', quantity: 1, price: -5 }] });
  check('TC-EDIT-negprice', 'sales', 'edit with negative price rejected', 400, r.status);
  r = await admin2.put(`/api/invoices/${einv.id}`, { passcode: '4321', items: [{ code: 'TEST-RICE-001', quantity: 1, price: 0 }] });
  record('TC-EDIT-zeroprice', 'sales', 'edit with price 0 accepted (free goods)', 'design', r.status, 'info');
  r = await admin2.put(`/api/invoices/${einv.id}`, { passcode: '4321', items: [{ code: 'TEST-RICE-001', quantity: 1, price: 50 }], paid: 99999 });
  check('TC-EDIT-overpaid', 'sales', 'edit caps paid at total', true, r.json?.invoice && r.json.invoice.paid <= r.json.invoice.total, r.text.slice(0, 120));
  r = await admin2.put(`/api/invoices/${einv.id}`, { passcode: '4321', items: [{ code: 'TEST-RICE-001', quantity: 1, price: 50 }], paid: -5 });
  record('TC-EDIT-negpaid', 'sales', 'edit with paid=-5', 'reject', r.json?.invoice && { paid: r.json.invoice.paid, status: r.json.invoice.status }, r.json?.invoice ? r.json.invoice.paid >= 0 : true);
  const riceStockE = (await admin2.get('/api/items?q=TEST-RICE-001')).json.items[0].stock;
  r = await admin2.del(`/api/invoices/${einv.id}`, { passcode: '4321' });
  check('TC-DEL-001', 'sales', 'delete bill with passcode', 200, r.status, r.text);
  check('TC-DEL-stock', 'sales', 'delete restores stock (+1)', riceStockE + 1, (await admin2.get('/api/items?q=TEST-RICE-001')).json.items[0].stock);
  d = await db();
  check('TC-DEL-db', 'sales', 'invoice rows removed', 0, rows(d, 'SELECT COUNT(*) c FROM invoice_items WHERE invoice_id=?', [einv.id])[0].c);
  // Invoice number reuse after delete of latest
  await admin2.post('/add_to_cart', { code: 'TEST-MILK-001', quantity: 1 });
  r = await admin2.post('/api/sale', { payment_method: 'Cash' });
  record('TC-INVNO-reuse', 'invoice_no', 'after deleting latest bill, next bill reuses its number', 'never reuse (audit log references it)', `${einv.invoice_no} -> ${r.json.invoice.invoice_no}`, r.json.invoice.invoice_no !== einv.invoice_no);
  const auditRef = rows(await db(), 'SELECT COUNT(*) c FROM audit_logs WHERE reference=?', [einv.invoice_no])[0].c;
  record('TC-INVNO-audit', 'invoice_no', `audit rows referencing ${einv.invoice_no} (now ambiguous if reused)`, 'n', auditRef, 'info');

  // ---------- Estimates / PO conversion (backend modules) ----------
  r = await admin2.post('/api/estimates', { cart: { 'TEST-MILK-001': { item_id: milk.id, name: milk.name, price: 30, quantity: 2, gst_percent: 0 } }, party_name: 'TEST est' });
  const est = r.json?.estimate;
  check('TC-EST-001', 'estimates', 'create estimate', true, r.json?.ok, r.text.slice(0, 150));
  if (est) {
    const milk0 = (await admin2.get('/api/items?q=TEST-MILK-001')).json.items[0].stock;
    r = await admin2.post(`/api/estimates/${est.id}/convert`, { payment_method: 'Cash' });
    record('TC-EST-convert', 'estimates', 'convert estimate to invoice', 'ok', r.json?.ok ? `ok ${r.json.invoice?.invoice_no}` : r.text, !!r.json?.ok);
    const milk1 = (await admin2.get('/api/items?q=TEST-MILK-001')).json.items[0].stock;
    record('TC-EST-convert-stock', 'estimates', 'stock after conversion', milk0 - 2, milk1, milk1 === milk0 - 2);
    const e2 = (await admin2.get(`/api/estimates/${est.id}`)).json.estimate;
    record('TC-EST-status', 'estimates', 'estimate status after convert', 'converted', e2?.status, e2?.status === 'converted');
    d = await db();
    const convInv = r.json?.invoice ? one(d, 'SELECT * FROM invoice_items WHERE invoice_id=?', [r.json.invoice.id]) : null;
    if (convInv) record('TC-EST-cogs', 'estimates', 'converted invoice line carries purchase_price (COGS)', 25, convInv.purchase_price, convInv.purchase_price === 25);
  }
  r = await admin2.post('/api/purchase-orders', { party_id: parties.find(p => p.name === 'TEST-SUPPLIER-001').id, items: [{ code: 'TEST-MILK-001', item_id: milk.id, quantity: 5, price: 25 }] });
  const po = r.json?.purchase_order;
  check('TC-PO-001', 'purchase_orders', 'create PO', true, r.json?.ok, r.text.slice(0, 150));
  if (po) {
    r = await admin2.post(`/api/purchase-orders/${po.id}/convert`, {});
    record('TC-PO-convert', 'purchase_orders', 'convert PO to purchase', 'ok', r.json?.ok ? 'ok' : r.text, !!r.json?.ok);
  }
  // Cash session
  r = await admin2.post('/api/cash-session/open', { opening_cash: 1000 });
  check('TC-CASH-open', 'cash', 'open cash session', true, r.json?.ok, r.text.slice(0, 120));
  r = await admin2.post('/api/cash-session/open', { opening_cash: 1000 });
  check('TC-CASH-open-twice', 'cash', 'second open rejected', 400, r.status, r.text.slice(0, 120));
  await admin2.post('/add_to_cart', { code: 'TEST-MILK-001', quantity: 1 });
  await admin2.post('/api/sale', { payment_method: 'Cash' });
  r = await admin2.post('/api/cash-session/close', { closing_cash: 1030 });
  record('TC-CASH-close', 'cash', 'close session: expected cash should be 1000+30 (only cash sales of THIS user in session)', 1030, r.json?.session?.expected_cash, near(1030, r.json?.session?.expected_cash));

  // ---------- Held bills ----------
  await admin2.post('/api/cart/clear', {});
  await admin2.post('/api/items', { code: 'TEST-HOLD-001', name: 'TEST hold item', purchase_price: 10, sale_price: 20, mrp: 22, stock: 100, gst_percent: 0 });
  await admin2.post('/add_to_cart', { code: 'TEST-HOLD-001', quantity: 3 });
  r = await admin2.post('/api/cart/hold', { name: 'TEST hold' });
  const h = r.json.held;
  r = await admin2.post(`/api/cart/recall/${h.id}`, {});
  check('TC-HOLD-recall', 'pos', 'recall held bill restores qty 3', 3, r.json?.cart?.items[0]?.quantity);
  r = await admin2.post(`/api/cart/recall/${h.id}`, {});
  record('TC-HOLD-recall-twice', 'pos', 'recalling same held bill twice', 'reject (already recalled)', r.status, r.status !== 200);
  await admin2.post('/api/cart/clear', {});

  // ---------- Party delete with history ----------
  r = await admin2.del(`/api/parties/${cust1.id}`);
  record('TC-PARTY-del-history', 'parties', 'delete customer with outstanding invoices/payments allowed?', 'block', r.status === 200 ? 'DELETED (outstanding lost; invoices keep party_id)' : r.text, r.status !== 200);
  d = await db();
  record('TC-PARTY-del-orphans', 'parties', 'invoices referencing deleted party', 0, rows(d, 'SELECT COUNT(*) c FROM invoices i LEFT JOIN parties p ON p.id=i.party_id WHERE i.party_id IS NOT NULL AND p.id IS NULL')[0].c, 'info');
  const custOutAfter = (await admin2.get('/api/reports/customers/outstanding')).json.report.summary;
  record('TC-PARTY-del-outstanding', 'parties', 'customer outstanding total after deleting a debtor (money silently vanished?)', 'unchanged', custOutAfter, 'info');
  // user delete: last admin?
  const users = (await admin2.get('/api/users')).json.users;
  const emptyUser = users.find(u => u.username === '');
  if (emptyUser) { r = await admin2.del(`/api/users/${emptyUser.id}`); record('TC-USER-cleanup', 'users', 'delete empty-username user created by TC-USER-004', 200, r.status, r.status === 200); }
  r = await admin2.del(`/api/users/${admin2.cookie && users.find(u => u.username === 'TEST-ADMIN').id}`);
  record('TC-USER-self-delete', 'users', 'admin can delete own account while logged in', 'block', r.status, r.status !== 200);
  r = await admin2.get('/api/me');
  record('TC-USER-self-delete-session', 'users', 'session remains valid because self-delete was blocked', 'valid', r.json?.user?.username || 'null', !!r.json?.user);

  summary();
})().catch(e => { console.error(e); process.exit(1); });
