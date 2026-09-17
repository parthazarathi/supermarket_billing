// Locates a modern Windows SDK signtool.exe for the build scripts.
//
// electron-builder ships its own signtool in the winCodeSign kit, but that
// binary is old enough that package signing (.appx/.msix) fails on current
// Windows 11 builds with "A required function is not present". When a
// Windows SDK is installed, its signtool is strictly newer and handles
// package signing correctly - so we prefer it via SIGNTOOL_PATH, which
// electron-builder honours for every signing operation.
// SIGNTOOL_PATH already set in the environment always wins.
const fs = require('fs');
const path = require('path');

function versionKey(dirName) {
  const m = /^10\.(\d+)\.(\d+)\.(\d+)$/.exec(dirName);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function findKitSignTool() {
  const roots = [];
  if (process.env['ProgramFiles(x86)']) {
    roots.push(path.join(process.env['ProgramFiles(x86)'], 'Windows Kits', '10', 'bin'));
  }
  if (process.env.ProgramFiles) {
    roots.push(path.join(process.env.ProgramFiles, 'Windows Kits', '10', 'bin'));
  }
  roots.push('C:\\Program Files (x86)\\Windows Kits\\10\\bin');

  const candidates = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const ver = versionKey(entry);
      if (!ver) continue;
      const p = path.join(root, entry, 'x64', 'signtool.exe');
      if (fs.existsSync(p)) candidates.push({ ver, path: p });
    }
  }
  // Newest SDK version wins.
  candidates.sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (a.ver[i] !== b.ver[i]) return b.ver[i] - a.ver[i];
    }
    return 0;
  });
  return candidates.length ? candidates[0].path : null;
}

// Ensures SIGNTOOL_PATH points at a usable signtool for this process and any
// children it spawns. Returns the resolved path, or '' when nothing was
// found (electron-builder then falls back to its bundled signtool).
function ensureSignToolEnv(env = process.env) {
  if (env.SIGNTOOL_PATH) return env.SIGNTOOL_PATH;
  const p = findKitSignTool();
  if (p) {
    env.SIGNTOOL_PATH = p;
    console.log(`build: using Windows SDK signtool at ${p}`);
  }
  return p || '';
}

module.exports = { ensureSignToolEnv, findKitSignTool };
