import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { isolatedPath } from './helpers/isolated-path.mjs';
import { waitFor } from './helpers/wait.mjs';

test('login-protected browser task API: validate, create, list and stop', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-task-api-'));
  const home = path.join(tmp, 'home'), data = path.join(tmp, 'data'), bin = path.join(tmp, 'bin');
  for (const dir of [home, data, bin]) fs.mkdirSync(dir);
  isolatedPath(bin);
  const salt = 'browser-task-test';
  fs.writeFileSync(path.join(data, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync('test-password', salt, 64).toString('hex') }));
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, HOME: home, PATH: bin, CW_DATA_DIR: data, CW_NO_ORCHESTRATOR: '1', PORT: String(port), AGENT_ORCH_BROWSER_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const profile = { identity: 'default', node: 'controller' };
  try {
    await waitFor(() => { if (child.exitCode != null) throw new Error(out); return out.includes(`127.0.0.1:${port}`); }, { timeout: 15000 });
    for (const [url, method] of [['/api/browser/task', 'POST'], ['/api/browser/tasks?identity=default&node=controller', 'GET'], ['/api/browser/task/1/stop', 'POST']]) {
      assert.equal((await fetch(base + url, { method })).status, 401);
    }
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const req = (url, body) => fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    for (const body of [{ ...profile, prompt: '  ' }, { ...profile, prompt: 'read', identity: 'missing' }, { ...profile, prompt: 'read', node: 'missing' }, { prompt: 'read' }]) {
      assert.equal((await req('/api/browser/task', body)).status, 400);
    }
    const r = await req('/api/browser/task', { ...profile, prompt: 'Read the page' });
    assert.equal(r.status, 201); const created = await r.json(); assert.deepEqual(Object.keys(created), ['taskId']);
    const list = await (await req('/api/browser/tasks?identity=default&node=controller')).json();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], { id: created.taskId, title: 'Read the page', status: 'queued', startedAt: null, finishedAt: null, resultText: null, steps: [] });
    assert.deepEqual(await (await req('/api/browser/tasks?identity=missing&node=controller')).json(), []);
    const db = new DatabaseSync(path.join(data, 'orchestrator', 'agent-orch.db'));
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(created.taskId); db.close();
    assert.deepEqual(JSON.parse(task.capabilities), ['browser']); assert.equal(task.run_on, 'controller');
    assert.equal((await req(`/api/browser/task/${created.taskId}/stop`, {})).status, 200);
    assert.equal((await (await req('/api/browser/tasks?identity=default&node=controller')).json())[0].status, 'cancelled');
    assert.equal((await req('/api/browser/task/999999/stop', {})).status, 404);
  } finally { child.kill('SIGKILL'); await new Promise((r) => child.exitCode != null ? r() : child.once('exit', r)); fs.rmSync(tmp, { recursive: true, force: true }); }
});
