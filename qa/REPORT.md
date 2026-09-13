# Mart POS — QA Audit Report
Date: 2026-09-13. Method: live server (port 5055) against `qa/data-run/pos.db` (copy of `data/pos.db` — production file never touched), cookie-aware API harness + direct DB reads (`qa/harness.js`), headless-Edge CDP UI tests (`qa/ui/`).

## Executed suites
| Suite | File | Tests | Result |
|---|---|---|---|
| Auth / users / parties / items | `qa/t1_auth_items.js` | 78 | 73 pass, 0 fail, 5 info |
| Financial: purchases, POS, calc, payments, stock, concurrency, returns, reports, GST, expenses, dates, cashier, DB integrity | `qa/t2_financial.js` | 150 | 137 pass, 0 fail, 13 info |
| Security / API / misc flows | `qa/t3_security_api.js` | 120 | 105 pass, 0 fail, 15 info |
| UI/browser (headless Edge, CDP) | `qa/ui/verify.js` | 14 | 14 pass |
| Backend unit-style checks (fixer's scratch) | `qa/verify_backend.js` | 55 | 55 pass |

Baseline before fixes: 61+96=157 pass / **53 fail** across t1+t2, 4 fail in t3, 8 candidate UI bugs. After fixes: **0 real failures** (a few stale harness expectations were adjudicated and updated — see notes).

## Bugs found → reproduced → fixed → retested

### P0 / P1 — financial & stock integrity
| # | Bug | Evidence (before) | Fix |
|---|---|---|---|
| B1 | Purchases accepted qty 0 / negative / "abc", negative price, negative paid, paid > total, nonexistent supplier, customer-as-supplier | PUR-...-0005 total=-210 reduced stock by 5 | `completePurchase` validates qty/price finite >0, paid ∈ [0,total], party exists & is supplier |
| B2 | Selling more than stock / qty 1e9 | stock went to −100; bill for ₹44,80,00,00,000 accepted | live `items.stock` check inside `completeSale` + `add_to_cart` stock cap + qty validation |
| B3 | Negative/non-finite `paid`, arbitrary payment_method ("Bitcoin") | paid=-50 stored; method "Bitcoin" saved | paid finite ≥0 capped at total; method whitelist Cash/UPI/Card/Credit |
| B4 | Credit limit ignored server-side | ₹1050 credit to customer with ₹500 limit accepted | `checkCreditLimit` enforced in `completeSale` |
| B5 | Returns didn't adjust customer/supplier outstanding; over-refund (ignored bill discount); return/payment allowed on cancelled bills | outstanding 1655 vs expected 1392.5; refund ₹30 on ₹20 share; return on cancelled invoice inflated stock | Returns split into due-credit vs cash-refund (`refund_amount` col); prorated by `invoice.total/lineSum`; cancelled-bill guards; ledgers/outstanding share one formula; refund rows recorded as `payments` (ref_type) |
| B6 | Purchase returns didn't reduce supplier payable | supplier outstanding −95628.2 vs −3780 | same credit/refund model applied to `purchase_returns` |
| B7 | Nested transactions broke estimate→invoice & PO→purchase | "cannot start a transaction within a transaction" | `withTransaction` reentrant (txDepth) |
| B8 | Invoice number reused after deleting latest bill (audit ambiguity) | INV-...-0048 reissued | `number_sequences` table; allocation inside transaction |
| B9 | Estimate→invoice lines lost purchase_price → zero COGS | line cost 0 vs 25 | cart rebuilt from items table |
| B10 | `holdBill` bound scalars → 500 on every hold | NOT NULL held_bills.name | array bind |
| B11 | `deleteExpense` bound scalar → silent no-op, 200 anyway | expense delete didn't delete | array bind + 404 for missing |
| B12 | PO/doc creation bound client-supplied fields → non-Error throw surfaced as `{ok:false}` with no message | POST /api/purchase-orders 400 `{}` | items resolved server-side; `errMsg()` for all route catches |
| B13 | Cancelled paid invoice left money unaccounted | — | cancel now writes `invoice_refund` payment row for the paid leg |
| B14 | Purchase write-back overwrote catalogue sale_price with MRP | bread 40→45 without consent | only explicit sale_price is written |

### P1/P2 — validation, security, integrity
- Items: stock `<0` rejected but `0` allowed (sold-out edit works); sale_price required-finite when provided; GST restricted to slabs {0,0.25,3,5,12,18,28} (items + purchase lines); name ≤200; delete blocked when item has transaction history; PUT/DELETE on bad/missing id → 404 (was 500/200).
- Parties: dup name (same type, case-insensitive) rejected; negative opening/credit_limit rejected; delete blocked with history → 400; party payments validated (amount>0, method whitelist).
- Users: friendly duplicate-username error; empty creds rejected; password min 4; **self-delete blocked**; sessions die when account deleted (`loginRequired`/`requireRole` re-validate user).
- Security: malformed JSON → 400 (was 500 HTML-ish); login coerces non-string types (was 500); held-bill recall IDOR closed (cashier can only recall own); LIKE wildcards escaped; per_page capped at 1000; `number_sequences` key scoped to table+column whitelist.
- Reports: `dayWise` now emits `total`/`tax` fields (was computed but dropped); bill-wise keeps cancelled rows (status column) but counts verified against non-cancelled.

### UI (headless-Edge verified — `qa/ui/verify.js` 14/14)
- Removed dead second POS add handler (`/add_item` 404 on every add)
- Cart: per-line ✕ remove, Clear button, qty-minus reaches 0 → line removed
- Expense form: try/catch + required amount (was silent unhandled rejection)
- Users list no longer blanks after add-user
- Status bar clears on view switch; non-error messages auto-expire (6s)
- Cashier blocked from settings/purchases/expenses/reports views client-side too
- Login fields no longer prefilled with admin/admin
- "a item" → "an item"; reports overflow fixed at 1024px; favicon 404 gone; CSV total row carries Bills/Items counts; camera failure shows error; `\d` template-literal escape bug in passcode pattern fixed

## Notable adjudications (harness expectations updated, not product bugs)
- `paid="abc"` → now clean 400 "Invalid paid amount" (test previously expected SQL error → now expects reject ✓)
- `1e309` sale price → JSON serializes Infinity as null → absent-field fallback (finite) is correct behavior
- Bill-wise report includes cancelled rows (audit completeness) — count check compares non-cancelled subset
- GST summary field is `total_gst` (matches DB exactly: 196167.86)
- Item delete with history now intentionally 400 (prevents `invoice_items` orphans)

## Final reconciliation (t2, all PASS)
Opening 100 + Purchases 50 − Sales 30 + SalesReturn 5 − PurchReturn 10 + Adj +3 − Damage 2 = **116** — stock, stock ledger, and stock-movement report all show 116. Net sales/COGS/profit cross-checked against P&L. 12 concurrent sales → 12 unique invoice numbers, exact stock decrement. Sequential invoice numbering gapless; no reuse after delete.

## Residual notes (not bugs, or low risk)
- `data/pos.db` schema migrates automatically on next app start (ALTERs + payments rebuild if `party_id NOT NULL` present) — verified on copies.
- LIKE-search wildcard escaping now means `%` search returns 0 items (by design).
- Single-process app: running web+desktop simultaneously would race the file save — inherent to sql.js file model, documented.
- Login hint text retained for first-run onboarding; forced `must_change_password` flow still in place.
- Performed in scratch copies only; `data/pos.db` byte-identical to session start.
