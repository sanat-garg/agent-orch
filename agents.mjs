// Pluggable coding-agent layer. Each adapter runs one headless agent turn and reports NORMALISED events:
//   {k:'text',text}  {k:'tool',name,input}  {k:'tool_result',text,isError}  {k:'result',usage}  {k:'limit',resetsAt}
//   {k:'image',tool,mediaType,data} (raw base64 from a tool result; callers store it via media.mjs and log {k:'image',id,name})
//   {k:'windows',windows:[{window,pct,resetsAt}]} (plan-window readings, pct used; codex and agy also leave the latest in res.windows)
// (adapters may add fields such as a tool id). Adapters: claude (Agent SDK), codex (`codex exec --json`),
// antigravity (`agy -p --output-format stream-json`), opencode (`opencode run --format json`),
// kiro (`kiro-cli chat --output-format stream-json`). Every adapter strips its `envFilter` vars from the env so
// billing stays on the owner's subscription login, never an API key. See .agent-orch/AGENTS.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { toolResultImages } from './media.mjs';
import { toEpochSec } from './usage.mjs';
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import { runHelper, runHelperSync, helperOut, claudeHelperSpawn, killGroup, trackGroup, singleFlight } from './helpers.mjs';

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

// Native field names (snake_cased) -> the ones the UI knows. agy: AbsolutePath, TargetFile, CommandLine, SearchPath,
// SearchDirectory, DirectoryPath, CodeContent; opencode: filePath, oldString; codex: cmd; copilot: paths; ACP: oldText.
const INPUT_ALIASES = {
  absolute_path: 'file_path', target_file: 'file_path', filepath: 'file_path', file: 'file_path', filename: 'file_path',
  command_line: 'command', cmd: 'command', search_path: 'path', search_directory: 'path', directory_path: 'path',
  directory: 'path', dir: 'path', paths: 'path', code_content: 'content', old_str: 'old_string', old_text: 'old_string',
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

// Extra options: query (SDK override, for tests), bin, env, partial (stream deltas), onMessage (raw SDK messages).
async function runClaude({ model, prompt, cwd, resume, systemAppend, signal, onEvent, query = sdkQuery, bin, env = process.env, partial, onMessage }) {
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
        cwd, resume: resume || undefined, model: model || undefined,
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
// append flag, so systemAppend is prepended to the prompt.
async function runCodex({ model, prompt, cwd, resume, systemAppend, signal, onEvent, bin, env = process.env, autonomous = true, onMessage, codexHome }) {
  const res = { outcome: 'error', text: '', sessionId: resume || null, usage: {}, numTurns: 0, resetsAt: null, limitType: null, stderr: '', errorCode: null, windows: null };
  const startedAt = Date.now();
  const args = ['exec', ...(resume ? ['resume'] : []), '--json', '--skip-git-repo-check', '-c', 'forced_login_method="chatgpt"'];
  if (model) args.push('-m', model);
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

// ---------------------------------------------------------------- antigravity (Google Antigravity CLI, `agy -p … --output-format stream-json`)

const AGY_LIMIT_RE = /RESOURCE_EXHAUSTED|quota|rate.?limit|\b429\b|exhausted/i;
const AGY_AUTH_RE = /waiting for authentication|sign in|accounts\.google\.com\/o\/oauth2|authorization code|not logged in|unauthenticated|\b401\b/i;
// agy -p doesn't fail when signed out: it prints an OAuth URL on stderr and blocks ~60 s. Kill it on sight.
const AGY_AUTH_PROMPT_RE = /waiting for authentication|paste the authorization code|accounts\.google\.com\/o\/oauth2/i;
const AGY_NO_SESSION_RE = /(conversation|session).*not found|no such (conversation|session)/i;
const AGY_DONE = new Set(['DONE', 'ERROR', 'FAILED', 'CANCELED', 'CANCELLED', 'INTERRUPTED']);

// agy's native parameter names (AbsolutePath, TargetFile, CommandLine, SearchPath…) map in nativeInput. Its stream
// sends only some parameters (write_to_file without CodeContent) and some tools' output (none for run_command's exit
// code or a silent command, none for edits): agyStepNative fills both in from the conversation it saved.
function agyTool(u, native) {
  const name = u.tool_name || u.tool_info?.name || 'tool';
  let input = nativeInput(u.tool_info?.parameters);
  if (native?.args) input = { ...nativeInput(native.args), ...input };
  if (name === 'run_command') return { name: 'Bash', input: toolInputSummary('Bash', input) };
  return { name, input: toolInputSummary(name, input) };
}

// Protobuf wire format, just enough to walk a step: field number -> [raw bytes of each length-delimited value].
function pbFields(buf) {
  const out = new Map();
  let i = 0;
  const varint = () => { let v = 0, sh = 0, c; do { if (i >= buf.length) throw new Error('truncated'); c = buf[i++]; v += (c & 0x7f) * 2 ** sh; sh += 7; } while (c & 0x80); return v; };
  while (i < buf.length) {
    const tag = varint(), wire = tag % 8, field = Math.floor(tag / 8);
    if (wire === 0) varint();
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) { const n = varint(); if (i + n > buf.length) throw new Error('truncated'); (out.get(field) || out.set(field, []).get(field)).push(buf.subarray(i, i + n)); i += n; }
    else throw new Error(`wire type ${wire}`);
  }
  return out;
}
const pbPath = (buf, ...fields) => {
  try { for (const f of fields) { buf = pbFields(buf).get(f)?.[0]; if (!buf) return null; } return buf.toString('utf8'); } catch { return null; }
};
export const AGY_HOME = () => process.env.CW_AGY_HOME || path.join(HOME, '.gemini/antigravity-cli');
// A saved step's native data, read-only: `output` (brain/<id>/.system_generated/steps/<i>/output.txt, else the step's
// tool result text in conversations/<id>.db) and `args` (the tool call's JSON arguments, step_payload field 5.4.3).
// null parts when agy hasn't written them.
export function agyStepNative(conversationId, stepIndex, { home = AGY_HOME(), args = false } = {}) {
  if (!/^[\w-]+$/.test(String(conversationId || '')) || !Number.isInteger(Number(stepIndex))) return { output: null, args: null };
  let output = null, argJson = null, payload = null;
  try { output = fs.readFileSync(path.join(home, 'brain', conversationId, '.system_generated/steps', String(stepIndex), 'output.txt'), 'utf8'); } catch {}
  if (output == null || args) {
    const file = path.join(home, 'conversations', `${conversationId}.db`);
    if (fs.existsSync(file)) {
      let db;
      try {
        db = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(file, { readOnly: true });
        payload = db.prepare('SELECT step_payload FROM steps WHERE idx = ?').get(Number(stepIndex))?.step_payload;
      } catch {} finally { try { db?.close(); } catch {} }
    }
    if (payload) {
      const buf = Buffer.from(payload);
      output ??= pbPath(buf, 140, 2, 1);
      if (args) { try { argJson = JSON.parse(pbPath(buf, 5, 4, 3) || 'null'); } catch {} }
    }
  }
  return { output, args: argJson };
}
// run_command's saved output: "The command exited with code N.\nStdout:\n…\nStderr:\n…" (or "Output:\n…").
const agyCommandOutput = (saved) => {
  const t = String(saved || ''), m = /The command exited with code (-?\d+)\.?/.exec(t);
  return m && { exitCode: Number(m[1]), text: t.slice(m.index + m[0].length).replace(/^[ \t]*(?:Stdout|Stderr|Output):[ \t]*$/gm, '').trim() };
};

// Antigravity's four limits: a 5-hour and a weekly one per model group. Gemini models ('gemini-*', and agy's default
// when no model is named) count against the 'gemini' group, everything else (Claude, GPT-OSS) against '3p'.
export const AGY_GROUPS = { gemini: 'Gemini', '3p': 'Third-party' };
export const agyGroup = (model) => (!model || /^gemini-/i.test(String(model).trim()) ? 'gemini' : '3p');
// The group a window id belongs to ('3p-weekly' → '3p'), or null for windows without one.
export const windowGroup = (w) => /^(gemini|3p)-/.exec(String(w || ''))?.[1] || null;
// What a usage limit blocks: the agent, or for antigravity the agent + model group ('antigravity:3p'). kv keys and
// state.blocks use it, so a Gemini limit never blocks third-party models and vice versa.
export const limitScope = (agent, model) => (agent === 'antigravity' ? `antigravity:${agyGroup(model)}`
  : agent === 'opencode' ? `opencode:${String(model || 'openai/').split('/')[0]}` : agent || 'claude');
export const scopeGroup = (scope) => String(scope || '').split(':')[1] || null;
// Every scope that can be blocked.
export const limitScopes = (agents) => agents.flatMap((a) => (a === 'antigravity' ? Object.keys(AGY_GROUPS).map((g) => `${a}:${g}`)
  : a === 'opencode' ? [...Object.keys(OPENCODE_OAUTH), ZEN].map((p) => `opencode:${p}`) : [a]));
// A scope's windows among an agent's: only its group's for antigravity.
export const scopeWindows = (scope, list) => { const g = scopeGroup(scope); return (list || []).filter((w) => !g || (scope.startsWith('opencode:') ? w.window.startsWith(`${g}-`) : windowGroup(w.window) === g)); };

// A plan window's display name ('3p-5h' → 'Third-party · 5-hour'); public/app.js winLabel matches it.
const WIN_NAMES = { '5h': '5-hour', weekly: 'Weekly', five_hour: '5-hour', seven_day: 'Weekly', premium: 'Premium requests' };
export function windowLabel(w) {
  const g = windowGroup(w), rest = g ? String(w).slice(g.length + 1) : String(w || '');
  const name = WIN_NAMES[rest] || rest.charAt(0).toUpperCase() + rest.slice(1).replace(/_/g, ' ');
  return g ? `${AGY_GROUPS[g]} · ${name}` : name;
}

// `agy -p /usage` data ({groups:[{name, buckets:[{id, window, remaining_fraction, reset_time}]}]}) -> window points.
// Each model group has its own 5h and weekly limit, so the window is the bucket id ('gemini-5h', '3p-weekly').
export function agyWindows(data) {
  const out = [];
  for (const g of data?.groups || []) for (const b of g.buckets || []) {
    if (b.remaining_fraction == null) continue;
    const window = b.id || `${String(g.name || 'models').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${b.window}`;
    out.push({ window, pct: Math.round((1 - Number(b.remaining_fraction)) * 1e4) / 100, resetsAt: b.reset_time ? Math.round(Date.parse(b.reset_time) / 1000) || null : null });
  }
  return out;
}
const agyUsageData = (m) => { const c = m.command || m.result?.command; return c?.name === 'usage' || c?.name === 'quota' ? c.data : null; };

export const agyDeniedNote = (names) => `Antigravity denied ${[...new Set(names)].join(', ')} without asking: headless agy can't prompt for ` +
  'permission and only runs these tools with --dangerously-skip-permissions (autonomous).';

// NDJSON event -> normalised events. `st` carries the text_delta buffers (per step) and the announced tool steps
// across calls; a step's text is emitted once the step is DONE, another step starts, or the result arrives.
function* agyEvents(m, st = { text: new Map(), started: new Set() }) {
  const flush = function* (keep) {
    for (const [i, t] of st.text) if (i !== keep) { st.text.delete(i); if (t.trim()) yield { k: 'text', text: t }; }
  };
  if (m.event === 'step_update' && m.step_update) {
    const u = m.step_update, i = u.step_index;
    yield* flush(i);
    if (u.step_type === 'agent_response') {
      if (u.text_delta) st.text.set(i, (st.text.get(i) || '') + u.text_delta);
      if (AGY_DONE.has(u.state)) yield* flush();
    } else if (u.step_type === 'tool') {
      const done = AGY_DONE.has(u.state), ti = u.tool_info || {};
      // Announced once it has arguments, or when it finishes (then with the saved call's arguments if the stream had none).
      if (!st.started.has(i)) {
        let tool = agyTool(u);
        if (isEmptyValue(tool.input) && !done) return;
        if (isEmptyValue(tool.input)) tool = agyTool(u, agyStepNative(u.conversation_id, i, { home: st.home, args: true }));
        st.started.add(i);
        yield { k: 'tool', id: String(i), ...tool };
      }
      if (!done) return;
      const name = u.tool_name || ti.name;
      let out = ti.output ?? ti.error?.message ?? ti.error ?? '', isError = u.state !== 'DONE' || !!ti.error, exit = null;
      if (name === 'run_command' || !outputText(out).trim()) {
        const saved = agyStepNative(u.conversation_id, i, { home: st.home }).output;
        const cmd = name === 'run_command' ? agyCommandOutput(saved) : null;
        if (cmd) { exit = cmd.exitCode; isError ||= exit !== 0; if (!outputText(out).trim()) out = cmd.text; }
        else if (!outputText(out).trim() && saved) out = saved.replace(/\s*If relevant, proactively run terminal commands[^\n]*/g, '').trim();
      }
      yield toolResult(String(i), out, isError, exit);
    }
  } else if (m.event === 'command_result' && agyUsageData(m)) {
    const windows = agyWindows(agyUsageData(m));
    if (windows.length) yield { k: 'windows', windows };
  } else if (m.event === 'result' && m.result) {
    yield* flush();
    const r = m.result;
    // Without --dangerously-skip-permissions, headless agy auto-denies every tool that needs a prompt (run_command…) and
    // still reports SUCCESS, the denied step looking DONE with no output: say so, or the turn just ends silently.
    const denied = (r.denied_actions || []).map((d) => d.display_name || d.action).filter(Boolean);
    if (denied.length) yield { k: 'text', text: agyDeniedNote(denied) };
    if (r.status === 'SUCCESS') yield { k: 'result', usage: r.usage || {} };
    else if (AGY_LIMIT_RE.test(r.error || '')) yield { k: 'limit', resetsAt: codexResetsAt(r.error) };
  }
}

// The plan windows from `agy -p /usage --output-format stream-json` (a local command: no model call, no tokens);
// null if it fails or takes over 20 s.
export async function agyUsage({ bin, env = process.env, cwd = HOME } = {}) {
  let windows = null;
  const r = await runHelper(bin || ANTIGRAVITY.bin, ['-p', '/usage', '--output-format', 'stream-json', '--print-timeout', '0'], { cwd,
    env: stripEnv(env, ANTIGRAVITY.envFilter), timeoutMs: 20_000, stopOn: AGY_AUTH_PROMPT_RE });
  for (const line of r.stdout.split('\n')) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.event === 'command_result' && agyUsageData(m)) windows = agyWindows(agyUsageData(m));
  }
  return windows?.length ? windows : null;
}

// Extra options: bin, env, autonomous (default true: --dangerously-skip-permissions approves every tool, like
// Claude's bypassPermissions; false leaves agy's headless policy), settingsPath (agy's settings.json, checked for
// API-key mode), onMessage (raw NDJSON events), usageProbe (default true: after an ok or rate-limited run, read the
// plan windows with agyUsage into res.windows). agy has no system-prompt append flag, so systemAppend is prepended.
async function runAntigravity({ model, prompt, cwd, resume, systemAppend, signal, onEvent, bin, env = process.env, autonomous = true, onMessage,
  settingsPath = path.join(HOME, '.gemini/antigravity-cli/settings.json'), usageProbe = true, agyHome }) {
  const res = { outcome: 'error', text: '', sessionId: resume || null, usage: {}, numTurns: 0, resetsAt: null, limitType: null, stderr: '', errorCode: null, windows: null };
  // `"modelProvider": "gemini"` switches agy to GEMINI_API_KEY billing; refuse rather than spend API credits.
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
  if (settings?.modelProvider === 'gemini') {
    Object.assign(res, { outcome: 'auth_error', errorCode: 'authentication_failed',
      text: `agy is set to API-key mode (modelProvider "gemini" in ${settingsPath}); remove it to use the Google account login.` });
    return res;
  }
  const text = systemAppend ? `${systemAppend}\n\n${prompt}` : prompt;
  const args = ['-p', text, '--output-format', 'stream-json', '--print-timeout', '0'];
  if (model) args.push('--model', model);
  if (autonomous) args.push('--dangerously-skip-permissions');
  if (resume) args.push('--conversation', resume);

  let result = null;
  const st = { text: new Map(), started: new Set(), home: agyHome };
  const handle = (m) => {
    const id = m.conversation_id || m.step_update?.conversation_id || m.result?.conversation_id;
    if (id) res.sessionId = id;
    if (m.event === 'result' && m.result) { result = m.result; res.usage = result.usage || {}; res.numTurns = result.num_turns || 0; }
    for (const e of agyEvents(m, st)) {
      if (e.k === 'text') res.text = e.text;
      if (onEvent) { try { onEvent(e); } catch {} }
    }
    try { onMessage?.(m); } catch {}
  };
  const { aborted, stopped, exitCode } = await spawnJsonl({ bin: bin || ANTIGRAVITY.bin, args, cwd, env: stripEnv(env, ANTIGRAVITY.envFilter),
    signal, res, handle, stopOn: AGY_AUTH_PROMPT_RE });

  if (aborted) { res.outcome = 'aborted'; return res; }
  const probe = async () => {
    if (!usageProbe || signal?.aborted) return;
    try { res.windows = await agyUsage({ bin, env, cwd }); } catch {}
    if (res.windows && onEvent) { try { onEvent({ k: 'windows', windows: res.windows }); } catch {} }
  };
  if (result?.status === 'SUCCESS' && exitCode === 0 && !stopped) {
    if (result.response) res.text = result.response;
    res.outcome = 'ok';
    await probe();
    return res;
  }
  const errMsg = result?.error || (result ? `agy ended with status ${result.status}` : '');
  const hay = `${errMsg}\n${res.stderr}`;
  if (!res.text || result?.status !== 'SUCCESS') res.text = errMsg || res.stderr.trim();
  if (stopped || AGY_AUTH_RE.test(hay) && !AGY_LIMIT_RE.test(errMsg)) { res.outcome = 'auth_error'; res.errorCode = 'authentication_failed'; }
  // Only the result's error decides a limit: a failed run's stderr log may mention 'quota' in passing.
  else if (AGY_LIMIT_RE.test(errMsg)) {
    res.outcome = 'rate_limited'; res.errorCode = 'rate_limit'; res.resetsAt = codexResetsAt(errMsg);
    await probe();
    const full = (res.windows || []).filter((w) => w.pct >= 100 && windowGroup(w.window) === agyGroup(model)).sort((a, b) => (b.resetsAt || 0) - (a.resetsAt || 0))[0];
    if (full) { res.limitType = full.window; res.resetsAt ??= full.resetsAt; }
  }
  else {
    res.outcome = 'error';
    if (resume && AGY_NO_SESSION_RE.test(hay)) res.errorCode = 'no_session';
  }
  return res;
}

export const agyModelsOk = (r) => r.status === 0 && !/sign in|not signed/i.test(`${r.stdout || ''}\n${r.stderr || ''}`);

const ANTIGRAVITY = {
  id: 'antigravity',
  label: 'Antigravity CLI',
  bin: path.join(HOME, '.local/bin/agy'),
  available() { return onPath(this.bin); },
  // `agy models` prints the model list when signed in, and exits 1 with "Please sign in …" right away when not
  // (the token's location varies: keyring or a file). API-key env vars are stripped, so only the Google login counts.
  loggedIn() {
    return cachedLogin(this, () => agyModelsOk(runHelperSync(this.bin, ['models'], this.modelsOpts())));
  },
  // The same check, uncached and async (connections.mjs polls it while a sign-in is waiting).
  async probe() {
    const r = await runHelper(this.bin, ['models'], this.modelsOpts());
    return agyModelsOk({ status: r.code === 0 && !r.error && !r.timedOut ? 0 : 1, stdout: r.stdout, stderr: r.stderr });
  },
  modelsOpts() { return { env: stripEnv(process.env, this.envFilter), cwd: HOME, timeoutMs: 8000 }; },
  login: 'Connect from the sidebar',
  // `agy models` prints one `<id>\t<display name>` line per model (progress goes to stderr).
  async listModels({ bin, env = process.env, timeoutMs = 20_000 } = {}) {
    return agyModels(await helperOut(bin || this.bin, ['models'], { env: stripEnv(env, this.envFilter), cwd: HOME, timeoutMs }));
  },
  limitSource: 'agy -p /usage',
  async limits({ bin, env = process.env } = {}) {
    const windows = await agyUsage({ bin, env });
    if (!windows) throw new Error('agy /usage returned no windows');
    return { windows };
  },
  envFilter: /^(GEMINI_API_KEY|GOOGLE_(API_KEY|GEMINI_BASE_URL|GENAI_USE_VERTEXAI|GENAI_USE_ENTERPRISE|GENAI_USE_GCA|APPLICATION_CREDENTIALS|CLOUD_PROJECT(_ID)?|CLOUD_LOCATION)|AGY_(ADC_AUTH|BUSINESS_PAYGO_TIER))$/,
  events: agyEvents,
  run: runAntigravity,
};

// ---------------------------------------------------------------- opencode (OAuth-backed subscription providers)

// The OpenCode providers with a headless subscription sign-in (device flows; login specs in connections.mjs
// SPECS.opencode.providers). API-key providers (OpenCode Zen, Anthropic, Google, …) never count as connected.
export const OPENCODE_OAUTH = { openai: 'ChatGPT', 'github-copilot': 'Copilot', xai: 'SuperGrok' };
export const opencodeAuthFile = (home = HOME) => path.join(home, '.local/share/opencode/auth.json');
// The email claim of an OAuth access token (decoded locally, never verified or sent anywhere); ChatGPT nests it.
const jwtEmail = (jwt) => {
  try {
    const c = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString());
    const e = c.email || c['https://api.openai.com/profile']?.email;
    return typeof e === 'string' && e || null;
  } catch { return null; }
};
// Signed-in subscription providers, in OPENCODE_OAUTH order: [{id, account}].
export function opencodeProviders(home = HOME) {
  let all;
  try { all = JSON.parse(fs.readFileSync(opencodeAuthFile(home), 'utf8')) || {}; } catch { return []; }
  return Object.keys(OPENCODE_OAUTH).flatMap((id) => {
    const a = all[id], token = a?.type === 'oauth' && [a.refresh, a.access].find((t) => typeof t === 'string' && t.length > 0);
    return token ? [{ id, account: jwtEmail(a.access) }] : [];
  });
}
export const opencodeAuth = (home = HOME) => opencodeProviders(home).length > 0;
// A pay-as-you-go OpenCode Zen key (`opencode auth login` → OpenCode Zen). Without one only free Zen models are offered.
export function opencodeZenKey(home = HOME) {
  try { const z = JSON.parse(fs.readFileSync(opencodeAuthFile(home), 'utf8'))?.opencode; return z?.type === 'api' && !!z.key; } catch { return false; }
}
// OpenCode Zen (provider `opencode`) needs no sign-in for its free models. Free = zero cost in `opencode models
// --verbose`; without that reading, the Zen naming convention (`-free` ids, big-pickle).
export const ZEN = 'opencode';
export const zenFreeId = (id) => /^opencode\/(?:[\w.-]+-free|big-pickle)$/.test(String(id));
// `opencode models [--verbose]` output → [{id: 'provider/model', label, free?}]: models of the signed-in `providers`,
// free Zen models, and paid Zen models only with a Zen key. Verbose output puts a JSON block under each id line.
export function opencodeModels(out, providers = Object.keys(OPENCODE_OAUTH), { zenKey = false } = {}) {
  const entries = new Map();
  let cur = null;
  for (const line of String(out).split('\n')) {
    if (/^[\w.-]+\/\S+$/.test(line.trim()) && !/^\s/.test(line)) {
      cur = line.trim();
      if (!entries.has(cur)) entries.set(cur, []);
    } else if (cur) entries.get(cur).push(line);
  }
  const ids = [...entries].flatMap(([id, body]) => {
    const p = id.startsWith(`${ZEN}/`) ? ZEN : providers.find((x) => id.startsWith(`${x}/`));
    if (!p || !/^[\w.-]+$/.test(id.slice(p.length + 1))) return [];
    let info = null;
    try { info = body.join('\n').trim() ? JSON.parse(body.join('\n')) : null; } catch {}
    if (p !== ZEN) return [[id, p, info]];
    const cost = info?.cost, free = cost ? [cost.input, cost.output, cost.cache?.read, cost.cache?.write].every((v) => !v) : zenFreeId(id);
    return free || zenKey ? [[id, p, info, free]] : [];
  });
  const many = new Set(ids.filter(([, p]) => p !== ZEN).map(([, p]) => p)).size > 1;
  return ids.map(([id, p, info, free]) => (p === ZEN
    ? { id, label: `Zen · ${info?.name || id.slice(p.length + 1)}${free ? ' (free)' : ''}`, ...(free ? { free: true } : {}) }
    : { id, label: id.slice(p.length + 1) + (many ? ` · ${OPENCODE_OAUTH[p]}` : '') }));
}
// A Zen model that costs money: refused unless the owner added a Zen key. Uses the discovered catalog's `free` flag.
export const zenPaid = (model, home = HOME) => String(model || '').startsWith(`${ZEN}/`) && !opencodeZenKey(home)
  && !(modelCatalog('opencode').models.find((m) => m.id === model)?.free ?? zenFreeId(model));
const OPENCODE_LIMIT_RE = /\b429\b|rate.?limit|quota|usage limit|resource.exhausted/i;
const OPENCODE_AUTH_RE = /\b401\b|unauthorized|not authenticated|not logged in|invalid.*(?:token|credential)|authentication/i;
const OPENCODE_NO_SESSION_RE = /session.*(?:not found|does not exist)|no such session/i;
const opencodeError = (e) => [e?.name, e?.data?.code, e?.data?.status, e?.data?.message, e?.message].filter((v) => v != null).join(' ');
const opencodeReset = (e) => {
  const data = e?.data || {};
  const v = data.resetsAt ?? data.resetAt ?? data.reset_at ?? data.retryAfter ?? data.retry_after;
  if (v != null) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.round(n > 1e12 ? n / 1000 : n < 86400 ? Date.now() / 1000 + n : n);
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return Math.round(parsed / 1000);
  }
  return codexResetsAt(data.message || e?.message || '');
};
// OpenCode updates a tool part from running to completed/error. A tool's output is never a provider error.
export function* opencodeEvents(m, st = { tools: new Set() }) {
  const p = m.part || {};
  if (m.type === 'text' && p.text?.trim()) yield { k: 'text', text: p.text };
  else if (m.type === 'tool_use' && p.type === 'tool') {
    const id = p.callID || p.id || p.toolID || m.id || p.tool;
    const s = p.state || {};
    const done = ['completed', 'error'].includes(s.status);
    // A pending part has no input yet: announce the tool once it has some, or when it ends.
    if (!st.tools.has(id) && (done || !isEmptyValue(s.input))) {
      st.tools.add(id);
      const name = p.tool === 'bash' ? 'Bash' : p.tool;
      yield { k: 'tool', id, name, input: toolInput(name, s.input) };
    }
    if (done) {
      const exit = s.metadata?.exit ?? null;
      yield toolResult(id, s.output ?? s.error ?? s.metadata?.output ?? '', s.status === 'error' || (exit != null && exit !== 0), exit);
    }
  } else if (m.type === 'step_finish' && p.tokens) {
    const t = p.tokens;
    yield { k: 'result', usage: { input_tokens: t.input || 0, output_tokens: t.output || 0,
      cached_input_tokens: t.cache?.read || 0, reasoning_output_tokens: t.reasoning || 0 } };
  } else if (m.type === 'error' && OPENCODE_LIMIT_RE.test(opencodeError(m.error))) {
    yield { k: 'limit', resetsAt: opencodeReset(m.error) };
  }
}
// OpenCode merges the global config (~/.config/opencode), every opencode.json[c] from the cwd up to the git root,
// and the cwd's .env. Returns the first file that sets an API key or custom endpoint, else null.
export function opencodeBillingConfig(cwd, env = process.env) {
  const globalDir = path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || HOME, '.config'), 'opencode');
  const files = ['config.json', 'opencode.json', 'opencode.jsonc'].map((f) => path.join(globalDir, f));
  files.push(path.join(cwd, '.env'));
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    files.push(path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc'));
    if (fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) break;
  }
  for (const file of files) {
    let cfg;
    try { cfg = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (path.basename(file) === '.env' ? /^\s*(?:[A-Z][A-Z0-9_]*(?:_API_KEY|_TOKEN)|OPENAI_BASE_URL)\s*=/m.test(cfg)
      : /"(?:apiKey|baseURL)"\s*:/.test(cfg)) return path.dirname(file) === path.resolve(cwd) ? path.basename(file) : file;
  }
  return null;
}
async function runOpencode({ model, prompt, cwd, resume, systemAppend, signal, onEvent, onMessage, bin, env = process.env, autonomous = true }) {
  const res = { outcome: 'error', text: '', sessionId: resume || null, usage: {}, numTurns: 0, resetsAt: null,
    limitType: null, stderr: '', errorCode: null, windows: null };
  // Any config OpenCode loads can override OAuth with an API key or custom endpoint; don't risk another billing route.
  const bad = opencodeBillingConfig(cwd, env);
  if (bad) {
    res.outcome = 'auth_error'; res.errorCode = 'authentication_failed';
    res.text = `${bad} configures an API key or custom endpoint; OpenCode requires subscription OAuth.`;
    return res;
  }
  if (zenPaid(model, env.HOME || HOME)) {
    res.outcome = 'auth_error'; res.errorCode = 'authentication_failed';
    res.text = `${model} is a paid OpenCode Zen model; only the free Zen models run without a Zen key.`;
    return res;
  }
  const args = ['run', '--dir', cwd, '--format', 'json'];
  if (model) args.push('--model', model);
  if (resume) args.push('--session', resume);
  if (autonomous) args.push('--auto');
  args.push(systemAppend ? `${systemAppend}\n\n${prompt}` : prompt);
  let failure = null;
  const st = { tools: new Set() };
  const handle = (m) => {
    if (m.sessionID) res.sessionId = m.sessionID;
    if (m.type === 'error') failure = m.error || { message: 'OpenCode error' };
    if (m.type === 'step_finish') res.numTurns++;
    for (const e of opencodeEvents(m, st)) {
      if (e.k === 'text') res.text = e.text;
      if (e.k === 'result') for (const [k, v] of Object.entries(e.usage)) res.usage[k] = (res.usage[k] || 0) + v;
      if (onEvent) { try { onEvent(e); } catch {} }
    }
    try { onMessage?.(m); } catch {}
  };
  const { aborted, exitCode } = await spawnJsonl({ bin: bin || OPENCODE.bin, args, cwd, env: stripEnv(env, OPENCODE.envFilter), signal, res, handle });
  if (aborted) { res.outcome = 'aborted'; return res; }
  if (exitCode === 0 && !failure) { res.outcome = 'ok'; return res; }
  const message = opencodeError(failure) || res.stderr.trim();
  if (!res.text) res.text = message;
  if (failure && OPENCODE_LIMIT_RE.test(message)) {
    res.outcome = 'rate_limited'; res.errorCode = 'rate_limit'; res.resetsAt = opencodeReset(failure);
  } else if (OPENCODE_AUTH_RE.test(message)) { res.outcome = 'auth_error'; res.errorCode = 'authentication_failed'; }
  else if (resume && OPENCODE_NO_SESSION_RE.test(message)) res.errorCode = 'no_session';
  return res;
}
const OPENCODE = {
  id: 'opencode', label: 'OpenCode CLI', bin: 'opencode',
  available() { return onPath(this.bin); },
  // Ready with a subscription provider, or with no sign-in at all when OpenCode lists free Zen models.
  loggedIn() { return modelCatalog('opencode').models.length > 0 || cachedLogin(this, () => opencodeAuth()); },
  freeTier: true,
  // One OpenCode login can hold several providers; connections.mjs shows each one's account.
  account() { return null; },
  login: 'Connect from the sidebar',
  freeModels() { return modelCatalog('opencode').models.filter((m) => m.free); },
  // `opencode stats` totals tokens and cost; no command reports subscription windows or reset times.
  limitSource: null,
  // The signed-in subscription providers' models plus the free Zen ones, from one `opencode models --verbose` run in a
  // neutral cwd (no project config) with the billing env stripped.
  // 60 s: it refreshes the models.dev catalog first, which ran past 30 s while every agent was being checked at boot.
  async listModels({ bin, env = process.env, home = HOME, timeoutMs = 60_000 } = {}) {
    const out = await helperOut(bin || this.bin, ['models', '--verbose'], { env: stripEnv(env, this.envFilter), cwd: HOME, timeoutMs });
    return opencodeModels(out, opencodeProviders(home).map((p) => p.id), { zenKey: opencodeZenKey(home) });
  },
  envFilter: /^(?:.*(?:_API_KEY|_TOKEN)|OPENAI_(?:BASE_URL|ORG_ID|ORGANIZATION|PROJECT_ID)|AZURE_OPENAI_.*|OPENCODE_(?:AUTH|CONFIG.*))$/,
  events: opencodeEvents, run: runOpencode,
};

// ---------------------------------------------------------------- kiro (browser-authenticated Kiro CLI)

export function kiroAuth(out) {
  try {
    const j = JSON.parse(String(out || ''));
    // Signed-out releases return {account:null}; authenticated ones may put accountType/email at the top level.
    const account = j?.account && typeof j.account === 'object' ? j.account : j;
    const type = String(account?.accountType || account?.account_type || account?.type || account?.authMethod || account?.auth_method || '');
    if (!account || j?.account === null || !type || /api.?key/i.test(type)) return { ok: false, account: null };
    return { ok: true, account: account.email || account.name || account.username || null };
  } catch { return { ok: false, account: null }; }
}
export function kiroModels(out) {
  const j = JSON.parse(String(out || ''));
  const rows = Array.isArray(j) ? j : j.models;
  if (!Array.isArray(rows)) throw new Error('Kiro returned no model list');
  return rows.filter((m) => typeof m === 'string' || m?.id || m?.modelId || m?.model_id).map((m) => {
    const id = typeof m === 'string' ? m : m.id || m.modelId || m.model_id;
    return { id, label: typeof m === 'string' ? m : m.model_name || m.name || m.displayName || id,
      ...(m.description && { description: m.description }), ...((m.default === true || id === j.default_model) && { default: true }) };
  });
}
const KIRO_LIMIT_RE = /\b429\b|rate.?limit|quota|credits? (?:exhausted|depleted)|(?:exhausted|insufficient) credits|usage limit|throttl/i;
const KIRO_AUTH_RE = /not authenticated|not logged in|sign in|login --use-device-flow|authentication required|api key required/i;
const KIRO_NO_SESSION_RE = /session.*(?:not found|does not exist)|no such session/i;
const kiroError = (m) => {
  const e = m?.error || m?.params?.error || m?.data?.error;
  return e && [e.code, e.type, e.message, e.data?.message].filter((v) => v != null).join(' ');
};
const kiroReset = (m) => {
  const e = m?.error || m?.params?.error || m?.data?.error || {};
  const v = e.resetsAt ?? e.resetAt ?? e.reset_at ?? e.retryAfter ?? e.retry_after ?? e.data?.resetsAt;
  if (v != null) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.round(n > 1e12 ? n / 1000 : n < 86400 ? Date.now() / 1000 + n : n);
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return Math.round(parsed / 1000);
  }
  return codexResetsAt(kiroError(m) || '');
};
// stream-json is an ACP event stream. Tool output and assistant prose never classify a provider limit.
export function* kiroEvents(m, st = { tools: new Set() }) {
  const u = m.params?.update || m.update || m;
  const kind = u.sessionUpdate || u.type || m.type;
  if (kind === 'agent_message_chunk') {
    const value = u.content?.text;
    if (value) yield { k: 'text', text: value };
  } else if (kind === 'tool_call' || kind === 'tool_call_update') {
    const id = u.toolCallId || u.id || u.title;
    const done = kind === 'tool_call_update' && ['completed', 'failed'].includes(u.status);
    // ACP may send the call before its rawInput (it follows in an update); `locations` names the files it touches.
    st.inputs ??= new Map(); st.names ??= new Map();
    if (!st.names.has(id)) st.names.set(id, u.title || u.kind || 'Tool');
    const raw = { ...(st.inputs.get(id) || {}), ...nativeInput(u.rawInput) };
    if (isEmptyValue(raw) && u.locations?.length) raw.file_path = u.locations.map((l) => l.path).filter(Boolean).join(', ');
    st.inputs.set(id, raw);
    if (!st.tools.has(id) && (done || !isEmptyValue(raw))) {
      st.tools.add(id);
      const name = st.names.get(id);
      yield { k: 'tool', id, name, input: toolInputSummary(name, raw) };
    }
    if (done) {
      const exit = u.rawOutput?.exit_code ?? u.rawOutput?.exitCode ?? null;
      const content = outputText(u.content);
      yield toolResult(id, content.trim() ? content : u.rawOutput ?? '', u.status === 'failed' || (exit != null && exit !== 0), exit);
    }
  } else if (kind === 'result' && m.usage) yield { k: 'result', usage: m.usage };
  else if ((m.type === 'error' || m.method === 'error') && KIRO_LIMIT_RE.test(kiroError(m) || '')) yield { k: 'limit', resetsAt: kiroReset(m) };
}
async function runKiro({ model, prompt, cwd, resume, systemAppend, signal, onEvent, onMessage, bin, env = process.env, autonomous = true }) {
  const res = { outcome: 'error', text: '', sessionId: resume || null, usage: {}, numTurns: 0, resetsAt: null,
    limitType: null, stderr: '', errorCode: null, windows: null };
  const args = ['chat', '--no-interactive', '--agent-engine', 'v2', '--output-format', 'stream-json'];
  if (autonomous) args.push('--trust-all-tools');
  if (model) args.push('--model', model);
  if (resume) args.push('--resume-id', resume);
  args.push(systemAppend ? `${systemAppend}\n\n${prompt}` : prompt);
  let failure = null, terminal = false;
  const st = { tools: new Set() };
  const handle = (m) => {
    res.sessionId = m.sessionId || m.session_id || m.params?.sessionId || res.sessionId;
    if (m.type === 'error' || m.method === 'error') failure = m;
    if (m.type === 'result' || m.type === 'interrupted' || m.method === 'session/end') terminal = true;
    if (m.usage && m.type === 'result') res.usage = m.usage;
    for (const e of kiroEvents(m, st)) {
      if (e.k === 'text') res.text += e.text;
      if (onEvent) { try { onEvent(e); } catch {} }
    }
    try { onMessage?.(m); } catch {}
  };
  const { aborted, exitCode } = await spawnJsonl({ bin: bin || KIRO.bin, args, cwd, env: stripEnv(env, KIRO.envFilter), signal, res, handle });
  if (aborted) { res.outcome = 'aborted'; return res; }
  const message = kiroError(failure) || res.stderr.trim();
  if (exitCode === 0 && !failure && (terminal || res.text)) { res.outcome = 'ok'; return res; }
  if (!res.text) res.text = message;
  if (failure && KIRO_LIMIT_RE.test(kiroError(failure) || '')) {
    res.outcome = 'rate_limited'; res.errorCode = 'rate_limit'; res.resetsAt = kiroReset(failure);
  } else if (KIRO_AUTH_RE.test(message)) { res.outcome = 'auth_error'; res.errorCode = 'authentication_failed'; }
  else if (resume && KIRO_NO_SESSION_RE.test(message)) res.errorCode = 'no_session';
  return res;
}
const KIRO = {
  id: 'kiro', label: 'Kiro CLI', bin: path.join(HOME, '.local/bin/kiro-cli'),
  available() { return onPath(this.bin); },
  loggedIn() {
    return cachedLogin(this, () => {
      const r = runHelperSync(this.bin, ['whoami', '--format', 'json'], { env: stripEnv(process.env, this.envFilter) });
      const a = r.status === 0 ? kiroAuth(r.stdout) : { ok: false, account: null };
      this.identity = a.account;
      return a.ok;
    });
  },
  account() { return this.loggedIn() ? this.identity : null; },
  login: 'Connect from the sidebar',
  // Credits show only in the interactive chat's /usage; no headless command or stream event reports them.
  limitSource: null,
  async listModels({ bin, env = process.env, timeoutMs = 20_000 } = {}) {
    return kiroModels(await helperOut(bin || this.bin, ['chat', '--list-models', '--format', 'json'], { env: stripEnv(env, this.envFilter), cwd: HOME, timeoutMs }));
  },
  envFilter: /^KIRO_API_KEY$/,
  events: kiroEvents, run: runKiro,
};

// ---------------------------------------------------------------- copilot (GitHub Copilot CLI)

const COPILOT_LIMIT_RE = /\b429\b|rate.?limit|quota(?: exceeded| exhausted)?|(?:premium requests?|credits?) (?:exhausted|depleted)|usage limit/i;
const COPILOT_AUTH_RE = /\b401\b|unauthorized|not authenticated|sign in|login required|copilot subscription/i;
const COPILOT_NO_SESSION_RE = /session.*(?:not found|does not exist)|no such session/i;
const copilotErrorText = (m) => {
  const e = m?.data?.error || m?.error || m?.data;
  return [e?.code, e?.type, e?.message, typeof e === 'string' ? e : null].filter(Boolean).join(' ');
};
export function* copilotEvents(m) {
  const d = m.data || {};
  if (m.type === 'assistant.message' && d.content?.trim()) yield { k: 'text', text: d.content };
  else if (m.type === 'tool.execution_start') {
    const name = d.toolName === 'bash' ? 'Bash' : d.toolName || 'Tool';
    // apply_patch's arguments are the raw patch text; the rest are objects.
    const input = typeof d.arguments === 'string' && d.toolName === 'apply_patch'
      ? { file_path: [...d.arguments.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((x) => x[1]).join(', ') || undefined, content: d.arguments }
      : d.arguments;
    yield { k: 'tool', id: d.toolCallId, name, input: toolInput(name, input) };
  } else if (m.type === 'tool.execution_complete') {
    const exit = d.shellExecution?.exitCode ?? null;
    const r = d.result || {};
    const out = outputText(r.content).trim() ? r.content : outputText(r.detailedContent).trim() ? r.detailedContent : d.error?.message ?? d.error ?? '';
    yield toolResult(d.toolCallId, out, d.success === false || (exit != null && exit !== 0), exit);
  } else if (m.type === 'result') yield { k: 'result', usage: m.usage || {} };
  else if (m.type === 'error' && COPILOT_LIMIT_RE.test(copilotErrorText(m))) yield { k: 'limit', resetsAt: null };
}
async function runCopilot({ model, prompt, cwd, resume, systemAppend, signal, onEvent, onMessage, bin, env = process.env, autonomous = true }) {
  const res = { outcome: 'error', text: '', sessionId: resume || null, usage: {}, numTurns: 0, resetsAt: null,
    limitType: null, stderr: '', errorCode: null, windows: null };
  // Copilot settings can select a custom (BYOK) provider regardless of the env. Never run that billing path.
  for (const file of [path.join(HOME, '.copilot/settings.json'), path.join(cwd, '.copilot/settings.json')]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cfg.provider || cfg.providers || cfg.modelProvider || cfg.customProvider) {
        res.outcome = 'auth_error'; res.errorCode = 'authentication_failed';
        res.text = `${file} configures a custom provider; Copilot requires the GitHub subscription.`;
        return res;
      }
    } catch (e) { if (e.code !== 'ENOENT') { res.text = `Could not inspect ${file}: ${e.message}`; return res; } }
  }
  const args = ['-C', cwd, '-p', systemAppend ? `${systemAppend}\n\n${prompt}` : prompt, '--output-format', 'json', '--no-ask-user'];
  if (model) args.push('--model', model);
  if (resume) args.push(`--resume=${resume}`);
  if (autonomous) args.push('--allow-all');
  let failure = null, terminal = null;
  const handle = (m) => {
    if (m.type === 'error') failure = m;
    if (m.type === 'result') { terminal = m; res.sessionId = m.sessionId || res.sessionId; res.usage = m.usage || {}; res.numTurns++; }
    for (const e of copilotEvents(m)) {
      if (e.k === 'text') res.text = e.text;
      if (onEvent) { try { onEvent(e); } catch {} }
    }
    try { onMessage?.(m); } catch {}
  };
  const cleanEnv = { ...stripEnv(env, COPILOT.envFilter), COPILOT_HOME: path.join(HOME, '.copilot') };
  const { aborted, exitCode } = await spawnJsonl({ bin: bin || COPILOT.bin, args, cwd, env: cleanEnv, signal, res, handle });
  if (aborted) { res.outcome = 'aborted'; return res; }
  const message = copilotErrorText(failure) || copilotErrorText(terminal?.error) || res.stderr.trim();
  if (exitCode === 0 && terminal?.exitCode === 0 && !failure) { res.outcome = 'ok'; return res; }
  if (!res.text) res.text = message;
  if (failure && COPILOT_LIMIT_RE.test(copilotErrorText(failure))) {
    res.outcome = 'rate_limited'; res.errorCode = 'rate_limit';
  } else if (COPILOT_AUTH_RE.test(message)) { res.outcome = 'auth_error'; res.errorCode = 'authentication_failed'; }
  else if (resume && COPILOT_NO_SESSION_RE.test(message)) res.errorCode = 'no_session';
  return res;
}
// 'auto' alone is a legitimate state (task #187: this account's entitlement lists nothing else), not an error.
export const COPILOT_AUTO_LABEL = 'Auto (Copilot picks the model)';
export function copilotModels(rows) {
  if (!Array.isArray(rows)) throw new Error('Copilot returned no model list');
  return rows.filter((m) => m?.id && !String(m.id).includes('/'))
    .map((m) => (m.id === 'auto' ? { id: 'auto', label: COPILOT_AUTO_LABEL, default: true } : { id: m.id, label: m.name || m.id }));
}
// The Copilot user record (account.getCurrentAuth → authInfo.copilotUser) → one window per limited quota
// ('premium' = premium_interactions), reset at quota_reset_date_utc. account.getQuota's resetDate is the snapshot
// time, not the reset, so it isn't used. Unlimited quotas (chat, completions on paid plans) aren't limits.
export function copilotWindows(user) {
  const resetsAt = toEpochSec(user?.quota_reset_date_utc || user?.quota_reset_date);
  return Object.entries(user?.quota_snapshots || {}).filter(([, q]) => q && !q.unlimited && Number.isFinite(q.percent_remaining))
    .map(([k, q]) => ({ window: k === 'premium_interactions' ? 'premium' : k, pct: Math.round((100 - q.percent_remaining) * 100) / 100, resetsAt }));
}
const COPILOT = {
  id: 'copilot', label: 'GitHub Copilot CLI', bin: 'copilot',
  available() { return onPath(this.bin); },
  loggedIn() { return cachedLogin(this, () => {
    const r = runHelperSync('gh', ['auth', 'status'], { env: stripEnv(process.env, this.envFilter) });
    return r.status === 0;
  }); },
  account() {
    if (!this.loggedIn()) return null;
    const r = runHelperSync('gh', ['api', 'user', '--jq', '.login'], { env: stripEnv(process.env, this.envFilter) });
    return r.status === 0 ? r.stdout.trim() || null : null;
  },
  login: 'Connect from the sidebar',
  // One SDK session over stdio: fn(client) runs after start and a signed-in check (which also names the account).
  // The SDK spawns the CLI in our process group, so it runs under setsid (same pid, its own group) as a tracked helper.
  async withClient({ bin, env = process.env, timeoutMs = 20_000, clientFactory } = {}, fn) {
    const cleanEnv = { ...stripEnv(env, this.envFilter), COPILOT_HOME: path.join(HOME, '.copilot') };
    const cli = clientFactory ? null : bin || execFileSync('which', [this.bin], { env: cleanEnv, encoding: 'utf8' }).trim();
    const client = clientFactory ? clientFactory() : new CopilotClient({ connection: fs.existsSync('/usr/bin/setsid')
      ? RuntimeConnection.forStdio({ path: '/usr/bin/setsid', args: [cli], env: cleanEnv }) : RuntimeConnection.forStdio({ path: cli, env: cleanEnv }) });
    let untrack = () => {};
    try {
      await withTimeout(client.start(), timeoutMs, 'copilot');
      if (client.cliProcess?.pid) untrack = trackGroup(client.cliProcess.pid);
      const auth = client.getAuthStatus ? await withTimeout(client.getAuthStatus(), timeoutMs, 'copilot auth') : null;
      if (auth?.isAuthenticated === false) throw new Error(auth.statusMessage || 'Copilot is not signed in');
      if (auth?.login) this.identity = auth.login;
      return await fn(client);
    } finally {
      const pid = client.cliProcess?.pid;
      await withTimeout(Promise.resolve(client.stop()), 5000, 'copilot stop').catch(() => client.forceStop?.().catch(() => {}));
      if (pid) killGroup(pid);
      untrack();
    }
  },
  listModels(opts = {}) { return this.withClient(opts, async (c) => copilotModels(await withTimeout(c.listModels(), opts.timeoutMs || 20_000, 'copilot models'))); },
  limitSource: 'Copilot SDK account quota_snapshots',
  limits(opts = {}) {
    return this.withClient(opts, async (c) => {
      const user = (await withTimeout(c.rpc.account.getCurrentAuth(), opts.timeoutMs || 20_000, 'copilot quota'))?.authInfo?.copilotUser;
      if (!user?.quota_snapshots) throw new Error('Copilot reported no quota');
      return { windows: copilotWindows(user) };
    });
  },
  envFilter: /^(?:COPILOT_(?:GITHUB_TOKEN|PROVIDER_.*|HOME)|GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY)$/,
  events: copilotEvents, run: runCopilot,
};

// ---------------------------------------------------------------- model discovery

// Each CLI's models as {id, label, description?, default?} (claude adds `resolved`, the full id an alias maps to).
// SDK ModelInfo rows; the 'default' row isn't a model, it marks the alias it resolves to as the default.
export function claudeModels(list) {
  const rows = Array.isArray(list) ? list.filter((m) => m?.value) : [];
  const def = rows.find((m) => m.value === 'default');
  const models = rows.filter((m) => m.value !== 'default').map((m) => ({ id: m.value, label: m.displayName || m.value,
    ...(m.description && { description: m.description }), ...(m.resolvedModel && m.resolvedModel !== m.value && { resolved: m.resolvedModel }) }));
  const d = def && models.find((m) => (m.resolved || m.id) === (def.resolvedModel || def.value));
  if (d) d.default = true;
  return models;
}
// `codex debug models` JSON (a `models` array of {slug, display_name, description, visibility, priority}), in priority order.
export function codexModels(j) {
  return (Array.isArray(j?.models) ? j.models : []).filter((m) => m?.slug && m.visibility !== 'hide')
    .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9))
    .map((m) => ({ id: m.slug, label: m.display_name || m.slug, ...(m.description && { description: m.description }) }));
}
// `agy models` stdout: `<id>\t<display name>` per line.
export function agyModels(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const [id, label] = line.trim().split('\t').map((x) => x?.trim());
    if (id && /^[\w.:/-]+$/.test(id) && (label || !/\s/.test(line.trim()))) out.push({ id, label: label || id });
  }
  return out;
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
  if (!a.freeTier && !a.loggedIn()) return none('not signed in', at);
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

export const AGENTS = { claude: CLAUDE, codex: CODEX, antigravity: ANTIGRAVITY, opencode: OPENCODE, kiro: KIRO, copilot: COPILOT };

// Runs one turn on `agent` (default 'claude'). Returns at least {outcome, text, sessionId, usage, resetsAt, errorCode};
// outcome is ok | aborted | rate_limited | auth_error | max_turns | error.
// opts.onSpawn({pid, pgid}) is called for every agent CLI process spawned (not the Claude SDK's own child: see resources.mjs).
// An ok run without a final reply keeps the last assistant text; if there was none but tools ran, it gets a synthesized
// summary of them (marked as such, and emitted as a text event); a run with neither is an error, not a success.
export function runAgentCli(opts) {
  const a = AGENTS[opts.agent || 'claude'];
  if (!a) throw new Error(`unknown agent: ${opts.agent}`);
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
