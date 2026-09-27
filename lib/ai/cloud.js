// Gateway-vendored AI provisioning. Cloud-linked installs (device token
// from the MartPOS owner account - the same link WhatsApp billing uses)
// pull the Gemini key and the Google OAuth client config from the hosted
// gateway. Nothing sensitive ships in the installer and no
// credentials.json is needed on the machine; rotating the key or the
// OAuth client server-side reaches installs on the next fetch.
const { cloudLinked, api: cloudApi } = require('../whatsapp/gatewayClient');

let inFlight = null;

// GET /v1/ai/credential -> { api_key?, google_client_id?, google_client_secret? }
// One in-flight request at a time; resolves to null on any failure - the
// AI is an optional add-on, so a gateway outage must never break POS work.
function fetchAiProvisioning() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      if (!cloudLinked()) return null;
      const res = await cloudApi('/v1/ai/credential');
      return res && res.ok ? res : null;
    } catch (e) {
      console.error('AI cloud provisioning fetch failed:', e.message);
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

module.exports = { fetchAiProvisioning, cloudLinked };
