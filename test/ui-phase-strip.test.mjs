// #479: every task card carries a thin phase strip along its bottom edge (app.js syncPhaseStrip): the job's steps as
// coloured segments, the current one pulsing in its phase's colour (the agent in the accent orange), a failed task's step
// in red; the Queue sheet's header has the colour legend. stripState is pulled out of app.js's source and checked on its
// own; the colours are checked in Chromium on the real index.html + app.css (no scripts) with the strip's functions
// injected, in light and dark. The browser part skips when Chromium can't launch.
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
const STRIP_SRC = [/^const el = .*?^};$/ms, /^function fmtDur\(.*?^}$/ms, /^const STRIP = .*?;$/ms, /^const STRIP_OF = .*$/m, /^const STRIP_LEGEND = .*?;$/ms,
  /^const stripTone = .*$/m, /^function stripDur\(.*?^}$/ms, /^function stripState\(.*?^}$/ms, /^function stripTitle\(.*?^}$/ms,
  /^function syncPhaseStrip\(.*?^}$/ms, /^function phaseLegend\(.*?^}$/ms].map(src).join('\n');
const pure = new Function(`${STRIP_SRC.replace(/^const el = .*?^};$/ms, '')}\nreturn { STRIP, stripState, stripTitle };`)();
const at = (st) => pure.STRIP[st.at][0];

test('stripState: where a task sits on the strip', () => {
  const now = Date.now() / 1000;
  assert.deepEqual([at(pure.stripState({ status: 'running', started_at: now - 30 }, { cls: 'running' })), pure.stripState({ status: 'running' }, { cls: 'running' }).state], ['running', 'cur']);
  assert.equal(at(pure.stripState({ status: 'running', phase: 'fetching', phase_at: Date.now() }, { cls: 'running' })), 'cloning');
  assert.equal(at(pure.stripState({ status: 'running', phase: 'checking', phase_at: Date.now() - 130_000 }, { cls: 'running' })), 'checking');
  assert.equal(pure.stripTitle(pure.stripState({ status: 'running', phase: 'checking', phase_at: Date.now() - 130_000 }, { cls: 'running' })), 'Checking · 2m 10s');
  const failed = pure.stripState({ status: 'failed', started_at: now - 99, finished_at: now, has_verify_failure: true }, { cls: 'failed' });
  assert.deepEqual([at(failed), failed.state], ['checking', 'failed']);
  assert.deepEqual([at(pure.stripState({ status: 'queued' }, { cls: 'limited' })), pure.stripState({ status: 'queued' }, { cls: 'limited' }).state], ['queued', 'limit']);
  assert.deepEqual([at(pure.stripState({ status: 'done', started_at: now - 60, finished_at: now }, { cls: 'done' })), pure.stripState({ status: 'done' }, { cls: 'done' }).state], ['done', 'done']);
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
  test(`UI (${scheme}): running agent pulses orange, a failed step is red, the legend is in the Queue header`, { skip: noBrowser }, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
    await page.route('http://app.test/**', (r) => {
      const f = path.join(PUB, new URL(r.request().url()).pathname);
      if (f.endsWith('.js') || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.abort();
      r.fulfill({ path: f });
    });
    await page.goto('http://app.test/index.html');
    await page.addScriptTag({ content: `${STRIP_SRC}\nwindow.S = { syncPhaseStrip, phaseLegend };` });
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
      const now = Date.now() / 1000;
      const run = card({ id: 1, status: 'running', started_at: now - 70 }, { cls: 'running' }).querySelector('.tc-strip');
      const fail = card({ id: 2, status: 'failed', started_at: now - 70, finished_at: now }, { cls: 'failed' }).querySelector('.tc-strip');
      const seg = (bar, cls) => bar.querySelector(`i.${cls}`);
      const cs = (n) => getComputedStyle(n);
      const legend = document.querySelector('#queueModal .m-head #qLegend');
      const r = run.getBoundingClientRect(), c = run.parentElement.getBoundingClientRect();
      return {
        runCur: seg(run, 'cur')?.dataset.phase, runBg: cs(seg(run, 'cur')).backgroundColor, runAnim: cs(seg(run, 'cur')).animationName,
        agent: rgb(root.getPropertyValue('--ph-agent')), accent: rgb(root.getPropertyValue('--accent')),
        failCls: seg(fail, 'failed')?.dataset.phase, failBg: cs(seg(fail, 'failed')).backgroundColor, red: rgb(root.getPropertyValue('--ph-failed')),
        faint: Number(cs(run.lastElementChild).opacity), title: run.title,
        height: r.height, inside: r.bottom < c.bottom && r.bottom > c.bottom - 8 && r.left > c.left && r.right < c.right,
        legend: legend ? [...legend.querySelectorAll('.lg')].map((l) => l.textContent) : null,
      };
    });
    assert.equal(got.runCur, 'running', 'a running agent is the current segment');
    assert.equal(got.runBg, got.agent);
    assert.equal(got.agent, got.accent, 'the agent phase is the accent orange');
    assert.equal(got.runAnim, 'tc-pulse');
    assert.equal(got.failCls, 'running');
    assert.equal(got.failBg, got.red);
    assert.ok(got.faint < 0.5, `future segments are faint (${got.faint})`);
    assert.match(got.title, /^Running agent · 1m 1\ds$/);
    assert.ok(got.height >= 3 && got.height <= 4 && got.inside, JSON.stringify(got));
    assert.deepEqual(got.legend, ['Queued', 'Preparing', 'Agent', 'Checking', 'Pushing / merging', 'Done', 'Failed', 'Waiting on limit']);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.tc-strip i.cur')).animationName), 'none', 'no pulse under reduced motion');
    await page.close();
  });
}
