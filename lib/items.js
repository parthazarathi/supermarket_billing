const { getDatabase, withTransaction, execToObject, execToObjects } = require('./database');
const { getSetting } = require('./settings');
const { getResourceDir } = require('./paths');
const fs = require('fs');
const path = require('path');

const LOW_STOCK_DEFAULT = 5;

function listItems(search = '', category = '') {
  let query = 'SELECT * FROM items WHERE 1=1';

  if (search) {
    const safeSearch = search.replace(/'/g, "''");
    query += ` AND (code LIKE '%${safeSearch}%' OR name LIKE '%${safeSearch}%')`;
  }

  if (category) {
    const safeCategory = category.replace(/'/g, "''");
    query += ` AND category = '${safeCategory}'`;
  }

  query += ' ORDER BY name';

  return execToObjects(query);
}

function getItemByCode(code) {
  const safeCode = code.trim().replace(/'/g, "''");
  return execToObject(`SELECT * FROM items WHERE code = '${safeCode}'`);
}

function getItem(itemId) {
  return execToObject(`SELECT * FROM items WHERE id = ${itemId}`);
}

function categories() {
  const results = execToObjects('SELECT DISTINCT category FROM items WHERE category IS NOT NULL AND category != "" ORDER BY category');
  return results.map(row => row.category);
}

function saveItem(data, itemId = null) {
  const now = new Date().toISOString();
  const rawPurchase = parseFloat(data.purchase_price);
  const rawSale = parseFloat(data.sale_price);
  const rawMRP = parseFloat(data.mrp);
  const purchasePrice = isNaN(rawPurchase) ? 0 : rawPurchase;
  const draftMRP = isNaN(rawMRP) || rawMRP === 0 ? null : rawMRP;
  let salePrice = isNaN(rawSale) || rawSale === 0 ? (draftMRP !== null ? draftMRP : purchasePrice * 1.2) : rawSale;
  let mrp = draftMRP !== null ? draftMRP : (salePrice > 0 ? salePrice : purchasePrice * 1.2);

  if (purchasePrice < 0 || salePrice < 0 || mrp < 0) {
    throw new Error('Purchase price, sale price and MRP cannot be negative');
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

  const fields = {
    code: (data.code || '').trim().replace(/'/g, "''"),
    name: (data.name || '').trim().replace(/'/g, "''"),
    category: (data.category || 'General').replace(/'/g, "''"),
    hsn: (data.hsn || '').replace(/'/g, "''"),
    gst_percent: isNaN(parseFloat(data.gst_percent)) ? parseFloat(getSetting('default_gst', '18')) || 18 : parseFloat(data.gst_percent),
    purchase_price: purchasePrice,
    mrp: mrp,
    sale_price: salePrice,
    stock: parseFloat(data.stock) || 0,
    unit: (data.unit || 'pcs').replace(/'/g, "''"),
    low_stock: parseFloat(data.low_stock) || LOW_STOCK_DEFAULT,
    updated_at: now
  };

  if (fields.stock <= 0) {
    throw new Error('Stock must be greater than 0');
  }

  if (!fields.code || !fields.name) {
    throw new Error('Item code and name are required');
  }

  const existingCode = execToObject(`SELECT * FROM items WHERE code = '${fields.code}' LIMIT 1`);
  if (existingCode && existingCode.id !== itemId) {
    throw new Error('An item with this barcode already exists');
  }

  const existingName = execToObject(`SELECT * FROM items WHERE name = '${fields.name}' LIMIT 1`);
  if (existingName && existingName.id !== itemId) {
    throw new Error('An item with this name already exists');
  }

  return withTransaction((db) => {
    try {
      if (itemId) {
        db.run(`
          UPDATE items SET code='${fields.code}', name='${fields.name}', category='${fields.category}', hsn='${fields.hsn}', 
          gst_percent=${fields.gst_percent}, purchase_price=${fields.purchase_price}, mrp=${fields.mrp},
          sale_price=${fields.sale_price}, stock=${fields.stock}, unit='${fields.unit}', 
          low_stock=${fields.low_stock}, updated_at='${now}'
          WHERE id=${itemId}
        `);
        return execToObject(`SELECT * FROM items WHERE id = ${itemId}`);
      } else {
        db.run(`
          INSERT INTO items (code, name, category, hsn, gst_percent, purchase_price, mrp, sale_price,
            stock, unit, low_stock, created_at, updated_at)
          VALUES ('${fields.code}', '${fields.name}', '${fields.category}', '${fields.hsn}', ${fields.gst_percent},
          ${fields.purchase_price}, ${fields.mrp}, ${fields.sale_price}, ${fields.stock}, '${fields.unit}', ${fields.low_stock},
          '${now}', '${now}')
        `);
        return execToObject(`SELECT * FROM items WHERE code = '${fields.code}'`);
      }
    } catch (error) {
      if (error.message && error.message.includes('UNIQUE constraint failed')) {
        throw new Error('Item code already exists');
      }
      throw error;
    }
  });
}

function deleteItem(itemId) {
  return withTransaction((db) => {
    db.run(`DELETE FROM items WHERE id = ${itemId}`);
  });
}

function adjustStock(db, itemId, delta) {
  const now = new Date().toISOString();
  db.run(`UPDATE items SET stock = stock + ${delta}, updated_at = '${now}' WHERE id = ${itemId}`);
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
      const safeCode = String(code).trim().replace(/'/g, "''");
      const safeName = String(info.name).trim().replace(/'/g, "''");
      const safeCategory = String(info.category || 'General').trim().replace(/'/g, "''");
      
      try {
        db.run(`
          INSERT OR IGNORE INTO items (code, name, category, hsn, gst_percent, purchase_price, mrp, sale_price,
            stock, unit, low_stock, created_at, updated_at)
          VALUES ('${safeCode}', '${safeName}', '${safeCategory}', '', 18, ${Math.round(price * 0.7 * 100) / 100}, ${price}, ${price},
          50, 'pcs', ${LOW_STOCK_DEFAULT}, '${now}', '${now}')
        `);
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
  deleteItem,
  adjustStock,
  seedItemsFromJson
};
