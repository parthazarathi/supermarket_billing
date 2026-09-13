// run4: follow-ups — reports custom range, per-report sweep, partial invoice receipt, cashier settings content
const cdp = require('./cdp');
const fs = require('fs');
const BASE = 'http://localhost:5056';
const out = [];
const log = (...a) => { const s = a.join(' '); console.log(s); out.push(s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const statusText = () => cdp.evaljs(`document.querySelector('.status')?.textContent?.trim() || ''`);

async function login(u, p) {
  if (await cdp.evaljs(`!!document.getElementById('loginForm')`)) {
    await cdp.evaljs(`document.querySelector('[name=username]').value=${JSON.stringify(u)};document.querySelector('[name=password]').value=${JSON.stringify(p)};document.getElementById('loginForm').requestSubmit();void 0`);
    await sleep(1500);
  }
}

(async () => {
  const proc = await cdp.launch();
  cdp.onEvent(d => {
    if (d.method === 'Page.javascriptDialogOpening')
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });
  await cdp.setViewport(1366, 768);
  await cdp.goto(BASE + '/'); await sleep(1200);
  await login('admin', 'admin');

  // find the partial invoice INV-...-0011 (paid 50 / total 230)
  const invs = await cdp.evaljs(`api('/api/invoices?per_page=5').then(d=>JSON.stringify(d.invoices.slice(0,5).map(i=>({no:i.invoice_no,total:i.total,paid:i.paid,status:i.status}))))`, true);
  log('RECENT INVOICES:', invs);
  const part = await cdp.evaljs(`api('/api/invoices').then(d=>d.invoices.find(i=>i.invoice_no==='INV-20260913-0011')||d.invoices[0]).then(i=>api('/api/invoices/'+i.id)).then(d=>JSON.stringify(d.invoice))`, true);
  const pinv = JSON.parse(part);
  log('PARTIAL INV:', pinv.invoice_no, 'total', pinv.total, 'paid', pinv.paid, 'status', pinv.status);
  const rhtml = await cdp.evaljs(`ReceiptPrinter.buildHtml(${part}, ReceiptPrinter.config(), state.settings)`);
  log('RECEIPT(partial) Due line:', /Balance Due/.test(rhtml), 'Change line:', /Change/.test(rhtml), '| snippet:', rhtml.match(/Paid \([^<]*<[^>]*>[^<]*/)?.[0]);
  fs.writeFileSync(__dirname + '/receipt-partial.html', rhtml);

  // ===== reports custom range =====
  await cdp.evaljs(`switchView('reports'); void 0`); await sleep(1400);
  // choose a dated report first: sales summary via data-rpt
  await cdp.evaljs(`document.querySelector('[data-cat="sales"]')?.click(); void 0`); await sleep(1000);
  log('sales cat first report chips:', await cdp.evaljs(`JSON.stringify([...document.querySelectorAll('[data-rpt]')].map(b=>b.dataset.rpt))`));
  // click custom preset
  await cdp.evaljs(`document.querySelector('[data-preset="custom"]')?.click(); void 0`); await sleep(800);
  log('custom preset: rptShow exists:', await cdp.evaljs(`!!document.getElementById('rptShow')`), 'date fields visible:', await cdp.evaljs(`document.querySelector('.rpt-date-fields')?.style.display!=='none'`));
  await cdp.shot('reports-custom-range');
  // valid range
  await cdp.evaljs(`(()=>{const f=document.getElementById('rptFrom'),t=document.getElementById('rptTo');f.value='2026-09-01';f.dispatchEvent(new Event('change',{bubbles:true}));t.value='2026-09-13';t.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
  cdp.resetNet();
  await cdp.evaljs(`document.getElementById('rptShow')?.click(); void 0`); await sleep(1200);
  log('RPT custom valid: status=', await statusText(), 'bad=', JSON.stringify(cdp.badResponses), 'rows=', await cdp.evaljs(`document.querySelectorAll('#rptContent tbody tr').length`));
  // From > To
  await cdp.evaljs(`(()=>{const f=document.getElementById('rptFrom'),t=document.getElementById('rptTo');f.value='2026-09-13';f.dispatchEvent(new Event('change',{bubbles:true}));t.value='2026-09-01';t.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
  await cdp.evaljs(`document.getElementById('rptShow')?.click(); void 0`); await sleep(800);
  log('RPT from>to: status=', await statusText());
  // only From filled (clear To)
  await cdp.evaljs(`(()=>{const t=document.getElementById('rptTo');t.value='';t.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
  await cdp.evaljs(`document.getElementById('rptShow')?.click(); void 0`); await sleep(600);
  log('RPT only-from: status=', await statusText());

  // ===== every report chip across categories =====
  const cats = JSON.parse(await cdp.evaljs(`JSON.stringify([...document.querySelectorAll('[data-cat]')].map(b=>b.dataset.cat))`));
  for (const cat of cats) {
    await cdp.evaljs(`document.querySelector('[data-cat="${cat}"]')?.click(); void 0`); await sleep(900);
    const keys = JSON.parse(await cdp.evaljs(`JSON.stringify([...document.querySelectorAll('[data-rpt]')].map(b=>b.dataset.rpt))`));
    for (const k of keys) {
      cdp.resetNet();
      await cdp.evaljs(`document.querySelector('[data-rpt="${k}"]')?.click(); void 0`); await sleep(900);
      const st = await statusText();
      const empty = await cdp.evaljs(`(document.querySelector('#rptContent .rpt-empty')?.textContent||'').trim().slice(0,80)`);
      const rows = await cdp.evaljs(`document.querySelectorAll('#rptContent tbody tr').length`);
      const flags = [];
      if (cdp.badResponses.length) flags.push('bad=' + JSON.stringify(cdp.badResponses.slice(0, 2)));
      if (cdp.consoleErrors.length) flags.push('console=' + JSON.stringify(cdp.consoleErrors.slice(0, 2)));
      if (st && !/Report exported|Settings saved/.test(st)) flags.push('status=' + st);
      log(`RPT ${cat}/${k}: rows=${rows}${empty ? ' empty="' + empty + '"' : ''} ${flags.join(' ')}`);
    }
  }

  fs.writeFileSync(__dirname + '/out4.txt', out.join('\n'));
  proc.kill(); process.exit(0);
})().catch(e => { console.error('FATAL', e); fs.writeFileSync(__dirname + '/out4.txt', out.join('\n')); process.exit(1); });
