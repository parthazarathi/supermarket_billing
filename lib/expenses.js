const { getDatabase, withTransaction } = require('./database');

function addExpense(category, amount, note = '', userId = null) {
  const now = new Date().toISOString();
  
  return withTransaction((db) => {
    const stmt = db.prepare('INSERT INTO expenses (category, amount, note, created_at, user_id) VALUES (?, ?, ?, ?, ?)');
    stmt.run([
      (category || 'General').trim(),
      parseFloat(amount),
      note || '',
      now,
      userId
    ]);
    stmt.free();

    const selectStmt = db.prepare('SELECT * FROM expenses WHERE id = last_insert_rowid()');
    const result = selectStmt.getAsObject();
    selectStmt.free();

    return result[0];
  });
}

function listExpenses(limit = 200) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM expenses ORDER BY id DESC LIMIT ?');
  stmt.bind([limit]);
  const expenses = [];
  
  while (stmt.step()) {
    expenses.push(stmt.getAsObject());
  }
  stmt.free();
  return expenses;
}

function deleteExpense(expenseId) {
  return withTransaction((db) => {
    const stmt = db.prepare('DELETE FROM expenses WHERE id = ?');
    stmt.run(expenseId);
    stmt.free();
  });
}

module.exports = {
  addExpense,
  listExpenses,
  deleteExpense
};
