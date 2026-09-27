# Task #217: Controller: node registry, pairing tokens and cluster WebSocket hub

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-27 11:58  
- starts after: #216  
- files: cluster.mjs, server.mjs, test/cluster-hub*.test.mjs

## Prompt

Implement the controller side per .agent-orch/CLUSTER.md and cluster-protocol.mjs. 1) cluster.mjs: a node registry in the orchestrator DB (nodes table: id, name, os, arch, token_hash, created_at, last_seen, status online/offline/draining/disabled, inventory JSON, resources JSON, max_slots, enabled). 2) Pairing: POST /api/cluster/pair (login-protected) creates a one-time 8-character code (10 min TTL). The worker exchanges it at POST /api/cluster/claim {code, name, os, arch} for a long-lived node token (store only a hash, and return the token once). DELETE /api/cluster/nodes/:id revokes a node (closes its socket). PATCH sets name, enabled/draining and max_slots. 3) The WebSocket endpoint /api/cluster/ws, authenticated by a bearer token (reject otherwise), handles hello/inventory/resources/heartbeat, marks nodes online/offline (offline after 30 s without a heartbeat), and exposes an in-process API for the scheduler: listNodes(), send(nodeId, msg), onMessage(handler). It must work through the existing Caddy proxy (same origin, wss). Enforce size limits and validation with cluster-protocol validators. 4) The controller registers itself as node 'controller' (local), using resources.mjs for its capacity. 5) GET /api/cluster/nodes for the UI. Tests: pairing and claim, token auth rejection, heartbeat timeout marks offline, revocation closes the socket. Use CW_DATA_DIR=$(mktemp -d) test servers only.

## Done when

`npm test` passes with cluster pairing/auth/heartbeat/revocation tests, and GET /api/cluster/nodes on a test server lists the local 'controller' node
