// AI Store Manager service: chat orchestration + dashboard summary.
// Sits on top of the existing POS business layer - tools call lib/reporting
// and lib/* modules; this file never touches the database directly.
const { getProvider, aiConfigured, AIProviderError, DEFAULT_MODEL } = require('./provider');
const { buildSystemPrompt } = require('./prompt');
const { toolSpecs, toolNames, executeTool, AiPermissionError } = require('./tools');
const {
  validateQuestion, sanitizeHistory, injectionFlags,
  checkRateLimit, hasRole, AiRateLimitError
} = require('./security');
const { storeContext, userContext, namedRange } = require('./context');
const { logAiInteraction } = require('./audit');
const { getSetting, setSettings } = require('../settings');
const { setSecret } = require('../secrets');
const reports = require('./tools/reports');

const MAX_TOOL_ROUNDS = 5;
const SUMMARY_CACHE_MS = 15 * 60 * 1000; // 15 min - caps API calls from the dashboard

// ---- configuration ----
// Model + enable flag live in settings (non-secret); the key lives in the
// encrypted secrets store only.
function aiModel() {
  return String(getSetting('ai_model', '') || process.env.MARTPOS_AI_MODEL || '').trim() || DEFAULT_MODEL;
}

function aiEnabled() {
  return getSetting('ai_enabled', '1') !== '0';
}

function aiStatus() {
  return {
    enabled: aiEnabled(),
    configured: aiConfigured(),
    provider: 'openai',
    model: aiModel(),
    key_set: aiConfigured()
  };
}

// Admin-only config change. The key is write-only: never echoed back.
function configureAi({ apiKey, model, enabled }) {
  if (apiKey !== undefined) {
    const v = String(apiKey || '').trim();
    if (v && (v.length < 20 || v.length > 200 || /\s/.test(v))) {
      throw new Error('That does not look like a valid API key');
    }
    setSecret('openai_api_key', v); // '' clears
  }
  const updates = {};
  if (model !== undefined) {
    const m = String(model || '').trim();
    if (m && !/^[a-zA-Z0-9._-]{1,64}$/.test(m)) {
      throw new Error('Invalid model name');
    }
    updates.ai_model = m;
  }
  if (enabled !== undefined) {
    updates.ai_enabled = enabled ? '1' : '0';
  }
  if (Object.keys(updates).length) setSettings(updates);
  summaryCache.clear();
  return aiStatus();
}

// ---- friendly errors (never raw SQL/stack/provider text to the user) ----
function friendlyProviderError(err) {
  if (err instanceof AIProviderError) {
    switch (err.code) {
    case 'not_configured':
      return { code: 'not_configured', message: 'AI Store Manager is not configured yet. An admin can add the API key in Settings.' };
    case 'offline':
      return { code: 'offline', message: 'AI Store Manager needs an internet connection. Your POS is still working normally.' };
    case 'timeout':
      return { code: 'offline', message: 'The AI service took too long to respond. Please try again.' };
    case 'auth':
      return { code: 'not_configured', message: 'The AI API key was rejected. An admin should update it in Settings.' };
    case 'rate_limited':
      return { code: 'rate_limited', message: 'The AI service is busy right now. Please try again in a moment.' };
    default:
      return { code: 'unavailable', message: 'AI Store Manager is temporarily unavailable. Your POS billing and other features continue to work normally.' };
    }
  }
  return { code: 'unavailable', message: 'AI Store Manager is temporarily unavailable. Your POS billing and other features continue to work normally.' };
}

// ---- chat ----
// One user question -> (tool calls)* -> final text answer.
async function chat({ user, question, history: rawHistory }) {
  const q = validateQuestion(question);
  checkRateLimit(user.id);
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

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const { message } = await provider.generateResponse({
        model: aiModel(),
        messages,
        tools: toolSpecs()
      });

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
          result = await executeTool(name, args, ctx);
          if (result && !result.error) toolsUsed.push(name);
        } catch (e) {
          result = e instanceof AiPermissionError
            ? { error: 'permission_denied', note: 'The current user role cannot access this data' }
            : { error: 'tool_failed', note: 'Could not retrieve this data right now' };
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id || `call_${round}`,
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
    errorText = friendly.code;
  }

  if (!reply) {
    success = false;
    reply = 'I could not produce an answer for that. Please try rephrasing the question.';
    errorText = 'empty';
  }

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
    error: errorText
  });

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

  if (!wantInsight || !aiEnabled() || !aiConfigured()) {
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

module.exports = { chat, dashboardSummary, aiStatus, configureAi, aiEnabled, aiConfigured, hasRole, AiRateLimitError };
