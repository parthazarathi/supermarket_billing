// shop_id is resolved ONLY from the hashed device token - request bodies are
// never trusted for tenant identity.
const bcrypt = require('bcryptjs');
const store = require('./store');
const { sha256Hex, randomToken } = require('./cryptoUtil');
const { redactText } = require('./redact');

const MIN_PASSWORD_LEN = 10;

function makeRateLimiter(maxAttempts, windowMs) {
  const hits = new Map();
  return function limited(ip) {
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now - entry.first > windowMs) {
      hits.set(ip, { count: 1, first: now });
      return false;
    }
    entry.count += 1;
    return entry.count > maxAttempts;
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function authRoutes(app, deps) {
  const { pool } = deps;
  const limited = makeRateLimiter(20, 15 * 60 * 1000);

  function issueDeviceToken() {
    const token = `mpt_${randomToken(32)}`;
    return { token, tokenHash: sha256Hex(token) };
  }

  app.post('/v1/auth/register', async (req, res) => {
    if (limited(req.ip)) {
      return res.status(429).json({ ok: false, error: 'Too many attempts - try again later' });
    }
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const shopName = String(b.shopName || '').trim();
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'A valid email address is required' });
    }
    if (password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ ok: false, error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
    }
    if (!shopName) {
      return res.status(400).json({ ok: false, error: 'Shop name is required' });
    }
    try {
      const existing = await store.findOwnerByEmail(pool, email);
      if (existing) {
        return res.status(409).json({ ok: false, error: 'An account with this email already exists' });
      }
      const { token, tokenHash } = issueDeviceToken();
      const passwordHash = await bcrypt.hash(password, 10);
      const { shop } = await store.createAccount(pool, {
        email, passwordHash, shopName,
        deviceName: String(b.deviceName || 'POS device').slice(0, 120),
        tokenHash
      });
      return res.json({ ok: true, shop: { id: shop.id, name: shop.name }, deviceToken: token });
    } catch (e) {
      console.error('register failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Registration failed' });
    }
  });

  app.post('/v1/auth/login', async (req, res) => {
    if (limited(req.ip)) {
      return res.status(429).json({ ok: false, error: 'Too many attempts - try again later' });
    }
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    try {
      const owner = await store.findOwnerByEmail(pool, email);
      // Same generic failure for unknown email and wrong password.
      if (!owner || !(await bcrypt.compare(password, owner.password_hash))) {
        return res.status(401).json({ ok: false, error: 'Invalid email or password' });
      }
      const shops = await pool.query(
        `SELECT id, name FROM shops WHERE owner_id = $1 AND status = 'active' ORDER BY created_at ASC LIMIT 1`,
        [owner.id]
      );
      if (!shops.rowCount) {
        return res.status(401).json({ ok: false, error: 'Invalid email or password' });
      }
      const shop = shops.rows[0];
      const { token, tokenHash } = issueDeviceToken();
      await store.createDevice(pool, {
        shopId: shop.id,
        name: String(b.deviceName || 'POS device').slice(0, 120),
        tokenHash
      });
      return res.json({ ok: true, shop: { id: shop.id, name: shop.name }, deviceToken: token });
    } catch (e) {
      console.error('login failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Login failed' });
    }
  });
}

function deviceAuth(pool) {
  return async (req, res, next) => {
    const header = String(req.get('authorization') || '');
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ ok: false, error: 'Device token required' });
    }
    try {
      const found = await store.findDeviceByTokenHash(pool, sha256Hex(match[1].trim()));
      if (!found) {
        return res.status(401).json({ ok: false, error: 'Device token is not valid' });
      }
      if (found.shop.status !== 'active') {
        return res.status(403).json({ ok: false, error: 'Shop is not active' });
      }
      req.device = found.device;
      req.shop = found.shop;
      next();
    } catch (e) {
      console.error('device auth failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Auth error' });
    }
  };
}

module.exports = { authRoutes, deviceAuth, makeRateLimiter, MIN_PASSWORD_LEN };
