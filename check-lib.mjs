import { chromium } from 'playwright-core';
const b = await chromium.launch(); const p = await b.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto('http://localhost:8811/design/'); await p.waitForTimeout(500);
console.log('lib errors:', errs.join(' | ') || 'none', await p.evaluate(() => document.querySelectorAll('#ch-sankey svg, #ch-radar svg, #ch-lines svg').length));
await b.close();
