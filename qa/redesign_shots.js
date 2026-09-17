// Visual audit helper - drives the redesigned UI inside the real Electron
// shell via Playwright's Electron support.
// Usage: node qa/redesign_shots.js [theme] [views...]
const { _electron } = require('playwright');
const fs = require('fs');
const path = require('path');

const ELECTRON = path.resolve(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const APP_DIR = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'shots', 'redesign');
const W = parseInt(process.env.SHOT_W || '1600', 10);
const H = parseInt(process.env.SHOT_H || '900', 10);

async function main() {
  const theme = process.argv[2] || 'light';
  const views = process.argv.slice(3);
  const wanted = views.length ? views : ['pos', 'dashboard', 'items', 'parties', 'sales', 'purchases', 'expenses', 'reports', 'settings', 'ai'];
  fs.mkdirSync(OUT, { recursive: true });

  const env = { ...process.env, MARTPOS_DATA_DIR: path.join(__dirname, 'data-redesign') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [APP_DIR],
    env,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: W, height: H });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.waitForSelector('#username, .shell', { timeout: 30000 });
  await page.evaluate((t) => {
    localStorage.setItem('martpos-theme', t);
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.themePref = t;
  }, theme);

  if (wanted.includes('login')) {
    await page.screenshot({ path: path.join(OUT, `${theme}-login.png`) });
    console.log(`shot ${theme}-login`);
  }

  // login - try the common dev passwords
  let ok = false;
  for (const pw of ['admin', 'admin123', 'password', '1234', 'admin@123']) {
    if (await page.$('#username')) {
      await page.fill('#username', 'admin');
      await page.fill('#password', pw);
      await page.click('button[type=submit]');
      await page.waitForTimeout(1800);
    }
    if (await page.$('.shell')) { ok = true; break; }
  }
  if (!ok) {
    console.log('LOGIN FAILED');
    await page.screenshot({ path: path.join(OUT, `${theme}-loginfail.png`) });
    await app.close();
    return;
  }

  const nav = async (view) => {
    await page.click(`[data-view="${view}"]`);
    await page.waitForTimeout(1500);
  };

  for (const v of wanted) {
    if (v === 'login') continue;
    try {
      await nav(v);
      await page.screenshot({ path: path.join(OUT, `${theme}-${v}.png`) });
      console.log(`shot ${theme}-${v}`);
    } catch (e) {
      console.log(`skip ${v}: ${e.message.split('\n')[0]}`);
    }
  }

  // POS interaction shot: search + add a product to the bill
  if (wanted.includes('pos')) {
    try {
      await nav('pos');
      await page.fill('#productSearch', 'a');
      await page.waitForTimeout(600);
      const sug = await page.$('.search-suggestion[data-code]');
      if (sug) {
        await sug.click();
        await page.waitForTimeout(900);
        await page.screenshot({ path: path.join(OUT, `${theme}-pos-bill.png`) });
        console.log(`shot ${theme}-pos-bill`);
      }
    } catch (e) { console.log('pos-bill skip:', e.message.split('\n')[0]); }
  }

  if (errors.length) {
    console.log('CONSOLE ERRORS:');
    errors.slice(0, 20).forEach((e) => console.log('  -', e));
  } else {
    console.log('no console errors');
  }
  await app.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
