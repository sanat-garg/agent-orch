// Static UI checks: app.js parses, every $('id') it looks up exists in index.html, and every local
// <script src>/<link href> in the HTML pages resolves to a file the server actually serves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const appJs = read('public/app.js');
const indexHtml = read('public/index.html');

// Ids that app.js creates itself before looking them up with $(): qList is the queue sheet's list (renderQueue).
const DYNAMIC_IDS = new Set(['qList']);

test('public/app.js parses', () => {
  assert.doesNotThrow(() => new vm.Script(appJs, { filename: 'public/app.js' }));
});

test("every $('id') in app.js exists in index.html", () => {
  const ids = new Set([...appJs.matchAll(/(?<![\w$.])\$\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2]));
  assert.ok(ids.size > 50, `expected many $() lookups, found ${ids.size}`);
  const htmlIds = new Set([...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !htmlIds.has(id) && !DYNAMIC_IDS.has(id));
  assert.deepEqual(missing, []);
});

test('every local <script src> and <link href> is served', () => {
  // Vendor files come from node_modules via server.mjs's VENDOR map; everything else from public/.
  const server = read('server.mjs');
  const vendor = Object.fromEntries([...server.matchAll(/'(\/vendor\/[^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
  assert.ok(Object.keys(vendor).length, 'VENDOR map not found in server.mjs');
  for (const page of ['public/index.html', 'public/login.html']) {
    const refs = [...read(page).matchAll(/<(?:script\b[^>]*\bsrc|link\b[^>]*\bhref)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length, `${page} has no script/link refs`);
    for (const ref of refs) {
      if (/^(?:[a-z]+:)?\/\//i.test(ref) || ref.startsWith('data:')) continue;
      const p = ref.split(/[?#]/)[0];
      const file = vendor[p] ? path.join(ROOT, vendor[p]) : path.join(ROOT, 'public', p);
      assert.ok(fs.existsSync(file), `${page}: ${ref} -> ${path.relative(ROOT, file)} missing`);
    }
  }
});

test('screenshots render as /api/media images in chat and in the task drawer', () => {
  assert.match(appJs, /const mediaUrl = \(id\) => `\/api\/media\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(appJs, /im\.src = mediaUrl\(img\.id\)/);
  assert.match(appJs, /case 'image':[^]*?shotNode\(ev\)/, 'chat renderEvent handles t:image');
  assert.match(appJs, /e\.k === 'image'\)[^]*?shotNode\(e\)/, 'drawer output renders k:image entries');
  assert.match(appJs, /shotGrid\(shots\.slice\(-4\)\)/, "drawer 'What happened' shows the latest 4");
  assert.match(indexHtml, /id="lightbox"/);
});

test('the sidebar usage card opens the Usage modal with per-agent charts', () => {
  assert.match(indexHtml, /<div class="modal" id="usageModal" hidden>/);
  assert.match(indexHtml, /class="ms-usage"[^>]*role="button"[^>]*tabindex="0"/, 'usage card is keyboard reachable');
  assert.match(indexHtml, /id="usageTitle">Usage</);
  assert.match(indexHtml, /id="usageRange"[^]*?data-range="24h"[^]*?data-range="7d"[^]*?data-range="30d"/);
  assert.match(appJs, /const usageCard = document\.querySelector\('\.ms-usage'\)/);
  assert.match(appJs, /usageCard\.addEventListener\('click', \(e\) => \{ if \(!e\.target\.closest\('#usRefresh'\)\) openUsage\(\); \}\)/, 'refresh button does not open the modal');
  assert.match(appJs, /e\.key !== 'Enter' && e\.key !== ' '/, 'Enter/Space open it');
  assert.match(appJs, /api\(`\/api\/usage\/history\?range=\$\{range\}`\)/);
  assert.match(appJs, /U\.timer = setInterval\(loadUsageHistory, 60e3\)/, 'live refresh while open');
  assert.match(appJs, /openConnections\(id\)/);
});

test("the model picker renders 'Auto Delegate' first and each message carries the choice", () => {
  const fn = appJs.slice(appJs.indexOf('function renderAgentPicker()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /el\('option', '', 'Auto Delegate'\)[\s\S]*?value = AUTO_PICK;[\s\S]*?sel\.append\(auto\);[\s\S]*for \(const a of AGENT_LIST\)/);
  assert.match(appJs, /send\(\{ t: 'send', cid: state\.cid, text, autoDelegate: autoPick\(\) \}\)/);
  assert.match(indexHtml, /id="apChip"/);
  assert.match(indexHtml, /class="modal sheet ap-pop" id="apModal"/);
  assert.match(appJs, /\/api\/delegate\/preview\?.*agent=/);
  assert.match(appJs, /\/api\/convos\/\$\{.*\}\/fallbacks.*PUT/);
  assert.doesNotMatch(appJs, /Pinned:/);
  assert.match(appJs, /\/api\/orch\/tasks\/\$\{[^}]+\}\/delegate/);
  assert.match(appJs, /'Delegate…'/);
});
