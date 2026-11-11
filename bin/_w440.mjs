import { chromium } from 'playwright-core';
const routes = process.argv.slice(2);
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 1 });
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto('http://localhost:8790/?sim#/home'); await p.waitForTimeout(500);
await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('whoop-state-v4') || '{}'); s.stressIntroSeen = true; localStorage.setItem('whoop-state-v4', JSON.stringify(s)); });
for (const r of routes) { await p.goto('http://localhost:8790/?sim#' + r); await p.reload(); await p.waitForTimeout(1600); await p.screenshot({ path: '/tmp/w440/' + r.replace(/\//g, '_') + '.png' }); }
console.log(errs); await b.close();
