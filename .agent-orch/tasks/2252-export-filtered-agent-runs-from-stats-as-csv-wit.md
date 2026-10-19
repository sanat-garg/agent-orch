# Task #2252: Export filtered agent runs from Stats as CSV, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:17  
- files: public/stats.js, public/stats.css, test/ui-stats-export.test.mjs

## Prompt

Add an Export runs CSV action to the existing Stats controls in public/stats.js, using the already-loaded snapshot and current project/time filters. Follow winfunc/opcode's usage-export idea. Export one row per matching run with project, task ID, agent, recorded model, start/end timestamps, outcome, elapsed seconds within the selected range, and exact input/output/cache token counts. Label token columns as whole-run totals so a partially overlapping run is not misleading; preserve unknown values rather than inventing model names or estimates. Reuse cut/slices/runMs semantics. Generate a client-side Blob download with correct CSV quoting and release its object URL. Disable export while loading or when no runs match, with an explanatory empty state. No API changes or CLI polling. Test downloaded contents against project/range fixtures, quoted fields and an empty selection.

## Done when

`npm test -- test/ui-stats-export.test.mjs` passes.

## Result — done (check passed) (2026-10-19 14:43)

AGENT-ORCH-STATUS: done — Stats exports filtered runs as CSV; export tests pass
