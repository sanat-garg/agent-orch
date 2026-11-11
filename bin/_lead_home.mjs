import { chromium } from 'playwright-core';
const [w,h,route,out,sel] = process.argv.slice(2);
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto('http://localhost:8790/?sim#/home'); await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('whoop-state-v4') || '{}'); s.stressIntroSeen = true; localStorage.setItem('whoop-state-v4', JSON.stringify(s)); });
await p.reload(); await p.waitForTimeout(300); await p.evaluate((r) => { location.hash = r; }, route); await p.waitForTimeout(1800);
if (sel) { await p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel); await p.waitForTimeout(600); }
await p.screenshot({ path: out }); console.log(errs); await b.close();
