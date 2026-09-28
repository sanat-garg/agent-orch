// #452: the orchestrator bar's status reads 'Running X · Queue Y', 'Paused · Queue Y' or 'Idle', and the Queue button
// has no count of its own. orchBarStatus and renderOrchBar are pulled out of app.js's source (like version-ui.test) and
// run against a fake DOM fed the project counts an 'oproject'/'ostate' frame brings. The 390px layout check loads the
// real index.html + CSS (no scripts) in Chromium and skips when it can't launch.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../browser.mjs';
import { macChromiumEnv } from './helpers/mac-chromium.mjs';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const appJs = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const src = (re) => { const m = appJs.match(re); assert.ok(m, `app.js: ${re}`); return m[0]; };
const fns = [/^function orchBarStatus\(.*?^}$/ms, /^function renderOrchBar\(.*?^}$/ms].map(src).join('\n');

// A fake page: every element the bar touches, with the attributes renderOrchBar sets.
function harness() {
  const els = {};
  const node = () => ({ hidden: false, disabled: false, textContent: '', title: '', dataset: {}, attrs: {},
    classList: { toggle() {} }, setAttribute(k, v) { this.attrs[k] = v; }, querySelector() { return node(); } });
  const $ = (id) => (els[id] ||= node());
  $('mode').value = 'orchestrator';
  const O = { project: null, state: {} };
  const noop = () => {};
  const render = new Function('$', 'O', 'blurSwap', 'renderConnFoot', 'syncSidebarRunning', 'renderSettings',
    `let obTogglePending = null;\n${fns}\nreturn renderOrchBar;`)($, O, (n, t) => { n.textContent = t; }, noop, noop, noop);
  return { $, O, render };
}
const project = (counts, status = 'active') => ({ id: 1, status, counts: { done: 4, failed: 1, ...counts } });

test('3 running and 7 queued renders "Running 3 · Queue 7"', () => {
  const h = harness();
  h.O.project = project({ running: 3, queued: 7 });
  h.render();
  assert.equal(h.$('obStatus').textContent, 'Running 3 · Queue 7');
  assert.equal(h.$('obState').dataset.state, 'running');
  assert.equal(h.$('obQueue').hidden, false);
});

test('paused renders "Paused · Queue 7"', () => {
  const h = harness();
  h.O.project = project({ running: 3, queued: 7 }, 'paused');
  h.render();
  assert.equal(h.$('obStatus').textContent, 'Paused · Queue 7');
  assert.equal(h.$('obState').dataset.state, 'paused');
});

test('nothing running or queued renders "Idle"', () => {
  const h = harness();
  h.O.project = project({ running: 0, queued: 0 });
  h.render();
  assert.equal(h.$('obStatus').textContent, 'Idle');
  assert.equal(h.$('obState').dataset.state, 'idle');
  h.O.project = null; // no project yet
  h.render();
  assert.equal(h.$('obStatus').textContent, 'Idle');
});

test('a live update re-renders the counts; only queued work shows "Running 0 · Queue Y"', () => {
  const h = harness();
  h.O.project = project({ running: 3, queued: 7 });
  h.render();
  h.O.project = project({ running: 2, queued: 9 }); // the next 'oproject' frame
  h.render();
  assert.equal(h.$('obStatus').textContent, 'Running 2 · Queue 9');
  h.O.project = project({ running: 0, queued: 4 });
  h.render();
  assert.equal(h.$('obStatus').textContent, 'Running 0 · Queue 4');
  assert.equal(h.$('obState').dataset.state, 'waiting');
  // Both frames re-render the bar.
  assert.match(appJs, /msg\.t === 'oproject'[\s\S]{0,200}renderOrchBar\(\)/);
  assert.match(appJs, /msg\.t === 'ostate'[\s\S]{0,200}renderOrchBar\(\)/);
});

test('the Queue button has no count badge of its own; the numbers use tabular figures', () => {
  const bar = indexHtml.slice(indexHtml.indexOf('id="orchBar"'), indexHtml.indexOf('id="composer"'));
  assert.doesNotMatch(bar, /ob-badge|obQueueCount/);
  assert.doesNotMatch(appJs, /obQueueCount/);
  const css = fs.readFileSync(path.join(PUB, 'app.css'), 'utf8');
  assert.match(css, /#obStatus \{[^}]*font-variant-numeric: tabular-nums/);
});

let browser, noBrowser = false;
try { browser = await chromium.launch(); } catch {
  const mac = macChromiumEnv(); // the MacBook worker: Playwright's headless shell with the WindowManagement shim
  try { browser = await chromium.launch(mac.AGENT_ORCH_BROWSER_PATH ? { executablePath: mac.AGENT_ORCH_BROWSER_PATH, env: { ...process.env, DYLD_INSERT_LIBRARIES: mac.DYLD_INSERT_LIBRARIES } }
    : { executablePath: findBrowser() || undefined }); } catch (e) { noBrowser = `no Chromium: ${e.message.split('\n')[0]}`; }
}
after(() => browser?.close());

test('the longest likely status fits the bar at 390px beside Queue and Pause', { skip: noBrowser }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await page.route('http://app.test/**', (r) => {
    const f = path.join(PUB, new URL(r.request().url()).pathname);
    if (f.endsWith('.js') || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.abort();
    r.fulfill({ path: f });
  });
  await page.goto('http://app.test/index.html');
  for (const text of ['Running 12 · Queue 148', 'Paused · Queue 148']) {
    const m = await page.evaluate((text) => {
      for (const id of ['orchBar', 'obQueue', 'obPause']) document.getElementById(id).hidden = false;
      const s = document.getElementById('obStatus');
      s.textContent = text;
      const bar = document.getElementById('orchBar').getBoundingClientRect(), pause = document.getElementById('obPause').getBoundingClientRect();
      return { clipped: s.scrollWidth > s.clientWidth, barRight: bar.right, pauseRight: pause.right, width: innerWidth };
    }, text);
    assert.equal(m.clipped, false, `${text} is not cut off`);
    assert.ok(m.barRight <= m.width && m.pauseRight <= m.barRight, `${text}: bar fits 390px ${JSON.stringify(m)}`);
  }
  await page.close();
});
