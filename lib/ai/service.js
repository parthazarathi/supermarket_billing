// AI Store Manager service: chat orchestration + dashboard summary.
// Sits on top of the existing POS business layer - tools call lib/reporting
// and lib/* modules; this file never touches the database directly.
const { getProvider, aiConfigured, AIProviderError, DEFAULT_MODEL } = require('./provider');
const { buildSystemPrompt } = require('./prompt');
const { toolSpecs, toolNames, executeTool, AiPermissionError } = require('./tools');
const {
  validateQuestion, sanitizeHistory, injectionFlags,
  checkRateLimit, hasRole, AiRateLimitError, AiBusyError
} = require('./security');
const { storeContext, userContext, namedRange } = require('./context');
const { logAiInteraction } = require('./audit');
const googleAuth = require('./googleAuth');
const { fetchAiProvisioning, revokeAiGrant, aiCloudLinked } = require('./cloud');
const { getSetting, setSettings } = require('../settings');
const { getSecret, setSecret } = require('../secrets');
const reports = require('./tools/reports');

const MAX_TOOL_ROUNDS = 5;
const SUMMARY_CACHE_MS = 15 * 60 * 1000; // 15 min - caps API calls from the dashboard

// ---- configuration ----
// Model + enable flag live in settings (non-secret); the key lives in the
// encrypted secrets store only.
function aiModel() {
  const stored = String(getSetting('ai_model', '') || '').trim();
  if (stored) return stored;
  const env = String(process.env.GEMINI_MODEL || '').trim();
  return env || DEFAULT_MODEL;
}

function aiEnabled() {
  return getSetting('ai_enabled', '1') !== '0';
}

// Where the Gemini credential comes from:
//   'platform' - GEMINI_API_KEY env var (operator/platform-managed mode)
//   'managed'  - key stored in the encrypted secrets store
//   'cloud'    - vendored by the MartPOS gateway for linked installs
//                (cached in the secrets store after the first fetch)
//   null       - no credential provisioned
// Never exposes the key itself.
function credentialMode() {
  if (String(process.env.GEMINI_API_KEY || '').trim()) return 'platform';
  if (getSecret('gemini_api_key')) return 'managed';
  if (aiCloudLinked() || getSecret('gemini_api_key_cloud')) return 'cloud';
  return null;
}

function googleConnected() {
  try {
    return googleAuth.identity().connected;
  } catch (_) {
    return false;
  }
}

function aiStatus() {
  return {
    enabled: aiEnabled(),
    configured: aiConfigured(),
    provider: 'gemini',
    model: aiModel(),
    key_set: aiConfigured(),
    credential_mode: credentialMode(),
    // Only display fields cross the API boundary - the Google subject id
    // stays server-side.
    google: publicGoogle(),
    google_signin_available: googleAuth.signInAvailable()
  };
}

function publicGoogle() {
  const g = googleAuth.identity();
  return { connected: g.connected, email: g.email, name: g.name, connected_at: g.connected_at };
}

// Live status: pings the Gemini API for the configured model. Cached briefly
// so the UI status poll does not burn API calls on every render.
const STATUS_CACHE_MS = 20000;
let statusCache = null;

async function aiStatusLive() {
  const base = aiStatus();
  if (!base.enabled || !base.configured) return base;
  if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) return statusCache.value;
  const live = { ...base, reachable: false, model_available: null };
  try {
    const p = getProvider();
    if (typeof p.status === 'function') {
      const s = await p.status(base.model);
      live.reachable = !!s.reachable;
      live.model_available = s.model_available;
    } else {
      live.reachable = null; // provider has no live check
    }
  } catch (_) { /* reported as unreachable */ }
  statusCache = { at: Date.now(), value: live };
  return live;
}

// Admin-only config change. The key is write-only: never echoed back.
function configureAi({ apiKey, model, enabled }) {
  if (apiKey !== undefined) {
    const v = String(apiKey || '').trim();
    if (v && (v.length < 20 || v.length > 200 || /\s/.test(v))) {
      throw new Error('That does not look like a valid API key');
    }
    setSecret('gemini_api_key', v); // '' clears
  }
  const updates = {};
  if (model !== undefined) {
    const m = String(model || '').trim();
    if (m && !/^[a-zA-Z0-9._-]{1,64}$/.test(m)) {
      throw new Error('Invalid model name');
    }
    updates.ai_model = m; // '' clears -> default
  }
  if (enabled !== undefined) {
    updates.ai_enabled = enabled ? '1' : '0';
  }
  if (Object.keys(updates).length) setSettings(updates);
  summaryCache.clear();
  statusCache = null;
  return aiStatus();
}

// ---- friendly errors (never raw SQL/stack/provider text to the user) ----
function friendlyProviderError(err) {
  if (err instanceof AIProviderError) {
    switch (err.code) {
    case 'not_configured':
      return { code: 'not_configured', message: 'AI Store Manager is not configured yet. An admin can add the Gemini API key in Settings.' };
    case 'offline':
      return { code: 'offline', message: 'AI Store Manager needs an internet connection. Your POS is still working normally.' };
    case 'timeout':
      return { code: 'offline', message: 'The AI service took too long to respond. Please try again.' };
    case 'auth':
      return { code: 'not_configured', message: 'The Gemini API key was rejected. An admin should update it in Settings.' };
    case 'rate_limited':
      return { code: 'rate_limited', message: 'AI usage limit reached. Please try again in a moment.' };
    case 'quota':
      return { code: 'quota', message: 'AI usage limit reached for now. The free Gemini tier resets daily - or an admin can switch models in Settings.' };
    case 'model':
      return { code: 'model', message: 'The configured Gemini model is not available. An admin can change the model in Settings.' };
    default:
      return { code: 'unavailable', message: 'AI Store Manager is temporarily unavailable. Your POS billing and other features continue to work normally.' };
    }
  }
  return { code: 'unavailable', message: 'AI Store Manager is temporarily unavailable. Your POS billing and other features continue to work normally.' };
}

// Provisions + verifies the Gemini credential (vendored keys are pulled
// from the gateway inside generateResponse). Runs the same connectivity
// probe the self-test uses - never throws, reports ok/error instead.
async function provisionAndTest() {
  try {
    const { message } = await getProvider().generateResponse({
      model: aiModel(),
      timeoutMs: 15000,
      messages: [
        { role: 'system', content: 'You are a connectivity probe. Reply with exactly: OK' },
        { role: 'user', content: 'Say OK' }
      ]
    });
    statusCache = null;
    summaryCache.clear();
    return { ok: !!(message && message.content) };
  } catch (err) {
    const friendly = friendlyProviderError(err);
    return { ok: false, error: friendly.code, message: friendly.message };
  }
}

// Google connect: the request stays open for the whole browser flow, then
// links + provisions + verifies AI before the identity is stored - the UI
// flips to Connected only when both halves succeeded, and a provisioning
// failure never disturbs an existing account (Change Account safe).
async function connectGoogle() {
  const { payload, idToken } = await googleAuth.signIn();
  // The gateway re-verifies the id_token itself and issues a scoped AI
  // grant; the vendored Gemini key arrives with it. Best-effort - a local
  // or platform credential can still satisfy provisioning below.
  await fetchAiProvisioning({ idToken });
  const prov = await provisionAndTest();
  if (!prov.ok) {
    return { google: { connected: false }, provisioned: false, provider_error: prov };
  }
  const stored = googleAuth.storeIdentity(payload);
  return { google: stored, provisioned: true, provider_error: null };
}

// Remove account: revokes the AI grant on the gateway (best-effort), then
// clears the verified identity, the grant and the cached vendored key so a
// later connect re-provisions cleanly. Business data, POS users and
// managed/platform keys are untouched; no Google tokens are persisted.
async function disconnectGoogle() {
  const result = googleAuth.disconnect();
  try { await revokeAiGrant(); } catch (_) { /* best effort */ }
  try {
    setSecret('gemini_api_key_cloud', '');
    setSecret('ai_gateway_grant', '');
  } catch (_) { /* best effort */ }
  summaryCache.clear();
  statusCache = null;
  return result;
}

// ---- chat ----
// One user question -> (tool calls)* -> final text answer.
// Per-user in-flight guard: a second concurrent request gets a clean 'busy'
// error (mapped to HTTP 409 by the route) instead of stacking API calls. The
// flag is released in finally, so any failure - provider, tool, audit - can
// never leave the service stuck.
const inflightChats = new Set();

async function chat({ user, question, history }) {
  if (!user || !user.id) {
    throw new AiPermissionError('Login required');
  }
  if (inflightChats.has(user.id)) {
    throw new AiBusyError();
  }
  inflightChats.add(user.id);
  try {
    return await runChat({ user, question, history });
  } finally {
    inflightChats.delete(user.id);
  }
}

async function runChat({ user, question, history: rawHistory }) {
  const q = validateQuestion(question);
  checkRateLimit(user.id);
  console.log(`[AI] request started user=${user.username} role=${user.role} model=${aiModel()}`);
  const history = sanitizeHistory(rawHistory);
  // Scan the whole conversation the client sent, not just the last turn.
  const flags = [
    ...injectionFlags(q),
    ...history.filter((m) => m.role === 'user').flatMap((m) => injectionFlags(m.content))
  ];
  const ctx = { user: userContext(user) };

  if (!aiEnabled()) {
    return { ok: true, reply: 'AI Store Manager is disabled. An admin can enable it in Settings.', tools_used: [], disabled: true };
  }

  // Identity gate: the Google sign-in authorises use of the AI credential.
  // The Gemini key itself never reaches the frontend or the chat surface.
  if (!googleConnected()) {
    return { ok: true, reply: 'AI Store Manager needs a connected Google account. An admin can sign in under Settings → AI Store Manager.', tools_used: [], needs_google: true };
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt({ store: storeContext(), user, toolNames: toolNames() }) },
    ...history,
    { role: 'user', content: q }
  ];

  const provider = getProvider();
  const toolsUsed = [];
  let reply = '';
  let success = true;
  let errorText = '';
  let auditError = '';

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      console.log(`[AI] provider request round=${round + 1}`);
      const { message } = await provider.generateResponse({
        model: aiModel(),
        messages,
        tools: toolSpecs()
      });
      console.log(`[AI] provider response received round=${round + 1}`);

      const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).slice(0, 4);
      if (!calls.length) {
        reply = typeof message.content === 'string' ? message.content.trim() : '';
        break;
      }

      // Feed every tool result back - including permission failures, so the
      // model can answer "that needs a manager login" in the user's language.
      // The assistant message contains only the calls we answer, keeping the
      // call/result pairs consistent for the API.
      messages.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: calls
      });
      for (const call of calls) {
        const name = call && call.function && call.function.name;
        const args = call && call.function && call.function.arguments;
        let result;
        try {
          console.log(`[AI] tool call=${name}`);
          result = await executeTool(name, args, ctx);
          if (result && !result.error) toolsUsed.push(name);
          console.log(`[AI] tool completed=${name}`);
        } catch (e) {
          result = e instanceof AiPermissionError
            ? { error: 'permission_denied', note: 'The current user role cannot access this data' }
            : { error: 'tool_failed', note: 'Could not retrieve this data right now' };
          console.error(`[AI ERROR] stage=tool tool=${name} code=${e.code || 'failed'}`);
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id || `call_${round}`,
          name: name || 'tool', // Gemini functionResponse needs the name
          content: JSON.stringify(result)
        });
      }
      if (round === MAX_TOOL_ROUNDS - 1) {
        reply = 'I gathered a lot of data but could not finish the answer. Please ask a more specific question.';
      }
    }
  } catch (err) {
    success = false;
    const friendly = friendlyProviderError(err);
    reply = friendly.message;
    // Audit gets the redacted upstream detail so admins can diagnose;
    // the response only ever carries the safe error code.
    errorText = friendly.code;
    auditError = err && err.message && err.message !== friendly.message
      ? `${friendly.code}: ${String(err.message).slice(0, 300)}`
      : friendly.code;
    console.error(`[AI ERROR] stage=provider status=${err && err.status || 0} code=${friendly.code} message=${err && err.message}`);
  }

  if (!reply) {
    success = false;
    reply = 'I could not produce an answer for that. Please try rephrasing the question.';
    errorText = 'empty';
  }

  // Audit logging is best-effort (logAiInteraction catches its own errors) -
  // an audit failure can never turn into an AI failure.
  logAiInteraction({
    userId: user.id,
    username: user.username,
    userRole: user.role,
    question: flags.length ? `[flagged:${flags.join(',')}] ${q}` : q,
    toolsUsed,
    action: 'chat',
    confirmationRequired: false,
    confirmationStatus: 'n/a',
    success,
    error: auditError || errorText
  });
  console.log(`[AI] request finished success=${success} tools=${toolsUsed.join(',') || 'none'}`);

  return { ok: true, reply, tools_used: toolsUsed, error: errorText || null };
}

// ---- dashboard widget ----
// Stats are computed locally (free). The AI insight line is only generated
// when a provider is configured and is cached per-user for SUMMARY_CACHE_MS
// so the dashboard never burns API quota.
const summaryCache = new Map();
const summaryInflight = new Map();

// Keep both maps bounded - they live for the process lifetime.
function mapSetCapped(map, key, value, max = 200) {
  if (map.size >= max) map.delete(map.keys().next().value);
  map.set(key, value);
}

function dashboardSummary(user, { wantInsight = true } = {}) {
  const range = namedRange('today');
  const summary = reports.generateDailyBusinessSummary({ period: 'today' });
  const base = {
    ok: true,
    date: range.from,
    sales: summary.sales,
    profit: summary.profit,
    inventory: summary.inventory,
    credit: summary.credit,
    previous_day: summary.previous_day,
    ai_enabled: aiEnabled(),
    ai_configured: aiConfigured(),
    ai_google_connected: googleConnected(),
    insight: null,
    insight_source: null
  };

  // Rule-based fallback insight - deterministic, zero API cost.
  const ruleInsight = () => {
    const parts = [];
    if (summary.previous_day && summary.previous_day.change_percent !== null) {
      const pct = summary.previous_day.change_percent;
      parts.push(`Sales are ${Math.abs(pct)}% ${pct >= 0 ? 'higher' : 'lower'} than yesterday.`);
    }
    if (summary.inventory.low_stock_products > 0) {
      parts.push(`${summary.inventory.low_stock_products} products need restocking.`);
    }
    if (summary.credit.customer_outstanding > 0) {
      parts.push(`₹${summary.credit.customer_outstanding} pending customer credit.`);
    }
    return parts.length ? parts.join(' ') : 'Store data looks normal today.';
  };

  if (!wantInsight || !aiEnabled() || !aiConfigured() || !googleConnected()) {
    base.insight = ruleInsight();
    base.insight_source = 'rules';
    return Promise.resolve(base);
  }

  const key = `${user.id}:${range.from}`;
  const cached = summaryCache.get(key);
  if (cached && Date.now() - cached.at < SUMMARY_CACHE_MS) {
    base.insight = cached.insight;
    base.insight_source = cached.source;
    return Promise.resolve(base);
  }

  // One short AI call for the insight line; on any failure fall back to the
  // rule-based line so the widget never breaks the dashboard. Concurrent
  // calls share one in-flight request so a burst can't multiply API usage.
  if (!summaryInflight.has(key)) {
    summaryInflight.set(key, generateInsight(key, base, summary, ruleInsight));
  }
  return summaryInflight.get(key);
}

async function generateInsight(key, base, summary, ruleInsight) {
  try {
    const provider = getProvider();
    const { message } = await provider.generateResponse({
      model: aiModel(),
      timeoutMs: 15000,
      messages: [
        { role: 'system', content: 'You are the Mart POS AI Store Manager. Write ONE short insight (max 2 sentences) about today\'s store numbers. Facts only, no advice, no emojis. Use ₹ for amounts.' },
        { role: 'user', content: `Today's numbers: ${JSON.stringify({ sales: summary.sales, previous_day: summary.previous_day, low_stock: summary.inventory.low_stock_products, out_of_stock: summary.inventory.out_of_stock_products, outstanding: summary.credit.customer_outstanding })}` }
      ]
    });
    const text = (message.content || '').trim().slice(0, 400);
    base.insight = text || ruleInsight();
    base.insight_source = text ? 'ai' : 'rules';
  } catch (_) {
    base.insight = ruleInsight();
    base.insight_source = 'rules';
  } finally {
    summaryInflight.delete(key);
  }
  mapSetCapped(summaryCache, key, { at: Date.now(), insight: base.insight, source: base.insight_source });
  return base;
}

// ---- admin self-test (used by GET /api/ai/selftest) ----
// Isolates each layer so "AI not working" can be diagnosed in one click:
// 1) provider connectivity with a tool-free request, 2) tool layer by
// executing get_today_sales directly against the POS data.
async function selfTest() {
  const { executeTool: exec } = require('./tools');
  const result = {
    configured: aiConfigured(),
    enabled: aiEnabled(),
    model: aiModel(),
    provider: 'gemini',
    key_set: aiConfigured(),
    credential_mode: credentialMode(),
    google: publicGoogle(),
    google_signin_available: googleAuth.signInAvailable(),
    provider_ok: null,
    provider_error: null,
    tool_ok: null,
    tool_error: null,
    today_sales_sample: null
  };

  const started = Date.now();
  try {
    const { message } = await getProvider().generateResponse({
      model: aiModel(),
      timeoutMs: 15000,
      messages: [
        { role: 'system', content: 'You are a connectivity probe. Reply with exactly: OK' },
        { role: 'user', content: 'Say OK' }
      ]
    });
    result.provider_ok = true;
    result.provider_latency_ms = Date.now() - started;
    result.provider_reply = (message.content || '').slice(0, 50);
  } catch (err) {
    result.provider_ok = false;
    const friendly = friendlyProviderError(err);
    result.provider_error = {
      code: friendly.code,
      status: err.status || 0,
      detail: String(err.message || '').slice(0, 300)
    };
  }

  try {
    const tool = await exec('get_today_sales', {}, { user: { id: -1, username: 'selftest', role: 'admin' } });
    result.tool_ok = !tool.error;
    result.today_sales_sample = tool;
    if (tool.error) result.tool_error = tool.error;
  } catch (e) {
    result.tool_ok = false;
    result.tool_error = e.message;
  }
  return result;
}

module.exports = { chat, dashboardSummary, aiStatus, aiStatusLive, configureAi, aiEnabled, aiConfigured, hasRole, AiRateLimitError, selfTest, connectGoogle, disconnectGoogle, provisionAndTest };
