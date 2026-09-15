// Build-time helper: bakes the deployment operator's gateway origin into
// generated/platform-config.json so packaged artifacts need zero owner-side
// configuration. Only the URL is stored - it is not a secret, and nothing
// else (tokens, Meta credentials) may ever be written here.
const fs = require('fs');
const path = require('path');
const { validateCloudBaseUrl } = require('./lib/whatsapp/gatewayClient');

function writePlatformConfig({ env = process.env, outputPath } = {}) {
  const url = String(env.MARTPOS_CLOUD_URL || '').trim().replace(/\/+$/, '');
  if (url && !validateCloudBaseUrl(url, env.NODE_ENV)) {
    throw new Error('invalid cloud url');
  }
  const target = outputPath || path.join(__dirname, 'generated', 'platform-config.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ cloudGatewayUrl: url }) + '\n', 'utf8');
  return !!url;
}

if (require.main === module) {
  try {
    console.log(writePlatformConfig() ? 'Platform gateway configured' : 'Platform gateway not configured');
  } catch (_) {
    console.log('Platform gateway not configured');
    process.exit(1);
  }
}

module.exports = { writePlatformConfig };
