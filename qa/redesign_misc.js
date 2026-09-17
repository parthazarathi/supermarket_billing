// Misc checks: qty stepper, collapsed sidebar, held-bill tab.
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
  for (const pw of ['admin', 'admin123', 'password', '1234']) {
    if (await page.$('#username')) {
      await page.fill('#username', 'admin');
      await page.fill('#password', pw);
      await page.click('button[type=submit]');
      await page.waitForTimeout(1600);
    }
    if (await page.$('.shell')) break;
  }
  if (!(await page.$('.shell'))) { console.log('LOGIN FAILED'); await app.close(); return; }

  await page.click('[data-view="pos"]');
  await page.waitForTimeout(1400);
  await page.fill('#productSearch', 'amul');
  await page.waitForTimeout(600);
  const sug = await page.$('.search-suggestion[data-code]');
  if (sug) await sug.click();
  await page.waitForTimeout(800);
  for (let i = 0; i < 2; i++) {
    const plus = await page.$('[data-qty-plus]');
    if (plus) { await plus.click(); await page.waitForTimeout(400); }
  }
  await page.waitForTimeout(400);
  const qty = await page.$eval('[data-qty]', (el) => el.value).catch(() => '?');
  const tot = await page.$eval('.grand-total span:last-child', (el) => el.textContent.trim()).catch(() => '?');
  console.log('qty after 2x + :', qty, '| grand total:', tot);

  // collapse sidebar
  await page.click('#sidebarToggle');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'light-pos-collapsed.png') });
  await page.click('#sidebarToggle');
  await page.waitForTimeout(400);

  // clear cart
  const clr = await page.$('#clearBill');
  if (clr) await clr.click();
  await page.waitForTimeout(600);

  if (errors.length) { console.log('CONSOLE ERRORS:'); errors.slice(0, 10).forEach((e) => console.log('  -', e)); }
  else console.log('no console errors');
  await app.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
