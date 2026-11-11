import { chromium } from 'playwright-core';
const W = +process.argv[2] || 440, H = W === 440 ? 956 : 844;
const routes = process.argv.slice(3);
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.goto('http://localhost:8790/?sim#/home'); await p.waitForTimeout(600);
for (const r of routes) {
  await p.evaluate((r) => { location.hash = r; }, r); await p.waitForTimeout(700);
  const full = await p.evaluate(() => { const s = document.querySelector('.screen:last-child .scroll'); return s ? s.scrollHeight : 0; });
  const name = `/tmp/settings-shots/${W}${r.replace(/\//g, '_')}`;
  await p.screenshot({ path: name + '.png' });
  // overflow check: any element wider than viewport
  const ov = await p.evaluate((W) => [...document.querySelectorAll('.screen:last-child *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > W + 1 || r.left < -1) && !e.closest('.wheel-in') && !e.closest('.articles') && !e.closest('.tabbar'); }).slice(0, 5).map(e => e.className || e.tagName), W);
  if (ov.length) console.log(r, 'OVERFLOW', ov);
  if (full > H) { await p.evaluate(() => { const s = document.querySelector('.screen:last-child .scroll'); s.scrollTop = s.scrollHeight; }); await p.waitForTimeout(200); await p.screenshot({ path: name + '_end.png' }); }
}
console.log('errors:', errs); await b.close();
