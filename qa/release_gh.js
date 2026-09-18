// One-shot release publisher: creates the v1.1.0 GitHub release and uploads
// the dist-app artifacts using the PAT stored in git's credential manager.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const OWNER = 'parthazarathi';
const REPO = 'supermarket_billing';
const TAG = 'v1.1.0';
const TITLE = 'Mart POS 1.1.0';
const TARGET = 'installer-packaging';
const DIST = path.resolve(__dirname, '..', 'dist-app');
const ASSETS = [
  'latest.yml',
  'MartPOS-Setup-1.1.0.exe',
  'MartPOS-Setup-1.1.0.exe.blockmap',
  'MartPOS-Portable-1.1.0.exe',
];
const NOTES = [
  'Redesigned interface - modern, clean iOS-inspired design across the whole app',
  'Dark mode and light mode - choose in Settings > Appearance, or follow Windows',
  'Configurable accent color (blue, green, purple, orange)',
  'Dashboard: friendly greeting, skeleton loading, cleaner KPI cards and charts',
  'POS billing: bigger search field, pill quantity steppers, clearer Grand Total',
  'Modern tables, menus, toggles, segmented filters and dialogs on every screen',
  'Settings now has a sidebar with a new Appearance section',
  'No changes to billing, inventory, reports or your data - same business logic',
].map((l) => `- ${l}`).join('\n');

function token() {
  const out = execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n' }).toString();
  const m = /^password=(.+)$/m.exec(out);
  if (!m) throw new Error('no github credential found');
  return m[1].trim();
}

function req(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const auth = (tok) => ({
  'User-Agent': 'martpos-release',
  Authorization: `Bearer ${tok}`,
  Accept: 'application/vnd.github+json',
});

async function main() {
  const tok = token();

  // does the release already exist?
  const existing = await req('GET', `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, auth(tok));
  let release;
  if (existing.status === 200) {
    release = JSON.parse(existing.body.toString());
    console.log('release already exists:', release.html_url);
  } else {
    const payload = JSON.stringify({
      tag_name: TAG, target_commitish: TARGET, name: TITLE,
      body: NOTES, draft: false, prerelease: false,
    });
    const res = await req('POST', `https://api.github.com/repos/${OWNER}/${REPO}/releases`,
      { ...auth(tok), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, payload);
    if (res.status !== 201) {
      console.error('create failed', res.status, res.body.toString().slice(0, 500));
      process.exit(1);
    }
    release = JSON.parse(res.body.toString());
    console.log('release created:', release.html_url);
  }

  const uploadBase = release.upload_url.replace(/\{.*\}/, '');
  for (const name of ASSETS) {
    const file = path.join(DIST, name);
    if (!fs.existsSync(file)) { console.log('MISSING', name); continue; }
    const data = fs.readFileSync(file);
    const ctype = name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
    const res = await req('POST', `${uploadBase}?name=${encodeURIComponent(name)}`,
      { ...auth(tok), 'Content-Type': ctype, 'Content-Length': data.length }, data);
    if (res.status === 201) console.log('uploaded', name, `(${(data.length / 1048576).toFixed(1)} MB)`);
    else console.log('upload failed', name, res.status, res.body.toString().slice(0, 300));
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
