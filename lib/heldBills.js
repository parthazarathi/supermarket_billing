const { getDatabase, withTransaction } = require('./database');

function holdBill(name, cart, userId = null) {
  const now = new Date().toISOString();
  
  return withTransaction((db) => {
    const stmt = db.prepare('INSERT INTO held_bills (name, cart_json, user_id, created_at) VALUES (?, ?, ?, ?)');
    stmt.run(
      (name || 'Held bill').trim(),
      JSON.stringify(cart),
      userId,
      now
    );
    stmt.free();

    const selectStmt = db.prepare('SELECT id, name, created_at FROM held_bills WHERE id = last_insert_rowid()');
    const held = selectStmt.getAsObject({})[0];
    selectStmt.free();

    return held;
  });
}

function listHeldBills(userId = null) {
  const db = getDatabase();
  let stmt;
  let result = [];
  
  if (userId) {
    stmt = db.prepare('SELECT id, name, created_at FROM held_bills WHERE user_id = ? ORDER BY id DESC');
    stmt.bind([userId]);
  } else {
    stmt = db.prepare('SELECT id, name, created_at FROM held_bills ORDER BY id DESC');
  }
  
  while (stmt.step()) {
    result.push(stmt.getAsObject());
  }
  stmt.free();
  return result;
}

function recallHeldBill(heldId) {
  return withTransaction((db) => {
    const stmt = db.prepare('SELECT * FROM held_bills WHERE id = ?');
    stmt.bind([heldId]);
    const result = stmt.getAsObject();
    stmt.free();

    if (result.length === 0) {
      throw new Error('Held bill not found');
    }

    const held = result[0];
    const cart = JSON.parse(held.cart_json);

    const deleteStmt = db.prepare('DELETE FROM held_bills WHERE id = ?');
    deleteStmt.run([heldId]);
    deleteStmt.free();

    return {
      id: held.id,
      name: held.name,
      cart: cart
    };
  });
}

module.exports = {
  holdBill,
  listHeldBills,
  recallHeldBill
};
