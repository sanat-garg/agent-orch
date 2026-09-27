// Pluggable coding-agent layer. Each adapter runs one headless agent turn and reports NORMALISED events:
//   {k:'text',text}  {k:'tool',name,input}  {k:'tool_result',text,isError}  {k:'result',usage}  {k:'limit',resetsAt}
//   {k:'image',tool,mediaType,data} (raw base64 from a tool result; callers store it via media.mjs and log {k:'image',id,name})
//   {k:'windows',windows:[{window,pct,resetsAt}]} (plan-window readings, pct used; codex also leaves the latest in res.windows)
// (adapters may add fields such as a tool id). Adapters: claude (Agent SDK) and codex (`codex exec --json`).
// Every adapter strips its `envFilter` vars from the env so
// billing stays on the owner's subscription login, never an API key. See .agent-orch/AGENTS.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { toolResultImages } from './media.mjs';
import { toEpochSec } from './usage.mjs';
import { runHelper, runHelperSync, helperOut, claudeHelperSpawn, killGroup, singleFlight } from './helpers.mjs';

const HOME = os.homedir();

function onPath(bin, env = process.env) {
  if (path.isAbsolute(bin)) return fs.existsSync(bin);
  try { execFileSync('bash', ['-c', `command -v ${bin}`], { env: { PATH: env.PATH || '/usr/bin:/bin' }, stdio: 'ignore' }); return true; } catch { return false; }
}
// Login checks are cached for LOGIN_TTL per adapter (and PATH/bin), so a caller never blocks for more than one
// probe (a spawn capped at 5 s) a minute. `loggedIn()` is sync-readable: true | false.
const LOGIN_TTL = 60_000;
const loginCache = new Map();
function cachedLogin(a, check) {
  const key = `${a.bin}\0${process.env.PATH}`, hit = loginCache.get(a.id);
  if (hit && hit.key === key && Date.now() - hit.at < LOGIN_TTL) return hit.value;
  let value = false;
  try { value = !!check(); } catch {}
  loginCache.set(a.id, { key, at: Date.now(), value });
  return value;
}
export const clearLoginCache = () => loginCache.clear();
// true when the agent can run; otherwise why not ('not installed' | 'not logged in').
export function agentStatus(id) {
  const a = AGENTS[id];
  if (!a) return 'unknown agent';
  if (!a.available()) return 'not installed';
  return a.loggedIn() ? true : 'not logged in';
}
export const stripEnv = (env, filter) => Object.fromEntries(Object.entries(env).filter(([k]) => !filter.test(k)));

// Native field names (snake_cased) -> the ones the UI knows (codex: cmd).
const INPUT_ALIASES = {
  filepath: 'file_path', file: 'file_path', filename: 'file_path', cmd: 'command',
  directory: 'path', dir: 'path', paths: 'path', old_str: 'old_string', old_text: 'old_string',
  new_str: 'new_string', new_text: 'new_string', q: 'query', search_query: 'query', queries: 'query',
};
const WRAPPERS = ['parameters', 'arguments', 'rawInput', 'raw_input', 'input'];
const isEmptyValue = (v) => v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
// A CLI's tool arguments in whatever shape it sends them (object, JSON-encoded string, raw string such as an apply_patch
// body, nested under parameters/arguments/input) -> one flat object with snake_case keys and the aliases above applied.
export function nativeInput(raw) {
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\{[\s\S]*\}$/.test(s)) { try { v = JSON.parse(s); } catch {} }
    if (typeof v === 'string') return s ? { input: v } : {};
  }
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) return isEmptyValue(v) ? {} : { input: v };
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (isEmptyValue(val)) continue;
    // Wrapped arguments ({parameters:{…}}, {arguments:'{"a":1}'}) merge in; a plain `input` string stays as is.
    if (WRAPPERS.includes(k) && (typeof val === 'object' ? !Array.isArray(val) : /^\s*\{/.test(val))) {
      for (const [k2, v2] of Object.entries(nativeInput(val))) out[k2] ??= v2;
      continue;
    }
    const snake = k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const to = INPUT_ALIASES[snake] || snake;
    const value = Array.isArray(val) && val.every((x) => typeof x !== 'object') && (to === 'command' || to === 'path' || to === 'query') ? val.join(to === 'command' ? ' ' : ', ') : val;
    out[to] ??= value;
  }
  return out;
}

const clip4k = (v) => (typeof v === 'string' && v.length > 4000 ? v.slice(0, 4000) + '\n…' : v);
// Tool input trimmed to the fields the UI shows. A tool with none of them keeps all its fields, so an input is never
// {} when the native call had arguments.
export function toolInputSummary(name, input = {}) {
  const keep = {};
  for (const k of ['command', 'description', 'file_path', 'path', 'pattern', 'url', 'query', 'old_string', 'new_string', 'content', 'todos']) {
    if (input[k] == null) continue;
    keep[k] = clip4k(input[k]);
  }
  if (Object.keys(keep).length || !input || typeof input !== 'object') return keep;
  for (const [k, v] of Object.entries(input)) {
    if (isEmptyValue(v)) continue;
    keep[k] = typeof v === 'object' ? clip4k(JSON.stringify(v)) : clip4k(v);
  }
  return keep;
}
// A tool's native arguments (any shape) -> the normalised input.
export const toolInput = (name, raw) => toolInputSummary(name, nativeInput(raw));

// Tool output from wherever a CLI puts it: a string, content blocks ([{type:'text',text}], ACP's nested
// {type:'content',content:{text}}), {stdout,stderr}, {output}, {content}, {message} -> text.
export function outputText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) {
    return v.map((c) => (typeof c === 'string' ? c : c?.type === 'tool_reference' ? `Loaded tool ${c.tool_name}` : c?.type === 'image' ? '(image)'
      : c?.type === 'diff' && c.path ? `edited ${c.path}` : outputText(c?.text ?? c?.content ?? c?.output ?? c?.snippet ?? ''))).filter((s) => s.trim()).join('\n');
  }
  const streams = [v.stdout, v.stderr].filter((s) => typeof s === 'string' && s.trim()).join('\n');
  if (streams) return streams;
  for (const k of ['aggregated_output', 'aggregatedOutput', 'formatted_output', 'output', 'content', 'text', 'detailedContent', 'result', 'message']) {
    const t = outputText(v[k]);
    if (t.trim()) return t;
  }
  // An exit code alone isn't output (toolResult reports it).
  const rest = Object.fromEntries(Object.entries(v).filter(([k, x]) => !isEmptyValue(x) && k !== 'exit_code' && k !== 'exitCode'));
  return Object.keys(rest).length ? JSON.stringify(rest) : '';
}
// A normalised tool_result. An empty output says so, with the exit code when the command failed, instead of ''.
export function toolResult(id, value, isError = false, exitCode = null) {
  let text = outputText(value);
  if (!text.trim()) text = exitCode != null && exitCode !== 0 ? `(exit code ${exitCode}, no output)` : isError ? '(failed, no output)' : '(no output)';
  return { k: 'tool_result', id, text: clip(text), isError: !!isError, lines: text.split('\n').length };
}

// ---------------------------------------------------------------- claude (Claude Code via the Agent SDK)

const LIMIT_RE = /(hit your (?:\w+ )?limit|usage limit reached|rate limit|limit reached|out of (?:extra )?usage)/i;
const AUTH_RE = /(failed to authenticate|please run \/login|oauth (?:session|token) (?:expired|revoked)|invalid api key|not logged in|authentication_error)/i;

function classifyClaude(res, result) {
  const rejected = res.limits.filter((l) => l.status === 'rejected' && !l.isUsingOverage);
  let isError, subtype = '';
  if (result) {
    res.text = result.result || res.text || '';
    res.usage = result.usage || {};
    res.numTurns = result.num_turns || 0;
    subtype = result.subtype || '';
    isError = !!result.is_error || subtype !== 'success';
  } else {
    res.text = res.text || res.stderr.trim();
    isError = true;
  }
  const hay = (res.text.length < 600 ? res.text : '') + '\n' + res.stderr;
  const limitNotice = rejected.length && res.text.length < 300 && LIMIT_RE.test(res.text);
  if (!isError && !limitNotice && res.errorCode !== 'rate_limit') res.outcome = 'ok';
  else if (subtype === 'error_max_turns') res.outcome = 'max_turns';
  else if (res.errorCode === 'authentication_failed' || AUTH_RE.test(hay)) res.outcome = 'auth_error';
  else if (rejected.length || res.errorCode === 'rate_limit' || LIMIT_RE.test(hay) || result?.api_error_status === 429) {
    res.outcome = 'rate_limited';
    if (rejected.length) {
      const latest = rejected.reduce((a, b) => ((b.resetsAt || 0) > (a.resetsAt || 0) ? b : a));
      res.resetsAt = latest.resetsAt ? Number(latest.resetsAt) : null;
      res.limitType = latest.rateLimitType || null;
    }
  } else res.outcome = 'error';
  return res;
}

// SDK message -> normalised events (public messages, tool calls and their results only).
function* claudeEvents(m) {
  if (m.type === 'assistant' && !m.parent_tool_use_id) {
    for (const b of m.message?.content || []) {
      if (b.type === 'text' && b.text.trim()) yield { k: 'text', text: b.text };
      else if (b.type === 'tool_use') yield { k: 'tool', id: b.id, name: b.name, input: toolInput(b.name, b.input) };
    }
  } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
    for (const b of m.message.content) {
      if (b.type !== 'tool_result') continue;
      // Content blocks: text, image (Read of a picture; the image itself follows as an image event), tool_reference (ToolSearch).
      yield toolResult(b.tool_use_id, b.content, !!b.is_error);
      for (const img of toolResultImages(b.content)) yield { k: 'image', tool: b.tool_use_id, ...img };
    }
  } else if (m.type === 'rate_limit_event' && m.rate_limit_info?.status === 'rejected') {
    const r = m.rate_limit_info.resetsAt;
    yield { k: 'limit', resetsAt: r ? Number(r) : null };
  } else if (m.type === 'result') yield { k: 'result', usage: m.usage || {} };
}

// MCP servers every run gets (extensions.mjs mcpRun, set by the server): Claude → an --mcp-config file, codex → a config
// profile layered on ~/.codex/config.toml (codex -p <name>); null for none. Files, so no secret is on a command line.
// A run's own `mcp` option replaces it.
let mcpSource = () => null;
export const setMcpSource = (fn) => { mcpSource = fn || (() => null); };
const mcpOf = (agent, own) => { if (own !== undefined) return own; try { return mcpSource(agent); } catch (e) { console.error('[agents] mcp source failed', e); return null; } };

// Extra options: query (SDK override, for tests), bin, env, partial (stream deltas), onMessage (raw SDK messages).
// effort: a level from CLAUDE.efforts (the SDK's `effort` option), or null for the model's default.
async function runClaude({ model, prompt, cwd, resume, systemAppend, signal, onEvent, query = sdkQuery, bin, env = process.env, partial, onMessage, effort, mcp }) {
  mcp = mcpOf('claude', mcp);
  const ac = new AbortController();
  let aborted = false;
  const onAbort = () => { aborted = true; ac.abort(); };
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const res = { outcome: 'error', text: '', sessionId: resume || null, usage: {}, numTurns: 0, limits: [], resetsAt: null, limitType: null, stderr: '', errorCode: null };
  let result = null;
  try {
    const it = query({
      prompt,
      options: {
        cwd, resume: resume || undefined, model: model || undefined, ...(effort && { effort }),
        ...(mcp && { extraArgs: { 'mcp-config': mcp } }),
        pathToClaudeCodeExecutable: bin || CLAUDE.bin, env: stripEnv(env, CLAUDE.envFilter), abortController: ac,
        systemPrompt: systemAppend ? { type: 'preset', preset: 'claude_code', append: systemAppend } : { type: 'preset', preset: 'claude_code' },
        // The owner runs this on a disposable server and gave every agent full access (including
        // this app's own code): no permission prompts, nothing refused, whatever `autonomous` says.
        // Roles such as "the planner doesn't edit code" are kept by instructions, not by blocking tools.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        includePartialMessages: !!partial,
        stderr: (d) => { res.stderr = (res.stderr + d).slice(-4000); },
      },
    });
    for await (const m of it) {
      if (m.session_id) res.sessionId = m.session_id;
      if (m.type === 'rate_limit_event' && m.rate_limit_info) res.limits.push(m.rate_limit_info);
      if (m.type === 'assistant' && m.error) res.errorCode = m.error;
      if (m.type === 'result') result = m;
      if (m.type === 'assistant' && !m.parent_tool_use_id) {
        const t = (m.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        if (t.trim()) res.text = t;
      }
      if (onEvent) for (const e of claudeEvents(m)) { try { onEvent(e); } catch {} }
      try { onMessage?.(m); } catch {}
    }
  } catch (e) {
    if (!aborted) res.stderr += `\n${e?.message || e}`;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (aborted) res.outcome = 'aborted';
  else classifyClaude(res, result);
  return res;
}

export function parseClaudeAuth(out) {
  let j;
  try { j = JSON.parse(String(out || '')); } catch { return { ok: false, email: null }; }
  const ok = j?.loggedIn === true && (j.apiProvider || 'firstParty') === 'firstParty' && /^claude\.ai$/i.test(j.authMethod || '');
  return { ok, email: ok ? j.email || null : null };
}

const CLAUDE = {
  id: 'claude',
  label: 'Claude Code',
  // The Agent SDK's EffortLevel (query option `effort`, the CLI's --effort); 'max' only on some models.
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  bin: path.join(HOME, '.local/bin/claude'),
  available() { return onPath(this.bin); },
  // `claude auth status --json` → {loggedIn, authMethod, apiProvider, email, …}. Only a first-party claude.ai
  // (subscription) login counts; an API key or Console login would bill API credits.
  loggedIn() {
    return cachedLogin(this, () => {
      const r = runHelperSync(this.bin, ['auth', 'status', '--json'], { env: stripEnv(process.env, this.envFilter) });
      const st = parseClaudeAuth(r.stdout);
      this.email = st.ok ? st.email : null;
      return st.ok;
    });
  },
  account() { return this.loggedIn() ? this.email || null : null; },
  login: 'Connect from the sidebar',
  // The CLI's own /model list via the SDK's supportedModels(): a query with an input stream that never sends a
  // message, so nothing is billed and no session is written. query is injectable for tests.
  async listModels({ query = sdkQuery, bin, env = process.env, timeoutMs = 30_000 } = {}) {
    const ac = new AbortController();
    const idle = (async function* () { await new Promise((r) => ac.signal.addEventListener('abort', r, { once: true })); })();
    try {
      const q = query({ prompt: idle, options: { cwd: HOME, abortController: ac, pathToClaudeCodeExecutable: bin || this.bin, env: stripEnv(env, this.envFilter), spawnClaudeCodeProcess: claudeHelperSpawn } });
      return claudeModels(await withTimeout(q.supportedModels(), timeoutMs, 'claude'));
    } finally { ac.abort(); }
  },
  // Plan windows from the SDK's usage() on the same idle query (no message sent). The server polls this every 3 min.
  limitSource: 'Claude SDK usage()',
  async limits({ query = sdkQuery, bin, env = process.env, timeoutMs = 20_000 } = {}) {
    const ac = new AbortController();
    const idle = (async function* () { await new Promise((r) => ac.signal.addEventListener('abort', r, { once: true })); })();
    try {
      const q = query({ prompt: idle, options: { cwd: HOME, abortController: ac, pathToClaudeCodeExecutable: bin || this.bin, env: stripEnv(env, this.envFilter), spawnClaudeCodeProcess: claudeHelperSpawn } });
      const u = await withTimeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), timeoutMs, 'claude usage');
      if (!u?.rate_limits_available) throw new Error('Claude reported no plan limits');
      return { windows: claudeWindows(u.rate_limits) };
    } finally { ac.abort(); }
  },
  envFilter: /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/,
  events: claudeEvents,
  run: runClaude,
};

// The SDK usage() rate_limits as window points: five_hour, seven_day(_opus|_sonnet) and model-scoped ones by name.
export function claudeWindows(rl = {}) {
  const w = (window, x) => (x && x.utilization != null ? [{ window, pct: x.utilization, resetsAt: toEpochSec(x.resets_at) }] : []);
  return [...w('five_hour', rl.five_hour), ...w('seven_day', rl.seven_day), ...w('seven_day_opus', rl.seven_day_opus),
    ...w('seven_day_sonnet', rl.seven_day_sonnet), ...(rl.model_scoped || []).flatMap((m) => (m.display_name ? w(m.display_name, m) : []))];
}

// ---------------------------------------------------------------- codex (OpenAI Codex CLI, `codex exec --json`)

// A limit is only read from the CLI's structured failure (turn.failed, a final `error` event, or a non-zero exit whose
// stderr names a known code), never from assistant text or tool output, which may quote these phrases.
const CODEX_LIMIT_RE = /usage limit|usage_limit_(?:reached|exceeded)|usage_not_included|quota_exceeded|\b429\b|rate.?limit/i;
const CODEX_LIMIT_CODE_RE = /usage_limit_(?:reached|exceeded)|usage_not_included|quota_exceeded|you(?:'|’)ve hit your usage limit/i;
// `error` events that are retry notices ("Reconnecting... 1/5 (… 429 …)"), not failures.
const codexRetryNotice = (msg) => /^\s*reconnecting\b/i.test(msg || '');
const CODEX_AUTH_RE = /401 Unauthorized|not logged in|missing bearer|please (?:log ?in|sign in)|codex login|token (?:expired|revoked)/i;

// "…Try again at 3:05 PM." / "try again at 2026-09-25T15:05:00Z" -> epoch seconds (null if unparseable).
export function codexResetsAt(msg, now = new Date()) {
  const m = /try again (?:at|after) ([^.()\n]+(?:\.\d+)?)/i.exec(msg || '');
  if (!m) return null;
  // "Sep 26th, 2026 1:20 AM": drop the ordinal so Date.parse reads it (local time, like the CLI prints it).
  let t = Date.parse(m[1].trim().replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/i, '$1'));
  if (Number.isNaN(t)) {
    const hm = /^(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/i.exec(m[1].trim());
    if (!hm) return null;
    let h = +hm[1] % (hm[3] ? 12 : 24);
    if (hm[3] && /p/i.test(hm[3])) h += 12;
    const d = new Date(now); d.setHours(h, +hm[2], 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    t = d.getTime();
  }
  return Math.floor(t / 1000);
}

// A Codex rate_limits snapshot ({primary, secondary: {used_percent, window_minutes, resets_at | resets_in_seconds}})
// -> window points; 300 min is '5h', 10080 min 'weekly', other lengths '<n>h' / '<n>m'.
export function codexWindows(rl, now = Date.now()) {
  const out = [];
  for (const w of [rl?.primary, rl?.secondary]) {
    if (!w || w.used_percent == null) continue;
    const min = Number(w.window_minutes) || 0;
    const window = min === 300 ? '5h' : min === 10080 ? 'weekly' : min % 60 === 0 && min ? `${min / 60}h` : `${min}m`;
    const resetsAt = w.resets_at != null ? Number(w.resets_at)
      : w.resets_in_seconds != null ? Math.round(now / 1000 + Number(w.resets_in_seconds)) : null;
    out.push({ window, pct: Number(w.used_percent), resetsAt });
  }
  return out;
}
// rate_limits of a token_count event: bare, a rollout `event_msg` payload, or a protocol `{msg}` envelope. Snapshots
// without windows (e.g. `limit_id: "premium"` with null primary/secondary, written next to the plan's) are skipped.
const codexRateLimits = (m) => {
  const rl = [m, m?.payload, m?.msg].find((x) => x?.type === 'token_count' && x.rate_limits)?.rate_limits;
  return rl && (rl.primary || rl.secondary) ? rl : null;
};
// The window a hit limit belongs to: a full one (the later-resetting if both are), else the fullest.
export function codexExhausted(windows) {
  const ws = (windows || []).filter((w) => Number.isFinite(w.pct));
  const full = ws.filter((w) => w.pct >= 100).sort((a, b) => (b.resetsAt || 0) - (a.resetsAt || 0))[0];
  return full || ws.sort((a, b) => b.pct - a.pct)[0] || null;
}

// Where the rollouts are read from (CW_CODEX_HOME points tests at a fixture dir; the CLI itself always uses ~/.codex).
const CODEX_HOME = () => process.env.CW_CODEX_HOME || path.join(HOME, '.codex');
// `codex exec --json` (0.157) doesn't stream rate limits, but the thread's rollout file
// (<codexHome>/sessions/YYYY/MM/DD/rollout-…-<thread id>.jsonl) records a token_count snapshot per turn.
// Rollout files, newest day dir first (and newest file first within a day), searching the newest 14 day dirs.
function* codexRollouts(codexHome) {
  const desc = (d) => { try { return fs.readdirSync(d).filter((n) => /^\d+$/.test(n)).sort().reverse(); } catch { return []; } };
  const root = path.join(codexHome, 'sessions');
  let days = 0;
  for (const y of desc(root)) for (const mo of desc(path.join(root, y))) for (const d of desc(path.join(root, y, mo))) {
    if (days++ >= 14) return;
    const dir = path.join(root, y, mo, d);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch {}
    const withTime = names.map((n) => { try { return [n, fs.statSync(path.join(dir, n)).mtimeMs]; } catch { return [n, 0]; } });
    for (const [n] of withTime.sort((a, b) => b[1] - a[1])) yield path.join(dir, n);
  }
}
// A rollout's latest plan snapshot written since `since` (epoch ms) -> { windows, t (epoch ms) }, plus `limit`
// ({ t, message, resetsAt }) when a later turn ended with the CLI's usage-limit error (task_complete / error
// events carrying codex_error_info). Read-only.
export function codexRolloutState(file, since = 0) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let snap = null, limit = null;
  for (const line of text.split('\n')) {
    if (!line.includes('rate_limits') && !line.includes('error')) continue;
    try {
      const m = JSON.parse(line), t = Date.parse(m.timestamp), rl = codexRateLimits(m);
      if (rl) {
        if (t < since) continue;
        const windows = codexWindows(rl, Number.isFinite(t) ? t : Date.now());
        if (windows.length) { snap = { windows, t: Number.isFinite(t) ? t : Date.now() }; limit = null; }
        continue;
      }
      const err = m.payload?.error || (m.payload?.type === 'error' ? m.payload : null);
      const code = `${err?.codex_error_info || ''} ${err?.message || ''}`;
      if (err && CODEX_LIMIT_CODE_RE.test(code) && !(t < since)) limit = { t, message: err.message || '', resetsAt: codexResetsAt(err.message) };
    } catch {}
  }
  if (!snap && !limit) return null;
  return { windows: snap?.windows || null, t: snap?.t ?? null, ...(limit && { limit }) };
}
// The windows of the thread's latest snapshot written since `since` (epoch ms), or null.
export function codexRolloutWindows(threadId, since = 0, codexHome = CODEX_HOME()) {
  if (!threadId) return null;
  for (const file of codexRollouts(codexHome)) {
    if (!file.endsWith(`-${threadId}.jsonl`)) continue;
    return codexRolloutState(file, since)?.windows || null;
  }
  return null;
}
// The newest plan snapshot across all recent rollouts (any thread, including interactive sessions): the latest
// file that has one wins. { windows, t, limit? } or null. Used to poll usage while codex is idle.
export function codexLatestSnapshot(codexHome = CODEX_HOME(), maxFiles = 40) {
  let n = 0;
  for (const file of codexRollouts(codexHome)) {
    if (n++ >= maxFiles) break;
    const st = codexRolloutState(file);
    if (st?.windows) return st;
  }
  return null;
}

const clip = (t) => (t.length > 6000 ? t.slice(0, 6000) + '\n…' : t);

// Spawns a CLI that prints one JSON object per stdout line and feeds each to `handle`; stderr is kept (last 4k) in
// res.stderr. detached: the CLI gets its own process group, so an abort, or the CLI's exit, also kills the commands
// it spawned. If `stopOn` matches stderr, the run is killed too (and `stopped` is true), e.g. a CLI blocking on an auth prompt.
// runAgentCli's onSpawn({pid, pgid}) (resources.mjs ownership), reached through the adapters without threading it through each.
const spawnHook = new AsyncLocalStorage();
async function spawnJsonl({ bin, args, cwd, env, signal, res, handle, stopOn }) {
  let aborted = false, stopped = false, killTimer;
  const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  if (child.pid) { try { spawnHook.getStore()?.({ pid: child.pid, pgid: child.pid }); } catch {} }
  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
  const kill = () => {
    killGroup('SIGTERM');
    killTimer ??= setTimeout(() => killGroup('SIGKILL'), 5000);
    killTimer.unref?.();
  };
  const onAbort = () => { aborted = true; kill(); };
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  child.stderr.on('data', (d) => {
    res.stderr = (res.stderr + d).slice(-4000);
    if (stopOn && !stopped && stopOn.test(res.stderr)) { stopped = true; kill(); }
  });
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      handle(m);
    }
  });
  let exitCode = null;
  try {
    exitCode = await new Promise((resolve) => {
      child.on('error', (e) => { res.stderr += `\n${e?.message || e}`; resolve(null); });
      child.on('close', (code) => resolve(code));
    });
    if (buf.trim()) { try { handle(JSON.parse(buf)); } catch {} }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Leftover group members (background commands the CLI's tools started) die with the run; the unref'd SIGKILL
    // follow-up still fires for ones that ignore SIGTERM, without delaying the result.
    if (child.pid) { try { process.kill(-child.pid, 0); kill(); } catch {} }
  }
  return { aborted, stopped, exitCode };
}

// A web_search item's query lives in `query` or, when that's empty, in its action (search: query/queries, open_page: url,
// find_in_page: url + pattern).
const codexSearch = (it) => {
  const a = it.action || {};
  return toolInputSummary('WebSearch', nativeInput({ query: it.query || a.query || a.queries, url: a.url, pattern: a.pattern }));
};
function codexTool(it) {
  switch (it.type) {
    case 'command_execution': return { name: 'Bash', input: toolInput('Bash', { command: it.command }) };
    case 'file_change': return { name: 'Edit', input: { file_path: (it.changes || []).map((c) => `${c.kind || 'update'} ${c.path}`).join('\n') } };
    case 'mcp_tool_call': return { name: `mcp__${it.server}__${it.tool}`, input: toolInput(it.tool, it.arguments) };
    case 'web_search': return { name: 'WebSearch', input: codexSearch(it) };
    default: return null;
  }
}
const codexSearchResult = (it) => {
  const r = (it.results || []).map((x) => [x.title, x.url, x.snippet].filter(Boolean).join(' — ')).filter(Boolean).join('\n');
  const a = it.action || {}, q = codexSearch(it);
  return r || (a.type === 'open_page' || a.type === 'openPage' ? `opened ${a.url}` : q.query ? `searched: ${q.query}` : '');
};

// JSONL event -> normalised events. `started` (a Set of item ids) lets a tool be announced once, whether or not
// Codex sent item.started for it; a tool whose item.started has no arguments yet (web_search) is announced on completion.
function* codexEvents(m, started = new Set()) {
  const it = m.item;
  if (m.type === 'item.completed' && it?.type === 'agent_message') {
    if (it.text?.trim()) yield { k: 'text', text: it.text };
  } else if ((m.type === 'item.started' || m.type === 'item.completed') && it && codexTool(it)) {
    const tool = codexTool(it);
    if (!started.has(it.id) && (m.type === 'item.completed' || !isEmptyValue(tool.input))) { started.add(it.id); yield { k: 'tool', id: it.id, ...tool }; }
    if (m.type !== 'item.completed') return;
    let out = '', isError = it.status === 'failed', exit = null;
    if (it.type === 'command_execution') { out = it.aggregated_output ?? ''; if (!String(out).trim()) out = it; exit = it.exit_code ?? null; isError ||= exit != null && exit !== 0; }
    else if (it.type === 'file_change') out = (it.changes || []).map((c) => `${c.kind || 'update'} ${c.path}`).join('\n');
    else if (it.type === 'mcp_tool_call') { out = it.error?.message || it.result?.content || it.result?.structured_content || ''; isError ||= !!it.error; }
    else if (it.type === 'web_search') out = codexSearchResult(it);
    // A command item without output text would otherwise stringify whole: keep only its streams.
    if (out === it) out = { stdout: it.stdout, stderr: it.stderr, formatted_output: it.formatted_output };
    yield toolResult(it.id, out, isError, exit);
  } else if (m.type === 'turn.completed') yield { k: 'result', usage: m.usage || {} };
  else if (codexRateLimits(m)) {
    const windows = codexWindows(codexRateLimits(m));
    if (windows.length) yield { k: 'windows', windows };
  } else if (m.type === 'turn.failed' || m.type === 'error') {
    const msg = m.error?.message || m.message || '';
    if (codexRetryNotice(msg)) return;
    if (CODEX_LIMIT_RE.test(msg) && (m.type === 'turn.failed' || CODEX_LIMIT_CODE_RE.test(msg))) yield { k: 'limit', resetsAt: codexResetsAt(msg) };
  }
}

// Extra options: bin, env, autonomous (default true: no approvals and no sandbox, like Claude's bypassPermissions;
// false keeps the workspace-write sandbox), onMessage (raw JSONL events), codexHome (where the rollouts with the
// rate-limit snapshots are; CODEX_HOME is stripped, so the CLI always uses ~/.codex). Codex has no system-prompt
// append flag, so systemAppend is prepended to the prompt. effort: a level from CODEX.efforts, passed as
// `-c model_reasoning_effort=<level>` (also on `exec resume`); null keeps the model's default.
async function runCodex({ model, prompt, cwd, resume, systemAppend, signal, onEvent, bin, env = process.env, autonomous = true, onMessage, codexHome, effort, mcp }) {
  const res = { outcome: 'error', text: '', sessionId: resume || null, usage: {}, numTurns: 0, resetsAt: null, limitType: null, stderr: '', errorCode: null, windows: null };
  const startedAt = Date.now();
  // The MCP profile goes before `exec`: `exec resume` has no -p of its own.
  const profile = mcpOf('codex', mcp);
  const args = [...(profile ? ['-p', profile] : []), 'exec', ...(resume ? ['resume'] : []), '--json', '--skip-git-repo-check', '-c', 'forced_login_method="chatgpt"'];
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  if (autonomous) args.push('--dangerously-bypass-approvals-and-sandbox');
  else args.push('-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"');
  const text = systemAppend ? `${systemAppend}\n\n${prompt}` : prompt;
  args.push('--', ...(resume ? [resume] : []), text);

  let completed = false, failMsg = '', lastError = '';
  const started = new Set();
  const handle = (m) => {
    if (m.type === 'thread.started' && m.thread_id) res.sessionId = m.thread_id;
    else if (m.type === 'item.completed' && m.item?.type === 'agent_message' && m.item.text?.trim()) res.text = m.item.text;
    else if (m.type === 'turn.started') res.numTurns++;
    else if (m.type === 'turn.completed') { completed = true; res.usage = m.usage || {}; }
    else if (m.type === 'turn.failed') failMsg = m.error?.message || 'turn failed';
    else if (m.type === 'error' && !codexRetryNotice(m.message)) lastError = m.message || '';
    for (const e of codexEvents(m, started)) {
      if (e.k === 'windows') res.windows = e.windows;
      if (onEvent) { try { onEvent(e); } catch {} }
    }
    try { onMessage?.(m); } catch {}
  };
  const { aborted, exitCode } = await spawnJsonl({ bin: bin || CODEX.bin, args, cwd, env: stripEnv(env, CODEX.envFilter), signal, res, handle });

  if (aborted) { res.outcome = 'aborted'; return res; }
  if (!res.windows) {
    res.windows = codexRolloutWindows(res.sessionId, startedAt - 5000, codexHome);
    if (res.windows && onEvent) { try { onEvent({ k: 'windows', windows: res.windows }); } catch {} }
  }
  const errMsg = failMsg || (!completed ? lastError : '');
  if (completed && !failMsg && exitCode === 0) { res.outcome = 'ok'; return res; }
  const hay = `${errMsg}\n${res.stderr}`;
  if (!res.text) res.text = errMsg || res.stderr.trim();
  // stderr counts only on a failed exit and only for the CLI's own limit codes/notice (it may echo tool output).
  if (CODEX_LIMIT_RE.test(errMsg) || (!errMsg && exitCode !== 0 && CODEX_LIMIT_CODE_RE.test(res.stderr))) {
    res.outcome = 'rate_limited';
    res.errorCode = 'rate_limit';
    res.resetsAt = codexResetsAt(errMsg || res.stderr);
    // The exhausted window's snapshot gives the reset when the error has no 'try again at'.
    const full = codexExhausted(res.windows);
    if (full) { res.limitType = full.window; res.resetsAt ??= full.resetsAt; }
  } else if (CODEX_AUTH_RE.test(hay)) { res.outcome = 'auth_error'; res.errorCode = 'authentication_failed'; }
  else {
    res.outcome = 'error';
    if (resume && /no rollout found/i.test(hay)) res.errorCode = 'no_session';
  }
  return res;
}

const CODEX = {
  id: 'codex',
  label: 'Codex CLI',
  // model_reasoning_effort values codex-cli 0.157 accepts (`debug models` supported_reasoning_levels; 'ultra' and 'max'
  // only on some models: each discovered model carries its own `efforts`).
  efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  bin: 'codex',
  available() { return onPath(this.bin); },
  // `codex login status` prints "Logged in using ChatGPT" (exit 0) or "Not logged in" (exit 1). An API-key login
  // would bill API credits, so it counts as logged out.
  loggedIn() {
    return cachedLogin(this, () => {
      const r = runHelperSync(this.bin, ['login', 'status'], { env: stripEnv(process.env, this.envFilter) });
      const out = `${r.stdout || ''}\n${r.stderr || ''}`;
      return r.status === 0 && /logged in/i.test(out) && !/not logged in|api key/i.test(out);
    });
  },
  login: 'Connect from the sidebar',
  // `codex debug models` prints the model catalog as JSON (refreshed from the account; hidden models skipped).
  async listModels({ bin, env = process.env, timeoutMs = 30_000 } = {}) {
    const out = await helperOut(bin || this.bin, ['debug', 'models'], { env: stripEnv(env, this.envFilter), cwd: HOME, timeoutMs });
    return codexModels(JSON.parse(out));
  },
  // `codex exec --json` streams no limits; the newest rollout rate_limits snapshot is the only reading (at = when written).
  limitSource: 'codex rollout rate_limits',
  async limits({ codexHome } = {}) { const s = codexLatestSnapshot(codexHome); return { windows: s?.windows || [], at: s?.t ?? null }; },
  envFilter: /^(OPENAI_(API_KEY|BASE_URL|ORG_ID|ORGANIZATION|PROJECT_ID)|CODEX_(API_KEY|ACCESS_TOKEN|AUTH|HOME)|AZURE_OPENAI_.*)$/,
  events: codexEvents,
  run: runCodex,
};

// ---------------------------------------------------------------- usage limits

// What a usage limit blocks: the agent (kv keys and state.blocks use it). Every agent's limit is independent.
export const limitScope = (agent) => agent || 'claude';
// Every scope that can be blocked.
export const limitScopes = (agents) => [...agents];

// A plan window's display name ('five_hour' → '5-hour'); public/app.js winLabel matches it.
const WIN_NAMES = { '5h': '5-hour', weekly: 'Weekly', five_hour: '5-hour', seven_day: 'Weekly' };
export function windowLabel(w) {
  const name = String(w || '');
  return WIN_NAMES[name] || name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');
}

// ---------------------------------------------------------------- model discovery

// Each CLI's models as {id, label, description?, default?} (claude adds `resolved`, the full id an alias maps to).
// SDK ModelInfo rows; the 'default' row isn't a model, it marks the alias it resolves to as the default.
export function claudeModels(list) {
  const rows = Array.isArray(list) ? list.filter((m) => m?.value) : [];
  const def = rows.find((m) => m.value === 'default');
  const models = rows.filter((m) => m.value !== 'default').map((m) => ({ id: m.value, label: m.displayName || m.value,
    ...(m.description && { description: m.description }), ...(m.supportedEffortLevels?.length && { efforts: m.supportedEffortLevels }), ...(m.resolvedModel && m.resolvedModel !== m.value && { resolved: m.resolvedModel }) }));
  const d = def && models.find((m) => (m.resolved || m.id) === (def.resolvedModel || def.value));
  if (d) d.default = true;
  return models;
}
// `codex debug models` JSON (a `models` array of {slug, display_name, description, visibility, priority,
// supported_reasoning_levels: [{effort} | level]}), in priority order.
export function codexModels(j) {
  const levels = (m) => (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []).map((l) => (typeof l === 'string' ? l : l?.effort)).filter(Boolean);
  return (Array.isArray(j?.models) ? j.models : []).filter((m) => m?.slug && m.visibility !== 'hide')
    .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9))
    .map((m) => ({ id: m.slug, label: m.display_name || m.slug, ...(m.description && { description: m.description }), ...(levels(m).length && { efforts: levels(m) }),
      ...(m.default_reasoning_level && { defaultEffort: m.default_reasoning_level }) }));
}
function withTimeout(p, ms, what) {
  let timer;
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} took over ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(timer));
}

// The discovered model list per agent: {models, error, at}. Filled by models.mjs (cached in <DATA>/models.json);
// empty with an error until then, when discovery fails, or when the agent is signed out.
const catalog = new Map(), NO_MODELS = Object.freeze([]);
const none = (error, at = Date.now()) => ({ models: NO_MODELS, error, at });
export const modelCatalog = (id) => catalog.get(id) || none('loading', null);
export const setModelCatalog = (id, entry) => { catalog.set(id, entry); };
// Every id a model can be named by on this agent (ids plus the full ids aliases resolve to).
export const modelNames = (id) => modelCatalog(id).models.flatMap((m) => (m.resolved ? [m.id, m.resolved] : [m.id]));
// Concurrent discoveries / limit checks of one agent and account (bin, home, PATH) share one in-flight helper.
const flightKey = (what, id, opts) => [what, id, opts.bin || AGENTS[id]?.bin, opts.home || HOME, opts.env?.PATH ?? process.env.PATH].join('\0');
// One agent's discovery: {models, error, at}; opts go to its listModels (bin, env, query for tests).
export const discoverModels = (id, opts = {}) => singleFlight(flightKey('models', id, opts), () => discoverNow(id, opts));
async function discoverNow(id, opts) {
  const a = AGENTS[id], at = Date.now();
  if (!a) return none('unknown agent', at);
  if (!a.available()) return none('not installed', at);
  if (!a.loggedIn()) return none('not signed in', at);
  try {
    const models = await a.listModels(opts);
    return models.length ? { models, error: null, at } : none('the CLI listed no models', at);
  } catch (e) { return none(String(e?.message || e).split('\n')[0].slice(0, 200) || 'discovery failed', at); }
}

// ---------------------------------------------------------------- versions and plan limits

// `<bin> --version` → the version number ('2.1.282'; null when unreadable), cached per agent/bin for 6 h. agentVersion(id)
// answers from the cache at once (null until the first read lands) and re-reads in the background; await readVersion(id)
// for a fresh one. Never a sync spawn: the server calls agentVersion while listing connections.
const versions = new Map();
const versionKey = (a) => `${a.bin}\0${process.env.PATH}`;
export function readVersion(id) {
  const a = AGENTS[id];
  if (!a) return Promise.resolve(null);
  const e = { key: versionKey(a), at: Date.now(), value: versions.get(id)?.value ?? null };
  versions.set(id, e);
  return singleFlight(`version\0${e.key}`, async () => {
    const r = await runHelper(a.bin, ['--version'], { env: stripEnv(process.env, a.envFilter), timeoutMs: 20_000 });
    e.value = r.code !== 0 ? null : /\d+\.\d+[\w.+-]*/.exec(r.stdout || '')?.[0]?.replace(/\.$/, '') || null;
    return e.value;
  });
}
export function agentVersion(id) {
  const a = AGENTS[id], hit = versions.get(id);
  if (!a) return null;
  if (!hit || hit.key !== versionKey(a) || Date.now() - hit.at > 6 * 3600e3) readVersion(id);
  return hit?.value ?? null;
}
// Why an agent has no limit readings when its CLI has no command or event that reports them (see AGENTS.md).
export const LIMITS_NOT_EXPOSED = 'not exposed by CLI';
// One agent's plan windows, read live: {source, exposed, windows: [{window, pct, resetsAt}], error, at} (at = when the
// reading was taken, null on failure). Agents whose CLI exposes nothing: exposed false, source null, no error.
export const fetchLimits = (id, opts = {}) => singleFlight(flightKey('limits', id, opts), () => fetchLimitsNow(id, opts));
async function fetchLimitsNow(id, opts) {
  const a = AGENTS[id], at = Date.now();
  if (!a) return { source: null, exposed: false, windows: [], error: 'unknown agent', at: null };
  if (!a.limitSource) return { source: null, exposed: false, windows: [], error: null, at };
  const base = { source: a.limitSource, exposed: true, windows: [] };
  if (!a.available()) return { ...base, error: 'not installed', at: null };
  if (!a.loggedIn()) return { ...base, error: 'not signed in', at: null };
  try {
    const r = await a.limits(opts);
    return { ...base, windows: r.windows || [], error: null, at: r.at ?? at };
  } catch (e) { return { ...base, error: String(e?.message || e).split('\n')[0].slice(0, 200) || 'limit check failed', at: null }; }
}

// A resumed run failed because its session is gone (Claude's text, or an adapter's errorCode 'no_session'):
// callers drop the stored session id and retry once fresh.
export const isMissingSession = (res) => res.outcome === 'error' &&
  (res.errorCode === 'no_session' || /no conversation found/i.test(`${res.text || ''}\n${res.stderr || ''}`));

export const AGENTS = { claude: CLAUDE, codex: CODEX };

// ---------------------------------------------------------------- reasoning effort
// Only agents that declare `efforts` take one (Claude and Codex); every other agent keeps its default and never sees it.
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const agentEfforts = (id) => AGENTS[id]?.efforts || [];
// The level `agent` (on `model`, when its discovered catalog entry lists levels) runs for a requested `level`: the level
// itself if accepted, else the nearest lower one, else the lowest. null (the default) for no level or an agent without efforts.
export function clampEffort(agent, level, model = null) {
  let levels = agentEfforts(agent);
  const m = model ? modelCatalog(agent).models.find((x) => x.id === model || x.resolved === model) : null;
  if (m?.efforts?.length) levels = levels.filter((l) => m.efforts.includes(l));
  const rank = EFFORT_ORDER.indexOf(level);
  if (!levels.length || rank < 0) return null;
  if (levels.includes(level)) return level;
  const lower = levels.filter((l) => EFFORT_ORDER.indexOf(l) < rank);
  return lower.length ? lower.at(-1) : levels[0];
}

// Runs one turn on `agent` (default 'claude'). Returns at least {outcome, text, sessionId, usage, resetsAt, errorCode};
// outcome is ok | aborted | rate_limited | auth_error | max_turns | error.
// opts.onSpawn({pid, pgid}) is called for every agent CLI process spawned (not the Claude SDK's own child: see resources.mjs).
// An ok run without a final reply keeps the last assistant text; if there was none but tools ran, it gets a synthesized
// summary of them (marked as such, and emitted as a text event); a run with neither is an error, not a success.
// opts.effort: a reasoning-effort level, clamped to the agent's (and model's) levels; dropped for an agent without efforts.
export function runAgentCli(opts) {
  const a = AGENTS[opts.agent || 'claude'];
  if (!a) throw new Error(`unknown agent: ${opts.agent}`);
  opts = { ...opts, effort: opts.effort ? clampEffort(a.id, opts.effort, opts.model) : null };
  if (!opts.effort) delete opts.effort;
  let lastText = '';
  const tools = [];
  const onEvent = (e) => {
    if (e.k === 'text' && String(e.text || '').trim()) lastText = e.text;
    if (e.k === 'tool') tools.push(e.name || 'tool');
    opts.onEvent?.(e);
  };
  const run = () => a.run({ ...opts, onEvent });
  return (opts.onSpawn ? spawnHook.run(opts.onSpawn, run) : run()).then((res) => finishEmpty(res, { agent: a, lastText, tools, onEvent }));
}
export function finishEmpty(res, { agent, lastText, tools, onEvent }) {
  if (res?.outcome !== 'ok' || String(res.text || '').trim()) return res;
  if (lastText.trim()) { res.text = lastText; return res; }
  if (tools.length) {
    const counts = new Map();
    for (const t of tools) counts.set(t, (counts.get(t) || 0) + 1);
    res.text = `(No final reply from ${agent.label}; summary synthesized by agent-orch) Used ${tools.length} tool call${tools.length > 1 ? 's' : ''}: ` +
      [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ') + '.';
    res.synthesized = true;
    try { onEvent({ k: 'text', text: res.text, synthesized: true }); } catch {}
    return res;
  }
  res.outcome = 'error';
  res.errorCode = 'empty_response';
  res.text = `${agent.label} returned an empty response: no reply and no tool calls.`;
  return res;
}
