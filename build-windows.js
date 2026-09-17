// Windows build wrapper: resolves a modern signtool (so package signing
// works on current Windows) and forwards all arguments to electron-builder.
// Usage: node build-windows.js [electron-builder args...]
//   node build-windows.js                -> every configured win target
//   node build-windows.js nsis portable  -> just the NSIS + portable exes
const { spawnSync } = require('child_process');
const path = require('path');
const { ensureSignToolEnv } = require('./build/signtool');

ensureSignToolEnv();

const cli = path.join(__dirname, 'node_modules', 'electron-builder', 'cli.js');
const res = spawnSync(process.execPath, [cli, '--win', ...process.argv.slice(2)], { stdio: 'inherit' });
if (res.error) {
  console.error('build-windows: failed to run electron-builder:', res.error.message || res.error);
  process.exit(1);
}
process.exit(res.status == null ? 1 : res.status);
