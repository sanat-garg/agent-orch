# Task #265: Cluster: auto-undrain a worker once the low disk that drained it has recovered

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-28 04:54  
- files: cluster.mjs, test/cluster-health.test.mjs, .agent-orch/CLUSTER.md, .agent-orch/CONTEXT.md

## Prompt

cluster.mjs checkHealth() auto-drains a worker when its resources frame reports under HEALTH.diskMinBytes (2 GB) free, setting drain_reason/drained_at; only the owner can undrain (nodes.draining=0, health_ack). Today the owner's Mac is stuck draining although its disk is back to 3-4 GB free. Add the reverse rule: on each resources frame, if the node is draining with a drain_reason set by the disk rule (mark disk drains distinctly, e.g. store drain_reason starting with 'disk:' or add a small `drain_kind` column via the existing column-migration list) and `res.disk.free >= health.diskMinBytes + health.diskRecoverBytes` (new HEALTH field, 1 GB) for 3 consecutive frames, then clear draining/drain_reason/drained_at, set health_ack = now, log it and send an info notice like `<name> has 3.4 GB free again and takes tasks again`. Never auto-undrain an owner drain (drain_reason NULL) or a lost-connection drain. Keep the existing notice text for the drain itself so test/cluster-health.test.mjs's current assertions still hold; add a test there: drain by low disk, send three recovered frames, assert draining is false, healthAck > 0 and the info notice arrived; also assert an owner drain is not lifted by good disk frames. Document the rule in the HEALTH comment at the top of cluster.mjs and in .agent-orch/CLUSTER.md's health section, and adjust the 'only the owner undrains' sentence in .agent-orch/CONTEXT.md.

## Done when

`node --test test/cluster-health.test.mjs` passes and `grep -n 'diskRecoverBytes' cluster.mjs` prints a match

## Result — done (check passed) (2026-09-28 04:58)

AGENT-ORCH-STATUS: done — Low-disk drains now lift themselves after three recovered frames
