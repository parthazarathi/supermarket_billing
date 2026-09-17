// MSIX package build for MartPOS.
//
// Wraps `electron-builder --win appx`. electron-builder 26.x produces
// MSIX-format packages via the appx target (makeappx.exe); the artifact is
// emitted with a .msix name (see the appx.artifactName in package.json).
// A native "msix" target exists only in the electron-builder 27.x alphas -
// the stable 26.x line is used here on purpose.
//
// Package Publisher resolution (must never be hard-coded):
//   1. A signing certificate is configured (WIN_CSC_LINK / CSC_LINK /
//      WIN_CSC_NAME) -> the manifest Publisher is taken from the certificate
//      subject. This is exactly what sideloaded MSIX installs require.
//   2. MARTPOS_MSIX_PUBLISHER is set -> passed through as the manifest
//      Publisher. Use the Publisher DN shown in Partner Center under
//      Product identity for Store-bound builds (e.g. "CN=AAAAAAA-BBBB-...").
//   3. Neither is set -> electron-builder's unsigned "CN=ms" placeholder.
//      Such a package cannot be installed or submitted - it only proves the
//      packaging pipeline works.
//
// MARTPOS_MSIX_IDENTITY_NAME and MARTPOS_MSIX_PUBLISHER_DISPLAY_NAME can
// likewise override the package.json defaults for Store submission.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ensureSignToolEnv } = require('./build/signtool');

const args = ['--win', 'appx'];
const env = process.env;

const publisher = String(env.MARTPOS_MSIX_PUBLISHER || '').trim();
const identityName = String(env.MARTPOS_MSIX_IDENTITY_NAME || '').trim();
const publisherDisplayName = String(env.MARTPOS_MSIX_PUBLISHER_DISPLAY_NAME || '').trim();
const hasCert = !!(env.WIN_CSC_LINK || env.CSC_LINK || env.WIN_CSC_NAME);

if (publisher) args.push(`-c.appx.publisher=${publisher}`);
if (identityName) args.push(`-c.appx.identityName=${identityName}`);
if (publisherDisplayName) args.push(`-c.appx.publisherDisplayName=${publisherDisplayName}`);

if (publisher && hasCert) {
  console.warn(
    'build:msix: MARTPOS_MSIX_PUBLISHER overrides the certificate subject as the\n' +
    'package Publisher. For sideload installs it MUST match the signing certificate\n' +
    'subject, otherwise Windows will refuse the package.'
  );
}
if (!publisher && !hasCert) {
  console.warn(
    'build:msix: no signing certificate (WIN_CSC_LINK / CSC_LINK / WIN_CSC_NAME)\n' +
    'and no MARTPOS_MSIX_PUBLISHER - the package will be unsigned with a\n' +
    'placeholder publisher. It cannot be installed or submitted to the Store.\n' +
    'See WINDOWS-DISTRIBUTION.md for signing options.'
  );
}

// The bundled winCodeSign signtool cannot sign appx/msix packages on current
// Windows builds - prefer an installed Windows SDK signtool when available.
ensureSignToolEnv();

const cli = path.join(__dirname, 'node_modules', 'electron-builder', 'cli.js');
const res = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
if (res.error) {
  console.error('build:msix: failed to run electron-builder:', res.error.message || res.error);
  process.exit(1);
}
if (res.status !== 0) {
  process.exit(res.status == null ? 1 : res.status);
}

// electron-builder emits MartPOS-<version>.msix directly (see
// appx.artifactName in package.json). Verify the artifact exists.
const outDir = path.join(__dirname, 'dist-app');
const msix = fs.readdirSync(outDir)
  .filter((f) => /^MartPOS-.+\.msix$/i.test(f))
  .map((f) => ({ f, mtime: fs.statSync(path.join(outDir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0];
if (!msix) {
  console.error('build:msix: build finished but no MartPOS-*.msix artifact was found in dist-app');
  process.exit(1);
}
console.log(`build:msix: MSIX package ready: dist-app\\${msix.f}`);
