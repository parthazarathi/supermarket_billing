// Gateway-vendored AI provisioning. The customer never installs a credential
// file: after a Google sign-in the POS exchanges the verified id_token for
// an AI grant (the gateway re-verifies the token itself) and pulls the
// MARTPOS-managed Gemini key with it. The grant and key are cached in the
// encrypted secrets store; key rotation propagates on the next fetch.
const { cloudBaseUrl, api: cloudApi, deviceToken } = require('../whatsapp/gatewayClient');
const { getSecret, setSecret } = require('../secrets');

function aiGrant() {
  return getSecret('ai_gateway_grant') || '';
}

// "Linked" for AI purposes: a gateway URL plus either an AI grant or the
// WhatsApp device token - both are accepted by /v1/ai/credential.
function aiCloudLinked() {
  return !!(cloudBaseUrl() && (aiGrant() || deviceToken()));
}

// POST /v1/ai/link: the id_token is re-verified by the gateway (audience,
// issuer, signature) before a grant is issued. Returns {grant_token,
// api_key} or null on any failure - AI is an add-on, never a blocker.
async function linkIdentity(idToken) {
  if (!cloudBaseUrl() || !idToken) return null;
  try {
    const res = await cloudApi('/v1/ai/link', { method: 'POST', body: { id_token: idToken } });
    if (res && res.ok) {
      if (res.grant_token) setSecret('ai_gateway_grant', res.grant_token);
      if (res.api_key) setSecret('gemini_api_key_cloud', String(res.api_key).trim());
      return res;
    }
    return null;
  } catch (e) {
    console.error('AI cloud link failed:', e.message);
    return null;
  }
}

let credFlight = null;

// GET /v1/ai/credential with the AI grant (or device token). One in-flight
// request at a time; resolves to null on any failure.
function fetchCredential() {
  if (credFlight) return credFlight;
  credFlight = (async () => {
    try {
      const bearer = aiGrant() || deviceToken();
      if (!cloudBaseUrl() || !bearer) return null;
      const res = await cloudApi('/v1/ai/credential', { token: bearer });
      return res && res.ok ? res : null;
    } catch (e) {
      console.error('AI cloud credential fetch failed:', e.message);
      return null;
    } finally {
      credFlight = null;
    }
  })();
  return credFlight;
}

function fetchAiProvisioning({ idToken } = {}) {
  return idToken ? linkIdentity(idToken) : fetchCredential();
}

// Public endpoint - no token required: the OAuth "Desktop app" client is
// vendored so fresh installs can sign in with zero local configuration.
async function fetchOAuthClient() {
  try {
    if (!cloudBaseUrl()) return null;
    const res = await cloudApi('/v1/ai/oauth-client', { token: '' });
    const clientId = String((res && res.google_client_id) || '').trim();
    if (!clientId) return null;
    return { client_id: clientId, client_secret: String(res.google_client_secret || '') };
  } catch (_) {
    return null;
  }
}

// Remove Account: revoke the grant server-side, best-effort.
async function revokeAiGrant() {
  const grant = aiGrant();
  if (!grant || !cloudBaseUrl()) return;
  try {
    await cloudApi('/v1/ai/link', { method: 'DELETE', token: grant });
  } catch (_) { /* offline - local cleanup still proceeds */ }
}

module.exports = { fetchAiProvisioning, fetchOAuthClient, revokeAiGrant, aiCloudLinked, aiGrant };
