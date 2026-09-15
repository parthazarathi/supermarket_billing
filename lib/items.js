const { getDatabase, withTransaction, execToObject, execToObjects } = require('./database');
const { getSetting } = require('./settings');
const { getResourceDir } = require('./paths');
const fs = require('fs');
const path = require('path');

const LOW_STOCK_DEFAULT = 5;

const ITEM_IMPORT_FIELDS = ['code', 'name', 'category', 'hsn', 'gst_percent', 'purchase_price', 'mrp', 'sale_price', 'stock', 'unit', 'low_stock'];

function listItems(search = '', category = '') {
  let query = 'SELECT * FROM items WHERE 1=1';
  const params = [];

  if (search) {
    const escaped = String(search).replace(/[\\%_]/g, (c) => `\\${c}`);
    query += " AND (code LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')";
    params.push(`%${escaped}%`, `%${escaped}%`);
  }

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }

  query += ' ORDER BY name';

  return execToObjects(query, params);
}

function getItemByCode(code) {
  return execToObject('SELECT * FROM items WHERE code = ?', [code.trim()]);
}

function getItem(itemId) {
  return execToObject('SELECT * FROM items WHERE id = ?', [itemId]);
}

function categories() {
  const results = execToObjects('SELECT DISTINCT category FROM items WHERE category IS NOT NULL AND category != "" ORDER BY category');
  return results.map(row => row.category);
}

function saveItem(data, itemId = null) {
  const now = new Date().toISOString();
  const provided = (v) => v !== undefined && v !== null && v !== '';

  const rawPurchase = provided(data.purchase_price) ? parseFloat(data.purchase_price) : NaN;
  if (provided(data.purchase_price) && !isFinite(rawPurchase)) {
    throw new Error('Invalid purchase price');
  }
  const rawMRP = provided(data.mrp) ? parseFloat(data.mrp) : NaN;
  if (provided(data.mrp) && !isFinite(rawMRP)) {
    throw new Error('Invalid MRP');
  }
  const purchasePrice = isFinite(rawPurchase) ? rawPurchase : 0;
  const draftMRP = isFinite(rawMRP) && rawMRP !== 0 ? rawMRP : null;

  let salePrice;
  if (provided(data.sale_price)) {
    salePrice = parseFloat(data.sale_price);
    if (!isFinite(salePrice) || salePrice <= 0) {
      throw new Error('Sale price must be greater than 0');
    }
  } else {
    salePrice = draftMRP !== null ? draftMRP : purchasePrice * 1.2;
  }
  let mrp = draftMRP !== null ? draftMRP : (salePrice > 0 ? salePrice : purchasePrice * 1.2);

  if (purchasePrice <= 0 || salePrice < 0 || mrp < 0) {
    throw new Error('Purchase price must be greater than 0 and sale price and MRP cannot be negative');
  }
  if (salePrice <= purchasePrice) {
    throw new Error('Sale price must be higher than purchase price');
  }
  if (mrp <= purchasePrice) {
    throw new Error('MRP must be higher than purchase price');
  }
  if (mrp <= 0) {
    throw new Error('MRP must be greater than 0');
  }
  if (salePrice > mrp) {
    throw new Error('Sale price cannot be greater than MRP');
  }

  let gstPercent;
  if (provided(data.gst_percent)) {
    gstPercent = parseFloat(data.gst_percent);
    const GST_SLABS = [0, 0.25, 3, 5, 12, 18, 28];
    if (!isFinite(gstPercent) || !GST_SLABS.includes(gstPercent)) {
      throw new Error('GST percent must be one of 0, 0.25, 3, 5, 12, 18, 28');
    }
  } else {
    gstPercent = parseFloat(getSetting('default_gst', '18')) || 18;
  }

  let stock;
  if (provided(data.stock)) {
    stock = parseFloat(data.stock);
    if (!isFinite(stock)) {
      throw new Error('Invalid stock');
    }
  } else {
    stock = 0;
  }

  const fields = {
    code: (data.code || '').trim(),
    name: (data.name || '').trim(),
    category: data.category || 'General',
    hsn: data.hsn || '',
    gst_percent: gstPercent,
    purchase_price: purchasePrice,
    mrp: mrp,
    sale_price: salePrice,
    stock: stock,
    unit: data.unit || 'pcs',
    low_stock: parseFloat(data.low_stock) || LOW_STOCK_DEFAULT,
    updated_at: now
  };

  if (fields.stock < 0) {
    throw new Error('Stock cannot be negative');
  }

  if (!fields.code || !fields.name) {
    throw new Error('Item code and name are required');
  }

  if (fields.name.length > 200) {
    throw new Error('Item name is too long');
  }

  const existingCode = execToObject('SELECT * FROM items WHERE code = ? LIMIT 1', [fields.code]);
  if (existingCode && existingCode.id !== itemId) {
    throw new Error('An item with this barcode already exists');
  }

  const existingName = execToObject('SELECT * FROM items WHERE name = ? LIMIT 1', [fields.name]);
  if (existingName && existingName.id !== itemId) {
    throw new Error('An item with this name already exists');
  }

  return withTransaction((db) => {
    try {
      if (itemId) {
        db.run(
          'UPDATE items SET code=?, name=?, category=?, hsn=?, gst_percent=?, purchase_price=?, mrp=?, sale_price=?, stock=?, unit=?, low_stock=?, updated_at=? WHERE id=?',
          [fields.code, fields.name, fields.category, fields.hsn, fields.gst_percent,
            fields.purchase_price, fields.mrp, fields.sale_price, fields.stock, fields.unit,
            fields.low_stock, now, itemId]
        );
        return execToObject('SELECT * FROM items WHERE id = ?', [itemId]);
      } else {
        db.run(
          'INSERT INTO items (code, name, category, hsn, gst_percent, purchase_price, mrp, sale_price, stock, unit, low_stock, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [fields.code, fields.name, fields.category, fields.hsn, fields.gst_percent,
            fields.purchase_price, fields.mrp, fields.sale_price, fields.stock, fields.unit,
            fields.low_stock, now, now]
        );
        return execToObject('SELECT * FROM items WHERE code = ?', [fields.code]);
      }
    } catch (error) {
      if (error.message && error.message.includes('UNIQUE constraint failed')) {
        throw new Error('Item code already exists');
      }
      throw error;
    }
  });
}

function importItems(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Import must contain at least one product');
  if (rows.length > 5000) throw new Error('Import cannot contain more than 5000 products');
  return withTransaction(() => {
    const seenCodes = new Set();
    let created = 0;
    let updated = 0;
    rows.forEach((row, index) => {
      const rowNumber = index + 2;
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Row ${rowNumber}: Invalid product data`);
      const clean = {};
      ITEM_IMPORT_FIELDS.forEach((field) => {
        const value = typeof row[field] === 'string' ? row[field].trim() : row[field];
        if (value !== undefined && value !== null && value !== '') clean[field] = value;
      });
      clean.code = String(clean.code || '').trim();
      clean.name = String(clean.name || '').trim();
      if (!clean.code || !clean.name) throw new Error(`Row ${rowNumber}: Barcode / code and name are required`);
      if (seenCodes.has(clean.code)) throw new Error(`Row ${rowNumber}: Duplicate barcode / code in import: ${clean.code}`);
      seenCodes.add(clean.code);
      const existing = getItemByCode(clean.code);
      try {
        saveItem(existing ? { ...existing, ...clean } : clean, existing ? existing.id : null);
      } catch (error) {
        throw new Error(`Row ${rowNumber} (${clean.code}): ${error.message}`);
      }
      if (existing) updated += 1;
      else created += 1;
    });
    return { total: rows.length, created, updated };
  });
}

function deleteItem(itemId) {
  return withTransaction((db) => {
    const refs = execToObject(
      `SELECT (SELECT COUNT(*) FROM invoice_items WHERE item_id = ?) +
              (SELECT COUNT(*) FROM purchase_items WHERE item_id = ?) as refs`,
      [itemId, itemId]
    );
    if (refs && refs.refs > 0) {
      throw new Error('Item has transaction history and cannot be deleted');
    }
    db.run('DELETE FROM items WHERE id = ?', [itemId]);
  });
}

function adjustStock(db, itemId, delta) {
  const now = new Date().toISOString();
  db.run('UPDATE items SET stock = stock + ?, updated_at = ? WHERE id = ?', [delta, now, itemId]);
}

function seedItemsFromJson() {
  const db = getDatabase();
  const seedPath = path.join(__dirname, '..', 'data', 'products.json');
  
  if (!fs.existsSync(seedPath)) {
    console.log('Products seed file not found, skipping...');
    return;
  }

  const products = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const now = new Date().toISOString();

  const countResult = execToObject('SELECT COUNT(*) as count FROM items');
  if (countResult && countResult.count > 0) {
    console.log('Items already seeded, skipping...');
    return; // Already seeded
  }

  return withTransaction((db) => {
    for (const [code, info] of Object.entries(products)) {
      if (!code || !info.name) {
        console.log('Skipping invalid item:', code, info);
        continue;
      }
      
      const price = parseFloat(info.price) || 0;
      const safeCode = String(code).trim();
      const safeName = String(info.name).trim();
      const safeCategory = String(info.category || 'General').trim();

      try {
        db.run(
          'INSERT OR IGNORE INTO items (code, name, category, hsn, gst_percent, purchase_price, mrp, sale_price, stock, unit, low_stock, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [safeCode, safeName, safeCategory, '', 18, Math.round(price * 0.7 * 100) / 100, price, price,
            50, 'pcs', LOW_STOCK_DEFAULT, now, now]
        );
      } catch (error) {
        console.error('Error seeding item:', code, error.message);
      }
    }
    console.log('Items seeded successfully');
  });
}

module.exports = {
  listItems,
  getItemByCode,
  getItem,
  categories,
  saveItem,
  importItems,
  deleteItem,
  adjustStock,
  seedItemsFromJson
};
