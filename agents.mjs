// Pluggable coding-agent layer. Each adapter runs one headless agent turn and reports NORMALISED events:
//   {k:'text',text}  {k:'tool',name,input}  {k:'tool_result',text,isError}  {k:'result',usage}  {k:'limit',resetsAt}
// (adapters may add fields such as a tool id). Adapters: claude (Agent SDK), codex (`codex exec --json`),
// antigravity (`agy -p --output-format stream-json`). Every adapter strips its `envFilter` vars from the env so
// billing stays on the owner's subscription login, never an API key. See .agent-orch/AGENTS.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

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

const CLAUDE = {
  id: 'claude',
  label: 'Claude Code',
  bin: path.join(HOME, '.local/bin/claude'),
  available() { return onPath(this.bin); },
  loggedIn() { return cachedLogin(this, () => fs.existsSync(path.join(HOME, '.claude/.credentials.json'))); },
  login: 'claude, then /login',
  models: ['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  envFilter: /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/,
  events: claudeEvents,
  run: runClaude,
};

// ---------------------------------------------------------------- codex (OpenAI Codex CLI, `codex exec --json`)

const CODEX_LIMIT_RE = /usage limit|usage_limit_reached|usage_not_included|quota_exceeded|\b429\b|rate.?limit/i;
const CODEX_AUTH_RE = /401 Unauthorized|not logged in|missing bearer|please (?:log ?in|sign in)|codex login|token (?:expired|revoked)/i;

// "…Try again at 3:05 PM." / "try again at 2026-09-25T15:05:00Z" -> epoch seconds (null if unparseable).
export function codexResetsAt(msg, now = new Date()) {
  const m = /try again (?:at|after) ([^.()\n]+(?:\.\d+)?)/i.exec(msg || '');
  if (!m) return null;
  let t = Date.parse(m[1].trim());
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

const clip = (t) => (t.length > 6000 ? t.slice(0, 6000) + '\n…' : t);

// Spawns a CLI that prints one JSON object per stdout line and feeds each to `handle`; stderr is kept (last 4k) in
// res.stderr. detached: the CLI gets its own process group, so an abort also kills the commands it spawned. If
// `stopOn` matches stderr, the run is killed too (and `stopped` is true), e.g. a CLI blocking on an auth prompt.
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
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', onAbort);
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
  else if (m.type === 'turn.failed' || m.type === 'error') {
    const msg = m.error?.message || m.message || '';
    if (CODEX_LIMIT_RE.test(msg) && (m.type === 'turn.failed' || /usage limit/i.test(msg))) yield { k: 'limit', resetsAt: codexResetsAt(msg) };
  }
}

// Extra options: bin, env, autonomous (default true: no approvals and no sandbox, like Claude's bypassPermissions;
// false keeps the workspace-write sandbox), onMessage (raw JSONL events). Codex has no system-prompt append flag,
// so systemAppend is prepended to the prompt.
async function runCodex({ model, prompt, cwd, resume, systemAppend, signal, onEvent, bin, env = process.env, autonomous = true, onMessage }) {
  const res = { outcome: 'error', text: '', sessionId: resume || null, usage: {}, numTurns: 0, resetsAt: null, limitType: null, stderr: '', errorCode: null };
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
    else if (m.type === 'error') lastError = m.message || '';
    if (onEvent) for (const e of codexEvents(m, started)) { try { onEvent(e); } catch {} }
    try { onMessage?.(m); } catch {}
  };
  const { aborted, exitCode } = await spawnJsonl({ bin: bin || CODEX.bin, args, cwd, env: stripEnv(env, CODEX.envFilter), signal, res, handle });

  if (aborted) { res.outcome = 'aborted'; return res; }
  const errMsg = failMsg || (!completed ? lastError : '');
  if (completed && !failMsg && exitCode === 0) { res.outcome = 'ok'; return res; }
  const hay = `${errMsg}\n${res.stderr}`;
  if (!res.text) res.text = errMsg || res.stderr.trim();
  if (CODEX_LIMIT_RE.test(errMsg) || (!errMsg && /usage limit/i.test(res.stderr))) {
    res.outcome = 'rate_limited';
    res.errorCode = 'rate_limit';
    res.resetsAt = codexResetsAt(hay);
  } else if (CODEX_AUTH_RE.test(hay)) { res.outcome = 'auth_error'; res.errorCode = 'authentication_failed'; }
  else res.outcome = 'error';
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
  login: 'codex login --device-auth',
  models: ['gpt-5-codex', 'gpt-5'],
  envFilter: /^(OPENAI_(API_KEY|BASE_URL|ORG_ID|ORGANIZATION|PROJECT_ID)|CODEX_(API_KEY|ACCESS_TOKEN|AUTH|HOME)|AZURE_OPENAI_.*)$/,
  events: codexEvents,
  run: runCodex,
};

// ---------------------------------------------------------------- antigravity (Google Antigravity CLI, `agy -p … --output-format stream-json`)

const AGY_LIMIT_RE = /RESOURCE_EXHAUSTED|quota|rate.?limit|\b429\b|exhausted/i;
const AGY_AUTH_RE = /waiting for authentication|sign in|accounts\.google\.com\/o\/oauth2|authorization code|not logged in|unauthenticated|\b401\b/i;
// agy -p doesn't fail when signed out: it prints an OAuth URL on stderr and blocks ~60 s. Kill it on sight.
const AGY_AUTH_PROMPT_RE = /waiting for authentication|paste the authorization code|accounts\.google\.com\/o\/oauth2/i;
const AGY_DONE = new Set(['DONE', 'ERROR', 'FAILED', 'CANCELED', 'CANCELLED', 'INTERRUPTED']);

const snakeKeys = (o = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(), v]));
function agyTool(u) {
  const name = u.tool_name || u.tool_info?.name || 'tool', p = u.tool_info?.parameters || {};
  if (name === 'run_command') return { name: 'Bash', input: { command: p.CommandLine ?? p.command ?? '' } };
  return { name, input: toolInputSummary(name, snakeKeys(p)) };
}

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
  } else if (m.event === 'result' && m.result) {
    yield* flush();
    const r = m.result;
    if (r.status === 'SUCCESS') yield { k: 'result', usage: r.usage || {} };
    else if (AGY_LIMIT_RE.test(r.error || '')) yield { k: 'limit', resetsAt: codexResetsAt(r.error) };
  }
}

// Extra options: bin, env, autonomous (default true: --dangerously-skip-permissions approves every tool, like
// Claude's bypassPermissions; false leaves agy's headless policy), settingsPath (agy's settings.json, checked for
// API-key mode), onMessage (raw NDJSON events). agy has no system-prompt append flag, so systemAppend is prepended.
async function runAntigravity({ model, prompt, cwd, resume, systemAppend, signal, onEvent, bin, env = process.env, autonomous = true, onMessage,
  settingsPath = path.join(HOME, '.gemini/antigravity-cli/settings.json') }) {
  const res = { outcome: 'error', text: '', sessionId: resume || null, usage: {}, numTurns: 0, resetsAt: null, limitType: null, stderr: '', errorCode: null };
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
  if (result?.status === 'SUCCESS' && exitCode === 0 && !stopped) {
    if (result.response) res.text = result.response;
    res.outcome = 'ok';
    return res;
  }
  const errMsg = result?.error || (result ? `agy ended with status ${result.status}` : '');
  const hay = `${errMsg}\n${res.stderr}`;
  if (!res.text || result?.status !== 'SUCCESS') res.text = errMsg || res.stderr.trim();
  if (stopped || AGY_AUTH_RE.test(hay) && !AGY_LIMIT_RE.test(errMsg)) { res.outcome = 'auth_error'; res.errorCode = 'authentication_failed'; }
  else if (AGY_LIMIT_RE.test(hay)) { res.outcome = 'rate_limited'; res.errorCode = 'rate_limit'; res.resetsAt = codexResetsAt(hay); }
  else res.outcome = 'error';
  return res;
}

const ANTIGRAVITY = {
  id: 'antigravity',
  label: 'Antigravity CLI',
  bin: path.join(HOME, '.local/bin/agy'),
  available() { return onPath(this.bin); },
  // With no keyring on this VM agy keeps its OAuth token in a file under ~/.gemini/antigravity-cli/ (see
  // .agent-orch/AGENTS.md; the exact name is unconfirmed), so look for a token/credential file there.
  credsDir: path.join(HOME, '.gemini/antigravity-cli'),
  loggedIn() {
    return cachedLogin(this, () => fs.readdirSync(this.credsDir, { withFileTypes: true })
      .some((f) => f.isFile() && /token|cred|oauth/i.test(f.name) && fs.statSync(path.join(this.credsDir, f.name)).size > 0));
  },
  login: 'agy (once, interactively)',
  models: ['gemini-3.8-flash-high'],
  envFilter: /^(GEMINI_API_KEY|GOOGLE_(API_KEY|GEMINI_BASE_URL|GENAI_USE_VERTEXAI|GENAI_USE_ENTERPRISE|GENAI_USE_GCA|APPLICATION_CREDENTIALS|CLOUD_PROJECT(_ID)?|CLOUD_LOCATION)|AGY_(ADC_AUTH|BUSINESS_PAYGO_TIER))$/,
  events: agyEvents,
  run: runAntigravity,
};

export const AGENTS = { claude: CLAUDE, codex: CODEX, antigravity: ANTIGRAVITY };

// Runs one turn on `agent` (default 'claude'). Returns at least {outcome, text, sessionId, usage, resetsAt, errorCode};
// outcome is ok | aborted | rate_limited | auth_error | max_turns | error.
export function runAgentCli(opts) {
  const a = AGENTS[opts.agent || 'claude'];
  if (!a) throw new Error(`unknown agent: ${opts.agent}`);
  return a.run(opts);
}
