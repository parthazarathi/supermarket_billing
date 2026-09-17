// Automatic update service - Electron main process only.
//
// Wraps electron-updater behind a small state machine so the rest of the app
// never touches updater internals:
//   init({ onStatus })   wire events, apply feed overrides (call once, after
//                        the backend/database is up - never before app ready)
//   checkForUpdates()    manual or scheduled check; safe to call anytime
//   downloadUpdate()     start downloading the announced update
//   quitAndInstall()     restart and install the downloaded update
//   getStatus()          snapshot for IPC/status polling
//
// Safety properties:
//  - Only packaged NSIS installs can update; dev mode and portable builds are
//    reported as unsupported so they can never hit the production channel.
//  - The app NEVER restarts on its own: downloads happen in the background,
//    install only runs when the user confirms (quitAndInstall) or chooses to
//    close the app normally (autoInstallOnAppQuit).
//  - Every failure lands in a friendly status message; raw errors are logged
//    only. Billing keeps working no matter what the updater does.
//  - The updater only touches application files. Customer data lives in the
//    data dir (%LOCALAPPDATA%\MartPOS), which updates never modify.

// ---------- pure helpers (also unit-tested under plain Node) ----------

// Maps low-level updater/network errors to plain language. The raw error is
// logged for diagnostics; the UI only ever shows the friendly text.
function friendlyUpdateError(err) {
  const msg = String((err && err.message) || err || '');
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|socket hang up|network|fetch failed|ERR_INTERNET_DISCONNECTED/i.test(msg)) {
    return 'Unable to check for updates - no internet connection. You can keep billing normally.';
  }
  if (/403|401|unauthorized|forbidden/i.test(msg)) {
    return 'The update server refused the request. You can keep billing normally.';
  }
  if (/404|not found|no latest version|cannot find channel/i.test(msg)) {
    return 'No published update was found yet. You can keep billing normally.';
  }
  if (/signature|sha512|checksum|integrity|differential/i.test(msg)) {
    return 'The update package failed verification and was not installed. Your current version is safe.';
  }
  return 'Update check failed. You can keep billing normally.';
}

// electron-updater releaseNotes can be a markdown string or an array of
// {version, note}. Normalize to a short list of displayable lines.
function releaseNotesLines(releaseNotes) {
  if (!releaseNotes) return [];
  const raw = Array.isArray(releaseNotes)
    ? releaseNotes.map((n) => (n && n.note) || '').join('\n')
    : String(releaseNotes);
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[#>*\-\u2022]+\s*/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l.length > 0)
    .slice(0, 12);
}

const DEFAULT_STATE = {
  supported: false,      // packaged NSIS build with electron-updater
  portable: false,       // running from the portable exe
  msix: false,           // running from an MSIX/AppX package (Store-updated)
  phase: 'idle',         // idle|checking|available|not-available|downloading|downloaded|error
  currentVersion: '',
  newVersion: '',
  releaseNotes: [],
  progress: null,        // {percent, transferred, total, bytesPerSecond}
  message: '',
  checkedAt: null
};

const state = { ...DEFAULT_STATE };
let autoUpdater = null;
let emit = () => {};
let installing = false;
let checking = false;
let checkTimer = null;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // one re-check every 4 hours
const STARTUP_DELAY_MS = 15 * 1000;           // let the POS settle first

function setState(patch) {
  Object.assign(state, patch);
  try {
    emit({ ...state });
  } catch (_) {
    // Status delivery must never break the update flow.
  }
}

function autoCheckEnabled() {
  try {
    return require('./settings').getSetting('update_auto_check', '1') === '1';
  } catch (_) {
    return true;
  }
}

function autoDownloadEnabled() {
  try {
    return require('./settings').getSetting('update_auto_download', '1') === '1';
  } catch (_) {
    return true;
  }
}

function isPortableBuild() {
  // electron-builder portable exes always set this variable.
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}

// True when the app is running from an MSIX/AppX package. Packaged apps
// install under <ProgramFiles>\WindowsApps\<PackageFamilyName>\ - that
// directory is read-only to the app, so the NSIS self-update flow can
// never apply there. Updates for MSIX installs are managed by the
// Microsoft Store (or by sideloading a newer package), never in-app.
function isMsixInstall(exePath = process.execPath) {
  return /[\\/]WindowsApps[\\/]/i.test(String(exePath || ''));
}

function init({ onStatus } = {}) {
  if (autoUpdater) return getStatus();
  if (typeof onStatus === 'function') emit = onStatus;

  let app;
  try {
    ({ app } = require('electron'));
    ({ autoUpdater } = require('electron-updater'));
  } catch (_) {
    autoUpdater = null;
  }

  state.currentVersion = (() => {
    try { return app ? app.getVersion() : require('./version').appVersion(); }
    catch (_) { return ''; }
  })();
  state.portable = isPortableBuild();
  state.msix = isMsixInstall();
  state.supported = !!(autoUpdater && app && app.isPackaged && !state.portable && !state.msix);

  if (!state.supported) {
    state.phase = 'idle';
    state.message = state.msix
      ? 'Updates are managed by the Microsoft Store for this installation.'
      : state.portable
        ? 'Automatic updates are not available for the portable version. Download the latest portable version manually.'
        : 'Updates are only available in the installed MartPOS app.';
    emit({ ...state });
    return getStatus();
  }

  // We control the download explicitly so an update never interrupts work:
  // announce first, download in background, install only on user restart.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  try {
    const feed = require('./updateFeed').resolveUpdateFeed();
    if (feed.type === 'generic') {
      autoUpdater.setFeedURL({ provider: 'generic', url: feed.url, channel: feed.channel });
      console.log(`Updater: using custom update server ${feed.url}`);
    } else if (feed.type === 'github') {
      autoUpdater.setFeedURL({ provider: 'github', owner: feed.owner, repo: feed.repo });
      console.log(`Updater: using GitHub feed ${feed.owner}/${feed.repo}`);
    }
  } catch (e) {
    console.error('Updater: invalid feed override ignored -', e.message);
  }

  autoUpdater.on('checking-for-update', () => {
    setState({ phase: 'checking', message: '' });
  });
  autoUpdater.on('update-available', (info) => {
    setState({
      phase: 'available',
      newVersion: (info && info.version) || '',
      releaseNotes: releaseNotesLines(info && info.releaseNotes),
      progress: null,
      message: '',
      checkedAt: new Date().toISOString()
    });
    if (autoDownloadEnabled()) {
      downloadUpdate();
    }
  });
  autoUpdater.on('update-not-available', () => {
    setState({
      phase: 'not-available',
      newVersion: '',
      releaseNotes: [],
      progress: null,
      message: '',
      checkedAt: new Date().toISOString()
    });
  });
  autoUpdater.on('download-progress', (p) => {
    setState({
      phase: 'downloading',
      progress: {
        percent: Math.round((p && p.percent) || 0),
        transferred: (p && p.transferred) || 0,
        total: (p && p.total) || 0,
        bytesPerSecond: (p && p.bytesPerSecond) || 0
      }
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    checking = false;
    setState({
      phase: 'downloaded',
      newVersion: (info && info.version) || state.newVersion,
      releaseNotes: releaseNotesLines(info && info.releaseNotes).length
        ? releaseNotesLines(info && info.releaseNotes)
        : state.releaseNotes,
      progress: { percent: 100 },
      message: ''
    });
  });
  autoUpdater.on('error', (err) => {
    checking = false;
    console.error('Updater error:', err);
    setState({ phase: 'error', progress: null, message: friendlyUpdateError(err) });
  });

  // First check shortly after startup, then a light re-check every few
  // hours. Both are skipped entirely when the owner disables auto-check.
  checkTimer = setInterval(() => {
    if (autoCheckEnabled()) checkForUpdates();
  }, CHECK_INTERVAL_MS);
  if (checkTimer.unref) checkTimer.unref();
  setTimeout(() => {
    if (autoCheckEnabled()) checkForUpdates();
  }, STARTUP_DELAY_MS).unref?.();

  emit({ ...state });
  return getStatus();
}

async function checkForUpdates() {
  if (!state.supported) {
    emit({ ...state });
    return getStatus();
  }
  if (checking || state.phase === 'downloading' || state.phase === 'downloaded') {
    return getStatus();
  }
  checking = true;
  setState({ phase: 'checking', message: '' });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // The 'error' event usually fires first; ensure state still settles.
    checking = false;
    if (state.phase === 'checking') {
      setState({ phase: 'error', message: friendlyUpdateError(err) });
    }
  } finally {
    checking = false;
  }
  return getStatus();
}

async function downloadUpdate() {
  if (!state.supported) return getStatus();
  if (state.phase === 'downloading' || state.phase === 'downloaded') {
    return getStatus();
  }
  try {
    setState({ phase: 'downloading', progress: { percent: 0 } });
    await autoUpdater.downloadUpdate();
  } catch (err) {
    console.error('Update download failed:', err);
    setState({ phase: 'error', progress: null, message: friendlyUpdateError(err) });
  }
  return getStatus();
}

// Called from the before-quit handler so the shutdown path knows an update
// install is in progress (skip the optional exit backup, which would cancel
// quitAndInstall by preventing the quit).
function isInstallingUpdate() {
  return installing;
}

// Flushes the database via the caller, then installs silently and relaunches
// MartPOS. Only ever invoked after the user clicked "Restart & Update".
function quitAndInstall() {
  if (!state.supported || state.phase !== 'downloaded' || !autoUpdater) {
    return false;
  }
  installing = true;
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return true;
}

function getStatus() {
  return { ...state };
}

module.exports = {
  init,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  isInstallingUpdate,
  getStatus,
  friendlyUpdateError,
  releaseNotesLines,
  isMsixInstall
};
