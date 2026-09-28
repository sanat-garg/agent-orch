// What running one task needs on any node, shared by the controller's orchestrator (orchestrator.mjs) and a worker
// (worker.mjs), so a worker never loads the orchestrator (planner, reflection, scheduler): the done-when check
// (extractCommand → runCheck) and a tool call in one line (toolLine). No deps beyond node built-ins.
import { spawn } from 'node:child_process';

// "Edit · src/app.js": a tool call in one line (lane activity, handoff prompts, a worker's progress hints).
export const toolLine = (e) => {
  const input = e.input || {};
  const detail = input.command || input.file_path || input.pattern || input.url || input.query || input.path || input.description || '';
  return `${e.name || 'Tool'} · ${String(detail).replace(/\s+/g, ' ').slice(0, 240)}`;
};

// Only ever returns a command when the done_when text clearly names one; anything ambiguous or
// risky returns null, because a false positive means running something unattended.
const RUNNERS = ['python3', 'python', 'pytest', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'make', 'cargo', 'go', 'uv', 'bun', 'deno', './'];
// A single-backtick snippet counts as a command only if it starts like one; `server.mjs` or `loggedIn` don't.
const CMD_START = /^(!|test\s|\[\s|grep\b|node\b|npm\b|bash\b|sh\s|curl\b|python)/;
const looksLikeCommand = (s) => RUNNERS.some((r) => s.startsWith(r)) || CMD_START.test(s);
// The command with its quoted and backslash-escaped text blanked out, leaving only what the shell parses as operators.
const unquoted = (s) => s.replace(/'[^']*'|"(?:\\.|[^"\\])*"|\\./g, '_');
export function extractCommand(doneWhen) {
  if (!doneWhen) return null;
  const triple = doneWhen.match(/```(?:\w+\n)?([\s\S]*?)```/);
  if (triple) return checkCommand(triple[1], doneWhen);
  // A backslash-escaped backtick (\`) stays inside the snippet: it's a literal backtick for the shell.
  const singles = [...doneWhen.matchAll(/`((?:\\.|[^`\\\n])+)`/g)].map((m) => m[1].trim().replace(/^\$\s+/, '')).filter(looksLikeCommand);
  if (singles.length) {
    // Every command-like snippet must be safe; dropping one silently would weaken the check.
    const cmds = singles.map((c) => checkCommand(c, doneWhen));
    if (cmds.some((c) => !c)) return null;
    return cmds.length === 1 ? cmds[0] : cmds.map((c) => (/;/.test(c) ? `{ ${c}; }` : c)).join(' && ');
  }
  if (/`/.test(doneWhen)) return null;
  for (let line of doneWhen.split('\n')) {
    line = line.trim().replace(/^\$\s+/, '');
    if (RUNNERS.some((r) => line.startsWith(r))) return checkCommand(line, doneWhen);
  }
  return null;
}

function checkCommand(cand, doneWhen) {
  cand = cand.trim().replace(/^\$\s+/, '');
  if (!cand || />|\brm\s|\bsudo\b|\bgit\s+push\b|\bcurl\b/.test(cand)) return null;
  if ((cand.match(/;/g) || []).length + (cand.match(/&&/g) || []).length > 1) return null;
  if (!RUNNERS.some((r) => cand.startsWith(r)) && !/^(test|ls|grep|cat|git|!|\[|bash|sh)(\s|\b)/.test(cand)) return null;
  // "`grep …` prints nothing": grep exits 1 when clean, so pass only on exit 1 (matches → 0, errors → 2 still fail).
  // Only a lone grep: after a pipe or a list $? is another command's, but a | ; & in its quoted pattern is just regex
  // (`grep -n 'cat <<.*|' x.sh` used to stay as written and fail the check when clean).
  if (/^grep\b/.test(cand) && !/[;&|]/.test(unquoted(cand))) {
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
