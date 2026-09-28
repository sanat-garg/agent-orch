// extensions.mjs: skills and subagents written where the CLIs discover them, MCP servers and personas in agent-orch's
// data, and the MCP servers handed to every run through files (runAgentCli: Claude's --mcp-config, codex's -p profile).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExtensions, parseFrontmatter, frontmatter, splitCommand, parseGitHubUrl, SECRET } from '../extensions.mjs';
import { runAgentCli, setMcpSource } from '../agents.mjs';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-test-')); dirs.push(d); return d; };
after(() => { setMcpSource(null); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const setup = (opts = {}) => { const home = tmp(); return { home, x: createExtensions({ dataDir: path.join(home, 'data'), home, ...opts }) }; };
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('frontmatter: quoted, folded and literal values; written values read back', () => {
  const { meta, body } = parseFrontmatter('---\nname: a\ndescription: >\n  one\n  two\nq: "x: y"\ns: \'it\'\'s\'\nlit: |\n  l1\n  l2\n---\n\nBody\n');
  assert.deepEqual(meta, { name: 'a', description: 'one two', q: 'x: y', s: "it's", lit: 'l1\nl2' });
  assert.equal(body, 'Body\n');
  const out = frontmatter({ name: 'n', description: 'Use when: a # b', empty: '' }, 'Hi');
  assert.equal(out, '---\nname: n\ndescription: "Use when: a # b"\n---\n\nHi\n');
  assert.deepEqual(parseFrontmatter(out).meta, { name: 'n', description: 'Use when: a # b' });
  assert.deepEqual(parseFrontmatter('no fence').meta, {});
});

test('splitCommand and parseGitHubUrl', () => {
  assert.deepEqual(splitCommand(`npx -y "@a/b c" 'd e' f\\ g ""`), ['npx', '-y', '@a/b c', 'd e', 'f g', '']);
  assert.throws(() => splitCommand('a "b'), /Unclosed quote/);
  assert.deepEqual(parseGitHubUrl('https://github.com/anthropics/skills/tree/main/skills/pdf'), { repo: 'https://github.com/anthropics/skills.git', ref: 'main', dir: 'skills/pdf' });
  assert.deepEqual(parseGitHubUrl('https://github.com/o/r/blob/v1/SKILL.md'), { repo: 'https://github.com/o/r.git', ref: 'v1', dir: '' });
  assert.deepEqual(parseGitHubUrl('https://github.com/o/r'), { repo: 'https://github.com/o/r.git', ref: null, dir: '' });
  for (const bad of ['http://github.com/o/r', 'https://gitlab.com/o/r', 'https://github.com/o', 'https://github.com/o/r/tree/main/a%2F..%2F..%2Fx', 'https://github.com/o/r/blob/main/README.md', 'nope']) {
    assert.throws(() => parseGitHubUrl(bad), Error, bad);
  }
});

test('skills: saved for each chosen agent, renamed and moved between agents with their files, hand-installed ones listed', () => {
  const { home, x } = setup();
  const claude = path.join(home, '.claude/skills'), codex = path.join(home, '.codex/skills');
  fs.mkdirSync(path.join(claude, 'by-hand'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'by-hand/SKILL.md'), '---\nname: by-hand\ndescription: Made by hand\n---\nx\n');
  fs.mkdirSync(path.join(codex, '.system/bundled'), { recursive: true });
  fs.writeFileSync(path.join(codex, '.system/bundled/SKILL.md'), '---\nname: bundled\n---\n');

  const s = x.saveSkill({ name: 'notes', description: 'Use when: writing notes', body: '# Notes', agents: ['claude'] });
  assert.deepEqual([s.folder, s.agents, s.files], ['notes', ['claude'], 1]);
  assert.equal(parseFrontmatter(read(claude, 'notes/SKILL.md')).meta.description, 'Use when: writing notes');
  fs.writeFileSync(path.join(claude, 'notes/ref.md'), 'reference');

  // Rename and add Codex in one edit: the whole folder (with ref.md) is copied, SKILL.md rewritten in both.
  const r = x.saveSkill({ prev: 'notes', name: 'release-notes', description: 'Release notes', body: 'v2', agents: ['claude', 'codex'] });
  assert.deepEqual([r.folder, r.agents, r.files], ['release-notes', ['claude', 'codex'], 2]);
  assert.ok(!fs.existsSync(path.join(claude, 'notes')));
  assert.equal(read(codex, 'release-notes/ref.md'), 'reference');
  assert.match(read(codex, 'release-notes/SKILL.md'), /^---\nname: release-notes\ndescription: Release notes\n---\n\nv2\n$/);

  // Dropping Claude removes only its copy.
  x.saveSkill({ prev: 'release-notes', name: 'release-notes', description: 'Release notes', body: 'v3', agents: ['codex'] });
  assert.ok(!fs.existsSync(path.join(claude, 'release-notes')));
  assert.equal(read(codex, 'release-notes/ref.md'), 'reference');

  assert.deepEqual(x.listSkills().map((k) => `${k.folder}:${k.agents}`), ['by-hand:claude', 'release-notes:codex']); // .system is Codex's own
  assert.throws(() => x.saveSkill({ name: 'by-hand', description: 'd', body: 'b' }), /already exists/);
  assert.throws(() => x.saveSkill({ name: 'Bad Name', description: 'd', body: 'b' }), /lowercase/);
  assert.throws(() => x.saveSkill({ name: 'ok', description: '', body: 'b' }), /description/);
  assert.throws(() => x.saveSkill({ name: 'ok', description: 'd', body: 'b', agents: [] }), /at least one agent/);
  x.removeSkill('by-hand');
  x.removeSkill('release-notes');
  assert.deepEqual(x.listSkills(), []);
  assert.ok(fs.existsSync(path.join(codex, '.system/bundled/SKILL.md')));
  assert.throws(() => x.removeSkill('../data'), /No such skill/);
});

test('skills: imported from a GitHub folder through a sparse clone (git stubbed), replaced only when asked', async () => {
  const bin = tmp(), log = path.join(bin, 'git.log');
  // The stub "clones" a repo with two skills under skills/ and records each call.
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const a = process.argv.slice(2);
if (a[0] === 'clone') {
  const repo = path.join(process.cwd(), a.at(-1));
  for (const n of ['pdf', 'docx']) {
    fs.mkdirSync(path.join(repo, 'skills', n, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'skills', n, 'SKILL.md'), '---\\nname: ' + n + '\\ndescription: The ' + n + ' skill\\n---\\nDo ' + n + '\\n');
    fs.writeFileSync(path.join(repo, 'skills', n, 'scripts', 'run.py'), 'print(1)');
  }
  fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref');
  try { fs.symlinkSync('/etc/hostname', path.join(repo, 'skills', 'pdf', 'leak')); } catch {}
}
`, { mode: 0o755 });
  // GitHub's API unreachable (a private repo, offline): the import falls back to git.
  const { home, x } = setup({ gitBin: path.join(bin, 'git'), fetch: async () => { throw new Error('offline'); } });
  const s = await x.importSkill({ url: 'https://github.com/anthropics/skills/tree/main/skills/pdf', agents: ['claude', 'codex'] });
  assert.deepEqual([s.name, s.agents, s.files, s.description], ['pdf', ['claude', 'codex'], 2, 'The pdf skill']);
  assert.equal(read(home, '.codex/skills/pdf/scripts/run.py'), 'print(1)');
  assert.ok(!fs.existsSync(path.join(home, '.claude/skills/pdf/leak')), 'symlinks are left behind');
  const calls = read(log).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls[0], ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', 'main', '--', 'https://github.com/anthropics/skills.git', 'repo']);
  assert.deepEqual(calls[1].slice(-3), ['set', '--', 'skills/pdf']);

  await assert.rejects(x.importSkill({ url: 'https://github.com/anthropics/skills/tree/main/skills/pdf' }), /A skill named pdf already exists/);
  const again = await x.importSkill({ url: 'https://github.com/anthropics/skills/tree/main/skills/pdf', agents: ['claude'], replace: true });
  assert.deepEqual(again.agents, ['claude']);
  await assert.rejects(x.importSkill({ url: 'https://github.com/anthropics/skills/tree/main/skills' }), /holds 2 skills \(docx, pdf\)/);
  await assert.rejects(x.importSkill({ url: 'https://github.com/anthropics/skills/tree/main/nope' }), /No folder nope/);
  assert.deepEqual(fs.readdirSync(path.join(home, 'data/extensions/tmp')), [], 'clones are cleaned up');
});

test('subagents: ~/.claude/agents/<name>.md with frontmatter; renamed and removed', () => {
  const { home, x } = setup();
  x.saveAgent({ name: 'reviewer', description: 'Reviews diffs', prompt: 'You review.', tools: 'Read, Grep,\nBash(git diff:*)', model: 'sonnet' });
  assert.equal(read(home, '.claude/agents/reviewer.md'), '---\nname: reviewer\ndescription: Reviews diffs\ntools: "Read, Grep, Bash(git diff:*)"\nmodel: sonnet\n---\n\nYou review.\n');
  assert.deepEqual(x.listAgents()[0], { file: 'reviewer', name: 'reviewer', description: 'Reviews diffs', tools: 'Read, Grep, Bash(git diff:*)', model: 'sonnet', prompt: 'You review.\n' });
  x.saveAgent({ prev: 'reviewer', name: 'code-reviewer', description: 'Reviews diffs', prompt: 'You review.' });
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude/agents')), ['code-reviewer.md']);
  assert.doesNotMatch(read(home, '.claude/agents/code-reviewer.md'), /tools:|model:/, 'blank tools/model are left out');
  assert.throws(() => x.saveAgent({ name: 'x', description: 'd', prompt: 'p', model: 'a b' }), /Model/);
  x.removeAgent('code-reviewer');
  assert.deepEqual(x.listAgents(), []);
});

test('MCP servers: secrets masked and kept; handed to runs through 0600 files, SSE and off servers left out for codex', () => {
  const { home, x } = setup();
  const s = x.saveMcp({ name: 'pw', type: 'stdio', commandLine: 'npx -y "@playwright/mcp@latest"', env: 'TOKEN=abc\nEMPTY=' });
  assert.deepEqual(s.env, { TOKEN: SECRET, EMPTY: '' });
  assert.equal(s.commandLine, 'npx -y @playwright/mcp@latest');
  assert.equal(fs.statSync(path.join(home, 'data/extensions/mcp.json')).mode & 0o777, 0o600);
  x.saveMcp({ prev: 'pw', name: 'pw', type: 'stdio', commandLine: 'npx -y @playwright/mcp@latest --headless', env: `TOKEN=${SECRET}\nNEW=1`, enabled: true });
  x.saveMcp({ name: 'docs', type: 'http', url: 'https://example.com/mcp', headers: 'Authorization: Bearer t' });
  x.saveMcp({ name: 'old', type: 'sse', url: 'https://example.com/sse', agents: ['claude', 'codex'] });
  const claude = {
    pw: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless'], env: { TOKEN: 'abc', NEW: '1' } },
    docs: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } },
    old: { type: 'sse', url: 'https://example.com/sse' },
  };
  assert.deepEqual(x.mcpFor('claude'), claude);
  const toml = '[mcp_servers.pw]\ncommand = "npx"\nargs = ["-y","@playwright/mcp@latest","--headless"]\nenv = {"TOKEN"="abc","NEW"="1"}\n\n' +
    '[mcp_servers.docs]\nurl = "https://example.com/mcp"\nhttp_headers = {"Authorization"="Bearer t"}\n';
  assert.ok(x.mcpFor('codex').endsWith(`\n\n${toml}`), x.mcpFor('codex'));

  // Runs get files, not arguments: Claude's --mcp-config JSON and codex's profile, both 0600.
  const file = x.mcpRun('claude');
  assert.equal(file, path.join(home, 'data/extensions/claude-mcp.json'));
  assert.deepEqual(JSON.parse(read(file)), { mcpServers: claude });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(x.mcpRun('codex'), 'agent-orch');
  assert.equal(read(home, '.codex/agent-orch.config.toml'), x.mcpFor('codex'));
  assert.equal(fs.statSync(path.join(home, '.codex/agent-orch.config.toml')).mode & 0o777, 0o600);

  x.setMcpEnabled('pw', false);
  assert.deepEqual(Object.keys(x.mcpFor('claude')), ['docs', 'old']);
  x.saveMcp({ prev: 'docs', name: 'docs', type: 'http', url: 'https://example.com/mcp', agents: ['claude'] });
  assert.equal(x.mcpFor('codex'), null);
  assert.equal(x.mcpRun('codex'), null);
  assert.ok(!fs.existsSync(path.join(home, '.codex/agent-orch.config.toml')), 'a profile with nothing in it is removed');
  assert.equal(x.list().mcp.find((m) => m.name === 'pw').enabled, false, 'an edit without `enabled` keeps it');
  assert.throws(() => x.saveMcp({ name: 'a.b', commandLine: 'x' }), /Name/);
  assert.throws(() => x.saveMcp({ name: 'pw', commandLine: 'x' }), /already exists/);
  assert.throws(() => x.saveMcp({ name: 'u', type: 'http', url: 'file:///etc/passwd' }), /URL/);
  assert.throws(() => x.saveMcp({ name: 'e', commandLine: 'x', env: 'BAD KEY=1' }), /Bad variable name/);
  for (const n of ['pw', 'docs', 'old']) x.removeMcp(n);
  assert.equal(x.mcpFor('claude'), null);
  assert.equal(x.mcpRun('claude'), null);
  assert.ok(!fs.existsSync(file));
});

test('MCP connectors: stdio and http ones with outbound tools run behind the gate proxy; an sse one is withheld', () => {
  const { home, x } = setup();
  const mail = x.saveMcp({ name: 'mail', type: 'http', url: 'https://example.com/mcp', headers: 'Authorization: Bearer t0k', outbound: 'send_mail' });
  assert.deepEqual(mail.outbound, ['send_mail']);
  assert.equal(mail.gated, true);
  assert.equal(mail.ungatedOutbound, false);
  assert.deepEqual(x.list().mcp.find((m) => m.name === 'mail').outbound, ['send_mail']);
  const pay = x.saveMcp({ name: 'pay', type: 'stdio', commandLine: 'node pay.js', outbound: 'charge, refund_*' });
  assert.equal(pay.gated, true);
  assert.equal(pay.ungatedOutbound, false);
  x.saveMcp({ name: 'docs', type: 'http', url: 'https://example.com/docs', headers: 'X-Key: k' });
  const feed = x.saveMcp({ name: 'feed', type: 'sse', url: 'https://example.com/sse', outbound: 'post' });
  assert.equal(feed.gated, false);
  assert.equal(feed.ungatedOutbound, true);

  const dir = path.join(home, 'gate'), withheld = [];
  fs.mkdirSync(dir);
  const onWithheld = (name, reason) => withheld.push([name, reason]);
  const gatedRun = x.mcpFor('claude', { gate: { dir, onWithheld } });
  assert.deepEqual(Object.keys(gatedRun), ['mail', 'pay', 'docs'], 'the sse connector is left out; a plain http server stays');
  assert.deepEqual(withheld, [['feed', 'connector with outbound tools over sse cannot be gated; add it as http or a stdio command']]);
  assert.equal(gatedRun.pay.command, process.execPath, 'the stdio connector runs behind the gate proxy');
  assert.match(gatedRun.pay.args.at(-1), /proxy-pay\.json$/);
  const payCfg = JSON.parse(read(dir, 'proxy-pay.json'));
  assert.deepEqual(payCfg.connector, { outbound: ['charge', 'refund_*'] });
  assert.deepEqual(payCfg.upstream, { command: 'node', args: ['pay.js'], env: {} });
  assert.deepEqual(gatedRun.mail, { type: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('../gate-proxy.mjs', import.meta.url)), '--config', path.join(dir, 'proxy-mail.json')] },
    'the http connector becomes a stdio entry for the gate proxy');
  const mailCfg = JSON.parse(read(dir, 'proxy-mail.json'));
  assert.deepEqual(mailCfg.upstream, { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t0k' } });
  assert.deepEqual(mailCfg.connector, { outbound: ['send_mail'] });
  assert.equal(mailCfg.kind, 'connector');
  assert.equal(fs.statSync(path.join(dir, 'proxy-mail.json')).mode & 0o777, 0o600);
  assert.deepEqual(gatedRun.docs, { type: 'http', url: 'https://example.com/docs', headers: { 'X-Key': 'k' } }, 'an http server without outbound tools is untouched');
  assert.match(x.mcpFor('codex', { gate: { dir } }), /\[mcp_servers\.mail\]\ncommand = .*\nargs = .*proxy-mail\.json.*\ntool_timeout_sec = \d+/);

  withheld.length = 0;
  x.mcpRun('claude', { gate: { dir }, onWithheld });
  assert.deepEqual(withheld.map(([n]) => n), ['feed'], 'mcpRun passes run.onWithheld through');

  const plain = x.mcpFor('claude');
  assert.deepEqual(Object.keys(plain), ['mail', 'pay', 'docs', 'feed'], 'a run without a gate is unchanged');
  assert.deepEqual(plain.mail, { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t0k' } });
});

test('personas: saved, prompt block for a run, unique names, removed', () => {
  const { x } = setup();
  const seen = [];
  x.onChange((kind) => seen.push(kind));
  const p = x.savePersona({ name: 'Staff engineer', description: 'Pragmatic', prompt: 'Be terse.' });
  assert.match(p.id, /^[0-9a-f]{10}$/);
  assert.equal(x.personaPrompt(p.id), '## Persona: Staff engineer\nThe owner chose this persona for this project. Work and reply as it describes, within the rules above:\nBe terse.');
  assert.equal(x.personaPrompt(null), null);
  assert.equal(x.personaPrompt('missing'), null);
  assert.throws(() => x.savePersona({ name: 'staff ENGINEER', prompt: 'x' }), /already exists/);
  const edited = x.savePersona({ id: p.id, name: 'Staff engineer', prompt: 'Be very terse.' });
  assert.equal(edited.createdAt, p.createdAt);
  x.removePersona(p.id);
  assert.deepEqual(x.list('personas'), { personas: [] });
  assert.deepEqual(seen, ['personas', 'personas', 'personas']);
});

test('runAgentCli hands the MCP files to Claude (--mcp-config) and codex (-p, also on resume); a run can override them', async () => {
  const seen = {};
  const q = (args) => { Object.assign(seen, args); return (async function* () { yield { type: 'result', subtype: 'success', result: 'ok', usage: {} }; })(); };
  setMcpSource((agent) => (agent === 'claude' ? '/data/extensions/claude-mcp.json' : 'agent-orch'));
  await runAgentCli({ agent: 'claude', prompt: 'hi', cwd: tmp(), query: q, env: {} });
  assert.deepEqual(seen.options.extraArgs, { 'mcp-config': '/data/extensions/claude-mcp.json' });
  assert.equal(seen.options.mcpServers, undefined, 'never on the command line');
  await runAgentCli({ agent: 'claude', prompt: 'hi', cwd: tmp(), query: q, env: {}, mcp: null });
  assert.equal(seen.options.extraArgs, undefined);

  const STUB = fileURLToPath(new URL('./fixtures/codex-stub.mjs', import.meta.url)), log = path.join(tmp(), 'argv.json');
  await runAgentCli({ agent: 'codex', bin: STUB, prompt: 'hi', cwd: tmp(), resume: 'thread-1', env: { PATH: process.env.PATH, CODEX_STUB: 'ok', CODEX_STUB_LOG: log } });
  assert.deepEqual(JSON.parse(read(log)).argv.slice(0, 4), ['-p', 'agent-orch', 'exec', 'resume']);
  setMcpSource(null);
  await runAgentCli({ agent: 'codex', bin: STUB, prompt: 'hi', cwd: tmp(), env: { PATH: process.env.PATH, CODEX_STUB: 'ok', CODEX_STUB_LOG: log } });
  assert.equal(JSON.parse(read(log)).argv[0], 'exec');
});
