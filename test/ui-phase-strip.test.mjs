// #507: the drawer's Timeline is the original #229 .tl-bar again (one 6px bar, a segment per step taking its share of the
// time, 2px surface gaps between them as the milestone marks; done steps --tl-done, the step in progress --run with a
// pulse (none under reduced motion), the failed one --danger; the .tl-steps list under it), and every task card (and the
// Machines star's mini cards) carries the same .tl-bar in compact form: 3px, 1px gaps, no step list, just above the card's
// bottom border, its tooltip listing the steps with their times and the current step.
// stripSegs is pulled out of app.js's source and checked on its own; the rendering is checked in Chromium on the real
// index.html + app.css (no scripts) with the bar's functions injected, in light and dark. The browser part skips when
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
const STRIP_SRC = [/^const el = .*?^};$/ms, /^function fmtDur\(.*?^}$/ms, /^const PHASE_LABEL = .*?;$/ms,
  /^function stripDur\(.*?^}$/ms, /^const PH_LOG = .*$/m, /^function stripSegs\(.*?^}$/ms, /^function syncPhaseStrip\(.*?^}$/ms,
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

test('the #229 .tl-bar is back: CSS exactly as it was, the phase palette and milestone bar gone', () => {
  const rule = (sel) => { const m = appCss.match(new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm')); assert.ok(m, `app.css: ${sel}`); return m[1].trim(); };
  assert.equal(rule('.tl-bar'), '--tl-done: #8a867c; display: flex; gap: 2px; height: 6px; margin: 2px 0 8px;');
  assert.match(appCss, /@media \(prefers-color-scheme: dark\) \{ \.tl-bar \{ --tl-done: #7c786f; \} \}/);
  assert.equal(rule('.tl-bar i'), 'min-width: 3px; background: var(--tl-done);');
  assert.equal(rule('.tl-bar i.cur'), 'background: var(--run); animation: pulse 1.6s ease-in-out infinite;');
  assert.equal(rule('.tl-bar i.bad'), 'background: var(--danger);');
  assert.equal(rule('.tl-bar.compact'), 'height: 3px; gap: 1px; margin: 0;');
  assert.match(appCss, /prefers-reduced-motion: reduce\) \{ \.tl-bar i\.cur[^{]*\{ animation: none; \}/);
  assert.doesNotMatch(appCss, /--ph-|\.ph-bar|ph-shimmer|\.tc-strip|\.tc-legend|data-tone/, 'no #497/#501 leftovers in app.css');
  assert.doesNotMatch(appJs, /phaseBar|ph-bar|ph-compact|phaseLegend|STRIP_LEGEND|stripTone|tc-strip|qLegend/, 'no #497/#501 leftovers in app.js');
  assert.doesNotMatch(indexHtml, /qLegend/);
  assert.match(src(/^function timelineSection\(.*?^}$/ms), /el\('div', 'tl-bar'\)/);
  assert.match(src(/^function syncPhaseStrip\(.*?^}$/ms), /el\('span', 'tl-bar compact'\)/);
});

let browser, noBrowser = false;
try { browser = await chromium.launch(); } catch {
  const mac = macChromiumEnv(); // the MacBook worker: Playwright's headless shell with the WindowManagement shim
  try { browser = await chromium.launch(mac.AGENT_ORCH_BROWSER_PATH ? { executablePath: mac.AGENT_ORCH_BROWSER_PATH, env: { ...process.env, DYLD_INSERT_LIBRARIES: mac.DYLD_INSERT_LIBRARIES } }
    : { executablePath: findBrowser() || undefined }); } catch (e) { noBrowser = `no Chromium: ${e.message.split('\n')[0]}`; }
}
after(() => browser?.close());

for (const scheme of ['light', 'dark']) {
  test(`UI (${scheme}): the drawer's 6px .tl-bar with 2px gaps and its step list; the cards' 3px .tl-bar.compact`, { skip: noBrowser }, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
    await page.route('http://app.test/**', (r) => {
      const f = path.join(PUB, new URL(r.request().url()).pathname);
      if (f.endsWith('.js') || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.abort();
      r.fulfill({ path: f });
    });
    await page.goto('http://app.test/index.html');
    await page.addScriptTag({ content: `${STRIP_SRC}\nwindow.S = { syncPhaseStrip, timelineSection };` });
    const got = await page.evaluate(() => {
      document.getElementById('splash')?.remove();
      document.getElementById('queueModal').hidden = false;
      const card = (t, s) => {
        const b = document.createElement('button');
        b.className = 'tcard';
        b.textContent = `#${t.id}`;
        document.getElementById('qBody').append(b);
        S.syncPhaseStrip(b, t, s);
        return b;
      };
      const cs = (n) => getComputedStyle(n);
      const rgb = (v) => { const d = document.createElement('i'); d.style.color = v; document.body.append(d); const c = cs(d).color; d.remove(); return c; };
      const now = Date.now(), started = now - 300_000;
      const runCard = card({ id: 1, status: 'running', created_at: (started - 100_000) / 1000, started_at: started / 1000, phase: 'checking', phase_at: now - 60_000,
        phase_log: [['running', started], ['checking', now - 60_000]] }, { cls: 'running' });
      const failCard = card({ id: 2, status: 'failed', created_at: (started - 100_000) / 1000, started_at: started / 1000, finished_at: now / 1000 }, { cls: 'failed' });
      const run = runCard.querySelector('.tl-bar'), fail = failCard.querySelector('.tl-bar');
      const host = document.createElement('div');
      host.style.cssText = 'width: 360px; background: var(--bg)';
      document.body.append(host);
      const tl = S.timelineSection({ phases: [{ phase: 'queued', at: started - 100_000, ms: 100_000 }, { phase: 'running', at: started, ms: 240_000 }, { phase: 'checking', at: now - 60_000 }] }, true);
      const tlBad = S.timelineSection({ phases: [{ phase: 'running', at: started, ms: 240_000 }, { phase: 'checking', at: now - 60_000, ms: 60_000 }, { phase: 'done', at: now, outcome: 'failed' }] }, false);
      host.append(tl, tlBad);
      const bar = tl.querySelector('.tl-bar');
      const segs = (b) => [...b.children].map((i) => ({ tag: i.tagName, w: i.getBoundingClientRect().width, l: i.getBoundingClientRect().left, r: i.getBoundingClientRect().right,
        h: i.getBoundingClientRect().height, bg: cs(i).backgroundColor, cls: i.className, anim: cs(i).animationName }));
      const box = (b) => ({ w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height, gap: cs(b).columnGap, bottom: b.getBoundingClientRect().bottom });
      return {
        drawer: segs(bar), drawerBox: box(bar), drawerCls: bar.className, steps: [...tl.querySelectorAll('.tl-steps li')].map((l) => [l.className, l.textContent]),
        bad: segs(tlBad.querySelector('.tl-bar')).map((g) => g.cls),
        card: segs(run), cardBox: box(run), cardCls: run.className, cardSteps: runCard.querySelectorAll('.tl-steps').length,
        cardBottom: runCard.getBoundingClientRect().bottom, title: run.title, fail: segs(fail),
        vars: { done: rgb(cs(bar).getPropertyValue('--tl-done')), run: rgb('var(--run)'), danger: rgb('var(--danger)') },
      };
    });
    const ratios = [100, 240, 60].map((x) => x / 400);
    // The drawer: one <i> per step, 6px, 2px gaps between them, widths in proportion to the time.
    assert.equal(got.drawerCls, 'tl-bar');
    assert.deepEqual(got.drawer.map((g) => g.tag), ['I', 'I', 'I']);
    assert.equal(got.drawerBox.h, 6);
    assert.equal(got.drawerBox.gap, '2px');
    assert.ok(got.drawer.every((g) => g.h === 6));
    for (let n = 1; n < got.drawer.length; n++) assert.ok(Math.abs(got.drawer[n].l - got.drawer[n - 1].r - 2) < 0.5, 'a 2px gap between segments');
    const inner = got.drawerBox.w - 2 * 2;
    got.drawer.forEach((g, n) => assert.ok(Math.abs(g.w / inner - ratios[n]) <= 0.02, `drawer step ${n}: ${(g.w / inner).toFixed(3)} of the bar, want ${ratios[n]} (±2%)`));
    assert.deepEqual(got.drawer.map((g) => g.cls), ['', '', 'cur']);
    assert.deepEqual(got.drawer.map((g) => g.bg), [got.vars.done, got.vars.done, got.vars.run], 'done steps --tl-done, the current one --run');
    assert.equal(got.drawer[2].anim, 'pulse');
    assert.deepEqual(got.steps.map(([c, t]) => [c, t.split(/\d/)[0]]), [['', 'Queued'], ['', 'Agent'], ['cur', 'Check']], 'the .tl-steps list, the current step marked');
    assert.deepEqual(got.bad, ['', 'bad'], 'the step a run failed in is .bad');
    // The cards: the same bar, compact (3px, 1px gaps), no step list, just above the card's bottom border.
    assert.equal(got.cardCls, 'tl-bar compact');
    assert.equal(got.cardSteps, 0);
    assert.equal(got.cardBox.h, 3);
    assert.equal(got.cardBox.gap, '1px');
    assert.ok(got.cardBottom - got.cardBox.bottom >= 1 && got.cardBottom - got.cardBox.bottom <= 4, `just above the bottom border (${got.cardBottom - got.cardBox.bottom}px)`);
    const cardInner = got.cardBox.w - 2 * 1;
    got.card.forEach((g, n) => assert.ok(Math.abs(g.w / cardInner - ratios[n]) <= 0.02, `card step ${n}: ${(g.w / cardInner).toFixed(3)}, want ${ratios[n]} (±2%)`));
    assert.deepEqual(got.card.map((g) => g.cls), ['', '', 'cur']);
    assert.deepEqual(got.card.map((g) => g.bg), [got.vars.done, got.vars.done, got.vars.run]);
    assert.deepEqual(got.fail.map((g) => g.cls), ['', 'bad'], 'queued, then the agent step it failed in');
    assert.equal(got.fail.at(-1).bg, got.vars.danger, 'a failed step in --danger');
    assert.equal(got.title, 'Queued 1m 40s · Agent 4m 0s · Checking 1m 0s\nNow: Checking', 'the tooltip lists the steps and names the current one');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.tl-bar i.cur')].map((i) => getComputedStyle(i).animationName)), ['none', 'none'], 'no pulse under reduced motion');
    await page.close();
  });
}
