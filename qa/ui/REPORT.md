# UI/UX + Browser + Print QA Report — Mart POS

- Server: isolated instance on `http://localhost:5056`, `MARTPOS_DATA_DIR=qa/data-ui` (copy of `data/pos.db`).
- Browser: headless **Edge** driven over CDP (Playwright unavailable — `npm` blocked in this environment; harness in `qa/ui/cdp.js` uses Node 24 native WebSocket + Edge `--headless=new`). Screenshots in `qa/ui/shots/`.
- Logs: `qa/ui/out1.txt` (auth + viewport sweep + button sweep), `out2.txt` (POS), `out3.txt` (POS/reports/items/cashier), `out4.txt` (full report sweep). Receipt captures: `receipt.html`, `receipt-partial.html`, `receipt-print-frame.html`. CSV sample: `export-sample.csv`.
- Note on methodology: several buttons in the sweep are reported `gone-before-click` — this is a harness artifact (the app re-renders the view on every state change, so DOM nodes are replaced), NOT a dead-button signal. Buttons that stayed mounted all did something or opened a modal.

## 1. Authentication

| Check | Result | Evidence |
|---|---|---|
| Login page renders | PASS | `shots/login-page.png`. **Note:** username and password are pre-filled `admin`/`admin`, and page text says "Default: admin / admin". |
| Submit empty fields | PASS (with caveat) | No status message shown; browser `required` validation silently blocks submit. Stays on login. No custom/visible error text. |
| Wrong password | PASS | Status shows `Invalid username or password`. |
| Correct login | PASS | Lands on `settings` view (forced because `must_change_password` is set) with status "Default password in use — please change it under Settings". |
| Reload after login | PASS | Still logged in (cookie session), returns to `settings` view. |
| Logout | PASS | Returns to login form. |
| Back button after logout | PASS | Browser navigated away to `about:blank` (previous history entry — the SPA never changes URL); no protected content shown. `shots/back-after-logout-2.png`. Caveat: because the app has no routing, Back always exits the app entirely rather than going to a previous in-app screen. |

## 2. Layout / overflow / console (all 9 views × 3 viewports)

- 1366×768: no horizontal overflow on any view. 0 console errors, 0 failed requests, only `404 /favicon.ico`.
- 1920×1080: same — clean.
- 1024×768: **FAIL — Reports view overflows horizontally** (`scrollWidth=1155` vs `clientWidth=1016`). All other views fine. `shots/v1024-reports.png`.
- Recurring: `404 /favicon.ico` on every load (no favicon shipped).

## 3. Dead buttons (click sweep @1366, `out1.txt`)

Every mounted button responded (modal opened, status changed, or view switched). Notable observations:
- POS `Camera` (scan) button → `NotAllowedError: Permission denied` in console (headless has no camera — expected in this env; verify on real hardware whether failure surfaces to the user or is a silent/unhandled rejection).
- Items `Delete` → `confirm()` dialog appears (auto-dismissed by harness). OK.
- Sales row buttons (Print / Pay / Return / Edit / Delete) all open modals or trigger print path. OK.
- Expenses `Add expense` with empty form → **bug #2 below**.

## 4. POS functional (`out2.txt`, `out3.txt`)

| Check | Result |
|---|---|
| Add via search + Enter | PASS — item added, qty 1. **But see bug #1:** a second dead handler also fires. |
| Add via Add button | PASS — qty +1. Same bug #1 404 fires. |
| Qty +/- | PASS (+ works). **Minus clamps at 0.01 — cannot reach 0 or remove the item** (script.js:929 `Math.max(0.01, ...)`). |
| Remove item | PARTIAL — **no Remove button / no Clear-cart button exists in the POS UI.** Setting the qty input to `0` and blurring does remove the line server-side, but the − button can never get there. |
| Mid-cart refresh | PASS — cart is server-side per pos_id; `TEST-UI-001x1` preserved after reload. |
| Bill discount | PASS — discount 10 applied, total 240→230. |
| paid > total | PASS — "Change to Return" shows ₹270.00 for total 230/paid 500. |
| Payment modes Cash/UPI/Card | PASS — UPI shows QR (`/upi_qr?am=230.00`), `shots/pos-upi-qr.png`. |
| paid < total then Charge | PASS — invoice saved, `status=partial` (INV-20260913-0011: total 230, paid 50). |
| Rapid multi-click on Charge | PASS — 3 synchronous clicks produced exactly **1** invoice (subsequent attempts hit empty cart). |
| Status text after qty-0 remove | Minor — status bar kept the earlier "Added TEST-UI-WIDGET" message (stale). |

## 5. Receipt printing (`receipt.js`)

- `ReceiptPrinter.print()` renders into a hidden 0×0 iframe then calls `frame.print()` — captured `shots/../receipt-print-frame.html` (the full print document) and rendered `shots/receipt-rendered.png` at 80mm (`@page size: 80mm`, `.rp` width 302px — no clipping inside the receipt).
- Field check on INV-20260913-0011 (partial, Cash): shop name ✓, invoice no ✓, date ✓, item rows (qty/rate/amount) ✓, subtotal ✓, discount ✓, TOTAL ✓, `Paid (Cash)` ✓, **Balance Due ₹ 180 shown** ✓ (paid 50 of 230). Change line correctly absent when paid ≤ total; appears when overpaid (code line 133).
- Settings page has a live receipt preview + `Test print` button (skipped in sweep; drives same iframe path).
- Caveat: actual `window.print()` output can't be verified headless; HTML/CSS verified instead.

## 6. Reports (`out4.txt` — all 12 categories, ~65 report tabs clicked)

- Every report loaded: **0 console errors, 0 failed requests, 0 4xx/5xx** across all categories.
- Custom range with both From+To filled → report loads, **no** "Select both From and To dates" error. PASS.
- From > To → `From date cannot be after To date`. PASS.
- Only From filled → `Select both From and To dates`. PASS.
- Note: the From/To inputs and the `Show Report` button only exist under the "Custom Range" preset (`rptShow` absent otherwise) — by design, though slightly non-obvious.
- Yesterday / This Month / Today presets → all load. PASS.
- Export CSV → downloads a well-formed CSV (`export-sample.csv`); parses correctly; totals row matches on-screen totals (930.00 / 60.00 / 855.00 / 271.00). **Minor:** CSV Total row leaves `Bills`/`Items` columns blank while the on-screen total row shows `10`/`15`.
- Print report → opens a formatted HTML window and calls print (verified via stub; 1101-byte doc generated). PASS.
- Empty states exist: e.g. "Select a customer to view this report." **Typo bug:** inventory ledger & price-history show "**Select a item** to view this report." (`a item`, should be `an item`; also ambiguous phrasing).
- **Stale status bug:** the "Select both From and To dates" error stays in the status bar across all subsequent report switches (and even across views/roles) — misleading while reports load fine.

## 7. Items form validation (exact messages)

| Input | Message shown |
|---|---|
| Empty submit | `Barcode / Code is required` |
| purchase_price = -5 | `Purchase price must be greater than 0` |
| sale (40) < purchase (50) | `Sale price must be higher than purchase price` |
| Duplicate code `TEST-UI-001` | `An item with this barcode already exists` |

All PASS — messages are inline in the modal (`#itemFormError`).

## 8. Cashier role

- Created `TEST-UI-CASHIER` (role `cashier`) via Settings → Users UI. Login works.
- Nav shows only: `dashboard, pos, items, parties, sales` — Purchases/Expenses/Reports/Settings correctly hidden.
- Calling `switchView('purchases'|'expenses'|'reports')` directly: view switches but APIs 403 and status shows `Not allowed for this role`. Server enforces → OK.
- **BUT `switchView('settings')` as cashier fully renders the Settings page** — shop/GST/Drive-backup/receipt-printer form AND the Add-user form (`hasUserForm=true`). `GET /api/settings` is allowed for any logged-in user; `GET /api/users` 403s (list stays empty). Writes are server-blocked (POST /api/settings is `requireRole('admin')`), so it's not a data-security hole, but the view is not gated and the cashier sees admin UI that will fail on save. `shots/cashier-settings-2.png`.

## Candidate bugs (ranked)

1. **POS: every search-add fires a dead second handler.** `renderPos` binds TWO click handlers to `#addBtn` (`addFromSearch` @script.js:808 and `doAdd` @882) and TWO Enter handlers on `#productSearch` (@815 and @883). `doAdd` POSTs to `/add_item`, which **does not exist server-side** → `404` + unhandled `Error: Not found` console error on every add. Repro: POS → type `TEST-UI-001` → Enter → Network shows `404 /add_item`, console shows `Error: Not found at doAdd (script.js:877)`.
2. **Expenses: unhandled rejection + raw SQLite error, no user feedback.** `expForm` submit handler (script.js:~2111) has no try/catch; submitting with empty Amount → `400` with `NOT NULL constraint failed: expenses.amount` in console; the status bar never changes — user sees nothing.
3. **Settings→Users: user list disappears after adding a user.** `POST /api/users` returns `{ok, user}` (server.js:1222) but the client does `state.users = data.users` (undefined) then re-renders → the users table renders empty until the page is reloaded. Repro: Settings → add user → list below goes blank.
4. **Stale status bar.** `setStatus` messages persist indefinitely across view/report switches — e.g. "Select both From and To dates" remains displayed while other reports load successfully; "Added …" persists after cart ops; "Report exported" persisted through the entire cashier session. Misleading.
5. **POS: no way to remove a line or clear the cart.** Minus clamps at 0.01; only typing `0` into the qty input removes the item (server accepts qty 0 → removes). Undiscoverable.
6. **Cashier can open the Settings view** via `switchView('settings')` (gating exists only in `navItems()`), sees full settings + user form that will 403 on save.
7. **Reports view horizontal overflow at 1024×768** (scrollWidth 1155 > 1016).
8. Minor: login form pre-fills `admin`/`admin`; `404 /favicon.ico` every load; "Select **a item** to view this report." typo; CSV Total row omits Bills/Items counts shown on-screen; Camera button rejection unhandled.

## Environment caveats

- Playwright/Chromium unavailable (npm install blocked in this sandbox); tests ran in headless **Edge** via raw CDP — behavior should be equivalent (same engine family), but print dialogs, camera, and file downloads were verified via DOM/network capture rather than real OS dialogs.
- Screenshots: `qa/ui/shots/*.png` (26 view shots + cashier/receipt/QR shots).
