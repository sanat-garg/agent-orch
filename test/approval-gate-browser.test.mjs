// The approval gate on a real browser: the pinned Playwright MCP behind gate-proxy.mjs, exactly as a gated task run gets
// it (extensions.mjs mcpRun with a gate), on a local compose page. Clicking Send is held until the owner answers; a
// denial leaves the page unchanged; reads pass. Skipped on a machine without Chromium or Chrome.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createExtensions } from '../extensions.mjs';
import { findBrowser } from '../browser.mjs';
import { answer, patternsWith, readAudit } from '../gate.mjs';
import { waitFor } from './helpers/wait.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-browser-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('real browser: Send is held until approved, a denial leaves the page unchanged, reads are not gated', { skip: !findBrowser() && 'no Chromium or Chrome on this machine', timeout: 180000 }, async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Compose</title><form onsubmit="event.preventDefault(); document.getElementById('st').textContent = 'Sent to ' + this.to.value">
      <label>To <input name="to" value="bob@example.com"></label><label>Subject <input name="subject" value="Invoice 42"></label>
      <button type="submit">Send</button><button type="button">Save draft</button></form><p id="st">Not sent</p>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/compose`;
  const dir = path.join(tmp, 'gate'), outputDir = path.join(tmp, 'wt', '.agent-orch', 'shots');
  fs.mkdirSync(outputDir, { recursive: true });
  const ext = createExtensions({ dataDir: path.join(tmp, 'data'), home: path.join(tmp, 'home'), claudeDir: path.join(tmp, 'claude'), codexDir: path.join(tmp, 'codex') });
  const server = JSON.parse(fs.readFileSync(ext.mcpRun('claude', { browser: { identity: 'default', outputDir, headed: false }, gate: { dir, task: 1, patterns: patternsWith([]) } }), 'utf8')).mcpServers.playwright;
  assert.match(server.args.join(' '), /gate-proxy\.mjs --config /, 'the browser runs behind the gate');
  const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0;
  const waits = new Map();
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waits.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise((r) => { const n = ++id; waits.set(n, r); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
  const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  const text = (r) => (r?.content || []).map((c) => c.text || '').join('\n');
  const asked = () => { try { return fs.readdirSync(path.join(dir, 'approvals')).filter((n) => /^[\w-]+\.json$/.test(n) && !n.includes('answer')); } catch { return []; } };
  const settled = (p) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 1500))]);
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    await call('browser_navigate', { url });
    const snap = text(await call('browser_snapshot'));
    const ref = /button "Send" \[ref=(\w+)\]/.exec(snap)?.[1];
    assert.ok(ref, snap);
    assert.equal(asked().length, 0, 'navigation and snapshots are not held');

    const denied = call('browser_click', { element: 'the blue button', target: ref });
    await waitFor(() => asked().length === 1, { timeout: 30000 });
    assert.equal(await settled(denied), false, 'held');
    const a = JSON.parse(fs.readFileSync(path.join(dir, 'approvals', asked()[0]), 'utf8'));
    assert.match(a.action, /^Click "Send" button on 127\.0\.0\.1:\d+\/compose · To: bob@example\.com, Subject: Invoice 42$/);
    assert.ok(fs.statSync(path.join(dir, 'shots', a.screenshot)).size > 1000, 'a real screenshot of the page');
    answer(dir, 'approvals', a.id, { decision: 'deny', reason: 'check the amount first' });
    assert.match(text(await denied), /denied .*check the amount first/);
    assert.match(text(await call('browser_snapshot')), /Not sent/, 'the page is unchanged');

    const approved = call('browser_click', { element: 'Send', target: ref });
    await waitFor(() => asked().length === 2, { timeout: 30000 });
    const b = asked().map((n) => JSON.parse(fs.readFileSync(path.join(dir, 'approvals', n), 'utf8'))).find((x) => x.id !== a.id);
    answer(dir, 'approvals', b.id, { decision: 'approve' });
    await approved;
    assert.match(text(await call('browser_snapshot')), /Sent to bob@example\.com/);
    const log = readAudit(path.join(dir, 'audit.jsonl'));
    assert.deepEqual(log.filter((e) => e.tool === 'browser_click').map((e) => [e.class, e.decision]), [['outbound', 'deny'], ['outbound', 'approve']]);
    assert.ok(log.filter((e) => e.tool === 'browser_snapshot').every((e) => e.class === 'read'));
  } finally {
    await call('browser_close').catch(() => {});
    child.stdin.end();
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 10000); });
    child.kill('SIGKILL');
    srv.close();
  }
});
