const path = require('path');
const fs = require('fs');

const APP_NAME = 'MartPOS';

function isFrozen() {
  return process.pkg || process.versions.electron;
}

function getResourceDir() {
  if (isFrozen()) {
    return process.pkg ? path.dirname(process.execPath) : path.dirname(__dirname);
  }
  return path.join(__dirname, '..');
}

function getDataDir() {
  const override = process.env.MARTPOS_DATA_DIR;
  if (override) {
    if (!fs.existsSync(override)) {
      fs.mkdirSync(override, { recursive: true });
    }
    return override;
  }

  let base;
  if (isFrozen()) {
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || process.env.HOME;
      base = path.join(localAppData, APP_NAME);
    } else {
      base = path.join(process.env.HOME, `.${APP_NAME.toLowerCase()}`);
    }
  } else {
    base = path.join(__dirname, '..', 'data');
  }

  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true });
  }
  return base;
}

function getDbPath() {
  return path.join(getDataDir(), 'pos.db');
}

function getCredentialsPath() {
  return path.join(getDataDir(), 'credentials.json');
}

function getTokenPath() {
  return path.join(getDataDir(), 'token.json');
}

module.exports = {
  isFrozen,
  getResourceDir,
  getDataDir,
  getDbPath,
  getCredentialsPath,
  getTokenPath
};
