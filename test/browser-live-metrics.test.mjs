// The live view's page layout and home page (browser-live.mjs) against a fake Chromium that speaks just enough CDP: a
// view opens on the home page with the viewer's metrics (a phone below 768 px: mobile metrics, touch and a phone user
// agent, a screencast at up to 2× its size), a resize re-applies them and reloads on a phone/desktop switch, a static
// page still gets a first frame, the last size is kept for the next view, a task's page is never re-laid out, and the
// last tab closing opens a new one on the home page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createLiveBrowsers, homeUrl, viewMetrics, castSize, userAgent, isBlank, markActive } from '../browser-live.mjs';
import { profileDir } from '../browser.mjs';
import { createBrowserViews } from '../browser-view.mjs';
import { waitFor } from './helpers/wait.mjs';

let server, wss, tmp, home;
const calls = [];
let sock = null, targets = [], url = 'about:blank', nextTarget = 2;
const UA = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.7339.16 Safari/537.36';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-live-metrics-'));
  home = path.join(tmp, 'home');
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake` }));
  });
  wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    sock = ws;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      calls.push(m);
      const reply = (result = {}) => ws.send(JSON.stringify({ id: m.id, result }));
      const event = (method, params) => ws.send(JSON.stringify({ method, params, sessionId: m.sessionId }));
      switch (m.method) {
        case 'Browser.getVersion': return reply({ userAgent: UA });
        case 'Target.getTargets': return reply({ targetInfos: targets.map((targetId) => ({ targetId, type: 'page', url })) });
        case 'Target.createTarget': { const targetId = `T${nextTarget++}`; targets.push(targetId); url = 'about:blank'; return reply({ targetId }); }
        case 'Target.attachToTarget': return reply({ sessionId: `S-${m.params.targetId}` });
        case 'Page.getNavigationHistory': return reply({ entries: [{ id: 1, url, title: '' }], currentIndex: 0 });
        case 'Page.navigate': url = m.params.url; reply({ frameId: 'F' }); return event('Page.frameNavigated', { frame: { id: 'F', url } });
        case 'Page.captureScreenshot': return reply({ data: Buffer.from('jpeg').toString('base64') });
        default: return reply();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.mkdirSync(profileDir('default', home), { recursive: true });
});
after(() => { wss?.close(); server?.close(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const sent = (method, from = 0) => calls.slice(from).filter((c) => c.method === method).map((c) => c.params);
const last = (method, from) => sent(method, from).at(-1);
const indexOf = (method, from = 0) => calls.findIndex((c, i) => i >= from && c.method === method);

test('metrics, screencast size and user agent follow the viewer', () => {
  assert.equal(homeUrl(), process.env.AGENT_ORCH_BROWSER_HOME_URL ? homeUrl() : 'https://www.google.com/');
  assert.deepEqual(viewMetrics({ width: 390, height: 700, dpr: 3 }), { width: 390, height: 700, deviceScaleFactor: 2, mobile: true });
  assert.deepEqual(viewMetrics(null), { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(viewMetrics({ width: 1000, height: 600, dpr: 1 }).mobile, false);
  assert.deepEqual(castSize(viewMetrics({ width: 390, height: 700, dpr: 3 })), { maxWidth: 780, maxHeight: 1400 });
  const big = castSize(viewMetrics({ width: 2000, height: 1200, dpr: 2 }));
  assert.ok(big.maxWidth * big.maxHeight <= 2560 * 1600 + 4000 && big.maxWidth > 2000, JSON.stringify(big));
  assert.ok(!userAgent(UA, false).includes('Headless') && userAgent(UA, false).includes('Chrome/140'));
  assert.match(userAgent(UA, true), /Android.*Chrome\/140\.0\.0\.0 Mobile Safari/);
  for (const u of ['', 'about:blank', 'chrome://newtab/', 'chrome://new-tab-page/']) assert.ok(isBlank(u), u);
  assert.ok(!isBlank('https://www.google.com/'));
});

test('a view opens on the home page laid out for the viewer, and resizes follow it', { timeout: 30000 }, async () => {
  targets = ['T1']; url = 'about:blank';
  const frames = [], states = [];
  const m = createLiveBrowsers({ home, browser: async () => ({ ws: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake` }) });
  try {
    await m.start('default', { size: { width: 390, height: 700, dpr: 3 }, onFrame: (f) => frames.push(f), onState: (s) => states.push(s) });
    const o = last('Emulation.setDeviceMetricsOverride');
    assert.deepEqual([o.width, o.height, o.deviceScaleFactor, o.mobile], [390, 700, 2, true]);
    assert.deepEqual(last('Emulation.setTouchEmulationEnabled'), { enabled: true, maxTouchPoints: 5 });
    assert.match(last('Emulation.setUserAgentOverride').userAgent, /Mobile Safari/);
    assert.deepEqual(last('Page.startScreencast'), { format: 'jpeg', quality: 60, maxWidth: 780, maxHeight: 1400 });
    // about:blank goes home, after the metrics are in place (so the first load already has the phone layout).
    assert.equal(last('Page.navigate').url, homeUrl());
    assert.ok(indexOf('Emulation.setDeviceMetricsOverride') < indexOf('Page.navigate'));
    assert.equal(sent('Page.reload').length, 0, 'no reload for the first load');
    await waitFor(() => states.some((s) => s.url === homeUrl()), { timeout: 5000, message: 'the URL shows the home page' });
    // Nothing repaints: a screenshot stands in for the first frame, in the page's CSS px.
    await waitFor(() => frames.length > 0, { timeout: 5000, message: 'a first frame' });
    assert.deepEqual([frames[0].w, frames[0].h], [390, 700]);
    // Screencast frames carry the page's CSS size, which the viewer maps clicks through.
    sock.send(JSON.stringify({ method: 'Page.screencastFrame', sessionId: 'S-T1', params: { data: 'AAAA', sessionId: 7, metadata: { deviceWidth: 390, deviceHeight: 700 } } }));
    await waitFor(() => frames.length > 1, { timeout: 5000, message: 'a screencast frame' });
    assert.deepEqual([frames.at(-1).w, frames.at(-1).h], [390, 700]);
    await waitFor(() => sent('Page.screencastFrameAck').length > 0, { timeout: 5000, message: 'the frame is acked' });

    // Rotated or moved to a desktop: desktop metrics, no touch, a desktop user agent without "Headless", a new
    // screencast size, and the page reloads for its desktop layout.
    const from = calls.length;
    assert.equal(await m.resize('default', { width: 1200, height: 700, dpr: 1 }), true);
    const d = last('Emulation.setDeviceMetricsOverride', from);
    assert.deepEqual([d.width, d.height, d.deviceScaleFactor, d.mobile], [1200, 700, 1, false]);
    assert.deepEqual(last('Emulation.setTouchEmulationEnabled', from), { enabled: false });
    assert.equal(last('Emulation.setUserAgentOverride', from).userAgent, UA.replace('HeadlessChrome', 'Chrome'));
    assert.equal(sent('Page.stopScreencast', from).length, 1);
    assert.deepEqual(last('Page.startScreencast', from), { format: 'jpeg', quality: 60, maxWidth: 1200, maxHeight: 700 });
    assert.equal(sent('Page.reload', from).length, 1, 'a phone/desktop switch reloads');
    // The same size again changes nothing; a new height alone doesn't reload.
    const again = calls.length;
    await m.resize('default', { width: 1200, height: 700, dpr: 1 });
    assert.equal(sent('Emulation.setDeviceMetricsOverride', again).length, 0);
    await m.resize('default', { width: 1200, height: 640, dpr: 1 });
    assert.equal(last('Emulation.setDeviceMetricsOverride', again).height, 640);
    assert.equal(sent('Page.reload', again).length, 0);

    // The last tab closes: a new one opens on the home page and the view follows it.
    targets = [];
    const closed = calls.length;
    sock.send(JSON.stringify({ method: 'Target.targetDestroyed', params: { targetId: 'T1' } }));
    await waitFor(() => sent('Page.navigate', closed).length > 0, { timeout: 5000, message: 'a new tab goes home' });
    assert.equal(last('Page.navigate', closed).url, homeUrl());
    assert.equal(sent('Target.createTarget', closed).length, 1);
    m.stop('default');

    // The next view keeps the last size …
    const next = calls.length;
    await m.start('default', {});
    assert.equal(last('Emulation.setDeviceMetricsOverride', next).width, 1200);
    m.stop('default');
    // … unless a task is using the profile: then its page keeps its own layout (the agent may be clicking it).
    const done = markActive('default', home);
    try {
      const busy = calls.length;
      await m.start('default', {});
      assert.equal(sent('Emulation.setDeviceMetricsOverride', busy).length, 0, 'the task\'s page is not re-laid out');
      await m.resize('default', { width: 390, height: 700, dpr: 3 });
      assert.equal(sent('Emulation.setDeviceMetricsOverride', busy).length, 0, 'not even for a viewer\'s new size');
      await waitFor(() => sent('Page.startScreencast', busy).length > 0, { timeout: 5000, message: 'it still streams' });
      assert.equal(sent('Page.navigate', busy).length, 0, 'the task\'s page is left alone');
      m.stop('default');
    } finally { done(); }
  } finally { await m.close(); }
});

test('the head sizes the page for the controlling viewer, else the one sized last; thumbnails never size it', async () => {
  const starts = [], sizes = [];
  const local = { home, start: async (identity, { size }) => { starts.push(size); }, resize: async (identity, size) => { sizes.push(size); return true; },
    stop() { return true; }, profiles: async () => [], close() {} };
  const views = createBrowserViews({ send() {}, local });
  const A = { name: 'A' }, B = { name: 'B' }, C = { name: 'C' };
  const say = (ws, msg) => views.handle(ws, { node: 'controller', identity: 'default', ...msg });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  try {
    say(A, { t: 'bv_open', size: { width: 390, height: 700, dpr: 3 } });
    await settle();
    assert.deepEqual(starts, [{ width: 390, height: 700, dpr: 3 }], 'the page opens at the viewer\'s size');
    say(B, { t: 'bv_open', thumb: true, size: { width: 300, height: 200, dpr: 1 } });
    say(A, { t: 'bv_size', size: { width: 844, height: 360, dpr: 3 } });
    await settle();
    assert.deepEqual(sizes, [{ width: 844, height: 360, dpr: 3 }], 'a rotation re-sizes it; the thumbnail doesn\'t');
    say(A, { t: 'bv_size', size: { width: 844, height: 360, dpr: 3 } });
    say(A, { t: 'bv_size', size: { width: 50, height: 50 } });
    say(C, { t: 'bv_open', size: { width: 1200, height: 700, dpr: 2 } });
    await settle();
    assert.equal(sizes.length, 1, 'the same size, a bogus one and a watcher change nothing while A drives');
    say(A, { t: 'bv_close' });
    await settle();
    assert.deepEqual(sizes.at(-1), { width: 1200, height: 700, dpr: 2 }, 'the next viewer in control sizes it');
  } finally { await views.close(); }
});
