// The approval gate inside real runs: the Claude PreToolUse permission hook (agents.mjs gateHooks) asking the proxy, and
// an orchestrator task whose connector call is held until the owner answers (approvals.mjs: deny with a reason, "always
// allow", the audit log, the chat notice, the run's timeout paused while held). The fake Claude `query` behaves like the
// CLI: it starts the MCP servers from its --mcp-config file and runs the PreToolUse hooks before each call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gateHooks } from '../agents.mjs';
import { answer, readAudit } from '../gate.mjs';
import { waitFor } from './helpers/wait.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(root, 'test/fixtures/fake-browser-mcp.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-run-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A minimal MCP client over a server record {command, args, env}.
const CLIENT = `function mcp(s, env = process.env) {
  const child = spawn(s.command, s.args || [], { env: { ...env, ...(s.env || {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0;
  const waits = new Map();
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waits.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise((r) => { const n = ++id; waits.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\\n'); });
  return { init: () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }),
    call: async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result, close: () => { child.stdin.end(); child.kill(); } };
}`;
const mcp = new Function('spawn', `${CLIENT}; return mcp;`)(spawn);
const txt = (r) => (r?.content || []).map((c) => c.text || '').join('\n');
// server.mjs's own MCP wiring, read as text (importing server.mjs boots the app): the orchestrator test below installs
// exactly this line, so a lambda that drops the run config (AUDIT #37) fails it.
const WIRING = fs.readFileSync(path.join(root, 'server.mjs'), 'utf8').match(/^setMcpSource\(.*?\);/m)?.[0];
const executed = (log) => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).name); } catch { return []; } };

test("server.mjs hands each run's gate and browser config to the extensions MCP source", () => {
  assert.equal(WIRING, 'setMcpSource((agent, run) => ext.mcpRun(agent, run));');
});

test('Claude runs: the PreToolUse permission hook holds an outbound call before the CLI dispatches it', async () => {
  const dir = path.join(tmp, 'hook'), log = path.join(tmp, 'hook.calls.jsonl'), cfg = path.join(dir, 'proxy-playwright.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ dir, server: 'playwright', kind: 'browser', hook: true, upstream: { command: process.execPath, args: [FAKE], env: { FAKE_MCP_LOG: log } } }));
  const c = mcp({ command: process.execPath, args: [path.join(root, 'gate-proxy.mjs'), '--config', cfg] });
  const pre = gateHooks({ dir, hook: true }).PreToolUse[0].hooks[0];
  const hook = (tool, args) => pre({ hook_event_name: 'PreToolUse', tool_name: `mcp__playwright__${tool}`, tool_input: args }, 'tu', { signal: new AbortController().signal });
  const approvals = () => { try { return fs.readdirSync(path.join(dir, 'approvals')).filter((n) => !n.includes('answer')); } catch { return []; } };
  try {
    await c.init();
    assert.deepEqual(await hook('browser_navigate', { url: 'https://mail.example.com/' }), {});
    await c.call('browser_navigate', { url: 'https://mail.example.com/' });
    assert.deepEqual(await hook('browser_snapshot', {}), {}, 'reads pass at once');
    assert.deepEqual(await pre({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }), {}, "the CLI's own tools are not the gate's");
    const send = { element: 'Send', target: 'e3' };
    // Deny: the hook tells the CLI no, with the owner's reason; the click never reaches the browser.
    const denied = hook('browser_click', send);
    await waitFor(() => approvals().length === 1, { timeout: 10000 });
    answer(dir, 'approvals', approvals()[0].replace('.json', ''), { decision: 'deny', reason: 'draft only' });
    const d = await denied;
    assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(d.hookSpecificOutput.permissionDecisionReason, /denied this action \(Click "Send" button.*\): draft only\. It was NOT performed/);
    assert.ok(!executed(log).includes('browser_click'));
    assert.match(txt(await c.call('browser_snapshot')), /Not sent/, 'the page is unchanged');
    // Approve: the hook allows it, and the call itself then runs without a second question.
    const ok = hook('browser_click', send);
    await waitFor(() => approvals().length === 2, { timeout: 10000 });
    answer(dir, 'approvals', approvals().find((n) => !fs.existsSync(path.join(dir, 'approvals', n.replace('.json', '.answer.json')))).replace('.json', ''), { decision: 'approve' });
    assert.deepEqual(await ok, {});
    assert.match(txt(await c.call('browser_click', send)), /Sent!/);
    assert.equal(approvals().length, 2, 'the pre-approved call was not asked about again');
    const a = readAudit(path.join(dir, 'audit.jsonl'));
    assert.deepEqual(a.filter((e) => e.tool === 'browser_click').map((e) => [e.class, e.decision, e.ok]), [['outbound', 'deny', false], ['outbound', 'approve', true]]);
  } finally { c.close(); }
});

test('orchestrator: a connector send is held (the run paused past its timeout), denied with a reason, then "always allowed"', { timeout: 120000 }, async () => {
  const repo = path.join(tmp, 'proj');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  const dataDir = path.join(tmp, 'data'), log = path.join(tmp, 'orch.calls.jsonl'), home = path.join(tmp, 'home');
  const url = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
  const script = `import { createOrchestrator } from ${url('orchestrator.mjs')};
    import { setMcpSource, setModelCatalog } from ${url('agents.mjs')};
    import { createExtensions } from ${url('extensions.mjs')};
    import { DatabaseSync } from 'node:sqlite';
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    import path from 'node:path';
    ${CLIENT}
    const [dataDir, repo, home, fake, log] = process.argv.slice(1);
    setModelCatalog('claude', { models: [{ id: 'opus', default: true }], error: null, at: 1 });
    const ext = createExtensions({ dataDir, home, claudeDir: path.join(home, '.claude'), codexDir: path.join(home, '.codex') });
    ext.saveMcp({ name: 'mail', commandLine: process.execPath + ' ' + fake, env: 'FAKE_MCP_LOG=' + log, outbound: 'send_email' });
    ${WIRING}
    const results = [], chat = [], pushed = [];
    let hooked = false;
    const query = ({ options }) => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-1' };
      const servers = JSON.parse(fs.readFileSync(options.extraArgs['mcp-config'], 'utf8')).mcpServers;
      const c = mcp(servers.mail, options.env);
      await c.init();
      const pre = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
      hooked = !!pre && Number(options.env.MCP_TOOL_TIMEOUT) > 86400000;
      const call = async (tool, args) => {
        const h = await pre({ hook_event_name: 'PreToolUse', tool_name: 'mcp__mail__' + tool, tool_input: args }, 'tu', { signal: options.abortController.signal });
        if (h.hookSpecificOutput?.permissionDecision === 'deny') return 'DENIED: ' + h.hookSpecificOutput.permissionDecisionReason;
        const r = await c.call(tool, args);
        return (r.content || []).map((x) => x.text).join('');
      };
      results.push(await call('search_messages', { q: 'invoice' }));
      for (const to of ['bob@example.com', 'amy@example.com', 'cat@example.com']) {
        results.push(await call('send_email', { to, subject: 'Invoice 42', api_key: 'sk-live-0123456789abcdefghij' }));
      }
      c.close();
      yield { type: 'result', subtype: 'success', result: 'AGENT-ORCH-STATUS: done — ok', session_id: 's-1', num_turns: 1 };
    })();
    const o = createOrchestrator({ config: { pollMs: 100, taskTimeoutSec: 2, meminfo: ${JSON.stringify(path.join(root, 'test/fixtures/meminfo-ample'))} }, query, dataDir,
      claudeEnv: { PATH: process.env.PATH, HOME: home }, getLimits: () => [], onSubscription: () => true,
      broadcast: (m) => { if (m.t === 'oapproval') pushed.push(m.kind); }, emitChat: (cid, ev) => chat.push({ cid, ...ev }), convoExists: () => true });
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,convo_id,created_at) VALUES(?,?,50,'active',0,'c1',0)").run(repo, 'proj').lastInsertRowid);
    const id = Number(db.prepare("INSERT INTO tasks(project_id,title,prompt,priority,created_at) VALUES(?,'Send the invoice','p',50,1)").run(pid).lastInsertRowid);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (f) => { for (let i = 0; i < 400 && !f(); i++) await sleep(100); return !!f(); };
    const get = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    const out = {};
    await until(() => o.pendingApprovals().length === 1);
    out.first = o.pendingApprovals()[0];
    out.view = o.taskDetail(id).task.approvals;
    await sleep(3000); // past the 2 s task timeout: a held run is paused, not killed
    out.stillRunning = get(id).status;
    out.deny = o.decideApproval(out.first.id, { decision: 'deny', reason: 'Bob is not the client' });
    out.again = o.decideApproval(out.first.id, { decision: 'approve' });
    await until(() => o.pendingApprovals().length === 1);
    const second = o.pendingApprovals()[0];
    out.always = o.decideApproval(second.id, { decision: 'always' });
    await until(() => get(id).status !== 'running' && get(id).status !== 'queued');
    out.status = get(id).status;
    out.results = results;
    out.hooked = hooked;
    out.actions = o.taskActions(id);
    out.chat = chat;
    out.pushed = pushed;
    out.gateDirs = fs.existsSync(path.join(dataDir, 'gate')) ? fs.readdirSync(path.join(dataDir, 'gate')) : [];
    console.log(JSON.stringify(out));
    process.exit(0);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repo, home, FAKE, log], { encoding: 'utf8', timeout: 100000 });
  const r = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(r.hooked, true, 'the Claude run got the permission hook and a long MCP tool timeout');
  assert.match(r.first.action, /^mail: send_email \(to: bob@example\.com, subject: Invoice 42, api_key: \[redacted\]\)$/);
  assert.equal(r.view.length, 1, 'the task view lists the held call');
  assert.equal(r.stillRunning, 'running', 'held past its timeout without being killed');
  assert.equal(r.deny.approval.status, 'denied');
  assert.match(r.again.error, /Already denied/);
  assert.equal(r.always.approval.status, 'always');
  assert.equal(r.status, 'done');
  assert.equal(r.results[0], '2 messages: "Invoice 42", "Lunch"', 'reads pass without asking');
  assert.match(r.results[1], /^DENIED: The owner denied this action .*: Bob is not the client\. It was NOT performed/);
  assert.deepEqual(r.results.slice(2), ['Sent to amy@example.com', 'Sent to cat@example.com'], 'approved once, then allowed for the rest of the task');
  assert.deepEqual(executed(log), ['search_messages', 'send_email', 'send_email'], 'the denied send never ran');
  assert.deepEqual(r.actions.approvals.map((a) => a.status), ['denied', 'always', 'auto']);
  const e = r.actions.entries;
  assert.deepEqual(e.map((x) => `${x.tool}:${x.class}:${x.decision || '-'}:${x.ok}`), [
    'search_messages:read:-:true', 'send_email:outbound:deny:false', 'send_email:outbound:always:true', 'send_email:outbound:auto:true']);
  assert.ok(e.every((x) => !x.broken && x.task > 0 && Number.isFinite(x.ts)), 'hash-chained, stamped, per task');
  assert.ok(e.every((x) => !JSON.stringify(x).includes('sk-live')), 'the api key never reaches the audit log');
  assert.ok(fs.existsSync(path.join(dataDir, 'audit', `${e[0].task}.jsonl`)));
  assert.deepEqual(r.chat.map((c) => [c.cid, c.t]), [['c1', 'approval'], ['c1', 'approval']], 'a chat notice for each question asked');
  assert.ok(r.pushed.includes('new') && r.pushed.includes('decided') && r.pushed.includes('auto'));
  assert.deepEqual(r.gateDirs, [], "the run's gate dir is removed when it ends");
});
