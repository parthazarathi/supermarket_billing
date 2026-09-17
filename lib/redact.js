// Pure redactor for secrets that may appear in log output or error text.
// redact() never mutates its input - it returns redacted copies; Errors are
// cloned preserving name/message/stack plus enumerable fields, and circular
// structures return '[Circular]' instead of throwing.
const RULES = [
  [/bearer\s+[a-z0-9._~+/=-]+/gi, 'Bearer <redacted>'],
  [/(\bauthorization\b\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1<redacted>'],
  [/\bmpt_[A-Za-z0-9_-]+/g, '<redacted>'],
  [/\bEAA[A-Za-z0-9_-]+/g, '<redacted>'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '<redacted>'],
  [/(\b(?:access_token|refresh_token|app_secret|appsecret|client_secret|verify_token|webhook_verify_token|pin)\b\s*[:=]\s*["']?)[^\s,"'&}]+/gi, '$1<redacted>'],
  [/([?&])(code|sig|token|access_token)=([^&\s"']+)/gi, '$1$2=<redacted>']
];

const SECRET_KEY = /^(authorization|access_token|refresh_token|app_secret|appsecret|client_secret|verify_token|webhook_verify_token|pin|password|deviceToken|device_token)$/i;

function redactText(text) {
  let out = String(text);
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

function redactError(err, seen) {
  seen.add(err);
  const clone = new Error(redactText(err.message));
  clone.name = err.name;
  if (err.stack) clone.stack = redactText(err.stack);
  for (const [k, v] of Object.entries(err)) {
    if (k === 'message' || k === 'name' || k === 'stack') continue;
    clone[k] = SECRET_KEY.test(k) ? '<redacted>' : redactValue(v, seen);
  }
  return clone;
}

function redactValue(value, seen) {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) return redactError(value, seen);
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((v) => redactValue(v, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '<redacted>' : redactValue(v, seen);
    }
    return out;
  }
  return value;
}

function redact(value) {
  return redactValue(value, new WeakSet());
}

module.exports = { redact, redactText };
