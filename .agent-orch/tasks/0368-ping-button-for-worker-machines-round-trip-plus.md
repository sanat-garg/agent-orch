# Task #368: Ping button for worker machines: round-trip plus an on-Mac network self-check

- kind: work  
- source: planner  
- priority: 85 (urgent)  
- created: 2026-09-28 12:52  
- files: cluster.mjs, cluster-protocol.mjs, worker.mjs, server.mjs, public/app.js, test/cluster-ping*.test.mjs

## Prompt

Add a 'Ping' button per machine in the Machines view (public/app.js; one per node card, plus 'Ping all' in the section header). 1) For a CONNECTED node: the head sends a cluster message ping {id, sentAt} (add it to cluster-protocol.mjs with a validator and a feature flag, so older workers that don't support it show 'update the worker to ping') over the existing socket, and the worker (worker.mjs) answers pong {id, diag} after running a quick self-check (in parallel, 5 s budget each): a DNS lookup of the head's hostname via the system resolver (the result IPs or the error code, e.g. ENOTFOUND/EAI_AGAIN, plus its duration), an HTTPS GET of the head's /api/health (or another cheap unauthenticated endpoint; add one if missing) with its status and timing, git reachability of the head's git endpoint (`git ls-remote` with a timeout, if #345's head-git is configured), a GitHub HTTPS HEAD request, and the worker's current reconnect/backoff state and last network error. POST /api/cluster/nodes/:id/ping (login-protected) returns {rtt, diag} or times out after 8 s with 'no answer'. The UI shows the result inline under the node: 'Ping 84 ms · DNS ok (129.154.229.134, 12 ms) · head HTTPS 200 (140 ms) · GitHub ok', with failures in red and plain-language hints (e.g. 'DNS lookup of the head failed on this Mac: its router or ISP can't resolve sslip.io. The worker falls back to the IP once #359 lands; or set the Mac's DNS to 1.1.1.1'). 2) For a DISCONNECTED node, the button says 'Not connected': show its last seen time, the recorded drop reason and 24 h drop counts (from #360's away data), and a copyable one-liner the owner can run on that Mac to test it (for example `curl -sS -o /dev/null -w '%{http_code} %{time_total}s\n' https://129-154-229-134.sslip.io/api/health; dscacheutil -q host -a name 129-154-229-134.sslip.io`, built from the real head URL). 3) Log each ping result as a node event so patterns show over time. Tests: a ping round-trip through a fake worker returning diag; a timeout gives 'no answer'; the DNS failure diag produces the hint text; a disconnected node returns its last-seen info and the one-liner. Run only the touched test files.

## Done when

`node --test test/cluster-ping*.test.mjs` passes (round-trip with diag, timeout, DNS-failure hint, disconnected node info), and the Machines view renders a Ping button per node
