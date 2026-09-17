// MartPOS desktop entry point (Electron).
// Runs the Express app in-process on an ephemeral port and shows it in a
// native window - no console, no browser chrome, no external browser.
const path = require('path');
const fs = require('fs');
const electronModule = require('electron');

// If ELECTRON_RUN_AS_NODE is set in the environment, the Electron binary
// starts in plain-Node mode and require('electron') returns a path string
// instead of the API. Respawn once with the variable removed - otherwise the
// app would silently fail on machines where that variable is set globally.
if (typeof electronModule === 'string') {
  if (!process.env.MARTPOS_RELAUNCHED) {
    const env = { ...process.env, MARTPOS_RELAUNCHED: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const { spawnSync } = require('child_process');
    const res = spawnSync(process.execPath, [__dirname], {
      env,
      stdio: 'inherit',
      windowsHide: true
    });
    process.exit(res.status == null ? 0 : res.status);
  }
  // Relaunch did not restore Electron mode - nothing more we can do.
  process.exit(1);
}

const { app: electronApp, BrowserWindow, Menu, dialog, ipcMain, session, shell } = electronModule;

// ---- file logging (must be set up before server.js is required) ----
const { getDataDir } = require('./lib/paths');
const logDir = require('./lib/logger').installFileLogging();
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason instanceof Error ? reason : new Error(String(reason)));
});

console.log('MartPOS starting');

// First-run data adoption: if this packaged build finds no database in the
// app data dir, adopt a data set left next to the executable by an older
// build (portable exe, server-mode exe or a repo install). Copy only - the
// legacy files are never moved or deleted, existing data is never
// overwritten, and every copied file is size-verified. Idempotent: a
// present pos.db means there is nothing to adopt, so later launches are
// a no-op. Under MSIX the exe dir is read-only - this only reads from it.
function copyIfMissing(src, dest) {
  try {
    if (!fs.existsSync(src) || fs.existsSync(dest)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    if (fs.statSync(src).size !== fs.statSync(dest).size) {
      // Never leave a half-copied file where the app would trust it.
      try { fs.renameSync(dest, `${dest}.migration-failed`); } catch (_) { /* best effort */ }
      console.error(`Migration: ${path.basename(src)} copied incompletely - skipped`);
      return false;
    }
    console.log(`Migrated ${path.basename(src)} from legacy data folder`);
    return true;
  } catch (e) {
    console.error(`Migration: could not copy ${path.basename(src)}:`, e.message);
    return false;
  }
}

function migrateLegacyData() {
  try {
    if (!electronApp.isPackaged) return;
    const dataDir = getDataDir();
    const legacyDir = path.join(path.dirname(process.execPath), 'data');
    if (legacyDir === dataDir || !fs.existsSync(legacyDir)) return;
    if (fs.existsSync(path.join(dataDir, 'pos.db'))) return;
    if (!fs.existsSync(path.join(legacyDir, 'pos.db'))) return;

    if (!copyIfMissing(path.join(legacyDir, 'pos.db'), path.join(dataDir, 'pos.db'))) return;

    // Companion files that travel with the database - first run wins, so a
    // partially-populated data dir is still respected file by file.
    for (const name of ['secrets.json', 'credentials.json', 'token.json', 'session-secret.txt']) {
      copyIfMissing(path.join(legacyDir, name), path.join(dataDir, name));
    }
    // Local backups keep the adopted database recoverable.
    const legacyBackups = path.join(legacyDir, 'backups');
    try {
      if (fs.existsSync(legacyBackups)) {
        for (const f of fs.readdirSync(legacyBackups)) {
          if (f.toLowerCase().endsWith('.db')) {
            copyIfMissing(path.join(legacyBackups, f), path.join(dataDir, 'backups', f));
          }
        }
      }
    } catch (e) {
      console.error('Migration: could not copy legacy backups:', e.message);
    }
    console.log('Legacy data adoption complete');
  } catch (e) {
    console.error('Data migration failed:', e);
  }
}
migrateLegacyData();

// Ask the server for an ephemeral port (0 = OS picks a free one)
if (!process.env.PORT) {
  process.env.PORT = '0';
}

const { startServer } = require('./server');
const { flushSave } = require('./lib/database');
const updater = require('./lib/updater');

// Forward updater status changes to the renderer. Everything the UI knows
// about updates comes through this channel - renderer code never touches
// electron-updater directly.
function pushUpdateStatus(status) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('martpos:update:event', status);
    }
  } catch (_) {
    // Status delivery is best-effort only.
  }
}

// IPC + menu wiring for the update service. Called once after the backend
// is up so lib/settings (DB-backed preferences) can be read safely.
function initUpdater() {
  ipcMain.handle('martpos:update:status', () => updater.getStatus());
  ipcMain.handle('martpos:update:check', () => updater.checkForUpdates());
  ipcMain.handle('martpos:update:download', () => updater.downloadUpdate());
  ipcMain.handle('martpos:update:install', async () => {
    // Explicit confirmation: the app must never close mid-sale.
    const status = updater.getStatus();
    if (status.phase !== 'downloaded') return status;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Restart Now', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Restart MartPOS',
      message: `Install MartPOS ${status.newVersion || 'update'}?`,
      detail: 'MartPOS will close, install the update, and reopen. Finish any bill in progress first - the app closes immediately.'
    });
    if (response !== 0) return status;
    try { flushSave(); } catch (e) { console.error('Flush before update failed:', e); }
    updater.quitAndInstall();
    return updater.getStatus();
  });
  updater.init({ onStatus: pushUpdateStatus });

  // Help menu (Alt reveals the menu bar - autoHideMenuBar is on). Packaged
  // builds only; dev keeps the default Electron menu with devtools.
  if (electronApp.isPackaged) {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
          { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
        ]
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Check for Updates',
            click: () => updater.checkForUpdates()
          }
        ]
      }
    ]);
    Menu.setApplicationMenu(menu);
  }
}

let mainWindow = null;
let backendPort = 0;
const appOrigin = () => `http://127.0.0.1:${backendPort}`;
const appIcon = path.join(__dirname, 'build', 'icon.png');

// Child windows (invoice PDF preview, report print-outs) get the same locked
// down preferences as the main window.
function childWindowOptions() {
  return {
    autoHideMenuBar: true,
    title: 'MartPOS',
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !electronApp.isPackaged
    }
  };
}

const gotLock = electronApp.requestSingleInstanceLock();
if (!gotLock) {
  // Second launch - hand off to the already-running instance and exit
  console.log('Second instance requested - exiting');
  electronApp.quit();
} else {
  electronApp.setAppUserModelId('com.martpos.app');

  electronApp.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  electronApp.whenReady().then(async () => {
    // Permission policy: the POS only needs camera access for the barcode
    // scanner, and only from our own origin. Everything else is denied.
    const isAppUrl = (url) => {
      try {
        return new URL(url).origin === appOrigin();
      } catch (_) {
        return false;
      }
    };
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      callback(permission === 'media' && isAppUrl(wc.getURL()));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
      return permission === 'media' &&
        (isAppUrl(requestingOrigin || '') || isAppUrl(wc ? wc.getURL() : ''));
    });

    let port;
    try {
      port = await startServer();
      backendPort = port;
    } catch (error) {
      console.error('MartPOS backend failed to start:', error);
      dialog.showErrorBox(
        'MartPOS failed to start',
        'The POS backend could not be started.\n\n' +
        `Details: ${error.message || error}\n\n` +
        `Technical details were written to:\n${logDir || 'the system temp folder'}`
      );
      electronApp.quit();
      return;
    }
    console.log(`Backend ready on port ${port}`);

    mainWindow = new BrowserWindow({
      width: 1366,
      height: 840,
      minWidth: 1024,
      minHeight: 700,
      title: 'MartPOS',
      icon: appIcon,
      autoHideMenuBar: true,
      show: false,
      backgroundColor: '#f4f6f8',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        devTools: !electronApp.isPackaged
      }
    });

    // Report printing uses window.open() against our own origin (or
    // about:blank) - allow those as native child windows. Anything external
    // is denied: the POS never leaves its own window set.
    // /invoice_pdf is served as an attachment (download). Electron has no
    // built-in PDF viewer, so instead of a dead window we download it via
    // the app session (which carries the login cookie) and open it in the
    // system's PDF viewer.
    session.defaultSession.on('will-download', (_e, item) => {
      let dir;
      try {
        dir = electronApp.getPath('downloads');
      } catch (_) {
        dir = path.join(getDataDir(), 'invoices');
        fs.mkdirSync(dir, { recursive: true });
      }
      const file = path.join(dir, item.getFilename());
      item.setSavePath(file);
      item.once('done', (_ev, state) => {
        if (state === 'completed') {
          console.log(`Invoice PDF saved to ${file}`);
          shell.openPath(file).then(err => {
            if (err) console.error('Failed to open invoice PDF:', err);
          });
        } else {
          console.error(`Invoice PDF download ${state}`);
        }
      });
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isAppUrl(url)) {
        try {
          if (new URL(url).pathname === '/invoice_pdf') {
            mainWindow.webContents.downloadURL(url);
            return { action: 'deny' };
          }
        } catch (_) { /* fall through to allow */ }
        return { action: 'allow', overrideBrowserWindowOptions: childWindowOptions() };
      }
      if (url === '' || url === 'about:blank') {
        return { action: 'allow', overrideBrowserWindowOptions: childWindowOptions() };
      }
      console.log(`Blocked external window.open: ${url}`);
      return { action: 'deny' };
    });

    // The main window must never navigate away from the POS.
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!isAppUrl(url)) {
        console.log(`Blocked navigation to: ${url}`);
        event.preventDefault();
      }
    });

    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.error('Renderer crashed:', JSON.stringify(details));
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.loadURL(`${appOrigin()}/`);

    // Updater is initialized only after the backend and window are ready -
    // it can never delay or block POS startup.
    initUpdater();
  });

  // Flush the database file before exiting so no sale is lost. When the
  // owner chose "at application close" backups, run one best-effort Drive
  // upload first (30s cap so shutdown can never hang).
  let exitBackupAttempted = false;
  electronApp.on('before-quit', (event) => {
    console.log('MartPOS shutting down');
    try {
      flushSave();
    } catch (e) {
      console.error('Database flush on quit failed:', e);
    }

    // When quitAndInstall is running, quitting must not be intercepted -
    // preventing the quit would silently cancel the update install.
    if (updater.isInstallingUpdate()) return;

    if (exitBackupAttempted) return;
    exitBackupAttempted = true;
    try {
      const { getSetting } = require('./lib/settings');
      const { tokenPresent, tryAutoBackup } = require('./lib/driveSync');
      if (getSetting('drive_auto_backup', '0') === '1' &&
          getSetting('drive_backup_interval', 'daily') === 'on_exit' &&
          tokenPresent()) {
        event.preventDefault();
        const finish = () => electronApp.quit();
        const timeout = setTimeout(finish, 30000);
        tryAutoBackup()
          .then((r) => {
            if (r && r.ok) console.log('Exit backup uploaded to Google Drive');
            else console.error('Exit backup failed:', r && r.error);
          })
          .catch((e) => console.error('Exit backup failed:', e))
          .finally(() => {
            clearTimeout(timeout);
            finish();
          });
      }
    } catch (e) {
      console.error('Exit backup check failed:', e);
    }
  });

  electronApp.on('window-all-closed', () => {
    electronApp.quit();
  });
}
