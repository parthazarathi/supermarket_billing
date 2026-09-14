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

The installer never touches shop data in `%LOCALAPPDATA%\MartPOS\`, so reinstalls, upgrades and uninstalls keep invoices.

On a fresh PC: run the setup, launch MartPOS, log in with `admin` / `admin`. To carry over an existing shop's data, copy `data\pos.db` into `%LOCALAPPDATA%\MartPOS\pos.db` or use Google Drive backup/restore. A `pos.db` left in a `data\` folder next to the exe is adopted automatically on first launch.

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

## Google Drive backup

This is backup/restore of the local database, not live two-way sync.

1. In [Google Cloud Console](https://console.cloud.google.com/) create a project, enable **Google Drive API**, and create an OAuth client of type **Desktop app**.
2. Download `credentials.json` into the app data folder:
   - Web/dev: `data\credentials.json`
   - EXE: `%LOCALAPPDATA%\MartPOS\credentials.json`
3. Settings → **Connect**, sign in with Google, then **Backup now**.
4. Turn on **Auto backup after each sale** if you want a Drive copy after billing (internet required; a failed backup never blocks a sale).

Restore downloads a chosen backup and replaces the local `pos.db`. You will need to log in again.

A public hosted website cannot use the shop owner’s Drive until that owner completes OAuth on that same machine.

## Environment variables

- `FLASK_SECRET_KEY` — session secret (set this in production)
- `MARTPOS_DATA_DIR` — override where `pos.db` and Drive tokens are stored
- `PORT` — web server port (default 5000)
- Optional WhatsApp via Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`

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
