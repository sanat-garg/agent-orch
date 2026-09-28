// A finish sound per machine: stable, distinct defaults (the controller keeps the MP3 chime), the owner's pick saved on
// the node row (cluster.mjs), and a finished task playing the sound of the machine it ran on (public/app.js, audio mocked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createCluster, LOCAL_NODE, NODE_SOUNDS } from '../cluster.mjs';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const section = source.split('// ---------- task completion sound ----------')[1].split('// ---------- WebSocket ----------')[0];
const flush = () => new Promise((r) => setImmediate(r));

function fixture() {
  let time = 0;
  const log = []; // what played, in order: 'chime' (the MP3) or each synthesized note's pitch
  const elements = Object.fromEntries(['stSound', 'stSoundTest', 'stSoundName', 'stSoundReset', 'stSoundUpload', 'stSoundFile']
    .map((id) => [id, { checked: true, addEventListener(type, fn) { this[type] = fn; } }]));
  const param = () => ({ setValueAtTime(v) { this.value ??= v; if (this.log) log.push(v); }, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  class AudioContext {
    state = 'running'; currentTime = 0; destination = {};
    resume() { return Promise.resolve(); }
    createOscillator() { return { frequency: { ...param(), log: true }, connect: (g) => g, start() {}, stop() {} }; }
    createGain() { return { gain: param(), connect: (d) => d }; }
  }
  const document = { visibilityState: 'hidden', hasFocus: () => false, addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ document, performance: { now: () => time }, setTimeout: (fn, ms) => { time += ms; fn(); },
    $: (id) => elements[id], store: { get: () => null, set() {} }, toast() {}, AudioContext,
    api: async (p) => (p === '/api/settings' ? { sound: { custom: false } } : { nodes: [] }),
    Audio: class { play() { log.push('chime'); return Promise.resolve(); } pause() {} } });
  vm.runInContext(section, context);
  const run = (code) => { const v = vm.runInContext(code, context); return v === undefined ? v : JSON.parse(JSON.stringify(v)); }; // plain values from the vm realm
  const notes = (key) => run(`MACHINE_SOUNDS[${JSON.stringify(key)}]`).notes?.map((n) => n[0]) ?? ['chime'];
  return { run, log, notes, advance(ms = 3001) { time += ms; },
    async done(id, node, extra = {}) {
      context.observeTaskCompletion({ id, status: 'running', kind: 'work', node, ...extra });
      context.observeTaskCompletion({ id, status: 'done', kind: 'work', node, ...extra });
      await flush();
    } };
}

const WORKERS = ['n_4f1c9a2b7d3e', 'n_a0b1c2d3e4f5', 'n_9e8d7c6b5a41', 'n_31d0c4a8e2b7'];

test('defaults: the controller keeps the chime; four workers get four different sounds, stable as machines are added', () => {
  const f = fixture();
  const ids = [LOCAL_NODE, ...WORKERS];
  const first = f.run(`[...defaultMachineSounds(${JSON.stringify(ids)})]`);
  assert.equal(first[0][1], 'chime');
  const sounds = first.slice(1).map(([, s]) => s);
  assert.equal(new Set(sounds).size, 4, `distinct: ${sounds}`);
  for (const s of sounds) assert.ok(s !== 'chime' && f.run(`SYNTH_SOUNDS`).includes(s));
  assert.deepEqual(f.run(`[...defaultMachineSounds(${JSON.stringify(ids)})]`), first, 'same ids, same sounds');
  const more = f.run(`[...defaultMachineSounds(${JSON.stringify([...ids, 'n_77aa88bb99cc'])})]`);
  assert.deepEqual(more.slice(0, 5), first, 'a new machine changes no other machine');
  // Every palette entry is short and gentle; the node row accepts exactly the UI's palette.
  assert.deepEqual(f.run('Object.keys(MACHINE_SOUNDS)'), NODE_SOUNDS);
  for (const key of f.run('SYNTH_SOUNDS')) {
    const s = f.run(`MACHINE_SOUNDS[${JSON.stringify(key)}]`);
    assert.ok(Math.max(...s.notes.map(([, at, len]) => at + len)) < 1, `${key} lasts under 1 s`);
    assert.ok(s.notes.reduce((a, n) => a + n[3], 0) <= 0.5, `${key} is gentle`);
  }
  assert.equal(new Set(f.run('SYNTH_SOUNDS').map((k) => JSON.stringify(f.notes(k)))).size, 6, 'six different patterns');
});

test("the owner's pick is saved on the node row, survives a restart, and null goes back to the default", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-machines-')), dbFile = path.join(dir, 'orch.db');
  try {
    let hub = createCluster({ dbFile });
    const { code } = hub.createPairing();
    const { node } = hub.claim({ code, name: 'mac', os: 'darwin', arch: 'arm64' });
    assert.equal(hub.node(node).sound, null, 'no pick yet: the UI default');
    assert.equal(hub.update(node, { sound: 'marimba' }).node.sound, 'marimba');
    assert.equal(hub.update(LOCAL_NODE, { sound: 'glass' }).node.sound, 'glass');
    assert.equal(hub.update(node, { sound: 'kazoo' }).status, 400);
    hub.close();
    hub = createCluster({ dbFile });
    const nodes = Object.fromEntries(hub.listNodes().map((n) => [n.id, n.sound]));
    assert.deepEqual(nodes, { [LOCAL_NODE]: 'glass', [node]: 'marimba' });
    assert.equal(hub.update(node, { sound: null }).node.sound, null);
    hub.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a task finishing on machine X plays X's sound; a burst plays each machine's sound once, in turn", async () => {
  const f = fixture();
  await flush(); // the page's own first read of the machines (none here), before the test sets them
  const [x, y] = WORKERS;
  f.run(`setMachineSounds([{ id: 'controller', sound: null }, { id: '${x}', sound: 'marimba' }, { id: '${y}', sound: null }])`);
  f.run('syncCompletionSound([])');
  assert.equal(f.run(`machineSound('${y}')`), f.run(`defaultMachineSounds(['controller', '${x}', '${y}']).get('${y}')`));

  await f.done(1, x);
  assert.deepEqual(f.log, f.notes('marimba'), "X's pick");
  f.log.length = 0; f.advance();

  await f.done(2, y); await f.done(3, x); await f.done(4, y); await f.done(5, null); await f.done(6, x);
  const ySound = f.run(`machineSound('${y}')`);
  assert.deepEqual(f.log, [...f.notes(ySound), ...f.notes('marimba'), 'chime'], 'one each, in order: Y, X, then the head');
  f.log.length = 0; f.advance();

  await f.done(7, x, { integrates: [2, 3] });
  assert.deepEqual(f.log, ['chime'], 'an integration sounds like the head');
  f.log.length = 0; f.advance();

  await f.done(8, 'n_newly_paired');
  assert.deepEqual(f.log, f.notes(f.run(`machineSound('n_newly_paired')`)), 'a machine paired since the page loaded gets its default');
  f.log.length = 0; f.advance();

  f.run(`$('stSound').checked = false`);
  await f.done(9, x);
  assert.deepEqual(f.log, [], 'the Settings switch still silences every machine');
});
