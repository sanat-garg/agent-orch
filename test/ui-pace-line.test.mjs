// Ideal-pace marker on the usage bars: app.js's paceMark/setPace (pulled out of the source, like version-ui's aboutLines)
// put a line at the share of the window already elapsed, grey while usage is at or under it, dark orange when over;
// a window without a known reset gets none. The CSS colours and the charts' dashed diagonal are checked in the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
const src = (re) => { const m = appJs.match(re); assert.ok(m, `app.js: ${re}`); return m[0]; };

// A tiny DOM: .ms-bar holding its fill <i>, and el() as app.js defines it.
class Node {
  constructor(tag, cls = '') { this.tag = tag; this.className = cls; this.style = {}; this.children = []; }
  append(...n) { for (const c of n) { c.parent = this; this.children.push(c); } }
  remove() { const a = this.parent.children; a.splice(a.indexOf(this), 1); }
  querySelector(sel) { return this.children.find((c) => c.className.split(' ').includes(sel.slice(1))) || null; }
}
const el = (tag, cls) => new Node(tag, cls);
const { paceMark, setPace, paceWinMs } = new Function('el', [/^const paceWinMs = .*$/m, /^const resetMs = .*$/m,
  /^function paceMark\(.*?^}$/ms, /^function setPace\(.*?^}$/ms].map(src).join('\n') + '\nreturn { paceMark, setPace, paceWinMs };')(el);

const H = 3600e3, NOW = Date.parse('2026-09-28T12:00:00Z');
const resetIn4h = new Date(NOW + 4 * H).toISOString(); // 1 h into a 5 h window
const bar = (pct, resetsAt, win = 'five_hour') => {
  const b = el('span', 'ms-bar');
  b.append(el('i'));
  setPace(b, paceMark(pct, resetsAt, paceWinMs(win), NOW));
  return b.querySelector('.pace');
};

test('1 h into a 5 h window at 15%: grey marker at 20%, under pace', () => {
  const m = bar(15, resetIn4h);
  assert.equal(m.style.left, '20%');
  assert.equal(m.className, 'pace');
  assert.equal(paceMark(15, resetIn4h, 5 * H, NOW).tip, "Pace: 20% by now · you're at 15% (5% under)");
});

test('1 h into a 5 h window at 25%: dark orange marker, over pace', () => {
  const m = bar(25, resetIn4h);
  assert.equal(m.style.left, '20%');
  assert.equal(m.className, 'pace over');
  assert.equal(paceMark(25, resetIn4h, 5 * H, NOW).tip, "Pace: 20% by now · you're at 25% (5% over)");
  assert.match(css, /\.ms-bar \.pace \{[^}]*background: var\(--muted\)/);
  assert.match(css, /\.ms-bar \.pace\.over \{ background: var\(--pace-over\)/);
  assert.match(css, /--pace-over: #c2410c/);
});

test('a window with an unknown (or past) reset shows no marker, and a marker goes away when the reset is lost', () => {
  assert.equal(bar(40, null), null);
  assert.equal(bar(40, new Date(NOW - H).toISOString()), null);
  const b = el('span', 'ms-bar');
  setPace(b, paceMark(40, resetIn4h, 5 * H, NOW));
  assert.ok(b.querySelector('.pace'));
  setPace(b, paceMark(40, null, 5 * H, NOW));
  assert.equal(b.querySelector('.pace'), null);
});

test('window lengths: 5-hour windows are 5 h, weekly ones 7 d; epoch-second resets work too', () => {
  for (const w of ['five_hour', '5h', 'spark-5h', '5-hour']) assert.equal(paceWinMs(w), 5 * H);
  for (const w of ['seven_day', 'seven_day_opus', 'weekly', 'Weekly', 'Fable']) assert.equal(paceWinMs(w), 7 * 24 * H);
  const m = paceMark(10, (NOW + 3.5 * 24 * H) / 1000, paceWinMs('seven_day'), NOW);
  assert.equal(Math.round(m.ideal), 50);
  assert.equal(m.over, false);
});

test('the sidebar rows and the usage charts use it', () => {
  assert.match(appJs, /setPace\(bar, pace\)/);
  assert.match(appJs, /ns\('line', \{ class: 'pace'/);
  assert.match(css, /\.ug-chart \.pace \{[^}]*stroke-dasharray/);
});
