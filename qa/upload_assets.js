// Retry upload of the large release assets.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const OWNER = 'parthazarathi';
const REPO = 'supermarket_billing';
const TAG = 'v1.1.0';
const DIST = path.resolve(__dirname, '..', 'dist-app');
const ASSETS = process.argv.slice(2);
if (!ASSETS.length) ASSETS.push('MartPOS-Setup-1.1.0.exe', 'MartPOS-Portable-1.1.0.exe');

function token() {
  const out = execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n' }).toString();
  return /^password=(.+)$/m.exec(out)[1].trim();
}
const auth = (tok) => ({
  'User-Agent': 'martpos-release',
  Authorization: `Bearer ${tok}`,
  Accept: 'application/vnd.github+json',
});
function req(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(url, { method, headers, timeout: 600000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    if (body) r.write(body);
    r.end();
  });
}

async function main() {
  const tok = token();
  const rel = await req('GET', `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, auth(tok));
  if (rel.status !== 200) { console.error('release lookup failed', rel.status); process.exit(1); }
  const release = JSON.parse(rel.body.toString());
  const uploadBase = release.upload_url.replace(/\{.*\}/, '');

  for (const name of ASSETS) {
    const file = path.join(DIST, name);
    const data = fs.readFileSync(file);
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      const res = await req('POST', `${uploadBase}?name=${encodeURIComponent(name)}`,
        { ...auth(tok), 'Content-Type': 'application/octet-stream', 'Content-Length': data.length }, data);
      if (res.status === 201) { console.log('uploaded', name); done = true; }
      else if (res.status === 422) { console.log('already uploaded', name); done = true; }
      else console.log(`attempt ${attempt} failed`, res.status, res.body.toString().slice(0, 200));
    }
    if (!done) console.log('FAILED', name);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
