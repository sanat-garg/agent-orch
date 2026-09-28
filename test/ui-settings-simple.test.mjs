// Settings (#481): one sound switch (each machine's sound is chosen in Machines) and no About section; the switch
// alone still decides whether a finished task plays. Static checks on index.html plus app.js's sound code in a vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (f) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const html = read('index.html'), appJs = read('app.js'), css = read('app.css');
const sheet = html.slice(html.indexOf('id="settingsModal"'), html.indexOf('<!-- Skills & tools'));

test('Settings has exactly one sound control, a switch, with a hint pointing to Machines', () => {
  const controls = [...sheet.matchAll(/<(input|select|button|textarea)\b[^>]*>/g)].map((m) => m[0]);
  const sound = controls.filter((c) => /sound/i.test(c));
  assert.equal(sound.length, 1, sound.join('\n'));
  assert.match(sound[0], /<input type="checkbox" class="st-switch" id="stSound" role="switch"/);
  assert.match(sheet, /<strong>Play a sound when a task finishes<\/strong><small id="stSoundHint">Choose each machine's sound in Machines<\/small>/);
  assert.doesNotMatch(sheet, /type="file"|type="range"|Upload MP3|Add custom sound|volume/i);
  // The per-machine picker (and its custom-sound form) stays in Machines.
  assert.match(appJs, /row\(manage, 'Finish sound', 'Plays when a task finishes here', machineSoundPicker\(n\)\)/);
  assert.doesNotMatch(appJs, /renderSoundList|stSoundList|stSoundAdd|stSoundUpload|stSoundTest/);
});

test('no About section; the version under the logo keeps its details in the tooltip', () => {
  assert.doesNotMatch(sheet, /About|stAbout|ab-line|abRunning|abRestart/);
  assert.doesNotMatch(css, /\.st-about|\.ab-line|\.ab-pending/);
  assert.match(html, /<button type="button" class="side-ver" id="sideVer" hidden><\/button>/);
  assert.match(appJs, /VER\.about = aboutLines\(d\)/);
  assert.match(appJs, /a \? \[a\.running, a\.restarted, a\.pending\]\.filter\(Boolean\)\.join\('\\n'\) : sideVerTip\(r\)/);
});

test('Settings groups its rows under at most 5 headings, each with a one-line hint', () => {
  const heads = [...sheet.matchAll(/<h3 class="st-sec"[^>]*>([^<]+)<\/h3>\s*<p class="st-hint">([^<]+)<\/p>/g)];
  assert.equal(heads.length, (sheet.match(/class="st-sec"/g) || []).length, 'every heading has a hint');
  assert.ok(heads.length <= 5, `${heads.length} headings`);
  assert.deepEqual(heads.map((m) => m[1]), ['Alerts', 'Tasks', 'Browser', 'Agents', 'This project']);
});

function fixture(saved = null) {
  let plays = 0;
  const elements = { stSound: { addEventListener(type, fn) { this[type] = fn; } } };
  const document = { visibilityState: 'hidden', hasFocus: () => false, addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ document, performance: { now: () => 0 },
    $: (id) => elements[id], store: { get: () => saved, set: (_, v) => { saved = v; } },
    api: async () => ({ sound: { custom: false } }), toast() {},
    Audio: class { play() { if (!this.muted) plays++; return Promise.resolve(); } pause() {} } });
  vm.runInContext(appJs.split('// ---------- task completion sound ----------')[1].split('// ---------- WebSocket ----------')[0], context);
  return { context, elements, get plays() { return plays; }, get saved() { return saved; },
    async finish(id) { context.observeTaskCompletion({ id, status: 'running', kind: 'work' }); context.observeTaskCompletion({ id, status: 'done', kind: 'work' }); await Promise.resolve(); } };
}

test('toggling the switch controls playback and is remembered', async () => {
  const f = fixture();
  assert.equal(f.elements.stSound.checked, true, 'on by default');
  f.context.syncCompletionSound([]);
  await f.finish(1);
  assert.equal(f.plays, 1);
  f.elements.stSound.checked = false;
  f.elements.stSound.change({ target: { checked: false } });
  assert.equal(f.saved, 'off');
  await f.finish(2);
  assert.equal(f.plays, 1, 'off: silent');
  const g = fixture('off');
  assert.equal(g.elements.stSound.checked, false, 'the saved choice comes back');
  g.context.syncCompletionSound([]);
  await g.finish(3);
  assert.equal(g.plays, 0);
  g.elements.stSound.checked = true;
  g.elements.stSound.change({ target: { checked: true } });
  assert.equal(g.saved, 'on');
  await g.finish(4);
  assert.equal(g.plays, 1, 'on again: it plays');
});
