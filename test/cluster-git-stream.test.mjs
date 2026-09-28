// The head's git endpoint streams (cluster-git.mjs, #429): a push is checked from its first pkt-lines and piped into git,
// never held whole in the head's memory; a refused push is answered before its body is read; a request with no command
// list in its first MAX_PUSH_PREFIX bytes gets 400; and a client that goes away mid-clone leaves no git running.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createClusterGit, MAX_PUSH_PREFIX } from '../cluster-git.mjs';
import { GIT_PATH, gitPath } from '../cluster-protocol.mjs';

const TOKEN = 'aon_stream';
const BLOB = 8 << 20;
let tmp, project, server, base, logs = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
const auth = (url) => ['-c', `http.${url}.extraHeader=Authorization: Bearer ${TOKEN}`];
const workerGit = (cwd, url, ...args) => promisify(execFile)('git', [...auth(url), ...args], { cwd, env, encoding: 'utf8', maxBuffer: 1 << 26 });
const pkt = (s) => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
const Z = '0'.repeat(40), A = 'a'.repeat(40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A raw POST to the project's git endpoint: resolves with the response (status + body) and how many body bytes the client
// had written by then; `send(write)` produces the body, stopping once `write` returns false.
function post(service, send, headers = {}) {
  return new Promise((resolve, reject) => {
    let sent = 0, answered = false;
    const req = http.request(`${base}${gitPath(1)}/${service}`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': `application/x-${service}-request`, ...headers },
    }, (res) => {
      answered = true;
      const at = sent, chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), sentBefore: at }); req.destroy(); });
      res.on('error', () => resolve({ status: res.statusCode, text: '', sentBefore: at }));
    });
    req.on('error', (e) => { if (!answered) reject(e); });
    const write = (b) => { if (answered || req.destroyed) return false; sent += b.length; req.write(b); return true; };
    Promise.resolve(send(write)).then(() => { if (!answered && !req.destroyed) req.end(); }, reject);
  });
}

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cluster-git-stream-')));
  env.HOME = tmp;
  project = path.join(tmp, 'demo');
  fs.mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'README.md'), '# demo\n');
  git(project, 'add', '-A');
  git(project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  // A branch whose pack takes a while to stream, for the clone that goes away.
  git(project, 'checkout', '-q', '-b', 'big');
  fs.writeFileSync(path.join(project, 'big.bin'), crypto.randomBytes(BLOB));
  git(project, 'add', '-A');
  git(project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'big');
  git(project, 'checkout', '-q', 'main');
  const row = { id: 1, name: 'worker-a', enabled: 1 };
  const endpoint = createClusterGit({
    node: (h) => (h.authorization === `Bearer ${TOKEN}` ? row : null), repo: (pid) => (pid === 1 ? project : null),
    pushable: (id, pid) => (id === 1 && pid === 1 ? [7] : []), log: (m) => logs.push(m),
  });
  server = http.createServer((req, res) => (req.url.startsWith(`${GIT_PATH}/`) ? endpoint.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('a multi-megabyte push streams into git: only its command list is buffered', async () => {
  const url = base + gitPath(1), wt = path.join(tmp, 'push');
  await workerGit(tmp, url, 'clone', '-q', '--single-branch', url, wt);
  fs.writeFileSync(path.join(wt, 'big.bin'), crypto.randomBytes(BLOB));
  git(wt, 'add', '-A');
  git(wt, '-c', 'user.name=w', '-c', 'user.email=w@w', 'commit', '-q', '-m', 'big');
  logs = [];
  await workerGit(wt, url, 'push', '-q', 'origin', 'HEAD:refs/heads/agent-orch/task-7');
  assert.equal(git(project, 'rev-parse', 'agent-orch/task-7'), git(wt, 'rev-parse', 'HEAD'), 'the push landed');
  const line = logs.find((l) => /push to refs\/heads\/agent-orch\/task-7 .*bytes buffered/.test(l));
  assert.ok(line, logs.join('\n'));
  const buffered = Number(/\((\d+) bytes buffered\)/.exec(line)[1]);
  assert.ok(buffered > 0 && buffered <= MAX_PUSH_PREFIX, `buffered ${buffered} bytes of an ${BLOB}-byte push`);
});

test('a push to main is refused with 403 before its body is read', async () => {
  const chunk = crypto.randomBytes(64 << 10), total = 200;
  const r = await post('git-receive-pack', async (write) => {
    write(Buffer.from(pkt(`${Z} ${A} refs/heads/main\0report-status\n`) + '0000'));
    for (let i = 0; i < total; i++) { await sleep(10); if (!write(chunk)) return; }
  });
  assert.equal(r.status, 403);
  assert.match(r.text, /refs\/heads\/main/);
  assert.ok(r.sentBefore < total * chunk.length / 2, `the 403 came after ${r.sentBefore} bytes`);
});

test('a push with no command list in its first MAX_PUSH_PREFIX bytes gets 400', async () => {
  const line = Buffer.from(pkt(`${Z} ${A} refs/heads/agent-orch/task-7\n`));
  const r = await post('git-receive-pack', async (write) => {
    for (let n = 0; n < MAX_PUSH_PREFIX * 1.5; n += line.length * 1000) {
      if (!write(Buffer.concat(Array(1000).fill(line)))) return;
      await sleep(1);
    }
  });
  assert.equal(r.status, 400);
  assert.match(r.text, /unreadable push/);
});

// The pids of the processes under this one (http-backend and whatever it runs).
function descendants() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' }).trim().split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map(([, pid, ppid, comm]) => ({ pid: +pid, ppid: +ppid, comm }));
  const mine = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (mine.has(r.ppid) && !mine.has(r.pid)) { mine.add(r.pid); grew = true; }
  }
  return rows.filter((r) => r.pid !== process.pid && mine.has(r.pid) && !/(^|\/)ps$/.test(r.comm)).map((r) => r.pid);
}

test('a client that goes away mid-clone leaves no git running', async (t) => {
  // git's pack step sends the pack and then hangs on, so only killing it ends it (the hook is read from global config:
  // the head's git gets the head's HOME).
  const home = path.join(tmp, 'hook-home'), hook = path.join(home, 'slow-pack');
  fs.mkdirSync(home);
  fs.writeFileSync(hook, '#!/bin/sh\n"$@"\nsleep 60\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.gitconfig'), `[uploadpack]\n\tpackObjectsHook = ${hook}\n`);
  const HOME = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = HOME; });
  const sha = git(project, 'rev-parse', 'big');
  const body = pkt(`want ${sha} ofs-delta\n`) + '0000' + pkt('done\n');
  const pids = await new Promise((resolve, reject) => {
    const req = http.request(`${base}${gitPath(1)}/git-upload-pack`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-git-upload-pack-request' },
    }, (res) => {
      assert.equal(res.statusCode, 200);
      res.once('data', () => {
        const running = descendants();
        res.pause();
        req.destroy();
        resolve(running);
      });
    });
    req.on('error', () => {});
    req.on('close', () => reject(new Error('closed before any response data')));
    req.end(body);
  });
  assert.ok(pids.length, 'git was running while the clone streamed');
  const deadline = Date.now() + 5000;
  while (pids.some(alive) && Date.now() < deadline) await sleep(100);
  const left = pids.filter(alive);
  for (const pid of left) try { process.kill(pid, 'SIGKILL'); } catch {}
  assert.deepEqual(left, [], 'every git of that clone exited');
  assert.ok(logs.some((l) => /git-upload-pack .* the client went away/.test(l)), logs.join('\n'));
});
