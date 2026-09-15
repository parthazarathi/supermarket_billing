class MetaError extends Error {
  constructor(message, { status = 0, metaCode = 0, subcode = 0 } = {}) {
    super(message || 'Meta request failed');
    this.name = 'MetaError';
    this.status = status;
    this.metaCode = metaCode;
    this.subcode = subcode;
  }
}

class MetaClient {
  constructor({ baseUrl, version, accessToken = '', appId = '', appSecret = '', fetchImpl } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.version = version;
    this.accessToken = accessToken;
    this.appId = appId;
    this.appSecret = appSecret;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  url(path, query) {
    const qs = query
      ? '?' + Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
      : '';
    return `${this.baseUrl}/${this.version}${path}${qs}`;
  }

  async request(method, path, { query, body, form, auth = true } = {}) {
    const headers = {};
    if (auth && this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await this.fetch(this.url(path, query), { method, headers, body: payload });
    } catch (e) {
      throw new MetaError(e.message || 'network error', { status: 0 });
    }
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-json body */ }
    const errObj = json && json.error;
    if (!res.ok || errObj) {
      throw new MetaError(
        (errObj && errObj.message) || `HTTP ${res.status}`,
        { status: res.status, metaCode: errObj ? errObj.code : 0, subcode: errObj ? errObj.error_subcode : 0 }
      );
    }
    return json;
  }

  exchangeCode(code) {
    return this.request('GET', '/oauth/access_token', {
      query: { client_id: this.appId, client_secret: this.appSecret, code },
      auth: false
    });
  }

  phoneNumberInfo(phoneNumberId) {
    return this.request('GET', `/${phoneNumberId}`, {
      query: { fields: 'display_phone_number,verified_name,code_verification_status,quality_rating' }
    });
  }

  listPhoneNumbers(wabaId) {
    return this.request('GET', `/${wabaId}/phone_numbers`, {
      query: { fields: 'id,display_phone_number,verified_name' }
    });
  }

  registerPhone(phoneNumberId, pin) {
    return this.request('POST', `/${phoneNumberId}/register`, {
      body: { messaging_product: 'whatsapp', pin: String(pin) }
    });
  }

  subscribeWaba(wabaId) {
    return this.request('POST', `/${wabaId}/subscribed_apps`, { body: {} });
  }

  unsubscribeWaba(wabaId) {
    return this.request('DELETE', `/${wabaId}/subscribed_apps`);
  }

  uploadMedia(phoneNumberId, buffer, filename, mimeType = 'application/pdf') {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([buffer], { type: mimeType }), filename);
    return this.request('POST', `/${phoneNumberId}/media`, { form });
  }

  // to must be digits only (no '+') for the Cloud API.
  sendTemplate(phoneNumberId, { to, name, language = 'en_US', components }) {
    return this.request('POST', `/${phoneNumberId}/messages`, {
      body: {
        messaging_product: 'whatsapp',
        to: String(to).replace(/\D/g, ''),
        type: 'template',
        template: { name, language: { code: language }, components: components || [] }
      }
    });
  }

  createMessageTemplate(wabaId, definition) {
    return this.request('POST', `/${wabaId}/message_templates`, { body: definition });
  }

  findMessageTemplate(wabaId, name) {
    return this.request('GET', `/${wabaId}/message_templates`, { query: { name } });
  }
}

module.exports = { MetaClient, MetaError };
