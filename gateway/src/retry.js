// Retry policy for Meta sends: exactly 3 attempts - failure 1 waits 30s,
// failure 2 waits 2m, failure 3 is final. Transient = network failures, HTTP
// 408/429/5xx and Meta codes Meta documents as temporary. Permanent = invalid
// recipient, template problems and auth errors - retrying can never succeed.

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [30 * 1000, 2 * 60 * 1000];

const TRANSIENT_META_CODES = new Set([
  1,      // unknown / possibly temporary
  2,      // service temporarily unavailable
  4,      // application-level rate limit
  17,     // user-level rate limit
  80007,  // rate limit
  130429, // throughput limited
  131048, // spam rate limit hit
  131056, // pair rate limit
  131057  // account in maintenance / temporarily unavailable
]);

const PERMANENT_META_CODES = new Set([
  10,     // permission denied
  190,    // access token expired/invalid
  200,    // permission
  131021, // recipient cannot be sender
  131026, // message undeliverable
  131030, // recipient not in allowed list
  131031, // account locked/restricted
  132000, // number of parameters mismatch
  132001, // template does not exist
  132005, // template paused / translation error
  132007, // template format issues
  132012, // parameter format error
  132015, // template paused
  132016, // template disabled
  133000, // business payment/verification issues
  133004, // server / certificate issues on business side
  133005, // two-step verification mismatch
  133008, // phone number not registered
  133009, // incorrect two-step pin
  133010  // phone number not registered on WhatsApp
]);

const PERMANENT_POLICY_CODES = new Set(['template_not_approved']);

const TRANSIENT_HTTP = new Set([408, 429]);

function classifyMetaError(err) {
  const status = Number(err && (err.status || err.statusCode)) || 0;
  const rawCode = err && (err.metaCode ?? err.code);
  const metaCode = Number(rawCode) || 0;

  if (typeof rawCode === 'string' && PERMANENT_POLICY_CODES.has(rawCode)) {
    return { permanent: true, code: rawCode, status };
  }
  if (metaCode && PERMANENT_META_CODES.has(metaCode)) {
    return { permanent: true, code: metaCode, status };
  }
  if (metaCode && TRANSIENT_META_CODES.has(metaCode)) {
    return { permanent: false, code: metaCode, status };
  }
  if (TRANSIENT_HTTP.has(status) || status >= 500) {
    return { permanent: false, code: metaCode, status };
  }
  if (status >= 400 && status < 500) {
    return { permanent: true, code: metaCode, status };
  }
  // No HTTP status: network failure, DNS, timeout - always retryable.
  return { permanent: false, code: metaCode, status };
}

function nextBackoffMs(failedAttempts) {
  const n = Math.max(1, failedAttempts);
  if (n >= MAX_ATTEMPTS) return null;
  return BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)];
}

module.exports = { classifyMetaError, nextBackoffMs, MAX_ATTEMPTS, BACKOFF_MS };
