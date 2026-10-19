# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment

_2026-10-19 (reflect #2275)._ Since #2267 landed: History sheet (#2262), chat export (#2240), dictation (#2236/#2268), seven-day token switch (#2266), file follow-up notes (#2265), bounded chat search (#2264). test/ui-static.test.mjs passes 22/22 (log: reflection-2275-static.log). Nothing visibly broken was found; no full suite or browser run this turn.

Still active, do not repeat: #2269 Queue search, #2270 CSV Quick Look, #2271 Browser recipes, #2272 code-block download, #2273 persona copy, #2274 schedule-output download, #2252 Stats CSV, #2249 project prompts, #2237 command palette.

Free areas this round: commits.js, shots.js, tokens.js + chat-usage.mjs, previews.js, credentials.js, and small localised app.js hunks (composer, title, task drawer). New public files are avoided: every one edits the same server.mjs allowlist line as #2272/#2249.

## Next: nine independent tasks (queued by #2275)

1. **@-mention project files in the composer.** Typing @ suggests files from the existing GET /api/files/find?cid=&q=, beside the slash-command menu (claudecodeui-style).
2. **History: Ask to undo a commit.** Commit detail drafts a `git revert` request into the project chat (never sent, never resets main).
3. **History: search commit messages.** commits.mjs `q` (git log --grep, case-insensitive, fixed-string) + one-line route pass-through + a search field in the History sheet.
4. **Screenshots: attach one to the project chat** through the existing attachment tray (addAttachments).
5. **Token usage: daily bars for the last seven days** (hourly buckets from chat-usage.mjs, grouped into local days in the browser).
6. **Live previews: Copy link and Share** on each live card (navigator.share where available).
7. **Credentials: generate a strong secret** in the field editor.
8. **Browser tab title shows how many actions wait for the owner** (same count as the Home Screen badge).
9. **Task drawer: Follow up on a finished task** drafts a note into the project chat (task-level sibling of #2265's per-file notes).

## Already shipped: project history contract

- GET /api/orch/projects/:id/commits?before=<sha>&limit=<n> returns { branch, commits: [{ sha, subject, author, at, task, add, del, files }], more }; newest first, first-parent, at in epoch ms, task parsed from agent-orch #N: or null.
- GET /api/orch/projects/:id/commit?sha=<sha>&max=<bytes> returns { sha, subject, body, author, at, task, files: [{ path, add, del, binary }], patch, truncated }; malformed sha 400, unknown sha 404.

## Later: feature ideas

- Kanban board view of a project's tasks (vibe-kanban) as a new public file, once the allowlist line is quiet.
- @-mention follow-ups: folders, and chips for mentioned files after #1 lands.
- Select a hunk or line range in task/commit diffs for precise follow-up context.
- Per-turn chat changes from commit events; "Run again" for done tasks via a copy-task endpoint.
- Sync saved project prompts and Browser recipes across devices after #2249/#2271.
- Compare alternative approaches in parallel worktrees (crystal).
- Cross-project schedule agenda using server-supplied next_run_at; human-readable cron preview in the schedule editor.
- Preview inspector: reload and landscape rotation; QR code to open a preview on the phone.
- Usage by project across all chats (opcode usage dashboard).

## Inspiration

Reuse these existing sources; the pattern inventory is not exhausted. Their README pages were re-opened on 2026-10-19 to verify descriptions. Borrow interaction ideas, not code; respect licences.

- [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) → task planning, branch workspaces, inline diff feedback and device previews. Adapt task-management emphasis into queue search; #2265 covers feedback and #2251 inspection. Its current README announces sunsetting, so treat it as interaction research rather than a new dependency.
- [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) → responsive chat, @-file mentions in the composer, file exploration/editing and Git exploration (commit search, revert); its README lists a task-queue plugin with filtering. Adapt these patterns into searchable queued work and practical file/output handling. CSV previews and code downloads are our extensions, not claims about its implementation.
- [winfunc/opcode](https://github.com/winfunc/opcode) → purpose-built agent libraries, checkpoints you can roll back to (→ History undo), execution logs and a usage dashboard with per-day charts (→ daily token bars). Adapt instruction reuse into persona copies and profile-scoped Browser recipes, and log access into schedule-output downloads. #2249/#2252/#2266 cover project prompts and usage/export work.
- [stravu/crystal](https://github.com/stravu/crystal) → previously recorded inspiration for comparing approaches in parallel workspaces; retained for later, not re-researched this turn.
