// The machine Ping result (app.js '// ----- ping result': pingNode, pingBox, pingChecks), rendered without a browser: the
// section runs in a vm against a tiny fake DOM, with node:test's mocked timers. Checks the chip group (round trip, one
// pill per check with its status), the single red pill for no answer and a disconnected machine, that it is removed
// 10 s after the answer, that hovering or opening its details pauses that, and that pinging again restarts it.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const appCss = fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
const section = appJs.split('// ----- ping result')[1]?.split('// ----- assign a task')[0].replace(/^.*/, '');

class Node {
  constructor(tag) { Object.assign(this, { tagName: tag.toUpperCase(), className: '', children: [], dataset: {}, attrs: {}, on: {}, text: '', html: '', parent: null, hidden: false }); }
  get classList() {
    const set = (on, c) => { const s = new Set(this.className.split(' ').filter(Boolean)); if (on) s.add(c); else s.delete(c); this.className = [...s].join(' '); };
    return { add: (c) => set(true, c), remove: (c) => set(false, c), toggle: (c, on) => set(on, c), contains: (c) => this.className.split(' ').includes(c) };
  }
  append(...xs) {
    for (const x of xs) {
      const n = typeof x === 'string' ? Object.assign(new Node('#text'), { text: x }) : x;
      n.remove?.();
      n.parent = this;
      this.children.push(n);
    }
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  contains(x) { for (let n = x; n; n = n.parent) if (n === this) return true; return false; }
  set textContent(v) { this.text = String(v); this.children = []; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(v) { this.html = v; this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { this.on[type] = fn; }
  fire(type, e = {}) { return this.on[type]?.(e); }
  all(pred) { return this.children.flatMap((c) => [...(pred(c) ? [c] : []), ...c.all(pred)]); }
  cls(c) { return this.all((x) => x.className.split(' ').includes(c)); }
}

const DIAG = {
  host: 'head.example', dns: { ok: true, ips: ['1.2.3.4'], ms: 12 }, head: { ok: true, status: 200, url: 'https://head.example/api/health', ms: 812 },
  git: { ok: false, code: 'ETIMEDOUT', ms: 3000 }, github: { ok: true, status: 200, ms: 90 },
};
const OK = { node: 'n1', connected: true, rtt: 84, diag: DIAG, parts: [{ text: 'Ping 84 ms' }, { text: 'DNS ok (1.2.3.4, 12 ms)' }, { text: 'head HTTPS 200 (812 ms)' },
  { text: 'head git failed (ETIMEDOUT)', bad: true }, { text: 'GitHub ok' }], hints: ['git ls-remote of the head\'s git endpoint failed on this Mac (ETIMEDOUT)'] };
const mac = { id: 'n1', name: 'MacBook Air', os: 'darwin', connected: true };

function fixture({ answer = OK, reduced = false } = {}) {
  assert.ok(section, 'app.js has a "// ----- ping result" section before "// ----- assign a task"');
  const calls = [], cards = new Map(), handlers = {}, answers = [answer].flat();
  const ctx = vm.createContext({
    document: { createElement: (t) => new Node(t) },
    el: (tag, cls, text) => { const n = new Node(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
    $: (id) => ({ addEventListener: (t, fn) => { handlers[id] = fn; } }),
    MC: { nodes: [mac, { id: 'n2', name: 'build-vps', os: 'linux', connected: true }, { id: 'controller', local: true }], pings: new Map() },
    api: async (url, method) => { calls.push([method, url]); const a = answers.length > 1 ? answers.shift() : answers[0]; if (a instanceof Error) throw a; return a; },
    relTime: () => '5 min ago', copyToClipboard: async () => true,
    DROP_WHY: { lost: 'no reason reported' }, DROP_NAME: { lost: 'unexplained' },
    matchMedia: () => ({ matches: reduced }),
    setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t), Date: { now: () => Date.now() },
    // renderMachines rebuilds each card and appends pingBox(node), as machineCard does.
    renderMachines: () => { for (const n of ctx.MC.nodes) { const li = new Node('li'); const b = !n.local && ctx.pingBox(n); if (b) li.append(b); cards.set(n.id, li); } },
  });
  vm.runInContext(section, ctx);
  const chip = (id = 'n1') => cards.get(id)?.cls('mc-ping')[0];
  return { ctx, calls, chip, pingAll: () => handlers.pingAll() };
}
const pills = (box) => box.cls('pg-pill').map((p) => [p.cls('pg-l')[0].textContent, p.className.split(' ')[1], p.cls('pg-ms')[0]?.textContent ?? null]);
const fake = () => { mock.timers.reset(); mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }); };
// mock.timers.tick doesn't run a timer set by one it ran (the fade's removal): step through time instead.
const tick = (ms) => { for (let t = 0; t < ms; t += 50) mock.timers.tick(Math.min(50, ms - t)); };
async function pinged(opts) {
  fake();
  const f = fixture(opts);
  await f.ctx.pingNode(mac);
  return f;
}

test('a ping result renders the round trip and one pill per check with its status', async (t) => {
  t.after(() => mock.timers.reset());
  fake();
  const f = fixture(), done = f.ctx.pingNode(mac);
  assert.equal(f.chip().textContent, 'Pinging…', 'a busy chip while it waits');
  await done;
  const box = f.chip();
  assert.equal(box.getAttribute('role'), 'status');
  assert.equal(box.cls('pg-rtt')[0].textContent, '84 ms');
  assert.deepEqual(pills(box), [['DNS', 'ok', '12 ms'], ['Head', 'warn', '812 ms'], ['Git', 'bad', '3000 ms'], ['GitHub', 'ok', '90 ms']]);
  assert.equal(box.cls('pg-pill')[1].title, 'head HTTPS 200 (812 ms) · slow');
  assert.ok(box.classList.contains('bad'), 'the group takes its worst status');
  // The hints wait behind tap-to-expand rather than inline.
  const det = box.cls('pg-det')[0], more = box.cls('pg-more')[0];
  assert.equal(det.hidden, true);
  assert.match(det.textContent, /git ls-remote of the head's git endpoint failed/);
  box.cls('pg-row')[0].fire('click');
  assert.deepEqual([det.hidden, more.getAttribute('aria-expanded')], [false, 'true']);
  assert.deepEqual(f.calls, [['POST', '/api/cluster/nodes/n1/ping']]);
});

test('no answer and a disconnected machine: one red pill and a one-line hint', async (t) => {
  t.after(() => mock.timers.reset());
  const f = await pinged({ answer: new Error('no answer') });
  assert.deepEqual(pills(f.chip()), [['No answer', 'bad', null]]);
  assert.equal(f.chip().cls('pg-hint')[0].textContent, 'Its worker did not reply within 8 s');
  const away = { ...mac, connected: false }, g = fixture({ answer: { node: 'n1', connected: false, lastSeen: 1, awayLabel: 'connection lost', command: 'curl …', drops: { total: 1, by: { lost: 1 } } } });
  g.ctx.MC.nodes[0] = away;
  await g.ctx.pingNode(away);
  assert.deepEqual(pills(g.chip()), [['Not connected', 'bad', null]]);
  assert.equal(g.chip().cls('pg-hint')[0].textContent, 'Last seen 5 min ago · connection lost');
  assert.match(g.chip().cls('pg-det')[0].textContent, /Drops in the last 24 h: 1 \(unexplained 1\).*curl …/);
});

test('it is removed 10 s after the answer, after a fade; under reduced motion at once', async (t) => {
  t.after(() => mock.timers.reset());
  const f = await pinged(), box = f.chip();
  f.ctx.renderMachines(); // live re-renders keep the same chip and its clock
  assert.equal(f.chip(), box);
  tick(9999);
  assert.ok(f.chip() && !box.classList.contains('out'));
  tick(1);
  assert.ok(box.classList.contains('out'), 'fading out and collapsing');
  tick(300);
  assert.equal(f.chip(), undefined, 'gone from the card');
  assert.equal(f.ctx.MC.pings.has('n1'), false);
  f.ctx.renderMachines();
  assert.equal(f.chip(), undefined, 'and stays gone');
  const g = await pinged({ reduced: true }), b2 = g.chip();
  tick(10000);
  assert.equal(g.chip(), undefined);
  assert.ok(!b2.classList.contains('out'), 'no fade under prefers-reduced-motion');
  assert.match(appCss, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.mc-ping[^}]*transition: none/);
});

test('hover, focus and open details pause the timer; pinging again replaces it and restarts', async (t) => {
  t.after(() => mock.timers.reset());
  const f = await pinged(), box = f.chip();
  tick(6000);
  box.fire('mouseenter');
  tick(30000);
  assert.equal(f.chip(), box, 'still there while hovered');
  box.fire('mouseleave');
  tick(3999);
  assert.ok(!box.classList.contains('out'), 'the 4 s left resume after hover');
  tick(1);
  assert.ok(box.classList.contains('out'));
  box.fire('mouseenter'); // hovering a fading chip brings it back
  assert.ok(!box.classList.contains('out'));
  tick(5000);
  assert.equal(f.chip(), box);
  box.fire('mouseleave');
  box.fire('focusin');
  box.cls('pg-row')[0].fire('click');
  box.fire('focusout', { relatedTarget: null });
  tick(60000);
  assert.equal(f.chip(), box, 'still there while its details are open');
  box.cls('pg-row')[0].fire('click');
  tick(2300);
  assert.equal(f.chip(), undefined);

  // Ping again: a new chip and a full 10 s; Ping all: one per worker node.
  const g = await pinged(), first = g.chip();
  tick(8000);
  const again = g.ctx.pingNode(mac);
  await again;
  assert.notEqual(g.chip(), first);
  tick(9000);
  assert.ok(g.chip(), 'the timer restarted');
  tick(1300);
  assert.equal(g.chip(), undefined);
  g.pingAll();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(g.calls.slice(-2), [['POST', '/api/cluster/nodes/n1/ping'], ['POST', '/api/cluster/nodes/n2/ping']]);
});
