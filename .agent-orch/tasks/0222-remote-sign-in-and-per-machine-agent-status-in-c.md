# Task #222: Remote sign-in and per-machine agent status in Connections

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-27 11:58  
- starts after: #219  
- files: connections.mjs, worker.mjs, cluster.mjs, public/app.js, public/app.css, test/cluster-login*.test.mjs

## Prompt

Let the owner sign agents in on worker machines from the web UI. The Connections modal gets a machine switcher (Controller / each node). For a remote node, Connect/Disconnect/model refresh are proxied over the cluster WebSocket as login.start/state/code/cancel messages: the worker runs the same connections.mjs tmux login specs locally (on macOS, check that tmux exists or install it via Homebrew instructions, else fall back to a pty via `script`) and streams the URL, code and prompts back, and the owner pastes codes that get forwarded. Status, account and models per node come from the node's inventory. Show clearly that limits are shared when the same account is signed in on several machines ('Same account as Controller: shares limits'). Tests with a fake worker: the login state round-trip and code forwarding.

## Done when

`npm test` passes with the remote login round-trip test, and the Connections modal renders a machine switcher when nodes exist

## Result — in progress (1) (2026-09-27 14:22)

AGENT-ORCH-STATUS: continue — remote sign-in works; five older test failures on main block `npm test`

## Result — done (check passed) (2026-09-27 14:32)

Full suite running; waiting for its completion notice.
