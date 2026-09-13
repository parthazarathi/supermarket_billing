// QA harness: cookie-aware API client + result recorder + direct DB reader.
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const BASE = process.env.QA_BASE || 'http://127.0.0.1:5055';
const DB_PATH = process.env.QA_DB || path.join(__dirname, 'data', 'pos.db');

const results = [];
function record(id, module, title, expected, actual, pass, note = '') {
  results.push({ id, module, title, expected, actual, pass, note });
  const tag = pass === true ? 'PASS' : pass === false ? 'FAIL' : String(pass).toUpperCase();
  console.log(`[${tag}] ${id} ${title}\n       expected: ${fmt(expected)}\n       actual:   ${fmt(actual)}${note ? `\n       note: ${note}` : ''}`);
}
function fmt(v) { return typeof v === 'string' ? v : JSON.stringify(v); }
function check(id, module, title, expected, actual, note) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  record(id, module, title, expected, actual, pass, note);
  return pass;
}
function near(a, b, eps = 0.011) { return Math.abs((+a) - (+b)) <= eps; }
function checkNear(id, module, title, expected, actual, note) {
  const pass = near(expected, actual);
  record(id, module, title, expected, actual, pass, note);
  return pass;
}

class Client {
  constructor(name) { this.name = name; this.cookie = ''; }
  async req(method, url, body, opts = {}) {
    const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
    if (this.cookie) headers.cookie = this.cookie;
    const noBody = method === 'GET' || method === 'HEAD';
    const res = await fetch(BASE + url, { method, headers, body: body === undefined || noBody ? undefined : (opts.raw ? body : JSON.stringify(body)), redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* non-json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  get(url) { return this.req('GET', url); }
  post(url, body) { return this.req('POST', url, body); }
  put(url, body) { return this.req('PUT', url, body); }
  del(url, body) { return this.req('DELETE', url, body); }
  async login(u, p) { const r = await this.post('/api/login', { username: u, password: p }); return r; }
}

let SQL = null;
async function db() {
  if (!SQL) SQL = await initSqlJs();
  await new Promise(r => setTimeout(r, 1800)); // debounced save is 1.5s
  return new SQL.Database(fs.readFileSync(DB_PATH));
}
function rows(d, sql, params = []) {
  const stmt = d.prepare(sql); stmt.bind(params);
  const out = []; while (stmt.step()) out.push(stmt.getAsObject()); stmt.free(); return out;
}
function one(d, sql, params = []) { return rows(d, sql, params)[0] || null; }

function summary() {
  const byMod = {};
  let pass = 0, fail = 0, other = 0;
  for (const r of results) {
    byMod[r.module] = byMod[r.module] || { pass: 0, fail: 0, other: 0 };
    if (r.pass === true) { pass++; byMod[r.module].pass++; }
    else if (r.pass === false) { fail++; byMod[r.module].fail++; }
    else { other++; byMod[r.module].other++; }
  }
  console.log('\n===== SUMMARY =====');
  console.log(`total=${results.length} pass=${pass} fail=${fail} other=${other}`);
  for (const [m, c] of Object.entries(byMod)) console.log(`  ${m}: pass=${c.pass} fail=${c.fail} other=${c.other}`);
  console.log('\nFAILED:');
  results.filter(r => r.pass === false).forEach(r => console.log(`  ${r.id} ${r.title} | expected ${fmt(r.expected)} got ${fmt(r.actual)}`));
  return results;
}

module.exports = { BASE, Client, record, check, checkNear, near, db, rows, one, summary, results };
