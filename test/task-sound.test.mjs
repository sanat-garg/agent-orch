import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function fixture(saved = null) {
  let plays = 0, time = 0;
  const elements = Object.fromEntries(['obSound', 'obSoundTest'].map(id => [id, { addEventListener(type, fn) { this[type] = fn; } }]));
  const listeners = new Map();
  const document = { visibilityState: 'hidden', hasFocus: () => false,
    addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  const context = vm.createContext({ document, performance: { now: () => time },
    $: id => elements[id], store: { get: () => saved, set: (_, value) => { saved = value; } },
    Audio: class { play() { if (!this.muted) plays++; return Promise.resolve(); } pause() {} } });
  vm.runInContext(source.split('// ---------- task completion sound ----------')[1].split('// ---------- WebSocket ----------')[0], context);
  return { context, document, elements, listeners, get plays() { return plays; }, get saved() { return saved; },
    advance() { time += 3001; }, run: code => vm.runInContext(code, context),
    async event(id, status, kind = 'work') { context.observeTaskCompletion({ id, status, kind }); await Promise.resolve(); } };
}

test('completion sound: live transitions, replay, first completion, focus, kinds and debounce', async () => {
  const f = fixture();
  await f.event(1, 'running'); await f.event(1, 'done');
  assert.equal(f.plays, 0, 'before initial sync');
  f.run("syncCompletionSound([{id:2,status:'done'}, {id:3,status:'running'}])");
  await f.event(2, 'done'); await f.event(4, 'done');
  assert.equal(f.plays, 0, 'history and unknown tasks');
  await f.event(3, 'done'); assert.equal(f.plays, 1);
  await f.event(5, 'running', 'reflect'); await f.event(5, 'done', 'reflect');
  assert.equal(f.plays, 1, 'burst coalesced');
  f.advance();
  await f.event(3, 'running'); await f.event(3, 'done');
  assert.equal(f.plays, 1, 'only first completion');
  await f.event(6, 'running', 'plan'); await f.event(6, 'done', 'plan');
  assert.equal(f.plays, 1, 'plans excluded');
  f.document.visibilityState = 'visible'; f.document.hasFocus = () => true;
  await f.event(7, 'running'); await f.event(7, 'done'); assert.equal(f.plays, 1);
  f.document.hasFocus = () => false;
  await f.event(8, 'running', 'reflect'); await f.event(8, 'done', 'reflect'); assert.equal(f.plays, 2);
  f.advance(); f.document.visibilityState = 'hidden'; f.document.hasFocus = () => true;
  await f.event(9, 'running'); await f.event(9, 'done'); assert.equal(f.plays, 3);
  f.advance(); await f.event(10, 'running'); f.run('resetCompletionSync()');
  await f.event(10, 'done'); f.run("syncCompletionSound([{id:11,status:'done'}])");
  await f.event(11, 'done'); assert.equal(f.plays, 3, 'reconnect replay suppressed');
  await f.event(12, 'running'); await f.event(12, 'done'); assert.equal(f.plays, 4);
});

test('sound preference, manual test and one-time muted unlock', async () => {
  const f = fixture('off');
  assert.equal(f.elements.obSound.checked, false);
  f.run('syncCompletionSound([])');
  await f.event(1, 'running'); await f.event(1, 'done'); assert.equal(f.plays, 0);
  f.listeners.get('pointerdown')();
  await f.elements.obSoundTest.click();
  assert.equal(f.plays, 1, 'manual test works even with preference off');
  assert.equal(f.listeners.size, 0);
  assert.equal(f.run('taskSound.muted'), false);
  assert.equal(f.run('taskSound.volume'), 0.6);
  f.elements.obSound.change({ target: { checked: true } }); assert.equal(f.saved, 'on');
  f.run('taskSound.play = () => Promise.reject(new Error("autoplay"))');
  await f.context.playTaskSound();
});
