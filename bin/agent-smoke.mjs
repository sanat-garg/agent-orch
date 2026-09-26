#!/usr/bin/env node
// End-to-end smoke suite for a coding-agent adapter: runs a fixed list of file/tool prompts through the REAL CLI via
// runAgentCli, exactly as the orchestrator launches it (same adapter flags, cwd = project, autonomous, the systemd
// service's minimal env), each in a fresh scratch git project, and checks every outcome on disk or against a random
// token the agent can only know by using its tools. Prints a pass/fail table plus the failing tool events.
//   node bin/agent-smoke.mjs --agent antigravity --model gemini-3.1-pro-high [--only read-line3,grep] [--timeout 300]
//        [--env service|inherit] [--keep] [--verbose]
// Exit 0 only when every check passes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { AGENTS, runAgentCli } from '../agents.mjs';

const { values: opt } = parseArgs({ options: {
  agent: { type: 'string', default: 'antigravity' }, model: { type: 'string' }, only: { type: 'string' },
  timeout: { type: 'string', default: '300' }, env: { type: 'string', default: 'service' }, keep: { type: 'boolean' }, verbose: { type: 'boolean' },
} });
if (!AGENTS[opt.agent]) { console.error(`unknown agent: ${opt.agent}`); process.exit(2); }

// The live service (systemd unit agent-orch) runs with only these vars, so agents inherit no shell setup.
const HOME = os.homedir();
const SERVICE_ENV = {
  HOME, USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL: os.userInfo().shell || '/bin/bash', LANG: 'C.UTF-8',
  PATH: `${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
};
const env = opt.env === 'inherit' ? process.env : SERVICE_ENV;
// Stands in for the orchestrator's worker preamble (agy and codex prepend it to the prompt, claude appends it).
const APPEND = 'You are an autonomous engineer. No human is watching this session: never ask questions or wait for confirmation. ' +
  'Work only inside the current working directory.';

const tok = (p) => `${p}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...SERVICE_ENV, ...(opt.env === 'inherit' ? process.env : {}) } });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const has = (text, s) => String(text || '').includes(s);

// A fresh scratch project: a few files, a tiny `node --test` suite with one failing test (add() subtracts), a git repo.
function scratch() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `agent-smoke-${opt.agent}-`)));
  const t = { dir, line3: tok('LINE3'), rel: tok('REL'), abs: tok('ABS'), big: tok('BIG'), needle: tok('NEEDLE'),
    mjs: [tok('alpha'), tok('beta'), tok('gamma')].map((s) => s.toLowerCase()) };
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  w('package.json', JSON.stringify({ name: 'smoke', version: '1.0.0', type: 'module', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n');
  w('README.md', '# smoke\n\nA scratch project for the agent smoke suite.\n');
  w('notes/poem.txt', `Roses are red,\nviolets are blue,\n${t.line3} is line three,\nand line four is new.\n`);
  w('notes/relative.txt', `first line\nsecret: ${t.rel}\n`);
  w('data/absolute.txt', `header\nsecret: ${t.abs}\n`);
  w('data/big.txt', Array.from({ length: 3000 }, (_, i) => (i + 1 === 2750 ? `line 2750: ${t.big}` : `line ${i + 1}: filler ${crypto.randomBytes(6).toString('hex')}`)).join('\n') + '\n');
  w('src/math.mjs', 'export function add(a, b) {\n  return a - b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n');
  w(`src/${t.mjs[0]}.mjs`, 'export const a = 1;\n');
  w(`src/lib/${t.mjs[1]}.mjs`, `// ${t.needle}\nexport const b = 2;\n`);
  w(`src/lib/deep/${t.mjs[2]}.mjs`, 'export const c = 3;\n');
  w('src/decoy.js', `// ${t.needle.slice(0, -2)}\nmodule.exports = 4;\n`);
  w('docs/usage.txt', `Search for ${t.needle} here too.\n`);
  // Records every run of the suite on disk, so "ran the tests" is checkable without trusting the agent's words.
  w('test/math.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n" +
    "import { add, mul } from '../src/math.mjs';\n\nfs.appendFileSync(new URL('../.test-runs', import.meta.url), `${Date.now()}\\n`);\n\n" +
    "test('mul multiplies', () => assert.equal(mul(3, 4), 12));\ntest('mul by zero', () => assert.equal(mul(3, 0), 0));\n" +
    "test('add adds', () => assert.equal(add(2, 3), 5));\n");
  w('.gitignore', '.test-runs\n');
  for (const a of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=smoke', '-c', 'user.email=smoke@localhost', 'commit', '-qm', 'scratch']]) sh('git', a, dir);
  t.testHash = sha(path.join(dir, 'test/math.test.mjs'));
  return t;
}
const runs = (t) => { try { return fs.readFileSync(path.join(t.dir, '.test-runs'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
const nodeTest = (t) => sh('node', ['--test'], t.dir);
const ranShell = (r, re) => r.tools.some((e) => /^(Bash|run_command|shell|exec_command|command_execution)$/i.test(e.name) && re.test(JSON.stringify(e.input)));

// Each check: prompt(t) (or turns), then verify(t, r) -> null when it passed, else the reason.
const CHECKS = [
  { id: 'read-line3', prompt: () => 'Read the file notes/poem.txt and quote its line 3 exactly, on a line by itself. Do not modify any file.',
    verify: (t, r) => (has(r.text, t.line3) ? null : 'answer lacks line 3 token') },
  { id: 'glob', prompt: () => 'Using a file-search/glob tool, list every file matching src/**/*.mjs (recursively). Reply with the relative paths, one per line. Do not modify any file.',
    verify: (t, r) => {
      const miss = [...t.mjs, 'math'].filter((n) => !has(r.text, `${n}.mjs`));
      return miss.length ? `missing ${miss.join(', ')}` : has(r.text, 'decoy.js') ? 'listed decoy.js' : null;
    } },
  { id: 'grep', prompt: (t) => `Search the project for the exact string ${t.needle} and list every file that contains it (relative paths). Do not modify any file.`,
    verify: (t, r) => {
      const miss = [`${t.mjs[1]}.mjs`, 'usage.txt'].filter((n) => !has(r.text, n));
      return miss.length ? `missing ${miss.join(', ')}` : has(r.text, 'decoy.js') ? 'listed decoy.js (partial match)' : null;
    } },
  { id: 'edit-fix', prompt: () => 'The test suite (npm test) has a failing test. Fix the bug in src/math.mjs so every test passes. Do not change the tests.',
    verify: (t) => {
      if (sha(path.join(t.dir, 'test/math.test.mjs')) !== t.testHash) return 'test file was modified';
      const n = nodeTest(t);
      return n.status === 0 ? null : `tests still fail: ${(n.stdout.match(/^# fail \d+/m) || ['?'])[0]}`;
    } },
  { id: 'create-subdir', prompt: (t) => `Create a new file docs/guide/NOTE.md (the docs/guide directory does not exist yet) whose entire content is the single line: created ${t.line3}`,
    verify: (t) => {
      const f = path.join(t.dir, 'docs/guide/NOTE.md');
      if (!fs.existsSync(f)) return 'docs/guide/NOTE.md missing';
      return fs.readFileSync(f, 'utf8').trim() === `created ${t.line3}` ? null : `wrong content: ${JSON.stringify(fs.readFileSync(f, 'utf8').slice(0, 80))}`;
    } },
  { id: 'npm-test', prompt: () => 'Run `npm test` in this project and report the result. End your reply with a line exactly of the form `RESULT: pass=<number of passing tests> fail=<number of failing tests>`. Do not modify any file.',
    verify: (t, r) => {
      if (!runs(t)) return 'the test suite never ran (.test-runs missing)';
      if (!ranShell(r, /npm\s+(run\s+)?test|node\s+--test/)) return 'no shell tool call ran npm test';
      const m = String(r.text).match(/RESULT:\s*pass=(\d+)\s+fail=(\d+)/i);
      return !m ? 'no RESULT line' : m[1] === '2' && m[2] === '1' ? null : `wrong counts pass=${m[1]} fail=${m[2]} (want 2/1)`;
    } },
  { id: 'read-relative', prompt: () => 'Read the file at the relative path notes/relative.txt and reply with the value after "secret:". Do not modify any file.',
    verify: (t, r) => (has(r.text, t.rel) ? null : 'answer lacks the secret') },
  { id: 'read-absolute', prompt: (t) => `Read the file at the absolute path ${path.join(t.dir, 'data/absolute.txt')} and reply with the value after "secret:". Do not modify any file.`,
    verify: (t, r) => (has(r.text, t.abs) ? null : 'answer lacks the secret') },
  { id: 'large-file', prompt: () => 'The file data/big.txt has 3000 lines. Read it (with your file-viewing tool if you have one, otherwise the shell) and quote line 2750 exactly. Do not modify any file.',
    verify: (t, r) => (has(r.text, t.big) ? null : 'answer lacks line 2750 token') },
  { id: 'resume', turns: [(t) => `Remember this codeword for later: ${t.rel}. Reply only with OK.`, () => 'What was the codeword I gave you earlier? Reply with just the codeword.'],
    verify: (t, r) => (!r.resumedSame ? `resume changed the session (${r.sessions.join(' -> ')})` : has(r.text, t.rel) ? null : 'resumed turn forgot the codeword') },
];

const TIMEOUT = Number(opt.timeout) * 1000;
async function turn(t, prompt, resume) {
  const r = { tools: [], results: [], errors: [], texts: [] };
  const started = Date.now();
  const res = await runAgentCli({ agent: opt.agent, model: opt.model, prompt, cwd: t.dir, resume, systemAppend: APPEND, env,
    signal: AbortSignal.timeout(TIMEOUT), usageProbe: false,
    onEvent: (e) => {
      if (e.k === 'tool') r.tools.push(e);
      if (e.k === 'tool_result') { r.results.push(e); if (e.isError) r.errors.push({ tool: r.tools.find((x) => x.id != null && x.id === e.id) || r.tools.at(-1), text: e.text }); }
      if (e.k === 'text') r.texts.push(e.text);
      if (opt.verbose) console.error(`  [${e.k}]`, JSON.stringify(e).slice(0, 300));
    } });
  return { ...r, res, secs: Math.round((Date.now() - started) / 1000) };
}

const only = opt.only ? new Set(opt.only.split(',')) : null;
const rows = [];
console.log(`agent-smoke: agent=${opt.agent} model=${opt.model || '(default)'} env=${opt.env} timeout=${opt.timeout}s`);
for (const c of CHECKS) {
  if (only && !only.has(c.id)) continue;
  const t = scratch();
  let r, reason;
  try {
    if (c.turns) {
      const a = await turn(t, c.turns[0](t));
      const b = a.res.outcome === 'ok' ? await turn(t, c.turns[1](t), a.res.sessionId) : a;
      r = { ...b, tools: [...a.tools, ...(b === a ? [] : b.tools)], errors: [...a.errors, ...(b === a ? [] : b.errors)], secs: a.secs + (b === a ? 0 : b.secs),
        sessions: [a.res.sessionId, b.res.sessionId], resumedSame: b !== a && !!a.res.sessionId && a.res.sessionId === b.res.sessionId };
    } else r = await turn(t, c.prompt(t));
    r.text = [r.res.text, ...r.texts].join('\n');
    reason = r.res.outcome !== 'ok' ? `outcome ${r.res.outcome}${r.res.errorCode ? `/${r.res.errorCode}` : ''}: ${String(r.res.text || r.res.stderr || '').trim().slice(0, 200)}` : c.verify(t, r);
  } catch (e) { reason = `threw: ${e?.stack || e}`; r ||= { tools: [], errors: [], secs: 0, res: {} }; }
  const row = { id: c.id, pass: !reason, secs: r.secs, tools: [...new Set(r.tools.map((e) => e.name))].join(' '), reason: reason || '', errors: r.errors, dir: t.dir, stderr: r.res?.stderr || '' };
  rows.push(row);
  console.log(`${row.pass ? 'PASS' : 'FAIL'} ${c.id} (${row.secs}s)${reason ? ` — ${reason}` : ''}`);
  if (!opt.keep && row.pass) fs.rmSync(t.dir, { recursive: true, force: true });
  // A plan limit fails every later check the same way (and agy retries each for minutes): stop here.
  if (r.res?.outcome === 'rate_limited') {
    const left = CHECKS.filter((x) => (!only || only.has(x.id)) && !rows.some((y) => y.id === x.id));
    for (const x of left) rows.push({ id: x.id, pass: false, secs: 0, tools: '', reason: 'skipped: agent rate limited', errors: [], dir: '-', stderr: '' });
    if (left.length) console.log(`rate limited${r.res.resetsAt ? ` until ${new Date(r.res.resetsAt * 1000).toISOString()}` : ''}: skipping ${left.length} checks`);
    break;
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n| check | result | secs | tools used | detail |\n|---|---|---|---|---|`);
for (const r of rows) console.log(`| ${r.id} | ${r.pass ? 'pass' : '**FAIL**'} | ${r.secs} | ${r.tools || '-'} | ${r.reason.replace(/\|/g, '\\|').replace(/\n/g, ' ') || ''} |`);
const failedTools = rows.filter((r) => r.errors.length);
if (failedTools.length) {
  console.log('\nFailing tool events:');
  for (const r of failedTools) for (const e of r.errors) console.log(`  ${pad(r.id, 14)} ${e.tool?.name || '?'} ${JSON.stringify(e.tool?.input || {}).slice(0, 200)}\n    -> ${String(e.text).replace(/\s+/g, ' ').slice(0, 400)}`);
}
for (const r of rows.filter((x) => !x.pass && x.dir !== '-')) {
  console.log(`\n${r.id}: scratch project kept at ${r.dir}`);
  if (r.stderr.trim()) console.log(`  stderr tail: ${r.stderr.trim().split('\n').slice(-5).join('\n  ')}`);
}
const failed = rows.filter((r) => !r.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} passed`);
process.exit(failed || !rows.length ? 1 : 0);
