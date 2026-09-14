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
npm run build
```

Produces in `dist-app\`:

- `MartPOS-Setup-<version>.exe` — NSIS installer (per-user install, Start Menu + desktop shortcuts, uninstaller)
- `MartPOS-Portable-<version>.exe` — single portable exe, no install needed
- `win-unpacked\MartPOS.exe` — the unpacked app for testing

The installer never touches shop data in `%LOCALAPPDATA%\MartPOS\`, so reinstalls, upgrades and uninstalls keep invoices, settings, secrets and backups. App files and shop data are fully separated, so a future auto-updater can replace the program without ever touching `pos.db`, `backups\`, `secrets.json`, `token.json` or settings.

On a fresh PC: run the setup, launch MartPOS, log in with `admin` / `admin`. To carry over an existing shop's data, copy `data\pos.db` into `%LOCALAPPDATA%\MartPOS\pos.db` or use Google Drive backup/restore. A `pos.db` left in a `data\` folder next to the exe is adopted automatically on first launch.

### Code signing (optional)

The Windows build is ready for Authenticode signing — no config changes needed:

1. Obtain a code-signing certificate (`.pfx`/`.p12`) from a CA.
2. Set the standard electron-builder environment variables before building:
   - `CSC_LINK` — path or base64 of the certificate file
   - `CSC_KEY_PASSWORD` — certificate password
   - (Windows-only alternates `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` also work)
3. Run `npm run build`. With the variables set, `MartPOS-Setup-*.exe` and the app exe are signed; without them, an unsigned build is produced as before.

Never commit the certificate or its password to this repository.

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

## WhatsApp billing (Twilio)

Bills can be sent to customers on WhatsApp through the **Twilio WhatsApp Business API** (official API — WhatsApp Web automation is not supported).

1. Get a WhatsApp sender from Twilio (sandbox or an approved WhatsApp Business number).
2. Settings → **WhatsApp billing**: enter the shop's WhatsApp number and the Twilio **Account SID**, **Auth Token**, and **sender number**. Credentials are stored encrypted in the app data folder and are never returned by the API.
3. Use **Test connection** to verify credentials, **Send test** to send a test message to the shop (or an explicit test) number. At the POS, tick **Send bill on WhatsApp** before charging — or enable **Automatically send WhatsApp bill after sale**. Any saved invoice can be resent from the Sales list, which also shows the last delivery status (✓ Sent / ✗ Failed) per bill.

A WhatsApp failure never affects the sale — the bill stays saved and can be resent. Media/PDF attachments need a public URL, so the bill is sent as formatted text; very large bills are summarized so the message always fits WhatsApp limits.

A public hosted website cannot use the shop owner’s Drive until that owner completes OAuth on that same machine.

## Environment variables

- `FLASK_SECRET_KEY` — session secret (set this in production)
- `MARTPOS_DATA_DIR` — override where `pos.db`, Drive tokens and encrypted secrets are stored
- `PORT` — web server port (default 5000)
- Optional WhatsApp via Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (fallback only — prefer Settings → Cloud & communication)

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
