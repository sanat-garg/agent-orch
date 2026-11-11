import { chromium } from 'playwright-core';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
const U = 'http://localhost:8790/?sim#';
await p.goto(U + '/home'); await p.evaluate(() => localStorage.clear()); await p.goto(U + '/home'); await p.reload(); await p.waitForTimeout(600);
const nav = async (r) => { await p.evaluate((r) => { location.hash = r; }, r); await p.waitForTimeout(600); };
const top = () => p.locator('.screen').last();
const hash = () => p.evaluate(() => location.hash);
const shot = (n) => p.screenshot({ path: `/tmp/settings-shots/t_${n}.png` });
const log = (...a) => console.log(...a);

// 1. every clickable on /more, /login, /order
for (const r of ['/more', '/login', '/order']) {
  await nav(r);
  const n = await top().locator('[data-go],[data-act]').count();
  for (let i = 0; i < n; i++) {
    await nav(r);
    const el = top().locator('[data-go],[data-act]').nth(i);
    const desc = await el.evaluate(e => (e.dataset.go || e.dataset.act) + ' | ' + (e.dataset.k || e.textContent.trim().slice(0, 30)));
    if (/logout|restart|units|noop|haptics|seg|back|^\/home|^\/plan|^\/community|^\/more \|/.test(desc)) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {}); await el.click({ timeout: 2000 }).catch(e => log('click fail', desc));
    await p.waitForTimeout(550);
    const h = await hash(); const t = await top().evaluate(e => e.dataset.route);
    log(r.padEnd(7), desc.padEnd(52), '->', h, t === '/splash' ? 'NO ROUTE!' : '');
  }
}
// 2. personal details: edit name + birthday sheet + save
await nav('/more/details');
await top().locator('input[data-f=first]').fill('Sanatt');
await top().locator('[data-act=bday]').click(); await p.waitForTimeout(500); await shot('bday_sheet');
await top().locator('[data-ok]').click(); await p.waitForTimeout(300);
await top().locator('[data-act=height]').click(); await p.waitForTimeout(400); await shot('height_sheet'); await top().locator('[data-x]').first().click(); await p.waitForTimeout(300);
await top().locator('[data-act=unit][data-v=imperial]').click();
log('height imperial:', await top().locator('[data-o=h]').textContent());
await top().locator('[data-act=save]').click(); await p.waitForTimeout(200);
log('saved first:', await p.evaluate(() => JSON.parse(localStorage.getItem('whoop-state-v4')).profile.first), await p.evaluate(() => JSON.parse(localStorage.getItem('whoop-state-v4')).profile.units));
await top().locator('input[data-f=username]').fill('@x'); await top().locator('[data-act=save]').click(); log('err:', await top().locator('.st2-err').textContent());
await top().locator('input[data-f=username]').fill('@sanatgrg'); await top().locator('input[data-f=first]').fill('Sanat'); await top().locator('[data-act=unit][data-v=metric]').click(); await top().locator('[data-act=save]').click();
// 3. strap find + unpair
await nav('/more/strap'); await top().locator('[data-act=find]').click(); await p.waitForTimeout(300); await shot('strap_buzz'); await p.waitForTimeout(2600); log('find note:', await top().locator('.st2-findnote').textContent());
await top().locator('[data-act=unpair]').click(); await p.waitForTimeout(300); await shot('unpair_alert'); await top().locator('.ios-alert button[data-i="1"]').click(); await p.waitForTimeout(500); await shot('unpaired');
await top().locator('[data-act=pair]').click(); await p.waitForTimeout(2300); log('paired again:', await top().locator('.st2-status').textContent());
// 4. integrations connect
await nav('/more/integrations'); await top().locator('[data-id=strava]').click(); await p.waitForTimeout(1300); log('strava:', await top().locator('[data-id=strava]').textContent());
// 5. privacy export
await nav('/more/privacy'); await top().locator('[data-act=export]').click(); await p.waitForTimeout(2000); await shot('export');
// 6. refer copy + invite
await nav('/more/refer'); await top().locator('[data-act=copy]').click(); await p.waitForTimeout(100); log('copy:', await top().locator('.st2-copy').textContent());
await top().locator('form input').fill('friend@example.com'); await top().locator('form button').click(); await p.waitForTimeout(200); log('invites:', await top().locator('.st2-inv').count());
// 7. shop add -> bag -> checkout
await nav('/more/shop/bicep'); await top().locator('[data-act=color][data-i="1"]').click(); await top().locator('[data-act=add]').click(); await p.waitForTimeout(200); await shot('pdp_added');
log('badge:', await top().locator('[data-o=bagn]').textContent());
await top().locator('.st2-bagbtn').click(); await p.waitForTimeout(600); await shot('bag');
await top().locator('[data-act=qty][data-d="1"]').click(); await p.waitForTimeout(100);
await top().locator('[data-act=checkout]').click(); await p.waitForTimeout(1700); await shot('ordered');
// 8. support search
await nav('/more/support'); await top().locator('input').fill('battery'); await p.waitForTimeout(100); log('visible articles:', await top().locator('.st2-art-row:not(.hidden)').count());
await top().locator('input').fill('zzzz'); log('none shown:', await top().locator('[data-o=none]:not(.hidden)').count());
await nav('/more/support/recovery'); await top().locator('[data-act=fb][data-v="1"]').click(); log('fb:', await top().locator('[data-o=fb]').textContent());
// 9. contact
await nav('/more/contact'); await top().locator('[data-act=topic]').nth(1).click(); await top().locator('textarea').fill('My strap is not syncing overnight since yesterday.'); await top().locator('[data-act=send]').click(); await p.waitForTimeout(1500); await shot('contact_sent');
// 10. alarm
await nav('/more/alarm'); await top().locator('[data-act=day][data-d="6"]').click(); await top().locator('.st2-tg').first().click(); await p.waitForTimeout(200); await shot('alarm_off'); await top().locator('.st2-tg').first().click();
log('alarm:', JSON.stringify(await p.evaluate(() => JSON.parse(localStorage.getItem('whoop-state-v4')).st2.alarm)));
// 11. membership
await nav('/more/membership'); await top().locator('.st2-tg').click(); await p.waitForTimeout(300); await top().locator('.ios-alert button[data-i="1"]').click(); await p.waitForTimeout(500); await shot('renew_off');
await nav('/more/membership/plans'); await top().locator('[data-act=pick][data-id=peak]').click(); await top().locator('[data-act=confirm]').click(); await p.waitForTimeout(200); await shot('plan_changed');
// 12. qr scan
await nav('/more/qr'); await top().locator('[data-act=tab][data-t=scan]').click(); await top().locator('[data-act=cam]').click(); await p.waitForTimeout(800); await shot('qr_scan');
// 13. forgot
await nav('/login'); await p.locator('#em').fill('sanat@example.com'); await top().locator('[data-act=forgot]').click(); await p.waitForTimeout(600);
log('forgot prefill:', await p.locator('#st2em').inputValue()); await top().locator('button[type=submit]').click(); await p.waitForTimeout(1300); await shot('forgot_done');
await top().locator('[data-act=back]').last().click(); await p.waitForTimeout(600); log('after back to login:', await hash());
// 14. track copy
await nav('/order/track'); await top().locator('[data-act=copy]').click(); log('track copy:', await top().locator('.st2-copy').textContent());
// 15. /more reflects state
await nav('/more'); log('more alarm value:', await top().locator('[data-k="Strap Alarm"] .v').textContent());
console.log('errors:', errs); await b.close();
