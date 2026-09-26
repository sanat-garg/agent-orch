# Task #137: Switch delegation ranking from Artificial Analysis to LiveBench

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 20:49  
- starts after: #136

## Prompt

Use the preceding LiveBench adapter as the delegation engine's benchmark source. Read .agent-orch/CONTEXT.md and LIVEBENCH-DATA-CHECK.md; locate ranking, fallback preview and manual delegation paths from #109/#110/#129. Replace Artificial Analysis scoring in these paths, sharing one ranking implementation between preview and execution. Map task categories to the actual available LiveBench categories and document the mapping; use comparable scores from the same benchmark release. Revisit any thresholds tied to Artificial Analysis's scale. Preserve usage-limit filtering, installed-agent eligibility, explicit routes, owner-defined fallback order and the rule that pinned chat models are not automatically delegated. For unscored models or unavailable data, use an explicit deterministic non-benchmark fallback consistent with owner preferences, with no invented score or silent Artificial Analysis fallback. Add focused regression cases for category ranking, exhausted usage, unmatched models, stale/unavailable data and explicit overrides. Update CONTEXT.md and record the passing command in .agent-orch/LIVEBENCH-RANKING-CHECK.md.

## Done when

.agent-orch/LIVEBENCH-RANKING-CHECK.md records a passing regression suite proving preview and execution use LiveBench consistently while respecting availability and owner overrides.

## Result — done (2026-09-26 02:20)

AGENT-ORCH-STATUS: done — LiveBench delegation ranking verified with availability and owner overrides preserved
