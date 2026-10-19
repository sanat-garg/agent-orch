# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-10-19 (reflect #2241)._ The existing product already covers multi-project chats, autonomous tasks, file editing,
schedules, credentials, screenshots and token usage. This reflection inspected the actual feature modules, their APIs and
tests. The next useful step is making those capabilities easier to reuse and evaluate: saved prompts, visual comparison,
responsive previews, portable run data, copied schedules, favourite folders and searchable skills.

The previous reflection's work remains reserved: #2234–#2240 cover the task diff UI, activity digest, dictation, command
palette, slash commands, retry notes and chat export. #2230/#2231 cover sidebar activity order and Zen mode. During this
inspection, commits for #2232 (stale UI assertion) and #2233 (task changes API) landed. Do not queue these again. Finish the
reserved diff viewer and digest through their existing tasks; the additions below need neither one.

Checks: direct Node runs passed all 22 ui-static, 7 cron and 5 digest tests, plus 8 pure/empty-data Stats tests. This is a
plain Node application with no build step. Integration checks could not be completed in this session: files-save could
not bind localhost (EPERM), and changes/Stats could not spawn synchronous git (EPERM). The broken-repository changes
fixture was also inconclusive under the temporary directory nested in this checkout. These are not confirmed product
bugs. Logs: `.agent-orch/verify/reflect-2241*.log`. No full-suite or browser-pass claim is made.

## Next (seven independent tasks proposed by #2241)
1. **Saved project prompts:** a small library that saves the current draft and inserts a saved prompt at the cursor.
   Browser-local, scoped by signed-in user and project, clearly labelled; never sends automatically. Implement in a new
   prompts module; the only shared-file changes are script/style registration in index.html and the server allowlist.
2. **Screenshot comparison:** choose two existing project screenshots and view them together, with task/time labels and
   a phone-friendly layout. Reuse the existing gallery and media endpoint; no image processing or new backend.
3. **Responsive preview inspector:** explicitly open an already-configured live preview in an embedded viewport with
   phone/tablet/desktop widths. This checks layout, not full device emulation. Open-in-new-tab remains available if a site
   refuses framing. Never assign an address, deploy, or change proxy configuration.
4. **Export filtered agent runs as CSV:** use Stats' existing snapshot and range/project selection, with exact numeric
   token values and clearly labelled run time. A client-side download; no extra polling or API calls.
5. **Copy a schedule:** prefill a new schedule from an existing one, allow choosing its destination project, preserve its
   timezone and command/prompt, and save the copy paused. Reuse the create API; never copy history or run it implicitly.
6. **Favourite folders in Files:** save the current folder in Places and revisit/remove favourites; scope browser storage
   to the signed-in user and project. Reuse normal navigation and errors for missing folders.
7. **Search Skills & tools:** filter each existing tab's loaded entries by name/description, with source filtering for
   local versus synced skills. Keep editing and read-only synced-skill behaviour intact.

All seven are background work with focused main-path and failure/empty-state tests. They use separate JS/CSS modules and
unique test files, have no prerequisite chains, and avoid app.js, app.css, phone.css and orchestrator.mjs. Only task 1 needs
small server/index registration edits. No integrator is required by design. No domains, services or live data were changed.

## Later (feature ideas)
- Inline comments on a task's diff that queue a follow-up task with the comment, once #2234 lands (vibe-kanban).
- Per-turn "View changes" from hidden chat commit events, reusing the eventual task diff renderer.
- Read-only project Git history with per-commit diffs (claudecodeui). Defer to avoid overlapping Files and server work;
  branch switching/staging require a separate owner decision about interactions with autonomous task merges.
- Saved prompt sync across devices after the browser-local library proves useful; optional variables later.
- Compare alternative task implementations in parallel worktrees (crystal); screenshot comparison is a smaller first step,
  not a claim to implement alternative-run orchestration.
- Owner cancellation notes surfaced in the digest.
- AGENTIC.md files-only office workspace when the owner asks for computer work again.

## Inspiration
Reused the prior reflection's research; it still contains unused ideas, so no new repository search was needed. These are
design inspirations, not claims that the proposed adaptations already exist in those projects. Study patterns, not copied
code; respect each repository's licence. Star counts were removed because they become stale.

- [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) → task workspaces, inline diff feedback, embedded previews
  and device-size inspection. Reserved: task diff UI. New: responsive preview inspector and visual comparison. Still open:
  inline feedback and PR creation with descriptions.
- [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) → mobile file navigation/editing, Git explorer and
  discoverable tools. New adaptations: favourite folders and searchable Skills & tools. Still open: project Git history.
- [winfunc/opcode](https://github.com/winfunc/opcode) → reusable agent instructions and usage reporting/export. New
  adaptations: saved user prompts and filtered run CSV export; existing personas remain system instructions.
- [stravu/crystal](https://github.com/stravu/crystal) → comparing approaches in parallel workspaces. New adaptation:
  comparing existing screenshots. Full alternative-run comparison remains later work.
