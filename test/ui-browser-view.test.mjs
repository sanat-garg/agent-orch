// The Browser header tab (public/browser.js bx*): the live view in place, the prompt box and the activity panel. The
// /api/browser* routes are mocked and the /ws bv_* messages are intercepted (no real browser runs): the tab opens the
// picked profile's view, sending the prompt posts {prompt, identity, node}, the returned task's steps, screenshots,
// approval and Stop render, an agent on the profile shows the working ring with Take over, and at 390px the canvas
// fits the width with the prompt box on screen, and two fingers pinch-zoom it (a tap maps through the zoom, a double-tap
// resets). CW_UI_SHOTS=1 saves screenshots into .agent-orch/shots/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'ui-browser-view-password';
const SHOTS = process.env.CW_UI_SHOTS ? path.join(ROOT, '.agent-orch', 'shots') : null;
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, tmp, cookie, frame, out = '';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-browser-view-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1', AGENT_ORCH_BROWSER_HOME: path.join(tmp, 'home') } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
  // A screencast frame: a mail-like page rendered to a 1280×800 JPEG.
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await p.setContent(`<body style="margin:0;font:15px system-ui;background:#fff"><div style="display:flex;height:800px">
    <div style="width:220px;background:#f6f8fc;padding:20px"><b style="font-size:22px;color:#c5221f">Mail</b><p>Inbox 12</p><p>Starred</p><p>Sent</p></div>
    <div style="flex:1;padding:20px">${Array.from({ length: 14 }, (_, i) => `<div style="padding:12px;border-bottom:1px solid #eee"><b>Newsletter ${i + 1}</b> · Weekly digest and offers</div>`).join('')}</div></div>`);
  frame = (await p.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');
  await p.close();
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const NODES = { nodes: [{ id: 'mac', name: 'MacBook Air', local: false, online: true, capable: true,
  profiles: [{ identity: 'work', running: true, task: null }, { identity: 'default', running: false, task: null }] }] };
const STEPS = [{ ts: 1, kind: 'nav', label: 'gmail.com' }, { ts: 2, kind: 'click', label: 'Archive', mediaId: 'shot-1' },
  { ts: 3, kind: 'type', label: 'Search', mediaId: 'shot-2' }];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// A page with the Browser API mocked and the socket's bv_* traffic captured (and never sent to the server).
async function app(opts) {
  const [name, value] = cookie.split('=');
  const ctx = await browser.newContext(opts);
  await ctx.addCookies([{ name, value, url: base }]);
  const p = await ctx.newPage();
  const s = { errors: [], posts: [], stops: [], bv: [], tasks: [], ws: null };
  p.on('pageerror', (e) => s.errors.push(e.message));
  await p.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    s.ws = ws;
    ws.onMessage((m) => { const msg = JSON.parse(m); if (msg.t?.startsWith('bv_')) s.bv.push(msg); else server.send(m); });
    server.onMessage((m) => ws.send(m));
  });
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await p.route('**/api/browser', (r) => json(r, NODES));
  await p.route('**/api/browser/tasks?*', (r) => json(r, s.tasks));
  await p.route('**/api/browser/task', (r) => {
    s.posts.push(r.request().postDataJSON());
    s.tasks = [{ id: 42, title: 'Archive every newsletter in the inbox', status: 'running', startedAt: Date.now(), steps: STEPS }];
    return json(r, { taskId: 42 }, 201);
  });
  await p.route('**/api/browser/task/*/stop', (r) => { s.stops.push(r.request().url()); s.tasks = s.tasks.map((t) => ({ ...t, status: 'cancelled' })); return json(r, { ok: true }); });
  await p.route('**/api/orch/approvals', (r) => json(r, { approvals: s.tasks.some((t) => t.status === 'running')
    ? [{ id: 'ap-000042', task: 42, action: 'Click "Delete" button on mail.google.com', url: 'https://mail.google.com/mail/u/0/' }] : [] }));
  await p.route('**/api/media/*', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await p.goto(`${base}/`);
  await p.locator('#app:not([inert])').waitFor({ timeout: 20000 });
  return { ctx, p, s };
}
const serverSays = (p, msg) => p.evaluate((m) => window.bvOnServer(m), msg);
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `ui-browser-view-${name}.png`) }); } };

test('desktop: the Browser tab shows the profile in place; the prompt posts to /api/browser/task and its steps render', { skip, timeout: 120000 }, async () => {
  const { ctx, p, s } = await app({ viewport: { width: 1280, height: 860 } });
  try {
    assert.equal(await p.locator('#browserBtn').count(), 0, 'no sidebar Browser button');
    await p.locator('.seg [data-view="browser"]').click();
    assert.equal(await p.locator('#app').getAttribute('data-view'), 'browser');
    assert.equal(await p.locator('.seg [data-view="browser"]').getAttribute('aria-selected'), 'true');
    assert.ok(await p.locator('#browserView').isVisible() && await p.locator('#chatView').isHidden());
    await waitFor(() => s.bv.some((m) => m.t === 'bv_open' && m.node === 'mac' && m.identity === 'work' && m.thumb === false), { timeout: 10000, message: `opens the first profile: ${JSON.stringify(s.bv)}` });
    assert.equal(await p.locator('#bxProfile').inputValue(), 'mac/work');
    assert.ok(await p.locator('#bvModal').isHidden(), 'in place, not the modal');
    await p.locator('#bxActivity', { hasText: 'No agent has worked on work yet' }).waitFor();
    // The page arrives: the canvas fits the width.
    await serverSays(p, { t: 'bv_state', node: 'mac', identity: 'work', url: 'https://mail.google.com/mail/u/0/', title: 'Inbox', active: false, takeover: false, role: 'control', task: null });
    await serverSays(p, { t: 'bv_frame', node: 'mac', identity: 'work', n: 1, data: frame, w: 1280, h: 800 });
    await p.locator('#bxWait').waitFor({ state: 'hidden' });
    assert.equal(await p.locator('#bxUrl').inputValue(), 'https://mail.google.com/mail/u/0/');
    const view = await p.locator('#browserView').boundingBox(), cv = await p.locator('#bxCanvas').boundingBox();
    assert.ok(cv.width <= view.width && cv.width > 400 && Math.abs(cv.width / cv.height - 1.6) < 0.02, `the canvas scales to fit, keeping its shape: ${JSON.stringify(cv)}`);
    await shot(p, 'desktop-idle');
    // Send the prompt: Enter posts {prompt, identity, node} for the shown profile.
    await p.locator('#bxInput').fill('Archive every newsletter in the inbox');
    await p.locator('#bxInput').press('Enter');
    await waitFor(() => s.posts.length === 1, { timeout: 10000, message: 'the prompt is posted' });
    assert.deepEqual(s.posts[0], { prompt: 'Archive every newsletter in the inbox', identity: 'work', node: 'mac' });
    await waitFor(async () => (await p.locator('#bxInput').inputValue()) === '', { timeout: 5000, message: 'the box clears' });
    const act = p.locator('#bxActivity');
    await act.locator('.bx-step').nth(2).waitFor({ timeout: 10000 });
    assert.deepEqual(await act.locator('.bx-step').allTextContents(), ['Opened gmail.com', 'Clicked Archive', 'Typed in Search']);
    assert.match(await act.locator('.bx-head').textContent(), /Working…\s*#42 Archive every newsletter/);
    assert.equal(await act.locator('.shots .shot').count(), 2, 'screenshot thumbnails');
    const th = await act.locator('.shot button').first().boundingBox();
    assert.ok(Math.abs(th.width - 160) < 2 && Math.abs(th.height - 100) < 2, `the standard thumbnail size: ${JSON.stringify(th)}`);
    await act.locator('.ap-panel', { hasText: 'Click "Delete" button' }).waitFor();
    assert.ok(await act.getByRole('button', { name: 'Approve once' }).isVisible() && await act.getByRole('button', { name: 'Deny…' }).isVisible(), 'an inline approval card');
    // The agent drives the profile: the working ring, and the owner can still take over.
    await serverSays(p, { t: 'bv_state', node: 'mac', identity: 'work', url: 'https://mail.google.com/mail/u/0/', title: 'Inbox', active: true, takeover: false, role: 'watch', task: { id: 42, title: 'Archive every newsletter in the inbox' } });
    assert.ok(await p.locator('#browserView').evaluate((n) => n.classList.contains('agent-busy')));
    assert.ok(await p.locator('#bxBusy').isVisible(), 'Agent is working');
    await shot(p, 'desktop-working');
    await p.locator('#bxTake').click();
    assert.ok(s.bv.some((m) => m.t === 'bv_take' && m.node === 'mac' && m.identity === 'work'), 'Take over reaches the server');
    // Stop, then the finished task's result shows.
    await act.getByRole('button', { name: 'Stop' }).click();
    await waitFor(() => s.stops.length === 1, { timeout: 5000, message: 'Stop posts' });
    assert.match(s.stops[0], /\/api\/browser\/task\/42\/stop$/);
    s.tasks = [{ ...s.tasks[0], status: 'done', resultText: 'Archived **14** newsletters.' }];
    s.ws.send(JSON.stringify({ t: 'otask', task: { id: 42, status: 'done', browser: 'work', node: 'mac', title: 'Archive every newsletter in the inbox' } }));
    await act.locator('.bx-result', { hasText: 'Archived 14 newsletters.' }).waitFor({ timeout: 5000 });
    assert.match(await act.locator('.bx-head').textContent(), /Done/);
    assert.equal(await act.locator('.bx-earlier').count(), 0, 'no Earlier prompts with one task');
    // Earlier prompts: the other two tasks, newest first; a row shows that task, Back to latest returns, Ask again fills the box unsent.
    const nowS = Date.now() / 1000;
    s.tasks = [s.tasks[0], { id: 41, title: 'Unsubscribe from the Acme list', prompt: 'Unsubscribe from the Acme list, then archive its mail', status: 'failed', finishedAt: nowS - 7200, steps: [{ ts: 1, kind: 'nav', label: 'acme.com' }] },
      { id: 40, title: 'Star the mail from Sam', status: 'done', finishedAt: nowS - 300, steps: [], resultText: 'Starred 3 messages.' }];
    s.ws.send(JSON.stringify({ t: 'otask', task: { id: 42, status: 'done', browser: 'work', node: 'mac', title: 'Archive every newsletter in the inbox' } }));
    const rows = act.locator('.bx-earlier .bx-erow');
    await waitFor(async () => (await rows.count()) === 2, { timeout: 5000, message: 'two earlier prompts' });
    assert.match(await rows.nth(0).textContent(), /#41\s*Unsubscribe from the Acme list\s*2h ago/);
    assert.match(await rows.nth(1).textContent(), /#40\s*Star the mail from Sam\s*5m ago/);
    const rh = await rows.nth(0).locator('.bx-ebtn').boundingBox();
    assert.ok(Math.abs(rh.height - 36) < 1, `36px rows on desktop: ${JSON.stringify(rh)}`);
    assert.equal(await act.getByRole('button', { name: 'Back to latest' }).count(), 0, 'the latest is shown');
    await act.locator('.bx-earlier').scrollIntoViewIfNeeded();
    await shot(p, 'desktop-earlier');
    await rows.nth(0).locator('.bx-ebtn').click();
    assert.match(await act.locator('.bx-title').textContent(), /^#41 Unsubscribe from the Acme list/);
    assert.deepEqual(await act.locator('.bx-step').allTextContents(), ['Opened acme.com']);
    assert.match(await act.locator('.bx-earlier').textContent(), /#42.*#40/);
    await act.getByRole('button', { name: 'Back to latest' }).click();
    assert.match(await act.locator('.bx-title').textContent(), /^#42 Archive every newsletter/);
    assert.equal(await act.getByRole('button', { name: 'Back to latest' }).count(), 0);
    await rows.nth(0).getByRole('button', { name: 'Ask again' }).click();
    assert.equal(await p.locator('#bxInput').inputValue(), 'Unsubscribe from the Acme list, then archive its mail');
    assert.ok(await p.locator('#bxInput').evaluate((n) => n === document.activeElement), 'the box takes focus');
    assert.ok(await p.locator('#bxSend').isEnabled(), 'ready to send');
    await rows.nth(1).getByRole('button', { name: 'Ask again' }).click();
    assert.equal(await p.locator('#bxInput').inputValue(), 'Star the mail from Sam', 'no prompt: its title');
    await p.waitForTimeout(300);
    assert.equal(s.posts.length, 1, 'Ask again does not send');
    await p.locator('#bxInput').fill('');
    // Another profile from the picker; leaving the tab closes the view.
    await p.locator('#bxProfile').selectOption('mac/default');
    await waitFor(() => s.bv.some((m) => m.t === 'bv_open' && m.identity === 'default'), { timeout: 5000, message: 'opens default' });
    await p.locator('.seg [data-view="chat"]').click();
    await waitFor(() => s.bv.at(-1)?.t === 'bv_close' && s.bv.at(-1).identity === 'default', { timeout: 5000, message: `closes it: ${JSON.stringify(s.bv.at(-1))}` });
    assert.deepEqual(s.errors, []);
  } finally { await ctx.close(); }
});

test('iPhone (390px): the canvas fits the width and the prompt box stays on screen', { skip, timeout: 120000 }, async () => {
  const { ctx, p, s } = await app({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  try {
    await p.locator('.seg [data-view="browser"]').tap();
    await waitFor(() => s.bv.some((m) => m.t === 'bv_open' && m.identity === 'work'), { timeout: 10000, message: 'opens the profile' });
    await serverSays(p, { t: 'bv_state', node: 'mac', identity: 'work', url: 'https://mail.google.com/mail/u/0/', title: 'Inbox', active: true, takeover: false, role: 'watch', task: { id: 42, title: 'Archive' } });
    await serverSays(p, { t: 'bv_frame', node: 'mac', identity: 'work', n: 1, data: frame, w: 1280, h: 800 });
    await p.locator('#bxWait').waitFor({ state: 'hidden' });
    const cv = await p.locator('#bxCanvas').boundingBox();
    assert.ok(cv.x >= 0 && cv.x + cv.width <= 390 && cv.width > 340, `the canvas fits the width: ${JSON.stringify(cv)}`);
    const box = await p.locator('#bxPrompt .box').boundingBox();
    assert.ok(box.y + box.height <= 844 && box.y > cv.y, `the prompt box is on screen below the canvas: ${JSON.stringify(box)}`);
    assert.ok(await p.locator('#bxTake').isVisible(), 'Take over');
    const size = await p.locator('#bxInput').evaluate((n) => getComputedStyle(n).fontSize);
    assert.equal(size, '16px', 'iOS does not zoom into the prompt box');
    await p.locator('#bxInput').fill('Find the invoice from Acme and download it');
    await shot(p, 'iphone');
    await p.locator('#bxSend').tap();
    await waitFor(() => s.posts.length === 1, { timeout: 10000, message: 'the send button posts' });
    assert.deepEqual(s.posts[0], { prompt: 'Find the invoice from Acme and download it', identity: 'work', node: 'mac' });
    await p.locator('#bxActivity .bx-step').first().waitFor({ timeout: 10000 });
    await shot(p, 'iphone-steps');
    assert.deepEqual(s.errors, []);
  } finally { await ctx.close(); }
});

test('iPhone (390px): two fingers pinch-zoom the canvas, a tap maps through the zoom, a double-tap goes back to fit', { skip, timeout: 120000 }, async () => {
  const { ctx, p, s } = await app({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  try {
    await p.locator('.seg [data-view="browser"]').tap();
    await waitFor(() => s.bv.some((m) => m.t === 'bv_open' && m.identity === 'work'), { timeout: 10000, message: 'opens the profile' });
    await serverSays(p, { t: 'bv_state', node: 'mac', identity: 'work', url: 'https://mail.google.com/mail/u/0/', title: 'Inbox', active: false, takeover: false, role: 'control', task: null });
    await serverSays(p, { t: 'bv_frame', node: 'mac', identity: 'work', n: 1, data: frame, w: 1280, h: 800 });
    await p.locator('#bxWait').waitFor({ state: 'hidden' });
    const cv = p.locator('#bxCanvas'), fit = await cv.boundingBox();
    const scale = () => cv.evaluate((n) => new DOMMatrix(getComputedStyle(n).transform).a);
    const ev = (type, id, x, y) => cv.dispatchEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, button: 0 });
    const tap = async (x, y) => { await ev('pointerdown', 7, x, y); await ev('pointerup', 7, x, y); };
    const inputs = () => s.bv.filter((m) => m.t === 'bv_input');
    assert.equal(await scale(), 1, 'fit-width to start');
    assert.ok(await p.locator('.bx-stage .bv-zoom').isHidden(), 'no 1× chip at fit');
    // Pinch: two fingers 60px apart spread to 180px around the canvas's middle (3×); nothing goes to the page.
    const cx = fit.x + fit.width / 2, cy = fit.y + fit.height / 2, n0 = inputs().length;
    await ev('pointerdown', 1, cx - 30, cy);
    await ev('pointerdown', 2, cx + 30, cy);
    await ev('pointermove', 1, cx - 90, cy);
    await ev('pointermove', 2, cx + 90, cy);
    await ev('pointerup', 1, cx - 90, cy);
    await ev('pointerup', 2, cx + 90, cy);
    const s1 = await scale();
    assert.ok(Math.abs(s1 - 3) < 0.01, `the canvas zooms to 3×: ${s1}`);
    assert.equal(inputs().length, n0, `a pinch sends nothing to the page: ${JSON.stringify(inputs().slice(n0))}`);
    assert.ok(await p.locator('.bx-stage').evaluate((n) => n.classList.contains('zoomed') && getComputedStyle(n).overflow === 'hidden'), 'the stage clips the zoomed canvas');
    assert.ok(await p.locator('.bx-stage .bv-zoom').isVisible(), 'the 1× chip shows');
    await shot(p, 'iphone-zoomed');
    // A tap 45px right of and 15px above the pinch's middle lands on the page point that was under it, 3× closer.
    const x = cx + 45, y = cy - 15;
    await tap(x, y);
    await waitFor(() => inputs().length === n0 + 1, { timeout: 5000, message: 'the tap is sent' });
    const click = inputs().at(-1).events[0];
    const want = { x: ((cx - fit.x + (x - cx) / 3) / fit.width) * 1280, y: ((cy - fit.y + (y - cy) / 3) / fit.height) * 800 };
    assert.equal(click.type, 'click');
    assert.ok(Math.abs(click.x - want.x) <= 1 && Math.abs(click.y - want.y) <= 1, `the click maps through the zoom: ${JSON.stringify({ click, want })}`);
    // A double-tap (two taps within 300 ms and 30px) goes back to fit-width, sending only the first tap.
    await p.waitForTimeout(350);
    await tap(x, y);
    await tap(x + 5, y + 5);
    assert.equal(await scale(), 1, 'a double-tap resets to fit');
    assert.equal(inputs().length, n0 + 2, 'the second tap of a double-tap is not a click');
    assert.ok(await p.locator('.bx-stage .bv-zoom').isHidden());
    // Another double-tap zooms to 2.5×; the chip resets.
    await p.waitForTimeout(350);
    await tap(cx, cy);
    await tap(cx, cy);
    assert.ok(Math.abs(await scale() - 2.5) < 0.01, 'a double-tap at fit zooms to 2.5×');
    await p.locator('.bx-stage .bv-zoom').tap();
    assert.equal(await scale(), 1, 'the 1× chip resets');
    assert.equal(await p.locator('.bx-stage').evaluate((n) => getComputedStyle(n).alignItems), 'center', 'the stage is centred on phones');
    assert.deepEqual(s.errors, []);
  } finally { await ctx.close(); }
});
