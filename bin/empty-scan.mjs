#!/usr/bin/env node
// Scans orchestrator run logs and chat logs (read-only) for normalised events that came out empty:
// a tool with {} input, a tool result with no text, a run that ended ok with no assistant text.
// Usage: node bin/empty-scan.mjs [--data <dir>] [--since <runId>] [--runs <dir>] [--json]
// --runs scans only that directory's run-*.jsonl (e.g. bin/agent-smoke.mjs --log <dir>); an empty tool input there is
// "explained" when the CLI's native call (native-<check>.jsonl next to it) had no arguments either.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DATA = opt('--data', process.env.CW_DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data'));
const since = Number(opt('--since', 0));
const runsOnly = opt('--runs', null);

const empty = (v) => v == null || (typeof v === 'object' && !Object.values(v).some((x) => x != null && x !== ''));
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });

// groups: `${agent}\t${kind}\t${detail}` -> { n, examples: [file:line] }
const groups = new Map();
const add = (agent, kind, detail, where, why = '') => {
  const key = `${agent}\t${kind}\t${detail}\t${why}`;
  const g = groups.get(key) || { agent, kind, detail, why, n: 0, examples: [] };
  g.n++;
  if (g.examples.length < 3) g.examples.push(where);
  groups.set(key, g);
};
const totals = { runs: 0, chats: 0, tools: 0, results: 0 };

// The native call's arguments for a tool id, from the smoke run's native events: any non-empty argument container
// on a native line that mentions the id.
const ARG_KEYS = ['input', 'arguments', 'parameters', 'rawInput', 'command', 'query', 'action', 'locations'];
function nativeHasArgs(nativeFile, id) {
  if (!fs.existsSync(nativeFile)) return null;
  const hit = (o) => o && typeof o === 'object' && (ARG_KEYS.some((k) => o[k] != null && o[k] !== '' && JSON.stringify(o[k]) !== '{}' && JSON.stringify(o[k]) !== '[]')
    || Object.values(o).some((v) => typeof v === 'object' && hit(v)));
  return readJsonl(nativeFile).some((m) => JSON.stringify(m).includes(JSON.stringify(String(id))) && hit(m));
}

const runsDir = runsOnly || path.join(DATA, 'orchestrator', 'runs');
for (const f of fs.existsSync(runsDir) ? fs.readdirSync(runsDir).sort() : []) {
  const id = Number(/(\d+)/.exec(f)?.[1]);
  if (!f.startsWith('run-') || !f.endsWith('.jsonl') || id < since) continue;
  const nativeFile = path.join(runsDir, f.replace(/^run-/, 'native-'));
  totals.runs++;
  let agent = 'claude', texts = 0, tools = 0, end = null;
  const names = new Map();
  readJsonl(path.join(runsDir, f)).forEach((e, i) => {
    const where = `${f}:${i + 1}`;
    if (e.k === 'start') { agent = e.agent || 'claude'; texts = 0; tools = 0; end = null; }
    else if (e.k === 'text') { if (String(e.text || '').trim()) texts++; }
    else if (e.k === 'tool') {
      totals.tools++; tools++; names.set(e.id, e.name);
      if (!e.name) add(agent, 'tool without name', '', where);
      else if (empty(e.input)) {
        const had = runsOnly ? nativeHasArgs(nativeFile, e.id) : null;
        add(agent, 'empty tool input', e.name, where, had === false ? 'explained: native call had no arguments' : '');
      }
    } else if (e.k === 'result') {
      totals.results++;
      if (!String(e.text || '').trim()) add(agent, 'empty tool result', names.get(e.id) || '?', where);
    } else if (e.k === 'end') {
      end = e;
      if (e.outcome === 'ok' && !texts && !String(e.text || '').trim()) add(agent, 'ok run without final text', tools ? 'tools used' : 'no tools', where);
    }
  });
}

const logsDir = path.join(DATA, 'logs');
let convos = [];
try { convos = JSON.parse(fs.readFileSync(path.join(DATA, 'convos.json'), 'utf8')); } catch {}
for (const f of !runsOnly && fs.existsSync(logsDir) ? fs.readdirSync(logsDir).sort() : []) {
  if (!f.endsWith('.jsonl')) continue;
  totals.chats++;
  const convoAgent = convos.find((c) => `${c.id}.jsonl` === f)?.agent || 'claude';
  // A chat can move between agents (delegation); a tool id's shape tells which one answered.
  const agentOf = (id) => (/^toolu_/.test(id) ? 'claude' : /^(item_|exec-)/.test(id) ? 'codex' : /^\d+$/.test(id) ? 'antigravity'
    : /^(call_|custom_call_|toolu_vrtx)/.test(id) ? 'copilot' : convoAgent);
  let agent = convoAgent;
  const names = new Map();
  let texts = 0;
  readJsonl(path.join(logsDir, f)).forEach((e, i) => {
    const where = `logs/${f}:${i + 1}`;
    if (e.t === 'user') texts = 0;
    else if (e.t === 'text') { if (String(e.text || '').trim()) texts++; }
    else if (e.t === 'tool_use') {
      agent = agentOf(String(e.id));
      totals.tools++; names.set(e.id, e.name);
      if (!e.name) add(agent, 'tool without name', '', where);
      else if (empty(e.input)) add(agent, 'empty tool input', e.name, where);
    } else if (e.t === 'tool_result') {
      totals.results++;
      if (!String(e.text || '').trim()) add(agent, 'empty tool result', names.get(e.id) || '?', where);
    } else if (e.t === 'result' && e.ok && !String(e.text || '').trim() && !texts) add(agent, 'ok run without final text', 'chat', where);
  });
}

const rows = [...groups.values()].sort((a, b) => a.agent.localeCompare(b.agent) || a.kind.localeCompare(b.kind) || b.n - a.n);
if (argv.includes('--json')) console.log(JSON.stringify({ totals, groups: rows }, null, 2));
else {
  console.log(`scanned ${totals.runs} run logs, ${totals.chats} chat logs: ${totals.tools} tool calls, ${totals.results} tool results`);
  const unexplained = rows.filter((g) => !g.why).reduce((n, g) => n + g.n, 0);
  console.log(`${rows.reduce((n, g) => n + g.n, 0)} empty events, ${unexplained} unexplained`);
  if (rows.length) console.log('| agent | kind | tool / detail | count | explanation | examples |\n|---|---|---|---|---|---|');
  for (const g of rows) console.log(`| ${g.agent} | ${g.kind} | ${g.detail || '—'} | ${g.n} | ${g.why || '**unexplained**'} | ${g.examples.join(', ')} |`);
}
