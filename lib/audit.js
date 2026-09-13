const { getDatabase, saveDatabase } = require('./database');
const { q, qOne } = require('./reportUtils');

// Write an audit log entry. Never throws - logging must not break the action.
function logAudit(entry = {}) {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO audit_logs (user_id, username, action, module, reference, old_value, new_value, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const toText = (v) => {
      if (v === undefined || v === null) return '';
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    };
    stmt.run([
      entry.userId || null,
      entry.username || '',
      entry.action || 'unknown',
      entry.module || '',
      toText(entry.reference),
      toText(entry.oldValue),
      toText(entry.newValue),
      entry.description || '',
      new Date().toISOString()
    ]);
    stmt.free();
    saveDatabase();
  } catch (error) {
    console.error('Audit log failed:', error.message);
  }
}

function listAuditLogs(filters = {}, pagination = { page: 1, perPage: 100, offset: 0 }) {
  let where = ' WHERE 1=1';
  const params = [];

  if (filters.start && filters.end) {
    where += ' AND a.created_at >= ? AND a.created_at <= ?';
    params.push(filters.start, filters.end);
  }
  if (filters.userId) {
    where += ' AND a.user_id = ?';
    params.push(filters.userId);
  }
  if (filters.module) {
    where += ' AND a.module = ?';
    params.push(filters.module);
  }
  if (filters.action) {
    where += ' AND a.action = ?';
    params.push(filters.action);
  }
  if (filters.search) {
    where += ' AND (a.reference LIKE ? OR a.description LIKE ? OR a.username LIKE ?)';
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }

  const totalRow = qOne(`SELECT COUNT(*) as total FROM audit_logs a${where}`, params);
  const rows = q(
    `SELECT a.* FROM audit_logs a${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...params, pagination.perPage, pagination.offset]
  );

  return { rows, total: totalRow ? totalRow.total : 0 };
}

function auditActions() {
  return q('SELECT DISTINCT action FROM audit_logs ORDER BY action').map(r => r.action);
}

function auditModules() {
  return q('SELECT DISTINCT module FROM audit_logs ORDER BY module').map(r => r.module);
}

module.exports = {
  logAudit,
  listAuditLogs,
  auditActions,
  auditModules
};
