// Queue → the refill line (#455, app.js renderRefillStatus), rendered without a browser: the '// ----- refill status'
// section of app.js runs in a vm against a tiny fake DOM. Checks each state's plain-language text and short form,
// the counts in <b>, the dot only while planning more work, the ⓘ explanation, and that no old jargon is left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const appCss = fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
const section = appJs.split('// ----- refill status')[1]?.split('// ----- end refill status')[0].replace(/^.*/, '');

class Node {
  constructor(tag) { Object.assign(this, { tagName: tag.toUpperCase(), className: '', children: [], attrs: {}, on: {}, text: '', hidden: false }); }
  append(...xs) { for (const x of xs) this.children.push(typeof x === 'string' ? Object.assign(new Node('#text'), { text: x }) : x); }
  set textContent(v) { this.text = String(v); this.children = []; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { this.on[type] = fn; }
  all(pred) { return this.children.flatMap((c) => [...(pred(c) ? [c] : []), ...c.all(pred)]); }
  cls(c) { return this.all((x) => x.className.split(' ').includes(c)); }
}

function fixture() {
  assert.ok(section, 'app.js has a "// ----- refill status" section');
  const rendered = [];
  const ctx = vm.createContext({
    el: (tag, cls, text) => { const n = new Node(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
    plural: (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`,
    document: { querySelectorAll: (sel) => rendered.flatMap((b) => b.cls(sel.slice(1))) },
  });
  vm.runInContext(section, ctx);
  const render = (r, p) => { const b = ctx.renderRefillStatus(r, p); if (b) rendered.push(b); return b; };
  return { ctx, render };
}
const proj = { id: 1, name: 'agent-orch', perpetual: 1 };
const state = (o) => ({ slots: 20, running: 1, free: 19, ready: 12, requested: 9, toppingUp: false, blockedProjects: [], head: { free: 2, ready: 0 }, ...o });
const full = (b) => b.cls('rf-full')[0].textContent;
const short = (b) => b.cls('rf-short')[0].textContent;

test('planning more work: ready for open slots, a dot, short form "12 ready · 19 open"', () => {
  const { render } = fixture();
  const b = render(state({ toppingUp: true }), proj);
  assert.equal(full(b), '12 tasks ready for 19 open slots · planning more work');
  assert.equal(short(b), '12 ready · 19 open');
  assert.equal(b.cls('rf-dot').length, 1);
  assert.deepEqual(b.cls('rf-full')[0].all((x) => x.tagName === 'B').map((x) => x.textContent), ['12', '19']);
  assert.match(b.className, /\brf-planning\b/);
});

test('balanced: open slots and tasks ready, no dot; all slots busy when none are free', () => {
  const { render } = fixture();
  let b = render(state({ ready: 21 }), proj);
  assert.equal(full(b), '19 open slots · 21 tasks ready');
  assert.equal(short(b), '21 ready · 19 open');
  assert.equal(b.cls('rf-dot').length, 0);
  b = render(state({ free: 0, running: 20, ready: 21 }), proj);
  assert.equal(full(b), 'All slots busy · 21 tasks ready');
  assert.equal(b.cls('rf-dot').length, 0);
  b = render(state({ free: 1, ready: 1 }), proj);
  assert.equal(full(b), '1 open slot · 1 task ready', 'singular');
});

test('blocked: usage limit near, or Keep improving off for this project', () => {
  const { render } = fixture();
  let b = render(state({ toppingUp: true, blockedProjects: [{ id: 1, reason: 'x' }] }), proj);
  assert.equal(full(b), 'Planning paused: usage limit near');
  assert.equal(b.cls('rf-dot').length, 0);
  b = render(state({ blockedProjects: [{ id: 2, reason: 'x' }] }), proj);
  assert.equal(full(b), '19 open slots · 12 tasks ready', 'another project at its limit does not block this one');
  b = render(state({ toppingUp: true }), { ...proj, perpetual: 0 });
  assert.equal(full(b), 'Keep improving is off for this project');
  assert.equal(b.cls('rf-dot').length, 0);
  assert.equal(render(null, proj), null, 'Rapid development off: no line');
});

test('the ⓘ opens and closes a short explanation, and it stays open across re-renders', () => {
  const { ctx, render } = fixture();
  const b = render(state({ toppingUp: true }), proj);
  const info = b.cls('rf-info')[0], pop = b.cls('rf-pop')[0];
  assert.equal(info.tagName, 'BUTTON');
  assert.ok(info.getAttribute('aria-label'));
  assert.equal(pop.hidden, true);
  assert.equal(info.getAttribute('aria-expanded'), 'false');
  info.on.click({ stopPropagation() {} });
  assert.equal(pop.hidden, false);
  assert.equal(info.getAttribute('aria-expanded'), 'true');
  assert.match(pop.textContent, /^Each machine can run several tasks at once\. When fewer tasks are ready than there are open slots, agent-orch asks the planner to queue more, so no machine sits idle\. Turn this off with Keep improving in Settings\.$/);
  const again = render(state({ toppingUp: true, ready: 13 }), proj);
  assert.equal(again.cls('rf-pop')[0].hidden, false, 'the Queue re-renders often: the popover stays open');
  ctx.closeRefillPop();
  assert.equal(again.cls('rf-pop')[0].hidden, true);
  assert.equal(again.cls('rf-info')[0].getAttribute('aria-expanded'), 'false');
  info.on.click({});
  info.on.click({});
  assert.equal(pop.hidden, true, 'a second tap closes it');
});

test('style: counts semibold in tabular figures, the dot is static under reduced motion, the short form at phone width', () => {
  assert.match(appCss, /\.rf b \{[^}]*font-weight: 600[^}]*tabular-nums/);
  assert.match(appCss, /prefers-reduced-motion: reduce\) \{ \.rf-dot \{ animation: none; \}/);
  assert.match(appCss, /max-width: 480px\) \{ \.rf-full \{ display: none; \} \.rf-short \{ display: inline; \}/);
});

test('no "topping up", "Workers:" or arrows left in the refill UI', () => {
  assert.ok(!/topping up|Workers:/.test(appJs), 'app.js still says "topping up" or "Workers:"');
  const { render } = fixture();
  for (const [r, p] of [[state({ toppingUp: true }), proj], [state(), proj], [state({ free: 0 }), proj],
    [state({ blockedProjects: [{ id: 1 }] }), proj], [state(), { ...proj, perpetual: 0 }]]) {
    const b = render(r, p);
    b.cls('rf-info')[0].on.click({});
    assert.doesNotMatch(b.textContent, /→|\bworkers?\b|top.?up|head/i);
  }
  const orch = fs.readFileSync(new URL('../orchestrator.mjs', import.meta.url), 'utf8');
  assert.ok(!/topping up/.test(orch), 'the event log line is plain too');
});
