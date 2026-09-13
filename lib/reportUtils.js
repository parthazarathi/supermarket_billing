const { getDatabase } = require('./database');

// Run a parameterized query and return rows as objects
function q(sql, params = []) {
  const db = getDatabase();
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
}

function qOne(sql, params = []) {
  const rows = q(sql, params);
  return rows.length ? rows[0] : null;
}

function r2(n) {
  const v = parseFloat(n);
  if (!isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Parse ?from=YYYY-MM-DD&to=YYYY-MM-DD into local-date bounds.
// Returns ISO UTC bounds for comparing against ISO created_at columns.
// Defaults to today when params are missing/invalid.
function parseRange(query = {}) {
  const today = todayLocal();
  let from = String(query.from || '').slice(0, 10);
  let to = String(query.to || '').slice(0, 10);
  if (!DATE_RE.test(from)) from = today;
  if (!DATE_RE.test(to)) to = today;
  if (from > to) {
    throw new Error('From date cannot be after To date');
  }
  const start = new Date(`${from}T00:00:00`).toISOString();
  const end = new Date(`${to}T23:59:59.999`).toISOString();
  return { from, to, start, end };
}

// created_at BETWEEN ? AND ? with params [start, end]
function rangeClause(range, alias = '') {
  const col = alias ? `${alias}.created_at` : 'created_at';
  return { sql: ` AND ${col} >= ? AND ${col} <= ?`, params: [range.start, range.end] };
}

// Group rows by local calendar day: date(created_at, 'localtime')
const DAY_EXPR = (alias = '') => `date(${alias ? alias + '.' : ''}created_at, 'localtime')`;
const HOUR_EXPR = (alias = '') => `strftime('%H', datetime(${alias ? alias + '.' : ''}created_at, 'localtime'))`;
const TIME_EXPR = (alias = '') => `strftime('%H:%M', datetime(${alias ? alias + '.' : ''}created_at, 'localtime'))`;

function pageParams(query = {}, defaultPerPage = 50) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const perPage = Math.min(100000, Math.max(1, parseInt(query.per_page, 10) || defaultPerPage));
  return { page, perPage, offset: (page - 1) * perPage };
}

// Run countSql + dataSql (with LIMIT/OFFSET appended) and return a paged payload
function pagedQuery(countSql, dataSql, params, query, defaultPerPage = 50) {
  const { page, perPage, offset } = pageParams(query, defaultPerPage);
  const countRow = qOne(countSql, params) || {};
  const total = parseInt(countRow.total, 10) || 0;
  const rows = q(`${dataSql} LIMIT ? OFFSET ?`, [...params, perPage, offset]);
  return { rows, total, page, per_page: perPage };
}

function likeParam(value) {
  return `%${String(value || '').replace(/[%_]/g, '')}%`;
}

// Round every numeric field in a row to 2 decimals
function roundRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'number' ? r2(v) : v;
  }
  return out;
}

function roundRows(rows) {
  return rows.map(roundRow);
}

function roundSummary(obj) {
  return roundRow(obj);
}

const NOT_CANCELLED = "i.status <> 'cancelled'";

module.exports = {
  q,
  qOne,
  r2,
  parseRange,
  rangeClause,
  DAY_EXPR,
  HOUR_EXPR,
  TIME_EXPR,
  pageParams,
  pagedQuery,
  likeParam,
  roundRow,
  roundRows,
  roundSummary,
  todayLocal,
  NOT_CANCELLED
};
