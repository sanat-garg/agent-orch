// Machines → each card's 'Machine settings' disclosure (app.js machineSettings), rendered without a browser: the
// section of app.js runs in a vm against a tiny fake DOM. Checks the three plain-language sections (Work, Staying
// awake, Manage), what each control sends, that removing asks first and sits apart in red, and that no jargon
// ('Power', 'drain', 'policy', 'thermal', 'battery') is left in the Machines UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const appCss = fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const section = appJs.split('// ----- machine settings')[1]?.split('// ----- cluster diagram')[0].replace(/^.*/, '');

class Node {
  constructor(tag) { Object.assign(this, { tagName: tag.toUpperCase(), className: '', children: [], dataset: {}, attrs: {}, on: {}, text: '', html: '' }); }
  append(...xs) { for (const x of xs) this.children.push(typeof x === 'string' ? Object.assign(new Node('#text'), { text: x }) : x); }
  set textContent(v) { this.text = String(v); this.children = []; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(v) { this.html = v; this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { this.on[type] = fn; }
  fire(type) { return this.on[type]?.(); }
  all(pred) { return this.children.flatMap((c) => [...(pred(c) ? [c] : []), ...c.all(pred)]); }
  cls(c) { return this.all((x) => x.className.split(' ').includes(c)); }
  tag(t) { return this.all((x) => x.tagName === t.toUpperCase()); }
  act(a) { return this.all((x) => x.dataset.act === a)[0]; }
}

function fixture() {
  assert.ok(section, 'app.js has a "// ----- machine settings" section before the cluster diagram');
  const calls = [], answers = { confirm: false, prompt: null };
  const ctx = vm.createContext({
    document: { createElement: (t) => new Node(t) },
    el: (tag, cls, text) => { const n = new Node(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
    MC: { open: new Set(), pings: new Map() },
    plural: (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`,
    api: async (url, method, body) => { calls.push([method, url, body]); return {}; },
    toast() {}, loadMachines() {}, pingNode: (n) => calls.push(['ping', n.id]),
    confirm: (msg) => { calls.push(['confirm', msg]); return answers.confirm; },
    prompt: () => answers.prompt,
    MACHINE_SOUNDS: { chime: { label: 'Chime' }, bell: { label: 'Bell' }, pop: { label: 'Pop' } },
    machineDefaultSound: (id) => (id === 'controller' ? 'chime' : 'bell'), machineSound: (id) => (id === 'n1' ? 'pop' : id === 'controller' ? 'chime' : 'bell'),
    $: () => ({ textContent: 'Default chime' }), playSound: (k) => calls.push(['play', k]),
  });
  vm.runInContext(section, ctx);
  return { render: (n) => ctx.machineSettings(n), calls, answers, ctx };
}
const flush = () => new Promise((r) => setImmediate(r));
const mac = { id: 'n1', name: 'MacBook Pro (Studio)', os: 'darwin', connected: true, enabled: true, draining: false, used: 1, maxSlots: null,
  policy: { minBattery: 50, keepAwake: 'ac', thermal: 'heavy', reserveGB: 3 } };
const vps = { id: 'n2', name: 'build-vps', os: 'linux', connected: true, enabled: true, draining: false, used: 0, maxSlots: 2 };
const head = { id: 'controller', name: 'agent-orch', os: 'linux', local: true, connected: true, enabled: true, draining: false, used: 0 };
const labels = (box) => box.cls('mc-rl').map((x) => x.textContent);
const words = (box) => box.textContent + box.all(() => true).map((x) => Object.values(x.attrs).join(' ')).join(' ');

test('a Mac worker: one "Machine settings" disclosure with a gear and Work, Staying awake and Manage', () => {
  const { render } = fixture();
  const box = render(mac);
  assert.equal(box.tagName, 'DETAILS');
  assert.equal(box.className, 'mc-set');
  assert.equal(box.open, false, 'collapsed until the owner opens it');
  const sum = box.children[0];
  assert.equal(sum.tagName, 'SUMMARY');
  assert.equal(sum.dataset.act, 'settings');
  assert.match(sum.html, /^<svg[^>]*aria-hidden="true"/, 'a gear icon');
  assert.equal(sum.textContent, 'Machine settings');
  assert.deepEqual(box.tag('h5').map((h) => h.textContent), ['Work', 'Staying awake', 'Manage']);
  assert.deepEqual(labels(box), ['Parallel tasks', 'Run tasks on this machine', "Keep this Mac awake while it's connected", 'Name', 'Finish sound', 'Check connection', 'Remove from cluster']);
  assert.ok(box.cls('mc-rh').every((h) => h.textContent.length > 0 && h.textContent.length <= 80), 'every control has a short one-line hint');
  assert.match(box.cls('mc-rh')[1].textContent, /^Accept new tasks$/);
  assert.match(box.cls('mc-rh')[2].textContent, /Closing the lid still puts it to sleep/);
  assert.deepEqual(box.cls('seg-sm')[0].children.map((b) => b.textContent), ['Auto', '1', '2', '3', '4']);
  assert.equal(box.act('slots-auto').getAttribute('aria-pressed'), 'true');
  for (const w of [/power/i, /drain/i, /policy/i, /thermal/i, /battery/i]) assert.doesNotMatch(words(box), w);
});

test('a Linux worker has no Staying awake section; the controller shows Auto and only Rename and its sound under Manage', () => {
  const { render } = fixture();
  const box = render(vps);
  assert.deepEqual(box.tag('h5').map((h) => h.textContent), ['Work', 'Manage']);
  assert.equal(box.act('slots-2').getAttribute('aria-pressed'), 'true');
  assert.match(box.cls('mc-rh')[0].textContent, /At most 2 tasks at once/);
  const h = render(head);
  assert.deepEqual(h.tag('h5').map((x) => x.textContent), ['Work', 'Manage']);
  assert.deepEqual(labels(h), ['Parallel tasks', 'Run tasks on this machine', 'Name', 'Finish sound']);
  assert.equal(h.cls('mc-auto')[0].textContent, 'Auto');
  assert.equal(h.act('remove'), undefined, 'the controller cannot be removed');
  assert.equal(h.act('ping'), undefined);
});

test('the switches send plain on/off: take tasks or finish and stop, keep awake or not', async () => {
  const { render, calls } = fixture();
  const patch = () => JSON.parse(JSON.stringify(calls.filter(([m]) => m === 'PATCH').map(([, u, b]) => [u, b]))); // bodies from the vm realm
  const on = render(mac).act('accept');
  assert.equal(on.type, 'checkbox');
  assert.equal(on.getAttribute('role'), 'switch');
  assert.equal(on.checked, true);
  on.fire('change');
  const off = render({ ...mac, draining: true });
  assert.equal(off.act('accept').checked, false);
  assert.equal(off.cls('mc-rh')[1].textContent, 'Finish current tasks, then stop');
  off.act('accept').fire('change');
  render({ ...mac, enabled: false }).act('accept').fire('change');
  const awake = render(mac).act('awake');
  assert.equal(awake.checked, true, "'ac' (the default) shows as on");
  awake.fire('change');
  render({ ...mac, policy: { ...mac.policy, keepAwake: 'never' } }).act('awake').fire('change');
  render(vps).act('slots-auto').fire('click');
  await flush();
  assert.deepEqual(patch(), [['/api/cluster/nodes/n1', { draining: true }], ['/api/cluster/nodes/n1', { draining: false }],
    ['/api/cluster/nodes/n1', { draining: false, enabled: true }], ['/api/cluster/nodes/n1', { policy: { keepAwake: 'never' } }],
    ['/api/cluster/nodes/n1', { policy: { keepAwake: 'always' } }], ['/api/cluster/nodes/n2', { maxSlots: null }]]);
  assert.equal(render(mac).cls('mc-row').filter((r) => r.tagName === 'LABEL').length, 2, "a switch's whole row is its label");
});

test('Finish sound: a picker marked with its default that saves the pick, or null for the default, and a Test button', async () => {
  const { render, calls } = fixture();
  const box = render(mac), sel = box.act('sound');
  assert.equal(sel.tagName, 'SELECT');
  assert.equal(sel.getAttribute('aria-label'), 'Finish sound for MacBook Pro (Studio)');
  assert.deepEqual(sel.children.map((o) => o.textContent), ['Chime', 'Bell (default)', 'Pop']);
  assert.equal(sel.value, 'pop');
  sel.value = 'bell';
  sel.fire('change');
  sel.value = 'chime';
  sel.fire('change');
  box.act('sound-test').fire('click');
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(([m]) => m === 'PATCH').map(([, , b]) => b))), [{ sound: null }, { sound: 'chime' }]);
  assert.deepEqual(calls.at(-1), ['play', 'chime']);
});

test('Remove from cluster sits apart in red and asks first; the disclosure stays open across renders', async () => {
  const { render, calls, answers, ctx } = fixture();
  const box = render(mac), danger = box.cls('mc-danger');
  assert.equal(danger.length, 1, 'removing is set apart');
  const rm = danger[0].act('remove');
  assert.match(rm.className, /\bdanger\b/);
  assert.equal(box.cls('danger').filter((x) => x.tagName === 'BUTTON').length, 1, 'only removing is red');
  rm.fire('click');
  await flush();
  assert.match(calls.at(-1)[1], /^Remove MacBook Pro \(Studio\) from the cluster\?.*1 running task goes back to the queue/);
  assert.equal(calls.filter(([m]) => m === 'DELETE').length, 0, 'cancelled: nothing removed');
  answers.confirm = true;
  rm.fire('click');
  await flush();
  assert.deepEqual(calls.at(-1), ['DELETE', '/api/cluster/nodes/n1', undefined]);
  box.open = true;
  box.fire('toggle');
  assert.equal(render(mac).open, true);
  assert.ok(ctx.MC.open.has('n1'));
});

test('no "Power" or drain wording left in the Machines UI; rows share a height and get 44pt targets on touch', () => {
  assert.doesNotMatch(appJs + indexHtml, />Power</);
  const machines = appJs.slice(appJs.indexOf('// ----- machines (cluster nodes)'), appJs.indexOf('// ----- cluster diagram'));
  for (const w of ["'Power'", "'Drain'", "'Disable'", 'powerPanel', 'Undrain', 'Power settings']) assert.ok(!machines.includes(w), `${w} is gone`);
  assert.match(appCss, /\.mc-row \{[^}]*min-height: 48px/);
  assert.match(appCss, /@media \(pointer: coarse\) \{[^\n]*\.mc-set > summary \{ min-height: 44px; \}[^\n]*\.mc-row \.seg-sm button, \.mc-row \.btn\.small \{ height: 44px; min-width: 44px; \}/);
  const rules = appCss.slice(appCss.indexOf('.mc-set {'), appCss.indexOf('.am-body {'));
  assert.doesNotMatch(rules.replace(/rgba?\([^)]*\)/g, ''), /#[0-9a-f]{3,8}\b/i, 'colours come from the theme variables');
});
