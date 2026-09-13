const { withTransaction, execToObject, execToObjects } = require('./database');

function getSetting(key, defaultValue = '') {
  const result = execToObject('SELECT value FROM settings WHERE key = ?', [key]);
  return result ? result.value : defaultValue;
}

function getSettings() {
  const results = execToObjects('SELECT key, value FROM settings');
  const settings = {};
  results.forEach(row => {
    if (row && row.key) {
      settings[row.key] = row.value;
    }
  });
  return settings;
}

function setSettings(updates) {
  withTransaction((db) => {
    for (const [key, value] of Object.entries(updates)) {
      const safeValue = value === null ? '' : String(value);

      // First try to insert, if exists then update
      const exists = execToObject('SELECT key FROM settings WHERE key = ?', [key]);

      if (exists) {
        db.run('UPDATE settings SET value = ? WHERE key = ?', [safeValue, key]);
      } else {
        db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, safeValue]);
      }
    }
  });
  return getSettings();
}

module.exports = {
  getSetting,
  getSettings,
  setSettings
};
