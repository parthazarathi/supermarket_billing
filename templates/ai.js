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

  // Summarise status for badges/notices. The Google account is the customer
  // identity gate; the Gemini credential itself is backend-only.
  function statusInfo(st) {
    const google = (st && st.google) || {};
    const needsGoogle = !!st && st.enabled !== false && !google.connected;
    const offline = !!st && st.enabled !== false && google.connected && st.configured && st.reachable === false;
    const modelMissing = !!st && st.reachable === true && st.model_available === false;
    const unconfigured = !!st && st.enabled !== false && google.connected && !st.configured;
    const online = !!st && st.enabled !== false && google.connected && st.configured && !offline && !modelMissing;
    let label = "Disabled";
    if (st && st.enabled !== false) {
      label = needsGoogle ? "Not connected"
        : !st.configured ? "AI credential missing"
          : modelMissing ? `Model unavailable - ${st.model}`
            : offline ? "AI unavailable - offline"
              : `Connected${google.email ? ` · ${google.email}` : ""}`;
    }
    return { needsGoogle, offline, modelMissing, unconfigured, online, label };
  }

  function renderAI(view) {
    const ai = aiState();
    const st = ai.status;
    const info = statusInfo(st);
    const unreachable = st && st.unreachable;
    const disabled = st && !unreachable && st.enabled === false;
    const unconfigured = !unreachable && !disabled && info.unconfigured;
    const needsGoogle = !unreachable && !disabled && info.needsGoogle;
    const blocked = disabled || unconfigured || needsGoogle || unreachable || info.offline || info.modelMissing;

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
            ${st ? `<span class="dot ${info.online ? "on" : "off"}"></span><span class="muted">${esc(info.label)}</span>` : ""}
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
            <p class="muted">${can("admin") ? "Enable it under Settings → AI Store Manager." : "Ask an admin to enable it in Settings."}</p>
          </div>` : ""}
        ${needsGoogle ? `
          <div class="card ai-notice">
            <p><b>AI Store Manager is not connected.</b></p>
            <p class="muted">${can("admin") ? "Sign in with your Google account under Settings → AI Store Manager." : "Ask an admin to connect a Google account in Settings."} Your POS billing works normally without it.</p>
            ${can("admin") ? `<button class="btn sm" id="aiGoSettings">Open Settings</button>` : ""}
          </div>` : ""}
        ${unconfigured ? `
          <div class="card ai-notice">
            <p><b>AI credential is not provisioned.</b></p>
            <p class="muted">This installation has no Gemini credential configured on the backend. Contact your POS provider/administrator. Billing keeps working normally.</p>
          </div>` : ""}
        ${info.offline && !disabled ? `
          <div class="card ai-notice">
            <p><b>AI Assistant unavailable - no internet connection.</b></p>
            <p class="muted">AI answers come from Google Gemini, which needs internet. Billing, inventory and printing keep working normally offline.</p>
          </div>` : ""}
        ${info.modelMissing && !disabled ? `
          <div class="card ai-notice">
            <p><b>The configured AI model is not available.</b></p>
            <p class="muted">${can("admin") ? "Change the model name under Settings → AI Store Manager." : "Ask an admin to check the AI model in Settings."}</p>
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
              ${ai.sending || blocked ? "disabled" : ""}></textarea>
            <button class="btn" type="submit" id="aiSend" ${ai.sending || blocked ? "disabled" : ""}>Send</button>
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
    if (!ai.sending && !blocked) input.focus();
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
    const first = !ai.loaded;
    try {
      const res = await api("/api/ai/status");
      ai.status = res.ai;
    } catch (_) {
      ai.status = { enabled: false, configured: false, unreachable: true };
    }
    ai.loaded = true;
    if (state.view === "ai") renderView();
    // First load refreshes the settings card once so its status line is real;
    // guarded so the render -> loadAI cycle cannot loop.
    else if (first && state.view === "settings") renderView();
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
  // No API-key field anywhere: the customer authenticates with Google, and
  // the Gemini credential lives only on the backend.
  function aiSettingsCardHtml() {
    const st = (state.ai && state.ai.status) || {};
    const info = statusInfo(st.provider ? st : null);
    const g = st.google || {};
    return `
      <div class="card" id="aiCard">
        <h3>🧠 AI Store Manager</h3>
        <p><span class="dot ${st.provider ? (info.online ? "on" : "off") : "off"}"></span>
          ${st.provider ? esc(info.label) : "Checking status..."}</p>
        <p class="help">Lets staff ask business questions in English, Tamil or Tanglish. Read-only - it can look up sales, stock, credit and expenses but cannot change any data. Powered by Google Gemini.</p>

        ${g.connected ? `
          <div class="ai-google-box">
            <p><b>Google account:</b> ${esc(g.name ? `${g.name} (${g.email})` : g.email)}</p>
            <p class="muted">AI model: ${esc(st.model || "")}${st.credential_mode === "platform" ? " · platform-managed credential" : st.credential_mode === "managed" ? " · managed credential" : ""}</p>
            ${!st.configured ? `<p class="help"><b>AI credential missing.</b> This installation has no Gemini credential on the backend - ask your POS provider to configure it (GEMINI_API_KEY).</p>` : ""}
          </div>` : `
          <p class="help">Connect a Google account to enable AI Store Manager. No API key is shown or entered here.</p>
          ${!st.google_signin_available ? `<p class="help"><b>Google sign-in is not set up on this installation.</b> Place a Google "Desktop app" credentials.json in the data folder (the same file Google Drive backup uses), or ask your provider to configure it.</p>` : ""}`}

        <form id="aiCfgForm" class="form-grid">
          <label>AI model
            <input name="model" placeholder="gemini-2.5-flash" value="${esc(st.model || "gemini-2.5-flash")}" />
          </label>
          <label class="check"><input type="checkbox" name="enabled" ${st.enabled !== false ? "checked" : ""} /> Enable AI Store Manager</label>
          <div class="full toolbar">
            ${g.connected
              ? `<button class="btn ghost" type="button" id="aiGoogleDisconnect">Disconnect Google Account</button>`
              : `<button class="btn" type="button" id="aiGoogleConnect" ${st.google_signin_available ? "" : "disabled"}>Sign in with Google</button>`}
            <button class="btn ghost" type="submit">Save AI settings</button>
            <button class="btn ghost" type="button" id="aiTestBtn">Test AI</button>
          </div>
        </form>
        <div id="aiCfgMsg" class="help"></div>
        <div id="aiTestMsg" class="help"></div>
      </div>`;
  }

  function bindAiSettingsCard() {
    const form = document.getElementById("aiCfgForm");
    if (!form) return;
    const msg = document.getElementById("aiCfgMsg");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        const res = await api("/api/ai/config", {
          method: "POST",
          body: {
            model: fd.get("model"),
            enabled: !!form.querySelector('[name="enabled"]').checked
          }
        });
        if (state.ai) state.ai.status = res.ai;
        msg.textContent = "AI settings saved.";
        renderView();
      } catch (err) {
        msg.textContent = err.message;
      }
    });

    // Google sign-in: the backend opens the system browser and this request
    // resolves when the flow finishes (or is cancelled/times out).
    const connectBtn = document.getElementById("aiGoogleConnect");
    if (connectBtn) {
      connectBtn.addEventListener("click", async () => {
        connectBtn.disabled = true;
        msg.textContent = "Finish signing in in the browser window that just opened...";
        try {
          const res = await api("/api/ai/google/connect", { method: "POST" });
          msg.textContent = "";
          await window.MartAI.loadAI();
          renderView();
        } catch (err) {
          msg.textContent = err.message || "Google sign-in failed.";
          connectBtn.disabled = false;
        }
      });
    }

    const disconnectBtn = document.getElementById("aiGoogleDisconnect");
    if (disconnectBtn) {
      disconnectBtn.addEventListener("click", async () => {
        if (!(await confirmDialog({
          title: "Disconnect the Google account?",
          message: "AI Store Manager will stop working until a Google account is connected again. Shop data and settings are not affected.",
          confirmLabel: "Disconnect"
        }))) return;
        try {
          await api("/api/ai/google/disconnect", { method: "POST" });
          await window.MartAI.loadAI();
          renderView();
        } catch (err) {
          msg.textContent = err.message;
        }
      });
    }

    // Diagnostic: provider connectivity + tool layer, reported inline.
    const testBtn = document.getElementById("aiTestBtn");
    const testMsg = document.getElementById("aiTestMsg");
    if (testBtn) {
      testBtn.addEventListener("click", async () => {
        testBtn.disabled = true;
        testMsg.textContent = "Testing...";
        try {
          const res = await api("/api/ai/selftest");
          const s = res.selftest || {};
          const lines = [];
          lines.push((s.google && s.google.connected) ? `Google: ${s.google.email}` : "Google: not connected");
          lines.push(s.provider_ok
            ? `Gemini reply OK (${s.provider_latency_ms || "?"} ms)`
            : `Gemini reply failed: ${(s.provider_error && s.provider_error.detail) || (s.provider_error && s.provider_error.code) || "unknown"}`);
          lines.push(s.tool_ok ? "Data tools OK" : `Data tools failed: ${s.tool_error || "unknown"}`);
          testMsg.textContent = lines.join(" · ");
        } catch (err) {
          testMsg.textContent = err.message || "Self-test failed";
        }
        testBtn.disabled = false;
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
