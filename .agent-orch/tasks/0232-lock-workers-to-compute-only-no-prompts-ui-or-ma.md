# Task #232: Lock workers to compute-only: no prompts, UI or management on worker machines

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-27 12:48  
- starts after: #218  
- files: worker.mjs, server.mjs, cluster.mjs, test/worker-lockdown*.test.mjs

## Prompt

Enforce BRIEF goal 11's compute-only rule for worker machines. 1) worker.mjs never starts server.mjs, the orchestrator, the planner, reflection, chat runtimes or the login UI. Guard it: if `node server.mjs` is launched on a machine configured as a worker (~/.agent-orch-worker/config.json exists and there's no controller config), refuse to start with a clear message. 2) Protocol allow-list on the worker: it acts only on head-originated job.*, login.* (remote sign-in driven from the head's Connections), models/limits refresh, node.update/drain and log-tail requests, and it rejects and logs anything else (including any 'prompt' or 'chat'-like messages). The head never sends chat/planner work to a worker, only work tasks (not plan or reflect tasks). Add an assertion in the scheduler. 3) No local control surface: the worker opens no listening ports except the read-only status page (the next task) bound to 127.0.0.1, and no local CLI command changes its behaviour except pair/run/status/uninstall. Configuration (slots, power policy, drain) comes only from the head. 4) The installers (bin/install-worker*.sh) install only the worker service: no agent-orch web service, no Caddy, no ttyd. 5) Tests: the worker rejects non-allow-listed messages; the scheduler never places plan/reflect/chat work on a remote node; server.mjs refuses to start in worker mode.

## Done when

`npm test` passes with the worker allow-list, scheduler-placement and server-refuses-in-worker-mode tests
