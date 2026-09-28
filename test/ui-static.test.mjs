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
  assert.match(appJs, /send\(\{ t: 'send', cid: state\.cid, text, \.\.\.\(attachments\.length && \{ attachments \}\) \}\)/);
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

test('the sidebar gear opens Settings: sound + MP3 upload, parallel tasks (what can run, a cap), per-project reflection', () => {
  const side = indexHtml.slice(indexHtml.indexOf('id="sidebar"'), indexHtml.indexOf('</aside>'));
  assert.match(side, /id="settingsBtn"[^>]*aria-label="Settings"/);
  const sheet = indexHtml.slice(indexHtml.indexOf('id="settingsModal"'), indexHtml.indexOf('id="fbModal"'));
  const sections = [...sheet.matchAll(/class="st-sec"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(sections, ['Sound', 'Tasks', 'Agents', 'This project']);
  // Skills & tools is one row (a summary line) that opens the sheet, whose tabs hold the four kinds.
  assert.deepEqual([...sheet.matchAll(/data-ext-open="(\w+)"/g)].map((m) => m[1]), ['skills']);
  assert.match(sheet, /id="stExtSummary"/);
  assert.match(sheet, /<div class="modal sheet" id="extModal" hidden>[\s\S]*role="tablist"[\s\S]*id="extBody" role="tabpanel"/);
  assert.match(sheet, /id="stSoundUpload"[\s\S]*id="stSoundFile" accept="audio\/mpeg,\.mp3"[\s\S]*id="stSound"[\s\S]*id="stParallel"[\s\S]*id="stReflectModel"[\s\S]*id="stReflectBtn"[\s\S]*id="stDirection"/);
  // Sound is one row: the switch, the current file, Test and Upload together.
  const sound = sheet.slice(sheet.indexOf('class="st-row st-sound"'), sheet.indexOf('class="st-sec">Tasks'));
  for (const id of ['stSound"', 'stSoundName', 'stSoundTest', 'stSoundUpload']) assert.ok(sound.includes(`id="${id}`), id);
  assert.equal((sound.match(/class="st-row/g) || []).length, 1);
  // Orchestrator Mode already means "keep improving": no toggle for it.
  assert.doesNotMatch(sheet + appJs, /stPerpetual|Keep improving/);
  // Reflection is per project and one row: the model and its fallbacks together, inside This project.
  const project = sheet.slice(sheet.indexOf('id="stProject"'));
  const reflect = project.slice(project.indexOf('class="st-row st-reflect"'), project.indexOf('st-dir'));
  assert.ok(reflect.includes('id="stReflectModel"') && reflect.includes('id="stReflectBtn"'));
  assert.match(appJs, /\/api\/orch\/projects\/\$\{O\.project\.id\}\/reflect-settings/);
  // Parallel tasks: a live readout and a cap, not a 1-or-2 choice.
  assert.match(sheet, /id="stParHint"/);
  assert.doesNotMatch(sheet, /1 \(recommended\)|Max parallel tasks/);
  assert.match(appJs, /saveParallel\(\{ maxTasks: /);
  assert.doesNotMatch(sheet, /stRank|stRoutes|Project priority|Routes/, 'no priority or routes rows in project settings');
  assert.match(appJs, /openFallbacks\(reflectFallbacks\(\), /);
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

test('server details: Top processes sits in the metric grid right after the six cards, two cards wide on desktop', () => {
  assert.match(appJs, /tile\('load', 'Load average'\),\n\s*\$\('mTopCard'\),/);
  assert.match(indexHtml, /id="mTopCard"[\s\S]*?class="m-top-scroll"><table class="m-table" id="mTop">/);
  assert.match(appCss, /@media \(min-width: 801px\) \{\n\s*\.m-grid > \.m-top \{ grid-column: span 2; \}/);
  assert.match(appCss, /\.m-top-scroll \{[^}]*contain: size;/, 'the list scrolls inside the row instead of stretching it');
});

test('top bar keeps its 56px content row below the iPhone safe-area inset (UI-REVIEW #1)', () => {
  const topbars = appCss.match(/\.topbar \{[^}]*\}/g);
  assert.equal(topbars.length, 2, 'base rule and the max-width: 800px rule');
  for (const r of topbars) {
    assert.match(r, /height: calc\(56px \+ env\(safe-area-inset-top, 0px\)\)/);
    assert.match(r, /padding-top: env\(safe-area-inset-top\)/);
  }
});

test('composer follows the on-screen keyboard via visualViewport and --kb (UI-REVIEW #2)', () => {
  assert.match(appJs, /visualViewport\.addEventListener\(ev/);
  assert.match(appJs, /setProperty\('--kb'/);
  assert.match(appJs, /classList\.toggle\('kb-open'/);
  assert.match(appCss, /\.app \{ height: calc\(100dvh - var\(--kb, 0px\)\); \}/);
  assert.match(appCss, /html\.kb-open \.orch-bar \{ display: none; \}/);
});

test('inline code pills clone across lines, 44pt tool rows on touch, system-font time cells (UI-REVIEW #15, #16)', () => {
  assert.match(appCss, /\.msg\.text code \{[^}]*box-decoration-break: clone/);
  assert.match(appCss, /@media \(pointer: coarse\) \{ \.tool > summary \{ min-height: 44px; \} \}/);
  for (const sel of ['.aw-list time', '.dr-events time']) {
    const rule = appCss.match(new RegExp(`${sel.replace('.', '\\.')} \\{[^}]*\\}`))[0];
    assert.ok(!rule.includes('var(--mono)'), `${sel} uses the system font`);
    assert.match(rule, /font-variant-numeric: tabular-nums/);
  }
});

test('phones get 16px body copy and 12px-minimum metadata (UI-REVIEW #7)', () => {
  // Top-level `@media (max-width: 600px) { ... }` bodies, brace-matched; later rules win, like the cascade.
  const sizes = new Map();
  for (const m of appCss.matchAll(/@media \(max-width: 600px\) \{/g)) {
    let i = m.index + m[0].length, depth = 1;
    const start = i;
    for (; depth; i++) depth += appCss[i] === '{' ? 1 : appCss[i] === '}' ? -1 : 0;
    for (const r of appCss.slice(start, i - 1).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const px = r[2].match(/font-size:\s*([\d.]+)px/);
      if (px) for (const sel of r[1].split(',')) sizes.set(sel.trim(), Number(px[1]));
    }
  }
  for (const sel of ['.msg.text', '.tcard', '.convo .ct', '.dr-summary']) assert.equal(sizes.get(sel), 16, `${sel} is 16px on phones`);
  for (const sel of ['.tc-tag', '.ms-age', '.ms-open', '.ms-note', '.cn-step.muted', '.att-size', '.fb-pop .m-head h2']) {
    assert.ok(sizes.get(sel) >= 12, `${sel} is at least 12px on phones (got ${sizes.get(sel)})`);
  }
  // the block sits after every base rule it overrides (same specificity: the later rule wins)
  const block = appCss.lastIndexOf('.fb-pop .m-head h2 { font-size: 12px; }');
  for (const base of ['.att-size { font-size: 11.5px', '.fb-pop .m-head h2 { font-size: 11px', '.tc-tag { font-size: 11.5px']) {
    assert.ok(appCss.indexOf(base) < block, `${base} comes before the phone block`);
  }
});

test('top-level function names are unique across the classic public/*.js scripts (a later one silently wins)', () => {
  const seen = new Map();
  const dups = [];
  for (const f of ['app.js', 'files.js', 'stats.js', 'ext.js', 'browser.js']) {
    for (const m of read(`public/${f}`).matchAll(/^(?:async )?function\s*\*?\s*([\w$]+)\s*\(/gm)) {
      if (seen.has(m[1])) dups.push(`${m[1]} (${seen.get(m[1])}, ${f})`);
      else seen.set(m[1], f);
    }
  }
  assert.deepEqual(dups, [], `duplicate top-level functions: ${dups.join('; ')}`);
  // the sidebar project drag and the Queue sheet card drag each call their own mover
  assert.match(appJs, /^function dragMove\(y\)/m);
  assert.match(appJs, /liftCard\(card, y0\); dragMove\(ev\.clientY\)/);
  assert.match(appJs, /^function qDragMove\(\)/m);
  assert.match(appJs, /return qDragMove\(\);/);
});
