import { chromium } from 'playwright-core';
const routes = process.argv.slice(2);
const widths = (process.env.W || '440').split(',').map(Number);
const b = await chromium.launch();
const errs = [];
for (const w of widths) {
  const h = w === 440 ? 956 : 844;
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  p.on('pageerror', (e) => errs.push(`${w} ${p.url()} ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`${w} console ${m.text()}`); });
  for (const r of routes) {
    const [route, scroll, wait] = r.split('@');
    await p.goto(`http://localhost:8790/?sim#${route}`);
    await p.waitForTimeout(+(wait || 900));
    if (scroll) { await p.evaluate((s) => { const el = [...document.querySelectorAll('.screen:last-child .scroll')].pop(); if (el) el.scrollTop = +s; }, scroll); await p.waitForTimeout(400); }
    const name = `/tmp/details-shots/${w}_${route.replace(/\W+/g, '_')}${scroll ? '_s' + scroll : ''}.png`;
    await p.screenshot({ path: name });
    // overflow check
    const ov = await p.evaluate(() => { const s = document.querySelector('.screen:last-child'); const bad = []; s.querySelectorAll('*').forEach((n) => { const r = n.getBoundingClientRect(); if (r.width && (r.right > innerWidth + 1 || r.left < -1) && getComputedStyle(n).position !== 'fixed') bad.push(n.className?.baseVal ?? n.className); }); return bad.slice(0, 5); });
    console.log(name, ov.length ? 'OVERFLOW ' + ov.join(',') : '');
  }
  await p.close();
}
console.log('ERRORS', errs.length ? errs.join('\n') : 'none');
await b.close();
