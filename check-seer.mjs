import { chromium } from 'playwright-core';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
for (const s of process.argv.slice(2)) { await p.goto(`http://localhost:8811/design/web/?s=${s}`); await p.waitForTimeout(300); const n = await p.evaluate(() => document.querySelectorAll('.pn,.kpi').length); console.log(s, 'panels', n, errs.splice(0).join(' | ')); }
await b.close();
