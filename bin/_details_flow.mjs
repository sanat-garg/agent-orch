import { chromium } from 'playwright-core';
const W = +(process.env.W || 390), H = W === 440 ? 956 : 844;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console ' + m.text()); });
const base = 'http://localhost:8790/?sim';
const route = () => p.evaluate(() => location.hash);
const shot = (n) => p.screenshot({ path: `/tmp/details-shots/flow_${W}_${n}.png` });
const top = '.screen:last-child ';
const click = async (sel) => { await p.locator(top + sel).first().click(); await p.waitForTimeout(700); };
const log = async (label) => console.log(label.padEnd(28), await route(), await p.evaluate(() => document.querySelector('.toast')?.textContent || ''));
async function fresh(r) { await p.goto(base + '#' + r); await p.waitForTimeout(900); }

await fresh('/home');
for (const [act, label] of [['start', 'home start'], ['video', 'home video'], ['journal', 'home journal']]) {
  await fresh('/home'); await click(`[data-act="${act}"]`); await log(label);
}
// action menu
for (let i = 0; i < 5; i++) {
  await fresh('/home'); await click('[data-act="fab"]'); await p.waitForTimeout(300);
  await p.locator(`.am-item[data-i="${i}"]`).click(); await p.waitForTimeout(900); await log('menu item ' + i);
}
// pillars
await fresh('/sleep'); await click('[data-act="activity"]'); await log('sleep activity');
await fresh('/sleep'); await click('[data-act="learn"]'); await log('sleep learn');
await fresh('/sleep'); await click('[data-act="share"]'); await log('sleep share');
await fresh('/sleep'); await p.locator(top + '[data-act="trend"]').nth(1).click(); await p.waitForTimeout(700); await log('sleep trend 2');
await fresh('/sleep'); await p.locator(top + '[data-act="trend"]').nth(2).click(); await p.waitForTimeout(700); await log('sleep trend 3');
await fresh('/recovery'); for (let i = 0; i < 3; i++) { await fresh('/recovery'); await p.locator(top + '[data-act="trend"]').nth(i).click(); await p.waitForTimeout(700); await log('recovery trend ' + i); }
await fresh('/strain'); await click('[data-act="prev-day"]'); await click('[data-act="activity"]'); await log('strain activity (yday)'); await shot('strain_act');
await fresh('/strain'); await p.locator(top + '[data-act="trend"]').nth(1).click(); await p.waitForTimeout(700); await log('strain trend cal');
await fresh('/strain'); await click('[data-act="prev-day"]'); await click('[data-act="share"]'); await log('strain share yday');
// trend 30D
await fresh('/trend/hours-vs-need'); await click('[data-n="30"]'); await shot('trend30'); await log('trend 30');
await fresh('/trend/heart-rate-variability'); await shot('trend_hrv');
// share target
await fresh('/share/strain'); await click('[data-a="copy"]'); await click('[data-a="ig"]'); await shot('share_done');
// video play
await fresh('/video/baseline'); await click('[data-act="play"]'); await p.waitForTimeout(2000); await shot('video_playing'); console.log('video time', await p.locator(top + '[data-v="cur"]').textContent());
// journal
await fresh('/home'); await click('[data-act="journal"]'); await click('[data-q="0"][data-a="n"]'); await click('[data-q="1"][data-a="y"]'); await click('[data-act="save"]'); await log('journal saved');
console.log('journal state', await p.evaluate(() => JSON.parse(localStorage.getItem('whoop-state-v4')).journal));
// live activity
await fresh('/activity/start'); await p.fill(top + 'input', 'box'); await p.waitForTimeout(200); await shot('start_search');
await click('.dt-all .dt-type:not(.hidden)'); await log('picked'); await p.waitForTimeout(4000);
await click('[data-act="pause"]'); await shot('live_paused'); await click('[data-act="pause"]'); await p.waitForTimeout(1500);
await click('[data-act="end"]'); await log('ended'); await shot('summary');
await click('[data-act="done"]'); await log('done');
// add activity
await fresh('/activity/add'); await p.locator(top + 'select').selectOption('cycling'); await click('[data-d="1"]');
await p.fill(top + '[data-f="start"]', '18:00'); await p.fill(top + '[data-f="end"]', '19:10'); await p.waitForTimeout(200);
await click('[data-act="save"]'); await shot('add_done'); await click('[data-go^="/activity/u"]'); await log('view added'); await shot('added_detail');
// live camera
await fresh('/live'); await click('[data-act="shoot"]'); await p.waitForTimeout(300); await shot('live_shot');
await click('[data-m="video"]'); await click('[data-act="shoot"]'); await p.waitForTimeout(2200); await shot('live_rec'); await click('[data-act="shoot"]');
// guide → learn → back marks read
await fresh('/guide'); await click('[data-go="/learn/recovery"]'); await log('guide learn'); await p.goBack(); await p.waitForTimeout(800); await shot('guide_after');
// pair + profile
await fresh('/pair/intro'); await p.locator(top + '[data-act="video"]').click(); await p.waitForTimeout(800); await log('pair video');
await fresh('/pair/search'); await click('[data-act="help"]'); await log('pair help');
await fresh('/pair/help'); await click('[data-act="retry"]'); await log('pair retry');
await fresh('/profile/health'); await click('[data-act="learn"]'); await log('profile learn');
await fresh('/strength'); await click('.pg-foot .btn'); await log('strength start');
await fresh('/activity/zzz'); await shot('missing');
console.log('ERRORS', errs.length ? errs : 'none');
await b.close();
