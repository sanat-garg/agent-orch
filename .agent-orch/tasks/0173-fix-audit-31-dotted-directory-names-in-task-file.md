# Task #173: Fix AUDIT #31: dotted directory names in task files cover their contents

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-26 10:31  
- files: parallel.mjs, test/parallel.test.mjs

## Prompt

Read .agent-orch/AUDIT.md finding #31 (Round 4) first. Bug in parallel.mjs `segs`: a plain path is treated as a directory only if it ends in `/` or its last segment has no `.`, so `filesOverlap(['.agent-orch'], ['.agent-orch/AUDIT.md'])` and `filesOverlap(['test/fixtures.v2'], ['test/fixtures.v2/x.js'])` are false and two tasks editing the same directory run in parallel and conflict. Fix conservatively: any declared path without wildcards also covers `path/**` (a file path like `src/a.mjs` can't have children, so this only costs parallelism in pathological cases). Keep existing behaviour for globs. Add cases to test/parallel.test.mjs: the two AUDIT repros must be true; `filesOverlap(['public'], ['public/app.js'])` stays true; `filesOverlap(['src/a.mjs'], ['src/b.mjs'])` stays false; `filesOverlap(['.agent-orch/ROADMAP.md'], ['.agent-orch/AUDIT.md'])` stays false. Do NOT edit .agent-orch/AUDIT.md.

## Done when

`node --test test/parallel.test.mjs` passes, including a new assertion that filesOverlap(['.agent-orch'], ['.agent-orch/AUDIT.md']) is true.

## Result — done (check passed) (2026-09-26 10:33)

AGENT-ORCH-STATUS: done — Declared paths without wildcards now cover their whole contents
