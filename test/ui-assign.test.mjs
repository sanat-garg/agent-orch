// Machines → 'Assign task' (app.js renderAssignButton and its picker), rendered without a browser: machineCard, ndRender
// and the '// ----- assign a task' section run in a vm against a tiny fake DOM with the endpoints mocked. Checks the
// button on every machine card and detail panel (disabled while offline), that the picker lists exactly what
// GET /api/cluster/nodes/:id/assignable returns, that a pick posts {node} and toasts, and that a 409 shows its reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const appCss = fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
const section = appJs.split('// ----- assign a task')[1]?.split('// ----- machine settings')[0].replace(/^.*/, '');
const fn = (name) => {
  const i = appJs.indexOf(`\nfunction ${name}(`);
  assert.ok(i >= 0, `app.js has function ${name}`);
  return appJs.slice(i, appJs.indexOf('\n}\n', i) + 3);
};

class Node {
  constructor(tag, doc) {
    Object.assign(this, { tagName: tag.toUpperCase(), className: '', children: [], dataset: new Proxy({}, { set: (o, k, v) => { o[k] = String(v); return true; } }), attrs: {}, on: {}, text: '', html: '', style: {}, parent: null, doc });
    this.classList = {
      add: (c) => { if (!this.classList.contains(c)) this.className = `${this.className} ${c}`.trim(); },
      remove: (c) => { this.className = this.className.split(' ').filter((x) => x !== c).join(' '); },
      toggle: (c, on) => (on ?? !this.classList.contains(c) ? this.classList.add(c) : this.classList.remove(c)),
      contains: (c) => this.className.split(' ').includes(c),
    };
  }
  append(...xs) { for (const x of xs) { const n = typeof x === 'string' ? Object.assign(new Node('#text'), { text: x }) : x; n.parent = this; this.children.push(n); } }
  replaceChildren(...xs) { for (const c of this.children) c.parent = null; this.children = []; this.append(...xs); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  get firstElementChild() { return this.children[0] ?? null; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n === this.doc?.body || n.tagName === 'ROOT'; }
  set textContent(v) { this.text = String(v); this.children = []; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(v) { this.html = v; this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, f) { this.on[type] = f; }
  focus() { this.doc.activeElement = this; }
  click() { if (!this.disabled) this.on.click?.({ target: this }); }
  key(key, extra = {}) { const e = { key, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {}, ...extra };
    for (let n = this; n; n = n.parent) n.on.keydown?.(e); return e; }
  all(pred) { return this.children.flatMap((c) => [...(pred(c) ? [c] : []), ...c.all(pred)]); }
  cls(c) { return this.all((x) => x.className.split(' ').includes(c)); }
}

function fixture({ tasks = [], post = () => ({ status: 200, body: { ok: true } }), phone = false } = {}) {
  assert.ok(section, 'app.js has a "// ----- assign a task" section before "// ----- machine settings"');
  const calls = [], toasts = [], docListeners = [];
  const doc = { activeElement: null, body: null, createElement: (t) => new Node(t, doc), createTextNode: (t) => Object.assign(new Node('#text', doc), { text: t }),
    addEventListener: (type, f, capture) => docListeners.push([type, f, capture]), querySelector: () => null };
  doc.body = new Node('body', doc);
  const root = new Node('root', doc); // where the cards and the detail panel live
  const el = (tag, cls, text) => { const n = new Node(tag, doc); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const ND = { taskKey: '', runs: new Map(), els: {} };
  const heads = { ndTitle: el('h2'), ndSub: el('p') };
  const ctx = vm.createContext({
    document: doc, el, CSS: { escape: (s) => s }, location: {}, ND,
    phoneMQ: { matches: phone }, placeMenu: (m, a) => calls.push(['place', a.dataset.node]),
    api: async (url) => { calls.push(['GET', url]); return { tasks }; },
    fetch: async (url, opts) => { calls.push([opts.method, url, JSON.parse(opts.body)]); const r = await post(url); return { ok: r.status < 300, status: r.status, json: async () => r.body }; },
    toast: (msg, o) => toasts.push([msg, o?.kind]), loadMachines: () => calls.push(['loadMachines']),
    fmtDur: (s) => (s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h`),
    shortLabel: (a) => ({ claude: 'Claude', codex: 'Codex' })[a] || a, modelName: (a, m) => m || 'default', agentLabel: (a) => a,
    displayTitle: (t) => t.title, relTime: () => 'just now', VER: {}, plural: (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`, cap: (s) => s[0].toUpperCase() + s.slice(1),
    OS_ICON: {}, OS_NAME: { darwin: 'macOS', linux: 'Linux' }, PHASE_DOING: {}, fmtGB: () => '1 GB', mcMeter: () => el('div'), poolLine: () => null,
    machineHealth: () => [], pingBox: () => null, machineSettings: () => el('details', 'mc-set'), closeNode() {}, openTask() {},
    $: (id) => heads[id], ndNode: () => ctx.ctxNode, ndLoadRun() {}, timelineSection: () => null,
  });
  vm.runInContext(section + fn('nodeState') + fn('machineCard') + fn('ndRender'), ctx);
  const escape = () => { const e = { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} }; for (const [t, f, c] of docListeners) if (t === 'keydown' && c) f(e); };
  return {
    ctx, calls, toasts, doc, escape,
    card: (n) => { const li = ctx.machineCard(n); root.append(li); return li; },
    detail: (n) => { ctx.ctxNode = n; const box = el('section'); box.append(el('h3', '', 'Running here')); root.append(box); ND.els.run = box; ctx.ndRender(); return box; },
    picker: () => doc.body.cls('as-pop')[0],
    rows: () => doc.body.cls('as-row'),
  };
}
const flush = () => new Promise((r) => setImmediate(r));
const now = Date.now() / 1000;
const head = { id: 'controller', name: 'agent-orch', os: 'linux', local: true, connected: true, enabled: true, used: 0, tasks: [], head: { reserved: 2, integrating: 0, workUsed: 0, work: 4, cores: 1 } };
const mac = { id: 'n1', name: 'MacBook Pro', os: 'darwin', connected: true, enabled: true, used: 1, slots: 4, tasks: [{ id: 7, title: 'Running thing', agent: 'claude', model: 'opus', started_at: now - 60 }] };
const vps = { id: 'n2', name: 'build-vps', os: 'linux', connected: false, enabled: true, used: 0, slots: 2, tasks: [], lastSeen: now - 600 };
const READY = [
  { id: 12, title: 'Fix the login page', urgency: 'urgent', agent: 'claude', model: 'opus', created_at: now - 300 },
  { id: 15, title: 'Write the README', urgency: 'normal', agent: 'codex', model: 'gpt-5', created_at: now - 7200 },
  { id: 19, title: 'Tidy the logs', urgency: 'background', agent: null, model: null, created_at: now - 60 },
];

test('every machine card has an Assign task button; an offline one is disabled with a tooltip', () => {
  const f = fixture();
  for (const n of [head, mac, vps]) {
    const b = f.card(n).cls('as-btn');
    assert.equal(b.length, 1, `${n.name}'s card has one Assign task button`);
    assert.equal(b[0].textContent, 'Assign task');
    assert.equal(b[0].tagName, 'BUTTON');
    assert.equal(b[0].getAttribute('aria-haspopup'), 'dialog');
    assert.equal(!!b[0].disabled, !n.connected, `${n.name}: disabled only while offline`);
    assert.match(b[0].title, n.connected ? /start it on/ : /offline/);
  }
});

test("each machine's detail panel (the head's too) has the Assign task button", () => {
  const f = fixture();
  for (const n of [head, mac, vps]) {
    const b = f.detail(n).cls('as-btn');
    assert.equal(b.length, 1, `${n.name}'s detail has the button`);
    assert.equal(!!b[0].disabled, !n.connected);
  }
});

test('the picker is titled for the machine and lists exactly the assignable tasks, with a search filter', async () => {
  const f = fixture({ tasks: READY });
  const btn = f.card(mac).cls('as-btn')[0];
  btn.click();
  const pop = f.picker();
  assert.ok(pop, 'a picker opens');
  assert.equal(pop.getAttribute('role'), 'dialog');
  assert.equal(pop.cls('as-head')[0].children[0].textContent, 'Run on MacBook Pro now');
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(f.calls.find((c) => c[0] === 'GET'), ['GET', '/api/cluster/nodes/n1/assignable']);
  assert.match(pop.textContent, /Loading/);
  await flush();
  assert.deepEqual(f.rows().map((r) => r.dataset.task), ['12', '15', '19'], 'only the returned tasks, in order');
  const [a, b, c] = f.rows().map((r) => r.textContent);
  assert.match(a, /Fix the login page/);
  assert.match(a, /#12 · Urgent · Claude · opus/);
  assert.match(a, /waited 5m/);
  assert.match(b, /#15 · Normal · Codex · gpt-5.*waited 2h/);
  assert.match(c, /#19 · Later · Claude · default/);
  assert.equal(f.calls.filter((x) => x[0] === 'place').length >= 1, true, 'a popover by its button on desktop');
  const search = pop.cls('as-search')[0];
  assert.equal(search.getAttribute('aria-label'), 'Search ready tasks');
  search.value = 'readme';
  search.on.input();
  assert.deepEqual(f.rows().map((r) => r.dataset.task), ['15']);
  search.value = '#19';
  search.on.input();
  assert.deepEqual(f.rows().map((r) => r.dataset.task), ['19']);
  search.value = 'nothing like it';
  search.on.input();
  assert.equal(f.rows().length, 0);
  assert.match(pop.textContent, /No ready task matches/);
  f.escape();
  assert.equal(f.picker(), undefined, 'Escape closes it');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(f.doc.activeElement, btn, 'focus goes back to the button');
});

test('the empty state explains why nothing is ready; phones get a bottom sheet', async () => {
  const f = fixture({ tasks: [], phone: true });
  f.card(head).cls('as-btn')[0].click();
  await flush();
  assert.equal(f.picker().cls('as-note')[0].textContent, 'No ready tasks: everything queued is waiting on another task');
  assert.ok(f.doc.body.cls('as-layer')[0].classList.contains('sheet'));
  assert.equal(f.calls.filter((x) => x[0] === 'place').length, 0, 'a sheet is not placed by the button');
  assert.match(appCss, /\.as-layer\.sheet \.as-pop \{[^}]*bottom: 0/);
  assert.match(appCss, /@media \(pointer: coarse\) \{\s*\.as-row \{ min-height: 44px; \}/);
});

test('picking a row posts {node}, closes the picker, toasts and refreshes the machines', async () => {
  const f = fixture({ tasks: READY });
  f.card(mac).cls('as-btn')[0].click();
  await flush();
  f.rows()[1].click();
  assert.match(f.rows()[1].textContent, /Starting…/);
  assert.ok(f.rows().every((r) => r.disabled), 'one pick at a time');
  await flush();
  assert.deepEqual(f.calls.find((c) => c[0] === 'POST'), ['POST', '/api/orch/tasks/15/assign', { node: 'n1' }]);
  assert.equal(f.picker(), undefined, 'closed');
  assert.deepEqual(f.toasts, [['Started #15 on MacBook Pro', 'success']]);
  assert.ok(f.calls.some((c) => c[0] === 'loadMachines'), 'the card updates');
});

test('a CPU-busy warning is added to the toast; Enter in the search starts its only match', async () => {
  const f = fixture({ tasks: READY, post: () => ({ status: 200, body: { ok: true, warning: 'cpu' } }) });
  f.detail(head).cls('as-btn')[0].click();
  await flush();
  const search = f.picker().cls('as-search')[0];
  search.value = 'logs';
  search.on.input();
  const e = search.key('Enter');
  assert.ok(e.defaultPrevented);
  await flush();
  assert.deepEqual(f.calls.find((c) => c[0] === 'POST'), ['POST', '/api/orch/tasks/19/assign', { node: 'controller' }]);
  assert.deepEqual(f.toasts, [['Started #19 on agent-orch · CPU busy', 'warn']]);
});

test('a 409 shows its reason inline in that row and the picker stays open', async () => {
  const f = fixture({ tasks: READY, post: () => ({ status: 409, body: { error: 'Codex is not signed in on MacBook Pro' } }) });
  f.card(mac).cls('as-btn')[0].click();
  await flush();
  f.rows()[1].click();
  await flush();
  assert.ok(f.picker(), 'still open');
  const why = f.picker().cls('as-why');
  assert.equal(why.length, 1);
  assert.equal(why[0].textContent, 'Codex is not signed in on MacBook Pro');
  assert.equal(why[0].parent.children[0].dataset.task, '15', 'under the row that was refused');
  assert.equal(f.rows()[1].getAttribute('aria-describedby'), why[0].id);
  assert.ok(f.rows().every((r) => !r.disabled), 'the rows work again');
  assert.equal(f.doc.activeElement, f.rows()[1], 'focus stays on the refused row');
  assert.deepEqual(f.toasts, []);
});

test('keyboard: arrows move from the search through the rows, Tab stays inside', async () => {
  const f = fixture({ tasks: READY });
  f.card(mac).cls('as-btn')[0].click();
  await flush();
  const search = f.picker().cls('as-search')[0];
  assert.equal(f.doc.activeElement, search, 'the search has focus on desktop');
  search.key('ArrowDown');
  assert.equal(f.doc.activeElement, f.rows()[0]);
  f.rows()[0].key('ArrowDown');
  assert.equal(f.doc.activeElement, f.rows()[1]);
  f.rows()[1].key('ArrowUp');
  f.rows()[0].key('ArrowUp');
  assert.equal(f.doc.activeElement, search);
  f.rows()[2].focus();
  f.rows()[2].key('Tab');
  assert.equal(f.doc.activeElement, f.picker().cls('as-x')[0], 'wraps to the close button');
});
