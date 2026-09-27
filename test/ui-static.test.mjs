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
const appCss = read('public/app.css');

// Ids that app.js creates itself before looking them up with $(): qList is the queue sheet's list (renderQueue); the
// eff* ones are the effort menu's slider, Default toggle, tick labels and note (buildEffMenu).
const DYNAMIC_IDS = new Set(['qList', 'effRange', 'effDefault', 'effTicks', 'effNote']);

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
  assert.match(appJs, /el\('div', 'dr-shots-head', `Screenshots · \$\{shots\.length\}`\), shotGrid\(shots\)/, "drawer 'What happened' shows every screenshot");
  assert.doesNotMatch(appJs, /more under Details/);
  assert.match(appCss, /#drBody \.shots \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(76px, 1fr\)\)/, 'as a compact gallery');
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
  // No polling (owner, 2026-09-27: CPU): the modal loads on open and on a range change; limits refresh one agent on click.
  assert.doesNotMatch(appJs, /setInterval\(loadUsageHistory/, 'no live refresh timer');
  assert.match(appJs, /api\(`\/api\/limits\/\$\{usageSlides\.agent\}\/refresh`, 'POST'\)/, 'the card refreshes the one agent it shows');
  assert.match(appJs, /openConnections\(id\)/);
});

test('the model picker picks the primary model only; a Fallbacks button opens the shared sheet', () => {
  const fn = appJs.slice(appJs.indexOf('function renderAgentPicker()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.doesNotMatch(body, /AUTO_PICK|__auto/);
  assert.match(appJs, /send\(\{ t: 'send', cid: state\.cid, text \}\)/);
  assert.doesNotMatch(appJs, /autoDelegate|delegate\/preview|Forecast/);
  assert.match(indexHtml, /class="chip fb-chip" id="fbChip"/);
  assert.match(indexHtml, /class="modal fb-pop" id="fbModal"/);
  assert.match(appJs, /\/api\/convos\/\$\{cid\}\/fallbacks/);
  assert.match(appJs, /`If \$\{name\} hits its limit`/);
  assert.doesNotMatch(appJs, /Pinned:/);
  assert.match(appJs, /\/api\/orch\/tasks\/\$\{[^}]+\}\/delegate/);
  assert.match(appJs, /'Delegate…'/);
});

test('the orchestrator bar is a status word plus Queue and Pause only', () => {
  const bar = indexHtml.slice(indexHtml.indexOf('id="orchBar"'), indexHtml.indexOf('id="composer"'));
  assert.deepEqual([...bar.matchAll(/<button[^>]*id="(\w+)"/g)].map((m) => m[1]), ['obQueue', 'obPause']);
  assert.match(bar, /class="ob-dot"[\s\S]*id="obStatus"/);
  for (const gone of ['ob-icon', 'ob-title', 'obCounts', 'obLaneStrip', 'obLanes', 'lanes-compact', 'obSettingsBtn', 'obPop', 'ob-opt', 'closeObPop']) {
    assert.ok(!indexHtml.includes(gone) && !appJs.includes(gone) && !appCss.includes(gone), `${gone} removed`);
  }
  assert.doesNotMatch(bar, /[⏸▶]/, 'Pause/Resume are plain text');
  assert.doesNotMatch(appJs, /[⏸▶] (Pause|Resume)/);
  assert.match(appJs, /paused \? 'Paused' : running \? 'Running' : queued \? 'Waiting' : 'Idle'/);
  assert.match(appJs, /\$\('obQueueCount'\)\.hidden = !queued/);
  assert.match(appCss, /\.ob-pause \{ color: var\(--accent\); border-color: var\(--accent\); background: transparent;/);
});

test('the sidebar gear opens Settings: sound + MP3 upload, max parallel tasks, reflection model and fallbacks', () => {
  const side = indexHtml.slice(indexHtml.indexOf('id="sidebar"'), indexHtml.indexOf('</aside>'));
  assert.match(side, /id="settingsBtn"[^>]*aria-label="Settings"/);
  const sheet = indexHtml.slice(indexHtml.indexOf('id="settingsModal"'), indexHtml.indexOf('id="fbModal"'));
  assert.deepEqual([...sheet.matchAll(/class="st-sec"[^>]*>([^<]+)</g)].map((m) => m[1]), ['Sound', 'Tasks', 'Reflection', 'This project']);
  assert.match(sheet, /id="stSoundUpload"[\s\S]*id="stSoundFile" accept="audio\/mpeg,\.mp3"[\s\S]*id="stSound"[\s\S]*id="stParallel"[\s\S]*id="stReflectModel"[\s\S]*id="stReflectBtn"[\s\S]*id="stDirection"/);
  // Sound is one row: the switch, the current file, Test and Upload together.
  const sound = sheet.slice(sheet.indexOf('class="st-row st-sound"'), sheet.indexOf('class="st-sec">Tasks'));
  for (const id of ['stSound"', 'stSoundName', 'stSoundTest', 'stSoundUpload']) assert.ok(sound.includes(`id="${id}`), id);
  assert.equal((sound.match(/class="st-row/g) || []).length, 1);
  // Orchestrator Mode already means "keep improving": no toggle for it.
  assert.doesNotMatch(sheet + appJs, /stPerpetual|Keep improving/);
  assert.doesNotMatch(sheet, /stRank|stRoutes|Project priority|Routes/, 'no priority or routes rows in project settings');
  assert.match(appJs, /openFallbacks\(reflectFallbacks\(\), /);
  assert.match(appJs, /url: '\/api\/orch\/reflect-settings'/);
  assert.match(appJs, /fetch\('\/api\/settings\/sound', \{ method: 'POST'/);
  assert.match(appJs, /sound\?\.custom \? `\/api\/settings\/sound\?v=\$\{sound\.at\}` : DEFAULT_TASK_SOUND/);
});

test('the model picker has no Connections entry, opens upward on desktop, and the fallback chip names its models with usage dots', () => {
  assert.doesNotMatch(appJs, /CONNECT_PICK|'Connections…'|Sign in to more agents/);
  assert.match(indexHtml, /id="modelChip"[^>]*aria-controls="modelPop"[\s\S]*?<select id="model"[^>]*hidden[\s\S]*?id="modelPop" role="listbox"/);
  assert.match(appCss, /\.pop-wrap \.popover|\.popover \{\s*position: absolute; bottom: calc\(100% \+ 6px\)/, 'popovers open upward');
  assert.match(appJs, /el\('span', 'fb-arrow', '→'\), dot, el\('span', 'fb-name', fbName\(r\)\)/);
  assert.match(appJs, /return Math\.max\(\.\.\.known\) >= 100 \? 'limited' : Math\.max\(\.\.\.known\) >= 80 \? 'high' : 'ok'/);
  for (const k of ['ok', 'high', 'limited']) assert.match(appCss, new RegExp(`\\.fb-dot\\.${k} \\{ background: var\\(--`));
});

test('running and paused tasks: Pause/Resume on the card and in the drawer, Hand off reuses the delegate sheet', () => {
  assert.match(appJs, /case 'paused':[^\n]*\n\s*return \{ cls: 'paused', label: 'Paused by you' \}/);
  assert.match(appJs, /if \(t\.kind === 'work' && \['running', 'paused'\]\.includes\(t\.status\)\) tags\.append\(cardControl\(t\)\)/);
  assert.match(appJs, /api\(`\/api\/orch\/tasks\/\$\{id\}\/\$\{what\}`, 'POST', body\)/);
  assert.match(appJs, /el\('button', 'btn small', 'Hand off…'\)/);
  assert.match(appJs, /t && t\.status !== 'queued' \? await taskControl\(DG\.id, 'handoff'/);
  assert.match(appJs, /body\.append\(el\('h3', 'dg-group', 'Paused'\)\)/);
  assert.match(appCss, /\.tc-glyph\.paused::before/);
});

test('composer menus: mode, model and effort chips open compact .cmenu listboxes (no native pickers)', () => {
  for (const [chip, menu] of [['modeChip', 'modePop'], ['modelChip', 'modelPop'], ['effChip', 'effPop']]) {
    assert.match(indexHtml, new RegExp(`<button type="button" class="chip menu-chip[^"]*" id="${chip}" aria-haspopup="listbox" aria-controls="${menu}"`));
    assert.match(indexHtml, new RegExp(`<div class="cmenu[^"]*" id="${menu}" role="listbox"`));
    assert.match(appJs, new RegExp(`bindMenu\\(\\$\\('${chip}'\\), \\$\\('${menu}'\\)`));
  }
  // The selects stay as hidden value holders; the mode menu lists every one of its options.
  assert.match(indexHtml, /<select id="mode" aria-label="Permission mode" hidden/);
  assert.match(appJs, /for \(const o of \$\('mode'\)\.options\)/);
  // Effort is a slider inside the same compact menu: no dialog, title or explanation paragraphs.
  assert.match(appJs, /range\.id = 'effRange'/);
  for (const gone of ['effModal', 'effHint', 'effSub', 'eff-foot', 'finePointer', 'mp-opt']) {
    assert.ok(!indexHtml.includes(gone) && !appJs.includes(gone) && !appCss.includes(gone), `${gone} removed`);
  }
  assert.match(appCss, /\.cmenu \{ position: fixed;/);
  assert.match(appCss, /\.cm-opt\[aria-selected="true"\]::after \{ background: var\(--accent\);/);
});
