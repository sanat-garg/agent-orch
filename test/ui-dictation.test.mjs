// Composer dictation (app.js DICT): boots server.mjs (CW_NO_ORCHESTRATOR=1, temp data dir) and swaps the browser's speech
// recogniser for a fake (addInitScript) the test drives with window.__say / __fail. Desktop: the mic beside send listens
// (continuous, interim, navigator.language), interim then final words land after the typed text, the field grows, and
// sending stops it; tapping again, 30 s of silence (shortened here) and errors stop it too. Phones: the '+' sheet's
// Dictate row starts it and the mic shows in the field only while listening; #input never gets focus. Without the API the
// button and row are gone. Skips when Chromium can't launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'dictation-password';

// A stand-in webkitSpeechRecognition: every instance goes on window.__recs; __say([[text, isFinal], …]) delivers the
// session's whole result list (as the real one does), __fail(code) an error; stop/abort end it like the real one.
const FAKE_SPEECH = () => {
  window.__recs = [];
  class FakeRec {
    constructor() { this.started = this.stopped = this.aborted = false; window.__recs.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; setTimeout(() => this.onend?.(), 0); }
    abort() { this.aborted = true; setTimeout(() => { this.onerror?.({ error: 'aborted' }); this.onend?.(); }, 0); }
  }
  delete window.SpeechRecognition;
  window.webkitSpeechRecognition = FakeRec;
  const live = () => window.__recs.at(-1);
  window.__say = (list) => live().onresult({ resultIndex: 0, results: list.map(([t, f]) => Object.assign([{ transcript: t, confidence: 1 }], { isFinal: f })) });
  window.__fail = (error) => { const r = live(); r.onerror({ error }); r.onend?.(); };
};
const NO_SPEECH = () => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; };

let browser, skip = false;
try { browser = await chromium.launch({ env: { ...process.env, ...macChromiumEnv() } }); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-dictation-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const cwd = path.join(dataDir, 'p', 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: 'c0', title: 'Chat 0', cwd, mode: 'chat',
    agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true }]));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(viewport, touch = true, speech = true) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name, value, url: base }]);
  // Catch chat sends in the page (window.__sent) so no agent is started.
  await ctx.addInitScript(() => {
    window.__sent = [];
    const raw = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      try { const m = JSON.parse(d); if (m.t === 'send') return void window.__sent.push(m); } catch {}
      return raw.call(this, d);
    };
  });
  await ctx.addInitScript(speech ? FAKE_SPEECH : NO_SPEECH);
  const page = await ctx.newPage();
  const errors = [];
  // A macOS head's Server details charts can't read load averages (renderMetrics): not the composer's concern.
  page.on('pageerror', (e) => { if (!/renderMetrics/.test(e.stack)) errors.push(e.message); });
  await page.goto(`${base}/#c0`);
  await page.locator('#app:not([inert]) #input').waitFor();
  await page.waitForFunction(() => state.ws?.readyState === 1);
  return { ctx, page, errors };
}

const mic = (page) => page.evaluate(() => {
  const b = document.getElementById('micBtn'), r = b.getBoundingClientRect();
  return { pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'), shown: r.width > 0 && r.height > 0,
    w: r.width, h: r.height, anim: getComputedStyle(b).animationName, bg: getComputedStyle(b).backgroundColor };
});
const toastText = (page) => page.locator('#toasts .toast-msg').last().textContent();

test('desktop: interim then final words land after the typed text, and sending stops dictation', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 1280, height: 800 }, false);
  let m = await mic(page);
  assert.deepEqual([m.shown, m.pressed, m.label], [true, 'false', 'Dictate']);
  const send = await page.locator('#send').boundingBox(), mb = await page.locator('#micBtn').boundingBox();
  assert.ok(mb.x + mb.width <= send.x && send.x - (mb.x + mb.width) <= 12 && Math.abs(mb.y + mb.height / 2 - (send.y + send.height / 2)) <= 1, 'just left of send');
  await page.locator('#input').fill('Fix');
  await page.locator('#micBtn').click();
  m = await mic(page);
  assert.deepEqual([m.pressed, m.label, m.anim], ['true', 'Stop dictation', 'mic-pulse'], 'listening: pressed, labelled to stop, pulsing');
  assert.equal(m.bg, 'rgb(215, 0, 21)', 'red');
  const rec = await page.evaluate(() => { const r = window.__recs[0]; return { started: r.started, continuous: r.continuous, interim: r.interimResults, lang: r.lang, nav: navigator.language }; });
  assert.deepEqual(rec, { started: true, continuous: true, interim: true, lang: rec.nav, nav: rec.nav });

  const h0 = (await page.locator('#input').boundingBox()).height;
  await page.evaluate(() => window.__say([['the login', false]]));
  assert.equal(await page.locator('#input').inputValue(), 'Fix the login', 'interim text shows live');
  await page.evaluate(() => window.__say([['the login bug', true]]));
  assert.equal(await page.locator('#input').inputValue(), 'Fix the login bug', 'the final replaces it');
  const long = ' and then check every page of the settings sheet on a narrow phone screen, line by line, so nothing overflows sideways or hides under the keyboard';
  await page.evaluate((long) => window.__say([['the login bug', true], [long, false]]), long);
  assert.equal(await page.locator('#input').inputValue(), 'Fix the login bug' + long, 'later words follow the kept ones');
  assert.ok((await page.locator('#input').boundingBox()).height > h0, 'the field grows as when typing');
  assert.equal(await page.locator('#send').isEnabled(), true);

  await page.locator('#send').click();
  await page.waitForFunction(() => window.__sent.length === 1);
  assert.equal((await page.evaluate(() => window.__sent))[0].text, 'Fix the login bug' + long);
  assert.equal(await page.evaluate(() => window.__recs[0].aborted), true, 'sending stops the recogniser');
  m = await mic(page);
  assert.deepEqual([m.pressed, m.label], ['false', 'Dictate']);
  await page.evaluate(() => window.__say([['late words', true]]));
  assert.equal(await page.locator('#input').inputValue(), '', 'nothing lands after sending');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('desktop: tapping again, silence and errors stop it', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 1280, height: 800 }, false);
  // Tap again: the recogniser stops, and words it was still finishing go in.
  await page.locator('#micBtn').click();
  await page.locator('#micBtn').click();
  assert.equal(await page.evaluate(() => window.__recs[0].stopped), true);
  assert.equal((await mic(page)).pressed, 'false');
  await page.locator('#micBtn').click(); // the fake ends a stopped session at once, so deliver its last words in the same tick
  await page.evaluate(() => { document.getElementById('micBtn').click(); window.__say([['hello', true]]); });
  assert.equal(await page.locator('#input').inputValue(), 'hello');

  // Silence (30 s; shortened here) stops it.
  await page.evaluate(() => { DICT.silence = 150; });
  await page.locator('#micBtn').click();
  await page.waitForFunction(() => window.__recs[2].stopped);
  assert.equal((await mic(page)).pressed, 'false');

  // Permission errors get the one plain message; others name the error. Both reset the button.
  await page.locator('#micBtn').click();
  await page.evaluate(() => window.__fail('not-allowed'));
  assert.equal(await toastText(page), 'Microphone access is off for this site');
  assert.deepEqual([(await mic(page)).pressed, (await mic(page)).label], ['false', 'Dictate']);
  await page.locator('#micBtn').click();
  await page.evaluate(() => window.__fail('service-not-allowed'));
  assert.equal(await toastText(page), 'Microphone access is off for this site');
  await page.locator('#micBtn').click();
  await page.evaluate(() => window.__fail('network'));
  assert.match(await toastText(page), /network/);
  assert.equal((await mic(page)).pressed, 'false');
  await page.locator('#micBtn').click();
  assert.equal((await mic(page)).pressed, 'true', 'and it starts again');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test("390px: the + sheet's Dictate row starts it, the mic shows only while listening, and #input is never focused", { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  assert.equal((await mic(page)).shown, false, 'no mic in the phone field until listening');
  await page.locator('#plusBtn').tap();
  const row = page.locator('#plusSheet [data-plus="dictate"]');
  await row.waitFor();
  assert.equal(await row.locator('.ps-l').textContent(), 'Dictate');
  assert.ok((await row.boundingBox()).height >= 44);
  await row.tap();
  await page.locator('#plusSheet').waitFor({ state: 'hidden' });
  const m = await mic(page);
  assert.deepEqual([m.shown, m.pressed, m.label], [true, 'true', 'Stop dictation']);
  assert.ok(m.w >= 44 && m.h >= 44, `44pt target: ${m.w}×${m.h}`);
  assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'input', 'no keyboard pops up');
  const [mb, send, field] = await Promise.all(['#micBtn', '#send', '#composer .box'].map((s) => page.locator(s).boundingBox()));
  assert.ok(mb.x + mb.width <= send.x && mb.x >= field.x && Math.abs(mb.y + mb.height / 2 - (send.y + send.height / 2)) <= 1, 'beside send, in the field');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'nothing overflows');
  await page.evaluate(() => window.__say([['add dark mode', true]]));
  assert.equal(await page.locator('#input').inputValue(), 'add dark mode');
  await page.locator('#plusBtn').tap();
  assert.equal(await row.locator('.ps-l').textContent(), 'Stop dictation');
  await page.keyboard.press('Escape');
  await page.locator('#micBtn').tap();
  assert.equal(await page.evaluate(() => window.__recs[0].stopped), true);
  assert.equal((await mic(page)).shown, false, 'the mic leaves the field once stopped');
  await ctx.close();
  assert.deepEqual(errors, []);
});

test('without the Speech API the mic and the Dictate row are hidden', { skip, timeout: 60000 }, async () => {
  const desk = await open({ width: 1280, height: 800 }, false, false);
  assert.equal(await desk.page.locator('#micBtn').isVisible(), false);
  await desk.ctx.close();
  const phone = await open({ width: 390, height: 844 }, true, false);
  await phone.page.locator('#plusBtn').tap();
  await phone.page.locator('#plusSheet').waitFor();
  assert.deepEqual(await phone.page.locator('#plusSheet .ps-row:visible .ps-l').allTextContents(), ['Photo', 'File', 'Permission mode', 'Effort']);
  await phone.ctx.close();
  assert.deepEqual([...desk.errors, ...phone.errors], []);
});
