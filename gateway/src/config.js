
const GRAPH_PROD_BASE = 'https://graph.facebook.com';
const DEFAULT_GRAPH_VERSION = 'v26.0';

function loadConfig(env = process.env) {
  const missing = [];
  const required = [
    'DATABASE_URL',
    'GATEWAY_PUBLIC_URL',
    'GATEWAY_ENCRYPTION_KEY',
    'META_APP_ID',
    'META_APP_SECRET',
    'META_EMBEDDED_SIGNUP_CONFIG_ID',
    'META_WEBHOOK_VERIFY_TOKEN'
  ];
  for (const key of required) {
    if (!env[key] || !String(env[key]).trim()) missing.push(key);
  }

  const nodeEnv = env.NODE_ENV || 'production';
  const publicUrl = String(env.GATEWAY_PUBLIC_URL || '').replace(/\/+$/, '');
  if (publicUrl && !publicUrl.startsWith('https://') && nodeEnv !== 'test') {
    throw new Error('GATEWAY_PUBLIC_URL must use https:// outside test environments');
  }

  let encryptionKey = null;
  const rawKey = String(env.GATEWAY_ENCRYPTION_KEY || '').trim();
  if (rawKey) {
    try {
      encryptionKey = Buffer.from(rawKey, 'base64');
    } catch (_) {
      encryptionKey = null;
    }
    if (!encryptionKey || encryptionKey.length !== 32) {
      throw new Error('GATEWAY_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    }
  }

  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  // The Graph base URL is fixed in production; a custom one is only honored
  // under NODE_ENV=test so nothing can silently redirect Meta traffic.
  const graphBaseUrl =
    nodeEnv === 'test' && env.META_GRAPH_BASE_URL
      ? String(env.META_GRAPH_BASE_URL).replace(/\/+$/, '')
      : GRAPH_PROD_BASE;

  let trustProxy = 1;
  const rawTp = env.GATEWAY_TRUST_PROXY;
  if (rawTp !== undefined && rawTp !== null && String(rawTp).trim() !== '') {
    const tp = String(rawTp).trim().toLowerCase();
    if (tp === 'false' || tp === '0') {
      trustProxy = false;
    } else if (/^[1-5]$/.test(tp)) {
      trustProxy = parseInt(tp, 10);
    } else {
      throw new Error('GATEWAY_TRUST_PROXY must be false/0 or an integer 1-5');
    }
  }

  return {
    nodeEnv,
    isTest: nodeEnv === 'test',
    port: parseInt(env.PORT || '8080', 10),
    trustProxy,
    databaseUrl: env.DATABASE_URL,
    publicUrl,
    encryptionKey,
    meta: {
      appId: String(env.META_APP_ID),
      appSecret: String(env.META_APP_SECRET),
      embeddedSignupConfigId: String(env.META_EMBEDDED_SIGNUP_CONFIG_ID),
      graphVersion: env.META_GRAPH_API_VERSION || DEFAULT_GRAPH_VERSION,
      graphBaseUrl,
      webhookVerifyToken: String(env.META_WEBHOOK_VERIFY_TOKEN)
    },
    support: {
      username: env.GATEWAY_SUPPORT_USERNAME || '',
      passwordHash: env.GATEWAY_SUPPORT_PASSWORD_HASH || ''
    }
  };
}

module.exports = { loadConfig, GRAPH_PROD_BASE, DEFAULT_GRAPH_VERSION };
