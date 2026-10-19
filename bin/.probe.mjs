import { chromium } from 'playwright-core';
const tok = process.argv[2], mobile = process.argv[3] === 'm';
const b = await chromium.launch();
const p = await b.newPage(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } });
await p.context().addCookies([{ name: 'cw_session', value: tok, url: 'http://127.0.0.1:3000' }]);
await p.goto('http://127.0.0.1:3000/');
await p.waitForTimeout(3000);
if (mobile) { await p.locator('#menuBtn, .menu-btn, [aria-label*="enu"]').first().click().catch(()=>{}); await p.waitForTimeout(600); }
await p.screenshot({ path: `/tmp/side${mobile?'-m':''}.png` });
console.log(await p.evaluate(() => ({ convos: state.convos.length, folders: new Set(state.convos.map(c=>c.cwd)).size, archived: state.convos.filter(c=>c.archived).length })));
await p.locator('#previewsBtn').click(); await p.waitForTimeout(1500);
await p.screenshot({ path: `/tmp/pv${mobile?'-m':''}.png`, fullPage: false });
await b.close();
