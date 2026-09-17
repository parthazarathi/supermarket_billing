// Modal + small-viewport audit
const { _electron } = require('playwright');
const fs = require('fs');
const path = require('path');

const ELECTRON = path.resolve(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const APP_DIR = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'shots', 'redesign');

async function main() {
  const theme = process.argv[2] || 'light';
  const w = parseInt(process.argv[3] || '1600', 10);
  const h = parseInt(process.argv[4] || '900', 10);
  fs.mkdirSync(OUT, { recursive: true });

  const env = { ...process.env, MARTPOS_DATA_DIR: path.join(__dirname, 'data-redesign') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: ELECTRON, args: [APP_DIR], env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: w, height: h });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.waitForSelector('#username, .shell', { timeout: 30000 });
  await page.evaluate((t) => {
    localStorage.setItem('martpos-theme', t);
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.themePref = t;
  }, theme);

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

  const tag = `${theme}-${w}x${h}`;
  const nav = async (v) => { await page.click(`[data-view="${v}"]`); await page.waitForTimeout(1300); };

  // 1) Item form modal
  await nav('items');
  await page.click('#newItem');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, `${tag}-modal-item.png`) });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 2) Row action menu
  const menuBtn = await page.$('[data-menu]');
  if (menuBtn) {
    await menuBtn.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `${tag}-rowmenu.png`) });
    await page.keyboard.press('Escape');
  }

  // 3) POS at this viewport
  await nav('pos');
  await page.screenshot({ path: path.join(OUT, `${tag}-pos.png`) });

  // 4) Settings Appearance section
  await nav('settings');
  const appBtn = await page.$('[data-sec="appearance"]');
  if (appBtn) {
    await appBtn.click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `${tag}-appearance.png`) });
  }

  if (errors.length) { console.log('CONSOLE ERRORS:'); errors.slice(0, 10).forEach((e) => console.log('  -', e)); }
  else console.log('no console errors');
  await app.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
