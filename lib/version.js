// Single source of truth for the application version. The version always
// comes from package.json - never hard-code a version string in the app.
function appVersion() {
  return require('../package.json').version;
}

// Minimal semver compare for "a.b.c" style versions (no prerelease handling
// needed for release tags). Returns >0 when a is newer, <0 when older, 0
// when equal. Non-numeric parts compare lexically as a last resort.
function compareVersions(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.');
  const pb = String(b || '0').replace(/^v/i, '').split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const xa = pa[i] === undefined ? '0' : pa[i];
    const xb = pb[i] === undefined ? '0' : pb[i];
    const na = Number(xa);
    const nb = Number(xb);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

module.exports = { appVersion, compareVersions };
