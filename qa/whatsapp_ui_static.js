// Static UI assertions: the WhatsApp settings card, checkout and Sales list
// must present only owner-friendly state - never technical provider details.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(ROOT, 'templates', 'script.js'), 'utf8');
const style = fs.readFileSync(path.join(ROOT, 'templates', 'style.css'), 'utf8');
const index = fs.existsSync(path.join(ROOT, 'templates', 'index.html'))
  ? fs.readFileSync(path.join(ROOT, 'templates', 'index.html'), 'utf8') : '';

let pass = 0, fail = 0;
function check(id, name, ok, detail = '') {
  if (ok) { pass++; console.log(`[PASS] ${id} ${name}`); }
  else { fail++; console.log(`[FAIL] ${id} ${name}${detail ? ' :: ' + String(detail).slice(0, 300) : ''}`); }
}

const ui = script + '\n' + index;

// ---------- no provider/technical leakage ----------
// (No literal provider names here: the removed provider's name must not exist
// anywhere in the repo, including inside this test file.)
for (const [id, pat, label] of [
  ['WU-UI-001', /api_key|apikey|secret_key|bearer\s+token|x-api-key/i, 'API credential field names'],
  ['WU-UI-002', /account_sid|auth_token|ACxxxx/i, 'credential field names'],
  ['WU-UI-003', /graph\.facebook|waba|phone_number_id|access_token|webhook|X-Hub/i, 'Meta technical names'],
  ['WU-UI-004', /test-connection|testConnection/, 'removed credential-check call'],
  ['WU-UI-005', /simulated/i, 'simulated provider text'],
  ['WU-UI-006', /Shop WhatsApp number|WhatsApp business number|WhatsApp business|sender number/i, 'ambiguous sender-number labels'],
]) {
  check(id, `UI free of ${label}`, !pat.test(ui));
}

// ---------- settings card states ----------
check('WU-UI-010', 'not-connected card copy present', ui.includes('No technical setup required') && ui.includes('Status: Not Connected'));
check('WU-UI-011', 'connect button present', ui.includes('id="waConnectBtn"') && ui.includes('Connect WhatsApp'));
check('WU-UI-012', 'owner modal has create + sign-in', ui.includes('Create owner account') && ui.includes('Sign in'));
check('WU-UI-013', 'owner modal explains secure linking', /securely links this shop/i.test(ui));
check('WU-UI-014', 'unavailable card copy when cloud url unset', ui.includes('not available on this installation'));
check('WU-UI-015', 'reconnect + relink controls', ui.includes('Reconnect WhatsApp') && ui.includes('Use another MartPOS account'));
check('WU-UI-016', 'connected card fields', ui.includes('WhatsApp Connected') && ui.includes('Business:') && ui.includes('Template:'));
check('WU-UI-017', 'template label options', ui.includes('Approval pending') && ui.includes('Needs attention') && ui.includes('Ready'));
check('WU-UI-018', 'send test bill + change + disconnect buttons', ui.includes('Send Test Bill') && ui.includes('Change WhatsApp') && ui.includes('waDisconnect'));
check('WU-UI-019', 'disconnect warning text', /future bills will no longer be sent/i.test(ui) && /existing invoices and past messages remain saved/i.test(ui));
check('WU-UI-020', 'country code select options', /name="whatsapp_default_country_code"/.test(ui) && ui.includes('+91 India') && ui.includes('+971'));

// ---------- polling ----------
check('WU-UI-030', 'status polling function exists with guards', /function pollWhatsAppStatus/.test(script) && /5 \* 60 \* 1000/.test(script) && /waPollTimer/.test(script));
check('WU-UI-031', 'polling stops on view change / connected', /state\.view !== "settings"/.test(script));

// ---------- checkout ----------
check('WU-UI-040', 'queued sale message', ui.includes('WhatsApp queued'));
check('WU-UI-041', 'post-sale invoice poll helper', /function pollInvoiceWhatsApp/.test(script) && /120000/.test(script));
check('WU-UI-042', 'poll clears prior timer and guards unrelated status',
  /clearTimeout\(waInvoicePoll\.timer\)/.test(script) && /startsWith\("Saved"\)/.test(script) && /includes\(invoiceNo\)/.test(script));

// ---------- sales list ----------
check('WU-UI-050', 'dedicated WhatsApp column', /<th>WhatsApp<\/th>/.test(script));
check('WU-UI-051', 'status label helper + symbols', /function whatsappStatusLabel/.test(script) && script.includes('Sending…') && script.includes('✓') && script.includes('✗') && script.includes('Not sent'));
check('WU-UI-052', 'delivery modal title + masked number', ui.includes('WhatsApp Delivery') && /function maskPhoneDisplay/.test(script));
check('WU-UI-053', 'wa cell styles exist', /\.wa-ok/.test(style) && /\.wa-fail/.test(style) && /\.wa-wait/.test(style));
check('WU-UI-054', 'attempts show masked phone', /maskPhoneDisplay\(a\.phone\)|maskPhoneDisplay\(a && a\.phone/.test(script));

// ---------- settings form keeps safe fields only ----------
check('WU-UI-060', 'auto-send checkbox retained once', (script.match(/<input[^>]*name="whatsapp_auto_send"/g) || []).length === 1);

console.log(`===== SUMMARY ===== total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
