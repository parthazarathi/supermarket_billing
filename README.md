# Mart POS (Vyapar-style billing)

One app for the shop counter: **Windows EXE** or a **web browser**. Bills, stock, parties, purchases, expenses, and reports are stored in a **local SQLite** database. You can **back up and restore** that file to **Google Drive**.

## Quick start (web)

```powershell
npm install
npm start
```

Open `http://127.0.0.1:5000`

Default login: **admin** / **admin** (change this in Settings).

### Development

```powershell
npm run lint    # Run ESLint
```

## Desktop app (Electron)

MartPOS ships as a standalone Windows desktop app. Double-clicking `MartPOS.exe` opens a native window — no console, no browser, no separate Node.js install. The Express backend runs inside the app on a random local port and the UI is served straight into the window.

Run the desktop app in development:

```powershell
npm run desktop
```

Build the production app:

```powershell
$env:MARTPOS_CLOUD_URL="https://gateway.your-domain.example"
npm run build
```

`MARTPOS_CLOUD_URL` bakes the gateway origin (URL only — never Meta secrets) into
`generated/platform-config.json`, which is packaged inside the installer and
portable exe. Shop owners never set an environment variable; the deployed app
connects to the gateway automatically. For server-mode deployments the operator
may instead set the variable at runtime, or bake it the same way via
`npm run build:server-exe`.

Produces in `dist-app\`:

- `MartPOS-Setup-<version>.exe` — NSIS installer (per-user install, Start Menu + desktop shortcuts, uninstaller)
- `MartPOS-Portable-<version>.exe` — single portable exe, no install needed
- `win-unpacked\MartPOS.exe` — the unpacked app for testing

The installer never touches shop data in `%LOCALAPPDATA%\MartPOS\`, so reinstalls, upgrades and uninstalls keep invoices, settings, secrets and backups. App files and shop data are fully separated, so a future auto-updater can replace the program without ever touching `pos.db`, `backups\`, `secrets.json`, `token.json` or settings.

On a fresh PC: run the setup, launch MartPOS, log in with `admin` / `admin`. To carry over an existing shop's data, copy `data\pos.db` into `%LOCALAPPDATA%\MartPOS\pos.db` or use Google Drive backup/restore. A `pos.db` left in a `data\` folder next to the exe is adopted automatically on first launch.

### Code signing

The Windows build is ready for Authenticode signing — no config changes needed.

> **Why it matters:** Windows 11 **Smart App Control** (Windows Security →
> App & browser control) *blocks unsigned executables entirely* — including
> the unsigned `MartPOS.exe` this repo produces and the uninstaller-signing
> step inside `npm run build` (it fails with `spawn UNKNOWN`). Signed builds
> are required for Smart App Control and to avoid SmartScreen warnings on
> customer machines.

1. Obtain a code-signing certificate from a CA (Sectigo, DigiCert, SSL.com,
   Certum, etc.):
   - **OV certificate** (`.pfx`/`.p12` file) — cheaper, issues in days; builds
     SmartScreen/Smart App Control reputation over time.
   - **EV certificate** (hardware token, stored in Windows cert store) —
     instant SmartScreen reputation; the token must be plugged in to sign.
2. For a PFX file, set the standard electron-builder environment variables
   before building:
   - `CSC_LINK` — path or base64 of the certificate file
   - `CSC_KEY_PASSWORD` — certificate password
   - (Windows-only alternates `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` also work)
3. For an EV token / cert already in the Windows certificate store, set:
   - `WIN_CSC_NAME` — the certificate's subject name (e.g. `Your Company Name`)
4. Run `npm run build`. With signing configured, `MartPOS-Setup-*.exe`,
   `MartPOS-Portable-*.exe` and the app exe are signed; without it, an
   unsigned build is produced as before.

Never commit the certificate or its password to this repository.

**Unsigned builds:** on machines without Smart App Control, unsigned builds
still run (SmartScreen "More info → Run anyway"). If Smart App Control is On,
only signed builds run — the dev path `npm run desktop` always works because
the Electron binary itself is allowed.

### Automatic updates

The installed NSIS build updates itself via `electron-updater` + GitHub Releases — no reinstall, no manual download for the shop owner.

- **Where it checks:** `parthazarathi/supermarket_billing` releases (baked into `resources/app-update.yml` at build time from the `publish` block in `package.json`).
- **Flow:** on startup (+ every 4 h) the app checks `latest.yml` on the newest GitHub release → notifies in Settings → downloads in the background → installs only when the owner clicks **Restart & Update** (or closes the app normally). It never force-restarts mid-sale, and a failed check never affects billing.
- **UI:** Settings → *Application update* card shows version, status, release notes, download progress and the two auto check/download toggles. Help → *Check for Updates* works too (Alt shows the menu bar).
- **Portable exe:** detected via `PORTABLE_EXECUTABLE_DIR`; shows "download the latest portable version manually" instead of updating.
- **Dev mode:** `npm run desktop` / `npm run dev` never contact the update channel — updates only run in packaged builds.
- **Data safety:** updates replace only program files. `pos.db`, `backups\`, `secrets.json`, tokens and settings in `%LOCALAPPDATA%\MartPOS\` are untouched, and a `pre-migration-*.db` backup is written before any schema migration runs.

#### Release procedure — pushing an update to users (e.g. shipping 1.0.1)

**1. Finish and commit the changes**

```powershell
npm run lint
npm run test:whatsapp; npm run test:updater
git add -A; git commit -m "..."
git push
```

**2. Bump the version** — `package.json` is the single source of truth:

```powershell
npm version 1.0.1 --no-git-tag-version   # or: npm version patch / minor / major
```

**3. Build**

```powershell
# include only when the WhatsApp gateway is live for this release:
$env:MARTPOS_CLOUD_URL="https://gateway.your-domain.example"
npm run build
```

Produces in `dist-app\`: `MartPOS-Setup-1.0.1.exe`, `.exe.blockmap`, `MartPOS-Portable-1.0.1.exe`, `latest.yml`.

**4. Smoke-test locally (recommended)** — run `MartPOS-Setup-1.0.1.exe` on a test PC, open a bill, confirm Settings → *Application update* shows `1.0.1`. To verify the update loop itself, serve `dist-app\` on localhost and launch the installed previous version with `MARTPOS_UPDATE_SERVER_URL=http://127.0.0.1:8787`.

**5. Create the GitHub release** — `github.com/parthazarathi/supermarket_billing` → *Releases → Draft a new release*:

- Tag `v1.0.1`, title `Mart POS 1.0.1`
- Description = release notes as bullets (the app shows them under "What's new")
- Attach **all four files** from `dist-app\`:

| File | Required? | Why |
|---|---|---|
| `latest.yml` | **yes — critical** | the update manifest the app polls |
| `MartPOS-Setup-1.0.1.exe` | yes | the update payload + new installs |
| `MartPOS-Setup-1.0.1.exe.blockmap` | recommended | enables small differential downloads |
| `MartPOS-Portable-1.0.1.exe` | recommended | portable users download manually |

- **Publish release** (drafts are not checked by clients)

**6. Done — users update themselves.** Every installed POS ≥1.0.0 picks it up within ~4 hours of next launch: *Update available → Update Now → downloads in background → Restart & Update → running 1.0.1.* No uninstalling, no data migration, `pos.db` untouched.

**Optional — one-command publishing.** With `GH_TOKEN` (a PAT with `repo` scope) in the environment, step 5's manual upload can be automated:

```powershell
$env:GH_TOKEN="ghp_..."
electron-builder --win nsis portable --publish always
```

Review the created draft before publishing, and never commit the token.

**Rollback:** delete the bad release on GitHub — clients just stay on the last good version. Ship the fix as a *new* version (1.0.2); never re-upload artifacts under an existing tag because `latest.yml` is cached by clients.

#### Custom / future update server

Point installs at any `latest.yml`-compatible feed without rebuilding the updater — either change the `publish` block in `package.json` (generic provider), or set `MARTPOS_UPDATE_SERVER_URL=https://updates.example.com/martpos` before launch (loopback `http://127.0.0.1` is permitted for QA only). `lib/updateFeed.js` is the single seam for this.

### Legacy server-mode EXE (browser)

The old `pkg` build — a console exe that serves MartPOS to a web browser — is still available for multi-till/browser deployments:

```powershell
npm run build:server-exe        # dist\MartPOS-Server.exe
npm run build:server-installer  # dist\MartPOS-Server-Setup-<version>.exe (Inno Setup)
```

## What you get

- **POS:** barcode / search / product tiles, cart, GST (CGST+SGST or IGST), Cash / UPI / Card, hold bill, PDF invoice, optional WhatsApp
- **Items & stock**, **customers & suppliers**, **sales & returns**, **purchases**, **expenses**
- **Advanced Billing Features:**
  - **Estimates/Quotations:** Create price quotes, convert to invoices
  - **Delivery Challans:** Track goods delivery without billing
  - **Credit/Debit Notes:** Handle returns and adjustments
  - **Purchase Orders:** Manage supplier orders
  - **Bank/Cash Accounts:** Track multiple accounts and transactions
  - **Credit Limits:** Set credit limits for customers with automatic checks
- **Enhanced Party Management:** Full address details, GSTIN, PAN, billing addresses
- **Reports:** sales, purchases, expenses, simple P&L (sales − cost of goods − expenses − returns)
- **Users:** admin, manager, cashier
- **UPI QR** from your UPI ID in Settings

## Backups (local + Google Drive)

MartPOS keeps **two independent backups**:

- **Local** — snapshots in `<data dir>\backups\` (e.g. `%LOCALAPPDATA%\MartPOS\backups\MartPOS-backup-2026-09-14-183000.db`). Taken automatically (daily by default, configurable) and manually from Settings → Local backup → **Create backup**. The last 30 snapshots are kept.
- **Google Drive** — uploads to `MartPOS Backups/YYYY/MM/YYYY-MM-DD/` on the connected Drive plus a `latest.db` at the folder root. Drive backups are never auto-deleted.

Every snapshot is **validated before it is saved or uploaded** (opens as a database, has the core tables, passes an integrity check) — a corrupt export is never counted as a backup. Every attempt is recorded in **Settings → Backups & restore → History** with date, type, location, status and size.

**Restore is a two-step safe flow**: pick a backup → MartPOS validates it and shows its details → confirm → a `pre-restore-*.db` safety copy of the current database is taken → the database is swapped and the app returns to login. If anything fails, your current data is untouched.

### Google Drive setup

This is backup/restore of the local database, not live two-way sync.

1. In [Google Cloud Console](https://console.cloud.google.com/) create a project, enable **Google Drive API**, and create an OAuth client of type **Desktop app**.
2. Download `credentials.json` into the app data folder:
   - Web/dev: `data\credentials.json`
   - EXE: `%LOCALAPPDATA%\MartPOS\credentials.json`
3. Settings → **Connect Google Drive** — the system browser opens for Google sign-in and returns to MartPOS automatically. The connected account's email is shown in Settings.
4. Turn on **automatic Google Drive backup** in Settings and pick a frequency (every 6 hours, every day, or at application close). A failed backup never blocks a sale.

**Disconnect** revokes access and stops automatic backup; existing Drive backups and local data are kept.

## WhatsApp billing (Meta Cloud API)

Bills are sent to customers on WhatsApp through the **WhatsApp Business Platform (Meta Cloud API)** via the MartPOS gateway — an official API; WhatsApp Web automation is not supported. The POS never stores Meta credentials; it only holds an encrypted device token linked to the shop's MartPOS owner account.

### Owner setup (7 steps)

1. Open **Settings → WhatsApp Billing** and click **Connect WhatsApp**.
2. **Create owner account** or **Sign in** with your MartPOS account email and password (new accounts also enter the shop name). This securely links this POS to your shop — no technical details are needed.
3. A browser window opens Meta's secure setup. Choose your business and the WhatsApp number to send bills from.
4. The MartPOS setup page asks for your **6-digit WhatsApp security PIN** as part of onboarding — for an existing WhatsApp Business number use the PIN you already set; for a new number choose any memorable 6 digits.
5. Close the browser tab when the setup page confirms success — MartPOS notices automatically within a few seconds.
6. Back in Settings the card shows **✓ WhatsApp Connected** with your business name and masked number. Click **Send Test Bill** to check delivery.
7. Tick **Automatically send bills on WhatsApp after sale**, or use the **Send bill on WhatsApp** checkbox per sale.

A WhatsApp failure never affects a sale — the bill stays saved and queued bills retry automatically when the connection returns. The Sales list has a dedicated **WhatsApp** column (⏳ Sending… / ✓ Sent / ✓ Delivered / ✓ Read / ✗ Failed); click it for delivery details and retry.

### Architecture

```
POS (this app)  ──HTTPS──>  MartPOS gateway (Express + PostgreSQL)  ──>  Meta Graph API
      ▲                           ▲                                        │
      └────── status updates ─────┴──────── webhooks (HMAC-verified) ──────┘
```

- The POS stores only an **opaque device token** (AES-256-GCM / Windows DPAPI in the desktop app). Meta app secrets and access tokens exist only on the gateway, encrypted with `GATEWAY_ENCRYPTION_KEY`.
- Every gateway call carries the device token; the gateway derives the shop from the token hash — tenant ids are never accepted from request bodies.
- Sends are **durable and offline-tolerant**: the POS enqueues into a local queue and returns immediately; a background worker forwards to the gateway (infinite retry, ≤30 min backoff, permanent 4xx failures marked failed). The gateway holds its own PostgreSQL queue (`FOR UPDATE SKIP LOCKED`, 3 Meta attempts, 30s/2m backoff) and polls delivery via webhooks.
- Status flows back through `GET /v1/whatsapp/messages/updates` using a lossless `(updated_at, id)` cursor.

### Deploying the gateway (PostgreSQL)

```powershell
cd gateway
npm ci               # reproducible install from the committed lockfile
createdb martpos_gateway
psql -d martpos_gateway -f schema.sql   # schema migration must run first
# set the env vars below, then:
npm start            # or: npm run gateway:start from repo root
# production (process manager):
pm2 start src/index.js --name martpos-gateway
```

Required gateway env vars: `DATABASE_URL`, `GATEWAY_PUBLIC_URL` (public `https://` URL), `GATEWAY_ENCRYPTION_KEY` (base64, 32 bytes), `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`, `META_WEBHOOK_VERIFY_TOKEN`. Optional: `PORT` (default 8080), `META_GRAPH_API_VERSION` (defaults to **v26.0**), `GATEWAY_TRUST_PROXY` (`false`/`0` or hops `1`–`5`, default `1`), `GATEWAY_SUPPORT_USERNAME` + `GATEWAY_SUPPORT_PASSWORD_HASH` (bcrypt) for `/support` and `/v1/support/*`.

### Meta app requirements

- **Embedded Signup v4**: the gateway hosts the signup page at `/onboarding/:token`; the POS opens it via `POST /api/whatsapp/connect`. The Meta app needs an Embedded Signup configuration id (`META_EMBEDDED_SIGNUP_CONFIG_ID`).
- **App Review / Tech Provider**: production onboarding requires the Meta app to be approved as a Tech Provider (or the shop onboarded under your own WABA). This repository does not include or claim any Meta approval.
- **Webhook**: point Meta at `POST {GATEWAY_PUBLIC_URL}/webhooks/meta` with verify token `META_WEBHOOK_VERIFY_TOKEN`. HTTPS is required; `X-Hub-Signature-256` is verified with the app secret before the body is parsed.
- **Template approval**: the gateway creates a `mart_pos_invoice` UTILITY template (text-only body with examples — approvable without a resumable-upload sample handle) and records Meta's reported status. Messages are only sent while the stored status is `APPROVED`; approval is never claimed by the app.
- **PDF header limitation**: sending the invoice PDF needs a media-header template that must be created and approved separately (document header requires a sample upload at approval time). The built-in default is text-only; a separately approved media template is detected automatically (`document_enabled` in status).

### Local development

```powershell
npm install                 # root deps
cd gateway && npm install   # gateway deps (npm ci also works)
# point the POS at a running gateway:
$env:MARTPOS_CLOUD_URL="http://127.0.0.1:8080"   # http allowed only for localhost dev/test
$env:MARTPOS_SECRET_KEY="<base64 32-byte key>"   # required outside the Electron app
npm start
npm run test:whatsapp       # unit suite - no real Meta/Postgres calls
npm run lint
```

### Production checklist

1. Deploy `gateway/` behind HTTPS with a real PostgreSQL `DATABASE_URL` and all required env vars — run `psql -f schema.sql` before first start.
2. Set `GATEWAY_PUBLIC_URL` to the public HTTPS origin and configure the Meta webhook URL + verify token.
3. `MARTPOS_CLOUD_URL` is provisioned by the MartPOS installer / deployment operator — the shop owner never types it. The desktop Electron app stores the device token with Windows **DPAPI** and does not need `MARTPOS_SECRET_KEY`; only standalone `node server.js` / pkg server mode requires that platform-level key for secret storage.
4. Owners connect via Settings → WhatsApp Billing (Embedded Signup) — no Meta credentials are ever typed into the POS.
5. Run both processes under a process manager, e.g. `pm2 start gateway/src/index.js --name martpos-gateway` for the gateway and `pm2 start server.js --name mart-pos` for a web-mode POS (the desktop app manages its own backend).

### Environment variable reference

| Variable | Where | Purpose |
|---|---|---|
| `FLASK_SECRET_KEY` | POS | session secret (set in production) |
| `MARTPOS_DATA_DIR` | POS | override data folder (pos.db, secrets, backups) |
| `PORT` | POS | local web port (default 5000) |
| `MARTPOS_CLOUD_URL` | POS | gateway base URL — deployment/build-operator config baked into packaged builds via `build:platform-config`, or set at runtime in server mode (https; localhost http only in dev/test) |
| `MARTPOS_SECRET_KEY` | POS | base64 32-byte key for secret storage when DPAPI is unavailable |
| `DATABASE_URL` | gateway | PostgreSQL connection string |
| `GATEWAY_PUBLIC_URL` | gateway | public HTTPS origin (onboarding links, webhook docs) |
| `GATEWAY_ENCRYPTION_KEY` | gateway | base64 32-byte key encrypting Meta access tokens |
| `META_APP_ID` / `META_APP_SECRET` | gateway | Meta app credentials |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | gateway | Embedded Signup configuration |
| `META_WEBHOOK_VERIFY_TOKEN` | gateway | webhook GET verification token |
| `META_GRAPH_API_VERSION` | gateway | Graph API version (default `v26.0`) |
| `META_GRAPH_BASE_URL` | gateway | test-only Graph base override (ignored outside `NODE_ENV=test`) |
| `GATEWAY_TRUST_PROXY` | gateway | proxy hops for client IPs (`false`/`0` or `1`–`5`, default `1`) |
| `GATEWAY_SUPPORT_USERNAME` / `GATEWAY_SUPPORT_PASSWORD_HASH` | gateway | Basic-auth credentials for `/support` |

### Current limitations

- The base POS supports single-method payments only (Cash / UPI / Card). Mixed or split-payment invoices are not modelled, so WhatsApp bill messaging covers single-method invoices only.
- WhatsApp delivery requires the `mart_pos_invoice` template to be APPROVED by Meta; while it is pending, queued bills report a friendly "not available yet" state instead of sending.

A public hosted website cannot use the shop owner’s Drive until that owner completes OAuth on that same machine.

## Production web

For production deployment, you can use process managers like PM2:

```powershell
npm install -g pm2
pm2 start server.js --name "mart-pos"
```

## Keyboard shortcuts (POS)

- `F2` — focus search / barcode box (USB scanners type here, then Enter)
- `F8` — charge / save bill
- `Escape` — clear cart
- `Arrow keys` — navigate product grid and payment options
- `Enter/Space` — select focused item or button
- `Tab` — navigate between form fields
