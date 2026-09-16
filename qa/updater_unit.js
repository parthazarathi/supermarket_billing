// Unit tests for the update plumbing that is pure Node: version compare,
// friendly error mapping, release-notes normalization and feed resolution.
// electron-updater itself is main-process only and is exercised by the real
// build/update smoke test - never imported here.
const results = [];
let failures = 0;
function check(id, title, cond, note = '') {
  const pass = !!cond;
  if (!pass) failures += 1;
  results.push({ id, title, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${title}${pass ? '' : ` :: ${note}`}`);
}

const { compareVersions } = require('../lib/version');
const { friendlyUpdateError, releaseNotesLines } = require('../lib/updater');
const { resolveUpdateFeed } = require('../lib/updateFeed');

// ---------- version comparison ----------
check('UP-VER-001', 'patch update detected', compareVersions('1.0.1', '1.0.0') > 0);
check('UP-VER-002', 'minor update detected', compareVersions('1.1.0', '1.0.9') > 0);
check('UP-VER-003', 'major update detected', compareVersions('2.0.0', '1.9.9') > 0);
check('UP-VER-004', 'same version equal', compareVersions('1.0.0', '1.0.0') === 0);
check('UP-VER-005', 'older version detected', compareVersions('1.0.0', '1.0.1') < 0);
check('UP-VER-006', 'v-prefix tolerated', compareVersions('v1.1.0', '1.0.0') > 0);
check('UP-VER-007', 'missing segment treated as zero', compareVersions('1.1', '1.1.0') === 0);

// ---------- friendly error mapping ----------
check('UP-ERR-001', 'ENETUNREACH maps to offline message',
  /no internet/i.test(friendlyUpdateError(new Error('connect ENETUNREACH 1.2.3.4:443'))));
check('UP-ERR-002', 'ENOTFOUND maps to offline message',
  /no internet/i.test(friendlyUpdateError('getaddrinfo ENOTFOUND github.com')));
check('UP-ERR-003', 'timeout maps to offline message',
  /no internet/i.test(friendlyUpdateError(new Error('ETIMEDOUT'))));
check('UP-ERR-004', 'signature failure maps to verification message',
  /verification/i.test(friendlyUpdateError(new Error('sha512 checksum mismatch'))));
check('UP-ERR-005', 'generic error is friendly, no stack trace',
  /keep billing/i.test(friendlyUpdateError(new Error('something obscure happened'))));
check('UP-ERR-006', 'raw error text never leaks verbatim',
  !/something obscure happened/.test(friendlyUpdateError(new Error('something obscure happened'))));

// ---------- release notes ----------
check('UP-REL-001', 'markdown bullets normalized',
  JSON.stringify(releaseNotesLines('- Faster billing\n* Bug fixes')) === JSON.stringify(['Faster billing', 'Bug fixes']));
check('UP-REL-002', 'array notes flattened',
  releaseNotesLines([{ version: '1.1.0', note: '- Improved printing' }])[0] === 'Improved printing');
check('UP-REL-003', 'empty notes -> empty list', releaseNotesLines(null).length === 0);
check('UP-REL-004', 'headings and blanks stripped',
  JSON.stringify(releaseNotesLines('## What is new\n\n- A fix')) === JSON.stringify(['What is new', 'A fix']));

// ---------- feed resolution ----------
check('UP-FEED-001', 'no overrides -> baked-in feed',
  resolveUpdateFeed({}).type === 'default');
check('UP-FEED-002', 'server url -> generic provider', (() => {
  const f = resolveUpdateFeed({ MARTPOS_UPDATE_SERVER_URL: 'https://updates.example.com/pos' });
  return f.type === 'generic' && f.url === 'https://updates.example.com/pos/';
})());
check('UP-FEED-003', 'trailing slash normalized', (() => {
  const f = resolveUpdateFeed({ MARTPOS_UPDATE_SERVER_URL: 'https://updates.example.com/pos/' });
  return f.url === 'https://updates.example.com/pos/';
})());
let threw = false;
try { resolveUpdateFeed({ MARTPOS_UPDATE_SERVER_URL: 'http://insecure.example.com' }); } catch (_) { threw = true; }
check('UP-FEED-004', 'http update server rejected', threw);
check('UP-FEED-004b', 'loopback http allowed for local QA', (() => {
  const f = resolveUpdateFeed({ MARTPOS_UPDATE_SERVER_URL: 'http://127.0.0.1:8787/feed' });
  return f.type === 'generic' && f.url === 'http://127.0.0.1:8787/feed/';
})());
check('UP-FEED-005', 'github override via env', (() => {
  const f = resolveUpdateFeed({ MARTPOS_UPDATE_GH_OWNER: 'acme', MARTPOS_UPDATE_GH_REPO: 'pos-qa' });
  return f.type === 'github' && f.owner === 'acme' && f.repo === 'pos-qa';
})());
check('UP-FEED-006', 'partial github override ignored',
  resolveUpdateFeed({ MARTPOS_UPDATE_GH_OWNER: 'acme' }).type === 'default');

// ---------- updater status before init ----------
const updater = require('../lib/updater');
const st = updater.getStatus();
check('UP-STA-001', 'pre-init status is unsupported idle',
  st.supported === false && st.phase === 'idle');
check('UP-STA-002', 'quitAndInstall refuses without download',
  updater.quitAndInstall() === false);

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
