// Custom sounds in the page (public/app.js, audio mocked): a machine that chose one plays it (whole, at its volume) when
// its task finishes, preloaded after the audio unlock so nothing is fetched at play time; the one-per-machine debounce
// and the master switch still hold; 'Use for all machines' covers machines without a pick; and a deleted sound falls
// back to the machine's built-in default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const section = source.split('// ---------- task completion sound ----------')[1].split('// ---------- WebSocket ----------')[0];
const flush = () => new Promise((r) => setImmediate(r));
const X = 'n_4f1c9a2b7d3e', Y = 'n_a0b1c2d3e4f5', ID = '0123456789abcdef01234567', ID2 = 'fedcba9876543210fedcba98';
const sound = (id, extra = {}) => ({ id, key: `custom:${id}`, name: `Sound ${id.slice(0, 4)}`, url: `/api/sounds/${id}`, volume: 100, duration: 1.2, ...extra });

function fixture() {
  let time = 0;
  const log = [], fetches = [], listeners = new Map();
  const elements = Object.fromEntries(['stSound', 'stSoundTest', 'stSoundName', 'stSoundReset', 'stSoundUpload', 'stSoundFile']
    .map((id) => [id, { checked: true, addEventListener(type, fn) { this[type] = fn; } }]));
  const param = () => ({ setValueAtTime(v) { this.value ??= v; if (this.log) log.push(v); }, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  class AudioContext {
    state = 'suspended'; currentTime = 0; destination = {};
    resume() { this.state = 'running'; return Promise.resolve(); }
    createOscillator() { return { frequency: { ...param(), log: true }, connect: (g) => g, start() {}, stop() {} }; }
    createGain() { return { gain: param(), connect: (d) => d }; }
    createBufferSource() {
      return { buffer: null, connect(g) { this.out = g; return g; }, start() { log.push(`${this.buffer.from}@${this.out.gain.value}`); } };
    }
    decodeAudioData(bytes) { return Promise.resolve({ from: bytes.url, duration: 1.2 }); }
  }
  const document = { visibilityState: 'hidden', hasFocus: () => false, addEventListener: (k, fn) => listeners.set(k, fn), removeEventListener: (k) => listeners.delete(k) };
  const context = vm.createContext({ document, performance: { now: () => time }, setTimeout: (fn, ms) => { time += ms; fn(); },
    $: (id) => elements[id], store: { get: () => null, set() {} }, toast() {}, AudioContext,
    fetch: async (url) => { fetches.push(url); return { ok: true, arrayBuffer: async () => ({ url }) }; },
    api: async (p) => (p === '/api/settings' ? { sound: { custom: false } } : { nodes: [] }),
    Audio: class { play() { if (!this.muted) log.push('chime'); return Promise.resolve(); } pause() {} } });
  vm.runInContext(section, context);
  const run = (code) => { const v = vm.runInContext(code, context); return v === undefined ? v : JSON.parse(JSON.stringify(v)); };
  const notes = (key) => run(`MACHINE_SOUNDS[${JSON.stringify(key)}]`).notes?.map((n) => n[0]) ?? ['chime'];
  return { run, log, fetches, listeners, elements, notes, advance(ms = 3001) { time += ms; },
    set: (name, value) => { context[`__${name}`] = value; vm.runInContext(`${name}(__${name})`, context); },
    async done(id, node) {
      context.observeTaskCompletion({ id, status: 'running', kind: 'work', node });
      context.observeTaskCompletion({ id, status: 'done', kind: 'work', node });
      await flush();
    } };
}

test("a task finishing on a machine with a custom sound plays it, preloaded after the unlock, at the sound's volume", async () => {
  const f = fixture();
  await flush();
  f.set('setMachineSounds', [{ id: 'controller', sound: null }, { id: X, sound: `custom:${ID}` }, { id: Y, sound: null }]);
  f.set('setCustomSounds', { sounds: [sound(ID, { volume: 40 }), sound(ID2)], default: null });
  f.run('syncCompletionSound([])');
  assert.deepEqual(f.fetches, [], 'nothing fetched before the page may play audio');

  f.listeners.get('pointerdown')(); // the first gesture unlocks audio, then the sounds in use load
  await flush();
  assert.deepEqual(f.fetches, [`/api/sounds/${ID}`], 'only the sound a machine uses is preloaded');

  await f.done(1, X);
  assert.deepEqual(f.log, [`/api/sounds/${ID}@0.4`], "X's custom sound, at 40%");
  assert.deepEqual(f.fetches, [`/api/sounds/${ID}`], 'played from the preloaded buffer');
  f.log.length = 0; f.advance();

  // A burst: one play per distinct machine, in turn; Y has no pick, so its built-in default.
  await f.done(2, X); await f.done(3, Y); await f.done(4, X); await f.done(5, Y);
  const yDefault = f.run(`machineDefaultSound('${Y}')`);
  assert.deepEqual(f.log, [`/api/sounds/${ID}@0.4`, ...f.notes(yDefault)]);
  f.log.length = 0; f.advance();

  // The picker's ▶ plays any custom sound, loading it on first use.
  f.run(`playSound('custom:${ID2}')`); await flush();
  assert.deepEqual(f.log, [`/api/sounds/${ID2}@1`]);
  f.log.length = 0; f.advance();

  f.elements.stSound.checked = false;
  await f.done(6, X);
  assert.deepEqual(f.log, [], 'the master switch still silences custom sounds');
});

test("'Use for all machines' covers machines without their own pick; deleting a sound falls back to the built-in default", async () => {
  const f = fixture();
  await flush();
  f.set('setMachineSounds', [{ id: 'controller', sound: null }, { id: X, sound: `custom:${ID}` }, { id: Y, sound: 'marimba' }]);
  f.set('setCustomSounds', { sounds: [sound(ID, { volume: 70 }), sound(ID2, { volume: 50 })], default: ID2 });
  f.listeners.get('pointerdown')();
  await flush();
  assert.deepEqual(f.fetches.sort(), [`/api/sounds/${ID}`, `/api/sounds/${ID2}`], 'both in use: both preloaded');
  f.run('syncCompletionSound([])');

  await f.done(1, null); await f.done(2, Y); await f.done(3, X);
  assert.deepEqual(f.log, [`/api/sounds/${ID2}@0.5`, ...f.notes('marimba'), `/api/sounds/${ID}@0.7`],
    "the head follows the all-machines sound; Y keeps its own pick; X its custom one");
  assert.equal(f.run(`machineFallback('${Y}')`), `custom:${ID2}`);
  f.log.length = 0; f.advance();

  // Deleted (GET /api/sounds no longer lists it; the head also resets the nodes that chose it): X's built-in default.
  f.set('setCustomSounds', { sounds: [sound(ID2, { volume: 50 })], default: null });
  assert.equal(f.run('completionSound.buffers.has(' + JSON.stringify(ID) + ')'), false, 'its buffer is dropped');
  await f.done(4, X);
  assert.deepEqual(f.log, f.notes(f.run(`machineDefaultSound('${X}')`)), "X's built-in default, even before the node row is re-read");
  f.log.length = 0; f.advance();
  await f.done(5, null);
  assert.deepEqual(f.log, ['chime'], 'with no sound for all machines the head is back on the chime');
});
