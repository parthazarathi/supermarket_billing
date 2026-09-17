# MartPOS — Windows Distribution Guide

This document describes how MartPOS is packaged for Windows, where it stores
data at runtime, how to build the NSIS installer and the MSIX package, how
code signing works, and what remains to be done for Microsoft Store
submission.

---

## 1. Architecture

| Piece | Technology | Location |
|---|---|---|
| Desktop shell | Electron 44 (`electron-main.js`) | `dist-app/win-unpacked/MartPOS.exe` inside packages |
| Backend | Node.js + Express, runs **inside** the Electron process on an ephemeral loopback port (`http://127.0.0.1:<port>`) | `server.js`, `lib/` |
| Frontend | Static server-served UI | `templates/` (no React build step) |
| Database | sql.js (SQLite compiled to WASM), single file `pos.db` | `%LOCALAPPDATA%\MartPOS\pos.db` |
| Secrets | `lib/secrets.js` — Windows DPAPI via Electron `safeStorage`, AES-256-GCM fallback (`MARTPOS_SECRET_KEY`) | `%LOCALAPPDATA%\MartPOS\secrets.json` |
| Google Drive | `lib/driveSync.js` — OAuth Desktop app, loopback-IP redirect (RFC 8252) | `credentials.json` / `token.json` in the data dir |
| WhatsApp | `lib/whatsapp/` — MartPOS cloud gateway; device token in encrypted secrets | gateway URL from `generated/platform-config.json` or `MARTPOS_CLOUD_URL` |
| Updates | `lib/updater.js` — electron-updater + GitHub Releases, **NSIS only** | `latest.yml` on the GitHub release |
| Packaging | electron-builder 26.15.3 — targets `nsis`, `portable`, `appx` | `dist-app/` |

Distribution targets:

| Target | Artifact | Update mechanism |
|---|---|---|
| NSIS | `MartPOS-Setup-<ver>.exe` | electron-updater via GitHub Releases |
| Portable | `MartPOS-Portable-<ver>.exe` | manual download |
| AppX/MSIX | `MartPOS-<ver>.msix` | Microsoft Store / sideload re-install |

### MSIX note

electron-builder 26.x does not have a `msix` target name (it exists only in
the 27.x alphas). The `appx` target produces exactly the same MSIX package
format via `makeappx.exe`; this project emits it with a `.msix` file name.
The Microsoft Store accepts these packages.

---

## 2. Runtime data paths

All writable data lives under the per-user data directory — **never** inside
the installation directory, `resources/app.asar`, or `Program Files`.

| Mode | Data root |
|---|---|
| NSIS / MSIX / portable (frozen) | `%LOCALAPPDATA%\MartPOS` (`C:\Users\<user>\AppData\Local\MartPOS`) |
| Development (`npm start`) | `<repo>\data` |
| `pkg` server executable | `%LOCALAPPDATA%\MartPOS` (Windows) or `~/.martpos` |
| Override (all modes) | `MARTPOS_DATA_DIR` environment variable |

Layout (established — kept intentionally flat for backward compatibility):

```
%LOCALAPPDATA%\MartPOS
├── pos.db                 # SQLite database (sql.js)
├── secrets.json           # DPAPI/GCM-encrypted credentials store
├── credentials.json       # Google OAuth client credentials (user-provided)
├── token.json             # Google OAuth refresh token
├── session-secret.txt     # Express session secret
├── backups\               # local DB snapshots + restore staging source
├── logs\martpos-YYYY-MM-DD.log   # 14-day rolling logs (secrets redacted)
└── restores\              # staging area for Google Drive restores
```

Why `%LOCALAPPDATA%` rather than `app.getPath('userData')`
(`%APPDATA%`): the existing installs already store data under
`%LOCALAPPDATA%\MartPOS`, it is a per-user writable path for both NSIS and
MSIX contexts (verified — MSIX full-trust apps write to the real Local
AppData), it survives app uninstall, and it is not roamed to a domain
profile. Changing the root would orphan existing customer data.

Path resolution lives in `lib/paths.js`. The install directory is treated
as read-only everywhere; the only write attempt near the executable is the
legacy-migration *read* described below.

### Legacy data migration

`electron-main.js` → `migrateLegacyData()` runs once on packaged first
launch:

1. Skips when `pos.db` already exists in the data dir (idempotent — later
   launches are a no-op).
2. Looks for `<exe dir>\data\` — the data folder used by older portable /
   server-mode builds.
3. Copies `pos.db` first (size-verified; a failed copy is renamed
   `*.migration-failed`, never trusted).
4. Then adopts `secrets.json`, `credentials.json`, `token.json`,
   `session-secret.txt`, and `backups\*.db` — each only when the
   destination does not already have it.
5. Source files are never moved or deleted; every step is logged; any
   failure is logged and non-fatal.

Under MSIX the exe directory is read-only — migration only *reads* it.

### Data survival guarantees

| Event | Data |
|---|---|
| NSIS upgrade | kept (`deleteAppDataOnUninstall: false`) |
| NSIS uninstall | kept |
| MSIX upgrade / reinstall | kept (real `%LOCALAPPDATA%`, verified) |
| MSIX uninstall | kept |
| App update (electron-updater) | kept — user data is outside app files |

---

## 3. Building

Prereqs: Node 18+, `npm install`, Windows 10/11.

```bat
:: everything at once (nsis + portable + msix)
npm run build:win

:: just the NSIS installer + portable exe (unchanged legacy command)
npm run build            :: same as build:installer
npm run build:installer

:: just the MSIX package
npm run build:msix
```

Outputs land in `dist-app\`:

```
dist-app
├── MartPOS-Setup-1.0.0.exe        # NSIS installer
├── MartPOS-Portable-1.0.0.exe     # portable exe
├── MartPOS-1.0.0.msix             # MSIX package (AppX format)
├── MartPOS-Setup-1.0.0.exe.blockmap
├── latest.yml                     # electron-updater feed (NSIS)
└── win-unpacked\                  # unpacked app (debugging only)
```

`build-windows.js` / `build-msix.js` additionally resolve a modern
Windows SDK `signtool.exe` into `SIGNTOOL_PATH` — the signtool bundled
with electron-builder cannot sign `.appx`/`.msix` packages on current
Windows 11 builds (`A required function is not present`). An explicit
`SIGNTOOL_PATH` in the environment always wins.

`npm run build:appx-assets` regenerates the MSIX tile images in
`build/appx/` from the MartPOS icon (see §4).

---

## 4. Required icons / MSIX assets

`build/appx/` is produced by `build/make-appx-assets.js` from the same
renderer as `build/make-icon.js` — no external image tools needed.
Regenerate whenever `build/icon.png` changes.

| File | Size | Manifest slot |
|---|---|---|
| `StoreLogo.png` | 50×50 | Package logo (Store listing) |
| `Square44x44Logo.png` | 44×44 | Start-menu tile |
| `Square150x150Logo.png` | 150×150 | Medium tile |
| `Wide310x150Logo.png` | 310×150 | Wide tile |
| `SmallTile.png` / `Square71x71Logo.png` | 71×71 | Small tile |
| `LargeTile.png` / `Square310x310Logo.png` | 310×310 | Large tile |
| `SplashScreen.png` | 620×300 | Splash screen |

If any are missing, electron-builder injects its own *sample* tiles — the
generated set above prevents that. The Store additionally wants
marketing screenshots etc., configured in Partner Center, not the package.

---

## 5. Code signing

### Unsigned builds (default)

Running any build command without certificate env vars produces unsigned
artifacts. NSIS/portable still install (with SmartScreen warnings); the
MSIX **cannot be installed** — Windows requires a signed package.

### Self-signed certificate (local testing)

```powershell
# create once per machine
New-SelfSignedCertificate -Type Custom -KeyUsage DigitalSignature `
  -Subject "CN=MartPOS Dev" -CertStoreLocation "Cert:\CurrentUser\My" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
$pw = ConvertTo-SecureString -String 'choose-a-password' -Force -AsPlainText
Export-PfxCertificate -Cert "Cert:\CurrentUser\My\<thumbprint>" `
  -FilePath .\build\martpos-dev.pfx -Password $pw
```

A dev cert already exists at `build/martpos-dev.pfx` (`CN=MartPOS Dev`,
expires 2031, gitignored — never commit it). Its password lives only in
local config (`.devin/config.local.json`) — keep it out of Git and docs.

```bat
:: signed local build (cmd.exe)
set CSC_LINK=D:\Projects\Supermarket_Billing\build\martpos-dev.pfx
set CSC_KEY_PASSWORD=<cert password>
npm run build:msix
```

Sideload install of a self-signed package requires trusting the cert
first (deployment validates against **LocalMachine** stores — admin needed):

```powershell
# public cert only, once per test machine
Import-Certificate -FilePath .\martpos-dev.cer `
  -CertStoreLocation Cert:\LocalMachine\TrustedPeople
Add-AppxPackage .\dist-app\MartPOS-1.0.0.msix
```

Self-signed packages work on machines where you imported the cert — they
do **not** reduce SmartScreen warnings or satisfy the Store on other PCs.

### Production signing

Use standard electron-builder variables (documented in README too):

| Variable | Meaning |
|---|---|
| `CSC_LINK` / `WIN_CSC_LINK` | path or base64 of the `.pfx`/`.p12` |
| `CSC_KEY_PASSWORD` / `WIN_CSC_KEY_PASSWORD` | cert password |
| `WIN_CSC_NAME` | subject name of a cert already in the Windows store |
| `SIGNTOOL_PATH` | override signtool (auto-detected by our wrappers) |
| `MARTPOS_MSIX_PUBLISHER` | Partner Center Publisher DN for Store builds (below) |

Store the `.pfx` outside the repo (CI secret / secure vault). `.gitignore`
already excludes `*.pfx`, `*.p12`, `*.cer`, `*.key`.

### What signing does and does not do

- Required for MSIX install and Store submission.
- Establishes publisher identity; reduces — does **not** guarantee removal
  of — SmartScreen prompts (reputation builds over time; EV/OV certs help).
- The manifest `Publisher` is derived automatically from the certificate
  subject — never set `appx.publisher` statically, or a signed package
  will be rejected for publisher/cert mismatch.

---

## 6. Microsoft Store preparation

The generated `MartPOS-<ver>.msix` installs and runs (verified on Windows
11: package installs, launches, backend starts, data persists across
uninstall/reinstall). Remaining Store work is all Partner Center
metadata/config — **not** code:

1. **Reserve the app name** in Partner Center → get the assigned
   *Package/Identity/Name* (e.g. `12345Publisher.MartPOS`) and
   *Publisher* DN (`CN=AAAA...`).
2. Build a Store-bound package with those values:
   ```bat
   set MARTPOS_MSIX_IDENTITY_NAME=12345Publisher.MartPOS
   set MARTPOS_MSIX_PUBLISHER=CN=AAAAAAA-...-...
   set MARTPOS_MSIX_PUBLISHER_DISPLAY_NAME=<legal entity name>
   npm run build:msix
   ```
   (Store-bound packages are signed by Microsoft after upload; building
   unsigned with the right identity is acceptable — do not guess values.)
3. Fill Partner Center metadata: description, screenshots, category,
   age ratings, privacy policy URL, pricing.
4. Answer capability declarations: the manifest requests
   `runFullTrust` (auto, required for Electron), `internetClient(Server)`,
   `privateNetworkClientServer` (loopback backend + OAuth + Drive/
   WhatsApp calls) and `codeGeneration` (Chromium/WASM). These are normal
   desktop capabilities — declare them in the submission questionnaire.
5. **Version**: the manifest version is `package.json` version +
   `.0` (e.g. `1.0.0` → `1.0.0.0`). Bump `version` before every upload —
   Store uploads must be strictly higher than the previous.
6. Upload the `.msix` under Packages in the submission.

Store-managed updates then replace the in-app updater — see §7.

---

## 7. Auto-update behavior per install type

| Install | Mechanism |
|---|---|
| NSIS | electron-updater → GitHub Releases (Settings → "Check for updates"; download in background, install on confirm/quit) |
| Portable | manual only |
| MSIX | **Store-managed** — `lib/updater.js` detects `WindowsApps` installs (`isMsixInstall`) and reports "Updates are managed by the Microsoft Store" instead of attempting an in-place update (which would fail on the read-only package dir) |

Do not ship electron-updater feeds for MSIX — there is exactly one update
system per install type.

---

## 8. Google Drive configuration

- OAuth **Desktop** app credentials: `credentials.json` placed in
  `%LOCALAPPDATA%\MartPOS\` (Settings → Google Drive → Connect).
- The OAuth flow uses a loopback IP redirect (`http://127.0.0.1:<port>`,
  RFC 8252) with a system browser — works identically under NSIS/MSIX; no
  redirect-URI changes needed for packaging.
- Scope: `drive.file`; backups go to `MartPOS Backups/YYYY/MM/DD` +
  `latest.db` in the user's Drive. Local staging under `backups\` /
  `restores\` in the data dir.
- Never commit real `credentials.json`/`token.json` — `.gitignore` covers
  them; they are also never packaged (they live outside `files`).

## 9. WhatsApp configuration

- Bill sending goes through the MartPOS cloud gateway; only a **device
  token** is stored client-side (in encrypted `secrets.json`). Meta
  credentials stay on the gateway.
- Gateway URL: runtime `MARTPOS_CLOUD_URL`, or the value baked into
  `generated/platform-config.json` by `npm run build:platform-config`
  (run automatically by every build script).
- Plain-HTTP gateway URLs are rejected outside loopback dev/test.
- No WhatsApp Desktop dependency, no localhost URL dependency — behavior
  is identical in packaged builds.

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `A required function is not present` signing `.msix` | old bundled signtool — install the Windows 10/11 SDK or set `SIGNTOOL_PATH` (our wrappers auto-detect the newest SDK signtool) |
| `0x800B0109` installing msix | cert not trusted → import the *public* cert into `Cert:\LocalMachine\TrustedPeople` (admin), or the manifest Publisher ≠ cert subject |
| msix installs but data "lost" | look at `%LOCALAPPDATA%\MartPOS` — NSIS and MSIX share it; dev builds use `<repo>\data` instead |
| Updater says "managed by the Microsoft Store" | expected on MSIX installs |
| "AppX is not signed / Windows Store only build" | no cert configured — fine for local packaging; not installable |
| OAuth window never returns | firewall/AV blocking the loopback listener; check `logs\` for the redirect port |
| Corrupt/missing `pos.db` | recovery in `lib/database.js` restores newest valid `backups\*.db` automatically; check `*.corrupt` / `.restore` files in the data dir |

## 11. Release checklist

- [ ] bump `version` in `package.json` (drives all artifact names + MSIX version)
- [ ] `npm run lint` clean of errors
- [ ] `npm run test:updater` / `npm run test:whatsapp` pass
- [ ] `npm run build:win` produces all three artifacts
- [ ] sign with the production cert (`WIN_CSC_*`) — verify with
      `signtool verify /pa` on each artifact
- [ ] install NSIS build on a clean machine/user; verify data at
      `%LOCALAPPDATA%\MartPOS`
- [ ] install MSIX on a test machine; verify launch, POS, Drive connect
- [ ] for Store: `MARTPOS_MSIX_IDENTITY_NAME` + `MARTPOS_MSIX_PUBLISHER`
      set to Partner Center values; upload; complete metadata
- [ ] publish GitHub Release (uploads `latest.yml` + Setup exe for
      in-app updates of NSIS installs)
