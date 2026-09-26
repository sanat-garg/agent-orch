// Four Antigravity usage windows in the real UI, using isolated data and stub CLIs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'fallbacks-ui-password';
const CID = 'chat-fb';
const START = [
  { agent: 'codex', model: 'gpt-6-sol' },
  { agent: 'antigravity', model: 'gemini-3.1-pro-high' },
  { agent: 'antigravity', model: 'claude-sonnet-4-6' },
];
let browser, skip = false;
try { browser = await chromium.launch(); } catch (e) { skip = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
let child, base, dataDir, home, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fbui-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fbui-home-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Fallbacks', cwd: path.join(dataDir, 'no-such-project'), mode: 'chat',
    agent: 'antigravity', model: 'gemini-3.1-pro-high', createdAt: 1, updatedAt: 1, fullAccess: true, fallbacks: START }]));
  fs.mkdirSync(path.join(dataDir, 'metrics'));
  const t = Date.now();
  fs.writeFileSync(path.join(dataDir, 'metrics/usage.jsonl'), ['gemini-5h', 'gemini-weekly', '3p-5h', '3p-weekly'].flatMap((window, i) => [t - 3600000, t].map((time, j) => JSON.stringify({ kind: 'window', agent: 'antigravity', window, pct: 10 + i * 20 + j * 5, resetsAt: Math.floor(t / 1000) + 18000, t: time }))).join('\n') + '\n');
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/codex-stub.mjs'), path.join(bin, 'codex'));
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/agy-stub.mjs'), path.join(bin, 'agy'));
  const port = await freePort();
  assert.notEqual(port, 3000);
  base = `http://127.0.0.1:${port}`;
  const PATH = `${bin}:/usr/local/bin:/usr/bin:/bin:${path.dirname(process.execPath)}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH, AA_API_KEY: '', CW_AA_BASE: 'http://127.0.0.1:9',
    PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
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
  // PUT validates against discovered models: wait for both stub catalogs.
  for (let i = 0; ; i++) {
    const a = await (await fetch(base + '/api/agents', { headers: { cookie } })).json();
    if (['codex', 'antigravity'].every((id) => a.agents.find((x) => x.id === id)?.models.length)) break;
    if (i > 100) assert.fail('model discovery never finished');
    await new Promise((res) => setTimeout(res, 200));
  }
});

after(async () => {
  await browser?.close();
  child?.kill('SIGKILL');
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test('Antigravity renders four named sidebar rows, chips and chart series', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  await page.goto(`${base}/#${CID}`);
  const labels = ['Gemini · 5-hour', 'Gemini · Weekly', 'Third-party · 5-hour', 'Third-party · Weekly'];
  await page.waitForFunction(() => document.querySelector('#usSessionRow > span')?.textContent === 'Gemini · 5-hour');
  assert.deepEqual(await page.locator('#usageCard .ms-row > span:first-child').allTextContents(), labels);
  await page.locator('#usageCard').click();
  await page.waitForFunction(() => document.querySelector('#usageModal').textContent.includes('Third-party · Weekly'));
  for (const label of labels) assert.ok((await page.locator('#usageModal').innerText()).includes(label));
  assert.deepEqual(await page.locator('#usageModal .ug-legend span').allTextContents(), labels);
  const tip = await page.locator('#usageModal .ug-legend span').nth(2).getAttribute('title');
  assert.match(tip, /claude-sonnet-4-6/);
  for (const label of labels) assert.ok((await page.locator('#usageModal .ug-chips').innerText()).includes(label));
  assert.equal(await page.locator('#usageModal .lines path').count(), 4);
  if (process.env.SHOTS) {
    const proxy = createServer(async (req, res) => {
      if (process.env.SHOTS === 'before' && ['/app.js', '/app.css', '/index.html', '/'].includes(req.url.split('?')[0])) {
        const file = req.url.split('?')[0].replace(/^\/$/, '/index.html');
        res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
        res.end(execFileSync('git', ['show', `HEAD:public${file}`]));
      } else {
        const r = await fetch(base + req.url, { headers: { cookie } });
        res.setHeader('content-type', r.headers.get('content-type') || 'text/plain');
        res.end(Buffer.from(await r.arrayBuffer()));
      }
    });
    proxy.on('upgrade', (req, socket, head) => {
      const upstream = net.connect(Number(new URL(base).port), '127.0.0.1', () => {
        upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      socket.on('close', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const shotBase = `http://127.0.0.1:${proxy.address().port}`;
    try { for (const [part, args] of [['sidebar', []], ['usage', ['--click=#usageCard']]]) {
      await promisify(execFile)(process.execPath, ['bin/shot.mjs', `${shotBase}/#${CID}`, `.agent-orch/shots/147-${process.env.SHOTS}-${part}.png`, `--cookie=${cookie}`, '--wait=7000', ...args], { cwd: ROOT });
    } } finally { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
  }
  await ctx.close();
});
