// Functional check: run a complete POS sale through the redesigned UI.
const { _electron } = require('playwright');
const fs = require('fs');
const path = require('path');

const ELECTRON = path.resolve(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const APP_DIR = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'shots', 'redesign');

async function main() {
  const env = { ...process.env, MARTPOS_DATA_DIR: path.join(__dirname, 'data-redesign') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: ELECTRON, args: [APP_DIR], env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.waitForSelector('#username, .shell', { timeout: 30000 });
  let ok = false;
  for (const pw of ['admin', 'admin123', 'password', '1234']) {
    if (await page.$('#username')) {
      await page.fill('#username', 'admin');
      await page.fill('#password', pw);
      await page.click('button[type=submit]');
      await page.waitForTimeout(1600);
    }
    if (await page.$('.shell')) { ok = true; break; }
  }
  if (!ok) { console.log('LOGIN FAILED'); await app.close(); return; }

  await page.click('[data-view="pos"]');
  await page.waitForTimeout(1400);

  // add a product via suggestion
  await page.fill('#productSearch', 'amul');
  await page.waitForTimeout(600);
  const sug = await page.$('.search-suggestion[data-code]');
  if (sug) await sug.click();
  await page.waitForTimeout(800);

  // bump qty via + button
  const plus = await page.$('.qty-btn[data-inc]');
  if (plus) { await plus.click(); await page.waitForTimeout(500); }

  // set cash received
  const total = await page.$eval('.grand-total span:last-child', (el) => el.textContent.trim());
  console.log('grand total:', total);
  await page.fill('#paidInput', '500');
  await page.waitForTimeout(400);

  // complete sale
  await page.click('#payBtn');
  await page.waitForTimeout(1500);
  const status = await page.$eval('.status', (el) => el.textContent).catch(() => '');
  console.log('status after pay:', status);
  const cartEmpty = await page.$eval('.items-table tbody', (el) => el.textContent.includes('Scan or search'));
  console.log('cart cleared after sale:', cartEmpty);
  await page.screenshot({ path: path.join(OUT, 'light-sale-done.png') });

  // verify invoice landed in Sales
  await page.click('[data-view="sales"]');
  await page.waitForTimeout(1400);
  const firstInvoice = await page.$eval('.sales-list tbody tr td', (el) => el.textContent.trim()).catch(() => 'none');
  console.log('latest invoice:', firstInvoice);

  // expenses view
  await page.click('[data-view="expenses"]');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, 'light-expenses.png') });

  // new purchase entry
  await page.click('[data-view="purchases"]');
  await page.waitForTimeout(1200);
  const np = await page.$('#newPurchase');
  if (np) { await np.click(); await page.waitForTimeout(1400); await page.screenshot({ path: path.join(OUT, 'light-new-purchase.png') }); }

  // theme toggle roundtrip
  await page.click('#themeToggle');
  await page.waitForTimeout(600);
  const th = await page.evaluate(() => document.documentElement.dataset.theme);
  console.log('theme after toggle:', th);
  await page.click('#themeToggle');
  await page.waitForTimeout(400);

  if (errors.length) { console.log('CONSOLE ERRORS:'); errors.slice(0, 10).forEach((e) => console.log('  -', e)); }
  else console.log('no console errors');
  await app.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
