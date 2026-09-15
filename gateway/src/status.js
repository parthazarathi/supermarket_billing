// Monotonic message-status transitions. A 'failed' update never downgrades a
// message that already reached delivered/read.
const RANK = { pending: 0, queued: 0, accepted: 0, sent: 1, delivered: 2, read: 3 };

function applyStatus(current, incoming) {
  const cur = RANK[current] !== undefined ? RANK[current] : 0;
  if (incoming === 'failed') {
    return cur <= RANK.sent ? 'failed' : current;
  }
  const next = RANK[incoming];
  if (next === undefined) return current;
  return next > cur ? incoming : current;
}

const STATUS_TS = { sent: 'sent_at', delivered: 'delivered_at', read: 'read_at' };

const { EXPIRED_CONNECTION } = require('./friendly');

// A stored 'connected' row whose access token has already expired is
// reported as needs_reconnect - the token can never succeed again.
function connectionState(conn, now = Date.now()) {
  if (!conn) return { status: 'disconnected', connected: false, needs_reconnect: false, friendly: '' };
  const exp = conn.token_expires_at ? Date.parse(conn.token_expires_at) : NaN;
  if (conn.status === 'connected' && Number.isFinite(exp) && exp <= now) {
    return { status: 'needs_reconnect', connected: false, needs_reconnect: true, friendly: EXPIRED_CONNECTION };
  }
  if (conn.status === 'needs_reconnect') {
    return { status: 'needs_reconnect', connected: false, needs_reconnect: true, friendly: conn.last_error || EXPIRED_CONNECTION };
  }
  if (conn.status === 'connected') {
    return { status: 'connected', connected: true, needs_reconnect: false, friendly: '' };
  }
  return { status: conn.status || 'disconnected', connected: false, needs_reconnect: false, friendly: conn.last_error || '' };
}

module.exports = { applyStatus, connectionState, RANK, STATUS_TS };
