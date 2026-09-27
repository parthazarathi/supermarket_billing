const express = require('express');
const store = require('./store');
const onboarding = require('./onboarding');
const { authRoutes, deviceAuth, makeRateLimiter } = require('./auth');
const { supportRoutes } = require('./support');
const { metaFactory } = require('./queueWorker');
const {
  verifySignature, digestBody, validatePayload, extractStatusUpdates, applyStatusUpdates
} = require('./webhook');
const { sha256Hex, randomToken } = require('./cryptoUtil');
const { sanitizeMessagePayload } = require('./payload');
const { redactText } = require('./redact');
const { connectionState } = require('./status');
const { driveRoutes } = require('./driveRoutes');
const { DriveApi } = require('./driveApi');

const PHONE_RE = /^\+?\d{8,15}$/;
const IDEMPOTENCY_RE = /^[\w:.-]{4,200}$/;
const MESSAGE_TYPES = new Set(['invoice', 'test', 'template']);
const UPDATES_PAGE_SIZE = 500;
const UPDATES_DEFAULT_SINCE = '1970-01-01T00:00:00.000Z';

function createApp(deps) {
  const { config, pool } = deps;
  const metaFor = deps.metaFor || metaFactory(config);
  const fullDeps = { config, pool, metaFor };
  // Injectable like metaFor: tests substitute a fake Google Drive client.
  const drive = deps.driveFor
    ? deps.driveFor(config)
    : new DriveApi({ clientId: (config.drive || {}).googleClientId, clientSecret: (config.drive || {}).googleClientSecret });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // The webhook POST must see the exact raw body for signature validation, so
  // it is mounted before the JSON parser. Dedupe and status processing share
  // one transaction: if processing fails, the dedupe row rolls back and Meta's
  // retry is not lost.
  app.post('/webhooks/meta', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
    const raw = req.body;
    const signature = req.get('X-Hub-Signature-256');
    if (!verifySignature(raw, signature, config.meta.appSecret)) {
      return res.status(401).json({ ok: false, error: 'Invalid signature' });
    }
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'Invalid JSON' });
    }
    const valid = validatePayload(body);
    if (!valid.ok) {
      return res.status(400).json({ ok: false, error: `Invalid payload: ${valid.reason}` });
    }
    const digest = digestBody(raw);
    try {
      const outcome = await store.withTx(pool, async (q) => {
        const isNew = await store.insertWebhookEvent(q, digest);
        if (!isNew) return { duplicate: true };
        await applyStatusUpdates(q, extractStatusUpdates(body));
        await store.markWebhookProcessed(q, digest);
        return { duplicate: false };
      });
      return res.json(outcome.duplicate ? { ok: true, duplicate: true } : { ok: true });
    } catch (e) {
      console.error('webhook processing failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Processing failed' });
    }
  });

  app.use(express.json({ limit: '1mb' }));

  app.get('/webhooks/meta', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === config.meta.webhookVerifyToken) {
      return res.status(200).send(String(challenge || ''));
    }
    return res.status(403).json({ ok: false, error: 'Verification failed' });
  });

  app.get('/', (req, res) => res.json({ ok: true, service: 'martpos-gateway' }));

  authRoutes(app, { pool });
  supportRoutes(app, { pool, config });

  app.get('/onboarding/:token', async (req, res) => {
    try {
      const session = await store.getOnboardingSession(pool, sha256Hex(String(req.params.token)));
      if (!session) {
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
        return res.status(410).type('html').send(
          onboarding.renderInfoPage('Link expired', 'This onboarding link has expired or was already used. Start again from the POS settings.')
        );
      }
      const nonce = randomToken(16);
      res.setHeader('Content-Security-Policy',
        `default-src 'none'; script-src 'self' 'nonce-${nonce}' https://connect.facebook.net; ` +
        `connect-src 'self' https://graph.facebook.com; style-src 'unsafe-inline'; ` +
        `img-src 'self' data:; frame-src https://facebook.com https://www.facebook.com https://connect.facebook.net; base-uri 'none'`);
      return res.type('html').send(onboarding.renderOnboardingPage({
        token: String(req.params.token),
        appId: config.meta.appId,
        configId: config.meta.embeddedSignupConfigId,
        version: config.meta.graphVersion,
        nonce
      }));
    } catch (e) {
      console.error('onboarding page failed:', redactText(e.message || 'error'));
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      return res.status(500).type('html').send(onboarding.renderInfoPage('Error', 'Something went wrong. Please retry from the POS.'));
    }
  });

  app.post('/onboarding/:token/complete', async (req, res) => {
    try {
      const result = await onboarding.completeOnboarding(fullDeps, req.params.token, req.body || {});
      return res.status(result.ok ? 200 : 400).json(result.ok ? { ok: true } : { ok: false, error: result.error });
    } catch (e) {
      console.error('onboarding completion failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Setup failed - please retry from the POS.' });
    }
  });

  // Everything under /v1 (except auth) requires a device bearer token.
  const device = deviceAuth(pool);

  app.get('/v1/account/status', device, (req, res) => {
    res.json({
      ok: true,
      shop: { id: req.shop.id, name: req.shop.name, status: req.shop.status },
      device: { name: req.device.name }
    });
  });

  // ---- AI Store Manager provisioning ----
  // The Gemini key and the Google OAuth "Desktop app" client live only on
  // the gateway. Two bearer types can reach the credential: the WhatsApp
  // device token, or an AI grant issued after a verified Google sign-in.
  // Nothing is ever shipped in the installer.
  async function aiAuth(req, res, next) {
    const m = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return res.status(401).json({ ok: false, error: 'Token required' });
    }
    const tokenHash = sha256Hex(m[1].trim());
    try {
      const grant = await store.findAiGrantByTokenHash(pool, tokenHash);
      if (grant) {
        req.aiGrant = grant;
        req.tokenHash = tokenHash;
        return next();
      }
      const found = await store.findDeviceByTokenHash(pool, tokenHash);
      if (!found) {
        return res.status(401).json({ ok: false, error: 'Token is not valid' });
      }
      if (found.shop.status !== 'active') {
        return res.status(403).json({ ok: false, error: 'Shop is not active' });
      }
      req.device = found.device;
      req.shop = found.shop;
      req.tokenHash = tokenHash;
      return next();
    } catch (e) {
      console.error('ai auth failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Auth error' });
    }
  }

  // Public: the OAuth "Desktop app" client config. Installed-app clients
  // are not confidential by design (RFC 8252) - vendoring it is what lets a
  // fresh install sign in with zero customer-side configuration.
  app.get('/v1/ai/oauth-client', (req, res) => {
    const ai = config.ai || {};
    if (!ai.googleClientId) {
      return res.status(503).json({ ok: false, code: 'not_provisioned', error: 'Google sign-in is not provisioned' });
    }
    return res.json({
      ok: true,
      google_client_id: ai.googleClientId,
      google_client_secret: ai.googleClientSecret || undefined
    });
  });

  // Re-verify a Google id_token server-side (signature, expiry, issuer and
  // our client_id audience) before trusting the identity.
  async function verifyGoogleIdToken(idToken) {
    const expectedAud = (config.ai || {}).googleClientId;
    if (!expectedAud) return null;
    let res;
    try {
      res = await globalThis.fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
        { signal: AbortSignal.timeout(10000) }
      );
    } catch (_) {
      return null;
    }
    if (!res.ok) return null;
    const p = await res.json().catch(() => null);
    if (!p || p.aud !== expectedAud) return null;
    if (p.iss !== 'accounts.google.com' && p.iss !== 'https://accounts.google.com') return null;
    if (p.email_verified !== 'true' && p.email_verified !== true) return null;
    if (p.exp && Number(p.exp) * 1000 < Date.now()) return null;
    if (!p.sub || !p.email) return null;
    return { sub: String(p.sub), email: String(p.email), name: String(p.name || '') };
  }

  const aiLinkLimited = makeRateLimiter(30, 15 * 60 * 1000);

  // Exchange a freshly verified Google id_token for an AI grant + the
  // vendored Gemini credential. This is the whole customer onboarding:
  // Google auth -> this call -> connected.
  app.post('/v1/ai/link', async (req, res) => {
    if (aiLinkLimited(req.ip)) {
      return res.status(429).json({ ok: false, error: 'Too many attempts - try again later' });
    }
    const ai = config.ai || {};
    if (!ai.googleClientId) {
      return res.status(503).json({ ok: false, code: 'not_provisioned', error: 'AI sign-in is not provisioned' });
    }
    const idToken = String((req.body || {}).id_token || '');
    if (!idToken) {
      return res.status(400).json({ ok: false, error: 'id_token is required' });
    }
    const identity = await verifyGoogleIdToken(idToken);
    if (!identity) {
      return res.status(401).json({ ok: false, error: 'Google identity could not be verified' });
    }
    try {
      const token = `mpt_ai_${randomToken(32)}`;
      await store.createAiGrant(pool, {
        tokenHash: sha256Hex(token),
        googleSub: identity.sub,
        email: identity.email,
        name: identity.name
      });
      return res.json({ ok: true, grant_token: token, api_key: ai.geminiApiKey || undefined });
    } catch (e) {
      console.error('ai link failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Could not link the Google account' });
    }
  });

  // Credential fetch for a linked install (AI grant or device token).
  app.get('/v1/ai/credential', aiAuth, (req, res) => {
    const ai = config.ai || {};
    if (!ai.geminiApiKey) {
      return res.status(503).json({ ok: false, code: 'not_provisioned', error: 'AI is not provisioned on this gateway' });
    }
    return res.json({ ok: true, api_key: ai.geminiApiKey });
  });

  // Remove Account: revoke the AI grant server-side (best-effort; the POS
  // clears its local copies regardless of the outcome).
  app.delete('/v1/ai/link', aiAuth, async (req, res) => {
    try {
      if (req.aiGrant) await store.revokeAiGrantByTokenHash(pool, req.tokenHash);
      return res.json({ ok: true });
    } catch (e) {
      console.error('ai unlink failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Unlink failed' });
    }
  });

  // ---- Google Drive backup ----
  // Same authentication model as the rest of /v1: POS installs present a
  // drive grant (mpt_drv_...) issued by /v1/drive/link, or their device
  // token when the link was made under a registered shop. Google tokens
  // live only here, encrypted with GATEWAY_ENCRYPTION_KEY.
  driveRoutes(app, {
    pool, config, drive,
    linkLimiter: makeRateLimiter(30, 15 * 60 * 1000)
  });

  app.delete('/v1/devices/current', device, async (req, res) => {
    try {
      await store.revokeDevice(pool, req.device.id);
      return res.json({ ok: true });
    } catch (e) {
      console.error('device revoke failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Could not revoke device' });
    }
  });

  app.get('/v1/whatsapp/status', device, async (req, res) => {
    try {
      const conn = await store.getConnection(pool, req.shop.id);
      const tpl = await store.getTemplate(pool, req.shop.id, 'mart_pos_invoice', 'en_US');
      const template = tpl ? { name: tpl.name, status: tpl.status, document_enabled: !!tpl.document_header } : null;
      if (!conn) {
        return res.json({ ok: true, connection: { status: 'disconnected', connected: false, needs_reconnect: false, template } });
      }
      const state = connectionState(conn);
      if (conn.status === 'connected' && state.needs_reconnect) {
        store.markConnectionError(pool, req.shop.id, 'needs_reconnect', state.friendly).catch(() => {});
      }
      return res.json({
        ok: true,
        connection: {
          status: state.status,
          connected: state.connected,
          needs_reconnect: state.needs_reconnect,
          display_phone_number: conn.display_phone_number || '',
          business_name: conn.business_name || '',
          connected_at: conn.connected_at || null,
          token_expires_at: conn.token_expires_at || null,
          last_error: state.connected ? '' : (state.friendly || ''),
          template
        }
      });
    } catch (e) {
      console.error('whatsapp status failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Status unavailable' });
    }
  });

  app.post('/v1/whatsapp/connect-session', device, async (req, res) => {
    try {
      const session = await onboarding.createSession(pool, req.shop.id, config.publicUrl);
      return res.json({ ok: true, onboardingUrl: session.onboardingUrl, expiresAt: session.expiresAt });
    } catch (e) {
      console.error('connect-session failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Could not start onboarding' });
    }
  });

  app.post('/v1/whatsapp/disconnect', device, async (req, res) => {
    try {
      await onboarding.disconnectShop(fullDeps, req.shop.id);
      return res.json({ ok: true });
    } catch (e) {
      console.error('disconnect failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Disconnect failed' });
    }
  });

  app.post('/v1/whatsapp/messages', device, async (req, res) => {
    const b = req.body || {};
    const idempotencyKey = String(b.idempotency_key || '');
    const normalizedPhone = String(b.normalized_phone || '').replace(/[\s\-().]/g, '');
    const messageType = String(b.message_type || 'invoice');
    if (!IDEMPOTENCY_RE.test(idempotencyKey)) {
      return res.status(400).json({ ok: false, error: 'idempotency_key is required' });
    }
    if (!PHONE_RE.test(normalizedPhone)) {
      return res.status(400).json({ ok: false, error: 'A valid international phone number is required' });
    }
    if (!MESSAGE_TYPES.has(messageType)) {
      return res.status(400).json({ ok: false, error: 'Unsupported message_type' });
    }
    const payload = sanitizeMessagePayload(messageType, b.payload);
    if (!payload.ok) {
      return res.status(400).json({ ok: false, error: payload.error });
    }
    try {
      const conn = await store.getConnection(pool, req.shop.id);
      if (!conn || conn.status !== 'connected') {
        return res.status(409).json({ ok: false, code: 'not_connected', error: 'WhatsApp is not connected' });
      }
      const existing = await store.findMessageByIdempotency(pool, req.shop.id, idempotencyKey);
      if (existing) {
        return res.json({ ok: true, message: { id: existing.id, status: existing.status }, duplicate: true });
      }
      let messageId;
      try {
        messageId = await store.createMessageWithQueue(pool, {
          shopId: req.shop.id,
          invoiceId: String(b.invoice_id || '').slice(0, 60),
          customerId: String(b.customer_id || '').slice(0, 60),
          customerPhone: String(b.customer_phone || '').slice(0, 40),
          normalizedPhone,
          messageType,
          templateName: String(b.template_name || 'mart_pos_invoice').slice(0, 120),
          payload: payload.value,
          idempotencyKey
        });
      } catch (e) {
        // Two concurrent posts with the same key: the second loses the unique
        // constraint race and is reported as the duplicate it is.
        if (e && e.code === '23505') {
          const dup = await store.findMessageByIdempotency(pool, req.shop.id, idempotencyKey);
          if (dup) {
            return res.json({ ok: true, message: { id: dup.id, status: dup.status }, duplicate: true });
          }
        }
        throw e;
      }
      return res.json({ ok: true, message: { id: messageId, status: 'pending' } });
    } catch (e) {
      console.error('enqueue message failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Could not queue the message' });
    }
  });

  app.post('/v1/whatsapp/messages/:id/retry', device, async (req, res) => {
    try {
      const ok = await store.requeueMessage(pool, req.shop.id, String(req.params.id));
      if (!ok) {
        return res.status(409).json({ ok: false, error: 'Only failed messages can be retried' });
      }
      return res.json({ ok: true, message: { id: req.params.id, status: 'pending' } });
    } catch (e) {
      console.error('retry failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Retry failed' });
    }
  });

  app.get('/v1/whatsapp/messages/updates', device, async (req, res) => {
    const sinceRaw = String(req.query.since || '');
    const afterId = String(req.query.after_id || '');
    const since = sinceRaw ? new Date(sinceRaw) : new Date(UPDATES_DEFAULT_SINCE);
    if (isNaN(since)) {
      return res.status(400).json({ ok: false, error: 'since must be an ISO timestamp' });
    }
    try {
      const updates = await store.messageUpdatesSince(pool, req.shop.id, since.toISOString(), afterId);
      const last = updates.length ? updates[updates.length - 1] : null;
      return res.json({
        ok: true,
        updates,
        next: last ? { updated_at: last.updated_at, id: last.id } : null,
        has_more: updates.length === UPDATES_PAGE_SIZE
      });
    } catch (e) {
      console.error('updates failed:', redactText(e.message || 'error'));
      return res.status(500).json({ ok: false, error: 'Updates unavailable' });
    }
  });

  return app;
}

module.exports = { createApp };
