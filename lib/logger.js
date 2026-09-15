// Shared file logging for MartPOS.
// Redirects console.log/info/warn/error into <data dir>/logs/martpos-YYYY-MM-DD.log
// while still echoing to the console. Used by both electron-main.js and the
// standalone `node server.js` mode; a guard prevents double installation.
//
// Nothing here ever throws - logging must not break the app.
const fs = require('fs');
const path = require('path');
const { redact } = require('./redact');

const KEEP_DAYS = 14;

function pruneOldLogs(logDir) {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(logDir)) {
      if (!/^martpos-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const p = path.join(logDir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch (_) { /* skip */ }
    }
  } catch (_) { /* best effort */ }
}

function installFileLogging() {
  if (global.__martposLoggingInstalled) return null;
  global.__martposLoggingInstalled = true;

  const { getDataDir } = require('./paths');
  let logDir;
  try {
    logDir = path.join(getDataDir(), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
  } catch (e) {
    // Data dir unusable (bad MARTPOS_DATA_DIR, permissions) - fall back to
    // the temp dir so logging still works and startup can fail gracefully.
    try {
      logDir = path.join(require('os').tmpdir(), 'MartPOS', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
    } catch (_) {
      logDir = null;
    }
  }
  if (!logDir) return null;

  pruneOldLogs(logDir);

  const logStream = fs.createWriteStream(
    path.join(logDir, `martpos-${new Date().toISOString().slice(0, 10)}.log`),
    { flags: 'a' }
  );

  for (const method of ['log', 'info', 'warn', 'error']) {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      const safeArgs = args.map((a) => {
        try { return redact(a); } catch (_) { return a; }
      });
      const line = safeArgs
        .map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      try {
        logStream.write(`${new Date().toISOString()} [${method.toUpperCase()}] ${line}\n`);
      } catch (_) { /* logging must never crash the app */ }
      orig(...safeArgs);
    };
  }

  return logDir;
}

module.exports = { installFileLogging, pruneOldLogs };
