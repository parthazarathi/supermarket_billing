// Dedicated AI audit log (ai_audit_log table - created in createTables()).
// Records who asked what, which tools ran, and the outcome. Never logs API
// keys, passwords, or customer PII beyond the question text itself.
const { getDatabase, saveDatabase } = require('../database');
const { redactText } = require('../redact');

function logAiInteraction(entry = {}) {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO ai_audit_log
        (user_id, username, user_role, question, tools_used, action_performed,
         confirmation_required, confirmation_status, success, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const text = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    stmt.run([
      entry.userId || null,
      entry.username || '',
      entry.userRole || '',
      redactText(text(entry.question)).slice(0, 2000),
      text(entry.toolsUsed || []),
      entry.action || '',
      entry.confirmationRequired ? 1 : 0,
      entry.confirmationStatus || '',
      entry.success === false ? 0 : 1,
      text(entry.error).slice(0, 500),
      new Date().toISOString()
    ]);
    stmt.free();
    saveDatabase();
  } catch (error) {
    // Auditing must never break the chat.
    console.error('AI audit log failed:', error.message);
  }
}

function listAiAudit(limit = 100) {
  try {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM ai_audit_log ORDER BY id DESC LIMIT ?');
    stmt.bind([Math.min(500, Math.max(1, limit | 0))]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (_) {
    return [];
  }
}

module.exports = { logAiInteraction, listAiAudit };
