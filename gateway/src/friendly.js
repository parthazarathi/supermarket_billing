// Maps Meta/gateway failure codes to the fixed user-facing strings that are
// persisted on message rows and surfaced to the POS. Raw Meta titles/bodies
// are never stored.
const TEMPLATE_UNAVAILABLE = 'The WhatsApp bill template is not available yet. Please contact support.';
const INVALID_RECIPIENT = 'The customer number is not a valid WhatsApp recipient.';
const EXPIRED_CONNECTION = 'WhatsApp connection expired. Please reconnect WhatsApp.';
const UNDELIVERABLE = 'WhatsApp could not deliver this message.';
const GENERIC_FAILED = 'WhatsApp delivery failed.';

function friendlyMetaError(code) {
  const c = Number(code) || 0;
  if (code === 'template_not_approved' || (c >= 132000 && c < 133000)) return TEMPLATE_UNAVAILABLE;
  if (c === 190 || c === 10 || c === 200 || c === 133008 || c === 133009) return EXPIRED_CONNECTION;
  if (c === 131021 || c === 131026 || c === 131030 || c === 131031 || c === 133010) return INVALID_RECIPIENT;
  if (c === 131047 || c === 130429 || c === 131048 || c === 131056 || c === 131057) return UNDELIVERABLE;
  return GENERIC_FAILED;
}

module.exports = {
  friendlyMetaError,
  TEMPLATE_UNAVAILABLE, INVALID_RECIPIENT, EXPIRED_CONNECTION, UNDELIVERABLE, GENERIC_FAILED
};
