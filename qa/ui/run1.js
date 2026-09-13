// run1: auth flows, view sweep at 3 viewports, dead-button sweep
const cdp = require('./cdp');
const fs = require('fs');
const BASE = 'http://localhost:5056';
const out = [];
const log = (...a) => { const s = a.join(' '); console.log(s); out.push(s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function statusText() { return cdp.evaljs(`document.querySelector('.status')?.textContent?.trim() || ''`); }
async function overflow() {
  return cdp.evaljs(`JSON.stringify({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight})`).then(JSON.parse);
}

async function login(u, p) {
  await cdp.evaljs(`document.querySelector('[name=username]').value = ${JSON.stringify(u)}; document.querySelector('[name=password]').value = ${JSON.stringify(p)}; void 0`);
  await cdp.evaljs(`document.getElementById('loginForm').requestSubmit(); void 0`);
  await sleep(1200);
}

(async () => {
  const proc = await cdp.launch();
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
  cdp.onEvent(async d => {
    if (d.method === 'Page.javascriptDialogOpening') {
      log('DIALOG:', d.params.type, d.params.message);
      cdp.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    }
  });

  await cdp.setViewport(1366, 768);
  await cdp.goto(BASE + '/');
  await sleep(1200);
  await cdp.shot('login-page');

  // --- empty fields submit
  await cdp.evaljs(`document.querySelector('[name=username]').value=''; document.querySelector('[name=password]').value=''; document.getElementById('loginForm').requestSubmit(); void 0`);
  await sleep(600);
  log('LOGIN-EMPTY status=', await statusText(), '| still on login:', await cdp.evaljs(`!!document.getElementById('loginForm')`));

  // --- wrong password
  await cdp.goto(BASE + '/'); await sleep(500);
  await login('admin', 'wrongpass');
  log('LOGIN-WRONG status=', await statusText());

  // --- correct login
  await login('admin', 'admin');
  await sleep(800);
  log('LOGIN-OK view=', await cdp.evaljs(`state.view`), 'user=', await cdp.evaljs(`state.user && state.user.username`));
  await cdp.shot('after-login');

  // --- reload persistence
  await cdp.goto(BASE + '/'); await sleep(1500);
  log('RELOAD still-logged-in:', await cdp.evaljs(`!!state.user`), 'view=', await cdp.evaljs(`state.view`));

  // --- logout then Back
  await cdp.evaljs(`document.getElementById('logoutBtn').click(); void 0`);
  await sleep(1000);
  log('LOGOUT shows login form:', await cdp.evaljs(`!!document.getElementById('loginForm')`));
  await cdp.evaljs(`history.back(); void 0`).catch(() => {});
  await sleep(1500);
  const protectedShown = await cdp.evaljs(`typeof state!=='undefined' && !!state.user && !!document.querySelector('.sidebar')`).catch(() => 'eval-failed');
  log('BACK-AFTER-LOGOUT protected content shown:', protectedShown, '| login form:', await cdp.evaljs(`!!document.getElementById('loginForm')`));
  await cdp.shot('back-after-logout');

  // re-login for sweep
  await cdp.goto(BASE + '/'); await sleep(800);
  if (await cdp.evaljs(`!!document.getElementById('loginForm')`)) { await login('admin', 'admin'); await sleep(800); }

  const views = ['dashboard', 'pos', 'items', 'parties', 'sales', 'purchases', 'expenses', 'reports', 'settings'];
  for (const vp of [[1366, 768], [1920, 1080], [1024, 768]]) {
    await cdp.setViewport(...vp);
    for (const v of views) {
      cdp.resetNet();
      await cdp.evaljs(`switchView('${v}'); void 0`);
      await sleep(1100);
      const ov = await overflow();
      const shotName = `v${vp[0]}-${v}`;
      await cdp.shot(shotName);
      log(`VIEW ${v} @${vp[0]}x${vp[1]} overflowX=${ov.sw > ov.cw} sw=${ov.sw} cw=${ov.cw} consoleErr=${cdp.consoleErrors.length} failedReq=${cdp.failedReqs.length} badResp=${JSON.stringify(cdp.badResponses)}`);
      if (cdp.consoleErrors.length) log('   console:', JSON.stringify(cdp.consoleErrors.slice(0, 5)));
    }
  }

  // ---- button sweep at 1366
  await cdp.setViewport(1366, 768);
  const SKIP = new Set(['logoutBtn', 'payBtn', 'printBtn', 'drvConnect', 'drvBackup', 'drvList', 'drvOff', 'rcTestPrint', 'sidebarToggle', 'newPosTab']);
  for (const v of views) {
    await cdp.evaljs(`switchView('${v}'); void 0`);
    await sleep(1000);
    // close any open modal first
    await cdp.evaljs(`document.getElementById('closeModal')?.click(); void 0`);
    const btns = await cdp.evaljs(`JSON.stringify([...document.querySelectorAll('#view button, .topbar button')].filter(b=>b.offsetParent!==null).map((b,i)=>{b.dataset.qaid=i;return {qaid:i, id:b.id, txt:(b.textContent||'').trim().slice(0,40), del:b.dataset.del||'', delu:b.dataset.delu||'', pay:b.dataset.pay||''}}))`);
    const list = JSON.parse(btns || '[]');
    log(`SWEEP ${v}: ${list.length} visible buttons`);
    for (const b of list) {
      if (SKIP.has(b.id)) continue;
      if (b.delu === '1') continue; // don't delete admin
      cdp.resetNet();
      const before = await statusText();
      const clicked = await cdp.evaljs(`(()=>{const b=document.querySelector('[data-qaid="${b.qaid}"]');if(!b)return 'gone';b.click();return 'ok'})()`);
      await sleep(500);
      const after = await statusText();
      const modal = await cdp.evaljs(`!!document.querySelector('.modal, [class*=modal]') && !!document.getElementById('closeModal')`);
      let note = '';
      if (modal) { note = 'opens-modal'; await cdp.evaljs(`document.getElementById('closeModal')?.click(); void 0`); await sleep(200); }
      const errs = cdp.consoleErrors.length ? ` consoleErr=${JSON.stringify(cdp.consoleErrors.slice(0,2))}` : '';
      const bad = cdp.badResponses.length ? ` badResp=${JSON.stringify(cdp.badResponses.slice(0,2))}` : '';
      if (clicked !== 'ok') note += ' gone-before-click';
      log(`  BTN [${b.id || b.txt || b.del || b.pay}] clicked=${clicked} status:'${before}'->'${after}' ${note}${errs}${bad}`);
    }
  }

  fs.writeFileSync(__dirname + '/out1.txt', out.join('\n'));
  proc.kill(); process.exit(0);
})().catch(e => { console.error('FATAL', e); fs.writeFileSync(__dirname + '/out1.txt', out.join('\n')); process.exit(1); });
