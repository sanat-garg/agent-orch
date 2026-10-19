# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment

_2026-10-19 (reflect #2267)._ Recent work delivered task diffs, the away digest, Zen mode, activity sorting, retry notes, slash commands, schedule copying, Browser site shortcuts and Skills search. The history backend is present; its UI already has a worker. Next, help owners find queued work, inspect office-work outputs and reuse successful instructions.

Do not repeat active work: #2262 History UI, #2254 Files favourites, #2252 Stats CSV, #2251 preview inspector, #2250 screenshot comparison, #2249 saved project prompts, #2240 chat export, #2237 command palette, #2236 dictation, #2264 recent-message search, #2265 file feedback drafts and #2266 seven-day token usage.

Concrete gaps verified in code:
- Queue's Up next tree has no search; the Machines assignment picker has a separate ready-task search.
- Files Quick Look renders CSV as raw lines; Markdown already has Preview/Source.
- Browser has saved site URLs but no reusable task instructions.
- Markdown supports shell-command click-to-copy but no code-block file download.
- Personas can be created and edited, but variations require manual copying.
- Schedule Output exposes retained run text but has no download action.

Checks: direct runs of test/ui-static.test.mjs (22 tests) and test/cron.test.mjs (7 tests) passed without skips. Logs: reflection-2267-static.log and reflection-2267-cron.log. test/commits.test.mjs failed during fixture setup at spawnSync git EPERM in this sandbox; neither test reached a product assertion. Details: reflection-2267-commits.log; initial combined run: reflection-2267-checks.log. This does not establish a history defect. No full-suite or browser validation was performed. There is no build step.

## Next: six independent tasks

1. **Search Up next by title, task number or declared file.** Confine search to the existing queue section, preserving the digest and machine lanes. Retain necessary ancestor context in filtered results and disable reordering until cleared. Preserve focus through task pushes; show match counts and a clear empty state. Files: public/app.js (Queue helpers/renderQueue only), public/app.css (scoped rules), test/ui-queue-search.test.mjs.
2. **Preview CSV files as tables in Quick Look.** Reuse the bounded raw response and Preview/Source control. Handle quoted commas, escaped quotes and multiline fields, preserve text, cap rendered rows/columns and label partial previews. Malformed CSV offers an understandable Source fallback. Files: public/files.js (Quick Look only), public/files.css (scoped CSV rules), test/ui-files-csv.test.mjs.
3. **Save reusable Browser task instructions per profile.** A browser-local library beside the Browser prompt saves named instructions and inserts editable drafts. Scope by signed-in user, node and identity. The owner still presses Send; preserve the live-only activity panel and approval behavior. This is separate from #2249's project-chat prompt library and depends on none of its code. Files: public/browser.js, public/browser.css, test/ui-browser-recipes.test.mjs.
4. **Download a Markdown code block as a file.** A standalone script adds Download outside each code element in chat and task output. Use exact code text, a conservative language-extension map and .txt fallback. Preserve shell click-to-copy. Files: public/code-download.js, public/code-download.css, public/index.html (asset tags only), server.mjs (static allowlist only), test/ui-code-download.test.mjs.
5. **Copy a persona into an editable new draft.** Copy name, summary and instructions without its id; create only on explicit save. Existing chats keep their current persona. Files: public/ext.js, public/ext.css, test/ui-persona-copy.test.mjs.
6. **Download a schedule run's retained output.** Add Download output using the already-loaded /runs response, with schedule/run identity, time, status and exact retained output. Label running output as a snapshot; do not imply it is the complete lifetime log. Files: public/schedules.js, public/schedules.css, test/ui-schedule-output-download.test.mjs.

All six are background urgency, independently runnable, with no after prerequisites and mutually disjoint file sets. Existing hot-file exceptions stay localized: Queue instead of composer/drawer; Quick Look instead of Files Places; asset tags and static allowlist instead of routes. No integrator is needed in advance. Each task gets a focused interaction test and one obvious empty/error case, including phone sizing. No source code was changed in this reflection.

## Already queued: project history contract

Preserve #2261/#2262's interface:
- GET /api/orch/projects/:id/commits?before=<sha>&limit=<n> returns { branch, commits: [{ sha, subject, author, at, task, add, del, files }], more }; newest first, first-parent, at in epoch ms, task parsed from agent-orch #N: or null.
- GET /api/orch/projects/:id/commit?sha=<sha>&max=<bytes> returns { sha, subject, body, author, at, task, files: [{ path, add, del, binary }], patch, truncated }; malformed sha 400, unknown sha 404. Both retain the project ownership gate.

## Later: feature ideas

- After History lands: owner-submitted revert requests producing new commits, plus history text search. Never reset or rewrite main.
- After file feedback lands: select a hunk or line range for precise follow-up context.
- Per-turn chat changes from hidden commit events once History and task diffs are stable.
- Sync saved project prompts across devices after #2249; Browser recipes can follow later.
- Compare alternative approaches in parallel worktrees after screenshot comparison lands.
- Explicitly paginated deeper-history search with clear coverage if bounded recent search proves insufficient.
- Cross-project schedule agenda using server-supplied next_run_at, without a second cron implementation.

## Inspiration

Reuse these existing sources; the pattern inventory is not exhausted. Their README pages were re-opened on 2026-10-19 to verify descriptions. Borrow interaction ideas, not code; respect licences.

- [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) → task planning, branch workspaces, inline diff feedback and device previews. Adapt task-management emphasis into queue search; #2265 covers feedback and #2251 inspection. Its current README announces sunsetting, so treat it as interaction research rather than a new dependency.
- [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) → responsive chat, file exploration/editing and Git exploration; its README lists a task-queue plugin with filtering. Adapt these patterns into searchable queued work and practical file/output handling. CSV previews and code downloads are our extensions, not claims about its implementation.
- [winfunc/opcode](https://github.com/winfunc/opcode) → purpose-built agent libraries with custom instructions, execution logs and usage reporting. Adapt instruction reuse into persona copies and profile-scoped Browser recipes, and log access into schedule-output downloads. #2249/#2252/#2266 cover project prompts and usage/export work.
- [stravu/crystal](https://github.com/stravu/crystal) → previously recorded inspiration for comparing approaches in parallel workspaces; retained for later, not re-researched this turn.
