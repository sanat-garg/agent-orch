// Compute-only workers (BRIEF goal 11; CLUSTER.md, Compute-only workers). A worker acts only on the head's allow-listed
// frames (cluster-protocol.mjs WORKER_ACCEPTS) and rejects and logs the rest: a real worker.mjs process against a fake
// head (a bare `ws` server that sends whatever it likes). The head's hub never sends anything else, and its scheduler
// never places plan (the owner's chat with the planner) or reflect work on a worker: the orchestrator in a child process
// with a stub hub whose one worker is idle, online and signed in to everything. server.mjs refuses to start on a paired
// worker. And the worker has no local control surface: nothing of the head in its module graph, no TCP port (only its
// status socket, a 0600 unix socket in its home), no CLI command but pair/run/status and limit (its one local setting, the
// CPU/RAM it lends), installers that set up only the worker service.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { DIRECTION, FEATURE_LIST, MSG, PROTOCOL_VERSION, WORKER_ACCEPTS, WS_PATH, createSender, decode } from '../cluster-protocol.mjs';
import { createCluster } from '../cluster.mjs';
import { remoteWork } from '../orchestrator.mjs';
import { JOB_ENV, headRefusal } from '../role.mjs';
import { isolatedPath } from './helpers/isolated-path.mjs';
import { waitFor } from './helpers/wait.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let tmp;
const dir = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d; };
const pairedHome = (home, cfg = {}) => {
  const whome = dir(path.relative(tmp, path.join(home, '.agent-orch-worker')));
  fs.writeFileSync(path.join(whome, 'config.json'), JSON.stringify({ controller: 'https://head.example', node: 'n_1', name: 'mac-1', token: 'aon_secret', ...cfg }), { mode: 0o600 });
  return whome;
};
// The environment a child gets: this one without any worker marker (the suite may itself run inside a worker's job).
const cleanEnv = (extra) => {
  const env = { ...process.env, ...extra };
  for (const k of ['AGENT_ORCH_WORKER_HOME', JOB_ENV]) if (!(k in extra)) delete env[k];
  return env;
};
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-compute-only-')); });
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('the allow-list: jobs, sign-in, refreshes, logs, updates, policy, the live browser view and extension sync from the head, nothing chat-, prompt- or settings-like', () => {
  assert.deepEqual([...WORKER_ACCEPTS].sort(), [
    'ack', 'agent.credential', 'bye', 'error', 'ext.sync', 'git.credential', 'heartbeat', 'job.approval', 'job.attach', 'job.cancel', 'job.offer', 'job.pause', 'job.resume', 'job.start',
    'limits.refresh', 'login.cancel', 'login.code', 'login.logout', 'login.start', 'logs.tail', 'models.refresh', 'node.policy', 'node.update',
    'ping', 'screen.input', 'screen.req', 'welcome',
  ]);
  for (const t of WORKER_ACCEPTS) {
    assert.doesNotMatch(t, /chat|prompt|plan|reflect|convo|setting|config|ui\b/, t);
    assert.notEqual(DIRECTION[t], 'w', `${t} is a worker's frame`);
  }
  assert.ok(Object.isFrozen(WORKER_ACCEPTS));
  // decode refuses an off-list type before validating it, even a valid frame of the protocol.
  const frame = (t, f = {}) => JSON.stringify({ t, seq: 1, ts: Date.now(), ...f });
  assert.deepEqual(decode(frame('chat', { text: 'hi' }), { from: 'c', accept: WORKER_ACCEPTS }), { error: '"chat" is not accepted here', refused: 'chat' });
  assert.equal(decode(frame('job.event', { job: 1, from: 0, events: [{ k: 'text', text: 'x' }] }), { from: 'c', accept: WORKER_ACCEPTS }).refused, 'job.event');
  assert.equal(decode(frame('job.cancel', { job: 1 }), { from: 'c', accept: ['job.offer'] }).refused, 'job.cancel');
  assert.equal(decode(frame('job.cancel', { job: 1 }), { from: 'c', accept: WORKER_ACCEPTS }).msg.t, 'job.cancel');
});

test('the head\'s hub never sends a worker anything off the allow-list', () => {
  const hub = createCluster({ dbFile: path.join(dir('hub'), 'hub.db') });
  try {
    for (const msg of [{ t: 'chat', text: 'hi' }, { t: 'prompt', prompt: 'x' }, { t: 'job.event', job: 1, from: 0, events: [] }]) {
      assert.throws(() => hub.send('n_1', msg), /is not for a worker: workers are compute-only/);
    }
    assert.equal(hub.send('n_1', { t: MSG.JOB_CANCEL, job: 1 }), false, 'an allowed frame to a node that is not connected');
  } finally { hub.close(); }
});

test('the worker rejects and logs every frame off the allow-list, still acts on allowed ones, and listens on no TCP port', { timeout: 60_000 }, async () => {
  const home = dir('w-home'), bin = dir('w-bin');
  isolatedPath(bin); // no agent CLIs: inventory says so, and a job offer is declined as agent_missing
  const frames = [], errors = () => frames.filter((f) => f.t === MSG.ERROR);
  let sock = null, beat = null;
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ server, path: WS_PATH });
  wss.on('connection', (ws) => {
    sock = ws;
    const send = createSender('c');
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      frames.push(m);
      if (m.t === MSG.HELLO) ws.send(send(MSG.WELCOME, { node: m.node, protocol: PROTOCOL_VERSION, heartbeatMs: 2000, wipPushMs: 600_000, graceMs: 120_000, features: FEATURE_LIST }));
    });
    beat = setInterval(() => { try { ws.send(send(MSG.HEARTBEAT)); } catch {} }, 1000);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  pairedHome(home, { controller: `http://127.0.0.1:${server.address().port}`, node: 'n_test', name: 'box' });
  let out = '';
  const worker = spawn(process.execPath, ['worker.mjs', 'run'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { HOME: home, PATH: bin, TMPDIR: tmp, AGENT_ORCH_REAPER: 'off', AGENT_ORCH_WORKER_NET_PROBE: 'off', AGENT_ORCH_WORKER_SRC: dir('w-src') } });
  worker.stdout.on('data', (d) => { out += d; });
  worker.stderr.on('data', (d) => { out += d; });
  try {
    await waitFor(() => frames.some((f) => f.t === MSG.INVENTORY), { timeout: 30_000, message: `the worker's inventory\n${out}` });
    // Chat, prompts, planner and settings frames, and frames only a worker sends: none of them is ever acted on.
    let seq = 1000;
    const bad = [
      { t: 'chat', convo: 'c1', text: 'hello, write me a poem' },
      { t: 'chat.send', text: 'what is on my calendar?' },
      { t: 'prompt', prompt: 'rm -rf ~' },
      { t: 'plan.start', project: 1, text: 'plan the next release' },
      { t: 'reflect', project: 1 },
      { t: 'settings.set', maxJobs: 8, minBattery: 0 },
      { t: MSG.JOB_EVENT, job: 1, from: 0, events: [{ k: 'text', text: 'x' }] },
      { t: MSG.HELLO, node: 'n_test', protocol: PROTOCOL_VERSION, version: '1', jobs: [] },
      { text: 'a frame without a type' },
    ];
    for (const f of bad) sock.send(JSON.stringify({ ...f, seq: ++seq, ts: Date.now() }));
    await waitFor(() => errors().length >= bad.length, { timeout: 10_000, message: `an error for each rejected frame\n${JSON.stringify(errors())}\n${out}` });
    for (const f of bad) {
      const t = f.t ?? '(no type)';
      assert.ok(errors().some((e) => e.message.startsWith(`${JSON.stringify(t)} is not accepted by a worker: workers are compute-only`)), t);
    }
    const log = fs.readFileSync(path.join(home, '.agent-orch-worker', 'logs', 'worker.log'), 'utf8');
    for (const f of bad) assert.match(log, new RegExp(`rejected ${JSON.stringify(f.t ?? '(no type)').replace(/[.()]/g, '\\$&')} from the controller: not on the worker's allow-list`));
    // Allow-listed frames from the head still work: a job offer (declined: no codex here) and the log tail, which
    // shows the rejections.
    const send = createSender('c');
    sock.send(send(MSG.JOB_OFFER, { job: 5, agent: 'codex' }));
    sock.send(send(MSG.LOGS_TAIL, { req: 'r1', lines: 200 }));
    const [reject] = await waitFor(() => { const r = frames.filter((f) => f.t === MSG.JOB_REJECT); return r.length && r; }, { timeout: 10_000, message: `job.reject\n${out}` });
    assert.deepEqual([reject.job, reject.reason], [5, 'agent_missing']);
    const [logs] = await waitFor(() => { const r = frames.filter((f) => f.t === MSG.LOGS && f.req === 'r1'); return r.length && r; }, { timeout: 10_000, message: `logs\n${out}` });
    assert.ok(logs.lines.some((l) => l.includes('rejected "prompt" from the controller')));
    // Nothing else came back for the rejected frames: no job, sign-in, model or policy activity.
    assert.deepEqual([...new Set(frames.map((f) => f.t))].filter((t) => ![MSG.HELLO, MSG.INVENTORY, MSG.RESOURCES, MSG.HEARTBEAT, MSG.ERROR, MSG.JOB_REJECT, MSG.LOGS].includes(t)), []);
    // No local control surface: the daemon itself holds no listening TCP socket; its only listener is the status view's
    // unix socket in its home, readable by its own user alone. (Read from /proc, so checked on Linux only.)
    if (process.platform === 'linux') {
      const inodes = new Set(fs.readdirSync(`/proc/${worker.pid}/fd`).map((fd) => { try { return /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${worker.pid}/fd/${fd}`))?.[1]; } catch { return null; } }).filter(Boolean));
      assert.ok(inodes.size > 0, 'sees the worker\'s sockets (its connection to the head)');
      const listening = [];
      for (const f of ['tcp', 'tcp6']) {
        for (const l of fs.readFileSync(`/proc/net/${f}`, 'utf8').split('\n').slice(1)) {
          const c = l.trim().split(/\s+/);
          if (c[3] === '0A' && inodes.has(c[9])) listening.push(`${f} ${c[1]}`);
        }
      }
      for (const l of fs.readFileSync('/proc/net/unix', 'utf8').split('\n').slice(1)) {
        const c = l.trim().split(/\s+/);
        if (c.length > 6 && (parseInt(c[3], 16) & 0x10000) && inodes.has(c[6])) listening.push(`unix ${c[7] || '(anonymous)'}`);
      }
      // A long home is bound by its name relative to the home (worker-status.mjs), so match the socket by its name.
      const statusSock = path.join(home, '.agent-orch-worker', 'worker.sock');
      assert.deepEqual(listening.map((l) => (/^unix (\S*\/)?worker\.sock$/.test(l) ? 'unix worker.sock' : l)), ['unix worker.sock']);
      assert.equal(fs.statSync(statusSock).mode & 0o777, 0o600);
    }
  } finally {
    clearInterval(beat);
    worker.kill('SIGTERM');
    await new Promise((r) => { const t = setTimeout(() => { worker.kill('SIGKILL'); r(); }, 10_000); worker.on('exit', () => { clearTimeout(t); r(); }); });
    wss.close();
    server.close();
  }
});

test('the scheduler never places plan (the chat\'s planner) or reflect work on a worker, only work tasks', { timeout: 120_000 }, async () => {
  // Integrators are work too (#435): a worker merges and the head lands the result.
  assert.deepEqual([{ kind: 'work' }, { kind: 'plan' }, { kind: 'reflect' }, { kind: 'review' }, { kind: 'work', integrates: 3 }].map(remoteWork), [true, false, false, false, true]);
  // The project: a git repo whose origin is a GitHub URL (a local bare repo under it, via url.insteadOf in HOME), so a
  // work task in it can go to the worker.
  const home = dir('s-home'), dataDir = dir('s-data'), repo = dir('s-demo'), origin = path.join(tmp, 's-origin.git'), url = 'https://github.com/test-owner/demo.git';
  fs.writeFileSync(path.join(home, '.gitconfig'), `[url "file://${origin}"]\n\tinsteadOf = ${url}\n[user]\n\tname = t\n\temail = t@t\n`);
  const env = cleanEnv({ HOME: home, GIT_CONFIG_NOSYSTEM: '1' });
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', url);
  git('push', '-q', '-u', 'origin', 'main');
  const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
    import { waitFor } from ${JSON.stringify(new URL('./helpers/wait.mjs', import.meta.url).href)};
    import { DatabaseSync } from 'node:sqlite';
    import path from 'node:path';
    const [dataDir, repo] = process.argv.slice(1), GB = 2 ** 30;
    // Claude on the controller (the planner and the reflector): answers at once.
    const query = () => (async function* () {
      yield { type: 'result', subtype: 'success', result: 'Nothing to add. AGENT-ORCH-STATUS: done — ok', session_id: 's-' + Math.random(), num_turns: 1 };
    })();
    const o = createOrchestrator({ config: { pollMs: 100, meminfo: ${JSON.stringify(new URL('./fixtures/meminfo-ample', import.meta.url).pathname)}, footprint: { claude: 1, codex: 1 } },
      query, dataDir, claudeEnv: { PATH: process.env.PATH }, getLimits: () => [], onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => false });
    // A stub hub with one idle worker, signed in to every agent, with room for 8 tasks: it records every frame sent to it
    // and declines every job, so a work task placed there comes back and waits.
    const sent = [];
    let onMsg = () => {};
    const worker = { id: 'n_1', name: 'vps-2', os: 'linux', arch: 'arm64', local: false, status: 'online', connected: true, enabled: true, draining: false, maxSlots: 8,
      inventory: { cores: 8, agents: ['claude', 'codex'].map((id) => ({ id, installed: true, signedIn: true })) }, resources: { memAvailable: 64 * GB, at: Date.now() } };
    o.attachCluster({
      listNodes: () => [{ id: 'controller', local: true, status: 'online', connected: true, enabled: true }, worker],
      node: (id) => (id === worker.id ? worker : null), isConnected: (id) => id === worker.id, version: () => 1, onMessage: (fn) => { onMsg = fn; },
      send: (node, msg) => {
        sent.push({ node, ...msg });
        if (msg.t === 'job.offer') setTimeout(() => onMsg(node, { t: 'job.reject', job: msg.job, reason: 'busy', seq: sent.length, ts: Date.now() }), 20);
        return true;
      },
    });
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    // Keep improving on (an off project runs no reflect task at all), with the next reflection a year away so
    // scheduleReflections adds none of its own: only the hand-made reflect task below runs.
    const pid = Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,next_reflect_at,created_at) VALUES(?,'demo',50,'active',1,?,0)")
      .run(repo, Date.now() / 1000 + 86400 * 365).lastInsertRowid);
    const task = (kind, title, source = 'user') => Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,priority,urgency,source,created_at) VALUES(?,?,?,?,50,'normal',?,?)")
      .run(pid, kind, title, title, source, Date.now() / 1000).lastInsertRowid);
    // The owner's chat message waits for the planner (a plan task answers it), a reflection, and a work task.
    db.prepare("INSERT INTO messages(project_id,content,status,created_at) VALUES(?,'Please plan the release','pending',?)").run(pid, Date.now() / 1000);
    const plan = task('plan', "Answer owner's message"), reflect = task('reflect', 'Reflect: what else should be done?', 'reflection'), work = task('work', 'Add a feature');
    const get = (id) => db.prepare('SELECT id, kind, status, node_id FROM tasks WHERE id=?').get(id);
    await waitFor(() => ['done', 'failed'].includes(get(plan).status) && ['done', 'failed'].includes(get(reflect).status) && sent.some((f) => f.t === 'job.offer'), { timeout: 60000 });
    await waitFor(() => get(work).status === 'queued', { timeout: 30000 }); // declined: back in the queue
    const runs = db.prepare('SELECT task_id, node_id FROM runs').all();
    const message = db.prepare('SELECT status FROM messages').get().status;
    console.log(JSON.stringify({ ids: { plan, reflect, work }, plan: get(plan), reflect: get(reflect), work: get(work), runs, sent, message }));
    process.exit(0);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repo], { cwd: ROOT, env, encoding: 'utf8', timeout: 110_000 });
  const r = JSON.parse(stdout.trim().split('\n').pop());
  // The control: the worker was free and eligible, and the work task went there first.
  assert.ok(r.sent.some((f) => f.t === 'job.offer' && f.node === 'n_1' && f.job === r.ids.work), JSON.stringify(r.sent));
  // The planner answered the chat on the controller, and the reflection ran there too.
  assert.deepEqual([r.plan.status, r.plan.node_id, r.message], ['done', 'controller', 'done']);
  assert.deepEqual([r.reflect.status, r.reflect.node_id], ['done', 'controller']);
  assert.deepEqual(r.runs.filter((x) => x.task_id !== r.ids.work && x.node_id != null && x.node_id !== 'controller'), []);
  // Not one frame about them went to the worker, and nothing sent is off the worker's allow-list.
  assert.deepEqual(r.sent.filter((f) => f.job !== r.ids.work), []);
  for (const f of r.sent) assert.ok(WORKER_ACCEPTS.includes(f.t), f.t);
});

test('server.mjs refuses to start on a paired worker, before it creates or starts anything', { timeout: 60_000 }, async () => {
  const home = dir('h-home'), dataDir = dir('h-data');
  const whome = pairedHome(home);
  const env = cleanEnv({ HOME: home, PORT: String(await freePort()), CW_DATA_DIR: dataDir, CW_NO_ORCHESTRATOR: '1' });
  const run = (...args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.mjs', ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => child.kill('SIGKILL'), 30_000); // a server that did start: killed, and the asserts fail
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
  });
  const r = await run();
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /agent-orch: not starting\. This machine is a worker \(paired as "mac-1" with https:\/\/head\.example/);
  assert.match(r.stderr, /compute-only/);
  assert.match(r.stderr, /node worker\.mjs run/);
  assert.ok(r.stderr.includes(whome), 'names the worker home to remove');
  assert.doesNotMatch(r.stdout + r.stderr, /agent-orch on 127\.0\.0\.1|aon_secret/);
  assert.deepEqual(fs.readdirSync(dataDir), [], 'no logs, DB or state files');
  // set-password can't make it a head either.
  const p = await run('set-password', 'a-long-enough-password');
  assert.equal(p.code, 1);
  assert.match(p.stderr, /not starting/);
  assert.deepEqual(fs.readdirSync(dataDir), []);

  // The rule itself (role.mjs): a paired worker with no head data here is refused; a head also paired as a worker, an
  // unpaired machine and a server a worker's job starts (the project's own tests) are not.
  const e = { AGENT_ORCH_WORKER_HOME: whome };
  assert.match(headRefusal({ dataDir, env: e }), /not starting/);
  assert.equal(headRefusal({ dataDir, env: { AGENT_ORCH_WORKER_HOME: dir('h-unpaired') } }), null);
  assert.equal(headRefusal({ dataDir, env: { ...e, [JOB_ENV]: '7' } }), null);
  const head = dir('h-head');
  fs.writeFileSync(path.join(head, 'auth.json'), '{}');
  assert.equal(headRefusal({ dataDir: head, env: e }), null);
  const db = dir('h-db/orchestrator');
  fs.writeFileSync(path.join(db, 'agent-orch.db'), '');
  assert.equal(headRefusal({ dataDir: path.dirname(db), env: e }), null);
});

test('worker.mjs loads nothing of the head: no server, orchestrator (planner, reflection), hub or chat runtimes', () => {
  const seen = new Set(), stack = ['worker.mjs'];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^;'"`]*?\bfrom\s+'(\.\/[^']+)'|^\s*import\s+'(\.\/[^']+)'/gm)) stack.push(path.normalize(m[1] || m[2]));
  }
  assert.ok(['cluster-protocol.mjs', 'taskrun.mjs', 'agents.mjs', 'role.mjs'].every((f) => seen.has(f)), [...seen].join(' '));
  for (const f of ['server.mjs', 'orchestrator.mjs', 'cluster.mjs', 'runtimes.mjs']) assert.ok(!seen.has(f), `worker.mjs loads ${f}`);
});

test('the worker CLI has one local setting (limit): pair, run, status and limit only; its slots, policy and draining come from the head', () => {
  const home = dir('c-home'), whome = pairedHome(home), cfg = path.join(whome, 'config.json'), before = fs.readFileSync(cfg, 'utf8');
  for (const argv of [['drain'], ['slots', '4'], ['policy', '--min-battery', '10'], ['set', 'maxJobs', '8']]) {
    const r = spawnSync(process.execPath, ['worker.mjs', ...argv], { cwd: ROOT, encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, AGENT_ORCH_REAPER: 'off' } });
    assert.equal(r.status, 1, argv.join(' '));
    assert.match(r.stderr, /set on the head/);
    assert.match(r.stdout, /^usage: node worker\.mjs pair .*\| run \| status \[--once\] \| limit …$/m);
  }
  assert.equal(fs.readFileSync(cfg, 'utf8'), before);
});

test('the installers set up only the worker service: no agent-orch web service, Caddy or ttyd', () => {
  const ARGS = ['--dry-run', '--controller', 'https://head.example', '--code', 'ABCD-2345', '--name', 'box', '--agents', 'claude,codex'];
  // install-worker.sh needs systemd, so it runs on Linux only.
  const runs = [...(process.platform === 'linux' ? [['install-worker.sh', ARGS]] : []), ['install-worker-macos.sh', ARGS], ['install-worker-macos.sh', [...ARGS, '--service', 'login']],
    ['install-worker-macos.sh', [...ARGS, '--no-dedicated-user']]];
  for (const [script, args] of runs) {
    const home = fs.mkdtempSync(path.join(tmp, 'i-'));
    const r = spawnSync('bash', [path.join(ROOT, 'bin', script), ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, NVM_DIR: path.join(home, 'nvm') } });
    const what = `${script} ${args.slice(8).join(' ')}`;
    assert.equal(r.status, 0, `${what}: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /caddy|ttyd|server\.mjs|agent-orch\.service|agent-orch-shell|agent-orch-tmux/i, what);
    // Every file it writes belongs to the worker's service, which runs `worker.mjs run` and nothing else.
    const written = [...r.stdout.matchAll(/^\+ write (\S+?):?(?: \(|$)/gm)].map((m) => m[1]);
    assert.ok(written.length, what);
    for (const f of written) assert.match(f, /agent-orch-worker|com\.agent-orch\.worker/, `${what} writes ${f}`);
    const starts = [
      ...[...r.stdout.matchAll(/ExecStart=(.+)/g)].map((m) => m[1]),
      ...[...r.stdout.matchAll(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/g)].map((m) => [...m[1].matchAll(/<string>([^<]*)<\/string>/g)].map((s) => s[1]).join(' ')),
      ...[...r.stdout.matchAll(/^\s*exec (.+)$/gm)].map((m) => m[1].replace(/"/g, '')),
    ];
    assert.ok(starts.length, what);
    for (const s of starts) assert.match(s, /\/worker\.mjs run$|^\/usr\/bin\/sudo -n -u agentorch -H \/usr\/local\/bin\/agent-orch-worker-run$/, `${what} starts ${s}`);
    for (const m of r.stdout.matchAll(/systemctl (?:enable|restart|start) (\S+)/g)) assert.equal(m[1], 'agent-orch-worker.service', what);
    for (const m of r.stdout.matchAll(/launchctl bootstrap \S+ (\S+)/g)) assert.match(m[1], /com\.agent-orch\.worker\.plist$/, what);
  }
});
