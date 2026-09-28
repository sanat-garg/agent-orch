# Task #457: Integrate #407: Version format: v<major>.<minor> from the commit count (352 → v3.52)

- kind: work  
- source: planner  
- priority: 60 (normal)  
- created: 2026-09-28 14:56  
- files: version.mjs, server.mjs, public/app.js, test/version*.test.mjs

## Prompt

Task #407 ("Version format: v<major>.<minor> from the commit count (352 → v3.52)") finished in its own git worktree, but its branch `agent-orch/task-407` conflicts with `main`, which changed meanwhile (conflicting files: .agent-orch/CONTEXT.md). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #407's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #407's instructions were:

The owner wants the running build shown like 'version 7.09', not a raw build number. This builds on #406 (version.mjs, /api/version, the About section, the sidebar 'build N' label, workers' builds in Machines). Define the version from the git commit count N = `git rev-list --count HEAD`: major = floor(N / 100), minor = N % 100 as two digits, shown as `v${major}.${minor.padStart(2,'0')}` (e.g. 352 → v3.52, 709 → v7.09, 1000 → v10.00). Add formatVersion(n) in version.mjs and include `version` next to `build` in /api/version (running and disk) and in the workers' info in GET /api/cluster/nodes. Update every UI place from #406 to use it: About 'Running v3.52 (a1b2c3d) · "<subject>"', the pending line 'v3.59 ready (7 newer)', the sidebar footer label 'v3.52', the post-restart toast 'Updated to v3.59', and the worker 'v3.49 · outdated' tags. Keep the sha visible in About for exactness. Set package.json's "version" field to the same value at build time? No: leave package.json alone, and note in version.mjs that the displayed version is derived. Tests: formatVersion(352) === 'v3.52', 709 → 'v7.09', 5 → 'v0.05', 1000 → 'v10.00'; /api/version includes version; the About section renders 'v'. Run only the touched test files.

## Done when

`node --test test/version*.test.mjs` passes including the formatVersion cases (352→v3.52, 709→v7.09, 5→v0.05, 1000→v10.00), and the About section and sidebar show the v-format

## Result — done (check passed) (2026-09-28 14:57)

I resolved the CONTEXT.md conflict so it keeps main's `assertChangeable` note and #407's version-format line.

AGENT-ORCH-STATUS: done — Conflict resolved; version tests and UI static tests pass
