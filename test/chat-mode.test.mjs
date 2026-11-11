// Chat (chat-mode.mjs): a reply streams as server-sent events from a tool-less Claude Code query whose prompt can't run
// a /command; the next message resumes the session, and a lost session starts over with a recap; chats are private to
// their owner; a capped user is refused. Server: a "Chat only" account gets /chat and /api/chat and nothing else (no
// app, no API, no websocket), the model list is every model the CLI listed (newest of each family first), and deleting the account deletes its chats.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createChatMode, chatModels, titleOf } from '../chat-mode.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = [
  { id: 'opus', label: 'Opus 5.5', description: 'For complex work', default: true },
  { id: 'claude-fable-5-2', label: 'Fable 5.2' }, { id: 'fable', label: 'Fable 5.1' }, { id: 'sonnet', label: 'Sonnet 5.5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' }];
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const events = (text) => text.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)));

test('chatModels lists every model the CLI listed, newest of each family first; titles come from the first line', () => {
  const l = chatModels(MODELS);
  assert.deepEqual(l.map((m) => m.id), ['opus', 'claude-fable-5-2', 'sonnet', 'fable', 'claude-opus-4-8']);
  assert.deepEqual(l.filter((m) => m.latest).map((m) => m.id), ['opus', 'claude-fable-5-2', 'sonnet']);
  assert.deepEqual(chatModels([{ id: 'x', label: 'Fable 5.10' }, { id: 'y', label: 'Fable 5.9' }]).map((m) => m.latest), [true, false]);
  assert.equal(titleOf('\n  What is a monad?\nMore'), 'What is a monad?');
  assert.ok(titleOf('word '.repeat(30)).length <= 49);
});

test('a turn streams, is saved, resumes, recovers a lost session, and stays private', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-chatmode-'));
  const calls = [], tokens = [];
  let lose = false;
  // A fake Claude Code: thinking, then two text blocks; a resume of a lost session fails the way the CLI does.
  const query = ({ prompt, options }) => (async function* () {
    calls.push({ prompt, options });
    if (lose && options.resume) { yield { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, errors: ['No conversation found'] }; return; }
    const sid = options.resume || 'sess-1';
    yield { type: 'system', subtype: 'init', session_id: sid, apiKeySource: 'none' };
    yield { type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Hmm.' } } };
    yield { type: 'stream_event', session_id: sid, event: { type: 'content_block_start', content_block: { type: 'text' } } };
    yield { type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } };
    yield { type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' there' } } };
    yield { type: 'result', subtype: 'success', session_id: sid, usage: { input_tokens: 5, output_tokens: 7 } };
  })();
  const cm = createChatMode({ dataDir, claudeBin: '/nonexistent', env: { HOME: dataDir }, models: () => MODELS, query, log: () => {},
    refuse: (u) => (u.id === 'capped' ? 'over your cap' : null), usageLog: { tokens: (...a) => tokens.push(a), limitHit() {}, limitCleared() {} } });
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => r(b ? JSON.parse(b) : {})); });
  const srv = http.createServer(async (req, res) => {
    const me = { id: req.headers['x-user'], name: req.headers['x-user'], role: 'chat' };
    if (!(await cm.handle(req, res, new URL(req.url, 'http://x'), me, { readBody, json }))) json(res, 404, { error: 'nope' });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (user, p, method = 'GET', body) => {
    const r = await fetch(base + p, { method, headers: { 'x-user': user, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, type: r.headers.get('content-type'), text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  try {
    const home = await call('ann', '/api/chat');
    assert.deepEqual(home.body.models.map((m) => m.id), ['opus', 'claude-fable-5-2', 'sonnet', 'fable', 'claude-opus-4-8']);
    assert.equal(home.body.defaultModel, 'opus');
    const { chat } = (await call('ann', '/api/chat/chats', 'POST', { model: 'gpt-9' })).body;
    assert.equal(chat.model, 'opus', 'an unlisted model falls back to the default');

    const r1 = await call('ann', `/api/chat/chats/${chat.id}/send`, 'POST', { text: '/logout now', model: 'claude-opus-4-8' });
    assert.match(r1.type, /text\/event-stream/);
    const ev = events(r1.text);
    assert.deepEqual(ev.map((e) => e.t), ['start', 'thinking', 'delta', 'delta', 'done']);
    assert.equal(ev.at(-1).message.text, 'Hello there');
    assert.equal(ev.at(-1).message.thinking, 'Hmm.');
    const o = calls[0].options;
    assert.equal(calls[0].prompt, '​/logout now', 'a leading / never runs a Claude Code command');
    assert.deepEqual([o.tools, o.settingSources, o.skills, o.strictMcpConfig, o.model, o.resume], [[], [], [], true, 'claude-opus-4-8', undefined]);
    assert.equal(o.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    assert.equal(tokens[0][2], 'chatmode');
    assert.deepEqual(tokens[0][4], { user: 'ann', model: 'claude-opus-4-8' });

    const saved = (await call('ann', `/api/chat/chats/${chat.id}`)).body;
    assert.equal(saved.chat.title, '/logout now');
    assert.deepEqual(saved.messages.map((m) => [m.role, m.text]), [['user', '/logout now'], ['assistant', 'Hello there']]);

    await call('ann', `/api/chat/chats/${chat.id}/send`, 'POST', { text: 'again' });
    assert.equal(calls[1].options.resume, 'sess-1', 'the next message resumes the session');

    lose = true;
    const r3 = events((await call('ann', `/api/chat/chats/${chat.id}/send`, 'POST', { text: 'third' })).text);
    assert.equal(r3.at(-1).message.text, 'Hello there');
    assert.equal(calls[3].options.resume, undefined);
    assert.match(calls[3].prompt, /^​\(Our conversation so far[^]*User: \/logout now[^]*Claude: Hello there[^]*third$/);

    // Private: another account can't see, read, send to or delete it.
    assert.deepEqual((await call('bob', '/api/chat')).body.chats, []);
    for (const [p, m] of [['', 'GET'], ['/send', 'POST'], ['', 'DELETE']]) assert.equal((await call('bob', `/api/chat/chats/${chat.id}${p}`, m, m === 'POST' ? { text: 'x' } : undefined)).status, 404);
    assert.equal((await call('capped', `/api/chat/chats/${(await call('capped', '/api/chat/chats', 'POST', {})).body.chat.id}/send`, 'POST', { text: 'hi' })).status, 429);

    assert.equal((await call('ann', `/api/chat/chats/${chat.id}`, 'PATCH', { title: 'Renamed' })).body.chat.title, 'Renamed');
    assert.equal((await call('ann', `/api/chat/chats/${chat.id}`, 'DELETE')).status, 200);
    assert.ok(!fs.existsSync(path.join(dataDir, 'chat-mode', `${chat.id}.json`)));
    assert.equal(cm.removeUser('capped'), 1);
  } finally {
    srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- the server: a Chat only account
let child, base, dataDir;
const hash = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') }; };
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-chatmode-srv-'));
  fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify([
    { id: 'admin', name: 'admin', role: 'admin', ...hash('admin-password-1'), caps: {} },
    { id: 'cora1', name: 'cora', role: 'chat', ...hash('cora-password-1'), caps: {} }]));
  fs.writeFileSync(path.join(dataDir, 'models.json'), JSON.stringify({ saved: Date.now(), agents: { claude: { models: MODELS, error: null, at: Date.now() } } }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
});
after(() => { child?.kill('SIGKILL'); if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); });

const login = async (username, password) => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  await r.arrayBuffer();
  return r.headers.get('set-cookie').split(';')[0];
};
const get = (cookie, p, method = 'GET', body) => fetch(base + p, { method, redirect: 'manual', headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });

test('a Chat only account gets /chat and nothing else', async () => {
  const cora = await login('cora', 'cora-password-1');
  for (const p of ['/', '/index.html', '/app.js']) {
    const r = await get(cora, p);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get('location'), '/chat');
  }
  for (const p of ['/chat', '/chat.js', '/chat.css', '/vendor/marked.js']) assert.equal((await get(cora, p)).status, 200, p);
  for (const p of ['/api/convos', '/api/me', '/api/files/list?path=/', '/api/credentials', '/api/users']) assert.equal((await get(cora, p)).status, 403, p);
  const home = await (await get(cora, '/api/chat')).json();
  assert.deepEqual([home.me.role, home.models.map((m) => m.id)], ['chat', ['opus', 'claude-fable-5-2', 'sonnet', 'fable', 'claude-opus-4-8']]);
  const { chat } = await (await get(cora, '/api/chat/chats', 'POST', {})).json();
  assert.equal(chat.model, 'opus');
  const refused = await new Promise((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie: cora } });
    ws.on('open', () => { ws.close(); resolve(false); });
    ws.on('error', () => resolve(true));
  });
  assert.ok(refused, 'no websocket for a Chat only account');

  // The admin sees the role and the chat count; deleting the account deletes its chats.
  const admin = await login('admin', 'admin-password-1');
  const { users } = await (await get(admin, '/api/users')).json();
  const c = users.find((u) => u.name === 'cora');
  assert.deepEqual([c.role, c.talks, c.orchestrator], ['chat', 1, false]);
  assert.equal((await get(admin, '/api/chat')).status, 200, 'admins can use Chat too');
  assert.equal((await get(admin, `/api/chat/chats/${chat.id}`)).status, 404, "but never see someone else's chats");
  const made = await (await get(admin, '/api/users', 'POST', { name: 'dee', password: 'dee-password-1', role: 'chat' })).json();
  assert.equal(made.user.role, 'chat');
  assert.equal((await get(admin, '/api/users/cora1', 'DELETE')).status, 200);
  assert.ok(!fs.existsSync(path.join(dataDir, 'chat-mode', `${chat.id}.json`)));
});
