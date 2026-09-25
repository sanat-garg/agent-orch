// GET /api/delegate/preview: boots server.mjs with stub codex/agy CLIs (signed in, fixture model lists), no Claude,
// and a stub Artificial Analysis API serving fixture metrics. Codex is then marked at its usage limit.
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'preview-test-password';
const ev = (ii, ci, ai, tb) => ({ artificial_analysis_intelligence_index: ii, artificial_analysis_coding_index: ci, artificial_analysis_agentic_index: ai, terminalbench_hard: tb });
// Coding scores (0.6 × Coding Index + 0.4 × Terminal-Bench): GPT-5.5 50, GPT-6 Sol 55.2, Gemini 3.1 Pro 49.2.
const AA = { pagination: { page: 1, total_pages: 1, has_more: false }, data: [
  { id: 'a1', name: 'GPT-5.5', slug: 'gpt-5-5', model_creator: { name: 'OpenAI' }, evaluations: ev(60, 50, 55, 0.5) },
  { id: 'a2', name: 'GPT-6 Sol', slug: 'gpt-6-sol', model_creator: { name: 'OpenAI' }, evaluations: ev(66, 56, 60, 0.54) },
  { id: 'a3', name: 'Gemini 3.1 Pro', slug: 'gemini-3-1-pro', model_creator: { name: 'Google' }, evaluations: ev(58, 49, 62, 0.495) },
] };
let child, base, dataDir, home, aaStub, cookie;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-prev-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-prev-home-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/codex-stub.mjs'), path.join(bin, 'codex'));
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/agy-stub.mjs'), path.join(bin, 'agy'));
  aaStub = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(AA)); });
  await new Promise((r) => aaStub.listen(0, '127.0.0.1', r));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // PATH without the real claude/codex/agy: only the stubs in the temp HOME.
  const PATH = `${bin}:/usr/local/bin:/usr/bin:/bin:${path.dirname(process.execPath)}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH, AA_API_KEY: 'test-key', CW_AA_BASE: `http://127.0.0.1:${aaStub.address().port}`,
    PORT: String(port), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const ok = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = ok.headers.get('set-cookie').split(';')[0];
  await ok.arrayBuffer();
});

after(() => {
  child?.kill('SIGKILL');
  aaStub?.close();
  for (const d of [dataDir, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const get = async (p) => { const r = await fetch(base + p, { headers: { cookie } }); return { status: r.status, body: JSON.parse(await r.text()) }; };
// Model discovery and the AA refresh run at boot; wait until the preview sees all three models.
async function preview(q) {
  let r;
  for (let i = 0; i < 100; i++) {
    r = await get(`/api/delegate/preview?${q}`);
    if (r.status === 200 && r.body.start.score != null && r.body.candidates.length === 2) return r;
    await new Promise((res) => setTimeout(res, 200));
  }
  assert.fail(`preview never settled: ${JSON.stringify(r)}`);
}

test('GET /api/delegate/preview needs a session', async () => {
  const r = await fetch(base + '/api/delegate/preview?agent=codex');
  assert.equal(r.status, 401);
  await r.arrayBuffer();
});

test('preview: start model plus comparable candidates; a limited agent is marked unavailable and ranked last', { timeout: 60000 }, async () => {
  let { body } = await preview('agent=codex&model=gpt-5.5');
  assert.equal(body.category, 'coding', 'category defaults to coding');
  assert.equal(body.source, 'artificialanalysis');
  assert.deepEqual([body.start.agent, body.start.model, body.start.score, body.start.status], ['codex', 'gpt-5.5', 50, 'available']);
  // Most similar first: Gemini (49.2) is closer to GPT-5.5 (50) than GPT-6 Sol (55.2).
  assert.deepEqual(body.candidates.map((c) => [c.model, c.status]), [['gemini-3.1-pro-high', 'available'], ['gpt-6-sol', 'available']]);
  const c = body.candidates[0];
  assert.match(c.reason, /^coding: 49.2 vs GPT-5.5 50/);
  assert.equal(c.metrics.agentic_index, 62);

  // Codex at its usage limit: the start model and GPT-6 Sol are limited; GPT-6 Sol ranks after the available Gemini.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
  const until = Math.floor(Date.now() / 1000) + 3600;
  db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run('blocked_until:codex', String(until));
  db.close();
  ({ body } = await get('/api/delegate/preview?agent=codex&model=gpt-5.5&category=agentic'));
  assert.equal(body.category, 'agentic');
  assert.deepEqual([body.start.status, body.start.until, body.start.note], ['limited', until, 'usage limit']);
  // agentic: GPT-6 Sol (60) is closer to GPT-5.5 (55) than Gemini (62), but it is limited, so it comes last.
  assert.deepEqual(body.candidates.map((c) => [c.model, c.status]), [['gemini-3.1-pro-high', 'available'], ['gpt-6-sol', 'limited']]);
  assert.equal(body.candidates[1].until, until);

  assert.equal((await get('/api/delegate/preview?agent=nope')).status, 400);
});
