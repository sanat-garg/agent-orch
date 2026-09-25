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
const CID = 'chat-1';
let child, base, dataDir, home, aaStub, cookie;
let providerStatus = 200, releaseProvider;
const providerPaths = [];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-prev-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-prev-home-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'p', cwd: path.join(dataDir, 'no-such-project'), mode: 'orchestrator', model: '', createdAt: 1, updatedAt: 1, fullAccess: true }]));
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/codex-stub.mjs'), path.join(bin, 'codex'));
  fs.symlinkSync(path.join(ROOT, 'test/fixtures/agy-stub.mjs'), path.join(bin, 'agy'));
  fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify({ aa_api_key: 'test-key' }));
  aaStub = http.createServer(async (req, res) => {
    providerPaths.push(req.url);
    assert.equal(req.headers['x-api-key'], 'test-key');
    if (providerStatus === 'wait') await new Promise((r) => { releaseProvider = r; });
    const status = providerStatus === 200 && !req.url.includes('/free?') ? 403 : providerStatus;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? AA : { error: 'provider denied' }));
  });
  await new Promise((r) => aaStub.listen(0, '127.0.0.1', r));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // PATH without the real claude/codex/agy: only the stubs in the temp HOME.
  const PATH = `${bin}:/usr/local/bin:/usr/bin:/bin:${path.dirname(process.execPath)}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH, AA_API_KEY: '', CW_AA_BASE: `http://127.0.0.1:${aaStub.address().port}`,
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

const put = async (p, body) => { const r = await fetch(base + p, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: JSON.parse(await r.text()) }; };

test('PUT /api/convos/:id/fallbacks: validated against the discovered models; the convo payload and ?convo= preview carry it', { timeout: 60000 }, async () => {
  await preview('agent=codex&model=gpt-5.5'); // models discovered
  const unauth = await fetch(base + `/api/convos/${CID}/fallbacks`, { method: 'PUT', body: '{"fallbacks":null}' });
  assert.equal(unauth.status, 401);
  await unauth.arrayBuffer();
  for (const bad of [[{ agent: 'nope', model: 'gpt-5.5' }], [{ agent: 'codex', model: 'gpt-9000' }], [{ agent: 'antigravity', model: 'gpt-5.5' }], [{ agent: 'codex' }], 'codex', undefined]) {
    const r = await put(`/api/convos/${CID}/fallbacks`, { fallbacks: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await put('/api/convos/nope/fallbacks', { fallbacks: null })).status, 404);
  assert.equal((await get('/api/convos')).body.find((c) => c.id === CID).fallbacks, null, 'automatic by default');

  const list = [{ agent: 'codex', model: 'gpt-6-sol' }, { agent: 'antigravity', model: 'gemini-3.1-pro-high' }, { agent: 'codex', model: 'gpt-6-sol' }];
  let r = await put(`/api/convos/${CID}/fallbacks`, { fallbacks: list });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.fallbacks, list.slice(0, 2), 'duplicates dropped, order kept');
  assert.deepEqual((await get('/api/convos')).body.find((c) => c.id === CID).fallbacks, list.slice(0, 2));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'convos.json'), 'utf8'))[0].fallbacks, list.slice(0, 2));

  // Preview for the chat: the curated list in the owner's order (codex is limited by the earlier test), plus the automatic suggestion.
  ({ body: r } = await get(`/api/delegate/preview?agent=codex&model=gpt-5.5&convo=${CID}`));
  assert.deepEqual(r.fallbacks, list.slice(0, 2));
  assert.deepEqual(r.candidates.map((c) => [c.model, c.status]), [['gpt-6-sol', 'limited'], ['gemini-3.1-pro-high', 'available']]);
  assert.equal(r.candidates[1].metrics.agentic_index, 62);
  assert.deepEqual(r.suggested.map((c) => c.model), ['gemini-3.1-pro-high', 'gpt-6-sol']);
  assert.equal((await get('/api/delegate/preview?agent=codex&convo=nope')).status, 404);

  assert.deepEqual((await put(`/api/convos/${CID}/fallbacks`, { fallbacks: [] })).body.fallbacks, []);
  assert.deepEqual((await get(`/api/delegate/preview?agent=codex&model=gpt-5.5&convo=${CID}`)).body.candidates, []);
  assert.equal((await put(`/api/convos/${CID}/fallbacks`, { fallbacks: null })).body.fallbacks, null);
  ({ body: r } = await get(`/api/delegate/preview?agent=codex&model=gpt-5.5&convo=${CID}`));
  assert.equal(r.fallbacks, null);
  assert.deepEqual(r.candidates, r.suggested);
});

const setKey = async () => {
  const r = await fetch(base + '/api/aa/key', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'test-key' }) });
  return r.json();
};

test('saved free-tier connection reaches popup JSON; loading, unmatched, provider failure and unconfigured stay distinct', async () => {
  let { body: d } = await preview('agent=codex&model=gpt-5.5');
  assert.ok(providerPaths.includes('/language/models?page=1'));
  assert.ok(providerPaths.includes('/language/models/free?page=1'));
  assert.equal(d.data_status, 'ready');
  assert.equal(d.start.metrics.coding_index, 50);
  assert.equal(d.start.metrics.agentic_index, 55);
  assert.ok(!JSON.stringify(d).includes('test-key'));
  // The real free shape omits benchmarks: never invent them or coerce null to zero.
  const original = structuredClone(AA);
  AA.data = AA.data.filter((m) => m.slug !== 'gpt-6-sol').map((m) => ({ ...m, evaluations: {
    artificial_analysis_intelligence_index: m.evaluations.artificial_analysis_intelligence_index,
    artificial_analysis_coding_index: m.evaluations.artificial_analysis_coding_index,
    artificial_analysis_agentic_index: null,
  } }));
  providerStatus = 'wait';
  const pending = setKey();
  while (!releaseProvider) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await get('/api/delegate/preview?agent=codex&model=gpt-5.5')).body.data_status, 'loading');
  providerStatus = 200; releaseProvider(); await pending;
  await put(`/api/convos/${CID}/fallbacks`, { fallbacks: [{ agent: 'codex', model: 'gpt-6-sol' }] });
  d = (await get(`/api/delegate/preview?agent=codex&model=gpt-5.5&convo=${CID}`)).body;
  assert.equal(d.data_status, 'ready');
  assert.equal(d.start.metrics.coding_index, 50);
  assert.equal(d.start.metrics.agentic_index, null);
  assert.deepEqual(d.start.metrics.benchmarks, {});
  assert.equal(d.candidates[0].model, 'gpt-6-sol');
  assert.equal(d.candidates[0].metrics, null);
  assert.equal(d.candidates[0].score, null);
  assert.equal(d.suggested[0].metrics.coding_index, 49);
  // Execute the actual popup consumer with the serialized HTTP response.
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="apTitle"></div><div id="apSub"></div><div id="apBody"></div>');
    const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    const functions = app.slice(app.indexOf('function renderAutoPreview()'), app.indexOf('const pickVal ='));
    const metrics = app.slice(app.indexOf('const DG_METRICS ='), app.indexOf('function openDelegate('));
    await page.addScriptTag({ content: `
      const $=id=>document.getElementById(id), el=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls||'';if(text)e.textContent=text;return e};
      const state={}, shortLabel=a=>a, apName=r=>r.label, apStatusText=r=>r.status, modelLabel=(a,m)=>m, apKey=r=>r.agent+"/"+r.model;
      const AP={data:null,fe:{}}, AP_ST={}, AGENT_LIST=[], apSaveFallbacks=()=>{}, toast=()=>{};
      ${metrics}
${functions}
      window.renderData=d=>{AP.data=d;renderAutoPreview();};
    ` });
    await page.evaluate((d) => window.renderData(d), d);
    assert.equal(await page.locator('details').getAttribute('open'), null);
    await page.locator('summary').click();
    assert.match(await page.locator('#apBody').innerText(), /50.0/);
    assert.match(await page.locator('#apBody').innerText(), /No metrics available for this model/);
    assert.ok((await page.locator('.v').allTextContents()).includes('—'));
    for (const [status, message] of [['loading', /Loading Artificial Analysis/], ['unconfigured', /Connect Artificial Analysis/], ['error', /Check Artificial Analysis in Connections/]]) {
      await page.evaluate((d) => window.renderData(d), { ...d, data_status: status });
      assert.match(await page.locator('#apBody').innerText(), message);
    }
  } finally { await browser.close(); }

  providerStatus = 503; await setKey();
  d = (await get('/api/delegate/preview?agent=codex&model=gpt-5.5')).body;
  assert.equal(d.data_status, 'error');
  assert.match(d.data_error, /503/);
  assert.equal(d.stale, true);
  assert.equal(d.start.metrics.coding_index, 50, 'cached real data survives provider failure');
  const del = await fetch(base + '/api/aa/key', { method: 'DELETE', headers: { cookie } }); await del.arrayBuffer();
  d = (await get('/api/delegate/preview?agent=codex&model=gpt-5.5')).body;
  assert.equal(d.data_status, 'unconfigured');
  assert.equal(d.start.metrics, null);
  // Simulate a first-fetch failure, with no previous successful cache.
  fs.unlinkSync(path.join(dataDir, 'aa-models.json'));
  const { createAAStore } = await import('../aa.mjs');
  const store = createAAStore({ dataDir, metaDir: dataDir, catalog: () => ({ codex: [{ id: 'gpt-5.5' }] }), env: {}, fetch: async () => new Response('{}', { status: 401 }) });
  await store.setKey('test-key');
  assert.equal(store.view().data_status, 'error');
  assert.equal(store.view().source, 'artificialanalysis');
  assert.equal(store.view().entries[0].metrics, null);
  assert.match(store.view().data_error, /rejected/);
  AA.data = original.data;
});
