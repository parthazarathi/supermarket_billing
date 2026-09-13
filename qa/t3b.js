const H = require('./harness'); const { Client, check, record, summary, db, rows } = H;
(async () => {
  const admin2 = new Client('a'); await admin2.login('TEST-ADMIN', 'Test@123');
  const items = (await admin2.get('/api/items?q=TEST-')).json.items; const milk = items.find(i => i.code === 'TEST-MILK-001');
  const parties = (await admin2.get('/api/parties')).json.parties; const cust1 = parties.find(p => p.name === 'TEST-CUSTOMER-001'); const sup = parties.find(p => p.name === 'TEST-SUPPLIER-001');
  let r = await admin2.post('/api/purchase-orders', { party_id: sup.id, items: [{ code: 'TEST-MILK-001', item_id: milk.id, quantity: 5, price: 25 }] });
  record('TC-PO-001', 'purchase_orders', 'create PO', 'ok', `${r.status} ${r.text.slice(0,200)}`, !!r.json?.ok);
  const po = r.json?.purchase_order;
  if (po) { r = await admin2.post(`/api/purchase-orders/${po.id}/convert`, {}); record('TC-PO-convert', 'purchase_orders', 'convert PO to purchase', 'ok', r.json?.ok ? 'ok' : r.text, !!r.json?.ok); }
  await admin2.post('/api/cart/clear', {});
  r = await admin2.post('/add_to_cart', { code: 'TEST-MILK-001', quantity: 3 });
  r = await admin2.post('/api/cart/hold', { name: 'TEST hold' });
  record('TC-HOLD-001', 'pos', 'hold bill', 'ok', `${r.status} ${r.text.slice(0,200)}`, !!r.json?.ok);
  const h = r.json?.held;
  if (h) {
    r = await admin2.post(`/api/cart/recall/${h.id}`, {});
    check('TC-HOLD-recall', 'pos', 'recall held bill restores qty 3', 3, r.json?.cart?.items[0]?.quantity, r.text.slice(0,150));
    r = await admin2.post(`/api/cart/recall/${h.id}`, {});
    record('TC-HOLD-recall-twice', 'pos', 'recalling same held bill twice', 'reject', r.status, r.status !== 200);
    await admin2.post('/api/cart/clear', {});
  }
  r = await admin2.del(`/api/parties/${cust1.id}`);
  record('TC-PARTY-del-history', 'parties', 'delete customer with outstanding invoices/payments allowed?', 'block', r.status === 200 ? 'DELETED (outstanding lost; invoices keep party_id)' : r.text, r.status !== 200);
  let d = await db();
  record('TC-PARTY-del-orphans', 'parties', 'invoices referencing deleted party', 0, rows(d, 'SELECT COUNT(*) c FROM invoices i LEFT JOIN parties p ON p.id=i.party_id WHERE i.party_id IS NOT NULL AND p.id IS NULL')[0].c, 'info');
  const users = (await admin2.get('/api/users')).json.users;
  const emptyUser = users.find(u => u.username === '');
  if (emptyUser) { r = await admin2.del(`/api/users/${emptyUser.id}`); record('TC-USER-cleanup', 'users', 'delete empty-username user', 200, r.status, r.status === 200); }
  for (const code of ['X', 'TEST-INF']) { const it = (await admin2.get(`/api/items?q=${code}`)).json.items.find(i => i.code === code); if (it) await admin2.del(`/api/items/${it.id}`); }
  r = await admin2.del(`/api/users/${users.find(u => u.username === 'TEST-ADMIN').id}`);
  record('TC-USER-self-delete', 'users', 'admin can delete own account while logged in', 'block', r.status, r.status !== 200);
  r = await admin2.get('/api/me');
  record('TC-USER-self-delete-session', 'users', 'session still valid after own account deleted', 'invalid', r.json?.user?.username || 'null', !r.json?.user);
  r = await admin2.post('/api/expenses', { category: 'TEST-ghost', amount: 1 });
  record('TC-USER-ghost-write', 'users', 'deleted user can still write data with old session', 'reject', r.status, r.status !== 200);
  summary();
})();
