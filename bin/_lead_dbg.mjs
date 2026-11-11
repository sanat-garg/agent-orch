import { chromium } from 'playwright-core';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 440, height: 956 } });
p.on('console', m => console.log('console', m.type(), m.text())); p.on('pageerror', e => console.log('err', e.message));
await p.goto('http://localhost:8790/?sim#/home'); await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('whoop-state-v4') || '{}'); s.stressIntroSeen = true; localStorage.setItem('whoop-state-v4', JSON.stringify(s)); }); await p.goto('http://localhost:8790/?sim#/stress/day/3'); await p.waitForTimeout(1500); await p.reload(); await p.waitForTimeout(1500);
console.log(await p.evaluate(() => [location.hash, document.querySelector('.screen')?.dataset.route]));
await b.close();
