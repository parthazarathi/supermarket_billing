// HTTP client for the MartPOS cloud gateway. The device bearer token is read
// from the encrypted secrets store per request and is never logged or
// returned to callers.
const { getSecret } = require('../secrets');

class CloudError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message || 'Cloud request failed');
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
  }
}

// Plain HTTP is refused (except loopback in dev/test) so a misconfigured
// deployment cannot send device credentials over cleartext.
function validateCloudBaseUrl(raw, nodeEnv) {
  const v = String(raw || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  if (v.startsWith('https://')) return v;
  const env = nodeEnv || 'production';
  if ((env === 'development' || env === 'test') && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(v)) {
    return v;
  }
  return '';
}

// Packaged builds bake the operator's gateway origin into
// generated/platform-config.json (see build-platform-config.js). The file
// value is cached; the env var is read fresh every call.
let packagedUrl;
function packagedCloudUrl() {
  if (packagedUrl === undefined) {
    try {
      const p = require('path').join(__dirname, '..', '..', 'generated', 'platform-config.json');
      packagedUrl = String(JSON.parse(require('fs').readFileSync(p, 'utf8')).cloudGatewayUrl || '');
    } catch (_) {
      packagedUrl = '';
    }
  }
  return packagedUrl;
}

function cloudBaseUrl() {
  const envUrl = validateCloudBaseUrl(process.env.MARTPOS_CLOUD_URL, process.env.NODE_ENV);
  if (envUrl) return envUrl;
  return validateCloudBaseUrl(packagedCloudUrl(), process.env.NODE_ENV);
}

function cloudUrlConfigured() {
  return !!String(process.env.MARTPOS_CLOUD_URL || '').trim();
}

function deviceToken() {
  return getSecret('cloud_device_token') || '';
}

function cloudLinked() {
  return !!(cloudBaseUrl() && deviceToken());
}

const { redactText: redactSecrets } = require('../redact');

async function api(pathname, { method = 'GET', body, timeoutMs = 10000 } = {}) {
  const base = cloudBaseUrl();
  if (!base) {
    throw new CloudError(
      cloudUrlConfigured()
        ? 'MARTPOS_CLOUD_URL must be an https URL (loopback http is allowed only for development/test)'
        : 'Cloud gateway URL is not configured',
      { code: 'not_configured' }
    );
  }
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const token = deviceToken();
  if (token) headers.authorization = `Bearer ${token}`;

  let res;
  try {
    res = await globalThis.fetch(`${base}${pathname}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    throw new CloudError(redactSecrets(e.message || 'network error'), { code: 'network' });
  }

  let json = null;
  try { json = await res.json(); } catch (_) { /* non-json response */ }
  if (!res.ok) {
    throw new CloudError(
      redactSecrets((json && (json.error || json.message)) || `HTTP ${res.status}`),
      { status: res.status, code: (json && json.code) || '' }
    );
  }
  return json;
}

module.exports = { api, cloudBaseUrl, validateCloudBaseUrl, cloudUrlConfigured, deviceToken, cloudLinked, redactSecrets, CloudError };
