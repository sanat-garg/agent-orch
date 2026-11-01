// The deploy API (deploy.mjs) from outside, against a real server.mjs (temporary HOME, data and port; sandboxed Caddy): a real
// MCP client, the real upload command in a shell, and each site fetched from the port it runs on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mergeEnv } from '../deploy.mjs';
import { parseEnv } from '../previews.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'deploy-api-password';
let child, base, root, home, cookie, token, tokenId, mcp;

const session = (p, method = 'GET', body) => fetch(`${base}${p}`, { method, headers: { cookie, origin: base, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
const call = async (name, args) => {
  const r = await mcp.callTool({ name, arguments: args });
  const text = r.content[0].text;
  try { return { ...JSON.parse(text), isError: r.isError }; } catch { return { text, isError: r.isError }; }
};
const portOf = async (project) => (await (await session('/api/previews')).json()).previews.find((v) => path.basename(v.dir) === project).port;
const page = async (project, p = '/') => (await fetch(`http://127.0.0.1:${await portOf(project)}${p}`)).text();

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-deploy-'));
  home = path.join(root, 'home');
  const dataDir = path.join(root, 'data'), handmade = path.join(home, 'workspace', 'handmade');
  for (const d of [dataDir, handmade]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(handmade, 'keep.txt'), 'made in a chat');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([
    { id: 'c0', title: 'handmade', cwd: handmade, mode: 'default', model: '', createdAt: 1, updatedAt: 1 },
    { id: 'c1', title: 'agent-orch', cwd: ROOT, mode: 'default', model: '', createdAt: 2, updatedAt: 2 },
  ]));
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  await mcp?.close().catch(() => {});
  // A preview's process outlives the server by design (the next boot replaces it), so each is taken down first.
  for (const v of (await (await session('/api/previews')).json()).previews) await session(`/api/convos/${v.cid}/preview`, 'PUT', { slug: '' });
  child?.kill('SIGTERM');
  await new Promise((r) => { child?.once('exit', r); setTimeout(r, 5000); });
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

test('no token, no deploy: tokens are made by a signed-in admin and shown once', async () => {
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/api/deploy/tools`, { headers: { authorization: 'Bearer aod_wrong' } })).status, 401);
  assert.equal((await fetch(`${base}/api/deploy/tokens`)).status, 401, 'a session is required');
  const t = await (await session('/api/deploy/tokens', 'POST', { name: 'MacBook' })).json();
  assert.match(t.token, /^aod_/);
  token = t.token; tokenId = t.id;
  const list = await (await session('/api/deploy/tokens')).json();
  assert.deepEqual(list.tokens.map((x) => [x.name, x.token, x.hash]), [['MacBook', undefined, undefined]]);
  mcp = new Client({ name: 'test', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  assert.match(mcp.getInstructions(), /prepare_upload/);
  const names = (await mcp.listTools()).tools.map((x) => x.name);
  for (const n of ['list_projects', 'prepare_upload', 'deploy_files', 'deploy_from_github', 'project_status', 'project_logs', 'restart_project', 'set_env', 'set_address', 'take_offline']) assert.ok(names.includes(n), n);
});

test('the upload command ships a folder: live site, new project, .env and ignored files stay home, a mirror on redeploy', async () => {
  const src = path.join(root, 'local-site');
  fs.mkdirSync(path.join(src, 'node_modules/x'), { recursive: true });
  fs.mkdirSync(path.join(src, 'cache'));
  for (const [f, c] of [['index.html', '<h1>one</h1>'], ['old.txt', 'old'], ['.env', 'SECRET=local'], ['node_modules/x/i.js', 'x'], ['.gitignore', 'cache/\n'], ['cache/big', 'ignored']]) fs.writeFileSync(path.join(src, f), c);
  const up = await call('prepare_upload', { name: 'Demo Site', message: 'first version' });
  const run = () => JSON.parse(execSync(up2.command, { cwd: src, encoding: 'utf8', shell: '/bin/bash' }));
  let up2 = up;
  const r = run();
  assert.equal(r.status, 'running', JSON.stringify(r));
  assert.equal(r.url, 'https://demo-site.greygoose.baby');
  assert.equal(r.project, 'demo-site');
  assert.match(await page('demo-site'), /one/);
  const dir = path.join(home, 'workspace', 'demo-site');
  assert.equal(fs.existsSync(path.join(dir, 'old.txt')), true);
  for (const gone of ['.env', 'node_modules', 'cache']) assert.equal(fs.existsSync(path.join(dir, gone)), false, gone);
  assert.match(execSync('git log -1 --format=%s', { cwd: dir, encoding: 'utf8' }), /Deploy from MacBook: first version/);
  assert.equal(execSync(up.command, { cwd: src, encoding: 'utf8', shell: '/bin/bash' }).includes('expired or was already used'), true, 'a ticket works once');

  const chats = (await (await session('/api/convos')).json());
  assert.ok((chats.convos || chats).some((c) => c.cwd === dir), 'it is an ordinary project with a chat');
  fs.mkdirSync(path.join(dir, 'runtime'));
  fs.writeFileSync(path.join(dir, 'runtime/app.db'), 'data the app keeps');
  fs.appendFileSync(path.join(dir, '.gitignore'), 'runtime/\n');
  fs.writeFileSync(path.join(src, '.gitignore'), 'cache/\nruntime/\n');
  fs.rmSync(path.join(src, 'old.txt'));
  fs.writeFileSync(path.join(src, 'index.html'), '<h1>two</h1>');
  up2 = await call('prepare_upload', { name: 'demo-site' });
  const r2 = run();
  assert.equal(r2.status, 'running', JSON.stringify(r2));
  assert.equal(r2.files.deleted, 1);
  assert.match(await page('demo-site'), /two/);
  assert.equal(fs.existsSync(path.join(dir, 'old.txt')), false, 'removed locally, removed here');
  assert.equal(fs.readFileSync(path.join(dir, 'runtime/app.db'), 'utf8'), 'data the app keeps');
  for (const rule of ['.env', 'node_modules/']) assert.ok(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n').includes(rule), rule);

  const bad = execSync(`printf 'not a tarball' | curl -sS -T - '${(await call('prepare_upload', { name: 'demo-site' })).command.match(/'(http[^']+)'$/)[1]}'`, { encoding: 'utf8', shell: '/bin/bash' });
  assert.match(JSON.parse(bad).error, /gzipped tar/);
  assert.match(await page('demo-site'), /two/, 'a bad upload changes nothing');
});

test('a custom start command with env vars and edits; a failing app answers with its logs', async () => {
  const js = 'require("http").createServer((q, s) => s.end(`v1 ${process.env.MY_KEY} ${process.env.PREVIEW_URL}`)).listen(process.env.PORT)';
  const r = await call('deploy_files', { name: 'api-app', files: [{ path: 'server.cjs', content: js }, { path: 'pic.bin', content: Buffer.from([0, 255, 1]).toString('base64'), encoding: 'base64' }, { path: '.env', content: 'NOT=sent' }], start_command: 'node server.cjs' });
  assert.equal(r.status, 'running', JSON.stringify(r));
  assert.deepEqual(r.files.skipped, ['.env']);
  const dir = path.join(home, 'workspace', 'api-app');
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'pic.bin'))], [0, 255, 1]);

  const e = await call('set_env', { name: 'api-app', set: { MY_KEY: 'a "quoted" value' } });
  assert.deepEqual(e.keys, ['MY_KEY']);
  assert.equal(e.status, 'running');
  assert.ok(!JSON.stringify(e).includes('quoted'), 'values are not shown back');
  assert.equal(await page('api-app'), 'v1 a "quoted" value https://api-app.greygoose.baby');
  assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600);
  assert.match((await call('set_env', { name: 'api-app', set: { PORT: '1' } })).text, /set by the server/);

  const partial = await call('deploy_files', { name: 'api-app', files: [{ path: 'extra.txt', content: 'x' }] });
  assert.equal(partial.status, 'running');
  assert.equal(fs.existsSync(path.join(dir, 'server.cjs')), true, 'without replace_all the rest stays');

  const moved = await call('set_address', { name: 'api-app', address: 'renamed-app' });
  assert.equal(moved.url, 'https://renamed-app.greygoose.baby');
  assert.equal(moved.moved_from, 'https://api-app.greygoose.baby');
  assert.match(await page('api-app'), /v1 .* https:\/\/renamed-app/);
  assert.match((await call('set_address', { name: 'api-app', address: 'x.not-ours.com' })).text, /isn't on this server's domains/);

  const broken = await call('deploy_files', { name: 'broken-app', files: [{ path: 'run.sh', content: 'echo boom-from-app; exit 3' }], start_command: 'bash run.sh' });
  assert.equal(broken.isError, true);
  assert.equal(broken.status, 'error');
  assert.match(broken.logs, /boom-from-app/);
  assert.match((await call('project_logs', { name: 'broken-app' })).logs, /boom-from-app/);
  assert.equal((await call('take_offline', { name: 'broken-app' })).status, 'offline');
  assert.equal((await call('project_status', { name: 'broken-app' })).status, 'offline');
  assert.equal(fs.existsSync(path.join(home, 'workspace', 'broken-app', 'run.sh')), true, 'offline keeps the code');
});

test('guards: another project needs replace_existing, agent-orch itself is never a target, paths stay inside', async () => {
  const handmade = path.join(home, 'workspace', 'handmade');
  const refused = await call('deploy_files', { name: 'handmade', files: [{ path: 'index.html', content: 'hi' }], replace_all: true });
  assert.match(refused.text, /wasn't created by a deploy/);
  assert.equal(fs.readFileSync(path.join(handmade, 'keep.txt'), 'utf8'), 'made in a chat');
  assert.equal(fs.existsSync(path.join(handmade, 'index.html')), false);

  const ok = await call('deploy_files', { name: 'handmade', files: [{ path: 'index.html', content: 'hi' }], replace_existing: true });
  assert.equal(ok.status, 'running', JSON.stringify(ok));
  assert.equal(fs.readFileSync(path.join(handmade, 'keep.txt'), 'utf8'), 'made in a chat');

  await call('deploy_files', { name: 'agent-orch', files: [{ path: 'pwned-by-deploy.txt', content: 'x' }], replace_existing: true });
  assert.equal(fs.existsSync(path.join(ROOT, 'pwned-by-deploy.txt')), false);

  assert.match((await call('deploy_files', { name: 'safe', files: [{ path: '../../evil.txt', content: 'x' }] })).text, /Bad file path/);
  assert.match((await call('deploy_files', { name: 'safe', files: [{ path: '/etc/evil.txt', content: 'x' }] })).text, /Bad file path/);
  assert.match((await call('project_status', { name: 'nope-nope' })).text, /No project named/);
});

test('plain HTTP has the same tools, and a revoked token stops working', async () => {
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const tools = await (await fetch(`${base}/api/deploy/tools`, { headers: h })).json();
  assert.ok(tools.tools.some((t) => t.name === 'deploy_files'));
  const list = await (await fetch(`${base}/api/deploy/tools/list_projects`, { method: 'POST', headers: h, body: '{}' })).json();
  assert.ok(list.projects.some((p) => p.url === 'https://demo-site.greygoose.baby' && p.status === 'running'));
  assert.ok(list.domains.length);
  const src = path.join(root, 'local-ci');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'index.html'), 'from ci');
  const out = JSON.parse(execSync(`tar -czf - . | curl -sS -T - -H 'Authorization: Bearer ${token}' '${base}/api/deploy/upload?name=ci-site'`, { cwd: src, encoding: 'utf8', shell: '/bin/bash' }));
  assert.equal(out.status, 'running', JSON.stringify(out));
  assert.match((await (await session(`/api/deploy/tokens/${tokenId}`, 'DELETE')).json()).ok ? 'ok' : '', /ok/);
  assert.equal((await fetch(`${base}/api/deploy/tools`, { headers: h })).status, 401);
});

test('mergeEnv keeps other lines and comments, and its quoting reads back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-env-'));
  fs.writeFileSync(path.join(dir, '.env'), '# note\nA=1\nexport B=2\nC=3\n');
  const value = 'multi\nline "q" \\ $x # not a comment';
  assert.deepEqual(mergeEnv(dir, { B: 'two', D: value }, ['C']), ['A', 'B', 'D']);
  const text = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.match(text, /^# note\nA=1\nB=two\nD=/);
  assert.equal(parseEnv(text).D, value);
  fs.rmSync(dir, { recursive: true, force: true });
});
