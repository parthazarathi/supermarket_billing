// Shared context helpers for the AI Store Manager.
// Date helpers produce local-calendar ranges converted to ISO bounds, the
// same convention parseRange() uses for created_at comparisons.
const { parseRange, todayLocal } = require('../reportUtils');
const { getSetting } = require('../settings');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Named date ranges the assistant understands: today, yesterday, this_week,
// last_week, this_month, last_month, last_7_days, last_30_days.
// Week starts Monday (Indian retail norm).
function namedRange(name) {
  const today = new Date(`${todayLocal()}T00:00:00`);
  const dayMs = 86400000;
  const dow = (today.getDay() + 6) % 7; // 0 = Monday
  switch (name) {
  case 'today':
    return parseRange({ from: todayLocal(), to: todayLocal() });
  case 'yesterday': {
    const d = new Date(today.getTime() - dayMs);
    return parseRange({ from: localDate(d), to: localDate(d) });
  }
  case 'this_week': {
    const from = new Date(today.getTime() - dow * dayMs);
    return parseRange({ from: localDate(from), to: todayLocal() });
  }
  case 'last_week': {
    const to = new Date(today.getTime() - (dow + 1) * dayMs);
    const from = new Date(to.getTime() - 6 * dayMs);
    return parseRange({ from: localDate(from), to: localDate(to) });
  }
  case 'this_month':
    return parseRange({ from: `${todayLocal().slice(0, 7)}-01`, to: todayLocal() });
  case 'last_month': {
    const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const last = new Date(today.getFullYear(), today.getMonth(), 0);
    return parseRange({ from: localDate(first), to: localDate(last) });
  }
  case 'last_7_days': {
    const from = new Date(today.getTime() - 6 * dayMs);
    return parseRange({ from: localDate(from), to: todayLocal() });
  }
  case 'last_30_days': {
    const from = new Date(today.getTime() - 29 * dayMs);
    return parseRange({ from: localDate(from), to: todayLocal() });
  }
  default:
    return null;
  }
}

const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'last_7_days', 'last_30_days'];

// Resolve { period } or { from, to } args into a parseRange() result.
// Falls back to today when nothing usable is given.
function rangeFromArgs(args = {}) {
  if (args.period && namedRange(args.period)) {
    return namedRange(args.period);
  }
  const from = String(args.from || '').slice(0, 10);
  const to = String(args.to || '').slice(0, 10);
  if (DATE_RE.test(from) && DATE_RE.test(to)) {
    return parseRange({ from, to });
  }
  return parseRange({}); // today
}

function dateFromArg(value) {
  const v = String(value || '').slice(0, 10);
  return DATE_RE.test(v) ? v : todayLocal();
}

// Facts about the store the model may need: name, currency, tax mode.
// Never includes credentials - secrets live outside settings entirely.
function storeContext() {
  return {
    shop_name: getSetting('shop_name', 'Mart POS'),
    currency: 'INR',
    currency_symbol: '₹',
    gst_type: getSetting('gst_type', 'intra'),
    today: todayLocal()
  };
}

function userContext(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role
  };
}

module.exports = { namedRange, rangeFromArgs, dateFromArg, storeContext, userContext, PERIODS, DATE_RE, localDate };
