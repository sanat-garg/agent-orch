# LiveBench delegation ranking (#137)

Passing command (2026-09-26):

`CW_LIVEBENCH_RELEASES_API=http://127.0.0.1:9 node --test test/livebench.test.mjs test/delegate.test.mjs test/delegate-preview.test.mjs`

**19 tests passed, 0 failed, 0 skipped.** Local fixtures/cache only; no provider quota required.

## Ranking policy

| Task category | LiveBench score |
| --- | --- |
| coding | Coding |
| agentic | Agentic Coding |
| scientific | Mean of Mathematics and Data Analysis; both required |
| general | Published global average (mean of available categories) |

Scores remain on LiveBench's 0–100 scale (0.5 means 0.5, not 50). Only fresh, ready LiveBench data with matching release identities is compared. Missing category values do not borrow another category or reweight the remaining category. AA metrics are never read by delegation.

Comparable means at least the starting model's score minus **5 percentage points**. This replaces AA's 95% ratio and two-rank shortcut: a sparse leaderboard must not make a much weaker model comparable. Comparable candidates sort by distance from the starting score, then higher score, then agent/model ID. The tolerance is a routing policy, not a claim of statistical equivalence.

When either model lacks a fresh same-release score (including unavailable/stale data), the candidate is explicitly marked non-benchmark with null score/ratio. Such candidates follow scored comparable models, preferring the already routed agent and then lexical agent/model ID. A scored model below the tolerance is excluded from automatic ranking. Owner-curated lists replace this order entirely, retain availability filtering, and an empty list disables fallback. Preview retains limited entries after usable ones; execution skips them. Pinned chats never automatically delegate; a manual owner choice remains an explicit override.

## Verified coverage

- Category-dependent ranking, missing scientific category, values below one, mismatched release, and conflicting AA fields.
- Preview/execution parity across every task category with exhausted usage, disconnected agents, stale/unavailable data, and a non-LiveBench source.
- Unmatched deterministic ordering; curated/empty overrides; missing catalog models; independent Antigravity usage groups.
- Real scheduler child process: reflection and Auto Delegate tasks execute on the LiveBench winner; pinned/default chats wait; owner order and empty lists persist.
- HTTP preview and manual options share LiveBench ranking. Manual owner selection overrides a pinned model; the explicit starting task route remains intact.
- Chat/reflection saved fallbacks retain validation/order. Changing the unrelated AA connection cannot alter LiveBench preview data.
- Adapter exact identity mapping, official release parsing, malformed refresh rejection and stale cache behavior.

The existing AA key/metrics API remains independent. Delegation score details now render LiveBench category names, release and attribution; unavailable/stale states explain non-benchmark fallback.

Visual check: isolated fixture server on port 3998 (`node .agent-orch/livebench-ranking-fixture.mjs`), captured with `bin/shot.mjs`: `shots/livebench-ranking-before.png`, `shots/livebench-ranking-after.png`, `shots/livebench-ranking-mobile-after.png`. Desktop/mobile images were inspected. No live server restart or commit.

Broader check: `CW_LIVEBENCH_RELEASES_API=http://127.0.0.1:9 npm test` was terminated with SIGTERM (exit 143) after test/suite 132, with no assertion failure reported. It is **not** counted as a passing full suite.

Additional passing command: `CW_LIVEBENCH_RELEASES_API=http://127.0.0.1:9 node --test test/server.test.mjs test/ui-fallbacks.test.mjs` — **19 passed, 0 failed, 0 skipped**, including manual delegation API and browser fallback remove/undo/reorder/add/reset persistence. `git diff --check` also passed.
