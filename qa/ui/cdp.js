// Minimal CDP client driving headless Edge via native WebSocket (Node 24).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEBUG_PORT = 9333;
const PROFILE = path.join(__dirname, 'edge-profile');
const SHOTS = path.join(__dirname, 'shots');

let ws, msgId = 0;
const pending = new Map();
const events = [];
const listeners = [];

function onEvent(fn) { listeners.push(fn); }

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await r.json();
      const page = targets.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('no debug target');
}

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function launch() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const proc = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`, '--no-first-run', '--disable-extensions',
    'about:blank'
  ], { stdio: 'ignore' });
  const wsUrl = await connect();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id); pending.delete(d.id);
      d.error ? p.reject(new Error(JSON.stringify(d.error))) : p.resolve(d.result);
    } else if (d.method) {
      events.push(d);
      listeners.forEach(fn => fn(d));
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Log.enable');
  return proc;
}

async function setViewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
}

async function goto(url) {
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 800));
}

async function evaljs(expression, awaitPromise = false) {
  try {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails) };
    return r.result?.value;
  } catch (e) { return { __error: String(e.message || e) }; }
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(SHOTS, name + '.png');
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

// collectors
const consoleErrors = [];
const failedReqs = [];
const badResponses = [];
onEvent(d => {
  if (d.method === 'Runtime.exceptionThrown')
    consoleErrors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error')
    consoleErrors.push(d.params.args?.map(a => a.value ?? a.description).join(' '));
  if (d.method === 'Network.loadingFailed')
    failedReqs.push(d.params.errorText);
  if (d.method === 'Network.responseReceived' && d.params.response.status >= 400)
    badResponses.push(`${d.params.response.status} ${d.params.response.url}`);
});
function resetNet() { consoleErrors.length = 0; failedReqs.length = 0; badResponses.length = 0; }

module.exports = { launch, send, setViewport, goto, evaljs, shot, onEvent, consoleErrors, failedReqs, badResponses, resetNet, SHOTS };

if (require.main === module) {
  (async () => {
    const proc = await launch();
    await setViewport(1366, 768);
    await goto(process.argv[2] || 'http://localhost:5056/');
    await new Promise(r => setTimeout(r, 1500));
    console.log('title:', await evaljs('document.title'));
    await shot('smoke');
    console.log('errors:', consoleErrors, failedReqs, badResponses);
    proc.kill(); process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
