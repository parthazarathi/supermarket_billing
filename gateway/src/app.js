const express = require('express');
const store = require('./store');
const onboarding = require('./onboarding');
const { authRoutes, deviceAuth } = require('./auth');
const { supportRoutes } = require('./support');
const { metaFactory } = require('./queueWorker');
const {
  verifySignature, digestBody, validatePayload, extractStatusUpdates, applyStatusUpdates
} = require('./webhook');
const { sha256Hex, randomToken } = require('./cryptoUtil');
const { sanitizeMessagePayload } = require('./payload');
const { redactText } = require('./redact');
const { connectionState } = require('./status');

const PHONE_RE = /^\+?\d{8,15}$/;
const IDEMPOTENCY_RE = /^[\w:.-]{4,200}$/;
const MESSAGE_TYPES = new Set(['invoice', 'test', 'template']);
const UPDATES_PAGE_SIZE = 500;
const UPDATES_DEFAULT_SINCE = '1970-01-01T00:00:00.000Z';

function createApp(deps) {
  const { config, pool } = deps;
  const metaFor = deps.metaFor || metaFactory(config);
  const fullDeps = { config, pool, metaFor };

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
