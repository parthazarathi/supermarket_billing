// Local + recorded backup management for MartPOS.
//
// Local backup files live in <data dir>/backups/ and are plain snapshots of
// the sql.js database - the same byte format uploaded to Google Drive.
// Every backup and restore attempt (local or cloud) is recorded in the
// backup_log table so Settings -> Backup history can show what happened.
//
// Safety rules implemented here:
//  - a snapshot is validated (opens, has core tables, quick_check) before it
//    is written or uploaded - a corrupt export is never called a backup
//  - restores always take a pre-restore-*.db safety copy of the live
//    database first and only swap files after the incoming image validates
//  - local backups are pruned to KEEP_COUNT so the folder cannot grow forever
const fs = require('fs');
const path = require('path');
const { getDataDir, getDbPath } = require('./paths');
const { exportSnapshot, validateDatabaseBuffer, reloadDatabase } = require('./database');

const KEEP_COUNT = 30;
const BACKUP_RE = /^MartPOS-backup-(.+)\.db$/i;
const PRERESTORE_RE = /^pre-restore-(.+)\.db$/i;

function backupDir() {
  const dir = path.join(getDataDir(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- history ----------------------------------------------------------

function recordHistory(entry) {
  try {
    const { withTransaction } = require('./database');
    withTransaction((db) => {
      db.run(
        'INSERT INTO backup_log (type, location, name, path, status, size, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          entry.type || 'manual',
          entry.location || 'local',
          entry.name || '',
          entry.path || '',
          entry.status || 'success',
          entry.size || 0,
          String(entry.error || '').slice(0, 500),
          new Date().toISOString()
        ]
      );
    });
  } catch (e) {
    // History must never break the operation it is describing.
    console.error('Could not record backup history:', e.message);
  }
}

function listHistory(limit = 100) {
  try {
    const { execToObjects } = require('./database');
    return execToObjects(
      'SELECT id, type, location, name, status, size, error, created_at FROM backup_log ORDER BY id DESC LIMIT ?',
      [limit]
    );
  } catch (_) {
    return [];
  }
}

// ---- local backups ----------------------------------------------------

function listLocalBackups() {
  const dir = backupDir();
  return fs.readdirSync(dir)
    .filter((f) => BACKUP_RE.test(f) || PRERESTORE_RE.test(f))
    .map((f) => {
      const p = path.join(dir, f);
      let st = { size: 0, mtime: null };
      try { st = fs.statSync(p); } catch (_) { /* unreadable */ }
      return {
        name: f,
        size: st.size || 0,
        created_at: st.mtime ? st.mtime.toISOString() : '',
        kind: PRERESTORE_RE.test(f) ? 'pre-restore' : 'snapshot'
      };
    })
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

function pruneLocalBackups() {
  const files = listLocalBackups().filter((f) => f.kind === 'snapshot');
  const extra = files.slice(KEEP_COUNT);
  for (const f of extra) {
    try {
      fs.unlinkSync(path.join(backupDir(), f.name));
      console.log(`Pruned old local backup ${f.name}`);
    } catch (e) {
      console.error(`Could not prune local backup ${f.name}:`, e.message);
    }
  }
}

// Exports the live database, validates it, and writes it to
// backups/<prefix>-<stamp>.db. Returns { ok, file, size } or { ok, error }.
async function createLocalBackup(type = 'manual') {
  const prefix = type === 'pre-restore' ? 'pre-restore' : 'MartPOS-backup';
  const name = `${prefix}-${stamp()}.db`;
  const dest = path.join(backupDir(), name);
  try {
    const snapshot = exportSnapshot();
    const check = await validateDatabaseBuffer(snapshot);
    if (!check.ok) {
      recordHistory({ type, location: 'local', name, path: dest, status: 'failed', error: check.error });
      console.error(`Local backup rejected by validation: ${check.error}`);
      return { ok: false, error: `Backup validation failed: ${check.error}` };
    }
    fs.writeFileSync(dest, snapshot);
    recordHistory({ type, location: 'local', name, path: dest, status: 'success', size: snapshot.length });
    console.log(`Local backup written: ${name} (${snapshot.length} bytes)`);
    if (type !== 'pre-restore') pruneLocalBackups();
    return { ok: true, file: { name, size: snapshot.length, path: dest, created_at: new Date().toISOString() } };
  } catch (e) {
    recordHistory({ type, location: 'local', name, path: dest, status: 'failed', error: e.message });
    console.error('Local backup failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// True when automatic local backup is enabled and the configured interval
// has elapsed since the newest local snapshot.
function isLocalBackupDue() {
  try {
    const { getSetting } = require('./settings');
    if (getSetting('local_backup_enabled', '1') !== '1') return false;
    const interval = getSetting('local_backup_interval', 'daily');
    const ms = interval === '6h' ? 6 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const latest = listLocalBackups().find((f) => f.kind === 'snapshot');
    const last = latest && latest.created_at ? Date.parse(latest.created_at) : 0;
    return Date.now() - (last || 0) >= ms;
  } catch (_) {
    return false;
  }
}

// ---- restore ----------------------------------------------------------

// Validates a backup file on disk and returns displayable details.
async function describeBackupFile(filePath, displayName) {
  const st = fs.statSync(filePath);
  const check = await validateDatabaseBuffer(fs.readFileSync(filePath));
  return {
    ok: check.ok,
    error: check.error || '',
    name: displayName || path.basename(filePath),
    size: st.size,
    created_at: st.mtime ? st.mtime.toISOString() : '',
    tables: check.tables || 0,
    invoices: check.invoices || 0
  };
}

// Performs the swap: validates the source once more, takes a safety backup
// of the live database, copies the source over pos.db and reloads. On any
// failure the live file is left exactly as it was.
async function applyRestoreFile(srcPath, label) {
  const dbPath = getDbPath();

  const check = await validateDatabaseBuffer(fs.readFileSync(srcPath));
  if (!check.ok) {
    recordHistory({ type: 'restore', location: 'local', name: label, status: 'failed', error: check.error });
    return { ok: false, error: `Backup is not usable: ${check.error}` };
  }

  const safety = await createLocalBackup('pre-restore');
  if (!safety.ok) {
    // No safety copy, no restore - never risk the live database.
    return { ok: false, error: `Could not create safety backup: ${safety.error}` };
  }

  const tmpTarget = `${dbPath}.restore`;
  try {
    fs.copyFileSync(srcPath, tmpTarget);
    fs.renameSync(tmpTarget, dbPath);
  } catch (e) {
    try { fs.unlinkSync(tmpTarget); } catch (_) { /* partial file cleaned */ }
    recordHistory({ type: 'restore', location: 'local', name: label, status: 'failed', error: e.message });
    return { ok: false, error: `Restore failed while replacing the database: ${e.message}` };
  }

  try {
    reloadDatabase();
  } catch (e) {
    // The new file validated but would not load - put the safety copy back.
    console.error('Restored database failed to load, rolling back:', e.message);
    try {
      fs.copyFileSync(safety.file.path, dbPath);
      reloadDatabase();
    } catch (e2) {
      console.error('Rollback after failed restore also failed:', e2.message);
    }
    recordHistory({ type: 'restore', location: 'local', name: label, status: 'failed', error: 'Restored database would not load; rolled back' });
    return { ok: false, error: 'Restored database could not be opened. Your previous data was put back.' };
  }

  recordHistory({ type: 'restore', location: 'local', name: label, status: 'success', size: check.size });
  console.log(`Database restored from ${label}`);
  return { ok: true, safety_backup: safety.file.name };
}

module.exports = {
  backupDir,
  createLocalBackup,
  isLocalBackupDue,
  listLocalBackups,
  describeBackupFile,
  applyRestoreFile,
  recordHistory,
  listHistory,
  KEEP_COUNT
};
