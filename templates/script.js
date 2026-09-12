const appEl = document.getElementById("app");
const modalEl = document.getElementById("modal");

const state = {
  user: null,
  settings: {},
  view: "pos",
  status: "",
  statusType: "",
  cart: emptyCart(),
  items: [],
  categories: [],
  category: "",
  parties: [],
  invoices: [],
  purchases: [],
  expenses: [],
  report: null,
  dashboard: null,
  users: [],
  drive: {},
  payment: "Cash",
  paid: "",
  phone: "",
  customerName: "",
  customerPhone: "",
  sendWhatsapp: false,
  held: [],
  sidebarCollapsed: localStorage.getItem("sidebarCollapsed") === "true",
  partyFilter: "customer",
};

const defaultPosId = (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
state.posId = localStorage.getItem("posId") || defaultPosId;
state.tabs = JSON.parse(localStorage.getItem("posTabs") || "null") || [{ posId: state.posId, label: "Bill 1" }];
localStorage.setItem("posId", state.posId);
localStorage.setItem("posTabs", JSON.stringify(state.tabs));

function emptyCart() {
  return {
    items: [],
    subtotal: 0,
    discount: 0,
    tax: 0,
    cgst: 0,
    sgst: 0,
    igst: 0,
    total: 0,
    party_id: null,
    party_name: "",
    party_phone: "",
  };
}

function money(n) {
  return Number(n || 0).toFixed(2);
}

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function can(minRole) {
  const order = { cashier: 1, manager: 2, admin: 3 };
  return (order[state.user?.role] || 0) >= order[minRole];
}

function setStatus(msg, type = "") {
  state.status = msg || "";
  state.statusType = type;
  const el = document.querySelector(".status");
  if (el) {
    el.textContent = state.status;
    el.className = `status ${type}`;
  }
}

async function api(url, options = {}) {
  const posId = state.posId;
  const method = options.method || "GET";
  if (posId && method.toUpperCase() === "GET" && !url.includes("pos_id=")) {
    const sep = url.includes("?") ? "&" : "?";
    url = `${url}${sep}pos_id=${encodeURIComponent(posId)}`;
  }
  const body =
    options.body && typeof options.body === "object" && posId
      ? { ...options.body, pos_id: posId }
      : options.body;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
    body: body && typeof body !== "string" ? JSON.stringify(body) : body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function navItems() {
  const items = [
    ["dashboard", "Dashboard"],
    ["pos", "POS Billing"],
    ["items", "Items"],
    ["parties", "Parties"],
    ["sales", "Sales"],
  ];
  if (can("manager")) {
    items.push(["purchases", "Purchases"], ["expenses", "Expenses"], ["reports", "Reports"]);
  }
  if (can("admin")) items.push(["settings", "Settings"]);
  return items;
}

function render() {
  if (!state.user) {
    appEl.innerHTML = `
      <div class="login-wrap">
        <form class="login-card" id="loginForm" aria-labelledby="loginTitle">
          <h1 id="loginTitle">Mart POS</h1>
          <p>Sign in to start billing. Default: admin / admin</p>
          <label for="username">Username</label>
          <input name="username" id="username" value="admin" autocomplete="username" required aria-required="true" />
          <label for="password">Password</label>
          <input name="password" id="password" type="password" value="admin" autocomplete="current-password" required aria-required="true" />
          <div class="status ${state.statusType}" style="margin:12px 0" role="alert" aria-live="polite">${esc(state.status)}</div>
          <button class="btn wide" type="submit">Sign in</button>
        </form>
      </div>`;
    document.getElementById("loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const data = await api("/api/login", {
          method: "POST",
          body: { username: fd.get("username"), password: fd.get("password") },
        });
        state.user = data.user;
        state.settings = data.settings || {};
        state.view = "pos";
        await bootApp();
      } catch (err) {
        state.status = err.message;
        state.statusType = "error";
        render();
      }
    });
    
    // Focus on username field when login page loads
    document.getElementById("username").focus();
    return;
  }

  const shop = state.settings.shop_name || "Mart POS";
  appEl.innerHTML = `
    <div class="shell ${state.sidebarCollapsed ? 'sidebar-collapsed' : ''}">
      <aside class="sidebar" role="navigation" aria-label="Main navigation">
        <div class="brand">
          <h1>${esc(shop)}</h1>
          <small>Billing & inventory</small>
          <button class="sidebar-toggle" id="sidebarToggle" aria-label="${state.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}">${state.sidebarCollapsed ? '→' : '←'}</button>
        </div>
        <nav role="menu">
        ${navItems()
          .map(
            ([id, label]) =>
              `<button class="nav-btn ${state.view === id ? "active" : ""}" data-view="${id}" role="menuitem" aria-current="${state.view === id ? 'page' : 'false'}">${label}</button>`
          )
          .join("")}
        </nav>
        <div class="spacer"></div>
        <div class="user-box">
          <strong>${esc(state.user.username)}</strong>
          <span>${esc(state.user.role)}</span>
          <button class="btn ghost sm" id="logoutBtn" style="margin-top:8px;width:100%" aria-label="Logout">Logout</button>
        </div>
      </aside>
      <section class="main" role="main">
        <header class="topbar">
          ${
            state.view === "pos"
              ? `
              <div class="pos-tabs" role="tablist" aria-label="POS bills">
                ${state.tabs
                  .map(
                    (tab, idx) => `
                    <button class="pos-tab ${tab.posId === state.posId ? "active" : ""}" data-pos="${esc(tab.posId)}" role="tab" aria-selected="${tab.posId === state.posId ? "true" : "false"}">
                      <span class="tab-label">${esc(tab.label)}</span>
                      ${state.tabs.length > 1 ? `<span class="tab-close" data-close="${esc(tab.posId)}" aria-label="Close ${esc(tab.label)}">×</span>` : ""}
                    </button>`
                  )
                  .join("")}
                <button class="pos-tab new-tab" id="newPosTab" aria-label="New bill tab">+</button>
              </div>`
              : `
              <div>
                <h2>${navItems().find((n) => n[0] === state.view)?.[1] || ""}</h2>
              </div>`
          }
          <div class="status ${state.statusType}" role="status" aria-live="polite">${esc(state.status)}</div>
        </header>
        <div class="content" id="view" role="region" aria-live="polite"></div>
      </section>
    </div>`;

  appEl.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST", body: {} });
    state.user = null;
    render();
  });
  document.getElementById("sidebarToggle").addEventListener("click", () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    localStorage.setItem("sidebarCollapsed", state.sidebarCollapsed ? "true" : "false");
    render();
  });
  if (state.view === "pos") {
    appEl.querySelectorAll("[data-pos]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        if (e.target.closest(".tab-close")) return;
        const posId = btn.dataset.pos;
        if (posId === state.posId) return;
        state.posId = posId;
        localStorage.setItem("posId", state.posId);
        await loadPosCart();
        // Update active tab highlight without full shell re-render
        appEl.querySelectorAll(".pos-tab").forEach((tab) => {
          const isActive = tab.dataset.pos === state.posId;
          tab.classList.toggle("active", isActive);
          tab.setAttribute("aria-selected", isActive ? "true" : "false");
        });
      });
    });
    appEl.querySelectorAll("[data-close]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const closeId = btn.dataset.close;
        const idx = state.tabs.findIndex((t) => t.posId === closeId);
        if (idx === -1) return;
        const closing = state.tabs[idx];
        if (closing && closing.label.startsWith("BILL-")) {
          await api("/api/release-bill-no", { method: "POST", body: { bill_no: closing.label } });
        }
        state.tabs.splice(idx, 1);
        if (state.posId === closeId) {
          const nextTab = state.tabs[Math.min(idx, state.tabs.length - 1)];
          state.posId = nextTab ? nextTab.posId : state.tabs[0]?.posId;
        }
        localStorage.setItem("posTabs", JSON.stringify(state.tabs));
        localStorage.setItem("posId", state.posId);
        if (state.tabs.length === 0) {
          addPosTab();
        } else {
          render();
          await loadPosCart();
        }
      });
    });
    document.getElementById("newPosTab").addEventListener("click", () => addPosTab());
  }
  renderView();
}

async function switchView(view) {
  state.view = view;
  render();
  try {
    if (view === "dashboard") await loadDashboard();
    if (view === "pos") await loadPos();
    if (view === "items") await loadItems();
    if (view === "parties") await loadParties();
    if (view === "sales") await loadSales();
    if (view === "purchases") await loadPurchases();
    if (view === "new-purchase") {
      // local state, no server load needed
    }
    if (view === "expenses") await loadExpenses();
    if (view === "reports") await loadReports();
    if (view === "settings") await loadSettings();
  } catch (err) {
    setStatus(err.message, "error");
  }
}

function renderView() {
  const view = document.getElementById("view");
  if (!view) return;
  if (state.focusInterval) {
    clearInterval(state.focusInterval);
    state.focusInterval = null;
  }
  const map = {
    dashboard: renderDashboard,
    pos: renderPos,
    items: renderItems,
    parties: renderParties,
    sales: renderSales,
    purchases: renderPurchases,
    'new-purchase': renderNewPurchase,
    expenses: renderExpenses,
    reports: renderReports,
    settings: renderSettings,
  };
  (map[state.view] || renderPos)(view);
}

function renderDashboard(view) {
  const d = state.dashboard || {
    today_sales: 0,
    today_invoices: 0,
    unpaid_dues: 0,
    today_expenses: 0,
    low_stock: [],
    recent_invoices: [],
  };
  view.innerHTML = `
    <div class="cards">
      <div class="card green"><div class="label">Today's sales</div><div class="value">₹ ${money(d.today_sales)}</div></div>
      <div class="card blue"><div class="label">Bills today</div><div class="value">${d.today_invoices}</div></div>
      <div class="card"><div class="label">Unpaid dues</div><div class="value">₹ ${money(d.unpaid_dues)}</div></div>
      <div class="card"><div class="label">Today's expenses</div><div class="value">₹ ${money(d.today_expenses)}</div></div>
    </div>
    <div class="pos" style="margin-top:16px">
      <div class="card">
        <h3>Low stock</h3>
        <div class="table-wrap">
          <table><thead><tr><th>Item</th><th>Stock</th></tr></thead>
          <tbody>${
            (d.low_stock || [])
              .map((i) => `<tr><td>${esc(i.name)}</td><td class="low">${money(i.stock)} ${esc(i.unit)}</td></tr>`)
              .join("") || `<tr><td colspan="2">All items look healthy</td></tr>`
          }</tbody></table>
        </div>
      </div>
      <div class="card">
        <h3>Recent bills</h3>
        <div class="table-wrap">
          <table><thead><tr><th>No</th><th>Total</th><th>Status</th></tr></thead>
          <tbody>${
            (d.recent_invoices || [])
              .map(
                (i) =>
                  `<tr><td>${esc(i.invoice_no)}</td><td>₹ ${money(i.total)}</td><td>${esc(i.status)}</td></tr>`
              )
              .join("") || `<tr><td colspan="3">No sales yet</td></tr>`
          }</tbody></table>
        </div>
      </div>
    </div>`;
}

function renderPos(view) {
  const c = state.cart;
  const billProfit = c.items.reduce((sum, item) => sum + ((item.price - (item.purchase_price || 0)) * item.quantity - item.discount), 0);
  const profitPercent = c.subtotal ? (billProfit / (c.subtotal - c.discount) * 100) : 0;
  view.innerHTML = `
    <div class="pos-compact" role="main" aria-label="Point of Sale Billing">
      <div class="pos-layout">
        <div class="pos-left">
          <div class="pos-topbar">
            <div class="search-section">
              <div class="search-row">
                <div class="search-input-wrap">
                  <input id="productSearch" placeholder="Scan barcode or type product name" autofocus aria-label="Product search" autocomplete="off" aria-autocomplete="list" aria-controls="searchSuggestions" />
                  <div id="searchSuggestions" class="search-suggestions" role="listbox" aria-label="Search suggestions"></div>
                </div>
                <button class="btn" id="addBtn" aria-label="Add product from search">Add</button>
                <button class="btn ghost" id="scanBtn" aria-label="Open barcode scanner">Camera</button>
              </div>
            </div>
          </div>
          
          <div class="items-table-section">
            <div class="section-header">
              <h3>Order Items</h3>
              <span class="item-count">${c.items.length} items</span>
            </div>
            
            <div class="items-table-container">
              <table class="items-table" role="table" aria-label="Order items table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Purchase Price</th>
                    <th>MRP</th>
                    <th>Sale Price</th>
                    <th>Qty</th>
                    <th>Discount</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  ${
                    c.items
                      .map(
                        (item) => `
                    <tr role="row">
                      <td><strong>${esc(item.name)}</strong></td>
                      <td>₹ ${money(item.purchase_price || 0)}</td>
                      <td>₹ ${money(item.mrp || item.price)}</td>
                      <td>₹ ${money(item.price)}</td>
                      <td>
                        <div class="qty-control-inline">
                          <button class="qty-btn sm minus" data-qty-minus="${esc(item.code)}">−</button>
                          <input type="number" min="0.01" step="0.01" value="${item.quantity}" data-qty="${esc(item.code)}" aria-label="Quantity for ${esc(item.name)}" class="qty-input sm" />
                          <button class="qty-btn sm plus" data-qty-plus="${esc(item.code)}">+</button>
                        </div>
                      </td>
                      <td><input type="number" min="0" step="0.01" value="${item.discount}" data-discount="${esc(item.code)}" aria-label="Discount for ${esc(item.name)}" class="discount-input sm" /></td>
                      <td>₹ ${money(item.line_total)}</td>
                    </tr>`
                      )
                      .join("") || `<tr><td colspan="7" class="empty-cart">Scan or search products to add them to the order</td></tr>`
                  }
                </tbody>
              </table>
            </div>
            
            <div class="bill-profit-note">
              <span>Bill Profit</span>
              <strong>₹ ${money(billProfit)} (${c.subtotal ? money(profitPercent) : '0.00'}%)</strong>
            </div>
          </div>
        </div>
        
        <div class="pos-right">
          <div class="customer-summary-section">
            <div class="customer-field">
              <label for="customerName">Customer Name</label>
              <input id="customerName" type="text" placeholder="Walk-in customer" value="${esc(state.customerName || '')}" aria-label="Customer name" autocomplete="off" />
              <div class="customer-suggestions" id="nameSuggestions"></div>
            </div>
            <div class="customer-field">
              <label for="customerPhone">Mobile Number</label>
              <input id="customerPhone" type="tel" placeholder="+91..." value="${esc(state.customerPhone || '')}" aria-label="Customer mobile number" autocomplete="off" />
              <div class="customer-suggestions" id="phoneSuggestions"></div>
            </div>
            <label class="whatsapp-check-label">
              <input type="checkbox" id="waCheck" ${state.sendWhatsapp ? "checked" : ""} />
              Send bill on WhatsApp
            </label>
          </div>
          
          <div class="order-summary">
            <div class="summary-header">
              <h3>Order Summary</h3>
            </div>
            
            <div class="cart-totals">
              <div class="total-row">
                <span>Subtotal</span>
                <span>₹ ${money(c.subtotal)}</span>
              </div>
              <div class="total-row discount-row">
                <span>Discount</span>
                <span><input id="billDiscount" type="number" min="0" step="0.01" value="${money(c.discount)}" class="discount-input" aria-label="Bill discount amount" /></span>
              </div>
              <div class="total-row">
                <span>CGST</span>
                <span>₹ ${money(c.cgst)}</span>
              </div>
              <div class="total-row">
                <span>SGST</span>
                <span>₹ ${money(c.sgst)}</span>
              </div>
              ${c.igst ? `<div class="total-row"><span>IGST</span><span>₹ ${money(c.igst)}</span></div>` : ""}
              <div class="total-row grand-total">
                <span>Grand Total</span>
                <span>₹ ${money(c.total)}</span>
              </div>
            </div>
            
            <div class="payment-section">
              <div class="payment-methods" role="group" aria-label="Payment methods">
                ${["Cash", "UPI", "Card"]
                  .map(
                    (m) =>
                      `<button class="payment-method ${state.payment === m ? "active" : ""}" data-pay="${m}" aria-pressed="${state.payment === m}">${m}</button>`
                  )
                  .join("")}
              </div>
              
              <div class="payment-details">
                <div class="payment-row">
                  <label for="paidInput">Amount Received</label>
                  <input id="paidInput" type="number" min="0" step="0.01" value="${state.paid || money(c.total)}" aria-label="Amount received from customer" />
                </div>
                <div class="payment-row">
                  <label>Change to Return</label>
                  <span class="change-amount">₹ ${money(Math.max(0, (parseFloat(state.paid) || c.total) - c.total))}</span>
                </div>
              </div>
              
              ${
                state.payment === "UPI" && c.total
                  ? `<div class="qr-section">
                      <img class="qr" alt="UPI QR code for payment" src="/upi_qr?am=${encodeURIComponent(money(c.total))}&tn=Mart%20POS" />
                    </div>`
                  : ""
              }
              
              <div class="payment-actions">
                <button class="btn wide green" id="payBtn" aria-label="Pay bill ₹${money(c.total)}">Pay ₹ ${money(c.total)}</button>
                <button class="btn wide" id="printBtn" aria-label="Print bill ₹${money(c.total)}">Print & Pay ₹ ${money(c.total)}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const search = document.getElementById("productSearch");
  const suggestionsEl = document.getElementById("searchSuggestions");
  let selectedIndex = -1;
  let matches = [];

  const showSuggestions = (q) => {
    q = q.trim();
    if (!q) {
      suggestionsEl.innerHTML = "";
      suggestionsEl.classList.remove("open");
      return;
    }
    matches = state.items
      .filter((i) =>
        i.name.toLowerCase().includes(q.toLowerCase()) ||
        i.code.toLowerCase().includes(q.toLowerCase())
      )
      .slice(0, 8);
    selectedIndex = -1;
    if (matches.length === 0) {
      suggestionsEl.innerHTML = "";
      suggestionsEl.classList.remove("open");
      return;
    }
    suggestionsEl.innerHTML = matches
      .map(
        (item, idx) => `
      <div class="search-suggestion" role="option" data-idx="${idx}" data-code="${esc(item.code)}" tabindex="-1" aria-selected="false">
        <span class="suggestion-name">${esc(item.name)}</span>
        <span class="suggestion-meta">${esc(item.code)} · ₹ ${money(item.sale_price)} · Stock: ${money(item.stock)} ${esc(item.unit)}</span>
      </div>`
      )
      .join("");
    suggestionsEl.classList.add("open");
  };

  const selectSuggestion = async (idx) => {
    if (idx < 0 || idx >= matches.length) return;
    const item = matches[idx];
    await addCode(item.code);
    search.value = "";
    suggestionsEl.innerHTML = "";
    suggestionsEl.classList.remove("open");
    matches = [];
    selectedIndex = -1;
    search.focus();
  };

  const updateActiveSuggestion = () => {
    suggestionsEl.querySelectorAll(".search-suggestion").forEach((el, idx) => {
      if (idx === selectedIndex) {
        el.classList.add("active");
        el.setAttribute("aria-selected", "true");
        el.focus();
      } else {
        el.classList.remove("active");
        el.setAttribute("aria-selected", "false");
      }
    });
  };

  const addFromSearch = async () => {
    const q = search.value.trim();
    if (!q) return;
    if (selectedIndex >= 0 && matches.length) {
      await selectSuggestion(selectedIndex);
      return;
    }
    const exact = state.items.find((i) => i.code.toLowerCase() === q.toLowerCase());
    const match = exact || state.items.find((i) => i.name.toLowerCase().includes(q.toLowerCase()));
    if (!match) {
      setStatus("Item not found", "error");
      return;
    }
    await addCode(match.code);
    search.value = "";
    search.focus();
  };

  document.getElementById("addBtn").addEventListener("click", addFromSearch);
  
  search.addEventListener("input", (e) => {
    showSuggestions(e.target.value);
  });

  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFromSearch();
    } else if (e.key === "ArrowDown" && matches.length) {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, matches.length - 1);
      updateActiveSuggestion();
    } else if (e.key === "ArrowUp" && matches.length) {
      e.preventDefault();
      if (selectedIndex === -1) {
        selectedIndex = matches.length - 1;
      } else {
        selectedIndex = Math.max(selectedIndex - 1, 0);
      }
      updateActiveSuggestion();
      if (selectedIndex === -1) search.focus();
    } else if (e.key === "Escape") {
      suggestionsEl.innerHTML = "";
      suggestionsEl.classList.remove("open");
      matches = [];
      selectedIndex = -1;
    }
  });

  suggestionsEl.addEventListener("click", (e) => {
    const opt = e.target.closest(".search-suggestion");
    if (!opt) return;
    const idx = Number(opt.dataset.idx);
    selectSuggestion(idx);
  });
  
  // Global keyboard shortcuts
  const keyboardHandler = (e) => {
    // F2 - Focus search
    if (e.key === 'F2') {
      e.preventDefault();
      search.focus();
    }
    
    // F8 - Charge bill
    if (e.key === 'F8') {
      e.preventDefault();
      document.getElementById('payBtn').click();
    }
    
    // Tab + Shift - Navigate between sections
    if (e.key === 'Tab' && e.shiftKey) {
      const activeElement = document.activeElement;
      if (activeElement === search) {
        e.preventDefault();
        document.getElementById('payBtn').focus();
      }
    }
  };
  
  view.addEventListener('keydown', keyboardHandler);
  const searchInput = view.querySelector("#productSearch");
  const addBtn = view.querySelector("#addBtn");
  
  const doAdd = async () => {
    const v = searchInput.value.trim();
    if (!v) return;
    applyCart(await api("/add_item", { method: "POST", body: { query: v } }));
    searchInput.value = "";
    searchInput.focus();
  };
  
  addBtn.addEventListener("click", doAdd);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doAdd(); }
  });
  
  // Keep search bar focused, but do not steal focus from other inputs
  const keepFocus = () => {
    const modal = document.querySelector(".scanner-modal[aria-hidden='false']");
    if (modal || !searchInput) return;
    const active = document.activeElement;
    const isFormControl = active && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA' || active.tagName === 'BUTTON');
    if (!isFormControl && active !== searchInput) {
      searchInput.focus();
    }
  };
  state.focusInterval = setInterval(keepFocus, 500);
  view.querySelectorAll("[data-qty]").forEach((input) => {
    inputChange(input, async () => {
      await api("/update_item", { method: "POST", body: { code: input.dataset.qty, quantity: Number(input.value) } }).then(
        applyCart
      );
    });
  });
  view.querySelectorAll("[data-discount]").forEach((input) => {
    inputChange(input, async () => {
      await api("/update_item", { method: "POST", body: { code: input.dataset.discount, discount: Number(input.value) } }).then(
        applyCart
      );
    });
  });
  view.querySelectorAll("[data-qty-plus]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const code = btn.dataset.qtyPlus;
      const currentInput = view.querySelector(`[data-qty="${code}"]`);
      const currentValue = parseFloat(currentInput.value) || 0;
      const newValue = currentValue + 1;
      currentInput.value = newValue;
      await api("/update_item", { method: "POST", body: { code, quantity: newValue } }).then(applyCart);
    });
  });
  view.querySelectorAll("[data-qty-minus]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const code = btn.dataset.qtyMinus;
      const currentInput = view.querySelector(`[data-qty="${code}"]`);
      const currentValue = parseFloat(currentInput.value) || 0;
      const newValue = Math.max(0.01, currentValue - 1);
      currentInput.value = newValue;
      await api("/update_item", { method: "POST", body: { code, quantity: newValue } }).then(applyCart);
    });
  });
  document.getElementById("billDiscount").addEventListener("change", async (e) => {
    applyCart(await api("/api/cart/discount", { method: "POST", body: { discount: Number(e.target.value) } }));
  });
  document.getElementById("customerName").addEventListener("input", (e) => {
    state.customerName = e.target.value;
    showCustomerSuggestions("name", e.target.value);
  });
  document.getElementById("customerName").addEventListener("change", () => syncCustomer());
  document.getElementById("customerPhone").addEventListener("input", (e) => {
    state.customerPhone = e.target.value;
    showCustomerSuggestions("phone", e.target.value);
  });
  document.getElementById("customerPhone").addEventListener("change", () => syncCustomer());
  document.getElementById("waCheck").addEventListener("change", (e) => (state.sendWhatsapp = e.target.checked));
  view.querySelectorAll("[data-pay]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.payment = btn.dataset.pay;
      renderView();
    });
  });
  
  // Keyboard navigation for payment methods
  const payOpts = view.querySelectorAll('.payment-method');
  payOpts.forEach((opt, index) => {
    opt.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (index < payOpts.length - 1) payOpts[index + 1].focus();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (index > 0) payOpts[index - 1].focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        opt.click();
      }
    });
  });
  document.getElementById("paidInput").addEventListener("input", (e) => {
    state.paid = e.target.value;
    // Update change amount display
    const changeEl = document.querySelector('.change-amount');
    if (changeEl) {
      const paid = parseFloat(state.paid) || c.total;
      const change = Math.max(0, paid - c.total);
      changeEl.textContent = `₹ ${money(change)}`;
    }
  });
  document.getElementById("payBtn").addEventListener("click", chargeBill);
  document.getElementById("printBtn").addEventListener("click", printBill);
  document.getElementById("scanBtn").addEventListener("click", startScanner);
  
  // Store keyboard handler reference for cleanup
  view._keyboardHandler = keyboardHandler;
  
  // Clean up event listeners when view changes
  view._cleanup = () => {
    view.removeEventListener('keydown', keyboardHandler);
  };
}

function inputChange(el, fn) {
  el.addEventListener("change", fn);
}

function applyCart(data) {
  state.cart = data.cart || emptyCart();
  state.customerName = state.cart.party_name === "Walk-in Customer" ? "" : state.cart.party_name || "";
  state.customerPhone = state.cart.party_phone || "";
  renderView();
}

function showCustomerSuggestions(type, value) {
  const nameBox = document.getElementById("nameSuggestions");
  const phoneBox = document.getElementById("phoneSuggestions");
  if (!nameBox || !phoneBox) return;
  if (!value || !state.parties) {
    nameBox.innerHTML = "";
    phoneBox.innerHTML = "";
    return;
  }
  const q = value.toLowerCase();
  const matches = state.parties
    .filter((p) => {
      if (type === "name") return (p.name || "").toLowerCase().includes(q);
      if (type === "phone") return (p.phone || "").includes(value);
      return false;
    })
    .slice(0, 6);
  const target = type === "name" ? nameBox : phoneBox;
  const other = type === "name" ? phoneBox : nameBox;
  other.innerHTML = "";
  if (matches.length === 0) {
    target.innerHTML = "";
    return;
  }
  target.innerHTML = matches
    .map(
      (p) => `
    <div class="customer-suggestion" data-party-id="${p.id}" role="option" tabindex="0">
      <strong>${esc(p.name)}</strong>
      <span>${esc(p.phone || '')}</span>
    </div>`
    )
    .join("");
  target.querySelectorAll(".customer-suggestion").forEach((el) => {
    el.addEventListener("click", () => selectCustomer(el.dataset.partyId));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        selectCustomer(el.dataset.partyId);
      }
    });
  });
}

function selectCustomer(partyId) {
  const party = state.parties.find((p) => p.id == partyId);
  if (!party) return;
  state.customerName = party.name;
  state.customerPhone = party.phone || "";
  const nameInput = document.getElementById("customerName");
  const phoneInput = document.getElementById("customerPhone");
  if (nameInput) nameInput.value = party.name;
  if (phoneInput) phoneInput.value = party.phone || "";
  const nameBox = document.getElementById("nameSuggestions");
  const phoneBox = document.getElementById("phoneSuggestions");
  if (nameBox) nameBox.innerHTML = "";
  if (phoneBox) phoneBox.innerHTML = "";
  syncCustomer(partyId);
}

async function syncCustomer(partyId = null) {
  const party = partyId ? state.parties.find((p) => p.id == partyId) : null;
  const body = party ? { party_id: party.id } : { party_name: state.customerName, phone: state.customerPhone };
  try {
    const data = await api("/api/cart/party", { method: "POST", body });
    state.cart = data.cart || state.cart;
  } catch (err) {
    console.error(err);
  }
}

async function addCode(code) {
  try {
    const item = state.items.find((i) => i.code === code);
    if (!item) {
      return setStatus("Product not found", "error");
    }
    const sale = Number(item.sale_price) || 0;
    const purchase = Number(item.purchase_price) || 0;
    const mrp = Number(item.mrp) || sale;
    if (sale <= 0) {
      return setStatus(`Sale price must be greater than 0 for ${esc(item.name)}`, "error");
    }
    if (sale <= purchase) {
      return setStatus(`Sale price must be higher than purchase price for ${esc(item.name)}`, "error");
    }
    if (mrp > 0 && sale > mrp) {
      return setStatus(`Sale price cannot be greater than MRP for ${esc(item.name)}`, "error");
    }
    applyCart(await api("/add_to_cart", { method: "POST", body: { code, quantity: 1 } }));
    setStatus(`Added ${esc(item.name)}`, "ok");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

async function chargeBill(openPdf = false) {
  try {
    const paid = document.getElementById("paidInput").value;
    const data = await api("/api/sale", {
      method: "POST",
      body: {
        payment_method: state.payment,
        paid,
        customer_name: state.customerName,
        customer_phone: state.customerPhone,
        send_whatsapp: state.sendWhatsapp,
      },
    });
    applyCart(data);
    state.customerName = "";
    state.customerPhone = "";
    state.sendWhatsapp = false;
    setStatus(`Saved ${data.invoice.invoice_no}`, "ok");
    if (openPdf) {
      window.open(`/invoice_pdf?id=${data.invoice.id}`, "_blank");
    }
    await loadItems(false);
  } catch (err) {
    setStatus(err.message, "error");
  }
}

async function printBill() {
  await chargeBill(true);
}

async function recallHeld() {
  const list = (await api("/api/cart/held")).held || [];
  if (!list.length) {
    setStatus("No held bills", "error");
    return;
  }
  const choice = prompt(list.map((h) => `${h.id}: ${h.name}`).join("\n") + "\n\nEnter id");
  if (!choice) return;
  applyCart(await api(`/api/cart/recall/${choice}`, { method: "POST", body: {} }));
}

function renderItems(view) {
  view.innerHTML = `
    ${
      can("manager")
        ? `<div class="toolbar"><button class="btn" id="newItem">Add item</button></div>`
        : ""
    }
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>Category</th><th>Purchase</th><th>MRP</th><th>Sale</th><th>GST</th><th>Stock</th>${can("manager") ? "<th></th>" : ""}</tr></thead>
        <tbody>
          ${state.items
            .map(
              (i) => `<tr>
                <td>${esc(i.code)}</td><td>${esc(i.name)}</td><td>${esc(i.category)}</td>
                <td>₹ ${money(i.purchase_price)}</td>
                <td>₹ ${money(i.mrp || i.sale_price)}</td>
                <td>₹ ${money(i.sale_price)}</td>
                <td>${i.gst_percent}%</td>
                <td class="${Number(i.stock) <= Number(i.low_stock) ? "low" : ""}">${money(i.stock)}</td>
                ${
                  can("manager")
                    ? `<td><button class="btn ghost sm" data-edit="${i.id}">Edit</button>
                       <button class="btn danger sm" data-del="${i.id}">Delete</button></td>`
                    : ""
                }
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
  document.getElementById("newItem")?.addEventListener("click", () => itemForm());
  view.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => itemForm(state.items.find((i) => String(i.id) === btn.dataset.edit)));
  });
  view.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this item?")) return;
      await api(`/api/items/${btn.dataset.del}`, { method: "DELETE" });
      await loadItems();
    });
  });
}

function itemForm(item = {}) {
  const cats = new Set(state.categories || []);
  if (item.category) cats.add(item.category);
  cats.add("General");
  const catOpts = Array.from(cats)
    .map((c) => `<option value="${esc(c)}" ${(item.category || "General") === c ? "selected" : ""}>${esc(c)}</option>`)
    .join("");
  const unitList = ["pcs", "kg", "g", "ltr", "ml", "box", "pack", "dozen", "set", "meter", "nos"];
  const units = new Set(unitList);
  if (item.unit) units.add(item.unit);
  const unitOpts = Array.from(units)
    .map((u) => `<option value="${esc(u)}" ${(item.unit || "pcs") === u ? "selected" : ""}>${esc(u)}</option>`)
    .join("");
  openModal(`
    <h3>${item.id ? "Edit item" : "New item"}</h3>
    <form id="itemForm" class="form-grid" novalidate>
      <label class="full">Barcode / Code
        <input name="code" placeholder="Barcode / code" value="${esc(item.code || "")}" required />
      </label>
      <label class="full">Name
        <input name="name" placeholder="Name" value="${esc(item.name || "")}" required />
      </label>
      <label>Category
        <select name="category">${catOpts}</select>
      </label>
      <label>HSN
        <input name="hsn" placeholder="HSN" value="${esc(item.hsn || "")}" />
      </label>
      <label>Sale price
        <input name="sale_price" type="number" step="0.01" placeholder="Sale price" value="${item.sale_price ?? ""}" />
      </label>
      <label>Purchase price
        <input name="purchase_price" type="number" step="0.01" min="0.01" placeholder="Purchase price" value="${item.purchase_price ?? ""}" required />
      </label>
      <label>MRP
        <input name="mrp" type="number" step="0.01" min="0.01" placeholder="MRP" value="${item.mrp || item.sale_price || ""}" required />
      </label>
      <label>GST %
        <input name="gst_percent" type="number" step="0.01" placeholder="GST %" value="${item.gst_percent ?? (parseFloat(state.settings?.default_gst) || 0)}" />
      </label>
      <label>Stock
        <input name="stock" type="number" step="0.01" min="0.01" placeholder="Stock" value="${item.stock ?? 0}" required />
      </label>
      <label>Unit
        <select name="unit">${unitOpts}</select>
      </label>
      <label>Low stock
        <input name="low_stock" type="number" step="0.01" placeholder="Low stock" value="${item.low_stock ?? 5}" />
      </label>
      <div class="full form-error" id="itemFormError"></div>
    </form>`, "itemForm");
  document.getElementById("itemForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    const errEl = document.getElementById("itemFormError");
    const purchase = Number(fd.purchase_price) || 0;
    const mrp = Number(fd.mrp) || 0;
    const stock = Number(fd.stock) || 0;
    const sale = fd.sale_price ? Number(fd.sale_price) : 0;
    let msg = "";
    if (!fd.code || !fd.code.trim()) msg = "Barcode / Code is required";
    else if (!fd.name || !fd.name.trim()) msg = "Name is required";
    else if (purchase <= 0) msg = "Purchase price must be greater than 0";
    else if (mrp <= 0) msg = "MRP must be greater than 0";
    else if (stock <= 0) msg = "Stock must be greater than 0";
    else if (sale > 0 && sale <= purchase) msg = "Sale price must be higher than purchase price";
    else if (sale > 0 && sale > mrp) msg = "Sale price cannot be greater than MRP";
    if (msg) {
      if (errEl) errEl.textContent = msg;
      return;
    }
    const url = item.id ? `/api/items/${item.id}` : "/api/items";
    try {
      await api(url, { method: item.id ? "PUT" : "POST", body: fd });
      closeModal();
      await loadItems(false);
      if (state.view === "items") renderView();
    } catch (err) {
      const errEl = document.getElementById("itemFormError");
      if (errEl) errEl.textContent = err.message;
    }
  });
}

function renderParties(view) {
  const filter = state.partyFilter || "customer";
  const filtered = state.parties.filter((p) => p.type === filter);
  view.innerHTML = `
    <div class="party-tabs" role="tablist" aria-label="Party types">
      <button class="party-tab ${filter === "customer" ? "active" : ""}" data-type="customer" role="tab" aria-selected="${filter === "customer" ? "true" : "false"}">Customers</button>
      <button class="party-tab ${filter === "supplier" ? "active" : ""}" data-type="supplier" role="tab" aria-selected="${filter === "supplier" ? "true" : "false"}">Suppliers</button>
    </div>
    ${can("manager") ? `<div class="toolbar"><button class="btn" id="newParty">Add party</button></div>` : ""}
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Phone</th><th>Outstanding</th>${can("manager") ? "<th></th>" : ""}</tr></thead>
        <tbody>
          ${filtered
            .map(
              (p) => `<tr>
                <td>${esc(p.name)}</td><td>${esc(p.phone)}</td>
                <td class="outstanding ${p.outstanding > 0 ? 'positive' : p.outstanding < 0 ? 'negative' : ''}">₹ ${money(p.outstanding)}</td>
                ${
                  can("manager")
                    ? `<td><button class="btn ghost sm" data-edit="${p.id}">Edit</button>
                       <button class="btn ghost sm" data-pay="${p.id}">Receive</button>
                       <button class="btn danger sm" data-del="${p.id}">Delete</button></td>`
                    : ""
                }
              </tr>`
            )
            .join("") || `<tr><td colspan="${can("manager") ? 4 : 3}">No ${filter}s found</td></tr>`
          }
        </tbody>
      </table>
    </div>`;
  view.querySelectorAll("[data-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.partyFilter = btn.dataset.type;
      renderView();
    });
  });
  document.getElementById("newParty")?.addEventListener("click", () => partyForm());
  view.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => partyForm(state.parties.find((p) => String(p.id) === btn.dataset.edit)));
  });
  view.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this party?")) return;
      await api(`/api/parties/${btn.dataset.del}`, { method: "DELETE" });
      await loadParties();
    });
  });
  view.querySelectorAll("[data-pay]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const amount = prompt("Amount received");
      if (!amount) return;
      await api(`/api/parties/${btn.dataset.pay}/payment`, { method: "POST", body: { amount, method: "Cash" } });
      await loadParties();
    });
  });
}

function partyForm(party = {}) {
  const isSupplier = party.type === "supplier";
  openModal(`
    <h3>${party.id ? "Edit party" : "New party"}</h3>
    <form id="partyForm" class="form-grid">
      <label class="full">Name
        <input name="name" placeholder="Name" value="${esc(party.name || "")}" required />
      </label>
      <label>Type
        <select name="type" id="partyType"><option value="customer" ${!isSupplier ? "selected" : ""}>Customer</option>
          <option value="supplier" ${isSupplier ? "selected" : ""}>Supplier</option></select>
      </label>
      <label>Phone
        <input name="phone" placeholder="Phone" value="${esc(party.phone || "")}" />
      </label>
      <label class="party-gstin ${isSupplier ? "" : "hidden"}">GSTIN
        <input name="gstin" placeholder="GSTIN" value="${esc(party.gstin || "")}" />
      </label>
      <label>Opening balance
        <input name="opening_balance" type="number" step="0.01" placeholder="Opening balance" value="${party.opening_balance ?? 0}" />
      </label>
    </form>`, "partyForm");
  const typeSelect = document.getElementById("partyType");
  const gstinLabel = document.querySelector(".party-gstin");
  if (typeSelect && gstinLabel) {
    typeSelect.addEventListener("change", (e) => {
      gstinLabel.classList.toggle("hidden", e.target.value !== "supplier");
    });
  }
  document.getElementById("partyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    const url = party.id ? `/api/parties/${party.id}` : "/api/parties";
    await api(url, { method: party.id ? "PUT" : "POST", body: fd });
    closeModal();
    await loadParties();
  });
}

function renderSales(view) {
  view.innerHTML = `
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Invoice</th><th>Customer</th><th>Total</th><th>Paid</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${state.invoices
            .map(
              (i) => `<tr>
                <td>${esc(i.invoice_no)}</td><td>${esc(i.party_name || "Walk-in")}</td>
                <td>₹ ${money(i.total)}</td><td>₹ ${money(i.paid)}</td><td>${esc(i.status)}</td>
                <td>
                  <a class="btn ghost sm" href="/invoice_pdf?id=${i.id}" target="_blank">PDF</a>
                  ${Number(i.total) > Number(i.paid) ? `<button class="btn sm" data-pay="${i.id}">Pay</button>` : ""}
                  ${can("manager") ? `<button class="btn ghost sm" data-ret="${i.id}">Return</button>` : ""}
                </td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
  view.querySelectorAll("[data-pay]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const amount = prompt("Amount received");
      if (!amount) return;
      await api(`/api/invoices/${btn.dataset.pay}/payment`, { method: "POST", body: { amount } });
      await loadSales();
    });
  });
  view.querySelectorAll("[data-ret]").forEach((btn) => {
    btn.addEventListener("click", () => openReturn(btn.dataset.ret));
  });
}

async function openReturn(id) {
  const inv = (await api(`/api/invoices/${id}`)).invoice;
  openModal(`
    <h3>Return ${esc(inv.invoice_no)}</h3>
    <form id="retForm">
      ${(inv.items || [])
        .map(
          (it) => `<label class="row" style="display:flex;gap:8px;margin:8px 0;align-items:center">
            <span style="flex:1">${esc(it.name)}</span>
            <input name="q_${it.id}" type="number" min="0" max="${it.quantity}" step="0.01" value="0" style="width:90px" />
          </label>`
        )
        .join("")}
    </form>`, "retForm");
  document.getElementById("retForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const items = (inv.items || [])
      .map((it) => ({ invoice_item_id: it.id, quantity: Number(fd.get(`q_${it.id}`) || 0) }))
      .filter((x) => x.quantity > 0);
    await api(`/api/invoices/${id}/return`, { method: "POST", body: { items } });
    closeModal();
    await loadSales();
    setStatus("Return saved", "ok");
  });
}

function renderPurchases(view) {
  view.innerHTML = `
    <div class="toolbar"><button class="btn" id="newPurchase">New purchase</button></div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>No</th><th>Supplier</th><th>Total</th><th>Date</th></tr></thead>
        <tbody>
          ${state.purchases
            .map(
              (p) =>
                `<tr><td>${esc(p.purchase_no)}</td><td>${esc(p.party_name)}</td><td>₹ ${money(p.total)}</td><td>${esc(p.created_at)}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
  document.getElementById("newPurchase").addEventListener("click", () => switchView("new-purchase"));
}

function makeResizable(table) {
  table.style.tableLayout = "fixed";
  const ths = table.querySelectorAll("th");
  ths.forEach((th) => {
    if (th.querySelector(".resizer")) return;
    th.style.position = "relative";
    const resizer = document.createElement("div");
    resizer.className = "resizer";
    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = th.offsetWidth;
      const onMove = (e2) => {
        const w = startWidth + (e2.clientX - startX);
        th.style.width = Math.max(40, w) + "px";
        table.style.tableLayout = "fixed";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    th.appendChild(resizer);
  });
}

function renderNewPurchase(view) {
  const suppliers = state.parties.filter((p) => p.type === "supplier");
  view.innerHTML = `
    <div class="toolbar">
      <button type="button" class="btn ghost" id="purBack">← Back</button>
      <h3 style="margin:0">New purchase</h3>
    </div>
    <div class="pur-pos">
      <div class="pur-pos-left">
        <div class="pur-search-wrap">
          <label for="purSearch" class="pur-search-label">Search product / barcode</label>
          <div class="pur-search">
            <input id="purSearch" type="text" placeholder="Type product name or barcode" autocomplete="off" />
            <div id="purSugg" class="pur-suggestions" style="display:none"></div>
          </div>
        </div>
        <div class="items-table-section">
          <div class="section-header">
            <h3>Purchase Items</h3>
            <span class="item-count" id="purItemCount">0 items</span>
          </div>
          <div class="items-table-container" style="min-height:180px">
            <table id="purTable" class="items-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th style="width:70px">Qty</th>
                  <th style="width:90px">Purchase</th>
                  <th style="width:90px">MRP</th>
                  <th style="width:90px">Sale</th>
                  <th style="width:60px">GST%</th>
                  <th style="width:90px">Total</th>
                  <th style="width:40px"></th>
                </tr>
              </thead>
              <tbody id="purLineBody"></tbody>
            </table>
          </div>
        </div>
        <div class="form-error" id="purTableError" style="display:none; margin-top:8px"></div>
      </div>
      <div class="pur-pos-right">
        <form id="purForm" class="order-summary">
          <h3 class="full" style="margin:0 0 8px 0">Purchase Summary</h3>
          <label class="full">Supplier
            <select name="party_id">
              <option value="">Walk-in / No supplier</option>
              ${suppliers.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}
            </select>
          </label>
          <div class="summary-row"><span>Subtotal</span><span id="purSubtotal">₹ 0.00</span></div>
          <div class="summary-row"><span>Tax</span><span id="purTax">₹ 0.00</span></div>
          <div class="summary-row total"><span>Total</span><span id="purTotal">₹ 0.00</span></div>
          <label class="full">Paid
            <input name="paid" id="purPaid" type="number" step="0.01" value="0" />
          </label>
          <div class="summary-row"><span>Balance</span><span id="purBalance">₹ 0.00</span></div>
          <div class="full" style="margin-top:12px">
            <button type="submit" class="btn green full" id="purSave">Save purchase</button>
            <button type="button" class="btn ghost full" id="purCancel" style="margin-top:8px">Cancel</button>
          </div>
        </form>
      </div>
    </div>`;
  makeResizable(document.getElementById("purTable"));
  const lines = [];
  const searchInput = document.getElementById("purSearch");
  const suggBox = document.getElementById("purSugg");
  const showSuggestions = () => {
    const val = searchInput.value.trim().toLowerCase();
    if (!val) {
      suggBox.style.display = "none";
      return;
    }
    const matches = state.items.filter((i) => i.name.toLowerCase().includes(val) || i.code.toLowerCase().includes(val));
    if (matches.length === 0) {
      suggBox.innerHTML = `<div class="pur-suggestion add-new" id="purAddNew">+ Add new item</div>`;
    } else {
      suggBox.innerHTML = matches
        .slice(0, 8)
        .map((i) => `<div class="pur-suggestion" data-code="${esc(i.code)}">${esc(i.name)} <span class="muted">${esc(i.code)}</span></div>`)
        .join("");
    }
    suggBox.style.display = "block";
    suggBox.querySelectorAll(".pur-suggestion").forEach((el) =>
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (el.id === "purAddNew") {
          itemForm();
          suggBox.style.display = "none";
        } else {
          const code = el.dataset.code;
          const item = state.items.find((i) => i.code === code);
          if (item) {
            const purchasePrice = Number(item.purchase_price || 0);
            const mrp = Number(item.mrp || item.sale_price || 0);
            const qty = 1;
            const gstPercent = 0;
            const taxable = qty * purchasePrice;
            const lineTax = Math.round(taxable * gstPercent / 100 * 100) / 100;
            lines.push({
              item_id: item.id,
              code: item.code,
              name: item.name,
              quantity: qty,
              price: purchasePrice,
              mrp: mrp,
              sale_price: mrp,
              gst_percent: gstPercent,
              line_total: Math.round((taxable + lineTax) * 100) / 100,
            });
            searchInput.value = "";
            suggBox.style.display = "none";
            draw();
          }
        }
      })
    );
  };
  searchInput.addEventListener("input", showSuggestions);
  searchInput.addEventListener("focus", showSuggestions);
  searchInput.addEventListener("blur", () => (suggBox.style.display = "none"));
  const draw = () => {
    let subtotal = 0;
    let tax = 0;
    for (const l of lines) {
      const taxable = l.quantity * l.price;
      const lineTax = Math.round(taxable * l.gst_percent / 100 * 100) / 100;
      subtotal += taxable;
      tax += lineTax;
      l.line_total = Math.round((taxable + lineTax) * 100) / 100;
      let err = "";
      const mrp = Number(l.mrp);
      const price = Number(l.price);
      const qty = Number(l.quantity);
      const sale = Number(l.sale_price);
      if (isNaN(qty) || qty < 0) err = "Quantity cannot be negative";
      else if (isNaN(price) || price < 0) err = "Purchase price cannot be negative";
      else if (isNaN(mrp) || mrp <= 0) err = "MRP is required and must be greater than 0";
      else if (mrp <= price) err = "MRP must be higher than purchase price";
      else if (isNaN(sale) || sale <= 0) err = "Sale price must be greater than 0";
      else if (sale <= price) err = "Sale price must be higher than purchase price";
      else if (sale > mrp) err = "Sale price cannot be greater than MRP";
      l._error = err;
    }
    const total = Math.round((subtotal + tax) * 100) / 100;
    const paid = Math.round((parseFloat(document.getElementById("purPaid").value) || 0) * 100) / 100;
    document.getElementById("purSubtotal").textContent = `₹ ${money(subtotal)}`;
    document.getElementById("purTax").textContent = `₹ ${money(tax)}`;
    document.getElementById("purTotal").textContent = `₹ ${money(total)}`;
    document.getElementById("purBalance").textContent = `₹ ${money(total - paid)}`;
    const tbody = document.getElementById("purLineBody");
    tbody.innerHTML = lines
      .map(
        (l, i) => `
        <tr class="${l._error ? "pur-row-error" : ""}" title="${l._error ? esc(l._error) : ""}">
          <td>${esc(l.name)}</td>
          <td><input type="number" step="0.01" value="${l.quantity}" data-i="${i}" data-f="quantity" /></td>
          <td><input type="number" step="0.01" value="${money(l.price)}" data-i="${i}" data-f="price" /></td>
          <td><input type="number" step="0.01" value="${money(l.mrp)}" data-i="${i}" data-f="mrp" /></td>
          <td><input type="number" step="0.01" value="${money(l.sale_price)}" data-i="${i}" data-f="sale_price" /></td>
          <td><input type="number" step="0.01" value="${money(l.gst_percent)}" data-i="${i}" data-f="gst_percent" style="width:100%" /></td>
          <td>₹ ${money(l.line_total)}</td>
          <td><button type="button" class="btn danger sm" data-i="${i}">x</button></td>
        </tr>
      `
      )
      .join("");
    const errMsg = lines.map((l) => l._error).filter(Boolean)[0] || "";
    const errEl = document.getElementById("purTableError");
    const countEl = document.getElementById("purItemCount");
    if (countEl) countEl.textContent = `${lines.length} items`;
    if (errMsg) {
      errEl.textContent = errMsg;
      errEl.style.display = "block";
    } else {
      errEl.textContent = "";
      errEl.style.display = "none";
    }
    tbody.querySelectorAll("input[data-i]").forEach((el) =>
      el.addEventListener("change", (e) => {
        const li = Number(e.target.dataset.i);
        const field = e.target.dataset.f;
        const l = lines[li];
        const raw = e.target.value.trim();
        if (field === "sale_price") {
          l.sale_price = raw === "" ? l.mrp : Number(raw) || 0;
        } else if (field === "mrp") {
          const newMrp = Number(raw) || 0;
          const oldMrp = l.mrp;
          l.mrp = newMrp;
          if (Number(l.sale_price) === Number(oldMrp)) {
            l.sale_price = newMrp;
          }
        } else if (field === "price" || field === "quantity") {
          l[field] = Number(raw) || 0;
        } else {
          l[field] = Number(raw) || 0;
        }
        draw();
      })
    );
    tbody.querySelectorAll("button[data-i]").forEach((b) =>
      b.addEventListener("click", () => {
        lines.splice(Number(b.dataset.i), 1);
        draw();
      })
    );
  };
  document.getElementById("purPaid").addEventListener("input", draw);
  document.getElementById("purForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    draw();
    if (lines.some((l) => l._error)) {
      setStatus("Please fix the highlighted items before saving", "error");
      return;
    }
    const fd = new FormData(e.target);
    try {
      await api("/api/purchases", {
        method: "POST",
        body: { party_id: fd.get("party_id") || null, paid: fd.get("paid"), items: lines },
      });
      await loadPurchases();
      await loadItems(false);
      setStatus("Purchase saved", "ok");
      switchView("purchases");
    } catch (err) {
      setStatus(err.message, "error");
    }
  });
  document.getElementById("purBack").addEventListener("click", () => switchView("purchases"));
  document.getElementById("purCancel").addEventListener("click", () => switchView("purchases"));
}

function renderExpenses(view) {
  view.innerHTML = `
    <form class="toolbar" id="expForm">
      <input name="category" placeholder="Category (rent, power...)" />
      <input name="amount" type="number" step="0.01" placeholder="Amount" />
      <input name="note" class="grow" placeholder="Note" />
      <button class="btn">Add expense</button>
    </form>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Category</th><th>Amount</th><th>Note</th><th>Date</th><th></th></tr></thead>
        <tbody>
          ${state.expenses
            .map(
              (e) => `<tr>
                <td>${esc(e.category)}</td><td>₹ ${money(e.amount)}</td><td>${esc(e.note)}</td><td>${esc(e.created_at)}</td>
                <td><button class="btn danger sm" data-del="${e.id}">Delete</button></td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
  document.getElementById("expForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    await api("/api/expenses", { method: "POST", body: fd });
    await loadExpenses();
  });
  view.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/api/expenses/${btn.dataset.del}`, { method: "DELETE" });
      await loadExpenses();
    });
  });
}

function renderReports(view) {
  const r = state.report || {};
  const today = new Date().toISOString().slice(0, 10);
  view.innerHTML = `
    <form class="toolbar" id="repForm">
      <input type="date" name="from" value="${r.date_from || today}" />
      <input type="date" name="to" value="${r.date_to || today}" />
      <button class="btn">Show report</button>
    </form>
    <div class="cards">
      <div class="card green"><div class="label">Sales</div><div class="value">₹ ${money(r.sales)}</div></div>
      <div class="card"><div class="label">Purchases</div><div class="value">₹ ${money(r.purchases)}</div></div>
      <div class="card"><div class="label">Expenses</div><div class="value">₹ ${money(r.expenses)}</div></div>
      <div class="card blue"><div class="label">Profit</div><div class="value">₹ ${money(r.profit)}</div></div>
    </div>
    <p class="muted">Profit = sales − cost of goods − expenses − returns. Dues: ₹ ${money(r.dues)}</p>
    <div class="card table-wrap">
      <table><thead><tr><th>Day</th><th>Bills</th><th>Sales</th></tr></thead>
      <tbody>${
        (r.by_day || [])
          .map((d) => `<tr><td>${esc(d.day)}</td><td>${d.n}</td><td>₹ ${money(d.total)}</td></tr>`)
          .join("") || `<tr><td colspan="3">No data in this range</td></tr>`
      }</tbody></table>
    </div>`;
  document.getElementById("repForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await loadReports(fd.get("from"), fd.get("to"));
  });
}

function renderSettings(view) {
  const s = state.settings || {};
  const d = state.drive || {};
  view.innerHTML = `
    <div class="pos">
      <form class="card form-grid" id="setForm">
        <h3 class="full">Shop</h3>
        <label>Shop name
          <input name="shop_name" placeholder="Shop name" value="${esc(s.shop_name || "")}" />
        </label>
        <label>GSTIN
          <input name="gstin" placeholder="GSTIN" value="${esc(s.gstin || "")}" />
        </label>
        <label>UPI ID
          <input name="upi_vpa" placeholder="UPI ID" value="${esc(s.upi_vpa || "")}" />
        </label>
        <label>UPI name
          <input name="upi_name" placeholder="UPI name" value="${esc(s.upi_name || "")}" />
        </label>
        <label>Default GST %
          <input name="default_gst" type="number" step="0.01" placeholder="Default GST %" value="${esc(s.default_gst || "")}" />
        </label>
        <label>GST type
          <select name="gst_type">
            <option value="intra" ${s.gst_type !== "inter" ? "selected" : ""}>Intra-state (CGST+SGST)</option>
            <option value="inter" ${s.gst_type === "inter" ? "selected" : ""}>Inter-state (IGST)</option>
          </select>
        </label>
        <label>Drive backup
          <select name="drive_auto_backup">
            <option value="0" ${s.drive_auto_backup !== "1" ? "selected" : ""}>Manual Drive backup</option>
            <option value="1" ${s.drive_auto_backup === "1" ? "selected" : ""}>Auto backup after each sale</option>
          </select>
        </label>
        <div class="full"><button class="btn" type="submit">Save settings</button></div>
      </form>
      <div class="card">
        <h3>Google Drive backup</h3>
        <p class="help">1. Create a Google Cloud OAuth <b>Desktop</b> client.<br>
        2. Download <code>credentials.json</code> into <code>${esc(d.credentials_path || "")}</code><br>
        3. Click Connect, then Backup now. Restore replaces the local database.</p>
        <p>Credentials: ${d.credentials ? "found" : "missing"} · Connected: ${d.connected ? "yes" : "no"}</p>
        <div class="toolbar">
          <button class="btn" id="drvConnect">Connect</button>
          <button class="btn green" id="drvBackup">Backup now</button>
          <button class="btn ghost" id="drvList">List backups</button>
          <button class="btn ghost" id="drvOff">Disconnect</button>
        </div>
        <div id="drvFiles"></div>
        <h3>Users</h3>
        <form id="userForm" class="toolbar">
          <input name="username" placeholder="Username" />
          <input name="password" placeholder="Password" />
          <select name="role"><option>cashier</option><option>manager</option><option>admin</option></select>
          <button class="btn">Add user</button>
        </form>
        <div class="table-wrap">
          <table><thead><tr><th>User</th><th>Role</th><th></th></tr></thead>
          <tbody>${(state.users || [])
            .map(
              (u) =>
                `<tr><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td><button class="btn danger sm" data-delu="${u.id}">Delete</button></td></tr>`
            )
            .join("")}</tbody></table>
        </div>
        <form id="pwForm" class="toolbar">
          <input name="password" type="password" placeholder="Change my password" />
          <button class="btn ghost">Update password</button>
        </form>
      </div>
    </div>`;
  document.getElementById("setForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    const data = await api("/api/settings", { method: "POST", body: fd });
    state.settings = data.settings;
    setStatus("Settings saved", "ok");
  });
  document.getElementById("drvConnect").addEventListener("click", async () => {
    try {
      setStatus("A browser window will open for Google sign-in...");
      const data = await api("/api/drive/connect", { method: "POST", body: {} });
      state.drive = data.drive;
      setStatus("Google Drive connected", "ok");
      renderView();
    } catch (err) {
      setStatus(err.message, "error");
    }
  });
  document.getElementById("drvBackup").addEventListener("click", async () => {
    try {
      await api("/api/drive/backup", { method: "POST", body: {} });
      setStatus("Backup uploaded to Drive", "ok");
    } catch (err) {
      setStatus(err.message, "error");
    }
  });
  document.getElementById("drvList").addEventListener("click", async () => {
    const data = await api("/api/drive/backups");
    document.getElementById("drvFiles").innerHTML = (data.files || [])
      .map(
        (f) =>
          `<div class="toolbar"><span>${esc(f.name)} · ${esc(f.createdTime || "")}</span>
           <button class="btn sm" data-res="${f.id}">Restore</button></div>`
      )
      .join("");
    document.querySelectorAll("[data-res]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Replace local database with this backup?")) return;
        await api("/api/drive/restore", { method: "POST", body: { file_id: b.dataset.res } });
        location.reload();
      })
    );
  });
  document.getElementById("drvOff").addEventListener("click", async () => {
    const data = await api("/api/drive/disconnect", { method: "POST", body: {} });
    state.drive = data.drive;
    renderView();
  });
  document.getElementById("userForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    const data = await api("/api/users", { method: "POST", body: fd });
    state.users = data.users;
    renderView();
  });
  view.querySelectorAll("[data-delu]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const data = await api(`/api/users/${btn.dataset.delu}`, { method: "DELETE" });
      state.users = data.users;
      renderView();
    });
  });
  document.getElementById("pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    await api(`/api/users/${state.user.id}/password`, { method: "POST", body: fd });
    setStatus("Password updated", "ok");
  });
}

function openModal(html, formId = null, cardClass = "") {
  const footer = formId
    ? `<div class="modal-footer">
        <button type="submit" form="${formId}" class="btn" id="saveModal">Save</button>
        <button type="button" class="btn ghost" id="closeModal">Close</button>
      </div>`
    : `<div class="modal-footer">
        <button type="button" class="btn ghost" id="closeModal">Close</button>
      </div>`;
  modalEl.innerHTML = `<div class="modal-card ${esc(cardClass)}">${html}${footer}</div>`;
  modalEl.setAttribute("aria-hidden", "false");
  document.getElementById("closeModal").addEventListener("click", closeModal);
}

function closeModal() {
  modalEl.setAttribute("aria-hidden", "true");
  modalEl.innerHTML = "";
}

let quaggaRunning = false;
const recentScans = new Map();
async function startScanner() {
  const modal = document.getElementById("scannerModal");
  if (!window.Quagga) {
    setStatus("Scanner library failed to load", "error");
    return;
  }
  modal.setAttribute("aria-hidden", "false");
  await Quagga.init({
    inputStream: {
      name: "Live",
      type: "LiveStream",
      target: document.querySelector("#scanner"),
      constraints: { facingMode: "environment" },
    },
    decoder: { readers: ["ean_reader", "ean_8_reader", "code_128_reader", "upc_reader", "upc_e_reader"] },
    locate: true,
  });
  Quagga.start();
  quaggaRunning = true;
}

function stopScanner() {
  if (window.Quagga && quaggaRunning) Quagga.stop();
  quaggaRunning = false;
  document.getElementById("scannerModal").setAttribute("aria-hidden", "true");
}

document.getElementById("closeScanner").addEventListener("click", stopScanner);
if (window.Quagga) {
  Quagga.onDetected(async (data) => {
    const code = data?.codeResult?.code;
    if (!code) return;
    const now = Date.now();
    if (now - (recentScans.get(code) || 0) < 1500) return;
    recentScans.set(code, now);
    await addCode(code);
  });
}

document.addEventListener("keydown", (e) => {
  if (!state.user) return;
  if (e.key === "F2") {
    e.preventDefault();
    document.getElementById("productSearch")?.focus();
  }
  if (e.key === "F8" && state.view === "pos") {
    e.preventDefault();
    chargeBill();
  }
});

async function loadDashboard() {
  state.dashboard = (await api("/api/dashboard")).dashboard;
  renderView();
}
async function loadItems(rerender = true) {
  const data = await api(`/api/items?q=&category=${encodeURIComponent(state.category || "")}`);
  state.items = data.items;
  state.categories = data.categories;
  if (rerender) renderView();
}
async function loadPos() {
  await Promise.all([loadItems(false), loadParties(false)]);
  await loadPosCart();
  state.held = (await api("/api/cart/held")).held;
  const tab = state.tabs.find((t) => t.posId === state.posId);
  if (tab) {
    if (tab.label.startsWith("BILL-")) {
      await api("/api/reserve-bill-no", { method: "POST", body: { bill_no: tab.label } });
    } else if (tab.label.startsWith("Bill ")) {
      const data = await api("/api/next-bill-no", { method: "POST", body: {} });
      tab.label = data.bill_no;
      localStorage.setItem("posTabs", JSON.stringify(state.tabs));
      render();
    }
  }
}

async function loadPosCart() {
  const data = await api("/cart");
  applyCart(data);
  const tab = state.tabs.find((t) => t.posId === state.posId);
  if (tab && tab.label.startsWith("BILL-")) {
    await api("/api/reserve-bill-no", { method: "POST", body: { bill_no: tab.label } });
  }
}

async function addPosTab() {
  const { bill_no } = await api("/api/next-bill-no", { method: "POST", body: {} });
  const newPosId = (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  state.tabs.push({ posId: newPosId, label: bill_no });
  state.posId = newPosId;
  localStorage.setItem("posId", state.posId);
  localStorage.setItem("posTabs", JSON.stringify(state.tabs));
  render();
  await loadPosCart();
}
async function loadParties(rerender = true) {
  state.parties = (await api("/api/parties")).parties;
  if (rerender) renderView();
}
async function loadSales() {
  state.invoices = (await api("/api/invoices")).invoices;
  renderView();
}
async function loadPurchases() {
  await loadItems(false);
  await loadParties(false);
  state.purchases = (await api("/api/purchases")).purchases;
  renderView();
}
async function loadExpenses() {
  state.expenses = (await api("/api/expenses")).expenses;
  renderView();
}
async function loadReports(from, to) {
  const q = from && to ? `?from=${from}&to=${to}` : "";
  state.report = (await api(`/api/reports${q}`)).report;
  renderView();
}
async function loadSettings() {
  const data = await api("/api/settings");
  state.settings = data.settings;
  state.drive = data.drive || {};
  state.users = data.users || [];
  renderView();
}

async function bootApp() {
  render();
  await loadPos();
}

async function start() {
  const me = await api("/api/me");
  state.settings = me.settings || {};
  state.drive = me.drive || {};
  if (me.user) {
    state.user = me.user;
    await bootApp();
  } else {
    render();
  }
}

start().catch((err) => {
  state.status = err.message;
  state.statusType = "error";
  render();
});
