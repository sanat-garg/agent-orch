# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment

_2026-10-19 (reflect #2259)._ The queue is full of the last three reflections' features (#2234–#2258): task diff UI, digest, command palette, dictation, slash commands, retry note, chat export, saved prompts, screenshot compare, preview inspector, Stats CSV, schedule copy, Files favourites, Skills search and Browser shortcuts. Nothing visibly broken surfaced: the last reflection's ui-static fix (#2232) landed and the three recent reflection tasks all passed. Let those finish; don't duplicate them.

The biggest remaining gap against similar tools is **seeing what changed in a project over time**. The owner can see one task's diff (#2233/#2234) and commit counts in Stats, but not a browsable history of commits: chat auto-commits, `agent-orch #N:` task merges and their diffs. That is the next feature, split into a read-only backend and a UI built against the same fixed API contract so both run in parallel.

API contract (both halves use it): `GET /api/orch/projects/:id/commits?before=<sha>&limit=<n>` → `{ branch, commits: [{ sha, subject, author, at, task, add, del, files }], more }` (newest first, first-parent, `at` epoch ms, `task` = N from an `agent-orch #N:` subject or null). `GET /api/orch/projects/:id/commit?sha=<sha>&max=<bytes>` → `{ sha, subject, body, author, at, task, files: [{ path, add, del, binary }], patch, truncated }`; a malformed sha is 400 and an unknown one 404. Query params keep both routes inside server.mjs's `/api/orch/projects/:id/<word>` ownership check.

## Next

1. **Project history backend** (`commits.mjs` + two routes): read-only log and per-commit diff, reusing changes.mjs's numstat/patch-cap approach.
2. **Project history UI** (`public/commits.js`/`.css`): a "History" pill beside Screenshots opening a sheet: commit list with +/- counts, task links, Load older, and a commit view with per-file counts and a coloured diff. Its test stubs the API, so it doesn't wait for (1).
3. **Finish the active queue** (#2234–#2258). No duplicates.

## Later (feature ideas)

- Once both history halves land: "Revert this commit" as a queued agent task (never a direct reset; main is never rewritten), and search commits by text.
- Inline feedback on a task diff that becomes a follow-up instruction, after #2234 lands (vibe-kanban).
- Per-turn chat changes using the hidden commit events and the diff renderer, once the history and task diff views are stable; unify the two diff renderers then.
- Sync saved prompts across devices after #2249's browser-local version proves useful.
- Compare alternative task approaches in parallel worktrees after #2250 shows what comparison UX owners need (crystal).

## Inspiration

The earlier reflection researched these open-source repos. Several useful ideas remain, so this reflection reuses that research instead of searching again. These are design patterns to study, not code to copy; respect each repository's licence.

- [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) → task workspaces, inline diff feedback, embedded previews and device-size inspection. #2234, #2250 and #2251 cover the first visual steps; inline feedback remains open.
- [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) → mobile navigation, file editing, Git explorer and discoverable tools. #2254 and #2255 cover Files and Skills navigation; the read-only Git history is queued by reflection #2259 (its commit list + diff view is the model). Profile-specific Browser shortcuts are a small adaptation of making frequently used destinations easy to reach.
- [winfunc/opcode](https://github.com/winfunc/opcode) → reusable agent instructions and usage reporting. #2249 and #2252 cover saved project prompts and CSV export.
- [stravu/crystal](https://github.com/stravu/crystal) → comparing approaches in parallel workspaces. #2250 begins with comparison of existing screenshots; full alternative-run comparison remains open.
