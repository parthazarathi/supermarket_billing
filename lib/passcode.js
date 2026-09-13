const bcrypt = require('bcryptjs');
const { getSetting } = require('./settings');

// Verifies the bill edit/delete passcode against the stored bcrypt hash.
// Empty/absent hash means the feature is disabled.
function verifyBillPasscode(plain) {
  const hash = getSetting('bill_passcode_hash', '');
  if (!hash) {
    return { configured: false, ok: false };
  }
  return { configured: true, ok: bcrypt.compareSync(String(plain || ''), hash) };
}

module.exports = {
  verifyBillPasscode
};
