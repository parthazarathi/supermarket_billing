// Security layer for the AI Store Manager.
// Permission checks reuse the existing role hierarchy (never a parallel
// system). Tool access mirrors the route guards in server.js: data a cashier
// can already see on the dashboard/invoices screens is readable by AI tools,
// while expense/purchase/profit data stays manager+.
const ROLE_LEVEL = { cashier: 1, manager: 2, admin: 3 };

class AiPermissionError extends Error {
  constructor(message) {
    super(message || 'This information is not available for your role');
    this.name = 'AiPermissionError';
    this.code = 'permission_denied';
  }
}

class AiRateLimitError extends Error {
  constructor(message) {
    super(message || 'Too many AI requests - please wait a moment and try again');
    this.name = 'AiRateLimitError';
    this.code = 'rate_limited';
  }
}

// Thrown when the same user already has an AI request running. Distinct from
// rate limiting so the API can answer 409 instead of a fake provider error.
class AiBusyError extends Error {
  constructor(message) {
    super(message || 'An AI request is already being processed. Please wait for it to finish.');
    this.name = 'AiBusyError';
    this.code = 'busy';
  }
}

function roleLevel(role) {
  return ROLE_LEVEL[role] || 0;
}

function hasRole(user, minRole) {
  return !!user && roleLevel(user.role) >= roleLevel(minRole);
}

function requirePermission(user, minRole) {
  if (!user || !user.id) {
    throw new AiPermissionError('Login required');
  }
  if (!hasRole(user, minRole)) {
    throw new AiPermissionError();
  }
}

// ---- request rate limiting (per user, in-memory) ----
// Billing-critical endpoints are never touched; this only guards the AI
// chat route so a runaway client cannot burn through API quota.
const buckets = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_PER_MINUTE = 12;
const RATE_PER_DAY = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BUCKETS = 500;

function checkRateLimit(userId) {
  const now = Date.now();
  // Bound the map: drop expired-day buckets, then evict oldest if still full.
  if (buckets.size >= MAX_BUCKETS) {
    for (const [k, v] of buckets) {
      if (now - v.dayStart > DAY_MS) buckets.delete(k);
    }
    if (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value);
  }
  let b = buckets.get(userId);
  if (!b || now - b.dayStart > DAY_MS) {
    b = { dayStart: now, dayCount: 0, hits: [] };
    buckets.set(userId, b);
  }
  b.hits = b.hits.filter((t) => now - t < RATE_WINDOW_MS);
  if (b.hits.length >= RATE_PER_MINUTE || b.dayCount >= RATE_PER_DAY) {
    throw new AiRateLimitError();
  }
  b.hits.push(now);
  b.dayCount += 1;
}

// ---- input validation ----
const MAX_MESSAGE_LEN = 2000;
const MAX_HISTORY = 10;
const MAX_HISTORY_MSG_LEN = 2000;

function validateQuestion(input) {
  const q = String(input == null ? '' : input).trim();
  if (!q) {
    const e = new Error('Ask a question first');
    e.code = 'bad_request';
    throw e;
  }
  return q.slice(0, MAX_MESSAGE_LEN);
}

// History arrives from the client and is untrusted: keep only well-formed
// text turns, trim count and length, never let it carry tool calls or
// system instructions.
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_MSG_LEN) }));
}

// ---- prompt-injection heuristics ----
// The system prompt already instructs the model; this layer flags obvious
// override attempts for the audit log. Detection only - the request still
// runs because tools are server-side and read-only anyway.
const INJECTION_PATTERNS = [
  /ignore\s+(all|any|previous|prior)\s+instructions/i,
  /system\s*prompt/i,
  /you\s+are\s+now\b/i,
  /\bDAN\b.*\bjailbreak/i,
  /reveal\s+(your|the)\s+(api|secret|key|token|password)/i,
  /drop\s+table|delete\s+from|update\s+\w+\s+set|insert\s+into|select\s+.+\s+from/i,
  /\bexec(ute)?\s+(sql|query|command)/i
];

function injectionFlags(question) {
  const flags = [];
  for (const re of INJECTION_PATTERNS) {
    if (re.test(question)) flags.push(re.source.slice(0, 40));
  }
  return flags;
}

// ---- result size control ----
// Tool results go to the provider verbatim; cap rows and total size so a
// big inventory can never balloon token usage.
const MAX_TOOL_ROWS = 25;
const MAX_TOOL_JSON = 6000;

function capRows(rows, max = MAX_TOOL_ROWS) {
  if (!Array.isArray(rows)) return rows;
  if (rows.length <= max) return rows;
  return rows.slice(0, max);
}

function truncateResult(data) {
  let json;
  try {
    json = JSON.stringify(data);
  } catch (_) {
    return { truncated: true, note: 'result could not be serialized' };
  }
  if (json.length <= MAX_TOOL_JSON) return data;
  // Drop rows progressively until it fits.
  if (data && Array.isArray(data.rows)) {
    const clone = { ...data, rows: data.rows.slice(0, Math.max(5, Math.floor(data.rows.length / 2))), truncated: true, total_rows: data.rows.length };
    return truncateResult(clone);
  }
  return { truncated: true, preview: json.slice(0, MAX_TOOL_JSON) };
}

module.exports = {
  ROLE_LEVEL,
  AiPermissionError,
  AiRateLimitError,
  AiBusyError,
  hasRole,
  requirePermission,
  checkRateLimit,
  validateQuestion,
  sanitizeHistory,
  injectionFlags,
  capRows,
  truncateResult,
  MAX_TOOL_ROWS
};
