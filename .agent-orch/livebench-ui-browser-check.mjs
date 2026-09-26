import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
const base='http://127.0.0.1:3998';
const browser=await chromium.launch();
try {
 for(const width of [1280,375]) {
  const page=await browser.newPage({viewport:{width,height:812}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  for(const state of ['real','unmatched','stale','unavailable','loading','owner','owner-stale']) {
   const {d,engine}=await(await fetch(`${base}/data?state=${state}`)).json();
   await page.goto(`${base}/?state=${state}`);
   assert.deepEqual(await page.locator('.fe-list .fe-row').evaluateAll(rows=>rows.map(r=>r.dataset.key)),engine.map(r=>r.agent+'/'+r.model));
   assert.equal(await page.locator('details').getAttribute('open'),null);
   await page.locator('summary').click();
   const text=await page.locator('#apBody').innerText();
   assert.match(text,/LiveBench/);assert.doesNotMatch(text,/Artificial Analysis|API key|Open Connections/);
   if(state==='real') {assert.match(text,/benchmark release 2026-06-25 · fresh/);assert.ok(d.candidates.some(r=>r.benchmark));for(const r of d.candidates.filter(r=>r.score!=null)) assert.ok(text.includes(r.score.toFixed(1)));}
   if(state.includes('stale')) {assert.match(text,/stale; scores are not used/);assert.equal(await page.locator('.fe-score').count(),0);}
   if(state==='unavailable') assert.match(text,/LiveBench unavailable/);
   if(state==='loading') assert.match(text,/Loading LiveBench scores/);
   if(state==='unmatched') assert.match(text,/Unscored for ranking/);
   if(state.startsWith('owner')) {assert.match(text,/Uses your saved order/);assert.doesNotMatch(text,/same agent first/);}
   const bounds=await page.evaluate(()=>({doc:document.documentElement.scrollWidth,body:document.querySelector('#apBody').clientWidth,scroll:document.querySelector('#apBody').scrollWidth}));
   assert.ok(bounds.doc<=width);assert.ok(bounds.scroll<=bounds.body);
   console.log(JSON.stringify({width,state,order:engine.map(r=>r.model),...bounds}));
   execFileSync(process.execPath,['bin/shot.mjs',`${base}/?state=${state}&details`,`.agent-orch/shots/livebench-ui-${state}-${width}.png`,`--width=${width}`,'--height=812']);
  }
  execFileSync(process.execPath,['bin/shot.mjs',base,`.agent-orch/shots/livebench-ui-compact-${width}.png`,`--width=${width}`,'--height=812']);
  assert.deepEqual(errors,[]);await page.close();
 }
} finally {await browser.close();}
