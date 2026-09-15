// Operator support endpoints behind HTTPS Basic auth. The password env var is
// a bcrypt hash; responses contain counts and masked values only - never IDs,
// tokens or raw phone numbers.
const bcrypt = require('bcryptjs');
const store = require('./store');
const { redactText } = require('./redact');

function supportAuth(config) {
  return async (req, res, next) => {
    const { username, passwordHash } = config.support;
    if (!username || !passwordHash) {
      return res.status(503).json({ ok: false, error: 'Support access is not configured' });
    }
    const header = String(req.get('authorization') || '');
    const match = header.match(/^Basic\s+(.+)$/i);
    if (!match) {
      res.set('WWW-Authenticate', 'Basic realm="martpos-support"');
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    let user = ''; let pass = '';
    try {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      user = decoded.slice(0, idx);
      pass = decoded.slice(idx + 1);
    } catch (_) { /* handled below */ }
    const userOk = user === username;
    let passOk = false;
    try { passOk = await bcrypt.compare(pass, passwordHash); } catch (_) { passOk = false; }
    if (!userOk || !passOk) {
      res.set('WWW-Authenticate', 'Basic realm="martpos-support"');
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    next();
  };
}

function esc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderDashboard(summary, rows) {
  const cards = [
    ['Connected Shops', summary.connected_shops],
    ['Messages Today', summary.messages_today],
    ['Delivered', summary.delivered_today],
    ['Read', summary.read_today],
    ['Failed', summary.failed_today],
    ['Connection Issues', summary.connection_issues]
  ];
  const tableRows = rows.map((r) => `<tr>
    <td>${esc(r.shop_name)}</td><td>${esc(r.business_name)}</td><td>${esc(r.display_number)}</td>
    <td>${esc(r.connection_status)}</td><td>${esc(r.template_status)}</td>
    <td>${r.messages_today}</td><td>${r.failed_today}</td><td>${esc(r.last_error)}</td>
  </tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MartPOS gateway support</title>
<style>
body{font-family:system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 16px;color:#1c1e21}
.cards{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0 24px}
.card{border:1px solid #ddd;border-radius:8px;padding:14px 20px;min-width:130px}
.card b{display:block;font-size:26px}
.card span{color:#606770;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border-bottom:1px solid #eee;padding:8px 10px;text-align:left}
th{color:#606770;font-weight:600}
</style></head><body>
<h2>MartPOS gateway support</h2>
<div class="cards">${cards.map(([l, v]) => `<div class="card"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>
<table><thead><tr><th>Shop</th><th>Business</th><th>Number</th><th>Connection</th><th>Template</th><th>Today</th><th>Failed</th><th>Last error</th></tr></thead>
<tbody>${tableRows || '<tr><td colspan="8">No shops yet.</td></tr>'}</tbody></table>
</body></html>`;
}

function supportRoutes(app, deps) {
  const { pool, config } = deps;
  const auth = supportAuth(config);

  app.get('/support', auth, async (req, res) => {
    try {
      const [summary, rows] = await Promise.all([
        store.supportSummary(pool),
        store.supportDiagnostics(pool)
      ]);
      res.type('html').send(renderDashboard(summary, rows));
    } catch (e) {
      console.error('support page failed:', redactText(e.message || 'error'));
      res.status(500).type('html').send('<!doctype html><title>Support</title><p>Dashboard unavailable.</p>');
    }
  });

  app.get('/v1/support/summary', auth, async (req, res) => {
    try {
      const summary = await store.supportSummary(pool);
      res.json({ ok: true, summary });
    } catch (e) {
      console.error('support summary failed:', redactText(e.message || 'error'));
      res.status(500).json({ ok: false, error: 'Summary unavailable' });
    }
  });

  app.get('/v1/support/diagnostics', auth, async (req, res) => {
    try {
      res.json({ ok: true, shops: await store.supportDiagnostics(pool) });
    } catch (e) {
      console.error('support diagnostics failed:', redactText(e.message || 'error'));
      res.status(500).json({ ok: false, error: 'Diagnostics unavailable' });
    }
  });
}

module.exports = { supportAuth, supportRoutes };
