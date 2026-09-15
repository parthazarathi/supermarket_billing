// Providers must implement every method; operations a provider does not
// support return a policy-safe error result, never a silent send.
class WhatsAppService {
  constructor(provider) { this.provider = provider; }
  connect(context) { return this.provider.connect(context); }
  disconnect(context) { return this.provider.disconnect(context); }
  getConnectionStatus(context) { return this.provider.getConnectionStatus(context); }
  sendInvoice(context, invoice) { return this.provider.sendInvoice(context, invoice); }
  sendText(context, message) { return this.provider.sendText(context, message); }
  sendDocument(context, document) { return this.provider.sendDocument(context, document); }
  sendTemplate(context, template) { return this.provider.sendTemplate(context, template); }
  getMessageStatus(context, id) { return this.provider.getMessageStatus(context, id); }
  retryMessage(context, id, options) { return this.provider.retryMessage(context, id, options); }
  validateNumber(number, options) { return this.provider.validateNumber(number, options); }
}

function policyError(operation) {
  return {
    ok: false,
    code: 'policy_unsupported',
    error: `${operation} is not supported by this WhatsApp provider; only approved template sends are allowed.`,
    friendly: 'This action is not supported by the WhatsApp provider.'
  };
}

module.exports = { WhatsAppService, policyError };
