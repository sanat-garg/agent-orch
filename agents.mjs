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
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { toolResultImages } from './media.mjs';
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';

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

// Tool input trimmed to the fields the UI shows.
export function toolInputSummary(name, input = {}) {
  const keep = {};
  for (const k of ['command', 'description', 'file_path', 'path', 'pattern', 'url', 'query', 'old_string', 'new_string', 'content', 'todos']) {
    if (input[k] == null) continue;
    keep[k] = typeof input[k] === 'string' && input[k].length > 4000 ? input[k].slice(0, 4000) + '\n…' : input[k];
  }
  return keep;
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
      else if (b.type === 'tool_use') yield { k: 'tool', id: b.id, name: b.name, input: toolInputSummary(b.name, b.input) };
    }
  } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
    for (const b of m.message.content) {
      if (b.type !== 'tool_result') continue;
      let text = typeof b.content === 'string' ? b.content
        : Array.isArray(b.content) ? b.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n') : '';
      const lines = text.split('\n').length;
      if (text.length > 6000) text = text.slice(0, 6000) + '\n…';
      yield { k: 'tool_result', id: b.tool_use_id, text, isError: !!b.is_error, lines };
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
      const r = spawnSync(this.bin, ['auth', 'status', '--json'], { env: stripEnv(process.env, this.envFilter), encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
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
      const q = query({ prompt: idle, options: { cwd: HOME, abortController: ac, pathToClaudeCodeExecutable: bin || this.bin, env: stripEnv(env, this.envFilter) } });
      return claudeModels(await withTimeout(q.supportedModels(), timeoutMs, 'claude'));
    } finally { ac.abort(); }
  },
  envFilter: /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/,
  events: claudeEvents,
  run: runClaude,
};

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
async function spawnJsonl({ bin, args, cwd, env, signal, res, handle, stopOn }) {
  let aborted = false, stopped = false, killTimer;
  const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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

function codexTool(it) {
  switch (it.type) {
    case 'command_execution': return { name: 'Bash', input: { command: it.command } };
    case 'file_change': return { name: 'Edit', input: { file_path: (it.changes || []).map((c) => `${c.kind || 'update'} ${c.path}`).join('\n') } };
    case 'mcp_tool_call': return { name: `mcp__${it.server}__${it.tool}`, input: toolInputSummary(it.tool, it.arguments || {}) };
    case 'web_search': return { name: 'WebSearch', input: { query: it.query } };
    default: return null;
  }
}

// JSONL event -> normalised events. `started` (a Set of item ids) lets a tool be announced once, whether or not
// Codex sent item.started for it.
function* codexEvents(m, started = new Set()) {
  const it = m.item;
  if (m.type === 'item.completed' && it?.type === 'agent_message') {
    if (it.text?.trim()) yield { k: 'text', text: it.text };
  } else if ((m.type === 'item.started' || m.type === 'item.completed') && it && codexTool(it)) {
    if (!started.has(it.id)) { started.add(it.id); yield { k: 'tool', id: it.id, ...codexTool(it) }; }
    if (m.type !== 'item.completed') return;
    let text = '', isError = it.status === 'failed';
    if (it.type === 'command_execution') { text = it.aggregated_output || ''; isError ||= it.exit_code != null && it.exit_code !== 0; }
    else if (it.type === 'file_change') text = (it.changes || []).map((c) => `${c.kind || 'update'} ${c.path}`).join('\n');
    else if (it.type === 'mcp_tool_call') {
      const r = it.result?.content;
      text = Array.isArray(r) ? r.map((c) => c.text || '').join('\n') : it.error?.message || '';
      isError ||= !!it.error;
    }
    yield { k: 'tool_result', id: it.id, text: clip(text), isError, lines: text.split('\n').length };
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
      const r = spawnSync(this.bin, ['login', 'status'], { env: stripEnv(process.env, this.envFilter), encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
      const out = `${r.stdout || ''}\n${r.stderr || ''}`;
      return r.status === 0 && /logged in/i.test(out) && !/not logged in|api key/i.test(out);
    });
  },
  login: 'Connect from the sidebar',
  // `codex debug models` prints the model catalog as JSON (refreshed from the account; hidden models skipped).
  async listModels({ bin, env = process.env, timeoutMs = 30_000 } = {}) {
    const out = await execOut(bin || this.bin, ['debug', 'models'], { env: stripEnv(env, this.envFilter), cwd: HOME, timeout: timeoutMs });
    return codexModels(JSON.parse(out));
  },
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

const snakeKeys = (o = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(), v]));
// agy's native path parameters (view_file AbsolutePath, write_to_file/replace_file_content TargetFile, grep_search
// SearchPath, find_by_name SearchDirectory, list_dir DirectoryPath) -> the file_path/path fields toolInputSummary keeps.
const AGY_PATH_KEYS = { AbsolutePath: 'file_path', TargetFile: 'file_path', FilePath: 'file_path', SearchPath: 'path', SearchDirectory: 'path', DirectoryPath: 'path' };
function agyTool(u) {
  const name = u.tool_name || u.tool_info?.name || 'tool', p = u.tool_info?.parameters || {};
  if (name === 'run_command') return { name: 'Bash', input: { command: p.CommandLine ?? p.command ?? '' } };
  const input = snakeKeys(p);
  for (const [k, to] of Object.entries(AGY_PATH_KEYS)) if (p[k] != null && input[to] == null) input[to] = p[k];
  return { name, input: toolInputSummary(name, input) };
}

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
  : a === 'opencode' ? ['opencode:openai'] : [a]));
// A scope's windows among an agent's: only its group's for antigravity.
export const scopeWindows = (scope, list) => { const g = scopeGroup(scope); return (list || []).filter((w) => !g || (scope.startsWith('opencode:') ? w.window.startsWith(`${g}-`) : windowGroup(w.window) === g)); };

// A plan window's display name ('3p-5h' → 'Third-party · 5-hour'); public/app.js winLabel matches it.
const WIN_NAMES = { '5h': '5-hour', weekly: 'Weekly', five_hour: '5-hour', seven_day: 'Weekly' };
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
      if (!st.started.has(i)) { st.started.add(i); yield { k: 'tool', id: String(i), ...agyTool(u) }; }
      if (!AGY_DONE.has(u.state)) return;
      const ti = u.tool_info || {};
      const out = ti.output ?? ti.error ?? '';
      const text = typeof out === 'string' ? out : JSON.stringify(out);
      yield { k: 'tool_result', id: String(i), text: clip(text), isError: u.state !== 'DONE' || !!ti.error, lines: text.split('\n').length };
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
  const res = { stderr: '' };
  let windows = null;
  const handle = (m) => { if (m.event === 'command_result' && agyUsageData(m)) windows = agyWindows(agyUsageData(m)); };
  await spawnJsonl({ bin: bin || ANTIGRAVITY.bin, args: ['-p', '/usage', '--output-format', 'stream-json', '--print-timeout', '0'], cwd,
    env: stripEnv(env, ANTIGRAVITY.envFilter), signal: AbortSignal.timeout(20_000), res, handle, stopOn: AGY_AUTH_PROMPT_RE });
  return windows?.length ? windows : null;
}

// Extra options: bin, env, autonomous (default true: --dangerously-skip-permissions approves every tool, like
// Claude's bypassPermissions; false leaves agy's headless policy), settingsPath (agy's settings.json, checked for
// API-key mode), onMessage (raw NDJSON events), usageProbe (default true: after an ok or rate-limited run, read the
// plan windows with agyUsage into res.windows). agy has no system-prompt append flag, so systemAppend is prepended.
async function runAntigravity({ model, prompt, cwd, resume, systemAppend, signal, onEvent, bin, env = process.env, autonomous = true, onMessage,
  settingsPath = path.join(HOME, '.gemini/antigravity-cli/settings.json'), usageProbe = true }) {
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
  const st = { text: new Map(), started: new Set() };
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
    return cachedLogin(this, () => agyModelsOk(spawnSync(this.bin, ['models'], { ...this.modelsOpts(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })));
  },
  // The same check, uncached and async (connections.mjs polls it while a sign-in is waiting).
  probe() {
    return new Promise((resolve) => execFile(this.bin, ['models'], this.modelsOpts(), (err, stdout, stderr) =>
      resolve(agyModelsOk({ status: err ? 1 : 0, stdout, stderr }))));
  },
  modelsOpts() { return { env: stripEnv(process.env, this.envFilter), cwd: HOME, timeout: 8000 }; },
  login: 'Connect from the sidebar',
  // `agy models` prints one `<id>\t<display name>` line per model (progress goes to stderr).
  async listModels({ bin, env = process.env, timeoutMs = 20_000 } = {}) {
    return agyModels(await execOut(bin || this.bin, ['models'], { env: stripEnv(env, this.envFilter), cwd: HOME, timeout: timeoutMs }));
  },
  envFilter: /^(GEMINI_API_KEY|GOOGLE_(API_KEY|GEMINI_BASE_URL|GENAI_USE_VERTEXAI|GENAI_USE_ENTERPRISE|GENAI_USE_GCA|APPLICATION_CREDENTIALS|CLOUD_PROJECT(_ID)?|CLOUD_LOCATION)|AGY_(ADC_AUTH|BUSINESS_PAYGO_TIER))$/,
  events: agyEvents,
  run: runAntigravity,
};

// ---------------------------------------------------------------- opencode (OAuth-backed OpenAI provider)

export const opencodeAuthFile = (home = HOME) => path.join(home, '.local/share/opencode/auth.json');
export function opencodeAuth(home = HOME) {
  try {
    const a = JSON.parse(fs.readFileSync(opencodeAuthFile(home), 'utf8'))?.openai;
    return a?.type === 'oauth' && typeof a.refresh === 'string' && a.refresh.length > 0;
  } catch { return false; }
}
export function opencodeModels(out) {
  return [...new Set(String(out).split('\n').map((s) => s.trim()).filter((s) => /^openai\/[\w.-]+$/.test(s)))].map((id) => ({ id, label: id.slice(7) }));
}
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
    if (!st.tools.has(id)) {
      st.tools.add(id);
      const input = { ...(s.input || {}) };
      if (input.filePath != null && input.file_path == null) input.file_path = input.filePath;
      if (input.targetFile != null && input.file_path == null) input.file_path = input.targetFile;
      const name = p.tool === 'bash' ? 'Bash' : p.tool;
      yield { k: 'tool', id, name, input: toolInputSummary(name, input) };
    }
    if (['completed', 'error'].includes(s.status)) {
      const output = s.output ?? s.error ?? '';
      const value = typeof output === 'string' ? output : JSON.stringify(output);
      yield { k: 'tool_result', id, text: clip(value), isError: s.status === 'error', lines: value.split('\n').length };
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
  loggedIn() { return cachedLogin(this, () => opencodeAuth()); },
  // auth.json has provider credentials, but no documented reliable account identity.
  account() { return null; },
  login: 'Connect from the sidebar',
  async listModels({ bin, env = process.env, timeoutMs = 30_000 } = {}) {
    return opencodeModels(await execOut(bin || this.bin, ['models', 'openai'], { env: stripEnv(env, this.envFilter), cwd: HOME, timeout: timeoutMs }));
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
    if (kind === 'tool_call' && !st.tools.has(id)) {
      st.tools.add(id);
      const name = u.title || u.kind || 'Tool';
      yield { k: 'tool', id, name, input: toolInputSummary(name, u.rawInput || {}) };
    }
    if (kind === 'tool_call_update' && ['completed', 'failed'].includes(u.status)) {
      const value = (u.content || []).map((c) => c.text || '').filter(Boolean).join('\n') || u.rawOutput || '';
      const s = typeof value === 'string' ? value : JSON.stringify(value);
      yield { k: 'tool_result', id, text: clip(s), isError: u.status === 'failed', lines: s.split('\n').length };
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
      const r = spawnSync(this.bin, ['whoami', '--format', 'json'], { env: stripEnv(process.env, this.envFilter), encoding: 'utf8', timeout: 5000 });
      const a = r.status === 0 ? kiroAuth(r.stdout) : { ok: false, account: null };
      this.identity = a.account;
      return a.ok;
    });
  },
  account() { return this.loggedIn() ? this.identity : null; },
  login: 'Connect from the sidebar',
  async listModels({ bin, env = process.env, timeoutMs = 20_000 } = {}) {
    return kiroModels(await execOut(bin || this.bin, ['chat', '--list-models', '--format', 'json'], { env: stripEnv(env, this.envFilter), cwd: HOME, timeout: timeoutMs }));
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
    yield { k: 'tool', id: d.toolCallId, name, input: toolInputSummary(name, d.arguments || {}) };
  } else if (m.type === 'tool.execution_complete') {
    const value = d.result?.content ?? d.result?.text ?? d.error ?? '';
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    yield { k: 'tool_result', id: d.toolCallId, text: clip(s), isError: d.success === false, lines: s.split('\n').length };
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
export function copilotModels(rows) {
  if (!Array.isArray(rows)) throw new Error('Copilot returned no model list');
  return rows.filter((m) => m?.id && !String(m.id).includes('/')).map((m) => ({ id: m.id, label: m.name || m.id, ...(m.id === 'auto' && { default: true }) }));
}
const COPILOT = {
  id: 'copilot', label: 'GitHub Copilot CLI', bin: 'copilot',
  available() { return onPath(this.bin); },
  loggedIn() { return cachedLogin(this, () => {
    const r = spawnSync('gh', ['auth', 'status'], { env: stripEnv(process.env, this.envFilter), encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    return r.status === 0;
  }); },
  account() {
    if (!this.loggedIn()) return null;
    const r = spawnSync('gh', ['api', 'user', '--jq', '.login'], { env: stripEnv(process.env, this.envFilter), encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() || null : null;
  },
  login: 'Connect from the sidebar',
  async listModels({ bin, env = process.env, timeoutMs = 20_000, clientFactory } = {}) {
    const cleanEnv = { ...stripEnv(env, this.envFilter), COPILOT_HOME: path.join(HOME, '.copilot') };
    const client = clientFactory ? clientFactory() : new CopilotClient({ connection: RuntimeConnection.forStdio({
      path: bin || execFileSync('which', [this.bin], { env: cleanEnv, encoding: 'utf8' }).trim(), env: cleanEnv,
    }) });
    try { await withTimeout(client.start(), timeoutMs, 'copilot'); return copilotModels(await withTimeout(client.listModels(), timeoutMs, 'copilot models')); }
    finally { await client.stop(); }
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
// stdout of a command; rejects with the last stderr line (or the exec error) when it fails.
const execOut = (bin, args, opts) => new Promise((resolve, reject) => execFile(bin, args, { maxBuffer: 64 << 20, encoding: 'utf8', ...opts },
  (err, stdout, stderr) => (err ? reject(new Error(String(stderr || '').trim().split('\n').pop() || (err.killed ? 'timed out' : err.message))) : resolve(stdout))));

// The discovered model list per agent: {models, error, at}. Filled by models.mjs (cached in <DATA>/models.json);
// empty with an error until then, when discovery fails, or when the agent is signed out.
const catalog = new Map(), NO_MODELS = Object.freeze([]);
const none = (error, at = Date.now()) => ({ models: NO_MODELS, error, at });
export const modelCatalog = (id) => catalog.get(id) || none('loading', null);
export const setModelCatalog = (id, entry) => { catalog.set(id, entry); };
// Every id a model can be named by on this agent (ids plus the full ids aliases resolve to).
export const modelNames = (id) => modelCatalog(id).models.flatMap((m) => (m.resolved ? [m.id, m.resolved] : [m.id]));
// One agent's discovery: {models, error, at}; opts go to its listModels (bin, env, query for tests).
export async function discoverModels(id, opts = {}) {
  const a = AGENTS[id], at = Date.now();
  if (!a) return none('unknown agent', at);
  if (!a.available()) return none('not installed', at);
  if (!a.loggedIn()) return none('not signed in', at);
  try {
    const models = await a.listModels(opts);
    return models.length ? { models, error: null, at } : none('the CLI listed no models', at);
  } catch (e) { return none(String(e?.message || e).split('\n')[0].slice(0, 200) || 'discovery failed', at); }
}

// A resumed run failed because its session is gone (Claude's text, or an adapter's errorCode 'no_session'):
// callers drop the stored session id and retry once fresh.
export const isMissingSession = (res) => res.outcome === 'error' &&
  (res.errorCode === 'no_session' || /no conversation found/i.test(`${res.text || ''}\n${res.stderr || ''}`));

export const AGENTS = { claude: CLAUDE, codex: CODEX, antigravity: ANTIGRAVITY, opencode: OPENCODE, kiro: KIRO, copilot: COPILOT };

// Runs one turn on `agent` (default 'claude'). Returns at least {outcome, text, sessionId, usage, resetsAt, errorCode};
// outcome is ok | aborted | rate_limited | auth_error | max_turns | error.
export function runAgentCli(opts) {
  const a = AGENTS[opts.agent || 'claude'];
  if (!a) throw new Error(`unknown agent: ${opts.agent}`);
  return a.run(opts);
}
