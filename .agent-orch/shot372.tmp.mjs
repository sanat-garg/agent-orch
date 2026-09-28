import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const ROOT = process.cwd(), PASSWORD = 'pw-372', port = 38372, base = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-372-'));
const salt = crypto.randomBytes(16).toString('hex');
fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: 'c0', title: 'agent-orch', cwd: ROOT, mode: 'chat', agent: 'claude', model: 'opus', createdAt: 1, updatedAt: 1, fullAccess: true }]));
const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r) => { let o = ''; const f = (d) => { o += d; if (o.includes(`:${port}`)) r(); }; child.stdout.on('data', f); child.stderr.on('data', f); });
const lr = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
const [name, value] = lr.headers.get('set-cookie').split(';')[0].split('=');
const browser = await chromium.launch();
try {
  for (const mobile of [false, true]) {
    const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 800 } });
    await ctx.addCookies([{ name, value, url: base }]);
    const page = await ctx.newPage();
    await page.goto(base + '/');
    await page.evaluate(() => { localStorage.setItem('cw.files.mode', 'contents'); localStorage.setItem('cw.files.grep.w', '1'); });
    await page.reload();
    await page.waitForTimeout(800);
    await page.click('text=agent-orch-task-372'); await page.waitForTimeout(300); if (mobile) await page.keyboard.press('Escape');
    await page.click('[data-view="files"]');
    await page.waitForSelector('#fxFilter');
    const q = process.argv[2] || 'grepMatcher';
    await page.fill('#fxFilter', q);
    await page.press('#fxFilter', 'Enter');
    await page.waitForTimeout(1500);
    const out = `.agent-orch/shots/372-${process.argv[3] || 'after'}${mobile ? '-mobile' : ''}.png`;
    await page.screenshot({ path: out });
    console.log(out, JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('[data-fxopt]')].map((b) => [b.textContent, b.getAttribute('aria-pressed'), Math.round(b.getBoundingClientRect().height)]))));
    await ctx.close();
  }
} finally { await browser.close(); child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); }
