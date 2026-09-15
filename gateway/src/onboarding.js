// Hosted Embedded Signup. The user-entered PIN and the login code are posted
// once in the JSON body and are never logged.
const store = require('./store');
const { sha256Hex, randomToken, encryptValue, decryptValue } = require('./cryptoUtil');
const { ensureInvoiceTemplate } = require('./templates');
const { redact } = require('./redact');

const PIN_RE = /^\d{6}$/;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderOnboardingPage({ token, appId, configId, version, nonce }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect WhatsApp - MartPOS</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#1c1e21}
  button{background:#1877f2;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:16px;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  input{font-size:18px;padding:8px 10px;width:180px;letter-spacing:3px}
  label{display:block;margin:16px 0 4px;font-weight:600}
  .help{font-size:13px;color:#606770}
  #msg{margin-top:16px;color:#606770}
</style></head><body>
<h2>Connect WhatsApp for MartPOS</h2>
<p>Link your WhatsApp Business account so the POS can send invoice PDFs to customers.</p>
<label for="pin">Create or enter your 6-digit WhatsApp security PIN</label>
<input id="pin" type="password" inputmode="numeric" pattern="\\d{6}" maxlength="6" autocomplete="off" required />
<p class="help">If this phone number is already registered for WhatsApp, enter its existing PIN.
If it is a new number, choose any memorable 6 digits - Meta will ask for this PIN when verifying the number.</p>
<button id="connect">Connect with Facebook</button>
<p id="msg"></p>
<script${nonce ? ` nonce="${escapeHtml(nonce)}"` : ''}>
  var ONBOARD_TOKEN = ${JSON.stringify(token)};
  var msg = document.getElementById('msg');
  var btn = document.getElementById('connect');
  var pinEl = document.getElementById('pin');
  var authCode = null, wabaId = null, phoneNumberId = null, submitting = false;

  function tryComplete() {
    var pin = pinEl.value.trim();
    if (submitting || !authCode || !wabaId || !phoneNumberId || !/^\\d{6}$/.test(pin)) return;
    submitting = true;
    btn.disabled = true;
    msg.textContent = 'Finishing setup...';
    fetch('/onboarding/' + encodeURIComponent(ONBOARD_TOKEN) + '/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: authCode, wabaId: wabaId, phoneNumberId: phoneNumberId, pin: pin })
    }).then(function(r) { return r.json(); }).then(function(r) {
      if (r && r.ok) {
        msg.textContent = 'All set! WhatsApp is connected - you can close this window and return to the POS.';
      } else {
        submitting = false;
        btn.disabled = false;
        msg.textContent = 'Setup failed: ' + ((r && r.error) || 'unknown error') + '. Start again from the POS settings.';
      }
    }).catch(function() {
      submitting = false;
      btn.disabled = false;
      msg.textContent = 'Setup failed to reach the server. Start again from the POS settings.';
    });
  }

  window.fbAsyncInit = function() {
    FB.init({ appId: ${JSON.stringify(appId)}, autoLogAppEvents: true, xfbml: true, version: ${JSON.stringify(version)} });
  };

  // Only real facebook.com origins may deliver session data - the origin is
  // parsed, not string-matched.
  window.addEventListener('message', function(event) {
    try {
      var host = new URL(event.origin).hostname;
      if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return;
    } catch (e) { return; }
    try {
      var data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (!data || data.type !== 'WA_EMBEDDED_SIGNUP' || !data.data) return;
      if (data.event === 'FINISH' || data.event === 'FINISH_ONLY_WABA_MIGRATION' || !data.event) {
        if (data.data.waba_id) wabaId = data.data.waba_id;
        if (data.data.phone_number_id) phoneNumberId = data.data.phone_number_id;
        tryComplete();
      } else {
        msg.textContent = 'Signup was not completed. You can close this window and try again from the POS.';
      }
    } catch (e) { /* ignore unparsable events */ }
  });

  btn.addEventListener('click', function() {
    var pin = pinEl.value.trim();
    if (!/^\\d{6}$/.test(pin)) {
      msg.textContent = 'Enter a 6-digit PIN first.';
      pinEl.focus();
      return;
    }
    msg.textContent = 'Opening Facebook...';
    FB.login(function(response) {
      if (!response || !response.authResponse || !response.authResponse.code) {
        msg.textContent = 'Signup was cancelled or did not complete. You can close this window and try again.';
        return;
      }
      authCode = response.authResponse.code;
      tryComplete();
    }, { config_id: ${JSON.stringify(configId)}, response_type: 'code', override_default_response_type: true, extras: { setup: {} } });
  });
</script>
<script${nonce ? ` nonce="${escapeHtml(nonce)}"` : ''} async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>
</body></html>`;
}

function renderInfoPage(title, text) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px">
<h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></body></html>`;
}

async function createSession(q, shopId, publicUrl) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await store.createOnboardingSession(q, { shopId, tokenHash: sha256Hex(token), expiresAt });
  return {
    onboardingUrl: `${publicUrl}/onboarding/${token}`,
    expiresAt
  };
}

// All local validation runs first; the session is consumed atomically only
// then - immediately before the first Meta call - so a retried/concurrent
// submit cannot replay it. The reported phone_number_id must appear under the
// reported WABA - caller-bound IDs are never trusted.
async function completeOnboarding(deps, token, body) {
  const { pool, config } = deps;
  const code = body && body.code;
  const wabaId = body && body.wabaId;
  const phoneNumberId = body && body.phoneNumberId;
  const pin = body && body.pin;
  if (!code || !wabaId || !phoneNumberId) {
    return { ok: false, error: 'Signup did not return the required account details.' };
  }
  if (!PIN_RE.test(String(pin || ''))) {
    return { ok: false, error: 'A 6-digit WhatsApp security PIN is required.' };
  }

  const session = await store.consumeOnboardingSession(pool, sha256Hex(String(token || '')));
  if (!session) return { ok: false, error: 'This onboarding link has expired or was already used.' };

  const meta = deps.metaFor({ accessToken: '' });
  const exchanged = await meta.exchangeCode(String(code));
  const accessToken = exchanged && exchanged.access_token;
  if (!accessToken) return { ok: false, error: 'Could not set up the WhatsApp connection.' };
  const expiresAt = exchanged && exchanged.expires_in
    ? new Date(Date.now() + Number(exchanged.expires_in) * 1000).toISOString()
    : null;

  const authed = deps.metaFor({ accessToken });
  const numbers = await authed.listPhoneNumbers(wabaId);
  const bound = numbers && Array.isArray(numbers.data)
    ? numbers.data.find((n) => String(n.id) === String(phoneNumberId))
    : null;
  if (!bound) {
    return { ok: false, error: 'Could not set up the WhatsApp connection.' };
  }

  // The number may already belong to another shop - check before any
  // register/subscribe/template side effects. The unique index stays as the
  // last line of defense for concurrent races.
  const claimedBy = await store.findConnectionByPhoneNumberId(pool, phoneNumberId);
  if (claimedBy && claimedBy.shop_id !== session.shop_id) {
    return { ok: false, error: 'This WhatsApp number is already connected to another MartPOS shop.' };
  }

  await authed.registerPhone(phoneNumberId, pin);
  await authed.subscribeWaba(wabaId);
  await ensureInvoiceTemplate(pool, authed, session.shop_id, wabaId);

  const enc = encryptValue(accessToken, config.encryptionKey);
  try {
    await store.upsertConnection(pool, session.shop_id, {
      provider: 'meta',
      business_account_id: String(wabaId),
      phone_number_id: String(phoneNumberId),
      display_phone_number: bound.display_phone_number || '',
      business_name: bound.verified_name || '',
      access_token_ciphertext: enc.ciphertext,
      access_token_iv: enc.iv,
      access_token_tag: enc.tag,
      token_expires_at: expiresAt,
      status: 'connected',
      connected_at: new Date().toISOString(),
      last_error: ''
    });
  } catch (e) {
    // The session is already consumed - the owner restarts setup from the POS.
    if (e && e.code === '23505' && e.constraint === 'idx_wa_connections_phone_unique') {
      return { ok: false, error: 'This WhatsApp number is already connected to another MartPOS shop.' };
    }
    throw e;
  }
  return { ok: true };
}

// Best-effort unsubscribe before the local connection is tombstoned.
async function disconnectShop(deps, shopId) {
  const { pool, config } = deps;
  const conn = await store.getConnection(pool, shopId);
  if (conn && conn.business_account_id && conn.access_token_ciphertext) {
    try {
      const token = decryptValue(
        { ciphertext: conn.access_token_ciphertext, iv: conn.access_token_iv, tag: conn.access_token_tag },
        config.encryptionKey
      );
      await deps.metaFor({ accessToken: token }).unsubscribeWaba(conn.business_account_id);
    } catch (e) {
      console.error('unsubscribe during disconnect failed:', redact(e).message || 'error');
    }
  }
  await store.withTx(pool, async (q) => {
    await store.cancelPendingJobs(q, shopId);
    await store.markDisconnected(q, shopId);
  });
  return { ok: true };
}

module.exports = {
  renderOnboardingPage, renderInfoPage,
  createSession, completeOnboarding, disconnectShop, PIN_RE
};
