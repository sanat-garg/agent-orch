# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment

_2026-10-19, reflect #2286._ The most valuable immediate work is already queued: make it easier to give agents context, find completed changes, and reuse successful instructions. Finish those features before expanding the backlog. The supplied scheduler snapshot has 30 ready worker tasks for 16 free slots (target 18); this reflection requests **zero new tasks**. Keep priority 90 and mode build.

Recent shipped foundations include History (#2261/#2262), per-file follow-up drafts (#2265), voice dictation (#2236/#2268), seven-day token totals (#2266), chat export (#2240), screenshot comparison (#2250), preview inspection (#2251), and Stats CSV export (#2252, now done). The command palette is awaiting integration (#2276 for #2237); completing that existing feature takes precedence over a new navigation surface.

Inspected actual implementations in commits.mjs, public/commits.js, chat-usage.mjs, public/tokens.js, public/schedules.js and public/app.js. File follow-up drafts currently target whole files; commit patches are coloured text without hunk selection. Token totals are scoped to a chat and, for the main project chat, its tasks. Schedules already have readable timing, next-run labels, presets and a live cron-preview endpoint: do not queue those again.

Verification: direct Node execution passed all 22 ui-static assertions and all 3 chat-usage tests. Both commits tests failed during fixture setup with `spawnSync git EPERM`, before exercising the feature; this is an execution restriction, not evidence of a History regression. Initial combined output is in reflection-2286-checks.log; detailed assertions and errors are in reflection-2286-detail.log. The normal npm wrapper writes its cache outside .agent-orch/, so these focused checks used Node directly, with temporary fixtures confined to .agent-orch/ and cleaned afterward. No full suite or browser run; no user-blocking defect established. There is no build script or build step.

## Prioritized next steps: existing queue

These are already assigned; do not requeue or change their scope.

1. **Finish navigation and precise requests:** command-palette integration #2276, queue search #2269, @-file mentions #2277, task-level follow-up #2285, screenshot attachments #2280. Together these reduce the work between finding an issue and asking an agent to fix it.
2. **Make completed work useful:** History search #2279 and undo-request drafts #2278; code-block downloads #2272, CSV Quick Look #2270 and retained schedule-output downloads #2274. Undo remains an owner-editable chat request, never an automatic reset.
3. **Reuse work across sessions:** saved project prompts #2249, Browser recipes #2271 and persona copies #2273.
4. **Improve daily visibility and sharing:** daily token bars #2281, owner-action tab count #2284, live-preview link/share #2282 and secret generation #2283.

File ownership is already crowded: public/app.js and app.css (queue/composer/title/drawer), public/commits.js and commits.css plus commits.mjs (History), public/shots.js and shots.css, public/tokens.js and tokens.css plus chat-usage.mjs, public/previews.js and previews.css, public/credentials.js and credentials.css, public/files.js and files.css, public/browser.js and browser.css, public/ext.js and ext.css, public/schedules.js and schedules.css. public/index.html and server.mjs also have queued work for new assets and routes. Preserve each existing task's declared test files. Recheck the actual queue before allocating future files; this is a snapshot, not a permanent reservation.

## Feature ideas: ranked for the next capacity opening

These are candidates, not additional queued work. Check full task history and current code again before scheduling. Each eventual task needs one focused check covering its main path and an obvious failure or empty state; avoid turning a candidate into one large end-to-end task.

1. **Draft a follow-up from one diff hunk.** Extend the existing task Changes feedback with a selected hunk, file path and task identifier in the editable chat draft. This saves copying and makes the requested change unambiguous. Start with task hunks only; commit hunks and arbitrary line ranges are later increments. Reuse #2265 and #2285's draft behavior, preserve existing draft text and explain when truncated/binary patches offer no selectable hunk. Likely files: public/app.js, public/app.css and a focused UI test, after their current work clears. Inspiration: BloopAI/vibe-kanban.
2. **See upcoming automation across projects.** Add an agenda toggle to Schedules, ordering enabled schedules by the existing server-supplied next_run_at and grouping by local date, with project names and links to the existing editor/output. Initially show the next occurrence of each schedule, clearly labelled; do not invent recurring occurrences client-side. Handle no enabled schedules and missing next times. Likely files: public/schedules.js, public/schedules.css and a focused UI test after #2274. This is our extension of existing scheduling, not a feature claim about another repository.
3. **Understand usage across a whole project.** Combine recorded usage from all project chats and tasks, with per-agent/model breakdown and an explicit distinction between measured tokens and estimated subscription percentages. First scope a separately tested aggregation helper; then a small presentation task when that contract exists. Do not poll CLIs or introduce API-dollar billing. This complements #2281 rather than duplicating its daily chart. Inspiration: winfunc/opcode's usage dashboard.
4. **See task progress as a board.** A read-only project board could make blocked, running and completed work easier to scan; reuse task states and the existing drawer. Test actual demand after command palette and queue search land. No drag-to-status actions until transition semantics are deliberately designed. Inspiration: BloopAI/vibe-kanban.

Other useful possibilities, lower priority:
- Sync saved prompts and Browser recipes across devices after their current local implementations land.
- Link each completed chat turn to its recorded commit changes, reusing History instead of adding a separate diff viewer.
- Add reload and landscape orientation to the existing preview inspector; only use owner-configured addresses.
- Extend @ mentions to folders and removable context chips after #2277.
- Compare alternative agent approaches in parallel worktrees (stravu/crystal); this needs smaller separately scoped deliverables before queueing.
- Copy a finished task into an editable rerun draft; distinguish this from already-queued task follow-up and failed-task retry.

## Already shipped: project history contract

- GET /api/orch/projects/:id/commits?before=<sha>&limit=<n> returns { branch, commits: [{ sha, subject, author, at, task, add, del, files }], more }; newest first, first-parent, at in epoch ms, task parsed from agent-orch #N: or null.
- GET /api/orch/projects/:id/commit?sha=<sha>&max=<bytes> returns { sha, subject, body, author, at, task, files: [{ path, add, del, binary }], patch, truncated }; malformed sha 400, unknown sha 404.

## Inspiration

Reuse the previously researched inventory: it still contains unused patterns. Earlier reflection notes record README checks on 2026-10-19; no new external research was needed in #2286. These are interaction references, not dependencies. Borrow ideas, respect licences, and include the relevant repository in any future worker prompt.

- [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) → task planning, branch workspaces, inline diff feedback and device previews. Applied in #2265 file feedback and #2251 preview inspection; queue search #2269 is pending. Remaining ideas: hunk-specific feedback and a task board. The earlier research noted a sunset announcement; do not assume ongoing maintenance.
- [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) → responsive chat, @-file context, file exploration/editing and Git exploration. File mentions #2277 and History search/undo drafts #2279/#2278 are pending. Remaining adaptation: richer folder/file context. CSV previews and code downloads are our extensions, not claims about its implementation.
- [winfunc/opcode](https://github.com/winfunc/opcode) → agent libraries, checkpoints, execution logs and usage dashboards with daily charts. Saved prompts #2249, persona copies #2273, Browser recipes #2271, schedule-output downloads #2274 and daily token bars #2281 apply these patterns. Remaining adaptation: usage across all chats in a project. Our undo action drafts a git revert request, not a checkpoint rollback.
- [stravu/crystal](https://github.com/stravu/crystal) → previously recorded inspiration for comparing approaches in parallel workspaces. Screenshot comparison #2250 is shipped; comparing agent implementations remains a future idea.
