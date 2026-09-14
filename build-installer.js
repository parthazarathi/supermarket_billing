// LEGACY server-mode installer. Compiles installer.iss into
// dist\MartPOS-Server-Setup-<version>.exe using the Inno Setup compiler
// bundled with the innosetup-compiler npm package.
// The primary desktop installer is built by electron-builder (npm run build).
const path = require('path');
const innosetupCompiler = require('innosetup-compiler');

const issPath = path.join(__dirname, 'installer.iss');

innosetupCompiler(issPath, { gui: false, verbose: true }, (error) => {
  if (error) {
    console.error('Installer build failed:', error.message || error);
    process.exit(1);
  }
  console.log('Installer built: dist\\MartPOS-Server-Setup-1.0.0.exe');
});
