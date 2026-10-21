// Execution Mode over HTTP (server.mjs /api/execution): admin only, the service catalogue with the admin's Credentials
// cards matched in, intake validation, and GitHub required before a project is created. Boots server.mjs
// (CW_NO_ORCHESTRATOR=1, temp data dir, no gh on PATH).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedPath } from './helpers/isolated-path.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'execution-api-password';
let child, base, dataDir, home, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-exec-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-exec-home-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH: isolatedPath(bin), PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  cookie = await login(PASSWORD);
});
after(() => {
  child?.kill('SIGKILL');
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

async function login(password, username) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password, ...(username && { username }) }) });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  return r.headers.get('set-cookie').split(';')[0];
}
const call = async (p, method = 'GET', body, c = cookie) => {
  const r = await fetch(base + p, { method, headers: { cookie: c, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: JSON.parse(await r.text()) };
};
const idea = 'A dating app where men pay a high monthly fee and women join free; verified profiles and one match a day.';

test('the catalogue lists every service with its status, matched to the admin\'s Credentials cards', async () => {
  let { status, body } = await call('/api/execution');
  assert.equal(status, 200);
  assert.ok(body.services.some((s) => s.id === 'godaddy' && s.status === 'missing'));
  assert.ok(body.services.some((s) => s.id === 'mobbin' && s.status === 'missing'));
  assert.deepEqual(body.executions, []);
  assert.ok(body.options.products.length >= 4 && body.options.askBefore.length >= 5);
  assert.equal(body.github, false);
  // A card holding the keys connects the service.
  assert.equal((await call('/api/credentials', 'POST', { name: 'GoDaddy', fields: [{ label: 'GODADDY_API_KEY', value: 'k' }, { label: 'GODADDY_API_SECRET', value: 's' }] })).status, 200);
  ({ body } = await call('/api/execution'));
  const gd = body.services.find((s) => s.id === 'godaddy');
  assert.equal(gd.status, 'ready');
  assert.equal(gd.card, 'GoDaddy');
});

test('a bad intake is a 400 with a sentence; a good one needs GitHub first (409), so no project is created', async () => {
  let r = await call('/api/execution', 'POST', { idea: 'too short', products: { web: true } });
  assert.equal(r.status, 400); assert.match(r.body.error, /few sentences/);
  r = await call('/api/execution', 'POST', { idea, products: { ios: true } });
  assert.equal(r.status, 400); assert.match(r.body.error, /React Native or native/);
  r = await call('/api/execution', 'POST', { idea, products: { web: true, ios: true }, appTech: 'native', domain: { mode: 'find' }, services: ['godaddy'] });
  assert.equal(r.status, 409); assert.equal(r.body.github, false);
  assert.deepEqual((await call('/api/convos')).body, []);
  assert.deepEqual((await call('/api/execution')).body.executions, []);
});

test('only an admin sees or starts executions', async () => {
  const u = await call('/api/users', 'POST', { name: 'sam', password: 'sam-password-1' });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const sam = await login('sam-password-1', 'sam');
  assert.equal((await call('/api/execution', 'GET', null, sam)).status, 403);
  assert.equal((await call('/api/execution', 'POST', { idea, products: { web: true } }, sam)).status, 403);
});
