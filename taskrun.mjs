// What running one task needs on any node, shared by the controller's orchestrator (orchestrator.mjs) and a worker
// (worker.mjs), so a worker never loads the orchestrator (planner, reflection, scheduler): the done-when check
// (extractCheck / extractCommand → runCheck) and a tool call in one line (toolLine). No deps beyond node built-ins.
import { spawn } from 'node:child_process';

// "Edit · src/app.js": a tool call in one line (lane activity, handoff prompts, a worker's progress hints).
export const toolLine = (e) => {
  const input = e.input || {};
  const detail = input.command || input.file_path || input.pattern || input.url || input.query || input.path || input.description || '';
  return `${e.name || 'Tool'} · ${String(detail).replace(/\s+/g, ' ').slice(0, 240)}`;
};

// Only ever returns a command when the done_when text clearly names one; anything ambiguous or
// risky returns null, because a false positive means running something unattended.
// A runner is a whole word (`node_modules`, `nodes.json`, `go.mod`, `yarn.lock` aren't), or a ./script.
const RUNNER = /^((python3|python|pytest|npm|npx|pnpm|yarn|node|make|cargo|go|uv|bun|deno)(?=\s|$)|\.\/[\w-])/;
// A single-backtick snippet counts as a command only if it starts like one; `server.mjs` or `loggedIn` don't. cd and
// curl count so that a snippet using them is judged (and refused) rather than silently dropped.
const CMD_START = /^(!|test\s|\[\s|grep\s|bash\s|sh\s|curl\s|cd\s)/;
// `./README.md`, `src/x.mjs`: a path with an extension and no space is a file name, never a command.
const PATH_LIKE = /^[\w.\/~-]+\.[A-Za-z0-9]+$/;
// What may precede the runner: `cd <relative dir without ..> && `, then env assignments (`CI=1 TMPDIR=/x `).
const CD_PREFIX = /^cd\s+(?![/~])(?![\w./-]*\.\.)[\w./-]+\s*&&\s*/;
const ENV_PREFIX = /^([A-Za-z_]\w*=[\w.,:/@%+-]*\s+)+/;
const stripPrefix = (s) => s.replace(CD_PREFIX, '').replace(ENV_PREFIX, '');
const looksLikeCommand = (s) => !PATH_LIKE.test(s) && (RUNNER.test(stripPrefix(s)) || CMD_START.test(stripPrefix(s)));
// A redirect of stderr only (`2>&1`, `2>/dev/null`) is harmless; any other > still refuses the check.
const STDERR_REDIRECT = /(^|\s)2>(&1|\/dev\/null)(?=\s|$|\|)/g;
// The command with its quoted and backslash-escaped text blanked out (same length, so positions still line up),
// leaving only what the shell parses as operators.
const unquoted = (s) => s.replace(/'[^']*'|"(?:\\.|[^"\\])*"|\\./g, (m) => '_'.repeat(m.length));
// The command with only single-quoted and backslash-escaped text blanked: bash still expands $( ` ${ inside "…".
const expandable = (s) => s.replace(/'[^']*'|\\.|"((?:\\.|[^"\\])*)"/g, (m, dq) => (dq === undefined ? '_' : dq.replace(/\\./g, '_')));
// Commands that must all pass, as one: a part holding `;` (the grep rewrite) is grouped so && covers it whole.
const joinAll = (cmds) => (cmds.length === 1 ? cmds[0] : cmds.map((c) => (/;/.test(c) ? `{ ${c}; }` : c)).join(' && '));
// { command, refused }: command is the check to run (null if none); refused lists, verbatim and in order, every
// command-like snippet or fenced-block line that checkCommand rejected, so a refused check isn't mistaken for none.
export function extractCheck(doneWhen) {
  const none = { command: null, refused: [] };
  if (!doneWhen) return none;
  // Every candidate must pass; one refused leaves no command, since dropping it silently would weaken the check.
  const judge = (cands) => {
    const cmds = cands.map((c) => checkCommand(c, doneWhen));
    const refused = cands.filter((c, i) => !cmds[i]);
    return { command: cmds.length && !refused.length ? joinAll(cmds) : null, refused };
  };
  const triple = doneWhen.match(/```(?:\w+\n)?([\s\S]*?)```/);
  if (triple) {
    // bash -c on the whole block would let only its last line decide, so every line must pass (AUDIT #64).
    return judge(triple[1].replace(/\\\n/g, ' ').split('\n').map((l) => l.trim().replace(/^\$\s+/, '')).filter((l) => l && !l.startsWith('#')));
  }
  // A backslash-escaped backtick (\`) stays inside the snippet: it's a literal backtick for the shell.
  const singles = [...doneWhen.matchAll(/`((?:\\.|[^`\\\n])+)`/g)].map((m) => m[1].trim().replace(/^\$\s+/, '')).filter(looksLikeCommand);
  if (singles.length) return judge(singles);
  if (/`/.test(doneWhen)) return none;
  for (let line of doneWhen.split('\n')) {
    line = line.trim().replace(/^\$\s+/, '');
    if (RUNNER.test(line)) return judge([line]);
  }
  return none;
}
export function extractCommand(doneWhen) { return extractCheck(doneWhen).command; }

function checkCommand(cand, doneWhen) {
  cand = cand.trim().replace(/^\$\s+/, '');
  // Risk is judged on what the shell parses, so a quoted pattern (`grep -q 'a -> b' f`, `grep -c 'rm -rf' x.sh`)
  // doesn't void the check; a real redirect or an unquoted rm/sudo/curl/git push still refuses it. Command and process
  // substitution ($(…), backticks, ${…}, <(…), >(…)) is refused wherever it appears, double quotes included, since
  // it could hide any of those; only single-quoted (or backslash-escaped) text is inert. $? still works.
  let bare = unquoted(cand).replace(STDERR_REDIRECT, '$1_');
  if (!cand || />|\brm\s|\bsudo\b|\bgit\s+push\b|\bcurl\b/.test(bare)) return null;
  if (/\$[({]|`|[<>]\(/.test(expandable(cand))) return null;
  if ((bare.match(/;/g) || []).length > 1) return null;
  // `a; b` exits with b's status, so a failing a would pass: split on the bare ; and require every part (AUDIT #64).
  const cut = bare.indexOf(';');
  const parts = cut < 0 ? [cand] : [cand.slice(0, cut).trim(), cand.slice(cut + 1).trim()].filter(Boolean);
  for (const part of parts) {
    if ((unquoted(part).match(/&&/g) || []).length > 3) return null;
    const head = stripPrefix(part);
    if (!RUNNER.test(head) && !/^(test|ls|grep|cat|git|!|\[|bash|sh)(\s|\b)/.test(head)) return null;
  }
  if (parts.length > 1) { cand = parts.join(' && '); bare = unquoted(cand); }
  // "`grep …` prints nothing": grep exits 1 when clean, so pass only on exit 1 (matches → 0, errors → 2 still fail).
  // Only a lone grep: after a pipe or a list $? is another command's, but a | ; & in its quoted pattern is just regex
  // (`grep -n 'cat <<.*|' x.sh` used to stay as written and fail the check when clean).
  if (/^grep\b/.test(cand) && !/[;&|]/.test(bare)) {
    const after = doneWhen.slice(doneWhen.indexOf(cand) + cand.length).replace(/^[`\s]+/, '');
    if (/^(prints|outputs|returns|shows|produces|finds|gives)\s+(nothing|no\s+(output|match|matches|results|hits|lines))\b/i.test(after)) {
      return `${cand}; test $? -eq 1`;
    }
  }
  return cand;
}

// Resolves [ok, output, exitCode]. Runs without a login shell so the caller's PATH (the orchestrator's has its
// `python` → python3 alias) is the one used. Aborting `signal` kills the check's process group; the group is
// also killed when the check exits, so anything it started in the background doesn't outlive it. shell: what runs
// `-c <command>` (a worker's wrapper that execs bash under its local cap: worker-cap.mjs).
export function runCheck(command, cwd, env, timeoutSec, signal, shell = 'bash') {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const child = spawn(shell, ['-c', command], { cwd, env, detached: true });
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const onAbort = () => { killGroup(); finish(false, (out || '') + '\n(aborted)', null); };
    const finish = (ok, text, code) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      resolve([ok, text.slice(-3000), code]);
    };
    const timer = setTimeout(() => { killGroup(); finish(false, (out || '') + '\n(timed out)', null); }, timeoutSec * 1000);
    child.stdout.on('data', (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); });
    child.stderr.on('data', (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); });
    child.on('error', (e) => finish(false, String(e), null));
    child.on('exit', killGroup); // background jobs hold stdout open, so 'close' would wait for them
    child.on('close', (code) => { killGroup(); finish(code === 0, out || (code === 0 ? '(no output)' : `exit ${code}`), code); });
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  });
}
