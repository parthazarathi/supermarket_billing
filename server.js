const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('./lib/logger').installFileLogging();
const { getDataDir } = require('./lib/paths');
const { initDatabase, flushSave, execToObject, dbInfo } = require('./lib/database');
const { seedItemsFromJson } = require('./lib/items');

// Import business logic modules
const { authenticate, listUsers, createUser, updateUserPassword, deleteUser, getUserById } = require('./lib/users');
const { getSetting, getSettings, setSettings } = require('./lib/settings');
const { listItems, getItemByCode, getItem, categories, saveItem, importItems, deleteItem } = require('./lib/items');
const { listParties, getParty, saveParty, deleteParty, addPartyPayment, checkCreditLimit } = require('./lib/parties');
const { calculateCartTotals } = require('./lib/cart');
const { completeSale, listInvoices, getInvoice, getInvoiceByNo, recordInvoicePayment, createSaleReturn, cancelInvoice, updateInvoice, deleteInvoice } = require('./lib/invoices');
const { verifyBillPasscode } = require('./lib/passcode');
const { completePurchase, listPurchases, getPurchase, updatePurchase, deletePurchase } = require('./lib/purchases');
const { createPurchaseReturn, listPurchaseReturns } = require('./lib/purchaseReturns');
const { createStockAdjustment, listStockAdjustments } = require('./lib/stockAdjustments');
const { openSession, closeSession, currentSession } = require('./lib/cashSessions');
const { logAudit } = require('./lib/audit');
const { parseRange } = require('./lib/reportUtils');
const { addExpense, listExpenses, getExpense, deleteExpense } = require('./lib/expenses');
const { holdBill, listHeldBills, recallHeldBill } = require('./lib/heldBills');
const reportLib = require('./lib/reports');
const { dashboard, reports } = reportLib;
const { generateInvoicePDF } = require('./lib/pdfGenerator');
const { generateUPIQRCode, buildUPIDeeplink } = require('./lib/upi');
const { sendBill, sendTestMessage, retryBill, normalizeWhatsAppNumber, whatsappStatus, latestStatusMap, attemptsFor, friendlyError, registerCloudOwner, loginCloudOwner, logoutCloudOwner, connectWhatsApp, disconnectWhatsApp, startWhatsAppWorker, stopWhatsAppWorker, refreshWhatsAppStatus } = require('./lib/whatsapp');
const { status: driveStatus, connectOAuth, disconnect, backupDatabase, listBackups, prepareRestore, applyStagedRestore, restoreDatabase, testConnection: testDrive, tryAutoBackup, isBackupDue, DriveError, cleanupStaging } = require('./lib/driveSync');

const { createLocalBackup, isLocalBackupDue, listLocalBackups, describeBackupFile, applyRestoreFile, listHistory, backupDir } = require('./lib/backup');
const { appVersion } = require('./lib/version');
const APP_VERSION = appVersion();
const { createEstimate, listEstimates, getEstimate, getEstimateByNo, updateEstimate, convertEstimateToInvoice, deleteEstimate } = require('./lib/estimates');
const { createDeliveryChallan, listDeliveryChallans, getDeliveryChallan, getDeliveryChallanByNo, updateDeliveryChallanStatus, linkChallanToInvoice, deleteDeliveryChallan } = require('./lib/deliveryChallans');
const { createCreditNote, createDebitNote, listCreditNotes, listDebitNotes, getCreditNote, getDebitNote, updateCreditNoteStatus, updateDebitNoteStatus, deleteCreditNote, deleteDebitNote } = require('./lib/creditDebitNotes');
const { createPurchaseOrder, listPurchaseOrders, getPurchaseOrder, getPurchaseOrderByNo, updatePurchaseOrderStatus, convertPurchaseOrderToPurchase, deletePurchaseOrder } = require('./lib/purchaseOrders');
const { listAccounts, getAccount, saveAccount, deleteAccount, createTransaction, listAccountTransactions, getDefaultAccount } = require('./lib/accounts');
const aiService = require('./lib/ai/service');
const { listAiAudit } = require('./lib/ai/audit');

const ROLE_LEVEL = { cashier: 1, manager: 2, admin: 3 };

const app = express();
const PORT = parseInt(process.env.PORT || '5000', 10);

// Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for development (enable in production)
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }
  if (process.env.FLASK_SECRET_KEY) {
    return process.env.FLASK_SECRET_KEY;
  }

  const secretPath = path.join(getDataDir(), 'session-secret.txt');
  try {
    if (fs.existsSync(secretPath)) {
      const existing = fs.readFileSync(secretPath, 'utf8').trim();
      if (existing) {
        return existing;
      }
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, generated, { mode: 0o600 });
    console.log('Using auto-generated session secret from data dir; set SESSION_SECRET for production.');
    return generated;
  } catch (error) {
    console.log('Using auto-generated session secret from data dir; set SESSION_SECRET for production.');
    return crypto.randomBytes(32).toString('hex');
  }
}

app.use(session({
  secret: resolveSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.SESSION_SECURE_COOKIE === '1' } // Set SESSION_SECURE_COOKIE=1 in production with HTTPS
}));

// Serve static files from templates directory
const templatesDir = path.join(__dirname, 'templates');
app.use('/style.css', express.static(path.join(templatesDir, 'style.css')));
app.use('/script.js', express.static(path.join(templatesDir, 'script.js')));
app.use('/reports.js', express.static(path.join(templatesDir, 'reports.js')));
app.use('/receipt.js', express.static(path.join(templatesDir, 'receipt.js')));
app.use('/ai.js', express.static(path.join(templatesDir, 'ai.js')));
app.use('/vendor', express.static(path.join(templatesDir, 'vendor')));

// Helper functions
function jsonError(message, status = 400) {
  return { ok: false, error: message };
}

// sql.js throws plain non-Error objects on bind/constraint failures, so
// error.message is not reliable - always surface a string.
function errMsg(e) {
  return (e && e.message) || String(e);
}

// Settings safe to send to the client: never expose the passcode hash,
// only whether one is configured. Any *_token / *_secret / *_hash style
// key is also withheld as defense-in-depth - API credentials live in
// lib/secrets, but a stray secret key must never leak via the API.
function publicSettings(settings) {
  const all = { ...(settings || getSettings()) };
  const out = {};
  for (const [key, value] of Object.entries(all)) {
    if (/_token$|_secret$|_hash$/.test(key)) continue;
    out[key] = value;
  }
  out.bill_passcode_set = !!all.bill_passcode_hash;
  return out;
}

function currentUser(req) {
  return req.session.user || null;
}

function loginRequired(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    return res.status(401).json(jsonError('Login required'));
  }
  // Drop sessions whose user no longer exists (deleted account)
  if (!getUserById(user.id)) {
    req.session.destroy();
    return res.status(401).json(jsonError('Login required'));
  }
  next();
}

function requireRole(minRole) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user) {
      return res.status(401).json(jsonError('Login required'));
    }
    if (!getUserById(user.id)) {
      req.session.destroy();
      return res.status(401).json(jsonError('Login required'));
    }
    const userLevel = ROLE_LEVEL[user.role] || 0;
    const requiredLevel = ROLE_LEVEL[minRole] || 99;
    if (userLevel < requiredLevel) {
      return res.status(403).json(jsonError('Not allowed for this role'));
    }
    next();
  };
}

// Audit helper - records an action for the current user without failing the request
function audit(req, action, module, reference, description, oldValue, newValue) {
  const user = currentUser(req) || {};
  logAudit({
    userId: user.id || null,
    username: user.username || '',
    action,
    module,
    reference,
    oldValue,
    newValue,
    description: description || ''
  });
}

function getPosId(req) {
  return ((req.body || {}).pos_id) || (req.query || {}).pos_id || 'default';
}

function getCartState(req) {
  const posId = getPosId(req);
  if (!req.session.carts) {
    req.session.carts = {};
  }
  if (!req.session.carts[posId]) {
    req.session.carts[posId] = {
      items: {},
      billDiscount: 0,
      partyId: null,
      partyName: '',
      partyPhone: '',
    };
  }
  return { posId, state: req.session.carts[posId] };
}

function getCart(req) {
  return getCartState(req).state.items;
}

function saveCart(req, cart) {
  getCartState(req).state.items = cart;
}

function cartPayload(req) {
  const { state } = getCartState(req);
  const discount = parseFloat(state.billDiscount) || 0;
  const totals = calculateCartTotals(state.items, discount);
  totals.party_id = state.partyId;
  totals.party_name = state.partyName || '';
  totals.party_phone = state.partyPhone || '';
  return totals;
}

// Runs scheduled backups when due: a local snapshot is taken even without
// internet or Google Drive, and a Drive upload happens when connected.
// Failures are logged and never thrown - billing must never be interrupted.
async function maybeAutoBackup() {
  try {
    if (isLocalBackupDue()) {
      const local = await createLocalBackup('automatic');
      if (!local.ok) console.error('Local auto-backup failed:', local.error);
    }
    if (!isBackupDue()) {
      return;
    }
    const result = await tryAutoBackup();
    if (!result.ok) {
      console.error('Auto-backup failed:', result.error);
    }
  } catch (error) {
    console.error('Auto-backup failed:', error);
  }
}

// Routes
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'templates', 'index.html');
  res.sendFile(indexPath);
});

// API: Current user info
app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  if (!user) {
    return res.json({ ok: true, user: null, settings: publicSettings() });
  }
  // Cashiers get cloud status without the local file paths - they need the
  // connected/not-connected dots for billing, not server internals.
  const drive = driveStatus();
  if (user.role !== 'admin') {
    delete drive.credentials_path;
    delete drive.token_path;
  }
  res.json({
    ok: true,
    user: user,
    must_change_password: getSetting('must_change_password', '0') === '1' && user.role === 'admin',
    settings: publicSettings(),
    drive,
    whatsapp: whatsappStatus()
  });
});

// Failed-attempt rate limiting. Login: 10 failures / 15 min per IP.
// Bill passcode: 5 failures / 10 min per IP+user.
function makeAttemptLimiter(maxFailures, windowMs) {
  const attempts = new Map();

  const prune = (now) => {
    for (const [key, entry] of attempts) {
      if (now - entry.firstAt > windowMs && (!entry.lockedUntil || now > entry.lockedUntil)) {
        attempts.delete(key);
      }
    }
  };

  return {
    // Returns minutes remaining if locked, else 0
    lockedFor(key) {
      const now = Date.now();
      prune(now);
      const entry = attempts.get(key);
      if (entry && entry.lockedUntil && now < entry.lockedUntil) {
        return Math.ceil((entry.lockedUntil - now) / 60000);
      }
      return 0;
    },
    // Records a failure; returns lock minutes if this failure triggered a lock, else 0
    fail(key) {
      const now = Date.now();
      prune(now);
      const entry = attempts.get(key);
      if (!entry || now - entry.firstAt > windowMs) {
        attempts.set(key, { count: 1, firstAt: now, lockedUntil: 0 });
      } else {
        entry.count += 1;
        if (entry.count > maxFailures) {
          entry.lockedUntil = entry.firstAt + windowMs;
        }
      }
      const record = attempts.get(key);
      if (record.lockedUntil && now < record.lockedUntil) {
        return Math.ceil((record.lockedUntil - now) / 60000);
      }
      return 0;
    },
    reset(key) {
      attempts.delete(key);
    }
  };
}

const loginLimiter = makeAttemptLimiter(10, 15 * 60 * 1000);
const passcodeLimiter = makeAttemptLimiter(5, 10 * 60 * 1000);

// Verifies the bill passcode for edit/delete. Responds and returns false on failure.
function checkBillPasscode(req, res, reference) {
  const result = verifyBillPasscode((req.body || {}).passcode);
  if (!result.configured) {
    res.status(403).json(jsonError('Bill passcode not configured. Set it in Settings.'));
    return false;
  }
  const user = currentUser(req) || {};
  const key = `${req.ip}:${user.id || ''}`;
  const locked = passcodeLimiter.lockedFor(key);
  if (locked) {
    res.status(429).json(jsonError(`Too many passcode attempts. Try again in ${locked} minutes.`));
    return false;
  }
  if (!result.ok) {
    audit(req, 'passcode_failed', 'sales', reference || '', 'Incorrect bill passcode entered');
    const minutes = passcodeLimiter.fail(key);
    if (minutes) {
      res.status(429).json(jsonError(`Too many passcode attempts. Try again in ${minutes} minutes.`));
    } else {
      res.status(401).json(jsonError('Incorrect passcode'));
    }
    return false;
  }
  passcodeLimiter.reset(key);
  return true;
}

// Authentication
app.post('/api/login', (req, res) => {
  const username = String((req.body || {}).username || '');
  const password = String((req.body || {}).password || '');
  const ip = req.ip;

  const locked = loginLimiter.lockedFor(ip);
  if (locked) {
    return res.status(429).json(jsonError(`Too many login attempts. Try again in ${locked} minutes.`));
  }

  const user = authenticate(username, password);
  if (!user) {
    const minutes = loginLimiter.fail(ip);
    logAudit({ userId: null, username: username || '', action: 'login_failed', module: 'auth', description: `Failed login attempt for username '${username || ''}'` });
    if (minutes) {
      return res.status(429).json(jsonError(`Too many login attempts. Try again in ${minutes} minutes.`));
    }
    return res.status(401).json(jsonError('Invalid username or password'));
  }

  loginLimiter.reset(ip);
  req.session.user = user;
  req.session.carts = { default: { items: {}, billDiscount: 0, partyId: null, partyName: '', partyPhone: '' } };
  logAudit({ userId: user.id, username: user.username, action: 'login', module: 'auth', description: 'User logged in' });
  res.json({
    ok: true,
    user: user,
    must_change_password: getSetting('must_change_password', '0') === '1' && user.role === 'admin',
    settings: publicSettings()
  });
});

app.post('/api/logout', (req, res) => {
  audit(req, 'logout', 'auth', '', 'User logged out');
  req.session.destroy();
  res.json({ ok: true });
});

// Dashboard
app.get('/api/dashboard', loginRequired, (req, res) => {
  try {
    const range = parseRange(req.query);
    const trend = ['7', '30', 'month'].includes(req.query.trend) ? req.query.trend : '7';
    res.json({ ok: true, dashboard: dashboard(range, trend) });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// Items
app.get('/api/items', loginRequired, (req, res) => {
  const search = req.query.q || '';
  const category = req.query.category || '';
  res.json({
    ok: true,
    items: listItems(search, category),
    categories: categories()
  });
});

app.post('/api/items/import', requireRole('manager'), (req, res) => {
  try {
    const result = importItems(req.body.items);
    audit(req, 'import', 'items', String(result.total), `Imported ${result.total} products`, null, result);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.post('/api/items', requireRole('manager'), (req, res) => {
  try {
    const item = saveItem(req.body);
    audit(req, 'create', 'items', item.code, `Item created: ${item.name}`, null, item);
    res.json({ ok: true, item: item });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.put('/api/items/:id', requireRole('manager'), (req, res) => {
  try {
    const itemId = parseInt(req.params.id);
    if (isNaN(itemId) || !getItem(itemId)) {
      return res.status(404).json(jsonError('Item not found'));
    }
    const item = saveItem(req.body, itemId);
    audit(req, 'update', 'items', item.code, `Item updated: ${item.name}`, null, item);
    res.json({ ok: true, item: item });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.delete('/api/items/:id', requireRole('manager'), (req, res) => {
  try {
    const itemId = parseInt(req.params.id);
    const item = isNaN(itemId) ? null : getItem(itemId);
    if (!item) {
      return res.status(404).json(jsonError('Item not found'));
    }
    deleteItem(itemId);
    audit(req, 'delete', 'items', item.code, `Item deleted: ${item.name}`, item, null);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// Parties
app.get('/api/parties', loginRequired, (req, res) => {
  const type = req.query.type || '';
  res.json({ ok: true, parties: listParties(type) });
});

app.post('/api/parties', requireRole('manager'), (req, res) => {
  try {
    const party = saveParty(req.body);
    audit(req, 'create', 'parties', party.id, `Party created: ${party.name} (${party.type})`);
    res.json({ ok: true, party: party });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.put('/api/parties/:id', requireRole('manager'), (req, res) => {
  try {
    const partyId = parseInt(req.params.id);
    if (isNaN(partyId) || !getParty(partyId)) {
      return res.status(404).json(jsonError('Party not found'));
    }
    const party = saveParty(req.body, partyId);
    audit(req, 'update', 'parties', party.id, `Party updated: ${party.name}`);
    res.json({ ok: true, party: party });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.delete('/api/parties/:id', requireRole('manager'), (req, res) => {
  try {
    const partyId = parseInt(req.params.id);
    const party = isNaN(partyId) ? null : getParty(partyId);
    if (!party) {
      return res.status(404).json(jsonError('Party not found'));
    }
    deleteParty(partyId);
    audit(req, 'delete', 'parties', req.params.id, `Party deleted: ${party.name}`, party, null);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.post('/api/parties/:id/payment', requireRole('manager'), (req, res) => {
  try {
    const payment = addPartyPayment(
      parseInt(req.params.id),
      parseFloat(req.body.amount),
      req.body.method || 'Cash',
      req.body.note || '',
      currentUser(req).id
    );
    const party = getParty(parseInt(req.params.id));
    audit(req, 'payment', 'parties', party ? party.name : req.params.id, `Payment ${req.body.method || 'Cash'} ₹${req.body.amount}`);
    res.json({ ok: true, payment: payment, party: party });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.get('/api/parties/:id/credit-check', loginRequired, (req, res) => {
  try {
    const additionalAmount = parseFloat(req.query.amount) || 0;
    const creditCheck = checkCreditLimit(parseInt(req.params.id), additionalAmount);
    res.json({ ok: true, credit_check: creditCheck });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// Cart operations
app.post('/api/next-bill-no', loginRequired, (req, res) => {
  if (!req.session.billCounter) {
    req.session.billCounter = 0;
  }
  if (!req.session.billFree) {
    req.session.billFree = [];
  }
  if (!req.session.billNos) {
    req.session.billNos = [];
  }

  const today = new Date();
  const dayPrefix = today.getFullYear().toString() +
    String(today.getMonth() + 1).padStart(2, '0') +
    String(today.getDate()).padStart(2, '0');

  let seq;
  let safety = 0;
  do {
    if (req.session.billFree.length > 0) {
      seq = req.session.billFree.shift();
    } else {
      req.session.billCounter += 1;
      seq = req.session.billCounter;
    }
    safety += 1;
  } while (req.session.billNos.includes(seq) && safety < 1000);

  if (!req.session.billNos.includes(seq)) {
    req.session.billNos.push(seq);
  }

  const billNo = `BILL-${dayPrefix}-${String(seq).padStart(4, '0')}`;
  res.json({ ok: true, bill_no: billNo });
});

app.post('/api/release-bill-no', loginRequired, (req, res) => {
  const { bill_no } = req.body || {};
  if (!bill_no || !bill_no.startsWith('BILL-')) {
    return res.json({ ok: true });
  }
  const parts = bill_no.split('-');
  if (parts.length === 3) {
    const seq = parseInt(parts[2], 10);
    if (!isNaN(seq)) {
      if (!req.session.billFree) {
        req.session.billFree = [];
      }
      if (!req.session.billNos) {
        req.session.billNos = [];
      }
      req.session.billNos = req.session.billNos.filter((n) => n !== seq);
      if (!req.session.billFree.includes(seq)) {
        req.session.billFree.push(seq);
        req.session.billFree.sort((a, b) => a - b);
      }
    }
  }
  res.json({ ok: true });
});

app.post('/api/reserve-bill-no', loginRequired, (req, res) => {
  const { bill_no } = req.body || {};
  if (!bill_no || !bill_no.startsWith('BILL-')) {
    return res.json({ ok: true });
  }
  const parts = bill_no.split('-');
  if (parts.length === 3) {
    const seq = parseInt(parts[2], 10);
    if (!isNaN(seq)) {
      if (!req.session.billNos) {
        req.session.billNos = [];
      }
      if (!req.session.billNos.includes(seq)) {
        req.session.billNos.push(seq);
      }
      if (!req.session.billCounter || req.session.billCounter < seq) {
        req.session.billCounter = seq;
      }
    }
  }
  res.json({ ok: true });
});

app.get('/cart', loginRequired, (req, res) => {
  res.json({ ok: true, cart: cartPayload(req) });
});

app.post('/add_to_cart', loginRequired, (req, res) => {
  const { code, quantity } = req.body;
  if (!code) {
    return res.status(400).json(jsonError('Product code is required'));
  }

  const product = getItemByCode(code);
  if (!product) {
    return res.status(404).json(jsonError('Product not found'));
  }

  const sale = parseFloat(product.sale_price) || 0;
  const purchase = parseFloat(product.purchase_price) || 0;
  const mrp = parseFloat(product.mrp) || 0;
  if (sale <= 0) {
    return res.status(400).json(jsonError(`Sale price must be greater than 0 for ${product.name}`));
  }
  if (sale <= purchase) {
    return res.status(400).json(jsonError(`Sale price must be higher than purchase price for ${product.name}`));
  }
  if (mrp > 0 && sale > mrp) {
    return res.status(400).json(jsonError(`Sale price cannot be greater than MRP for ${product.name}`));
  }

  const cart = getCart(req);
  const qty = parseFloat(quantity);
  if (!isFinite(qty) || qty <= 0) {
    return res.status(400).json(jsonError('Invalid quantity'));
  }

  const existingQty = cart[code] ? parseFloat(cart[code].quantity) || 0 : 0;
  const stock = parseFloat(product.stock);
  if (isFinite(stock) && stock >= 0 && existingQty + qty > stock + 1e-9) {
    return res.status(400).json(jsonError('Insufficient stock'));
  }

  if (cart[code]) {
    cart[code].quantity = parseFloat(cart[code].quantity) + qty;
  } else {
    cart[code] = {
      item_id: product.id,
      name: product.name,
      price: parseFloat(product.sale_price),
      mrp: parseFloat(product.mrp) || parseFloat(product.sale_price) || 0,
      category: product.category || 'General',
      quantity: qty,
      gst_percent: parseFloat(product.gst_percent) || 0,
      discount: 0,
      purchase_price: parseFloat(product.purchase_price) || 0,
      stock: product.stock,
      unit: product.unit || 'pcs'
    };
  }

  saveCart(req, cart);
  res.json({ ok: true, cart: cartPayload(req) });
});

app.post('/update_item', loginRequired, (req, res) => {
  const { code, quantity, discount, price } = req.body;
  const cart = getCart(req);

  if (!cart[code]) {
    return res.status(404).json(jsonError('Item not in cart'));
  }

  if (quantity !== undefined) {
    const qty = parseFloat(quantity);
    if (!isFinite(qty)) {
      return res.status(400).json(jsonError('Invalid quantity'));
    }
    if (qty <= 0) {
      delete cart[code];
    } else {
      cart[code].quantity = qty;
    }
  }

  if (discount !== undefined) {
    const disc = parseFloat(discount);
    if (!isFinite(disc) || disc < 0) {
      return res.status(400).json(jsonError('Invalid discount'));
    }
    if (cart[code]) {
      cart[code].discount = disc;
    }
  }

  if (price !== undefined && cart[code]) {
    const newPrice = parseFloat(price);
    if (!isFinite(newPrice) || newPrice <= 0) {
      return res.status(400).json(jsonError('Invalid price'));
    }
    const lineMrp = parseFloat(cart[code].mrp) || 0;
    if (lineMrp > 0 && newPrice > lineMrp) {
      return res.status(400).json(jsonError('Price cannot be greater than MRP'));
    }
    cart[code].price = newPrice;
  }

  saveCart(req, cart);
  res.json({ ok: true, cart: cartPayload(req) });
});

app.post('/remove_item', loginRequired, (req, res) => {
  const { code } = req.body;
  const cart = getCart(req);
  delete cart[code];
  saveCart(req, cart);
  res.json({ ok: true, cart: cartPayload(req) });
});

app.post('/api/cart/clear', loginRequired, (req, res) => {
  getCartState(req).state.items = {};
  getCartState(req).state.billDiscount = 0;
  res.json({ ok: true, cart: cartPayload(req) });
});

app.post('/api/cart/discount', loginRequired, (req, res) => {
  const disc = parseFloat(req.body.discount);
  if (!isFinite(disc) || disc < 0) {
    return res.status(400).json(jsonError('Invalid discount'));
  }
  getCartState(req).state.billDiscount = disc;
  res.json({ ok: true, cart: cartPayload(req) });
});

app.post('/api/cart/party', loginRequired, (req, res) => {
  const { party_id, party_name, phone } = req.body;
  const cartState = getCartState(req).state;

  if (party_id) {
    const party = getParty(parseInt(party_id));
    if (!party) {
      return res.status(404).json(jsonError('Party not found'));
    }
    cartState.partyId = party.id;
    cartState.partyName = party.name;
    cartState.partyPhone = party.phone || '';
  } else {
    cartState.partyId = null;
    cartState.partyName = party_name || 'Walk-in Customer';
    cartState.partyPhone = phone || '';
  }

  res.json({ ok: true, cart: cartPayload(req) });
});

app.post('/api/cart/hold', loginRequired, (req, res) => {
  const cartState = getCartState(req).state;
  const cart = cartState.items;
  if (!cart || Object.keys(cart).length === 0) {
    return res.status(400).json(jsonError('Cart is empty'));
  }

  const payload = {
    items: cart,
    discount: cartState.billDiscount || 0
  };

  const held = holdBill(req.body.name || 'Held bill', payload, currentUser(req).id);
  cartState.items = {};
  cartState.billDiscount = 0;

  res.json({ ok: true, held: held, cart: cartPayload(req) });
});

app.get('/api/cart/held', loginRequired, (req, res) => {
  res.json({ ok: true, held: listHeldBills(currentUser(req).id) });
});

app.post('/api/cart/recall/:id', loginRequired, (req, res) => {
  try {
    const held = recallHeldBill(parseInt(req.params.id), currentUser(req));
    const payload = held.cart;
    const cartState = getCartState(req).state;
    cartState.items = payload.items || payload;
    cartState.billDiscount = payload.discount || 0;
    res.json({ ok: true, cart: cartPayload(req) });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// Sales
app.post('/checkout', loginRequired, (req, res) => {
  const cart = getCart(req);
  if (!cart || Object.keys(cart).length === 0) {
    return res.status(400).json(jsonError('Cart is empty'));
  }
  res.json({ ok: true, cart: cartPayload(req) });
});

app.post('/api/sale', loginRequired, async (req, res) => {
  try {
    const cart = getCart(req);
    if (!cart || Object.keys(cart).length === 0) {
      return res.status(400).json(jsonError('Cart is empty'));
    }

    const state = getCartState(req).state;
    let partyId = state.partyId || req.body.party_id || null;
    let partyName = state.partyName || req.body.party_name || '';
    let partyPhone = req.body.phone || state.partyPhone || '';

    const customerName = (req.body.customer_name || '').trim();
    const customerPhone = (req.body.customer_phone || '').trim();

    // Attach an existing customer when the phone (or name) already exists -
    // a sale must never fail on a duplicate 'Customer' placeholder.
    if (customerName || customerPhone) {
      let existing = null;
      if (customerPhone) {
        existing = execToObject("SELECT * FROM parties WHERE type = 'customer' AND phone = ?", [customerPhone]);
      }
      if (!existing && customerName) {
        existing = execToObject("SELECT * FROM parties WHERE type = 'customer' AND LOWER(TRIM(name)) = LOWER(?)", [customerName]);
      }
      if (existing) {
        partyId = existing.id;
        partyName = existing.name;
        partyPhone = existing.phone || customerPhone;
      } else {
        const newParty = saveParty({
          name: customerName || `Customer ${customerPhone}`,
          type: 'customer',
          phone: customerPhone,
        });
        partyId = newParty.id;
        partyName = newParty.name;
        partyPhone = customerPhone;
      }
    }

    const invoice = completeSale(cart, {
      billDiscount: parseFloat(state.billDiscount) || 0,
      paymentMethod: req.body.payment_method || 'Cash',
      paid: req.body.paid,
      partyId: partyId,
      partyName: partyName,
      partyPhone: partyPhone,
      userId: currentUser(req).id
    });

    state.items = {};
    state.billDiscount = 0;

    audit(req, 'sale', 'sales', invoice.invoice_no, `Sale completed: ${invoice.invoice_no} ₹${invoice.total}`);

    // Auto-backup if enabled
    await maybeAutoBackup();

    // WhatsApp integration - a delivery failure never affects the saved sale.
    // Sent when the cashier ticked the box OR admin enabled auto-send and the
    // customer has a number. Missing number never blocks billing.
    let whatsapp = { ok: true, provider: 'none' };
    const whatsappPhone = customerPhone || partyPhone;
    const autoSend = getSetting('whatsapp_auto_send', '0') === '1';
    if ((req.body.send_whatsapp || autoSend) && whatsappPhone) {
      try {
        // Durable local enqueue - resolves immediately; Meta delivery happens
        // in the background worker and can never affect the saved sale.
        whatsapp = sendBill(invoice, whatsappPhone);
      } catch (error) {
        console.error('WhatsApp error:', error);
        whatsapp = { ok: false, provider: 'meta', friendly: 'The bill was saved, but WhatsApp could not be queued.' };
      }
    }

    res.json({ ok: true, invoice: invoice, whatsapp: whatsapp, cart: cartPayload(req) });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.post('/send_bill', loginRequired, async (req, res) => {
  try {
    const cart = getCart(req);
    if (!cart || Object.keys(cart).length === 0) {
      return res.status(400).json(jsonError('Cart is empty'));
    }

    const state = getCartState(req).state;
    const invoice = completeSale(cart, {
      billDiscount: parseFloat(state.billDiscount) || 0,
      paymentMethod: req.body.payment_method || 'Cash',
      paid: null,
      partyId: state.partyId,
      partyName: state.partyName || '',
      partyPhone: req.body.phone || '',
      userId: currentUser(req).id
    });

    state.items = {};
    state.billDiscount = 0;

    // Auto-backup if enabled
    await maybeAutoBackup();

    // WhatsApp integration
    let result = { ok: true, provider: 'none' };
    if (req.body.phone) {
      try {
        result = sendBill(invoice, req.body.phone);
      } catch (error) {
        console.error('WhatsApp error:', error);
        result = { ok: false, provider: 'meta', friendly: 'The bill was saved, but WhatsApp could not be queued.' };
      }
    }

    // The bill is already saved - a WhatsApp failure is reported in the
    // payload but never fails the request.
    return res.json({
      ok: true,
      message: result.ok ? 'Bill saved' : 'Bill saved successfully, but WhatsApp delivery failed',
      whatsapp: result,
      provider: result.provider,
      invoice: invoice
    });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// Send (or retry sending) a saved invoice over WhatsApp. Cashiers may use it.
// A failed message is requeued; after a terminal success this creates an
// explicit resend.
app.post('/api/invoices/:id/whatsapp', loginRequired, async (req, res) => {
  try {
    const invoice = getInvoice(parseInt(req.params.id));
    if (!invoice) {
      return res.status(404).json(jsonError('Invoice not found'));
    }
    const phone = String((req.body || {}).phone || invoice.party_phone || '').trim();
    if (!phone) {
      return res.status(400).json(jsonError('Customer WhatsApp number is required'));
    }
    const result = retryBill(invoice, phone);
    audit(
      req, 'whatsapp', 'sales', invoice.invoice_no,
      result.ok ? `Bill queued for WhatsApp to ${phone}` : `WhatsApp queue failed: ${result.friendly || result.error || 'unknown'}`
    );
    res.json({ ok: true, whatsapp: result, invoice_no: invoice.invoice_no });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// Invoices - each row carries its latest WhatsApp delivery status so the
// Sales list can show Sent / Failed without extra round-trips.
app.get('/api/invoices', loginRequired, (req, res) => {
  // Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD filters by bill date (local days).
  let range = null;
  if (req.query.from || req.query.to) {
    try {
      range = parseRange(req.query);
    } catch (e) {
      return res.status(400).json(jsonError(e.message));
    }
  }
  const invoices = listInvoices(500, range);
  const wa = latestStatusMap();
  for (const inv of invoices) {
    if (wa[inv.id]) inv.whatsapp = wa[inv.id];
  }
  res.json({ ok: true, invoices: invoices });
});

app.get('/api/invoices/:id', loginRequired, (req, res) => {
  const invoice = getInvoice(parseInt(req.params.id));
  if (!invoice) {
    return res.status(404).json(jsonError('Invoice not found'));
  }
  invoice.whatsapp_attempts = attemptsFor(invoice.id);
  res.json({ ok: true, invoice: invoice });
});

app.post('/api/invoices/:id/payment', loginRequired, (req, res) => {
  try {
    const invoice = recordInvoicePayment(
      parseInt(req.params.id),
      parseFloat(req.body.amount),
      req.body.method || 'Cash',
      currentUser(req).id
    );
    audit(req, 'payment', 'sales', invoice.invoice_no, `Due collected: ₹${req.body.amount} (${req.body.method || 'Cash'})`);
    res.json({ ok: true, invoice: invoice });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.post('/api/invoices/:id/return', requireRole('manager'), (req, res) => {
  try {
    const returnRecord = createSaleReturn(parseInt(req.params.id), req.body.items || [], currentUser(req).id, req.body.reason || '');
    audit(req, 'return', 'sales', returnRecord.return_no, `Sale return on invoice ${req.params.id}: ₹${returnRecord.total}`);
    res.json({ ok: true, return: returnRecord });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.post('/api/invoices/:id/cancel', requireRole('manager'), (req, res) => {
  try {
    const invoice = cancelInvoice(parseInt(req.params.id), currentUser(req).id, req.body.reason || '');
    audit(req, 'cancel', 'sales', invoice.invoice_no, `Bill cancelled: ${invoice.invoice_no} (${req.body.reason || 'no reason'})`);
    res.json({ ok: true, invoice: invoice });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// Edit / delete a bill - gated by the bill passcode
app.put('/api/invoices/:id', requireRole('manager'), (req, res) => {
  try {
    const existing = getInvoice(parseInt(req.params.id));
    if (!existing) {
      return res.status(404).json(jsonError('Invoice not found'));
    }
    if (!checkBillPasscode(req, res, existing.invoice_no)) {
      return;
    }
    const updated = updateInvoice(existing.id, req.body, currentUser(req).id);
    audit(req, 'update', 'sales', updated.invoice_no, `Bill edited: ${updated.invoice_no} (${req.body.reason || 'no reason'})`, existing, updated);
    res.json({ ok: true, invoice: updated });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.delete('/api/invoices/:id', requireRole('manager'), (req, res) => {
  try {
    const existing = getInvoice(parseInt(req.params.id));
    if (!existing) {
      return res.status(404).json(jsonError('Invoice not found'));
    }
    if (!checkBillPasscode(req, res, existing.invoice_no)) {
      return;
    }
    const snapshot = deleteInvoice(existing.id, currentUser(req).id);
    audit(req, 'delete', 'sales', snapshot.invoice_no, `Bill deleted: ${snapshot.invoice_no} (${req.body.reason || 'no reason'})`, snapshot, null);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// Purchases
app.get('/api/purchases', requireRole('manager'), (req, res) => {
  // Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD filters by purchase date.
  let range = null;
  if (req.query.from || req.query.to) {
    try {
      range = parseRange(req.query);
    } catch (e) {
      return res.status(400).json(jsonError(e.message));
    }
  }
  res.json({ ok: true, purchases: listPurchases(500, range) });
});

app.post('/api/purchases', requireRole('manager'), (req, res) => {
  try {
    const purchase = completePurchase(req.body.items || [], {
      partyId: req.body.party_id || null,
      paid: req.body.paid,
      userId: currentUser(req).id
    });
    audit(req, 'create', 'purchases', purchase.purchase_no, `Purchase recorded: ${purchase.purchase_no} ₹${purchase.total}`);
    res.json({ ok: true, purchase: purchase });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.post('/api/purchases/:id/return', requireRole('manager'), (req, res) => {
  try {
    const ret = createPurchaseReturn(parseInt(req.params.id), req.body.items || [], currentUser(req).id, req.body.reason || '');
    audit(req, 'return', 'purchases', ret.return_no, `Purchase return on ${req.params.id}: ₹${ret.total}`);
    res.json({ ok: true, return: ret });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.get('/api/purchase-returns', requireRole('manager'), (req, res) => {
  res.json({ ok: true, returns: listPurchaseReturns() });
});

// Stock adjustments (damage / wastage / manual correction)
app.post('/api/stock-adjustments', requireRole('manager'), (req, res) => {
  try {
    const adj = createStockAdjustment({
      item_id: req.body.item_id,
      change: req.body.change,
      type: req.body.type,
      reason: req.body.reason,
      userId: currentUser(req).id
    });
    audit(req, req.body.type === 'damage' ? 'damage' : req.body.type === 'wastage' ? 'wastage' : 'stock_adjustment',
      'inventory', adj.item_code || req.body.item_id,
      `Stock ${req.body.type || 'adjustment'}: ${adj.item_name || ''} ${req.body.change} units`);
    res.json({ ok: true, adjustment: adj });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.get('/api/stock-adjustments', requireRole('manager'), (req, res) => {
  res.json({ ok: true, adjustments: listStockAdjustments({}) });
});

// Cash drawer sessions (day open / day close)
app.get('/api/cash-session', loginRequired, (req, res) => {
  res.json({ ok: true, session: currentSession(currentUser(req).id) });
});

app.post('/api/cash-session/open', loginRequired, (req, res) => {
  try {
    const session = openSession(currentUser(req).id, req.body.opening_cash);
    audit(req, 'session_open', 'cash', session.id, `Cash session opened with ₹${req.body.opening_cash || 0}`);
    res.json({ ok: true, session: session });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.post('/api/cash-session/close', loginRequired, (req, res) => {
  try {
    const session = closeSession(currentUser(req).id, req.body.closing_cash, req.body.note || '');
    audit(req, 'session_close', 'cash', session.id, `Cash session closed. Counted ₹${req.body.closing_cash ?? '-'}`);
    res.json({ ok: true, session: session });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.get('/api/purchases/:id', requireRole('manager'), (req, res) => {
  const purchase = getPurchase(parseInt(req.params.id));
  if (!purchase) {
    return res.status(404).json(jsonError('Purchase not found'));
  }
  res.json({ ok: true, purchase: purchase });
});

// Edit / delete a purchase bill - gated by the bill passcode, same as sales.
app.put('/api/purchases/:id', requireRole('manager'), (req, res) => {
  try {
    const existing = getPurchase(parseInt(req.params.id));
    if (!existing) {
      return res.status(404).json(jsonError('Purchase not found'));
    }
    if (!checkBillPasscode(req, res, existing.purchase_no)) {
      return;
    }
    const updated = updatePurchase(existing.id, req.body);
    audit(req, 'update', 'purchases', updated.purchase_no, `Purchase edited: ${updated.purchase_no} (${req.body.reason || 'no reason'})`, existing, updated);
    res.json({ ok: true, purchase: updated });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.delete('/api/purchases/:id', requireRole('manager'), (req, res) => {
  try {
    const existing = getPurchase(parseInt(req.params.id));
    if (!existing) {
      return res.status(404).json(jsonError('Purchase not found'));
    }
    if (!checkBillPasscode(req, res, existing.purchase_no)) {
      return;
    }
    const snapshot = deletePurchase(existing.id);
    audit(req, 'delete', 'purchases', snapshot.purchase_no, `Purchase deleted: ${snapshot.purchase_no} (${req.body.reason || 'no reason'})`, snapshot, null);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// Expenses
app.post('/api/expenses', requireRole('manager'), (req, res) => {
  try {
    const expense = addExpense(req.body.category, req.body.amount, req.body.note || '', currentUser(req).id);
    audit(req, 'create', 'expenses', expense.id, `Expense added: ${expense.category} ₹${expense.amount}`);
    res.json({ ok: true, expense: expense });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.get('/api/expenses', requireRole('manager'), (req, res) => {
  res.json({ ok: true, expenses: listExpenses() });
});

app.delete('/api/expenses/:id', requireRole('manager'), (req, res) => {
  try {
    const expenseId = parseInt(req.params.id);
    if (isNaN(expenseId) || !getExpense(expenseId)) {
      return res.status(404).json(jsonError('Expense not found'));
    }
    deleteExpense(expenseId);
    audit(req, 'delete', 'expenses', req.params.id, `Expense deleted (id ${req.params.id})`);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// Settings
app.get('/api/settings', loginRequired, (req, res) => {
  const user = currentUser(req);
  const payload = {
    ok: true,
    settings: publicSettings(),
    drive: driveStatus(),
    whatsapp: whatsappStatus()
  };

  if (user.role === 'admin') {
    payload.users = listUsers();
    const db = dbInfo();
    payload.data_dir = getDataDir();
    payload.db_path = db.path;
    // Settings -> About card. Paths are admin-only; no secrets included.
    payload.about = {
      app: 'MartPOS',
      version: APP_VERSION,
      schema_version: db.schema_version,
      data_dir: getDataDir(),
      db_path: db.path,
      db_size: db.size,
      backup_dir: backupDir(),
      last_drive_backup_at: (driveStatus() || {}).last_backup_at || '',
      last_local_backup_at: (listLocalBackups()[0] || {}).created_at || ''
    };
  }

  res.json(payload);
});

app.post('/api/settings', requireRole('admin'), (req, res) => {
  try {
    const allowed = {
      shop_name: true,
      gstin: true,
      upi_vpa: true,
      upi_name: true,
      gst_type: true,
      default_gst: true,
      drive_auto_backup: true,
      drive_backup_interval: true,
      local_backup_enabled: true,
      local_backup_interval: true,
      whatsapp_number: true,
      whatsapp_auto_send: true,
      whatsapp_default_country_code: true,
      must_change_password: true,
      receipt_printer_width: true,
      receipt_font_size: true,
      receipt_font_family: true,
      receipt_header: true,
      receipt_footer: true,
      receipt_show_gstin: true,
      receipt_show_customer: true,
      receipt_show_cashier: true,
      receipt_show_mrp: true,
      receipt_show_hsn: true,
      receipt_show_savings: true,
      receipt_show_gst_breakup: true,
      update_auto_check: true,
      update_auto_download: true
    };
    
    const updates = {};
    for (const [key, value] of Object.entries(req.body)) {
      if (allowed[key]) {
        updates[key] = value;
      }
    }

    // whatsapp_number is a legacy receipt/footer contact field - it is not
    // the WhatsApp sender. Still must be a valid international-format number.
    if (updates.whatsapp_number !== undefined) {
      const v = String(updates.whatsapp_number).trim();
      updates.whatsapp_number = v === '' ? '' : normalizeWhatsAppNumber(v);
    }

    if (updates.drive_backup_interval !== undefined &&
        !['6h', 'daily', 'on_exit'].includes(String(updates.drive_backup_interval))) {
      return res.status(400).json(jsonError('Invalid backup frequency'));
    }
    if (updates.local_backup_interval !== undefined &&
        !['6h', 'daily'].includes(String(updates.local_backup_interval))) {
      return res.status(400).json(jsonError('Invalid local backup frequency'));
    }
    for (const flag of ['whatsapp_auto_send', 'local_backup_enabled', 'update_auto_check', 'update_auto_download']) {
      if (updates[flag] !== undefined && !['0', '1'].includes(String(updates[flag]))) {
        return res.status(400).json(jsonError('Invalid on/off value'));
      }
    }

    if (updates.whatsapp_default_country_code !== undefined &&
        !/^\+\d{1,3}$/.test(String(updates.whatsapp_default_country_code))) {
      return res.status(400).json(jsonError('Invalid default country code'));
    }

    // Bill passcode: virtual fields, never stored or echoed in plain text
    const plainPasscode = req.body.bill_passcode;
    const clearPasscode = String(req.body.bill_passcode_clear || '') === '1';
    let passcodeAudit = null;
    if (clearPasscode) {
      updates.bill_passcode_hash = '';
      passcodeAudit = 'Bill passcode cleared';
    } else if (plainPasscode !== undefined && String(plainPasscode) !== '') {
      if (!/^\d{4,8}$/.test(String(plainPasscode))) {
        return res.status(400).json(jsonError('Passcode must be 4-8 digits'));
      }
      const bcrypt = require('bcryptjs');
      updates.bill_passcode_hash = bcrypt.hashSync(String(plainPasscode), 10);
      passcodeAudit = 'Bill passcode updated';
    }

    const settings = setSettings(updates);
    if (Object.keys(updates).some((k) => k !== 'bill_passcode_hash')) {
      const changed = Object.keys(updates).filter((k) => k !== 'bill_passcode_hash');
      audit(req, 'update', 'settings', '', `Settings changed: ${changed.join(', ')}`, null, updates);
    }
    if (passcodeAudit) {
      audit(req, 'update', 'settings', '', passcodeAudit);
    }
    res.json({ ok: true, settings: publicSettings(settings), whatsapp: whatsappStatus() });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// Reports - legacy summary endpoint (defaults to today when params are omitted)
app.get('/api/reports', requireRole('manager'), (req, res) => {
  try {
    const range = parseRange(req.query);
    const reportData = reports(range.from, range.to);
    res.json({ ok: true, report: reportData, reports: reportData });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// Report handler registry - each handler receives (range, query) and returns
// { summary?, rows?, total?, page?, per_page?, ... }
const REPORT_HANDLERS = {
  'overview': (range) => reportLib.overview(range),

  'sales/summary': (range) => reportLib.salesReports.summary(range),
  'sales/day-wise': (range) => reportLib.salesReports.dayWise(range),
  'sales/bill-wise': (range, qy) => reportLib.salesReports.billWise(range, qy),
  'sales/item-wise': (range) => reportLib.salesReports.itemWise(range),
  'sales/category-wise': (range) => reportLib.salesReports.categoryWise(range),
  'sales/customer-wise': (range) => reportLib.salesReports.customerWise(range),
  'sales/cashier-wise': (range) => reportLib.salesReports.cashierWise(range),
  'sales/payment-wise': (range) => reportLib.salesReports.paymentWise(range),
  'sales/hourly': (range) => reportLib.salesReports.hourly(range),
  'sales/discounts': (range, qy) => reportLib.salesReports.discounts(range, qy),
  'sales/cancelled': (range, qy) => reportLib.salesReports.cancelled(range, qy),
  'sales/returns': (range, qy) => reportLib.salesReports.returnsReport(range, qy),

  'inventory/current-stock': (range, qy) => reportLib.inventoryReports.currentStock(qy),
  'inventory/low-stock': () => reportLib.inventoryReports.lowStock(),
  'inventory/out-of-stock': () => reportLib.inventoryReports.outOfStock(),
  'inventory/valuation': () => reportLib.inventoryReports.valuation(),
  'inventory/ledger': (range, qy) => reportLib.inventoryReports.stockLedger(parseInt(qy.item_id, 10), range),
  'inventory/movement': (range) => reportLib.inventoryReports.stockMovement(range),
  'inventory/fast-moving': (range) => reportLib.inventoryReports.fastMoving(range),
  'inventory/slow-moving': (range) => reportLib.inventoryReports.slowMoving(range),
  'inventory/dead-stock': (range, qy) => reportLib.inventoryReports.deadStock(parseInt(qy.days, 10) || 60),
  'inventory/adjustments': (range, qy) => reportLib.inventoryReports.adjustments(range, { type: qy.adj_type || '', userId: qy.user_id ? parseInt(qy.user_id, 10) : null }),

  'purchases/summary': (range) => reportLib.purchaseReports.summary(range),
  'purchases/supplier-wise': (range) => reportLib.purchaseReports.supplierWise(range),
  'purchases/item-wise': (range) => reportLib.purchaseReports.itemWise(range),
  'purchases/invoices': (range, qy) => reportLib.purchaseReports.invoices(range, qy),
  'purchases/returns': (range, qy) => reportLib.purchaseReports.returnsReport(range, qy),
  'purchases/payments': (range, qy) => reportLib.purchaseReports.payments(range, qy),
  'purchases/pending': () => reportLib.purchaseReports.pendingPayments(),
  'purchases/price-history': (range, qy) => reportLib.purchaseReports.priceHistory(parseInt(qy.item_id, 10)),

  'profit-loss/summary': (range) => reportLib.financeReports.profitLoss(range),
  'profit-loss/day-wise': (range) => reportLib.financeReports.dayWiseProfit(range),
  'profit-loss/item-wise': (range) => reportLib.salesReports.itemWise(range),
  'profit-loss/category-wise': (range) => reportLib.salesReports.categoryWise(range),
  'profit-loss/expenses': (range, qy) => reportLib.financeReports.expenseReport(range, qy),
  'profit-loss/expense-categories': (range) => reportLib.financeReports.expenseCategories(range),
  'profit-loss/income-expense': (range) => reportLib.financeReports.incomeExpense(range),

  'payments/summary': (range) => reportLib.financeReports.paymentSummary(range),
  'payments/daily': (range) => reportLib.financeReports.dailyCollections(range),
  'payments/credit-sales': (range, qy) => reportLib.financeReports.creditSales(range, qy),
  'payments/collections': (range, qy) => reportLib.financeReports.customerCollections(range, qy),
  'payments/day-closing': (range, qy) => reportLib.financeReports.dayClosing(range, qy),

  'customers/summary': (range) => reportLib.partyReports.customerSummary(range),
  'customers/ledger': (range, qy) => reportLib.partyReports.customerLedger(parseInt(qy.party_id, 10), range),
  'customers/outstanding': () => reportLib.partyReports.customerOutstanding(),
  'customers/history': (range, qy) => reportLib.partyReports.customerHistory(parseInt(qy.party_id, 10), range, qy),
  'customers/top': (range) => reportLib.partyReports.topCustomers(range),

  'suppliers/summary': (range) => reportLib.partyReports.supplierSummary(range),
  'suppliers/ledger': (range, qy) => reportLib.partyReports.supplierLedger(parseInt(qy.party_id, 10), range),
  'suppliers/outstanding': () => reportLib.partyReports.supplierOutstanding(),
  'suppliers/payments': (range, qy) => reportLib.partyReports.supplierPayments(range, qy),
  'suppliers/top': (range) => reportLib.partyReports.topSuppliers(range),

  'returns/all': (range, qy) => reportLib.staffReports.returnsUnified(range, qy),

  'gst/sales': (range) => reportLib.gstReports.salesSummary(range),
  'gst/purchases': (range) => reportLib.gstReports.purchaseSummary(range),
  'gst/rate-wise': (range) => reportLib.gstReports.rateWiseSales(range),
  'gst/hsn-sales': (range) => reportLib.gstReports.hsnSales(range),
  'gst/hsn-purchases': (range) => reportLib.gstReports.hsnPurchases(range),
  'gst/returns': (range) => reportLib.gstReports.returnsSummary(range),

  'cashiers/sales': (range) => reportLib.staffReports.cashierSales(range),
  'cashiers/payments': (range) => reportLib.staffReports.cashierPayments(range),
  'cashiers/discounts': (range, qy) => reportLib.staffReports.cashierDiscounts(range, qy),
  'cashiers/returns': (range, qy) => reportLib.staffReports.cashierReturns(range, qy),
  'cashiers/sessions': (range, qy) => reportLib.staffReports.sessionsReport(range, qy),

  'meta': () => reportLib.staffReports.meta()
};

app.get('/api/reports/audit', requireRole('manager'), (req, res) => {
  try {
    const range = parseRange(req.query);
    const data = reportLib.staffReports.auditReport(range, req.query);
    res.json({ ok: true, report: data });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.get('/api/reports/:group/:name', requireRole('manager'), (req, res) => {
  const key = `${req.params.group}/${req.params.name}`;
  const handler = REPORT_HANDLERS[key];
  if (!handler) {
    return res.status(404).json(jsonError('Unknown report'));
  }
  try {
    const range = parseRange(req.query);
    const data = handler(range, req.query);
    res.json({ ok: true, report: { from: range.from, to: range.to, ...data } });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.get('/api/reports/:name', requireRole('manager'), (req, res) => {
  const handler = REPORT_HANDLERS[req.params.name];
  if (!handler) {
    return res.status(404).json(jsonError('Unknown report'));
  }
  try {
    const range = parseRange(req.query);
    const data = handler(range, req.query);
    res.json({ ok: true, report: { from: range.from, to: range.to, ...data } });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// Users management
app.get('/api/users', requireRole('admin'), (req, res) => {
  res.json({ ok: true, users: listUsers() });
});

app.post('/api/users', requireRole('admin'), (req, res) => {
  try {
    const user = createUser(req.body.username, req.body.password, req.body.role);
    audit(req, 'create', 'users', user.username, `User created: ${user.username} (${user.role})`);
    res.json({ ok: true, user: user });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.put('/api/users/:id/password', loginRequired, (req, res) => {
  try {
    const user = currentUser(req);
    const targetUserId = parseInt(req.params.id);
    
    // Allow admin to change any password, or users to change their own
    if (user.role !== 'admin' && user.id !== targetUserId) {
      return res.status(403).json(jsonError('Not allowed'));
    }
    
    updateUserPassword(targetUserId, req.body.password);
    audit(req, 'password_change', 'users', targetUserId, `Password changed for user id ${targetUserId}`);
    
    // If user changed their own password, reset must_change_password setting
    if (user.id === targetUserId) {
      setSettings({ must_change_password: '0' });
    }
    
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.delete('/api/users/:id', requireRole('admin'), (req, res) => {
  try {
    const target = getUserById(parseInt(req.params.id));
    if (target && target.id === currentUser(req).id) {
      return res.status(400).json(jsonError('You cannot delete your own account'));
    }
    deleteUser(parseInt(req.params.id));
    audit(req, 'delete', 'users', req.params.id, `User deleted: ${target ? target.username : req.params.id}`);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// PDF invoice generation
app.get('/invoice_pdf', loginRequired, async (req, res) => {
  try {
    const invId = req.query.id;
    const invNo = req.query.inv || req.query.no;
    let invoice;
    
    if (invId) {
      invoice = getInvoice(parseInt(invId));
    } else if (invNo) {
      invoice = getInvoiceByNo(invNo);
    }
    
    if (!invoice) {
      return res.status(404).send('Invoice not found');
    }
    
    const pdfBuffer = await generateInvoicePDF(invoice);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice-${invoice.invoice_no}.pdf`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Failed generating PDF:', error);
    res.status(500).send('Failed to generate PDF');
  }
});

// UPI QR code generation
app.get('/upi_qr', loginRequired, async (req, res) => {
  try {
    const amount = parseFloat(req.query.am || req.query.amount || '0');
    const note = req.query.tn || req.query.note || 'Mart POS Bill';
    
    if (isNaN(amount)) {
      return res.status(400).send('Invalid amount');
    }
    
    const qrBuffer = await generateUPIQRCode(amount, note);
    res.setHeader('Content-Type', 'image/png');
    res.send(qrBuffer);
  } catch (error) {
    console.error('Failed generating UPI QR:', error);
    res.status(500).send('Failed to generate QR code');
  }
});

// Cloud account routes - registration/login are proxied to the gateway; the
// device token it returns is stored in the encrypted secrets store and never
// appears in any response body.
app.get('/api/cloud/status', requireRole('admin'), (req, res) => {
  const w = whatsappStatus();
  res.json({
    ok: true,
    cloud: { linked: w.linked, cloud_url_set: w.cloud_url_set, shop_name: w.shop_name }
  });
});

app.post('/api/cloud/register', requireRole('admin'), async (req, res) => {
  try {
    const b = req.body || {};
    const result = await registerCloudOwner({
      email: b.email, password: b.password,
      shopName: b.shopName || b.shop_name || getSetting('shop_name', 'Mart POS'),
      deviceName: b.deviceName || b.device_name || 'POS'
    });
    audit(req, 'cloud_register', 'settings', '', 'Cloud account registered and device linked');
    res.json(result);
  } catch (error) {
    res.status(400).json(jsonError(friendlyError(error)));
  }
});

app.post('/api/cloud/login', requireRole('admin'), async (req, res) => {
  try {
    const b = req.body || {};
    const result = await loginCloudOwner({
      email: b.email, password: b.password,
      deviceName: b.deviceName || b.device_name || 'POS'
    });
    audit(req, 'cloud_login', 'settings', '', 'Device linked to cloud account');
    res.json(result);
  } catch (error) {
    res.status(400).json(jsonError(friendlyError(error)));
  }
});

app.post('/api/cloud/logout', requireRole('admin'), async (req, res) => {
  try {
    const result = await logoutCloudOwner();
    audit(req, 'cloud_logout', 'settings', '', 'Device unlinked from cloud account');
    res.json(result);
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// WhatsApp routes
app.get('/api/whatsapp/status', loginRequired, async (req, res) => {
  if (whatsappStatus().linked) {
    try { await refreshWhatsAppStatus(); } catch (_) { /* offline - safe status still returned */ }
  }
  res.json({ ok: true, whatsapp: whatsappStatus() });
});

// Starts Embedded Signup: fetches a one-time onboarding URL from the gateway
// and opens it in the system browser. The URL itself is not returned to the
// renderer - only that onboarding was started.
app.post('/api/whatsapp/connect', requireRole('admin'), async (req, res) => {
  try {
    const result = await connectWhatsApp();
    let opened = false;
    if (result.url) {
      try {
        await require('open')(result.url);
        opened = true;
      } catch (_) {
        opened = false;
      }
    }
    audit(req, 'whatsapp_connect', 'settings', '', 'WhatsApp onboarding started');
    res.json({ ok: true, whatsapp: whatsappStatus(), connect: { started: true, opened, expires_at: result.expires_at } });
  } catch (error) {
    res.status(400).json(jsonError(friendlyError(error)));
  }
});

app.post('/api/whatsapp/disconnect', requireRole('admin'), async (req, res) => {
  try {
    await disconnectWhatsApp();
    audit(req, 'whatsapp_disconnect', 'settings', '', 'WhatsApp disconnected');
    res.json({ ok: true, whatsapp: whatsappStatus() });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// Queues a test invoice-template message to the shop's own configured number
// (or an explicit test recipient). Delivery happens via the gateway worker.
app.post('/api/whatsapp/test', requireRole('admin'), async (req, res) => {
  try {
    const result = sendTestMessage((req.body || {}).to);
    audit(req, 'whatsapp_test', 'settings', '', result.ok ? 'WhatsApp test queued' : `WhatsApp test failed: ${result.friendly || result.error || 'unknown'}`);
    res.json({ ok: true, whatsapp: whatsappStatus(), result });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

// Google Drive sync routes
app.get('/api/drive/status', requireRole('admin'), (req, res) => {
  res.json({ ok: true, drive: driveStatus() });
});

app.post('/api/drive/connect', requireRole('admin'), async (req, res) => {
  try {
    const info = await connectOAuth();
    res.json({ ok: true, drive: info });
  } catch (error) {
    if (error instanceof DriveError) {
      res.status(400).json(jsonError(errMsg(error)));
    } else {
      res.status(500).json(jsonError(errMsg(error)));
    }
  }
});

app.post('/api/drive/disconnect', requireRole('admin'), async (req, res) => {
  await disconnect();
  res.json({ ok: true, drive: driveStatus() });
});

// Manual "Backup now" under the Drive card - uploads to Google Drive only.
// Local snapshots have their own endpoint (POST /api/backups/local) and also
// run automatically on the schedule.
app.post('/api/drive/backup', requireRole('admin'), async (req, res) => {
  try {
    const result = await backupDatabase('manual');
    res.json({ ok: true, ...result, drive: driveStatus() });
  } catch (error) {
    res.status(error instanceof DriveError ? 400 : 500).json(jsonError(errMsg(error)));
  }
});

// Validates the OAuth token and confirms the backup folder is reachable.
app.post('/api/drive/test', requireRole('admin'), async (req, res) => {
  try {
    const result = await testDrive();
    console.log(`Drive connection test OK (${result.email || 'no email'})`);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.get('/api/drive/backups', requireRole('admin'), async (req, res) => {
  try {
    const files = await listBackups();
    res.json({ ok: true, files: files });
  } catch (error) {
    if (error instanceof DriveError) {
      res.status(400).json(jsonError(errMsg(error)));
    } else {
      res.status(500).json(jsonError(errMsg(error)));
    }
  }
});

// Two-step safe restore:
//   POST /api/backup/prepare  { source:'local', name } | { source:'drive', file_id }
//       -> validates the backup and returns details for the confirm screen.
//       Drive files are downloaded to <data dir>/restores/ and validated.
//   POST /api/backup/restore  { source:'local', name } | { source:'drive', staging }
//       -> takes a pre-restore safety backup, swaps pos.db, reloads, and
//       destroys the session so the UI returns to login.
// Path components are strictly validated - only files inside the backups/
// and restores/ directories can ever be referenced.
const SAFE_BACKUP_NAME = /^(MartPOS-backup|pre-restore)-[\w.-]+\.db$/i;
const SAFE_STAGING_NAME = /^drive-[\w.-]+\.db$/i;

app.post('/api/backup/prepare', requireRole('admin'), async (req, res) => {
  try {
    const source = (req.body || {}).source;
    if (source === 'local') {
      const name = String(req.body.name || '');
      if (!SAFE_BACKUP_NAME.test(name)) {
        return res.status(400).json(jsonError('Invalid backup name'));
      }
      const filePath = path.join(backupDir(), name);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json(jsonError('Backup file not found'));
      }
      const details = await describeBackupFile(filePath, name);
      if (!details.ok) {
        return res.status(400).json({ ok: false, error: `Backup is not usable: ${details.error}`, details });
      }
      return res.json({ ok: true, source: 'local', details });
    }
    if (source === 'drive') {
      const fileId = String(req.body.file_id || '');
      if (!fileId) {
        return res.status(400).json(jsonError('file_id is required'));
      }
      const details = await prepareRestore(fileId);
      return res.json({ ok: true, source: 'drive', details, staging: path.basename(details.staging_path) });
    }
    res.status(400).json(jsonError('source must be "local" or "drive"'));
  } catch (error) {
    res.status(error instanceof DriveError ? 400 : 500).json(jsonError(errMsg(error)));
  }
});

app.post('/api/backup/restore', requireRole('admin'), async (req, res) => {
  try {
    const source = (req.body || {}).source;
    let result;
    if (source === 'local') {
      const name = String(req.body.name || '');
      if (!SAFE_BACKUP_NAME.test(name)) {
        return res.status(400).json(jsonError('Invalid backup name'));
      }
      const filePath = path.join(backupDir(), name);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json(jsonError('Backup file not found'));
      }
      result = await applyRestoreFile(filePath, name);
    } else if (source === 'drive') {
      const staging = String(req.body.staging || '');
      if (!SAFE_STAGING_NAME.test(staging)) {
        return res.status(400).json(jsonError('Invalid staged file'));
      }
      const stagingPath = path.join(getDataDir(), 'restores', staging);
      if (!fs.existsSync(stagingPath)) {
        return res.status(400).json(jsonError('Staged download expired - prepare the restore again'));
      }
      result = await applyStagedRestore(stagingPath, staging);
    } else {
      return res.status(400).json(jsonError('source must be "local" or "drive"'));
    }

    if (!result.ok) {
      return res.status(400).json(jsonError(result.error));
    }

    // Database was swapped and reloaded inside applyRestoreFile. Drop the
    // session so the cashier logs in again against the restored data.
    req.session.destroy();
    res.json({ ok: true, ...result, note: 'Database restored. Please log in again.' });
  } catch (error) {
    res.status(500).json(jsonError(errMsg(error)));
  }
});

// One-call restore kept for compatibility - prepares and applies safely.
app.post('/api/drive/restore', requireRole('admin'), async (req, res) => {
  try {
    const { file_id } = req.body;
    if (!file_id) {
      return res.status(400).json(jsonError('file_id is required'));
    }
    const result = await restoreDatabase(file_id);
    if (!result.ok) {
      return res.status(400).json(jsonError(result.error));
    }
    req.session.destroy();
    res.json({ ok: true, ...result, note: 'Database restored. Please log in again.' });
  } catch (error) {
    if (error instanceof DriveError) {
      res.status(400).json(jsonError(errMsg(error)));
    } else {
      res.status(500).json(jsonError(errMsg(error)));
    }
  }
});

// ---- Local backups + history ----

app.get('/api/backups/local', requireRole('admin'), (req, res) => {
  res.json({ ok: true, backups: listLocalBackups(), dir: backupDir() });
});

app.post('/api/backups/local', requireRole('admin'), async (req, res) => {
  const result = await createLocalBackup('manual');
  if (!result.ok) {
    return res.status(400).json(jsonError(result.error));
  }
  res.json({ ok: true, file: result.file });
});

app.get('/api/backups/history', requireRole('admin'), (req, res) => {
  res.json({ ok: true, history: listHistory(200) });
});

// Estimates
app.get('/api/estimates', loginRequired, (req, res) => {
  res.json({ ok: true, estimates: listEstimates() });
});

app.get('/api/estimates/:id', loginRequired, (req, res) => {
  const estimate = getEstimate(parseInt(req.params.id));
  if (!estimate) {
    return res.status(404).json(jsonError('Estimate not found'));
  }
  res.json({ ok: true, estimate: estimate });
});

app.post('/api/estimates', requireRole('manager'), (req, res) => {
  try {
    const cart = req.body.cart || {};
    const estimate = createEstimate(cart, {
      partyId: req.body.party_id,
      partyName: req.body.party_name,
      partyPhone: req.body.party_phone,
      validUntil: req.body.valid_until,
      notes: req.body.notes,
      userId: currentUser(req).id
    });
    res.json({ ok: true, estimate: estimate });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.put('/api/estimates/:id', requireRole('manager'), (req, res) => {
  try {
    const cart = req.body.cart || {};
    const estimate = updateEstimate(parseInt(req.params.id), cart, {
      billDiscount: req.body.discount,
      validUntil: req.body.valid_until,
      notes: req.body.notes,
      status: req.body.status
    });
    res.json({ ok: true, estimate: estimate });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.post('/api/estimates/:id/convert', requireRole('manager'), (req, res) => {
  try {
    const result = convertEstimateToInvoice(parseInt(req.params.id), {
      paymentMethod: req.body.payment_method || 'Cash',
      paid: req.body.paid,
      userId: currentUser(req).id
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.delete('/api/estimates/:id', requireRole('manager'), (req, res) => {
  deleteEstimate(parseInt(req.params.id));
  res.json({ ok: true });
});

// Delivery Challans
app.get('/api/delivery-challans', loginRequired, (req, res) => {
  res.json({ ok: true, challans: listDeliveryChallans() });
});

app.get('/api/delivery-challans/:id', loginRequired, (req, res) => {
  const challan = getDeliveryChallan(parseInt(req.params.id));
  if (!challan) {
    return res.status(404).json(jsonError('Delivery challan not found'));
  }
  res.json({ ok: true, challan: challan });
});

app.post('/api/delivery-challans', requireRole('manager'), (req, res) => {
  try {
    const items = req.body.items || [];
    const challan = createDeliveryChallan(items, {
      partyId: req.body.party_id,
      partyName: req.body.party_name,
      partyAddress: req.body.party_address,
      invoiceId: req.body.invoice_id,
      notes: req.body.notes,
      userId: currentUser(req).id
    });
    res.json({ ok: true, challan: challan });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.put('/api/delivery-challans/:id/status', requireRole('manager'), (req, res) => {
  try {
    const challan = updateDeliveryChallanStatus(parseInt(req.params.id), req.body.status);
    res.json({ ok: true, challan: challan });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.put('/api/delivery-challans/:id/link', requireRole('manager'), (req, res) => {
  try {
    const challan = linkChallanToInvoice(parseInt(req.params.id), req.body.invoice_id);
    res.json({ ok: true, challan: challan });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.delete('/api/delivery-challans/:id', requireRole('manager'), (req, res) => {
  deleteDeliveryChallan(parseInt(req.params.id));
  res.json({ ok: true });
});

// Credit Notes
app.get('/api/credit-notes', loginRequired, (req, res) => {
  res.json({ ok: true, credit_notes: listCreditNotes() });
});

app.get('/api/credit-notes/:id', loginRequired, (req, res) => {
  const creditNote = getCreditNote(parseInt(req.params.id));
  if (!creditNote) {
    return res.status(404).json(jsonError('Credit note not found'));
  }
  res.json({ ok: true, credit_note: creditNote });
});

app.post('/api/credit-notes', requireRole('manager'), (req, res) => {
  try {
    const items = req.body.items || [];
    const creditNote = createCreditNote(items, {
      partyId: req.body.party_id,
      partyName: req.body.party_name,
      invoiceId: req.body.invoice_id,
      reason: req.body.reason,
      userId: currentUser(req).id
    });
    res.json({ ok: true, credit_note: creditNote });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.put('/api/credit-notes/:id/status', requireRole('manager'), (req, res) => {
  try {
    const creditNote = updateCreditNoteStatus(parseInt(req.params.id), req.body.status);
    res.json({ ok: true, credit_note: creditNote });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.delete('/api/credit-notes/:id', requireRole('manager'), (req, res) => {
  deleteCreditNote(parseInt(req.params.id));
  res.json({ ok: true });
});

// Debit Notes
app.get('/api/debit-notes', loginRequired, (req, res) => {
  res.json({ ok: true, debit_notes: listDebitNotes() });
});

app.get('/api/debit-notes/:id', loginRequired, (req, res) => {
  const debitNote = getDebitNote(parseInt(req.params.id));
  if (!debitNote) {
    return res.status(404).json(jsonError('Debit note not found'));
  }
  res.json({ ok: true, debit_note: debitNote });
});

app.post('/api/debit-notes', requireRole('manager'), (req, res) => {
  try {
    const items = req.body.items || [];
    const debitNote = createDebitNote(items, {
      partyId: req.body.party_id,
      partyName: req.body.party_name,
      invoiceId: req.body.invoice_id,
      reason: req.body.reason,
      userId: currentUser(req).id
    });
    res.json({ ok: true, debit_note: debitNote });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.put('/api/debit-notes/:id/status', requireRole('manager'), (req, res) => {
  try {
    const debitNote = updateDebitNoteStatus(parseInt(req.params.id), req.body.status);
    res.json({ ok: true, debit_note: debitNote });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.delete('/api/debit-notes/:id', requireRole('manager'), (req, res) => {
  deleteDebitNote(parseInt(req.params.id));
  res.json({ ok: true });
});

// Purchase Orders
app.get('/api/purchase-orders', loginRequired, (req, res) => {
  res.json({ ok: true, purchase_orders: listPurchaseOrders() });
});

app.get('/api/purchase-orders/:id', loginRequired, (req, res) => {
  const purchaseOrder = getPurchaseOrder(parseInt(req.params.id));
  if (!purchaseOrder) {
    return res.status(404).json(jsonError('Purchase order not found'));
  }
  res.json({ ok: true, purchase_order: purchaseOrder });
});

app.post('/api/purchase-orders', requireRole('manager'), (req, res) => {
  try {
    const items = req.body.items || [];
    const purchaseOrder = createPurchaseOrder(items, {
      partyId: req.body.party_id,
      partyName: req.body.party_name,
      expectedDate: req.body.expected_date,
      notes: req.body.notes,
      userId: currentUser(req).id
    });
    res.json({ ok: true, purchase_order: purchaseOrder });
  } catch (error) {
    console.error('PO create error:', error && error.stack ? error.stack : error);
    res.status(400).json(jsonError(error && error.message !== undefined ? error.message : String(error)));
  }
});

app.put('/api/purchase-orders/:id/status', requireRole('manager'), (req, res) => {
  try {
    const purchaseOrder = updatePurchaseOrderStatus(parseInt(req.params.id), req.body.status);
    res.json({ ok: true, purchase_order: purchaseOrder });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.post('/api/purchase-orders/:id/convert', requireRole('manager'), (req, res) => {
  try {
    const result = convertPurchaseOrderToPurchase(parseInt(req.params.id), {
      userId: currentUser(req).id
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.delete('/api/purchase-orders/:id', requireRole('manager'), (req, res) => {
  deletePurchaseOrder(parseInt(req.params.id));
  res.json({ ok: true });
});

// Accounts
app.get('/api/accounts', loginRequired, (req, res) => {
  res.json({ ok: true, accounts: listAccounts() });
});

app.get('/api/accounts/default', loginRequired, (req, res) => {
  const account = getDefaultAccount();
  if (!account) {
    return res.status(404).json(jsonError('Default account not found'));
  }
  res.json({ ok: true, account: account });
});

app.get('/api/accounts/:id', loginRequired, (req, res) => {
  const account = getAccount(parseInt(req.params.id));
  if (!account) {
    return res.status(404).json(jsonError('Account not found'));
  }
  res.json({ ok: true, account: account });
});

app.post('/api/accounts', requireRole('admin'), (req, res) => {
  try {
    const account = saveAccount(req.body);
    res.json({ ok: true, account: account });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.put('/api/accounts/:id', requireRole('admin'), (req, res) => {
  try {
    const account = saveAccount(req.body, parseInt(req.params.id));
    res.json({ ok: true, account: account });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.delete('/api/accounts/:id', requireRole('admin'), (req, res) => {
  try {
    deleteAccount(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.get('/api/accounts/:id/transactions', loginRequired, (req, res) => {
  const transactions = listAccountTransactions(parseInt(req.params.id));
  res.json({ ok: true, transactions: transactions });
});

app.post('/api/accounts/:id/transactions', requireRole('manager'), (req, res) => {
  try {
    const transaction = createTransaction({
      accountId: parseInt(req.params.id),
      transactionType: req.body.transaction_type,
      amount: req.body.amount,
      referenceType: req.body.reference_type || '',
      referenceId: req.body.reference_id || 0,
      partyId: req.body.party_id,
      notes: req.body.notes
    });
    res.json({ ok: true, transaction: transaction });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.get('/api/health', requireRole('admin'), (req, res) => {
  res.json({ ok: true, health: healthReport, about: { version: APP_VERSION, schema_version: dbInfo().schema_version } });
});

// ---- AI Store Manager ----
// Read-only assistant on top of the existing business layer. The model can
// only call the registered tools - never SQL, never writes. All routes fail
// closed: an AI outage must never affect billing.
app.get('/api/ai/status', loginRequired, (req, res) => {
  res.json({ ok: true, ai: aiService.aiStatus() });
});

app.post('/api/ai/chat', loginRequired, async (req, res) => {
  try {
    const user = currentUser(req);
    const result = await aiService.chat({
      user,
      question: (req.body || {}).message,
      history: (req.body || {}).history
    });
    res.json(result);
  } catch (error) {
    if (error && error.code === 'rate_limited') {
      return res.status(429).json(jsonError(errMsg(error)));
    }
    if (error && error.code === 'bad_request') {
      return res.status(400).json(jsonError(errMsg(error)));
    }
    console.error('AI chat failed:', error);
    res.json({ ok: true, reply: 'AI Store Manager is temporarily unavailable. Your POS billing and other features continue to work normally.', tools_used: [], error: 'unavailable' });
  }
});

app.get('/api/ai/summary', loginRequired, async (req, res) => {
  try {
    const user = currentUser(req);
    const wantInsight = req.query.insight !== '0';
    const summary = await aiService.dashboardSummary(user, { wantInsight });
    res.json(summary);
  } catch (error) {
    console.error('AI summary failed:', error);
    res.status(400).json(jsonError('Summary unavailable'));
  }
});

// Admin-only AI configuration. The API key is write-only and stored in the
// encrypted secrets store - it is never returned by any endpoint.
app.post('/api/ai/config', requireRole('admin'), (req, res) => {
  try {
    const body = req.body || {};
    const status = aiService.configureAi({
      apiKey: body.api_key,
      model: body.model,
      enabled: body.enabled === undefined ? undefined
        : (body.enabled === true || body.enabled === '1' || body.enabled === 'true' || body.enabled === 1)
    });
    audit(req, 'update', 'settings', '', 'AI Store Manager configuration updated');
    res.json({ ok: true, ai: status });
  } catch (error) {
    res.status(400).json(jsonError(errMsg(error)));
  }
});

app.get('/api/ai/audit', requireRole('admin'), (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  res.json({ ok: true, rows: listAiAudit(limit) });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json(jsonError('Not found'));
});

// Global error handler
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    return res.status(400).json(jsonError('Invalid request body'));
  }
  console.error('Server error:', err);
  res.status(500).json(jsonError('Internal server error'));
});

// Startup health check. Local checks (data dir, database, backup dir,
// assets) are required for the POS to function; cloud services are reported
// but never block startup - MartPOS must open normally without internet.
let healthReport = { at: null, checks: [] };
function runHealthChecks() {
  const checks = [];
  const add = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    (ok ? console.log : console.error)(`Health check: ${name} ${ok ? 'OK' : 'FAILED'}${detail ? ` - ${detail}` : ''}`);
  };

  // Data directory writable
  try {
    const probe = path.join(getDataDir(), `.healthcheck-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    add('data directory writable', true);
  } catch (e) {
    add('data directory writable', false, e.message);
  }

  // Database readable + core tables present
  try {
    const missing = ['users', 'settings', 'items', 'invoices', 'invoice_items']
      .filter((t) => !execToObject("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t]));
    add('database readable and tables valid', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');
  } catch (e) {
    add('database readable and tables valid', false, e.message);
  }

  // Backup directory writable
  try {
    const dir = backupDir();
    const probe = path.join(dir, `.healthcheck-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    add('backup directory writable', true);
  } catch (e) {
    add('backup directory writable', false, e.message);
  }

  // UI assets exist
  add('UI assets present', fs.existsSync(path.join(__dirname, 'templates', 'index.html')));

  // Cloud services: informational only - never block startup.
  add('WhatsApp configured', whatsappStatus().configured, 'informational - POS works without it');
  add('Google Drive connected', driveStatus().connected, 'informational - POS works without it');

  healthReport = { at: new Date().toISOString(), checks };
  const failed = checks.filter((c) => !c.ok && !/configured|connected/.test(c.name));
  if (failed.length) {
    console.error(`Startup health: ${failed.length} required check(s) failed`);
  }
  return healthReport;
}

// Initialize and start server
async function startServer() {
  try {
    await initDatabase();
    cleanupStaging();
    seedItemsFromJson();
    runHealthChecks();
    startWhatsAppWorker();

    const openBrowser = (port) => {
      if (!process.pkg) {
        return;
      }
      try {
        require('open')(`http://127.0.0.1:${port}/`);
      } catch (_) {
        console.log(`Open http://127.0.0.1:${port}/ in your browser`);
      }
    };

    const port = await new Promise((resolve, reject) => {
      const server = app.listen(PORT, () => {
        const p = server.address().port;
        console.log(`Mart POS server running on http://localhost:${p}`);
        console.log('Default login: admin / admin');
        openBrowser(p);
        resolve(p);
      });
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          const fallback = app.listen(0, () => {
            const p = fallback.address().port;
            console.log(`Port ${PORT} busy - Mart POS running on http://localhost:${p}`);
            openBrowser(p);
            resolve(p);
          });
        } else {
          reject(err);
        }
      });
    });

    // Periodic check for due automatic Drive backups. The check itself is
    // cheap; failures are logged inside maybeAutoBackup and never surface.
    setInterval(() => { maybeAutoBackup(); }, 15 * 60 * 1000).unref();

    const shutdown = () => {
      stopWhatsAppWorker();
      flushSave();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('beforeExit', flushSave);
    return port;
  } catch (error) {
    console.error('Failed to start server:', error);
    // Under Electron the main process shows a native error dialog, so the
    // failure must propagate. Standalone (node/pkg) just exits.
    if (require.main === module || process.pkg) {
      process.exit(1);
    }
    throw error;
  }
}

// Start automatically when run directly (node server.js) or as the pkg exe.
// Electron requires this module and calls startServer() itself.
if (require.main === module || process.pkg) {
  startServer();
}

module.exports = { app, startServer };
