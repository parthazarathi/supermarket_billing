// Reliability tests: WhatsApp attempt log/statuses, auto-send, local
// backups, backup history, staged restore flow, drive test endpoint,
// health check, and role gating on the new endpoints.
// Expects the app running at QA_BASE with MARTPOS_DATA_DIR pointing at a
// scratch dir (QA_DB must point at its pos.db for direct-DB checks).
const H = require('./harness');
const fs = require('fs');
const path = require('path');
const { Client, check, record, summary } = H;
const DATA_DIR = path.dirname(process.env.QA_DB || path.join(__dirname, 'data', 'pos.db'));
const BKU = path.join(DATA_DIR, 'backups');

(async () => {
  const admin = new Client('admin');
  const cashier = new Client('cashier');

  let r = await admin.login('admin', 'admin');
  check('TC5-000', 'auth', 'admin login', true, r.json?.ok === true, r.text.slice(0, 150));

  // ---------- WHATSAPP ATTEMPT LOG ----------
  const items = (await admin.get('/api/items')).json?.items || [];
  const item = items[0];
  if (!item) {
    record('TC5-WA-000', 'whatsapp', 'seeded item exists', 'item', 'none', 'skip');
  } else {
    await admin.post('/add_to_cart', { code: item.code, quantity: 1 });
    r = await admin.post('/api/sale', { payment_method: 'Cash', paid: '9999', customer_phone: '+91 98765 11111', send_whatsapp: true });
    const inv = r.json?.invoice;
    check('TC5-WA-001', 'whatsapp', 'sale completes with WhatsApp requested', true, r.json?.ok === true && !!inv?.invoice_no, r.text.slice(0, 200));

    // Attempt recorded in whatsapp_log
    const d1 = await H.db();
    const waRows = H.rows(d1, 'SELECT * FROM whatsapp_log WHERE invoice_id = ?', [inv.id]);
    check('TC5-WA-002', 'whatsapp', 'send attempt logged with invoice+phone+status', true,
      waRows.length > 0 && waRows[0].phone === '+919876511111' && ['sent', 'failed'].includes(waRows[0].status),
      JSON.stringify(waRows[0]));

    // Invoice list carries latest status
    r = await admin.get('/api/invoices');
    const row = (r.json?.invoices || []).find((i) => i.id === inv.id);
    check('TC5-WA-003', 'whatsapp', 'invoice list carries whatsapp status', true, !!row && !!row.whatsapp && typeof row.whatsapp.status === 'string', JSON.stringify(row && row.whatsapp));

    // Invoice detail carries attempt history
    r = await admin.get(`/api/invoices/${inv.id}`);
    check('TC5-WA-004', 'whatsapp', 'invoice detail carries attempt history', true, (r.json?.invoice?.whatsapp_attempts || []).length > 0);

    // Retry resends the SAME invoice (no duplicate sale)
    const invCount = H.rows(d1, 'SELECT COUNT(*) c FROM invoices')[0].c;
    r = await admin.post(`/api/invoices/${inv.id}/whatsapp`, { phone: '+919876522222' });
    check('TC5-WA-005', 'whatsapp', 'retry endpoint responds', 200, r.status);
    const d2 = await H.db();
    const invCount2 = H.rows(d2, 'SELECT COUNT(*) c FROM invoices')[0].c;
    check('TC5-WA-006', 'whatsapp', 'retry does not create a duplicate sale', invCount, invCount2);
    const waRows2 = H.rows(d2, 'SELECT * FROM whatsapp_log WHERE invoice_id = ? ORDER BY id', [inv.id]);
    check('TC5-WA-007', 'whatsapp', 'retry increments retry_count', true, waRows2.length >= 2 && waRows2[waRows2.length - 1].retry_count === 1, JSON.stringify(waRows2.map((x) => x.retry_count)));
  }

  // ---------- AUTO-SEND SETTING ----------
  r = await admin.post('/api/settings', { whatsapp_auto_send: 'bogus' });
  check('TC5-WA-010', 'whatsapp', 'invalid auto-send value rejected', 400, r.status);
  r = await admin.post('/api/settings', { whatsapp_auto_send: '1' });
  check('TC5-WA-011', 'whatsapp', 'auto-send setting saved', '1', r.json?.settings?.whatsapp_auto_send);
  if (item) {
    await admin.post('/add_to_cart', { code: item.code, quantity: 1 });
    // send_whatsapp NOT passed - auto-send should still attempt delivery
    r = await admin.post('/api/sale', { payment_method: 'Cash', paid: '9999', customer_phone: '9876500003' });
    const inv2 = r.json?.invoice;
    check('TC5-WA-012', 'whatsapp', 'auto-send triggers without checkbox', true, (r.json?.whatsapp?.provider === 'simulated' || r.json?.whatsapp?.provider === 'twilio'), JSON.stringify(r.json?.whatsapp));
    const d3 = await H.db();
    const autoRow = H.rows(d3, 'SELECT * FROM whatsapp_log WHERE invoice_id = ?', [inv2.id]);
    check('TC5-WA-013', 'whatsapp', 'auto-send attempt recorded', true, autoRow.length > 0);

    // Missing phone: sale completes, nothing attempted
    await admin.post('/add_to_cart', { code: item.code, quantity: 1 });
    r = await admin.post('/api/sale', { payment_method: 'Cash', paid: '9999' });
    check('TC5-WA-014', 'whatsapp', 'auto-send without customer number never blocks billing', true, r.json?.ok === true && r.json?.whatsapp?.provider === 'none', JSON.stringify(r.json?.whatsapp));
  }
  await admin.post('/api/settings', { whatsapp_auto_send: '0' });

  // ---------- BILL TEXT FORMAT (unit-level) ----------
  try {
    const { formatBillText } = require('../lib/whatsapp');
    const fakeInv = {
      invoice_no: 'INV-TEST-1', created_at: '2026-09-14T13:00:00.000Z', party_name: 'QA Customer',
      party_phone: '+919876543210', subtotal: 100, discount: 5, tax: 4.5, total: 99.5, paid: 99.5,
      payment_method: 'UPI', items: [{ name: 'Milk 1L', quantity: 2, price: 50, line_total: 100 }]
    };
    const text = formatBillText(fakeInv);
    check('TC5-WA-020', 'whatsapp', 'bill text has shop/invoice/customer/totals', true,
      /🧾/.test(text) && text.includes('INV-TEST-1') && text.includes('QA Customer') && text.includes('₹99.50') && /Payment: UPI/.test(text), text.slice(0, 120));
    const big = { ...fakeInv, items: Array.from({ length: 40 }, (_, i) => ({ name: `Item ${i}`, quantity: 1, price: 10, line_total: 10 })) };
    const bigText = formatBillText(big);
    check('TC5-WA-021', 'whatsapp', 'huge bill is summarized within WhatsApp limits', true,
      bigText.length <= 1500 && bigText.includes('Items: 40') && bigText.includes('INV-TEST-1'), `len=${bigText.length}`);
  } catch (e) {
    record('TC5-WA-020', 'whatsapp', 'bill text unit checks', 'formatted', e.message, 'fail');
  }

  // ---------- SECRET MASKING ----------
  r = await admin.post('/api/settings', { twilio_whatsapp_from: '+14155238886' });
  r = await admin.get('/api/whatsapp/status');
  check('TC5-SEC-001', 'security', 'sender shown masked, never in full', '+1415***886', r.json?.whatsapp?.sender_masked, JSON.stringify(r.json?.whatsapp));
  check('TC5-SEC-002', 'security', 'status never leaks full sender', false, JSON.stringify(r.json).includes('+14155238886'));
  await admin.post('/api/settings', { twilio_disconnect: '1' });

  // ---------- LOCAL BACKUP ----------
  r = await admin.post('/api/backups/local', {});
  check('TC5-BK-001', 'backup', 'manual local backup created', true, r.json?.ok === true && /MartPOS-backup-.*\.db/.test(r.json?.file?.name || ''), r.text.slice(0, 200));
  const backupName = r.json?.file?.name;

  r = await admin.get('/api/backups/local');
  check('TC5-BK-002', 'backup', 'local backup listed with size/date', true,
    (r.json?.backups || []).some((b) => b.name === backupName && b.size > 0), r.text.slice(0, 200));

  // Backup file actually on disk and openable
  const onDisk = backupName && fs.existsSync(path.join(BKU, backupName));
  check('TC5-BK-003', 'backup', 'backup file exists on disk', true, onDisk === true, BKU);

  r = await admin.get('/api/backups/history');
  check('TC5-BK-004', 'backup', 'history records the backup', true,
    (r.json?.history || []).some((h) => h.name === backupName && h.location === 'local' && h.status === 'success'),
    r.text.slice(0, 300));

  // ---------- SAFE RESTORE (local) ----------
  r = await admin.post('/api/backup/prepare', { source: 'local', name: backupName });
  check('TC5-RS-001', 'restore', 'prepare validates + returns details', true,
    r.json?.ok === true && r.json?.details?.ok === true && r.json?.details?.size > 0, r.text.slice(0, 250));

  r = await admin.post('/api/backup/prepare', { source: 'local', name: '../pos.db' });
  check('TC5-RS-002', 'restore', 'path traversal rejected', 400, r.status);
  r = await admin.post('/api/backup/prepare', { source: 'local', name: 'MartPOS-backup-1900-01-01-000000.db' });
  check('TC5-RS-003', 'restore', 'missing backup -> 404', 404, r.status);

  // Corrupt backup must be rejected and must not touch the live db
  fs.mkdirSync(BKU, { recursive: true });
  fs.writeFileSync(path.join(BKU, 'MartPOS-backup-1999-01-01-000000.db'), 'not a database at all');
  const before = (await admin.get('/api/invoices')).json?.invoices?.length;
  r = await admin.post('/api/backup/prepare', { source: 'local', name: 'MartPOS-backup-1999-01-01-000000.db' });
  check('TC5-RS-004', 'restore', 'corrupt backup rejected at validation', 400, r.status, r.text.slice(0, 200));
  r = await admin.post('/api/backup/restore', { source: 'local', name: 'MartPOS-backup-1999-01-01-000000.db' });
  check('TC5-RS-005', 'restore', 'corrupt backup cannot be applied', 400, r.status);
  const afterBad = (await admin.get('/api/invoices')).json?.invoices?.length;
  check('TC5-RS-006', 'restore', 'live database intact after failed restore', before, afterBad);

  // Real restore: safety backup taken, session dropped
  r = await admin.post('/api/backup/restore', { source: 'local', name: backupName });
  check('TC5-RS-007', 'restore', 'restore succeeds', true, r.json?.ok === true && !!r.json?.safety_backup, r.text.slice(0, 250));
  const me = await admin.get('/api/me');
  check('TC5-RS-008', 'restore', 'session dropped after restore (re-login)', true, me.json?.user === null);
  r = await admin.login('admin', 'admin');
  check('TC5-RS-010', 'restore', 're-login works after restore', true, r.json?.ok === true);
  r = await admin.get('/api/backups/local');
  check('TC5-RS-009', 'restore', 'pre-restore safety backup exists', true,
    (r.json?.backups || []).some((b) => b.kind === 'pre-restore'), r.text.slice(0, 300));

  // ---------- DRIVE ----------
  r = await admin.post('/api/drive/test', {});
  check('TC5-DRV-001', 'drive', 'drive test without connection -> friendly 400', true,
    r.status === 400 && /connect/i.test(r.json?.error || ''), r.text.slice(0, 200));
  r = await admin.post('/api/backup/prepare', { source: 'drive', file_id: 'x' });
  check('TC5-DRV-002', 'drive', 'drive prepare without connection -> friendly 400', true,
    r.status === 400 && /connect/i.test(r.json?.error || ''), r.text.slice(0, 200));

  // ---------- HEALTH ----------
  r = await admin.get('/api/health');
  const checks = r.json?.health?.checks || [];
  check('TC5-HEALTH-001', 'health', 'health report present', true, checks.length >= 5, JSON.stringify(checks.map((c) => c.name)));
  const requiredFailed = checks.filter((c) => !c.ok && !/configured|connected/.test(c.name));
  check('TC5-HEALTH-002', 'health', 'all required health checks pass', 0, requiredFailed.length, JSON.stringify(requiredFailed));
  check('TC5-HEALTH-003', 'health', 'about exposes app + schema version', true, !!r.json?.about?.version && r.json?.about?.schema_version >= 1, JSON.stringify(r.json?.about));

  // ---------- ROLE GATING ----------
  r = await cashier.login('TEST-CASHIER', 'Test@123');
  if (r.json?.ok !== true) {
    await admin.post('/api/users', { username: 'TEST-CASHIER', password: 'Test@123', role: 'cashier' });
    r = await cashier.login('TEST-CASHIER', 'Test@123');
  }
  r = await cashier.post('/api/backups/local', {});
  check('TC5-ROLE-001', 'auth', 'cashier cannot create backups', 403, r.status);
  r = await cashier.get('/api/backups/history');
  check('TC5-ROLE-002', 'auth', 'cashier cannot read backup history', 403, r.status);
  r = await cashier.post('/api/backup/restore', { source: 'local', name: backupName });
  check('TC5-ROLE-003', 'auth', 'cashier cannot restore', 403, r.status);
  r = await cashier.post('/api/drive/test', {});
  check('TC5-ROLE-004', 'auth', 'cashier cannot test drive connection', 403, r.status);
  r = await cashier.post('/api/whatsapp/test-connection', {});
  check('TC5-ROLE-005', 'auth', 'cashier cannot test whatsapp connection', 403, r.status);
  r = await cashier.get('/api/health');
  check('TC5-ROLE-006', 'auth', 'cashier cannot read health report', 403, r.status);
  r = await cashier.get('/api/me');
  check('TC5-ROLE-007', 'auth', 'cashier /api/me has no credential paths', false,
    JSON.stringify(r.json).includes('credentials_path') || JSON.stringify(r.json).includes('token_path'));

  summary();
})().catch((e) => { console.error('t5 crashed:', e); process.exit(2); });
