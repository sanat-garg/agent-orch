// Cron expressions for scheduled tasks (orchestrator.mjs `schedules`): standard 5 fields, minute hour day-of-month
// month day-of-week, with *, lists, ranges, /steps, month and day names, and @hourly/@daily/@weekly/@monthly/@yearly.
// Day-of-month and day-of-week OR together when both are set (Vixie cron). Times are wall-clock in an IANA time zone.
//
//   parseCron(expr)          → {minute, hour, dom, month, dow: Set, domAny, dowAny}; throws Error with a readable message
//   nextRun(expr, afterMs, tz) → the first matching minute strictly after afterMs (epoch ms), or null within ~5 years
//   describeCron(expr)       → 'Every day at 09:00', 'Weekdays at 18:30', … (the expression itself when unusual)
//   validTz(tz)              → tz if Intl knows it, else null

const ALIASES = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, base: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAYS, base: 0 },
];

const expand = (expr) => ALIASES[String(expr || '').trim().toLowerCase()] || String(expr || '').trim();

function parseField(src, f) {
  const out = new Set();
  const num = (s) => {
    const i = f.names?.indexOf(s.toLowerCase().slice(0, 3)) ?? -1;
    if (i >= 0 && /^[a-z]{3}$/i.test(s)) return i + f.base;
    if (!/^\d+$/.test(s)) throw new Error(`${f.name}: '${s}' is not a number`);
    const n = Number(s);
    if (n < f.min || n > f.max) throw new Error(`${f.name}: ${n} is outside ${f.min}-${f.max}`);
    return n;
  };
  for (const part of src.split(',')) {
    const [range, stepStr, extra] = part.split('/');
    if (extra != null || !range) throw new Error(`${f.name}: '${part}' is not valid`);
    const step = stepStr == null ? 1 : /^\d+$/.test(stepStr) && Number(stepStr) > 0 ? Number(stepStr) : NaN;
    if (!step) throw new Error(`${f.name}: step '${stepStr}' must be a positive number`);
    let lo, hi;
    if (range === '*') [lo, hi] = [f.min, f.max];
    else if (range.includes('-')) {
      const [a, b] = range.split('-');
      [lo, hi] = [num(a), num(b)];
      if (lo > hi) throw new Error(`${f.name}: range ${range} runs backwards`);
    } else [lo, hi] = [num(range), stepStr == null ? num(range) : f.max];
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out;
}

export function parseCron(expr) {
  const parts = expand(expr).split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new Error(`A schedule needs 5 fields (minute hour day month weekday), got ${parts.length || 'none'}`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

export function validTz(tz) {
  if (!tz || typeof tz !== 'string') return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

const fmts = new Map();
// The zone's wall-clock time at epoch ms t, as a UTC-based ms value (so getUTC* read the wall clock).
function wallAt(t, tz) {
  let f = fmts.get(tz);
  if (!f) fmts.set(tz, f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
}
// The epoch ms at which the zone's clock shows wall time w (a time a DST jump skips lands an hour off; a repeated one, first).
function wallToUtc(w, tz) {
  const t1 = w - (wallAt(w, tz) - w);
  return w - (wallAt(t1, tz) - t1);
}

const dayMatches = (c, d) => {
  const dom = c.dom.has(d.getUTCDate()), dow = c.dow.has(d.getUTCDay());
  return c.domAny || c.dowAny ? dom && dow : dom || dow;
};

export function nextRun(expr, afterMs, tz = 'UTC') {
  const c = parseCron(expr);
  tz = validTz(tz) || 'UTC';
  const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
  let w = Math.floor(wallAt(afterMs, tz) / MIN) * MIN + MIN;
  for (let guard = 0; guard < 100000; guard++) {
    const d = new Date(w);
    if (d.getUTCFullYear() > new Date(afterMs).getUTCFullYear() + 5) return null;
    if (!c.month.has(d.getUTCMonth() + 1)) { w = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); continue; }
    if (!dayMatches(c, d)) { w = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + DAY; continue; }
    if (!c.hour.has(d.getUTCHours())) { w = Math.floor(w / HOUR) * HOUR + HOUR; continue; }
    if (!c.minute.has(d.getUTCMinutes())) { w += MIN; continue; }
    const t = wallToUtc(w, tz);
    if (t > afterMs) return t;
    w += MIN; // a DST fold: this wall time already passed
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ord = (n) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

export function describeCron(expr) {
  const src = expand(expr);
  let c;
  try { c = parseCron(src); } catch { return src; }
  const [m, h, dom, mon, dow] = src.split(/\s+/);
  const one = (s) => s.size === 1 ? [...s][0] : null;
  const step = (f) => /^\*\/(\d+)$/.exec(f)?.[1];
  const anyDay = dom === '*' && mon === '*' && dow === '*';
  if (anyDay && h === '*' && m === '*') return 'Every minute';
  if (anyDay && h === '*' && step(m)) return `Every ${step(m)} minutes`;
  if (anyDay && h === '*' && one(c.minute) != null) return one(c.minute) === 0 ? 'Every hour' : `Every hour at :${pad(one(c.minute))}`;
  if (anyDay && step(h) && one(c.minute) != null) return `Every ${step(h)} hours${one(c.minute) ? ` at :${pad(one(c.minute))}` : ''}`;
  if (one(c.minute) == null || one(c.hour) == null || mon !== '*') return `Cron: ${src}`;
  const at = `${pad(one(c.hour))}:${pad(one(c.minute))}`;
  if (anyDay) return `Every day at ${at}`;
  if (dom === '*') {
    const days = [...c.dow].sort();
    if (days.join() === '1,2,3,4,5') return `Weekdays at ${at}`;
    if (days.join() === '0,6') return `Weekends at ${at}`;
    return `Every ${days.map((d) => DAY_NAMES[d]).join(', ')} at ${at}`;
  }
  if (dow === '*' && one(c.dom) != null) return `Monthly on the ${ord(one(c.dom))} at ${at}`;
  return `Cron: ${src}`;
}
