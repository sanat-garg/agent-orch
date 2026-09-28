// Chrome-runner tasks actually start (#525): the browser profile lock is per (machine, identity), never global; a task
// bound for a Chrome runner (the extension drives the owner's Chrome, no profile) is never gated by it; a holder whose
// run is dead (nothing written for CFG.staleLockMs) is ignored; a runner's Auto slots are CHROME_RUNNER_SLOTS; a runner
// reads the owner's own Claude sign-in (chrome.mjs ownerClaudeLogin, the owner's config), and a signed-out runner is
// told to sign in (Machines view and Browser tab) instead of queueing tasks forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CHROME_RUNNER_SLOTS, OWNER_ENV_STRIP, browserRoute, chromeSetupStatus, ownerClaudeLogin, ownerSignInHint, runnerSignIn } from '../chrome.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-start-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const HINT = "Sign in to Claude on Sanat's MacBook Air as yourself: run `claude` in Terminal";
const runner = (signedIn) => ({ id: 'cr', name: "Chrome on Sanat's MacBook Air", os: 'darwin', local: false, status: 'online', connected: true, enabled: true,
  features: ['approvals', 'browser-task', 'chrome'], inventory: { chrome: { capable: true, extension: true, gui: true }, chromeRunner: true, agents: [{ id: 'claude', installed: true, signedIn }] } });

test("runner sign-in: the owner's config (no CLAUDE_CONFIG_DIR, never the head's token), the CLI's answer or ~/.claude.json", () => {
  assert.deepEqual(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH'].filter((k) => !OWNER_ENV_STRIP.test(k)), ['HOME', 'PATH']);
  const home = path.join(tmp, 'owner');
  fs.mkdirSync(home, { recursive: true });
  assert.deepEqual(ownerClaudeLogin({ home, cli: 'owner@example.com' }), { ok: true, email: 'owner@example.com', via: 'cli' });
  assert.deepEqual(ownerClaudeLogin({ home, cli: false }), { ok: false, email: null, via: 'none' }, 'no CLI answer, no config: signed out');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'owner@example.com', accountUuid: 'u' } }));
  assert.deepEqual(ownerClaudeLogin({ home, cli: false }), { ok: true, email: 'owner@example.com', via: 'config' }, "an interactive login's oauthAccount counts when the CLI probe fails");
  assert.deepEqual(ownerClaudeLogin({ home, cli: true }), { ok: true, email: 'owner@example.com', via: 'cli' }, 'the CLI said yes without an email: the config names the account');
  fs.writeFileSync(path.join(home, '.claude.json'), '{}');
  assert.equal(ownerClaudeLogin({ home, cli: false }).ok, false);
  // worker.mjs: a runner strips those variables at start and reads the owner's sign-in for its inventory and offers.
  const src = fs.readFileSync(path.join(ROOT, 'worker.mjs'), 'utf8');
  assert.match(src, /if \(CHROME_RUNNER\) for \(const k of Object\.keys\(process\.env\)\) if \(OWNER_ENV_STRIP\.test\(k\)\) delete process\.env\[k\]/);
  assert.match(src, /const owner = a\.id === 'claude' \? runnerLogin\(\) : null;\n\s+const installed = !!a\.available\(\), signedIn = owner \? owner\.ok/);
  assert.match(src, /const owner = msg\.agent === 'claude' \? runnerLogin\(\) : null;\n\s+const st = owner \? \(owner\.ok \? true : 'not logged in'\)/);
  assert.match(src, /policy\.maxTasks \?\? \(CHROME_RUNNER \? CHROME_RUNNER_SLOTS/);
  assert.equal(CHROME_RUNNER_SLOTS, 2);
});

test('a signed-out runner: the sign-in message on the Browser tab and in Machines; no chrome route until then', () => {
  assert.equal(ownerSignInHint("Sanat's MacBook Air"), HINT);
  assert.equal(runnerSignIn(runner(false)), HINT);
  assert.equal(runnerSignIn(runner(true)), null);
  assert.equal(runnerSignIn({ id: 'mac', name: 'Mac mini', inventory: { agents: [] } }), null, 'not a runner');
  assert.equal(chromeSetupStatus(runner(false)), HINT);
  assert.equal(chromeSetupStatus(runner(true)), 'ready');
  assert.equal(browserRoute([runner(false)]).mode, 'builtin');
  assert.equal(browserRoute([runner(true)]).mode, 'chrome');
  // The Machines view says the same (app.js runnerSignIn, a pure helper).
  const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const fn = new Function(`${/^function runnerSignIn\(.*?^}$/ms.exec(appJs)[0]}; return runnerSignIn;`)();
  assert.equal(fn(runner(false)), HINT);
  assert.equal(fn(runner(true)), null);
  assert.equal(fn({ ...runner(false), inventory: { chromeRunner: true } }), null, 'agents not reported yet: no verdict');
});

test('placement: the profile lock is per machine; chrome tasks are never gated; a stale holder is ignored; a runner takes 2', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'orch-')), repos = fs.mkdtempSync(path.join(tmp, 'repos-'));
  const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
    import { DatabaseSync } from 'node:sqlite';
    import { execFileSync } from 'node:child_process';
    import path from 'node:path';
    const [dataDir, repos] = process.argv.slice(1), GB = 2 ** 30;
    const agents = (signedIn) => [{ id: 'claude', installed: true, signedIn }];
    const base = { os: 'darwin', local: false, status: 'online', connected: true, enabled: true, draining: false, resources: { memAvailable: 16 * GB, at: Date.now() } };
    const mac = { ...base, id: 'mac', name: 'Mac mini', maxSlots: 4, features: ['approvals', 'browser-task'], inventory: { cores: 8, agents: agents(true), browser: { capable: true } } };
    const cr = { ...base, id: 'cr', name: "Chrome on Sanat's MacBook Air", maxSlots: null, features: ['approvals', 'browser-task', 'chrome'], inventory: { cores: 8, agents: agents(true), chrome: { capable: true, extension: true, gui: true }, chromeRunner: true } };
    const nodes = [{ id: 'controller', local: true, status: 'online', connected: true, enabled: true }, mac, cr];
    const o = createOrchestrator({ query: () => (async function* () {})(), dataDir, disabled: true, claudeEnv: {}, getLimits: () => [],
      onSubscription: () => true, broadcast() {}, emitChat() {}, convoExists: () => false });
    let ver = 1;
    o.attachCluster({ listNodes: () => nodes, node: (id) => nodes.find((n) => n.id === id) || null, onMessage() {}, version: () => ver });
    const db = new DatabaseSync(path.join(dataDir, 'orchestrator', 'agent-orch.db'));
    let pos = 0;
    const project = (name) => {
      const repo = path.join(repos, name);
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/test-owner/' + name + '.git'], { cwd: repo });
      return Number(db.prepare("INSERT INTO projects(path,name,priority,status,perpetual,position,created_at) VALUES(?,?,50,'active',0,?,0)").run(repo, name, ++pos).lastInsertRowid);
    };
    // A work task with the browser capability in its own GitHub project (an audit like #506), pinned or not.
    const task = (title, identity, runOn = null) => Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,capabilities,browser_identity,run_on,created_at) VALUES(?,'work',?,'p','[\\"browser\\"]',?,?,?)")
      .run(project(title), title, identity, runOn, Date.now() / 1000).lastInsertRowid);
    const browserPid = project('browser');
    // A Browser-tab prompt (execution 'browser') on a machine's profile.
    const btask = (title, identity, runOn) => Number(db.prepare("INSERT INTO tasks(project_id,kind,title,prompt,capabilities,browser_identity,run_on,execution,created_at) VALUES(?,'work',?,'p','[\\"browser\\"]',?,?,'browser',?)")
      .run(browserPid, title, identity, runOn, Date.now() / 1000).lastInsertRowid);
    const claim = () => { const c = o.claimNext(null); return c && [c.task.title, c.node]; };
    const out = {};
    task('A', 'default', 'mac');
    out.a = claim();
    task('B', 'default');
    out.b = claim(); // the chrome route: A's profile on the Mac is not in its way
    task('C', 'default', 'mac');
    out.c = claim(); // the same machine and profile as A: waits
    btask('E', 'default', 'cr');
    out.e = claim(); // B runs on the runner with the same identity: no profile there
    btask('F', 'default', 'cr');
    out.f = claim(); // the runner's Auto slots: 2
    db.prepare("UPDATE tasks SET started_at=? WHERE title='A'").run(Date.now() / 1000 - 700); // A's run went silent 11+ min ago
    out.cStale = claim();
    cr.inventory.agents = agents(false); ver++;
    out.runner = o.browserRunner();
    task('G', 'xero');
    out.g = claim(); // no chrome route while the runner is signed out: the Mac's built-in browser
    btask('H', 'other', 'cr');
    out.h = claim();
    console.log(JSON.stringify(out));
    process.exit(0);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, repos], { cwd: ROOT, encoding: 'utf8', timeout: 45000 });
  const r = JSON.parse(stdout.trim().split('\n').pop());
  assert.deepEqual(r.a, ['A', 'mac']);
  assert.deepEqual(r.b, ['B', 'cr'], "another machine's running browser task doesn't block a chrome task");
  assert.equal(r.c, null, 'the same profile on the same machine still waits');
  assert.deepEqual(r.e, ['E', 'cr'], 'chrome tasks are never profile-gated, even on one runner');
  assert.equal(r.f, null, 'a runner takes CHROME_RUNNER_SLOTS tasks at once');
  assert.deepEqual(r.cStale, ['C', 'mac'], "a holder whose run is dead doesn't hold the lock");
  assert.equal(r.runner.mode, 'builtin');
  assert.equal(r.runner.macs.find((m) => m.id === 'cr')?.status, HINT);
  assert.deepEqual(r.g, ['G', 'mac'], 'a signed-out runner gets nothing; the built-in browser runs it');
  assert.equal(r.h, null, 'a prompt pinned to the signed-out runner waits (the UI says to sign in)');
});
