// UI smoke test for the AI Store Manager view + dashboard widget.
// Runs against the live server (BASE) using the headless-Edge CDP harness.
const cdp = require('./cdp');
const BASE = process.env.UI_BASE || 'http://127.0.0.1:5099';
const out = [];
const rec = (id, name, pass, info) => { out.push({ id, name, pass }); console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name} ${info ? '| ' + info : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await cdp.launch();
  await cdp.setViewport(1366, 900);
  await cdp.goto(BASE + '/');
  await sleep(1500);

  // login if needed
  const needLogin = await cdp.evaljs(`!state.user && !!document.querySelector('#username')`);
  if (needLogin) {
    await cdp.evaljs(`document.querySelector('#username').value='admin';document.querySelector('#password').value='admin';document.getElementById('loginForm').requestSubmit();void 0`);
    await sleep(2000);
  }
  rec('UI-AI-LOGIN', 'logged in', (await cdp.evaljs(`state.user && state.user.role`)) === 'admin');

  // nav entry
  const navAi = await cdp.evaljs(`[...document.querySelectorAll('.nav-item, .nav a, nav *')].filter(e=>/AI Manager/i.test(e.textContent)).length`);
  rec('UI-AI-NAV', 'AI Manager nav entry exists', navAi >= 1, `hits=${navAi}`);

  // dashboard widget
  await cdp.evaljs(`switchView('dashboard'); void 0`);
  await sleep(2500);
  const widget = await cdp.evaljs(`!!document.getElementById('aiWidget')`);
  rec('UI-AI-WIDGET', 'dashboard AI widget rendered', widget === true);
  const wstats = await cdp.evaljs(`document.querySelectorAll('#aiWidget .ai-wstat').length`);
  const insight = await cdp.evaljs(`(document.querySelector('#aiWidget .ai-insight p')||{}).textContent || ''`);
  rec('UI-AI-WIDGET-STATS', 'widget shows 4 stats', wstats === 4, `stats=${wstats}`);
  rec('UI-AI-WIDGET-INSIGHT', 'widget has insight text', typeof insight === 'string' && insight.length > 0, insight.slice(0, 60));

  // AI view
  await cdp.evaljs(`switchView('ai'); void 0`);
  await sleep(1500);
  rec('UI-AI-VIEW', 'AI view renders', (await cdp.evaljs(`!!document.querySelector('.ai-wrap')`)) === true);
  rec('UI-AI-HERO', 'hero header present', (await cdp.evaljs(`!!document.querySelector('.ai-hero h3')`)) === true);
  const notice = await cdp.evaljs(`(document.querySelector('.ai-notice')||{}).textContent || ''`);
  rec('UI-AI-NOTICE', 'unconfigured notice shown', /API key|disabled|unavailable/i.test(notice), notice.trim().slice(0, 80));
  const sugs = await cdp.evaljs(`document.querySelectorAll('.ai-sug').length`);
  rec('UI-AI-SUGS', 'suggestion chips present', sugs >= 5, `sugs=${sugs}`);

  // send a question - with no key configured the input is disabled, so also
  // verify the send path fails gracefully rather than freezing.
  const inputDisabled = await cdp.evaljs(`document.getElementById('aiInput').disabled`);
  if (!inputDisabled) {
    await cdp.evaljs(`document.getElementById('aiInput').value='today sales?';document.getElementById('aiForm').requestSubmit();void 0`);
    await sleep(4000);
    const lastMsg = await cdp.evaljs(`[...document.querySelectorAll('.ai-msg')].map(m=>m.textContent).pop() || ''`);
    rec('UI-AI-CHAT', 'chat answered or failed gracefully', /sales|unavailable|configured|error|try/i.test(lastMsg), lastMsg.slice(0, 80));
  } else {
    rec('UI-AI-CHAT', 'input correctly disabled without API key', true);
  }

  // POS still works after AI usage
  await cdp.evaljs(`switchView('pos'); void 0`);
  await sleep(1200);
  rec('UI-AI-POS', 'POS view still renders after AI view', (await cdp.evaljs(`!!document.getElementById('productSearch')`)) === true);

  const errs = cdp.consoleErrors.filter(e => !/favicon|must_change|deprecat/i.test(e));
  rec('UI-AI-CONSOLE', 'no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  await cdp.shot('ai-view');
  const fails = out.filter(r => !r.pass).length;
  console.log(`\n${out.length - fails}/${out.length} UI checks passed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('UI check failed:', e); process.exit(1); });
