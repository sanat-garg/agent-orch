import { chromium } from 'playwright-core';
// usage: node _social_shot.mjs <width> <height> route[@scrollY] ...
const [w, h, ...routes] = process.argv.slice(2);
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.goto('http://localhost:8790/?sim#/home'); await p.waitForTimeout(400);
for (const spec of routes) {
  const [r, sy] = spec.split('@');
  await p.goto('http://localhost:8790/?sim#' + r); await p.reload(); await p.waitForTimeout(900);
  if (sy) { await p.evaluate((y) => { const s = document.querySelector('.screen:last-child .scroll'); if (s) s.scrollTop = +y; }, sy); await p.waitForTimeout(300); }
  await p.screenshot({ path: `/tmp/social-shots/${w}${r.replace(/\//g, '_')}${sy ? '_' + sy : ''}.png` });
}
console.log('errors:', JSON.stringify(errs)); await b.close();
