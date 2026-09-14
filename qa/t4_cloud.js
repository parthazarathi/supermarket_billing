// Cloud & communication tests: WhatsApp config/validation/sending and
// Google Drive status/backup endpoints. Expects the app running at QA_BASE
// with MARTPOS_DATA_DIR pointing at a scratch dir (no real Twilio/Drive
// credentials - sends are simulated, Drive stays disconnected).
const H = require('./harness');
const { Client, check, record, summary } = H;

(async () => {
  const anon = new Client('anon');
  const admin = new Client('admin');
  const cashier = new Client('cashier');

  let r = await admin.login('admin', 'admin');
  check('TC-CLD-000', 'auth', 'admin login', true, r.json?.ok === true);

  // ---------- WHATSAPP SETTINGS ----------
  r = await admin.post('/api/settings', { whatsapp_number: 'not-a-number' });
  check('TC-WA-001', 'whatsapp', 'invalid WhatsApp number rejected', true, r.status === 400 && r.json?.ok === false, `status=${r.status}`);

  r = await admin.post('/api/settings', { whatsapp_number: '123' });
  check('TC-WA-002', 'whatsapp', 'too-short number rejected', 400, r.status);

  r = await admin.post('/api/settings', { whatsapp_number: '+91 98765 43210' });
  check('TC-WA-003', 'whatsapp', 'valid +91 number accepted and normalized', '+919876543210', r.json?.settings?.whatsapp_number, r.text.slice(0, 200));

  r = await admin.post('/api/settings', { whatsapp_number: '9876543210' });
  check('TC-WA-004', 'whatsapp', 'bare 10-digit Indian number gets +91', '+919876543210', r.json?.settings?.whatsapp_number);

  // ---------- SECRET HANDLING ----------
  r = await admin.post('/api/settings', {
    twilio_account_sid: 'ACtestsid123',
    twilio_auth_token: 'SECRET-TOKEN-XYZ',
    twilio_whatsapp_from: '+14155238886'
  });
  check('TC-WA-010', 'whatsapp', 'Twilio credentials accepted', true, r.json?.ok === true);
  check('TC-WA-011', 'whatsapp', 'credentials not echoed in response', false, JSON.stringify(r.json).includes('SECRET-TOKEN-XYZ'));
  check('TC-WA-012', 'whatsapp', 'configured flag true after saving creds', true, r.json?.whatsapp?.configured === true, JSON.stringify(r.json?.whatsapp));

  r = await admin.get('/api/settings');
  check('TC-WA-013', 'whatsapp', 'GET /api/settings never exposes secrets', false, JSON.stringify(r.json).includes('SECRET-TOKEN-XYZ') || JSON.stringify(r.json).includes('ACtestsid123'));
  check('TC-WA-014', 'whatsapp', 'whatsapp status present in settings payload', true, r.json?.whatsapp?.configured === true && r.json?.whatsapp?.number === '+919876543210');

  // Clear creds again so later sends are deterministic (simulated)
  r = await admin.post('/api/settings', { twilio_disconnect: '1' });
  check('TC-WA-015', 'whatsapp', 'twilio_disconnect clears credentials', false, r.json?.whatsapp?.configured === true);

  // ---------- WHATSAPP TEST MESSAGE ----------
  r = await admin.post('/api/whatsapp/test', {});
  check('TC-WA-020', 'whatsapp', 'test message endpoint responds', 200, r.status, r.text.slice(0, 200));
  check('TC-WA-021', 'whatsapp', 'test send simulated without creds', 'simulated', r.json?.result?.provider, r.text.slice(0, 200));

  r = await admin.post('/api/whatsapp/test', { to: 'bad' });
  check('TC-WA-022', 'whatsapp', 'test to invalid recipient reports failure', false, r.json?.result?.ok === true, r.text.slice(0, 200));

  // ---------- SALE + WHATSAPP ----------
  const items = (await admin.get('/api/items')).json?.items || [];
  const item = items[0];
  if (!item) {
    record('TC-SALE-000', 'sale', 'seeded item exists', 'item', 'none', 'skip');
  } else {
    r = await admin.post('/add_to_cart', { code: item.code, quantity: 1 });
    check('TC-SALE-001', 'sale', 'add to cart', true, r.json?.ok === true || r.status === 200, r.text.slice(0, 150));

    r = await admin.post('/api/sale', { payment_method: 'Cash', paid: '9999', customer_phone: 'bogus', send_whatsapp: true });
    check('TC-SALE-010', 'sale', 'sale succeeds despite invalid WhatsApp number', true, r.json?.ok === true && !!r.json?.invoice?.invoice_no, r.text.slice(0, 200));
    check('TC-SALE-011', 'sale', 'WhatsApp failure reported, sale intact', false, r.json?.whatsapp?.ok === true, JSON.stringify(r.json?.whatsapp));
    const badPhoneInvoice = r.json?.invoice;

    r = await admin.post('/add_to_cart', { code: item.code, quantity: 1 });
    r = await admin.post('/api/sale', { payment_method: 'Cash', paid: '9999', phone: '+91 98765 00000', send_whatsapp: true });
    check('TC-SALE-012', 'sale', 'sale + simulated WhatsApp send', 'simulated', r.json?.whatsapp?.provider, r.text.slice(0, 200));
    const inv = r.json?.invoice;

    // Retry/resend on a saved invoice
    r = await admin.post(`/api/invoices/${inv.id}/whatsapp`, { phone: '+919876500001' });
    check('TC-SALE-013', 'sale', 'resend bill on WhatsApp (simulated)', 'simulated', r.json?.whatsapp?.provider, r.text.slice(0, 200));

    r = await admin.post(`/api/invoices/${badPhoneInvoice.id}/whatsapp`, { phone: 'xx' });
    check('TC-SALE-014', 'sale', 'resend with bad number fails gracefully, invoice intact', true, r.status === 200 && r.json?.ok === true && r.json?.whatsapp?.ok === false, r.text.slice(0, 200));

    r = await admin.post(`/api/invoices/${badPhoneInvoice.id}/whatsapp`, {});
    check('TC-SALE-015', 'sale', 'resend uses saved party phone (bad -> graceful fail)', true, r.json?.ok === true && r.json?.whatsapp?.ok === false, r.text.slice(0, 200));

    r = await admin.post('/api/invoices/999999/whatsapp', { phone: '+919876543210' });
    check('TC-SALE-016', 'sale', 'resend on missing invoice -> 404', 404, r.status);
  }

  // ---------- ROLE GATING ----------
  r = await cashier.login('TEST-CASHIER', 'Test@123');
  if (r.json?.ok !== true) {
    await admin.post('/api/users', { username: 'TEST-CASHIER', password: 'Test@123', role: 'cashier' });
    r = await cashier.login('TEST-CASHIER', 'Test@123');
  }
  r = await cashier.post('/api/settings', { whatsapp_number: '+919000000000' });
  check('TC-ROLE-001', 'auth', 'cashier cannot change settings', 403, r.status);
  r = await cashier.post('/api/whatsapp/test', {});
  check('TC-ROLE-002', 'auth', 'cashier cannot run WhatsApp test', 403, r.status);
  if (item) {
    r = await cashier.post('/api/invoices/1/whatsapp', { phone: '+919876543210' });
    check('TC-ROLE-003', 'auth', 'cashier can send a bill on WhatsApp', 200, r.status, r.text.slice(0, 150));
  }

  // ---------- GOOGLE DRIVE ----------
  r = await admin.get('/api/drive/status');
  const d = r.json?.drive || {};
  check('TC-DRV-001', 'drive', 'drive status shape', true,
    d.connected === false && 'email' in d && 'auto_backup' in d && 'backup_interval' in d && 'last_backup_at' in d && 'folder' in d,
    JSON.stringify(d));

  r = await admin.post('/api/drive/backup', {});
  check('TC-DRV-002', 'drive', 'backup without connection -> friendly error', true, r.status === 400 && /connect/i.test(r.json?.error || ''), r.text.slice(0, 200));

  r = await admin.post('/api/drive/disconnect', {});
  check('TC-DRV-003', 'drive', 'disconnect is safe when not connected', true, r.json?.ok === true && r.json?.drive?.connected === false);

  r = await admin.post('/api/settings', { drive_backup_interval: 'bogus' });
  check('TC-DRV-010', 'drive', 'invalid backup frequency rejected', 400, r.status);

  r = await admin.post('/api/settings', { drive_auto_backup: '1', drive_backup_interval: '6h' });
  check('TC-DRV-011', 'drive', 'auto backup + frequency saved', '6h', r.json?.settings?.drive_backup_interval);

  r = await admin.get('/api/drive/status');
  check('TC-DRV-012', 'drive', 'status reflects auto-backup config', true, r.json?.drive?.auto_backup === true && r.json?.drive?.backup_interval === '6h');

  // ---------- AUTH ----------
  r = await anon.get('/api/drive/status');
  check('TC-SEC-001', 'auth', 'drive status requires login', 401, r.status);
  r = await anon.post('/api/whatsapp/test', {});
  check('TC-SEC-002', 'auth', 'whatsapp test requires login', 401, r.status);

  summary();
})().catch((e) => { console.error('t4 crashed:', e); process.exit(2); });
