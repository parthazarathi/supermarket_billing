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

const { app: electronApp, BrowserWindow, dialog, session, shell } = electronModule;

// ---- file logging (must be set up before server.js is required) ----
const { getDataDir } = require('./lib/paths');
let logDir;
try {
  logDir = path.join(getDataDir(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
} catch (e) {
  // Data dir unusable (bad MARTPOS_DATA_DIR, permissions, etc.) - fall back
  // to %TEMP% so logging still works and startup can fail gracefully.
  try {
    logDir = path.join(require('os').tmpdir(), 'MartPOS', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
  } catch (_) {
    logDir = null;
  }
}
const logStream = logDir
  ? fs.createWriteStream(
    path.join(logDir, `martpos-${new Date().toISOString().slice(0, 10)}.log`),
    { flags: 'a' }
  )
  : null;
for (const method of ['log', 'info', 'warn', 'error']) {
  const orig = console[method].bind(console);
  console[method] = (...args) => {
    const line = args
      .map(a => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    try {
      if (logStream) {
        logStream.write(`${new Date().toISOString()} [${method.toUpperCase()}] ${line}\n`);
      }
    } catch (_) { /* logging must never crash the app */ }
    orig(...args);
  };
}
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason instanceof Error ? reason : new Error(String(reason)));
});

console.log('MartPOS starting');

// First-run data migration: if this packaged build finds no database in the
// app data dir, adopt a pos.db left next to the executable by an older build
// (portable exe or repo install). Copy only - the legacy file is never moved
// or deleted, and an existing database is never overwritten.
function migrateLegacyData() {
  try {
    if (!electronApp.isPackaged) return;
    const dbPath = path.join(getDataDir(), 'pos.db');
    if (fs.existsSync(dbPath)) return;
    const legacyPath = path.join(path.dirname(process.execPath), 'data', 'pos.db');
    if (fs.existsSync(legacyPath) && legacyPath !== dbPath) {
      fs.copyFileSync(legacyPath, dbPath);
      console.log(`Migrated existing database from ${legacyPath}`);
    }
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
  });

  // Flush the database file before exiting so no sale is lost
  electronApp.on('before-quit', () => {
    console.log('MartPOS shutting down');
    try {
      flushSave();
    } catch (e) {
      console.error('Database flush on quit failed:', e);
    }
  });

  electronApp.on('window-all-closed', () => {
    electronApp.quit();
  });
}
