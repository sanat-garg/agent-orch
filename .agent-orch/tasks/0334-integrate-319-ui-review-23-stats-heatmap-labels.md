# Task #334: Integrate #319: UI-REVIEW #23: Stats heatmap labels at 11px, a text value per cell, and 14 days on phones with Show all days

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-28 11:46  
- files: public/stats.js, public/stats.css, test/ui-stats.test.mjs, .agent-orch/UI-REVIEW.md

## Prompt

Task #319 ("UI-REVIEW #23: Stats heatmap labels at 11px, a text value per cell, and 14 days on phones with Show all days") finished in its own git worktree, but its branch `agent-orch/task-319` conflicts with `main`, which changed meanwhile (conflicting files: public/stats.css, test/ui-stats.test.mjs). You are in that worktree, and the orchestrator has started merging `main` into it: the conflicted files contain <<<<<<< markers. Resolve every conflict so both main's changes and task #319's intent survive, then verify the result still works. Don't commit, and don't abort the merge.

Task #319's instructions were:

Fix UI-REVIEW.md row 23 (Stats heatmap) in public/stats.js and public/stats.css only (the sheet is built by stats.js; do not touch app.css or index.html, other tasks hold them). Today `.sx-heat-h`, `.sx-heat-row`, `.sx-heat-toth` are 9.5px and `.sx-heat-sum` 8.5px on phones (the `max-width: 600px` block near stats.css line 200), below Apple's 11pt minimum; on 'All' the grid lists every day since the first run so useful rows sit far down; cells carry data by colour only. Change: (1) in the phone block set every heatmap label to ≥ 11px, keeping only the 12 AM / 6 AM / Noon / 6 PM hour ticks; (2) each `.sx-heat-c` gets `aria-label` (and `title` on desktop) with the day, hour and value (reuse the text already in `data-tip`); (3) on phones (`matchMedia('(max-width: 600px)')`) render only the last 14 days, or all days with activity if fewer, plus a `button.sx-heat-more` 'Show all days' that expands the grid (and 'Show fewer' back); desktop unchanged. Extend test/ui-stats.test.mjs (playwright-core, see its 375×667 test): at 375px the heatmap has at most 14 day rows before tapping 'Show all days' and more after, every `.sx-heat-c` has an aria-label, and the computed font-size of `.sx-heat-h` is ≥ 11px. Mark row 23 fixed in place in .agent-orch/UI-REVIEW.md (same style as the other fixed rows).

## Done when

`node --test test/ui-stats.test.mjs` passes and `grep -n 'sx-heat-more' public/stats.js` prints a line

## Result — done (check passed) (2026-09-28 12:36)

I resolved both conflicts and the stats UI tests pass (2/2).

AGENT-ORCH-STATUS: done — Conflicts resolved; phone range chip and heatmap tests both pass
