# Task #136: Add cached LiveBench scores for delegation

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 20:49

## Prompt

Replace the planned reliance on Artificial Analysis with LiveBench, as explicitly requested by the owner. Read repository instructions and .agent-orch/BRIEF.md and CONTEXT.md; inspect the metrics integration from #108/#132. Starting at https://github.com/livebench/livebench and its official leaderboard https://livebench.ai, identify and verify the official published results source. The repository is an evaluation framework; do not run benchmarks or mistake question datasets for model scores. Implement a small results adapter using a verified official export/feed, recording source URL, benchmark release, model identity/configuration, category scores and fetch time. Do not invent an API endpoint. Validate parsed scores, cache successful results, retain last-known-good data on refresh failure and expose stale/unavailable states. Map installed model IDs only through verified exact identities or explicit aliases; never borrow scores from another version or reasoning configuration. Add fixture-based parser/cache checks and perform one real fetch. Refresh BRIEF.md with the LiveBench replacement decision and CONTEXT.md with the source contract, mapping and refresh policy. Record the real-fetch evidence and passing check command in .agent-orch/LIVEBENCH-DATA-CHECK.md. If no usable official results source exists, document the concrete blocker rather than fabricate data.

## Done when

.agent-orch/LIVEBENCH-DATA-CHECK.md records a successful fetch from a verified official results source and passing parser/cache checks covering valid scores, malformed responses and retained stale data.

## Result — done (2026-09-25 23:26)

AGENT-ORCH-STATUS: done — LiveBench adapter fetches official livebench.ai results; tests pass
