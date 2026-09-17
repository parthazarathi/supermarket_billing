// AI provider abstraction. The rest of the app talks to the AIProvider
// interface only - no OpenAI-specific code outside this file, so another
// provider can be added later without touching the service layer.
//
// Credential resolution order:
//   1. lib/secrets 'openai_api_key' (DPAPI/AES-GCM encrypted store - the
//      same mechanism used for the cloud device token)
//   2. OPENAI_API_KEY environment variable (server-mode deployments)
// Keys are never logged, never returned to the frontend, never in the DB.
const { getSecret } = require('../secrets');
const { redactText } = require('../redact');

class AIProviderError extends Error {
  constructor(message, { code = 'provider', status = 0 } = {}) {
    super(redactText(message || 'AI provider error'));
    this.name = 'AIProviderError';
    this.code = code; // not_configured | offline | auth | rate_limited | provider | timeout
    this.status = status;
  }
}

// Interface implemented by providers:
//   generateResponse({ model, messages, tools, timeoutMs }) ->
//     { message: { role, content, tool_calls? }, usage? }
class AIProvider {
  constructor() {
    if (new.target === AIProvider) {
      throw new Error('AIProvider is abstract');
    }
  }
  // eslint-disable-next-line no-unused-vars
  async generateResponse(_request) {
    throw new Error('not implemented');
  }
}

function apiKey() {
  const fromStore = getSecret('openai_api_key');
  if (fromStore) return fromStore;
  return String(process.env.OPENAI_API_KEY || '').trim();
}

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 30000;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

class OpenAIProvider extends AIProvider {
  constructor({ key } = {}) {
    super();
    this._key = key !== undefined ? key : null; // null = resolve lazily per call
  }

  resolvedKey() {
    return this._key !== null ? this._key : apiKey();
  }

  configured() {
    return !!this.resolvedKey();
  }

  async generateResponse({ model, messages, tools, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const key = this.resolvedKey();
    if (!key) {
      throw new AIProviderError('AI is not configured - add an OpenAI API key in Settings', { code: 'not_configured' });
    }

    const body = {
      model: model || DEFAULT_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 900
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
      body.parallel_tool_calls = false;
    }

    let res;
    try {
      res = await globalThis.fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/abort|timeout/i.test(msg) || (e && e.name === 'TimeoutError')) {
        throw new AIProviderError('AI request timed out', { code: 'timeout' });
      }
      throw new AIProviderError(msg, { code: 'offline' });
    }

    let json = null;
    try { json = await res.json(); } catch (_) { /* non-json */ }
    if (!res.ok) {
      const errMsg = (json && json.error && json.error.message) || `HTTP ${res.status}`;
      // OpenAI reports quota exhaustion inconsistently - as error.code,
      // error.type, or only inside the message text. Check all three.
      const providerCode = String((json && json.error && (json.error.code || json.error.type)) || '');
      const isQuota = /insufficient_quota/i.test(providerCode)
        || /no credits|exceeded your current quota|billing|payment required/i.test(errMsg);
      const code = res.status === 401 || res.status === 403 ? 'auth'
        : res.status === 429 ? (isQuota ? 'quota' : 'rate_limited')
          : res.status === 402 ? 'quota'
            : res.status === 404 || providerCode === 'model_not_found' ? 'model' : 'provider';
      const err = new AIProviderError(errMsg, { code, status: res.status });
      err.providerCode = providerCode;
      throw err;
    }

    const choice = json && json.choices && json.choices[0];
    if (!choice || !choice.message) {
      throw new AIProviderError('Empty response from AI provider', { code: 'provider' });
    }
    return { message: choice.message, usage: json.usage || null };
  }
}

// The configured provider instance. Kept behind a function so tests can
// substitute a fake provider via setProvider().
let activeProvider = new OpenAIProvider();

function getProvider() {
  return activeProvider;
}

function setProvider(p) {
  activeProvider = p;
}

function aiConfigured() {
  try {
    return !!(activeProvider && activeProvider.configured && activeProvider.configured());
  } catch (_) {
    return false;
  }
}

module.exports = {
  AIProvider,
  OpenAIProvider,
  AIProviderError,
  getProvider,
  setProvider,
  aiConfigured,
  apiKey,
  DEFAULT_MODEL
};
