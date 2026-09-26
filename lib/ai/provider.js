// AI provider abstraction. The rest of the app talks to the AIProvider
// interface only - no Gemini-specific code outside this file, so another
// provider can be added later without touching the service layer.
//
// Current provider: Google Gemini (cloud API, free tier capable).
// Internally the service layer keeps an OpenAI-style message format
// ({role, content, tool_calls} / {role:'tool', name, content}); this file
// translates to/from Gemini's generateContent API - including function
// calling - so the chat loop stays provider-agnostic.
//
// Credential resolution order:
//   1. lib/secrets 'gemini_api_key' (DPAPI/AES-GCM encrypted store - the
//      same mechanism used for the cloud device token)
//   2. GEMINI_API_KEY environment variable (server-mode deployments)
// Keys are never logged, never returned to the frontend, never in the DB.
const { getSecret } = require('../secrets');
const { redactText } = require('../redact');

class AIProviderError extends Error {
  constructor(message, { code = 'provider', status = 0 } = {}) {
    super(redactText(message || 'AI provider error'));
    this.name = 'AIProviderError';
    this.code = code; // not_configured | offline | auth | rate_limited | provider | timeout | model | quota
    this.status = status;
  }
}

// Interface implemented by providers:
//   generateResponse({ model, messages, tools, timeoutMs }) ->
//     { message: { role, content, tool_calls? }, usage? }
//   configured() -> boolean
//   status(model) -> optional live availability check
//     { reachable, model_available }
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
  const fromStore = getSecret('gemini_api_key');
  if (fromStore) return fromStore;
  return String(process.env.GEMINI_API_KEY || '').trim();
}

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 30000;
const API_BASE = 'https://generativelanguage.googleapis.com';
const STATUS_TIMEOUT_MS = 8000;

// ---- message format translation (OpenAI-style -> Gemini) ----

// Tool parameter schemas arrive as JSON Schema ({type:'object', ...});
// Gemini expects OpenAPI-style schemas with UPPERCASE types and does not
// accept arbitrary JSON-Schema keywords. Strip to the supported subset.
function sanitizeSchema(node) {
  if (!node || typeof node !== 'object') return { type: 'OBJECT', properties: {} };
  const out = {};
  if (node.type) out.type = String(node.type).toUpperCase();
  if (node.description) out.description = node.description;
  if (Array.isArray(node.enum)) out.enum = node.enum.map(String);
  if (Array.isArray(node.required)) out.required = node.required;
  if (node.properties && typeof node.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(node.properties)) {
      out.properties[k] = sanitizeSchema(v);
    }
  }
  if (node.items) out.items = sanitizeSchema(node.items);
  return out;
}

function toFunctionDeclarations(tools) {
  return (tools || []).map((t) => {
    const fn = (t && t.function) || t || {};
    return {
      name: fn.name,
      description: fn.description,
      parameters: sanitizeSchema(fn.parameters || { type: 'object', properties: {} })
    };
  });
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) {
    return {};
  }
}

// Gemini roles are 'user' and 'model'. Tool results go back as
// functionResponse parts in a user-role turn. Consecutive same-role turns
// are merged (Gemini wants user/model alternation), and a leading 'model'
// turn is dropped (contents must start with user).
function toContents(messages) {
  const contents = [];
  let sawUser = false;
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'system') continue; // collected separately as instruction
    let role = null;
    let parts = null;
    if (m.role === 'user') {
      role = 'user';
      parts = [{ text: String(m.content || '') }];
    } else if (m.role === 'assistant') {
      if (!sawUser) continue;
      role = 'model';
      parts = [];
      if (m.content) parts.push({ text: String(m.content) });
      for (const tc of (m.tool_calls || [])) {
        const fn = (tc && tc.function) || {};
        if (!fn.name) continue;
        parts.push({ functionCall: { name: fn.name, args: parseArgs(fn.arguments) } });
      }
      if (!parts.length) parts.push({ text: '' });
    } else if (m.role === 'tool') {
      role = 'user';
      let response;
      try {
        const parsed = JSON.parse(m.content);
        response = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed : { result: parsed };
      } catch (_) {
        response = { result: String(m.content || '') };
      }
      parts = [{ functionResponse: { name: m.name || 'tool', response } }];
    }
    if (!role) continue;
    if (role === 'user') sawUser = true;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents;
}

function systemText(messages) {
  return (messages || [])
    .filter((m) => m && m.role === 'system' && m.content)
    .map((m) => String(m.content))
    .join('\n');
}

// Gemini response -> OpenAI-style message.
function fromGemini(json) {
  const cand = json && json.candidates && json.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  if (!parts.length) return null;
  const text = [];
  const toolCalls = [];
  let i = 0;
  for (const part of parts) {
    if (typeof part.text === 'string') text.push(part.text);
    else if (part.functionCall && part.functionCall.name) {
      toolCalls.push({
        id: `call_${i++}`,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {})
        }
      });
    }
  }
  const message = { role: 'assistant', content: text.join('').trim() };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return message;
}

class GeminiProvider extends AIProvider {
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
      throw new AIProviderError('AI is not configured - add a Gemini API key in Settings', { code: 'not_configured' });
    }
    const m = model || DEFAULT_MODEL;
    const url = `${API_BASE}/v1beta/models/${encodeURIComponent(m)}:generateContent`;

    const body = {
      contents: toContents(messages),
      generationConfig: { temperature: 0.2, maxOutputTokens: 900 }
    };
    const sys = systemText(messages);
    if (sys) body.system_instruction = { parts: [{ text: sys }] };
    const decls = toFunctionDeclarations(tools);
    if (decls.length) body.tools = [{ function_declarations: decls }];

    let res;
    try {
      res = await globalThis.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': key
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
      const gerr = (json && json.error) || {};
      const errMsg = gerr.message || `HTTP ${res.status}`;
      const gstatus = String(gerr.status || '');
      const code = res.status === 401 || res.status === 403 ? 'auth'
        : res.status === 429 ? (/(quota|resource_exhausted|daily)/i.test(`${gstatus} ${errMsg}`) ? 'quota' : 'rate_limited')
          : res.status === 404 || /NOT_FOUND|not found|is not supported/i.test(gstatus + ' ' + errMsg) ? 'model'
            : 'provider';
      const err = new AIProviderError(errMsg, { code, status: res.status });
      err.providerCode = gstatus;
      throw err;
    }

    if (json && json.promptFeedback && json.promptFeedback.blockReason) {
      throw new AIProviderError(`Blocked: ${json.promptFeedback.blockReason}`, { code: 'provider' });
    }
    const message = fromGemini(json);
    if (!message) {
      throw new AIProviderError('Empty response from AI provider', { code: 'provider' });
    }
    return { message, usage: json.usageMetadata || null };
  }

  // Live check: is the API reachable and does the configured model exist?
  // Never throws - an offline/error state is reported, not raised.
  async status(model) {
    const m = model || DEFAULT_MODEL;
    const out = { provider: 'gemini', reachable: false, model_available: null };
    if (!this.resolvedKey()) return out;
    let res;
    try {
      res = await globalThis.fetch(`${API_BASE}/v1beta/models/${encodeURIComponent(m)}`, {
        headers: { 'x-goog-api-key': this.resolvedKey() },
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS)
      });
    } catch (_) {
      return out;
    }
    if (res.status === 404) {
      out.reachable = true;
      out.model_available = false;
      return out;
    }
    out.reachable = res.ok;
    if (res.ok) out.model_available = true;
    return out;
  }
}

// The configured provider instance. Kept behind a function so tests can
// substitute a fake provider via setProvider().
let activeProvider = new GeminiProvider();

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
  GeminiProvider,
  AIProviderError,
  getProvider,
  setProvider,
  aiConfigured,
  apiKey,
  DEFAULT_MODEL
};
