// #465: every Machine settings row (app.js machineSettings' row helper) lays its label and hint out beside or above its
// control, never under it: at 1280px and 390px, light and dark, no label or hint overlaps the control, the control stays
// inside its row, the text keeps its 12rem column (no one-word-a-line wrapping), the sound picker's select and ▶ Test
// share a line, and at 1280px every hint takes at most 2 lines. Loads the real index.html + app.css (no scripts) in
// Chromium, runs app.js's machine-settings section in the page against stubs and mounts the cards where the app does
// (this server's details in the wide #nodeModal). Skips when Chromium can't launch.
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
const section = appJs.split('// ----- machine settings')[1]?.split('// ----- cluster diagram')[0].replace(/^.*/, '');

let browser, noBrowser = false;
try { browser = await chromium.launch(); } catch {
  const mac = macChromiumEnv(); // the MacBook worker: Playwright's headless shell with the WindowManagement shim
  try { browser = await chromium.launch(mac.AGENT_ORCH_BROWSER_PATH ? { executablePath: mac.AGENT_ORCH_BROWSER_PATH, env: { ...process.env, DYLD_INSERT_LIBRARIES: mac.DYLD_INSERT_LIBRARIES } }
    : { executablePath: findBrowser() || undefined }); } catch (e) { noBrowser = `no Chromium: ${e.message.split('\n')[0]}`; }
}
after(() => browser?.close());

const FANFARE = 'custom:0123456789abcdef01234567';
const NODES = [
  { id: 'controller', name: 'sanats-MacBook-Pro.local', os: 'darwin', local: true, connected: true, enabled: true, draining: false, used: 0, head: { cores: 12 } },
  { id: 'n1', name: "Sanat's MacBook Pro (Studio)", os: 'darwin', connected: true, enabled: true, draining: false, used: 1, maxSlots: null, policy: { keepAwake: 'always' } },
  { id: 'n2', name: 'build-vps', os: 'linux', connected: true, enabled: true, draining: true, used: 0, maxSlots: 6, update: { state: 'failed' } },
  { id: 'n3', name: 'old-mini', os: 'darwin', connected: false, enabled: false, draining: false, used: 0, maxSlots: 2, policy: { keepAwake: 'never' } },
];

// The page's stubs for what the section reads from the rest of app.js, then one card per node with its settings open.
function mount({ section, nodes, fanfare }) {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  Object.assign(window, {
    $, el, MC: { open: new Set(nodes.map((n) => n.id)), pings: new Map(), soundAdd: null },
    plural: (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`, api: async () => ({}), toast() {}, loadMachines() {}, renderMachines() {}, pingNode() {}, playSound() {},
    canUpdate: (n) => n.id === 'n1', openUpdateAll() {},
    MACHINE_SOUNDS: { chime: { label: 'Chime' }, bell: { label: 'Bell' }, pop: { label: 'Pop' } },
    completionSound: { custom: { sounds: [{ key: fanfare, name: 'Victory fanfare from the old arcade cabinet' }, { key: 'custom:fedcba9876543210fedcba98', name: 'Soft marimba ding (long version)' }] } },
    machineFallback: (id) => (id === 'controller' ? 'chime' : 'bell'), machineSound: (id) => (id === 'n1' ? fanfare : id === 'controller' ? 'chime' : 'bell'),
  });
  (0, eval)(section);
  $('ndBody').append($('serverDetails'));
  $('nodeModal').querySelector('.modal-panel').classList.add('wide');
  $('nodeModal').hidden = false;
  $('mMachines').replaceChildren(...nodes.map((n) => {
    const li = el('li', 'm-card mc-node');
    li.dataset.node = n.id;
    li.append(el('div', 'mc-top', n.name), window.machineSettings(n));
    return li;
  }));
}

// Every row's geometry: its label, hint and control boxes, the text column's width and the hint's line count.
function measure() {
  const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  return [...document.querySelectorAll('#mMachines .mc-row')].map((row) => {
    const hint = row.querySelector('.mc-rh'), pick = row.querySelector('.mc-sound-pick');
    return {
      node: row.closest('.mc-node').dataset.node, label: row.querySelector('.mc-rl').textContent, row: box(row), text: box(row.querySelector('.mc-rt')),
      parts: [row.querySelector('.mc-rl'), hint].map(box), control: box(row.lastElementChild),
      hintLines: Math.round(hint.getBoundingClientRect().height / parseFloat(getComputedStyle(hint).lineHeight)),
      pick: pick && [...pick.children].map(box),
    };
  });
}

const overlap = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5;

for (const [width, scheme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']]) {
  test(`machine settings rows at ${width}px (${scheme}): no text under a control, no squeezed text${width === 1280 ? ', hints ≤ 2 lines' : ''}`, { skip: noBrowser }, async () => {
    assert.ok(section, 'app.js has a "// ----- machine settings" section before the cluster diagram');
    const phone = width < 600;
    const page = await browser.newPage({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: scheme, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('http://app.test/**', (r) => {
      const f = path.join(PUB, new URL(r.request().url()).pathname);
      if (f.endsWith('.js') || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.abort();
      r.fulfill({ path: f });
    });
    await page.goto('http://app.test/index.html');
    await page.evaluate(mount, { section, nodes: NODES, fanfare: FANFARE });
    const rows = await page.evaluate(measure);
    assert.deepEqual(errors, []);
    assert.ok(rows.length >= 20, `every card's rows render (${rows.length})`);
    assert.ok(rows.some((r) => r.label === 'Finish sound' && r.node === 'n1'), 'the Mac with the long custom sound is there');
    for (const r of rows) {
      const where = `${r.node} · ${r.label}`;
      for (const p of r.parts) assert.ok(!overlap(p, r.control), `${where}: text ${JSON.stringify(p)} overlaps its control ${JSON.stringify(r.control)}`);
      assert.ok(r.control.l >= r.row.l - 0.5 && r.control.r <= r.row.r + 0.5, `${where}: the control stays inside its row ${JSON.stringify([r.control, r.row])}`);
      assert.ok(r.text.w >= Math.min(192, r.row.w) - 1, `${where}: the text keeps its 12rem column (${r.text.w}px of ${r.row.w}px)`);
      if (width === 1280) assert.ok(r.hintLines <= 2, `${where}: its hint takes ${r.hintLines} lines`);
      if (r.pick) {
        const [sel, btn] = r.pick;
        assert.ok(Math.abs(sel.t - btn.t) < 8 && sel.r <= btn.l, `${where}: the select and ▶ Test share one line ${JSON.stringify(r.pick)}`);
        assert.ok(btn.r <= r.row.r + 0.5, `${where}: ▶ Test stays inside the row`);
      }
    }
    await page.close();
  });
}
