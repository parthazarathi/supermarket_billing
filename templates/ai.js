// AI Store Manager - chat UI + dashboard widget.
// Follows the existing MartPOS SPA conventions: renders into the #view
// element, uses the shared api()/esc()/state helpers from script.js, and
// fails soft - an AI outage must never break billing.
(function () {
  const SUGGESTIONS = [
    "Today's sales",
    "Low stock products",
    "Top selling products",
    "Pending credit",
    "Products to reorder",
    "This week vs last week",
    "Summary of my store"
  ];

  function aiState() {
    if (!state.ai) {
      state.ai = {
        status: null,          // { enabled, configured, model }
        messages: [],          // { role, content, tools? }
        sending: false,
        loaded: false
      };
    }
    return state.ai;
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  }

  // Safe rich text: escape first, then allow **bold** and newlines only.
  function fmt(text) {
    let t = esc(text || "");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    t = t.replace(/\n/g, "<br>");
    return t;
  }

  function msgHtml(m, i) {
    if (m.role === "thinking") {
      return `<div class="ai-msg ai-assistant"><div class="ai-bubble ai-thinking"><span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span> ${esc(m.note || "Thinking...")}</div></div>`;
    }
    const who = m.role === "user" ? "ai-user" : "ai-assistant";
    const tools = (m.tools && m.tools.length)
      ? `<div class="ai-tools">Used: ${m.tools.map((t) => esc(t)).join(", ")}</div>` : "";
    const errCls = m.error ? " ai-error" : "";
    const actions = m.role === "assistant"
      ? `<div class="ai-msg-actions">
          <button class="ai-act" data-copy="${i}" title="Copy response" aria-label="Copy response">⧉ Copy</button>
          ${m.retry ? `<button class="ai-act" data-retry="${i}">↻ Retry</button>` : ""}
        </div>` : "";
    return `<div class="ai-msg ${who}${errCls}"><div class="ai-bubble">${fmt(m.content)}${tools}</div>${actions}</div>`;
  }

  function renderAI(view) {
    const ai = aiState();
    const st = ai.status;
    const unreachable = st && st.unreachable;
    const disabled = st && !unreachable && st.enabled === false;
    const unconfigured = st && !unreachable && st.enabled !== false && !st.configured;

    view.innerHTML = `
      <div class="ai-wrap">
        <div class="card ai-hero">
          <div class="ai-hero-left">
            <div class="ai-avatar" aria-hidden="true">🧠</div>
            <div>
              <h3>AI Store Manager</h3>
              <p class="muted">${greeting()}, ${esc(state.user ? state.user.username : "")} — ask anything about your store. English, தமிழ் and Tanglish all work.</p>
            </div>
          </div>
          <div class="ai-hero-right">
            ${st ? `<span class="dot ${st.enabled && st.configured ? "on" : "off"}"></span><span class="muted">${st.enabled ? (st.configured ? `Connected · ${esc(st.model)}` : "API key not set") : "Disabled"}</span>` : ""}
            <button class="btn ghost sm" id="aiClear" ${ai.messages.length ? "" : "disabled"}>Clear</button>
          </div>
        </div>

        ${unreachable ? `
          <div class="card ai-notice">
            <p><b>AI Store Manager is temporarily unavailable.</b></p>
            <p class="muted">Your POS billing and other features continue to work normally.</p>
          </div>` : ""}
        ${disabled ? `
          <div class="card ai-notice">
            <p><b>AI Store Manager is disabled.</b></p>
            <p class="muted">${can("admin") ? "Enable it and add your OpenAI API key under Settings → AI Store Manager." : "Ask an admin to enable it in Settings."}</p>
          </div>` : ""}
        ${unconfigured && !disabled ? `
          <div class="card ai-notice">
            <p><b>AI Store Manager needs an API key.</b></p>
            <p class="muted">${can("admin") ? "Add your OpenAI API key under Settings → AI Store Manager to start asking questions." : "Ask an admin to add the API key in Settings."} Your POS billing works normally without it.</p>
            ${can("admin") ? `<button class="btn sm" id="aiGoSettings">Open Settings</button>` : ""}
          </div>` : ""}

        <div class="card ai-chat" id="aiChat">
          <div class="ai-messages" id="aiMessages" aria-live="polite">
            ${ai.messages.length ? ai.messages.map(msgHtml).join("") : `
              <div class="ai-empty">
                <p class="muted">Ask things like:</p>
                <div class="ai-sugs">
                  ${SUGGESTIONS.map((s) => `<button class="chip ai-sug" data-sug="${esc(s)}">${esc(s)}</button>`).join("")}
                </div>
                <p class="muted ai-sugs-ta">உதா: "இன்று sales எவ்வளவு?" · "Innaiku sales evlo?"</p>
              </div>`}
          </div>
          <form class="ai-inputbar" id="aiForm">
            <textarea id="aiInput" rows="2" placeholder="Ask anything about your store..." aria-label="Ask the AI Store Manager"
              ${ai.sending || disabled || unconfigured || unreachable ? "disabled" : ""}></textarea>
            <button class="btn" type="submit" id="aiSend" ${ai.sending || disabled || unconfigured || unreachable ? "disabled" : ""}>Send</button>
          </form>
        </div>
      </div>`;

    const msgs = view.querySelector("#aiMessages");
    const scroll = () => { if (msgs) msgs.scrollTop = msgs.scrollHeight; };
    scroll();

    view.querySelectorAll("[data-sug]").forEach((b) => {
      b.addEventListener("click", () => send(b.dataset.sug));
    });
    view.querySelectorAll("[data-copy]").forEach((b) => {
      b.addEventListener("click", async () => {
        const m = ai.messages[parseInt(b.dataset.copy, 10)];
        try {
          await navigator.clipboard.writeText(m.content);
          b.textContent = "✓ Copied";
          setTimeout(() => { b.textContent = "⧉ Copy"; }, 1500);
        } catch (_) { /* clipboard unavailable */ }
      });
    });
    view.querySelectorAll("[data-retry]").forEach((b) => {
      b.addEventListener("click", () => {
        const m = ai.messages[parseInt(b.dataset.retry, 10)];
        if (m && m.question) send(m.question);
      });
    });

    view.querySelector("#aiClear").addEventListener("click", () => {
      ai.messages = [];
      renderView();
    });
    const goSettings = view.querySelector("#aiGoSettings");
    if (goSettings) goSettings.addEventListener("click", () => switchView("settings"));

    const form = view.querySelector("#aiForm");
    const input = view.querySelector("#aiInput");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      send(input.value);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send(input.value);
      }
    });
    if (!ai.sending && !disabled && !unconfigured && !unreachable) input.focus();
  }

  async function send(text) {
    const ai = aiState();
    const q = String(text || "").trim();
    if (!q || ai.sending) return;
    ai.sending = true;
    ai.messages.push({ role: "user", content: q });
    ai.messages.push({ role: "thinking", note: "Checking your store data..." });
    renderView();

    // History sent to the server: user/assistant text turns only, capped.
    const history = ai.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const res = await api("/api/ai/chat", {
        method: "POST",
        body: { message: q, history }
      });
      ai.messages = ai.messages.filter((m) => m.role !== "thinking");
      ai.messages.push({
        role: "assistant",
        content: res.reply || "No answer produced.",
        tools: res.tools_used || [],
        error: !!res.error
      });
    } catch (err) {
      ai.messages = ai.messages.filter((m) => m.role !== "thinking");
      const offline = /failed to fetch|networkerror|network request/i.test(String(err && err.message || err));
      ai.messages.push({
        role: "assistant",
        content: offline
          ? "AI Store Manager requires an internet connection. Your POS is still working normally."
          : (err.message || "Something went wrong. Please try again."),
        error: true,
        retry: true,
        question: q
      });
    }
    ai.sending = false;
    renderView();
  }

  // ---- status + data loading ----
  async function loadAI() {
    const ai = aiState();
    try {
      const res = await api("/api/ai/status");
      ai.status = res.ai;
    } catch (_) {
      ai.status = { enabled: false, configured: false, unreachable: true };
    }
    ai.loaded = true;
    if (state.view === "ai") renderView();
  }

  // ---- dashboard widget ----
  function aiWidgetCardHtml() {
    return `<div class="card ai-widget" id="aiWidget">
      <div class="dash-card-head"><h3>🧠 AI Store Manager</h3><button class="btn ghost sm" data-qa="ai">Ask AI</button></div>
      <div class="ai-widget-body"><p class="muted">Loading today's overview...</p></div>
    </div>`;
  }

  async function loadAiWidget() {
    const box = document.getElementById("aiWidget");
    if (!box) return;
    const body = box.querySelector(".ai-widget-body");
    try {
      const s = await api("/api/ai/summary");
      if (!document.getElementById("aiWidget")) return; // navigated away
      body.innerHTML = `
        <div class="ai-widget-grid">
          <div class="ai-wstat"><span class="label">Sales</span><span class="value">₹ ${money(s.sales.total)}</span></div>
          <div class="ai-wstat"><span class="label">Bills</span><span class="value">${esc(String(s.sales.bills))}</span></div>
          <div class="ai-wstat"><span class="label">Low stock</span><span class="value">${esc(String(s.inventory.low_stock_products))}</span></div>
          <div class="ai-wstat"><span class="label">Credit due</span><span class="value">₹ ${money(s.credit.customer_outstanding)}</span></div>
        </div>
        <div class="ai-insight"><span class="ai-insight-tag">AI Insight</span><p>${esc(s.insight || "")}</p></div>`;
    } catch (_) {
      body.innerHTML = `<p class="muted">AI overview unavailable right now - POS is working normally.</p>`;
    }
  }

  // ---- settings card (admin) ----
  function aiSettingsCardHtml() {
    const st = (state.ai && state.ai.status) || {};
    return `
      <div class="card" id="aiCard">
        <h3>🧠 AI Store Manager</h3>
        <p><span class="dot ${st.enabled && st.configured ? "on" : "off"}"></span>
          ${st.enabled ? (st.configured ? `Connected · ${esc(st.model || "")}` : "Enabled - API key not set") : "Disabled"}</p>
        <p class="help">Lets staff ask business questions in English, Tamil or Tanglish. Read-only - it can look up sales, stock, credit and expenses but cannot change any data. Requires an OpenAI API key and internet.</p>
        <p class="help">Note: questions and the business figures needed to answer them (sales totals, stock counts, customer names and balances) are sent to OpenAI for processing. Phone numbers, emails and addresses are never sent.</p>
        <form id="aiCfgForm" class="form-grid">
          <label class="full">OpenAI API key
            <input name="api_key" type="password" autocomplete="off" placeholder="${st.configured ? "Key saved - enter new to replace" : "sk-..."}" />
          </label>
          <label>Model
            <input name="model" placeholder="gpt-4o-mini" value="${esc(st.model || "gpt-4o-mini")}" />
          </label>
          <label class="check"><input type="checkbox" name="enabled" ${st.enabled !== false ? "checked" : ""} /> Enable AI Store Manager</label>
          <div class="full toolbar">
            <button class="btn" type="submit">Save AI settings</button>
            ${st.configured ? `<button class="btn ghost" type="button" id="aiKeyClear">Remove key</button>` : ""}
          </div>
        </form>
        <div id="aiCfgMsg" class="help"></div>
      </div>`;
  }

  function bindAiSettingsCard() {
    const form = document.getElementById("aiCfgForm");
    if (!form) return;
    const msg = document.getElementById("aiCfgMsg");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = {
        model: fd.get("model"),
        enabled: !!form.querySelector('[name="enabled"]').checked
      };
      const key = String(fd.get("api_key") || "").trim();
      if (key) body.api_key = key;
      try {
        const res = await api("/api/ai/config", { method: "POST", body });
        if (state.ai) state.ai.status = res.ai;
        msg.textContent = "AI settings saved.";
        renderView();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
    const clearBtn = document.getElementById("aiKeyClear");
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        if (!confirm("Remove the saved OpenAI API key? AI Store Manager will stop working.")) return;
        try {
          const res = await api("/api/ai/config", { method: "POST", body: { api_key: "" } });
          if (state.ai) state.ai.status = res.ai;
          renderView();
        } catch (err) {
          msg.textContent = err.message;
        }
      });
    }
  }

  window.MartAI = {
    renderAI,
    loadAI,
    aiWidgetCardHtml,
    loadAiWidget,
    aiSettingsCardHtml,
    bindAiSettingsCard
  };
})();
