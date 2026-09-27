// Which role this machine plays in the cluster (BRIEF goal 11; .agent-orch/CLUSTER.md, Compute-only workers). A paired
// worker (its home holds config.json) is compute-only: it never runs the head, i.e. server.mjs with the UI, chat,
// planner, reflection and orchestrator. server.mjs asks headRefusal() before it touches anything. No deps beyond node
// built-ins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The worker's home: AGENT_ORCH_WORKER_HOME, else ~/.agent-orch-worker. Its config.json is the pairing (worker.mjs pair).
export const workerHome = (env = process.env) => env.AGENT_ORCH_WORKER_HOME || path.join(os.homedir(), '.agent-orch-worker');
// Set by the worker on everything a job runs (its agent and its done-when check): a server.mjs started there is a
// throwaway instance of the project's own code under test (agent-orch's tests, screenshots), not a head.
export const JOB_ENV = 'AGENT_ORCH_WORKER_JOB';
// What only a head's data dir holds: the login password (`node server.mjs set-password`) and the orchestrator DB.
const HEAD_FILES = ['auth.json', path.join('orchestrator', 'agent-orch.db')];

// Why server.mjs must not start on `dataDir`, or null: this machine is a paired worker and the data dir holds no head's
// state (a head that is also paired as a worker keeps running).
export function headRefusal({ dataDir, env = process.env }) {
  const file = path.join(workerHome(env), 'config.json');
  if (env[JOB_ENV] || !fs.existsSync(file) || HEAD_FILES.some((f) => fs.existsSync(path.join(dataDir, f)))) return null;
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const paired = `paired${cfg?.name ? ` as "${cfg.name}"` : ''}${cfg?.controller ? ` with ${cfg.controller}` : ''}`;
  return `agent-orch: not starting. This machine is a worker (${paired}; ${file}) and has no head data in ${dataDir}.\n` +
    'Workers are compute-only: the UI, chat, planner, reflection and orchestrator run only on the head. Run the worker\n' +
    'instead: node worker.mjs run (or its service). To make this machine a head, unpair it first: the worker installer\'s\n' +
    `--uninstall --purge, or delete ${path.dirname(file)}.`;
}
