// Provider implementation backed by the cloud gateway; Meta credentials never
// reach this machine.
const client = require('./gatewayClient');
const { policyError } = require('./service');

class GatewayProvider {
  connect() {
    return client.api('/v1/whatsapp/connect-session', { method: 'POST', body: {} });
  }

  disconnect() {
    return client.api('/v1/whatsapp/disconnect', { method: 'POST', body: {} });
  }

  getConnectionStatus() {
    return client.api('/v1/whatsapp/status');
  }

  sendInvoice(context, invoice) {
    return client.api('/v1/whatsapp/messages', { method: 'POST', body: invoice });
  }

  sendText() {
    return Promise.resolve(policyError('sendText'));
  }

  sendDocument() {
    return Promise.resolve(policyError('sendDocument'));
  }

  sendTemplate(context, template) {
    return client.api('/v1/whatsapp/messages', {
      method: 'POST',
      body: { ...template, message_type: 'template' }
    });
  }

  getMessageStatus() {
    return Promise.resolve(policyError('getMessageStatus'));
  }

  retryMessage(context, id) {
    return client.api(`/v1/whatsapp/messages/${encodeURIComponent(id)}/retry`, { method: 'POST', body: {} });
  }

  validateNumber(number, options) {
    try {
      const { normalizeWhatsAppNumber } = require('../whatsapp');
      return Promise.resolve({ ok: true, normalized: normalizeWhatsAppNumber(number, options) });
    } catch (e) {
      return Promise.resolve({ ok: false, error: e.message, friendly: e.message });
    }
  }
}

function createGatewayProvider() {
  return new GatewayProvider();
}

module.exports = { GatewayProvider, createGatewayProvider };
