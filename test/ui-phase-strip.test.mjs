// #479/#497/#501: every task card carries a quiet phase strip along its bottom edge (app.js syncPhaseStrip), the compact form
// of the drawer Timeline's phaseBar: one segment per step, as wide as the time it took (the queue wait, then the run's
// phase_log), a vertical milestone line at each phase boundary (phases − 1 of them, where the time says), the live step
// with a gentle shimmer (none under reduced motion); a failed step in brick, a limit wait in ochre. Colours are muted
// --ph-* vars tuned for light and dark; on cards the track is ≤ 3px, milestones 1px hairlines, dimmed until hovered.
// stripSegs is pulled out of app.js's source and checked on its own; the rendering is checked in Chromium on the real
// index.html + app.css (no scripts) with the strip's functions injected, in light and dark. The browser part skips when
// Chromium can't launch.
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
const appCss = fs.readFileSync(path.join(PUB, 'app.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const src = (re) => { const m = appJs.match(re); assert.ok(m, `app.js: ${re}`); return m[0]; };
const STRIP_SRC = [/^const el = .*?^};$/ms, /^function fmtDur\(.*?^}$/ms, /^const PHASE_LABEL = .*?;$/ms, /^const STRIP_LEGEND = .*?;$/ms,
  /^const stripTone = .*$/m, /^function stripDur\(.*?^}$/ms, /^const PH_LOG = .*$/m, /^function stripSegs\(.*?^}$/ms, /^function phaseBar\(.*?^}$/ms,
  /^function syncPhaseStrip\(.*?^}$/ms, /^function phaseLegend\(.*?^}$/ms,
  /^function section\(.*?^}$/ms, /^const PHASE_NAME = .*$/m, /^const ERROR_KIND = .*$/m, /^const OUTCOME_TEXT = .*$/m, /^function timelineSection\(.*?^}$/ms].map(src).join('\n');
const pure = new Function(`${STRIP_SRC.replace(/^const el = .*?^};$/ms, '')}\nreturn { stripSegs, stripDur };`)();
const S = 1000;

test('stripSegs: each step as long as it took, the live one last', () => {
  const now = Date.now(), started = now - 300 * S;
  const t = { id: 1, status: 'running', created_at: (started - 100 * S) / S, started_at: started / S, phase: 'checking', phase_at: now - 60 * S,
    phase_log: [['running', started], ['checking', now - 60 * S]] };
  const segs = pure.stripSegs(t, { cls: 'running' });
  assert.deepEqual(segs.map((g) => [g.phase, Math.round(g.ms / S), g.cls || '']), [['queued', 100, ''], ['running', 240, ''], ['checking', 60, 'cur']]);
  assert.ok(Math.abs(segs[2].since - (now - 60 * S)) < 50, 'the live step grows from when it began');
  // A remote run: the queue wait and the worker's own queue merge into one Queued segment.
  const remote = pure.stripSegs({ ...t, id: 2, phase_log: [['queued', started], ['cloning', started + 5 * S], ['running', started + 20 * S]] }, { cls: 'running' });
  assert.deepEqual(remote.map((g) => [g.phase, Math.round(g.ms / S)]), [['queued', 105], ['cloning', 15], ['running', 280]]);
  // Finished: the log seen while it ran, the failed step in brick; done gets a green end cap; a limit wait is ochre.
  const failed = pure.stripSegs({ ...t, status: 'failed', finished_at: now / S, phase_log: null }, { cls: 'failed' });
  assert.deepEqual(failed.map((g) => [g.phase, g.cls || '']), [['queued', ''], ['running', ''], ['checking', 'bad']]);
  const done = pure.stripSegs({ id: 3, status: 'done', created_at: (started - 10 * S) / S, started_at: started / S, finished_at: now / S }, { cls: 'done' });
  assert.deepEqual(done.map((g) => g.phase), ['queued', 'running', 'done']);
  assert.equal(pure.stripSegs({ id: 4, status: 'queued', created_at: now / S - 30 }, { cls: 'limited' })[0].cls, 'limit');
  assert.equal(pure.stripSegs({ ...t, id: 5, waiting_for: 'Mac mini (connection lost)' }, { cls: 'running' }).at(-1).cls, 'limit');
  assert.equal(pure.stripDur(252), '4m 12s');
});

test('the drawer Timeline and the cards share one phaseBar (cards in compact mode)', () => {
  assert.match(src(/^function timelineSection\(.*?^}$/ms), /phaseBar\(el\('div', 'tl-bar'\), segs, \{ name: /);
  assert.match(src(/^function syncPhaseStrip\(.*?^}$/ms), /phaseBar\(bar, stripSegs\(t, s\), \{ compact: true \}\)/);
  assert.equal(appJs.match(/classList\.add\('ph-bar'\)/g)?.length, 1);
});

// The palette: every phase colour defined for light (:root) and dark (the prefers-color-scheme block), muted (HSL
// saturation ≤ 50%), and tuned separately for each.
const hsl = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  return { s: max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1)), l };
};
const PH = ['queued', 'prep', 'agent', 'check', 'ship', 'done', 'failed', 'limit'];
const vars = (block) => Object.fromEntries(PH.map((k) => [k, block.match(new RegExp(`--ph-${k}:\\s*(#[0-9a-f]{6});`, 'i'))?.[1]]));
test('muted phase palette vars exist for both themes', () => {
  const light = vars(appCss.match(/^:root \{.*?^\}/ms)[0]), dark = vars(appCss.match(/^@media \(prefers-color-scheme: dark\) \{\n  :root \{.*?^  \}/ms)[0]);
  for (const [theme, set] of [['light', light], ['dark', dark]]) {
    for (const k of PH) {
      assert.ok(set[k], `--ph-${k} in ${theme}`);
      assert.ok(hsl(set[k]).s <= 0.5, `--ph-${k} (${theme}) ${set[k]} is muted: saturation ${hsl(set[k]).s.toFixed(2)}`);
    }
  }
  assert.ok(PH.every((k) => light[k].toLowerCase() !== dark[k].toLowerCase()), 'each colour is tuned per theme');
  assert.ok(PH.every((k) => hsl(dark[k]).l < hsl(light[k]).l), 'dark keeps the contrast subtle (darker tones)');
  assert.doesNotMatch(appCss, /tc-pulse/, 'no pulsing');
});

test('the Queue sheet has a slot for the legend and app.js fills it', () => {
  assert.match(indexHtml, /<div id="qLegend"><\/div>/);
  assert.match(appJs, /\$\('qLegend'\)\.replaceWith\(Object\.assign\(phaseLegend\(\), \{ id: 'qLegend' \}\)\)/);
});

let browser, noBrowser = false;
try { browser = await chromium.launch(); } catch {
  const mac = macChromiumEnv(); // the MacBook worker: Playwright's headless shell with the WindowManagement shim
  try { browser = await chromium.launch(mac.AGENT_ORCH_BROWSER_PATH ? { executablePath: mac.AGENT_ORCH_BROWSER_PATH, env: { ...process.env, DYLD_INSERT_LIBRARIES: mac.DYLD_INSERT_LIBRARIES } }
    : { executablePath: findBrowser() || undefined }); } catch (e) { noBrowser = `no Chromium: ${e.message.split('\n')[0]}`; }
}
after(() => browser?.close());

for (const scheme of ['light', 'dark']) {
  test(`UI (${scheme}): proportional compact strip with milestone hairlines, shimmering live step, same bar as the drawer Timeline`, { skip: noBrowser }, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
    await page.route('http://app.test/**', (r) => {
      const f = path.join(PUB, new URL(r.request().url()).pathname);
      if (f.endsWith('.js') || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.abort();
      r.fulfill({ path: f });
    });
    await page.goto('http://app.test/index.html');
    await page.addScriptTag({ content: `${STRIP_SRC}\nwindow.S = { syncPhaseStrip, phaseLegend, timelineSection };` });
    const got = await page.evaluate(() => {
      const q = document.getElementById('queueModal');
      q.hidden = false;
      document.getElementById('qLegend').replaceWith(Object.assign(S.phaseLegend(), { id: 'qLegend' }));
      const card = (t, s) => {
        const b = document.createElement('button');
        b.className = 'tcard';
        b.textContent = `#${t.id}`;
        document.getElementById('qBody').append(b);
        S.syncPhaseStrip(b, t, s);
        return b;
      };
      const root = getComputedStyle(document.documentElement), rgb = (v) => { const d = document.createElement('i'); d.style.color = v; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; };
      const now = Date.now(), started = now - 300_000;
      const run = card({ id: 1, status: 'running', created_at: (started - 100_000) / 1000, started_at: started / 1000, phase: 'checking', phase_at: now - 60_000,
        phase_log: [['running', started], ['checking', now - 60_000]] }, { cls: 'running' }).querySelector('.tc-strip');
      const fail = card({ id: 2, status: 'failed', started_at: started / 1000, finished_at: now / 1000 }, { cls: 'failed' }).querySelector('.tc-strip');
      const cs = (n) => getComputedStyle(n);
      const legend = document.querySelector('#queueModal .m-head #qLegend');
      const r = run.getBoundingClientRect(), c = run.parentElement.getBoundingClientRect();
      // The drawer's Timeline for a remote run in the same phases.
      const tl = S.timelineSection({ phases: [{ phase: 'queued', at: started - 100_000, ms: 100_000 }, { phase: 'running', at: started, ms: 240_000 }, { phase: 'checking', at: now - 60_000 }] }, true);
      document.body.append(tl);
      const tlBar = tl.querySelector('.tl-bar');
      const segs = (bar) => [...bar.querySelectorAll(':scope > i')].map((i) => ({ phase: i.dataset.phase, w: i.getBoundingClientRect().width, h: i.getBoundingClientRect().height,
        bg: cs(i).backgroundColor, cls: i.className, radius: cs(i).borderRadius }));
      // Milestone lines: where each stands along the bar (0..1), its drawn line's size, and its tooltip.
      const ms = (bar) => { const b = bar.getBoundingClientRect(); return [...bar.querySelectorAll(':scope > b.ph-ms')].map((m) => {
        const line = getComputedStyle(m, '::before'), at = m.getBoundingClientRect().left;
        return { x: (at - b.left) / b.width, lineW: parseFloat(line.width), lineH: parseFloat(line.height), trackH: bar.querySelector('i').getBoundingClientRect().height,
          phase: m.dataset.phase, cls: m.className, title: m.title, between: m.previousElementSibling?.tagName === 'I' && m.nextElementSibling?.tagName === 'I' };
      }); };
      return {
        card: segs(run), cardW: r.width, drawer: segs(tlBar), drawerW: tlBar.getBoundingClientRect().width, cardMs: ms(run), drawerMs: ms(tlBar),
        compact: [run.classList.contains('ph-compact'), tlBar.classList.contains('ph-compact')],
        dot: [cs(tlBar.querySelector('i.cur'), '::after').content, cs(run.querySelector('i.cur'), '::after').content],
        vars: Object.fromEntries(['queued', 'agent', 'check', 'failed'].map((k) => [k, rgb(root.getPropertyValue(`--ph-${k}`))])),
        failBg: cs(fail.lastElementChild).backgroundColor, failCls: fail.lastElementChild.className,
        curAnim: cs(run.querySelector('i.cur')).animationName, title: run.title,
        height: run.querySelector('i').getBoundingClientRect().height, inside: r.bottom < c.bottom && r.bottom > c.bottom - 6 && r.left > c.left && r.right < c.right,
        dim: Number(cs(run).opacity), legend: legend ? [...legend.querySelectorAll('.lg')].map((l) => l.textContent) : null,
      };
    });
    const ratios = [100, 240, 60].map((x) => x / 400);
    for (const [bar, w] of [[got.card, got.cardW], [got.drawer, got.drawerW]]) {
      assert.deepEqual(bar.map((g) => g.phase), ['queued', 'running', 'checking']);
      bar.forEach((g, n) => assert.ok(Math.abs(g.w / w - ratios[n]) <= 0.02, `${g.phase}: ${(g.w / w).toFixed(3)} of the bar, want ${ratios[n]} (±2%)`));
    }
    assert.deepEqual(got.card.map((g) => g.bg), [got.vars.queued, got.vars.agent, got.vars.check], 'phase colours from the --ph-* vars');
    assert.deepEqual(got.drawer.map((g) => g.bg), got.card.map((g) => g.bg), 'the drawer Timeline looks the same');
    assert.deepEqual(got.drawer.map((g) => g.radius), got.card.map((g) => g.radius), 'rounded track ends on both');
    assert.deepEqual(got.compact, [true, false], 'cards use the compact mode, the drawer the full one');
    // Milestones: phases − 1 lines, each between two segments, at the boundary the time puts it (100/400, 340/400).
    const bounds = [100 / 400, 340 / 400];
    for (const [name, lines] of [['card', got.cardMs], ['drawer', got.drawerMs]]) {
      assert.equal(lines.length, 3 - 1, `${name}: one milestone per phase boundary`);
      lines.forEach((m, n) => {
        assert.ok(m.between, `${name}: milestone ${n} sits between two segments`);
        assert.ok(Math.abs(m.x - bounds[n]) <= 0.02, `${name}: milestone ${n} at ${m.x.toFixed(3)}, want ${bounds[n].toFixed(3)} (±2%)`);
        assert.ok(m.lineH > m.trackH, `${name}: the milestone line stands through the track (${m.lineH} > ${m.trackH})`);
      });
      assert.deepEqual(lines.map((m) => [m.phase, m.cls]), [['running', 'ph-ms'], ['checking', 'ph-ms cur']], 'the live phase\'s milestone is marked');
    }
    assert.deepEqual(got.cardMs.map((m) => m.lineW), [1, 1], 'hairlines on cards');
    assert.ok(got.drawerMs.every((m) => m.lineW > 1 && m.lineH >= 10), 'full-size ticks in the drawer');
    assert.equal(got.drawerMs[1].title, 'Check · from 5m 40s', 'the tooltip names the step and when it began');
    assert.equal(got.cardMs[0].title, 'Agent · from 1m 40s');
    assert.ok(got.drawer.every((g) => g.h >= 4) && got.card.every((g) => g.h <= 3), 'a thicker track in the drawer, 2-3px on cards');
    assert.notEqual(got.dot[0], 'none', 'the drawer marks now with a dot');
    assert.ok(['none', 'normal'].includes(got.dot[1]), 'no dot on cards');
    assert.deepEqual(got.card.map((g) => g.cls), ['', '', 'cur']);
    assert.equal(got.curAnim, 'ph-shimmer');
    assert.equal(got.failCls, 'bad');
    assert.equal(got.failBg, got.vars.failed);
    assert.equal(got.title, 'Queued 1m 40s · Agent 4m 0s · Checking 1m 0s');
    assert.ok(got.height > 0 && got.height <= 3 && got.inside, JSON.stringify({ height: got.height, inside: got.inside }));
    assert.ok(got.dim < 1, `dimmed when not hovered (${got.dim})`);
    await page.evaluate(() => document.getElementById('splash')?.remove()); // no app script runs to dismiss it
    await page.locator('.tcard').first().hover();
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.tc-strip')).opacity), '1', 'full strength on hover');
    assert.deepEqual(got.legend, ['Queued', 'Preparing', 'Agent', 'Checking', 'Pushing / merging', 'Done', 'Failed', 'Waiting on limit']);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.tc-strip i.cur')).animationName), 'none', 'no shimmer under reduced motion');
    await page.close();
  });
}
