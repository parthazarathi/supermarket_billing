const bcrypt = require('bcryptjs');
const { getDatabase, withTransaction, execToObject, execToObjects } = require('./database');

function authenticate(username, password) {
  const user = execToObject(`SELECT * FROM users WHERE username = '${username.trim()}'`);
  
  if (!user) return null;

  const isValid = bcrypt.compareSync(password, user.password_hash);
  if (!isValid) return null;

  // Remove password hash from returned user object
  const { password_hash, ...userWithoutPassword } = user;
  return userWithoutPassword;
}

function listUsers() {
  return execToObjects('SELECT id, username, role, created_at FROM users ORDER BY username');
}

function createUser(username, password, role) {
  const validRoles = ['admin', 'manager', 'cashier'];
  const userRole = validRoles.includes(role) ? role : 'cashier';
  const passwordHash = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();
  const safeUsername = username.trim().replace(/'/g, "''");

  return withTransaction((db) => {
    db.run(`INSERT INTO users (username, password_hash, role, created_at) VALUES ('${safeUsername}', '${passwordHash}', '${userRole}', '${now}')`);
    return execToObject(`SELECT id, username, role, created_at FROM users WHERE username = '${safeUsername}'`);
  });
}

function updateUserPassword(userId, password) {
  const passwordHash = bcrypt.hashSync(password, 10);
  
  return withTransaction((db) => {
    db.run(`UPDATE users SET password_hash = '${passwordHash}' WHERE id = ${userId}`);
  });
}

function deleteUser(userId) {
  return withTransaction((db) => {
    // Check if this is the last user
    const result = execToObject('SELECT COUNT(*) as count FROM users');
    const count = result ? result.count : 0;

    if (count <= 1) {
      throw new Error('Cannot delete the last user');
    }

    db.run(`DELETE FROM users WHERE id = ${userId}`);
  });
}

function getUserById(userId) {
  return execToObject(`SELECT id, username, role, created_at FROM users WHERE id = ${userId}`);
}

module.exports = {
  authenticate,
  listUsers,
  createUser,
  updateUserPassword,
  deleteUser,
  getUserById
};
