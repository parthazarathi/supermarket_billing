const H = require('./harness');
const { Client } = H;
(async () => {
  const c = new Client('perf'); await c.login('admin', 'admin');
  const today = new Date(); const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const from = new Date(today); from.setDate(from.getDate() - 59);
  const rng = `from=${ymd(from)}&to=${ymd(today)}`;
  const targets = [
    ['dashboard (60d)', `/api/dashboard?${rng}`], ['dashboard (today)', '/api/dashboard'],
    ['items list (POS load)', '/api/items'], ['items search', '/api/items?q=PERF Item 5'],
    ['parties list (outstanding per party)', '/api/parties'], ['invoices list', '/api/invoices'],
    ['sales summary 60d', `/api/reports/sales/summary?${rng}`], ['bill-wise 60d p1', `/api/reports/sales/bill-wise?${rng}`],
    ['item-wise 60d', `/api/reports/sales/item-wise?${rng}`], ['P&L 60d', `/api/reports/profit-loss/summary?${rng}`],
    ['day-wise profit 60d', `/api/reports/profit-loss/day-wise?${rng}`], ['current stock', '/api/reports/inventory/current-stock'],
    ['stock movement 60d', `/api/reports/inventory/movement?${rng}`], ['valuation', '/api/reports/inventory/valuation'],
    ['customer outstanding', '/api/reports/customers/outstanding'], ['customer summary 60d', `/api/reports/customers/summary?${rng}`],
    ['supplier summary 60d', `/api/reports/suppliers/summary?${rng}`], ['gst rate-wise 60d', `/api/reports/gst/rate-wise?${rng}`],
    ['audit 60d', `/api/reports/audit?${rng}`], ['dead stock', '/api/reports/inventory/dead-stock'],
  ];
  for (const [name, url] of targets) {
    const times = [];
    let size = 0;
    for (let i = 0; i < 3; i++) { const t = Date.now(); const r = await c.get(url); times.push(Date.now() - t); size = r.text.length; if (r.status !== 200) console.log('  !! status', r.status, r.text.slice(0, 100)); }
    console.log(`${name.padEnd(40)} ${String(Math.min(...times)).padStart(6)} ms (min of 3)  ${String(Math.round(size / 1024)).padStart(6)} KB`);
  }
  // bill save latency
  const times = [];
  for (let i = 0; i < 5; i++) { await c.post('/add_to_cart', { code: 'PERF-1', quantity: 1 }); const t = Date.now(); await c.post('/api/sale', { payment_method: 'Cash' }); times.push(Date.now() - t); }
  console.log(`${'bill save (1 line)'.padEnd(40)} ${String(Math.min(...times)).padStart(6)} ms (min of 5)`);
  const ledgerItem = (await c.get('/api/items?q=PERF-1')).json.items[0];
  let t = Date.now(); let r = await c.get(`/api/reports/inventory/ledger?item_id=${ledgerItem.id}&${rng}`); console.log(`${'stock ledger 60d'.padEnd(40)} ${String(Date.now() - t).padStart(6)} ms  rows=${r.json.report.rows.length}`);
  t = Date.now(); r = await c.get(`/api/reports/sales/bill-wise?${rng}&per_page=100000`); console.log(`${'bill-wise per_page=100000'.padEnd(40)} ${String(Date.now() - t).padStart(6)} ms  ${Math.round(r.text.length / 1024)} KB`);
  console.log('memory (server) not measured here; see process list');
})();
