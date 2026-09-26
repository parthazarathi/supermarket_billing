// Multi-resolution visual QA harness for the MartPOS UI.
// Drives the running dev server in headless Chromium, logs in, visits every
// view (plus key modals / POS states) at each resolution, screenshots them and
// records layout diagnostics: horizontal document overflow, elements that
// overflow their scroll container horizontally, elements clipped past the
// viewport, and console/page errors.
//
// Usage:
//   node qa/ui_shots.js [--base http://127.0.0.1:5077] [--user admin] [--pass admin]
//                       [--res 1280x720,1920x1080] [--views pos,dashboard] [--theme light|dark]
//                       [--out qa/shots/ui]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg('base', process.env.QA_BASE || 'http://127.0.0.1:5077');
const USER = arg('user', 'admin');
const PASS = arg('pass', process.env.QA_PASS || 'admin');
const THEME = arg('theme', 'light');
const OUT = path.resolve(arg('out', path.join(__dirname, 'shots', 'ui')));
const RES = arg('res', '1280x720,1366x768,1440x900,1536x864,1600x900,1920x1080,2560x1440,3840x2160')
  .split(',').map((s) => s.split('x').map(Number));
const ALL_VIEWS = ['login', 'pos', 'pos-cart', 'dashboard', 'items', 'items-form', 'parties', 'sales', 'sales-edit', 'purchases', 'new-purchase', 'expenses', 'reports', 'reports-table', 'settings', 'settings-backup', 'ai'];
const VIEWS = arg('views', ALL_VIEWS.join(',')).split(',');

// Runs inside the page: find layout problems.
function diagnostics() {
  const out = { docOverflowX: 0, overflowers: [], offscreen: [], tinyTargets: 0 };
  const de = document.documentElement;
  out.docOverflowX = Math.max(0, de.scrollWidth - window.innerWidth);
  const vw = window.innerWidth;
  const seen = new Set();
  const desc = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // horizontal content overflow where the element itself does not scroll
    if (el.scrollWidth > el.clientWidth + 2 && !/auto|scroll/.test(cs.overflowX) && cs.overflow !== 'hidden' && cs.overflowX !== 'hidden') {
      const key = desc(el);
      if (!seen.has(key) && out.overflowers.length < 25) { seen.add(key); out.overflowers.push(`${key} (${el.clientWidth}<${el.scrollWidth})`); }
    }
    // element extends past the right edge of the viewport
    if (r.right > vw + 2 && r.left < vw && cs.position !== 'fixed') {
      const key = desc(el);
      if (!seen.has('off:' + key) && out.offscreen.length < 25) { seen.add('off:' + key); out.offscreen.push(`${key} right=${Math.round(r.right)} vw=${vw}`); }
    }
    if ((el.tagName === 'BUTTON' || el.tagName === 'A') && r.width > 0 && (r.width < 24 || r.height < 24)) out.tinyTargets++;
  }
  return out;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const report = [];
  const errors = [];
  for (const [W, H] of RES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${W}x${H}] ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[${W}x${H}] pageerror ${e}`));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate((t) => { localStorage.setItem('martpos-theme', t); localStorage.setItem('sidebarCollapsed', 'false'); }, THEME);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#username, .shell', { timeout: 20000 });

    const shot = async (name) => {
      const file = path.join(OUT, `${THEME}-${W}x${H}-${name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      const d = await page.evaluate(diagnostics);
      report.push({ res: `${W}x${H}`, view: name, ...d });
      const flags = [];
      if (d.docOverflowX) flags.push(`DOC-OVERFLOW-X ${d.docOverflowX}px`);
      if (d.overflowers.length) flags.push(`overflow: ${d.overflowers.join(' | ')}`);
      if (d.offscreen.length) flags.push(`offscreen: ${d.offscreen.join(' | ')}`);
      console.log(`${W}x${H} ${name.padEnd(16)} ${flags.length ? flags.join('  ') : 'ok'}`);
    };

    if (VIEWS.includes('login') && await page.$('#username')) await shot('login');
    if (await page.$('#username')) {
      await page.fill('#username', USER);
      await page.fill('#password', PASS);
      await page.click('button[type=submit]');
      await page.waitForSelector('.shell', { timeout: 15000 });
      await page.waitForTimeout(800);
    }
    // Close any status/modals from login
    await page.keyboard.press('Escape');

    const nav = async (view) => {
      await page.click(`.nav-btn[data-view="${view}"]`);
      await page.waitForTimeout(1200);
    };
    const closeModal = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(300); };

    for (const v of VIEWS) {
      if (v === 'login') continue;
      try {
        if (v === 'pos') { await nav('pos'); await shot('pos'); }
        else if (v === 'pos-cart') {
          await nav('pos');
          // add a few products via the search box
          for (const q of ['a', 'e', 'i']) {
            await page.fill('#productSearch', q);
            await page.waitForTimeout(400);
            const sug = await page.$('.search-suggestion[data-code]');
            if (sug) { await sug.click(); await page.waitForTimeout(700); }
          }
          await page.click('.payment-method[data-pay="UPI"]').catch(() => {});
          await page.waitForTimeout(500);
          await shot('pos-cart');
          await page.click('#clearCartBtn').catch(() => {});
          await page.waitForTimeout(500);
        }
        else if (v === 'items-form') { await nav('items'); await page.click('#newItem'); await page.waitForTimeout(400); await shot('items-form'); await closeModal(); }
        else if (v === 'sales-edit') {
          await nav('sales');
          const menu = await page.$('[data-menu]');
          if (menu) {
            await menu.click(); await page.waitForTimeout(300);
            await shot('sales-menu');
            const view = await page.$('.row-menu.open [data-act="view"]');
            if (view) { await view.click(); await page.waitForTimeout(800); await shot('sales-view'); await closeModal(); }
          }
        }
        else if (v === 'new-purchase') { await nav('purchases'); await page.click('#newPurchase'); await page.waitForTimeout(600); await shot('new-purchase'); }
        else if (v === 'reports-table') {
          await nav('reports');
          const tab = await page.$('.rpt-nav-btn[data-cat="sales"]');
          if (tab) { await tab.click(); await page.waitForTimeout(800); }
          const t2 = await page.$('.rpt-tab[data-rpt="sales/bill-wise"]');
          if (t2) { await t2.click(); await page.waitForTimeout(900); }
          const chip = await page.$('[data-preset="this_year"]');
          if (chip) { await chip.click(); await page.waitForTimeout(1200); }
          await shot('reports-table');
        }
        else if (v === 'settings-backup') {
          await nav('settings');
          const b = await page.$('#backupList');
          if (b) { await b.click(); await page.waitForTimeout(900); await shot('settings-backup'); await closeModal(); }
        }
        else { await nav(v); await shot(v); }
      } catch (e) {
        console.log(`${W}x${H} ${v}: SKIP ${String(e.message).split('\n')[0]}`);
      }
    }
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, `${THEME}-report.json`), JSON.stringify({ report, errors }, null, 2));
  if (errors.length) {
    console.log(`\nCONSOLE/PAGE ERRORS (${errors.length}):`);
    [...new Set(errors)].slice(0, 30).forEach((e) => console.log('  -', e));
  } else {
    console.log('\nno console/page errors');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
