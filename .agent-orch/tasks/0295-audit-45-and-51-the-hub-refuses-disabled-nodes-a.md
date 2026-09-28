# Task #295: AUDIT #45 and #51: the hub refuses disabled nodes and shares nothing with them; the worker gate reads only MEDIA_ID_RE screenshot ids

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 08:44  
- files: cluster.mjs, agent-share.mjs, worker.mjs, taskrun.mjs, test/cluster.test.mjs, test/agent-share.test.mjs, .agent-orch/AUDIT.md, .agent-orch/CLUSTER.md

## Prompt

Fix AUDIT.md Round 6 items #45 and #51 (read both first). Two small changes.

#45: cluster.mjs `handleUpgrade` (around line 330) accepts any node row with a valid token, enabled or not, so a node the owner disabled in Machines still connects, and agent-share.mjs `wireAgentShare`/`shareTargets` (around lines 100–116) then send it the head's Claude token, Codex login and, via `sendExt`, extension hashes. Refuse the upgrade for `enabled=0` rows with 403 (use the existing `deny`), close an already-connected socket when the owner disables a node (in `update`, like `revoke` does, with a close code and reason that worker.mjs reports sensibly on reconnect: read how worker.mjs handles 4003), and skip disabled nodes in `syncNode`, `shareTargets` and any `sendExt` fan-out as belt and braces. Update .agent-orch/CLUSTER.md if it describes the upgrade rules.

#51: worker.mjs `openGate` `image(id)` (around line 1046) reads `path.join(dir, 'shots', id)` for any id from a question file or audit line, including `../` paths. Guard it with the same `MEDIA_ID_RE` check approvals.mjs uses: import the regex from a module the compute-only rule allows (see test/compute-only.test.mjs; taskrun.mjs is the shared place; if the regex lives in a module the worker must not import, move it to taskrun.mjs and re-export from where it was) and `return` for any id that fails it.

Tests: in test/cluster.test.mjs add a case that PATCHes a node `enabled:false`, asserts its open socket closes and a fresh upgrade with its token gets 403, and that `shareTargets` no longer lists it (test/agent-share.test.mjs has the helpers). For #51 a unit-level check is enough: export nothing new from worker.mjs; instead assert in the existing worker gate test (test/approval-gate.test.mjs 'cluster frames' or test/cluster-e2e.test.mjs) that an audit line with `"screenshot":"../x"` produces no `image` event, if that fixture is easy to reach; otherwise a static assertion that worker.mjs guards `image` with MEDIA_ID_RE. Mark #45 and #51 **Fixed** in .agent-orch/AUDIT.md.

## Done when

`npm test -- test/cluster.test.mjs test/agent-share.test.mjs test/compute-only.test.mjs` passes and `grep -q 'MEDIA_ID_RE' worker.mjs`

## Result — done (check passed) (2026-09-28 08:56)

AGENT-ORCH-STATUS: done — disabled nodes refused, sign-ins withheld; worker screenshot ids now validated
