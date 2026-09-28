# Task #392: Stats ui: a Why tasks failed card on Overview with a count per reason and the last tasks of each

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 13:14  
- starts after: #391  
- files: public/stats.js, test/ui-stats.test.mjs

## Prompt

public/stats.js (read its header and the `card`, `bars`, `empty` helpers; reuse them, no new CSS classes beyond what stats.css has) gets a 'Why tasks failed' card on the Overview tab, placed after the shipped-tasks card, built from the snapshot's `failures` and `tasks[].why` added by the stats.mjs task (fields: failures [{kind, n, tasks}], tasks[].why {kind, text, task?}). Show one horizontal bar per kind with plain labels (check → 'Done-when check failed', setup → 'Setup failed', blocked → 'Blocked by an unfinished task', gave-up → 'Gave up after several sessions', push → 'Push failed', browser → 'Browser tool failed', cascade → 'Cancelled with a failed prerequisite', cancelled → 'Cancelled', other → 'Other'), the count as the text, and under the bars a compact list of the last three failed/cancelled tasks in the current range and project filter: '#id title' with the `why.text` as a muted sub-line, clicking the row calls the existing task-opening hook the sheet already uses for task ids if there is one (grep stats.js for how task ids are linked elsewhere; otherwise plain text). Respect the range/project filters like the other cards (filter by task.finished). When nothing failed, show `empty('Nothing failed in this range.')`. Insight line at the top of the card: the dominant kind in words, e.g. 'Most failures were blocked prerequisites (4 of 6).' Test in test/ui-stats.test.mjs: extend the desktop seeded test so its DB has one failed task with result 'setup failed: cannot lock ref' and one 'cancelled with #3', then assert the card renders both bars and the list rows, and the phone test still shows nothing sticking out sideways. Run only `npm test -- test/ui-stats.test.mjs`.

## Done when

`npm test -- test/ui-stats.test.mjs`
