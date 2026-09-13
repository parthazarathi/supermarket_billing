const { getDatabase, withTransaction, execToObjects, execToObject } = require('./database');
const { generateNextNumber } = require('./cart');
const { getItemByCode, getItem } = require('./items');

// Resolve a document line against the items table - client-sent names/codes
// are never trusted, and quantities/prices are validated server-side.
function resolveDocLines(items, notFoundMessage) {
  const prepared = [];
  for (const line of items) {
    let item = null;
    if (line.code !== undefined && line.code !== null && String(line.code).trim() !== '') {
      item = getItemByCode(String(line.code));
    }
    if (!item && line.item_id) {
      item = getItem(line.item_id);
    }
    if (!item) {
      throw new Error(notFoundMessage);
    }

    const qty = parseFloat(line.quantity);
    if (!isFinite(qty) || qty <= 0) {
      throw new Error(`Invalid quantity for ${item.name}`);
    }
    const hasPrice = line.price !== undefined && line.price !== null && line.price !== '';
    const price = hasPrice ? parseFloat(line.price) : parseFloat(item.sale_price);
    if (!isFinite(price) || price < 0) {
      throw new Error(`Invalid price for ${item.name}`);
    }
    const gstRaw = line.gst_percent !== undefined && line.gst_percent !== null && line.gst_percent !== '' ? parseFloat(line.gst_percent) : NaN;
    const gst = isFinite(gstRaw) ? gstRaw : (parseFloat(item.gst_percent) || 0);

    const lineTotal = Math.round(price * qty * 100) / 100;
    prepared.push({
      item_id: item.id,
      code: item.code,
      name: item.name,
      quantity: qty,
      price: price,
      gst_percent: gst,
      line_total: lineTotal,
      line_tax: Math.round(lineTotal * gst / 100 * 100) / 100
    });
  }
  return prepared;
}

function createCreditNote(items, options = {}) {
  const {
    partyId = null,
    invoiceId = null,
    reason = '',
    userId = null
  } = options;
  let partyName = options.partyName || '';

  if (!items || items.length === 0) {
    throw new Error('Items are required');
  }

  const prepared = resolveDocLines(items, 'Unknown item in credit note');
  let subtotal = 0;
  let tax = 0;
  let total = 0;

  for (const item of prepared) {
    subtotal += item.line_total;
    tax += item.line_tax;
    total += item.line_total + item.line_tax;
  }

  return withTransaction((db) => {
    const creditNoteNo = generateNextNumber(db, 'credit_notes', 'credit_note_no', 'CN');
    
    // Get party details if partyId is provided
    if (partyId) {
      const partyStmt = db.prepare('SELECT * FROM parties WHERE id = ?');
      partyStmt.bind([partyId]);
      const party = partyStmt.getAsObject({})[0];
      partyStmt.free();
      
      if (party) {
        partyName = party.name;
      }
    }

    const now = new Date().toISOString();
    
    // Insert credit note
    const cnStmt = db.prepare(`
      INSERT INTO credit_notes (credit_note_no, party_id, party_name, invoice_id,
        subtotal, tax, total, reason, status, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    cnStmt.run([
      creditNoteNo,
      partyId,
      partyName,
      invoiceId,
      subtotal,
      tax,
      total,
      reason,
      'pending',
      userId,
      now
    ]);
    cnStmt.free();

    const creditNoteId = db.prepare('SELECT last_insert_rowid() as id').getAsObject({})[0].id;

    // Insert credit note items
    const itemStmt = db.prepare(`
      INSERT INTO credit_note_items (credit_note_id, item_id, code, name, quantity, price, gst_percent, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of prepared) {
      itemStmt.run([
        creditNoteId,
        item.item_id,
        item.code,
        item.name,
        item.quantity,
        item.price,
        item.gst_percent,
        item.line_total
      ]);
    }
    itemStmt.free();

    // Get complete credit note with items
    const cnStmt2 = db.prepare('SELECT * FROM credit_notes WHERE id = ?');
    cnStmt2.bind([creditNoteId]);
    const creditNote = cnStmt2.getAsObject({})[0];
    cnStmt2.free();

    const linesStmt = db.prepare('SELECT * FROM credit_note_items WHERE credit_note_id = ?');
    linesStmt.bind([creditNoteId]);
    const lines = [];
    while (linesStmt.step()) {
      lines.push(linesStmt.getAsObject());
    }
    linesStmt.free();

    creditNote.items = lines;
    return creditNote;
  });
}

function createDebitNote(items, options = {}) {
  const {
    partyId = null,
    invoiceId = null,
    reason = '',
    userId = null
  } = options;
  let partyName = options.partyName || '';

  if (!items || items.length === 0) {
    throw new Error('Items are required');
  }

  const prepared = resolveDocLines(items, 'Unknown item in debit note');
  let subtotal = 0;
  let tax = 0;
  let total = 0;

  for (const item of prepared) {
    subtotal += item.line_total;
    tax += item.line_tax;
    total += item.line_total + item.line_tax;
  }

  return withTransaction((db) => {
    const debitNoteNo = generateNextNumber(db, 'debit_notes', 'debit_note_no', 'DN');
    
    // Get party details if partyId is provided
    if (partyId) {
      const partyStmt = db.prepare('SELECT * FROM parties WHERE id = ?');
      partyStmt.bind([partyId]);
      const party = partyStmt.getAsObject({})[0];
      partyStmt.free();
      
      if (party) {
        partyName = party.name;
      }
    }

    const now = new Date().toISOString();
    
    // Insert debit note
    const dnStmt = db.prepare(`
      INSERT INTO debit_notes (debit_note_no, party_id, party_name, invoice_id,
        subtotal, tax, total, reason, status, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    dnStmt.run([
      debitNoteNo,
      partyId,
      partyName,
      invoiceId,
      subtotal,
      tax,
      total,
      reason,
      'pending',
      userId,
      now
    ]);
    dnStmt.free();

    const debitNoteId = db.prepare('SELECT last_insert_rowid() as id').getAsObject({})[0].id;

    // Insert debit note items
    const itemStmt = db.prepare(`
      INSERT INTO debit_note_items (debit_note_id, item_id, code, name, quantity, price, gst_percent, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of prepared) {
      itemStmt.run([
        debitNoteId,
        item.item_id,
        item.code,
        item.name,
        item.quantity,
        item.price,
        item.gst_percent,
        item.line_total
      ]);
    }
    itemStmt.free();

    // Get complete debit note with items
    const dnStmt2 = db.prepare('SELECT * FROM debit_notes WHERE id = ?');
    dnStmt2.bind([debitNoteId]);
    const debitNote = dnStmt2.getAsObject({})[0];
    dnStmt2.free();

    const linesStmt = db.prepare('SELECT * FROM debit_note_items WHERE debit_note_id = ?');
    linesStmt.bind([debitNoteId]);
    const lines = [];
    while (linesStmt.step()) {
      lines.push(linesStmt.getAsObject());
    }
    linesStmt.free();

    debitNote.items = lines;
    return debitNote;
  });
}

function listCreditNotes(limit = 200) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM credit_notes ORDER BY id DESC LIMIT ?');
  stmt.bind([limit]);
  const notes = [];
  
  while (stmt.step()) {
    notes.push(stmt.getAsObject());
  }
  stmt.free();
  return notes;
}

function listDebitNotes(limit = 200) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM debit_notes ORDER BY id DESC LIMIT ?');
  stmt.bind([limit]);
  const notes = [];
  
  while (stmt.step()) {
    notes.push(stmt.getAsObject());
  }
  stmt.free();
  return notes;
}

function getCreditNote(creditNoteId) {
  const db = getDatabase();
  const cnStmt = db.prepare('SELECT * FROM credit_notes WHERE id = ?');
  cnStmt.bind([creditNoteId]);
  const cnResult = cnStmt.getAsObject();
  cnStmt.free();

  if (cnResult.length === 0) return null;

  const creditNote = cnResult[0];

  const itemsStmt = db.prepare('SELECT * FROM credit_note_items WHERE credit_note_id = ?');
  itemsStmt.bind([creditNoteId]);
  creditNote.items = [];
  while (itemsStmt.step()) {
    creditNote.items.push(itemsStmt.getAsObject());
  }
  itemsStmt.free();

  return creditNote;
}

function getDebitNote(debitNoteId) {
  const db = getDatabase();
  const dnStmt = db.prepare('SELECT * FROM debit_notes WHERE id = ?');
  dnStmt.bind([debitNoteId]);
  const dnResult = dnStmt.getAsObject();
  dnStmt.free();

  if (dnResult.length === 0) return null;

  const debitNote = dnResult[0];

  const itemsStmt = db.prepare('SELECT * FROM debit_note_items WHERE debit_note_id = ?');
  itemsStmt.bind([debitNoteId]);
  debitNote.items = [];
  while (itemsStmt.step()) {
    debitNote.items.push(itemsStmt.getAsObject());
  }
  itemsStmt.free();

  return debitNote;
}

function updateCreditNoteStatus(creditNoteId, status) {
  const validStatuses = ['pending', 'applied', 'cancelled'];
  if (!validStatuses.includes(status)) {
    throw new Error('Invalid status');
  }

  return withTransaction((db) => {
    db.run('UPDATE credit_notes SET status = ? WHERE id = ?', [status, creditNoteId]);
    return getCreditNote(creditNoteId);
  });
}

function updateDebitNoteStatus(debitNoteId, status) {
  const validStatuses = ['pending', 'applied', 'cancelled'];
  if (!validStatuses.includes(status)) {
    throw new Error('Invalid status');
  }

  return withTransaction((db) => {
    db.run('UPDATE debit_notes SET status = ? WHERE id = ?', [status, debitNoteId]);
    return getDebitNote(debitNoteId);
  });
}

function deleteCreditNote(creditNoteId) {
  return withTransaction((db) => {
    db.run('DELETE FROM credit_note_items WHERE credit_note_id = ?', [creditNoteId]);
    db.run('DELETE FROM credit_notes WHERE id = ?', [creditNoteId]);
  });
}

function deleteDebitNote(debitNoteId) {
  return withTransaction((db) => {
    db.run('DELETE FROM debit_note_items WHERE debit_note_id = ?', [debitNoteId]);
    db.run('DELETE FROM debit_notes WHERE id = ?', [debitNoteId]);
  });
}

module.exports = {
  createCreditNote,
  createDebitNote,
  listCreditNotes,
  listDebitNotes,
  getCreditNote,
  getDebitNote,
  updateCreditNoteStatus,
  updateDebitNoteStatus,
  deleteCreditNote,
  deleteDebitNote
};