// The extension bundle (extensions.mjs syncInfo/syncBundle on the controller, applyBundle on a worker): the controller's
// skills, subagents and enabled MCP servers written into a worker's own homes, touching only what an earlier sync wrote.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtensions } from '../extensions.mjs';
import { extBundleError } from '../cluster-protocol.mjs';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-sync-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const machine = () => { const home = tmp(); return { home, x: createExtensions({ dataDir: path.join(home, 'data'), home }) }; };
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const mode = (...p) => fs.statSync(path.join(...p)).mode & 0o777;
const SECRET_VALUE = 'ghp_sync-test-secret';

test('the bundle: skills per agent (no .git or symlinks), subagents, enabled MCP servers; oversized skills stay out', () => {
  const { home, x } = machine();
  x.saveSkill({ name: 'notes', description: 'Use when: notes', body: '# Notes', agents: ['claude', 'codex'] });
  const notes = path.join(home, '.claude/skills/notes');
  fs.mkdirSync(path.join(notes, 'scripts'));
  fs.writeFileSync(path.join(notes, 'scripts/run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  fs.symlinkSync('/etc/passwd', path.join(notes, 'link'));
  fs.mkdirSync(path.join(notes, '.git'));
  fs.writeFileSync(path.join(notes, '.git/HEAD'), 'ref: x\n');
  const huge = path.join(home, '.claude/skills/huge');
  fs.mkdirSync(huge, { recursive: true });
  fs.writeFileSync(path.join(huge, 'SKILL.md'), '---\nname: huge\ndescription: big\n---\n');
  for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(huge, `f${i}`), '');
  x.saveAgent({ name: 'reviewer', description: 'Reviews diffs', prompt: 'Review it.' });
  x.saveMcp({ name: 'gh', commandLine: 'npx -y gh-mcp', env: `GITHUB_TOKEN=${SECRET_VALUE}` });
  x.saveMcp({ name: 'off', type: 'http', url: 'https://off.example', enabled: false });

  const info = x.syncInfo();
  assert.match(info.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(info.skills.map((s) => `${s.agent}/${s.name}`), ['claude/notes', 'codex/notes']);
  assert.deepEqual(info.skills[0].files.map((f) => [f.path, !!f.x]), [['SKILL.md', false], ['scripts/run.sh', true]]);
  assert.deepEqual(info.skipped, [{ kind: 'skill', name: 'claude/huge', reason: 'too big (1001 files, 1 MB)' }]);
  assert.deepEqual(info.agents.map((a) => a.name), ['reviewer']);
  assert.deepEqual(info.mcp.map((s) => s.name), ['gh'], 'disabled servers stay on the controller');
  assert.equal(x.syncInfo(), info, 'unchanged files: the cached bundle');

  const b = x.syncBundle();
  assert.equal(extBundleError(b), null);
  // The SKILL.md shared by the Claude and Codex copies travels once.
  assert.equal(Object.keys(b.blobs).length, 3);
  assert.equal(b.bytes, Object.values(b.blobs).reduce((n, s) => n + Buffer.from(s, 'base64').length, 0));

  fs.writeFileSync(path.join(notes, 'scripts/run.sh'), '#!/bin/sh\necho changed, and longer\n');
  assert.notEqual(x.syncInfo().hash, info.hash, 'an edited file changes the hash');
  x.setMcpEnabled('off', true);
  assert.deepEqual(x.syncInfo().mcp.map((s) => s.name), ['gh', 'off']);
});

test('a worker writes the bundle into its homes, keeps its own entries, and removes only what a sync wrote', () => {
  const c = machine(), w = machine();
  c.x.saveSkill({ name: 'notes', description: 'Use when: notes', body: '# Notes', agents: ['claude', 'codex'] });
  fs.mkdirSync(path.join(c.home, '.claude/skills/notes/scripts'));
  fs.writeFileSync(path.join(c.home, '.claude/skills/notes/scripts/run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  c.x.saveSkill({ name: 'shared-name', description: "The controller's", body: 'controller', agents: ['claude'] });
  c.x.saveAgent({ name: 'reviewer', description: 'Reviews diffs', prompt: 'Review it.' });
  c.x.saveMcp({ name: 'gh', commandLine: 'npx -y gh-mcp', env: `GITHUB_TOKEN=${SECRET_VALUE}` });
  c.x.saveMcp({ name: 'events', type: 'sse', url: 'https://events.example/sse', agents: ['claude'] });
  // Installed on the worker by hand: one under a name the controller also uses, one of its own.
  w.x.saveSkill({ name: 'shared-name', description: "The worker's own", body: 'worker', agents: ['claude'] });
  w.x.saveSkill({ name: 'local-only', description: 'Only here', body: 'local', agents: ['codex'] });

  const b = c.x.syncBundle(), r = w.x.applyBundle(b);
  assert.deepEqual(r, { hash: b.hash, skills: 3, agents: 1, mcp: 2, kept: ['claude skill shared-name'] });
  assert.equal(read(w.home, '.claude/skills/notes/SKILL.md'), read(c.home, '.claude/skills/notes/SKILL.md'));
  assert.equal(read(w.home, '.codex/skills/notes/SKILL.md'), read(c.home, '.codex/skills/notes/SKILL.md'));
  assert.equal(mode(w.home, '.claude/skills/notes/scripts/run.sh'), 0o755);
  assert.equal(mode(w.home, '.claude/skills/notes/SKILL.md'), 0o644);
  assert.equal(read(w.home, '.claude/agents/reviewer.md'), read(c.home, '.claude/agents/reviewer.md'));
  assert.match(read(w.home, '.claude/skills/shared-name/SKILL.md'), /worker/, "the worker's own skill is left alone");
  assert.match(read(w.home, '.codex/skills/local-only/SKILL.md'), /local/);
  assert.equal(w.x.synced().hash, b.hash);
  assert.deepEqual(fs.readdirSync(path.join(w.home, '.claude/skills')).sort(), ['notes', 'shared-name'], 'no temp folders left');

  // MCP servers: the worker's own 0600 files, handed to runs as a path (Claude) or a profile name (codex).
  assert.equal(mode(w.home, 'data/extensions/mcp.json'), 0o600);
  const claudeFile = w.x.mcpRun('claude');
  assert.equal(claudeFile, path.join(w.home, 'data/extensions/claude-mcp.json'));
  assert.equal(mode(claudeFile), 0o600);
  assert.deepEqual(Object.keys(JSON.parse(read(claudeFile)).mcpServers), ['gh', 'events']);
  assert.equal(w.x.mcpRun('codex'), 'agent-orch');
  const toml = read(w.home, '.codex/agent-orch.config.toml');
  assert.equal(mode(w.home, '.codex/agent-orch.config.toml'), 0o600);
  assert.match(toml, /\[mcp_servers\.gh\]/);
  assert.ok(toml.includes(SECRET_VALUE));
  assert.doesNotMatch(toml, /events/, 'SSE servers are Claude-only');

  // The same bundle again rewrites nothing.
  const before = fs.statSync(path.join(w.home, '.claude/skills/notes/SKILL.md')).ino;
  w.x.applyBundle(b);
  assert.equal(fs.statSync(path.join(w.home, '.claude/skills/notes/SKILL.md')).ino, before);

  // Removed or switched off on the controller: gone from the worker too; the worker's own entries stay.
  c.x.removeSkill('notes');
  c.x.removeSkill('shared-name');
  c.x.removeAgent('reviewer');
  c.x.setMcpEnabled('gh', false);
  const b2 = c.x.syncBundle();
  assert.deepEqual(w.x.applyBundle(b2).kept, []);
  assert.ok(!fs.existsSync(path.join(w.home, '.claude/skills/notes')));
  assert.ok(!fs.existsSync(path.join(w.home, '.codex/skills/notes')));
  assert.ok(!fs.existsSync(path.join(w.home, '.claude/agents/reviewer.md')));
  assert.match(read(w.home, '.claude/skills/shared-name/SKILL.md'), /worker/);
  assert.match(read(w.home, '.codex/skills/local-only/SKILL.md'), /local/);
  assert.equal(w.x.mcpRun('codex'), null);
  assert.ok(!fs.existsSync(path.join(w.home, '.codex/agent-orch.config.toml')), 'no codex servers: the profile is removed');
  assert.deepEqual(Object.keys(JSON.parse(read(w.x.mcpRun('claude'))).mcpServers), ['events']);
});

test('a bundle that fails its check writes nothing', () => {
  const c = machine(), w = machine();
  c.x.saveSkill({ name: 'notes', description: 'd', body: 'b', agents: ['claude'] });
  const b = c.x.syncBundle();
  b.skills[0].files[0].path = '../../escape.md';
  assert.throws(() => w.x.applyBundle(b), /bad file/);
  assert.ok(!fs.existsSync(path.join(w.home, '.claude')));
  assert.equal(w.x.synced().hash, null);
});
