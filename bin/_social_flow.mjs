import { chromium } from 'playwright-core';
const W = +(process.argv[2] || 390), H = +(process.argv[3] || 844);
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
const U = 'http://localhost:8790/?sim#';
const shot = (n) => p.screenshot({ path: `/tmp/social-shots/flow${W}_${n}.png` });
const S = '.screen:last-child ';
const click = async (sel) => { await p.click(S + sel); await p.waitForTimeout(550); };
await p.goto(U + '/home'); await p.evaluate(() => localStorage.clear()); await p.goto(U + '/plan'); await p.reload(); await p.waitForTimeout(800);
// plan -> edit: set Thursday (i=3) to Cardio 7:00 AM, Fri (4) to Rest
await click('[data-act="edit"]');
await click('.so-ed[data-i="3"] [data-act="open"]');
await click('.so-ed[data-i="3"] [data-a="Cardio"]');
await click('.so-ed[data-i="3"] [data-t="7:00 AM"]');
await shot('edit');
await click('.so-ed[data-i="4"] [data-act="open"]');
await click('.so-ed[data-i="4"] [data-a="Rest"]');
await click('.pg-foot [data-act="save"]');
await p.waitForTimeout(300);
console.log('route after save', await p.evaluate(() => location.hash), await p.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('whoop-state-v4')).planEdits)));
await click('.pn-week [data-i="3"]'); await shot('plan-thu');
await click('.pn-act'); await shot('day-thu');
console.log('day route', await p.evaluate(() => location.hash));
await p.goBack(); await p.waitForTimeout(600);
await click('.pn-week [data-i="4"]'); console.log('fri:', await p.textContent(S + '.pn-acts'));
// calendar
await click('[data-act="cal"]');
await click('.so-cal [data-key$="05"]'); await shot('cal-pick');
await click('.mr-row[data-act="gcal"]'); await p.waitForTimeout(1300); console.log('gcal:', await p.textContent(S + '.gsub'));
await click('[data-act="month"][data-d="-1"]'); await shot('cal-oct');
// community create
await p.goto(U + '/community'); await p.waitForTimeout(700);
await click('.cy-join [data-act="create"]');
await p.fill(S + '#so-name', 'Sunrise Lifters'); await p.fill(S + '#so-about', 'Early lifts in West Delhi.');
await click('[data-act="color"][data-c="#13806b"]'); await click('[data-act="priv"][data-v="Private"]');
await click('[data-act="inv"][data-n="Anishka Malik"]'); await click('[data-act="inv"][data-n="Maulik Khurana"]'); await click('[data-act="inv"][data-n="Devam Khanijo"]');
await shot('create-filled');
await click('.pg-foot [data-act="create"]'); await shot('team-created');
await click('[data-act="tab"][data-t="members"]'); await shot('team-created-members');
await click('[data-act="tab"][data-t="feed"]'); await shot('team-created-feed');
await click('[data-act="tab"][data-t="feed"]');
await click('.so-head-invite, [data-act="invite"].btn'); await shot('invite');
await click('.so-sheet [data-n="Rubal Singh"]'); await click('.so-sheet [data-done]');
console.log('members after invite:', await p.textContent(S + '.so-hero p'));
await p.goBack(); await p.waitForTimeout(600); await shot('community-after');
// find & join
await click('[data-act="find"]');
await click('[data-act="join"][data-id="delhi-runners"]');
await p.fill(S + '#so-fq', 'zzz'); await p.waitForTimeout(200); await shot('find-empty');
await p.fill(S + '#so-fq', 'mumbai'); await p.waitForTimeout(200); await shot('find-mumbai');
await p.fill(S + '#so-fq', ''); await p.waitForTimeout(200);
await click('.so-p[data-go="/community/team/delhi-runners"] .k'); await shot('team-dr');
await click('[data-act="tab"][data-t="feed"]'); await shot('team-dr-feed');
await click('.so-like'); 
await p.goBack(); await p.waitForTimeout(500); await p.goBack(); await p.waitForTimeout(700); await shot('community-joined');
// team via chevron, leave
await click('.cy-team[data-id="india"] .go'); console.log('india route', await p.evaluate(() => location.hash));
await click('[data-act="leave"]'); await shot('leave-alert'); await p.click(S + '.ios-alert [data-i="1"]'); await p.waitForTimeout(700);
console.log('after leave', await p.evaluate(() => location.hash), await p.$$eval(S + '.cy-team', (n) => n.map((x) => x.dataset.id)));
// coach about -> ask
await p.goto(U + '/coach'); await p.waitForTimeout(600);
await click('[data-act="about"]'); await p.evaluate(() => document.querySelector('.screen:last-child .scroll').scrollTop = 9999); await p.waitForTimeout(200); await shot('about-bottom');
await click('[data-act="ask"][data-q="Should I train legs today?"]'); await p.waitForTimeout(2600); await shot('coach-asked');
console.log('coach route', await p.evaluate(() => location.hash));
console.log('errors:', JSON.stringify(errs)); await b.close();
