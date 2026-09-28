# Task #360: Head: tell 'asleep' apart from 'network lost' and show the real reason

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 12:36  
- files: cluster.mjs, public/app.js, test/cluster-away*.test.mjs

## Prompt

cluster.mjs (~line 476) labels every Mac that disconnects without a 'bye' as 'asleep' ('Mac asleep', and orchestrator.mjs ~line 2959 shows tasks 'waiting for <node> (Mac asleep)'), but many drops are network/DNS failures while the Mac is awake. Change it: 1) On a drop without a bye, the node's away reason is 'lost' ('Connection lost') for every OS, and it's upgraded to 'asleep' only when the worker reports on reconnect that it slept (its hello.reconnect.reason === 'sleep' or msg.sleptMs, which already exists at ~line 438), recorded after the fact in the node's history. 2) When the worker reports reconnect.reason 'dns' or 'network', record and show it: 'Reconnected after 3 min: DNS lookup of the head failed', etc. Keep a per-node counter of drops by reason over 24 h. 3) The grace period before reassigning a node's running tasks stays per the failover rules, but the waiting text says 'waiting for <node> (connection lost)' unless it's known to be asleep. 4) The Machines view shows the reason and the 24 h drop counts under each node, e.g. 'Connection drops today: 4 (DNS 3, sleep 1)'. The contract with the worker (the other task implements it): hello may include {reconnect: {reason: 'dns'|'network'|'sleep', since, lastError}}, and older workers without it are still handled. Tests: a drop without bye → 'lost'; a reconnect with reason 'sleep' → recorded as asleep; reason 'dns' is counted and displayed; the waiting label follows. Run only the touched test files.

## Done when

`node --test test/cluster-away*.test.mjs` passes (lost by default, sleep only when reported, dns counted), and `! grep -n "row.os === 'darwin' ? 'asleep'" cluster.mjs`
