# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment

_2026-10-19 (reflect #2263)._ Task Changes, the away digest, sidebar activity sorting, Zen mode and intake-only Orchestrator Mode exit have landed. History (#2261/#2262), saved prompts, dictation, command palette, slash commands, retry notes, chat export, screenshot comparison, preview inspection, Stats CSV, schedule copying, Files favourites, Skills search and Browser shortcuts already have workers. Do not queue them again.

Focused checks passed: `node --test test/ui-static.test.mjs test/chat-usage.test.mjs test/search.test.mjs` (three files, no failures or skips; log: `.agent-orch/reflection-2263-checks.log`). This was not a full-suite or browser check. There is no build step.

One user-visible problem was reproduced despite green tests: search.mjs scans only the FIRST maxBytes of each chat log (4 MB by default). A recent message beyond that cap is invisible. A small fixture with a 512-byte cap returned zero matches for a complete matching message at the end. Existing tests explicitly preserve the prefix-only behavior; change that expectation with the fix. Keep a bounded scan, prioritizing the newest complete messages; this does not promise exhaustive full-history search.

Two useful additions can build on completed features without waiting for the active queue: attach a file-specific request to a task's Changes view and transfer it into a chat draft; show recent raw token totals rather than making the owner infer recent activity from lifetime totals and weekly percentage estimates. Both reuse existing paths and require no new endpoints.

## Next

1. **Search the newest messages in long chats.** Update search.mjs's bounded scan to read the tail, discard a partial leading JSONL record, and preserve title matching, snippets, ordering and corrupt-line behavior. Prove a recent hit beyond the old prefix cap is found. Files: search.mjs, test/search.test.mjs.
2. **Turn a changed file into a follow-up chat draft.** In the landed task Changes section, offer a compact file note and Add to chat. Include the task number/title, file path and owner's note, target the task project's main chat, and append to any existing draft. The owner sends it normally. Keep note state across drawer refreshes and show a useful message if the target chat is unavailable. Files: public/app.js (Changes section and local helpers only), public/app.css (new scoped rules only), test/ui-diff-feedback.test.mjs. Do not touch retry/delegate controls or the composer send path.
3. **Last 7 days / All time in Token usage.** Add recent totals to chatUsage's existing response and a range selector within tokens.js. Recent totals and model rows cover only the same authorized chat/task references in a rolling seven-day interval. Preserve the lifetime header pill and the separately labelled weekly-limit estimates. Files: chat-usage.mjs, public/tokens.js, public/tokens.css, test/chat-usage.test.mjs, test/ui-token-range.test.mjs. No server changes: its usage route already spreads chatUsage's return value.

All three are independently runnable, with disjoint file declarations and no prerequisites. Use background urgency: the search omission is real but no owner is currently blocked. The only hot-file exception is localized Changes UI work in app.js/app.css. No source code was changed during this reflection.

## Already queued: project history contract

Preserve the contract shared by #2261/#2262:

- `GET /api/orch/projects/:id/commits?before=<sha>&limit=<n>` → `{ branch, commits: [{ sha, subject, author, at, task, add, del, files }], more }`, newest first, first-parent, `at` epoch ms, task parsed from `agent-orch #N:` or null.
- `GET /api/orch/projects/:id/commit?sha=<sha>&max=<bytes>` → `{ sha, subject, body, author, at, task, files: [{ path, add, del, binary }], patch, truncated }`; malformed sha 400, unknown sha 404. Both routes retain the project ownership gate.

## Later: feature ideas

- After history lands: request a commit revert through an owner-submitted agent task that creates a new commit, plus text search within history. Never reset or rewrite main.
- After file feedback proves useful: select a hunk or line range to include precise context in the draft. Keep the first version file-level and small.
- Per-turn chat changes using hidden commit events once the history and task diff views are stable.
- Sync saved prompts across devices after #2249's browser-local version lands.
- Compare alternative task approaches in parallel worktrees after screenshot comparison #2250 lands.
- If owners need older search results beyond the bounded tail, add an explicit deeper-history search with pagination and clear coverage; do not silently read entire logs for each keystroke.

## Inspiration

Reuse the earlier reflections' research: these patterns are not exhausted. Repository ideas guide the design; workers should study the relevant README/interaction and respect licences rather than copy code.

- [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) → task workspaces, inline diff feedback and embedded previews. #2234 supplies the diff, #2250/#2251 cover visual inspection; this reflection advances feedback with a file-specific chat draft. Precise hunk selection remains later.
- [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) → mobile navigation, discoverable chat/file tools and Git exploration. #2254/#2255 and #2261/#2262 are in flight. Reliable recent-chat search is our adaptation of making an established chat workspace useful as projects grow, not a claim about that repo's search implementation.
- [winfunc/opcode](https://github.com/winfunc/opcode) → reusable instructions and usage reporting. Saved prompts #2249 and Stats CSV #2252 are in flight; the rolling seven-day token view is a separate, small adaptation for understanding current consumption without invented subscription prices or quotas.
- [stravu/crystal](https://github.com/stravu/crystal) → comparing approaches in parallel workspaces. Screenshot comparison #2250 is in flight; full alternative-run comparison remains open.
