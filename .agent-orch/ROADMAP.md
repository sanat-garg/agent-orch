# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment
_2026-10-19 (reflect #2229)._ Since the last reflection (2026-09-28) most work arrived through the owner's chat: multi-user
accounts, many chats per project, rewind/edit/delete a prompt, credentials, cron schedules, live previews per project, project
screenshots, phone redesign, Windows workers, a CodeMirror file editor, per-chat token usage. No agent-orch tasks are queued.
Tests run for this reflection (chat-usage, files-save, ui-chat-tokens, ui-static, cron): 37 of 38 passed. The failure is
ui-static's Settings test: it still expects the "Restarting once idle (automatic)…" wording as an `O.state?.parallel` ternary,
which now lives in the pure `updateBannerView` helper. That's a stale assertion, not a bug.

Two features are half-built: `changes.mjs` (a task's diff) and `digest.mjs` ("since you were away") have modules and tests
but no route or UI. Finishing them comes first. Beyond that, the biggest gaps compared with similar tools are reviewing what an agent
changed, quick keyboard navigation, voice input on the phone, slash commands, and getting a chat out of the app.

CONTEXT.md was cut to its 8 KB budget; per-area rules moved to AREAS.md.

## Next (queued by #2229)
1. Fix ui-static's stale restart-wording assertion.
2. Task changes: `GET /api/orch/tasks/:id/changes` over changes.mjs.
3. Task drawer "Changes" section: files with +/− counts and a coloured diff (vibe-kanban's diff review).
4. "Since you were away" group at the top of the Queue, from digest.mjs.
5. Voice dictation in the composer (Web Speech API; iPhone + desktop).
6. ⌘K command palette: jump to any chat/project, open any view.
7. Slash-command autocomplete in the composer from the SDK's reported `slash_commands`.
8. Retry a failed task with a note from the owner.
9. Export a chat as Markdown from the sidebar ⋯ menu.

## Later (feature ideas)
- Inline comments on a task's diff that queue a follow-up task with the comment (vibe-kanban), once the Changes section lands.
- Per-turn "View changes" under each chat reply from its hidden `{t:'commit', sha}` events, reusing the diff renderer.
- Project git history: commit list with per-commit diff, branch view (claudecodeui's Git explorer).
- Owner cancel asks an optional reason, kept in `tasks.result` so Stats and the digest say why.
- Saved prompt templates per project (opcode's agent library), offered with the slash menu.
- Compare two tasks' attempts side by side (crystal/Nimbalyst run variants in parallel worktrees).
- Push notification test button + per-device last error in Settings (push.mjs `createNotifier` wiring).
- Split public/app.js into ESM modules, guarded by ui-static.test.mjs (only when it blocks a feature).
- AGENTIC.md phase 1 (files-only workspace) when the owner asks for computer work again.

## Inspiration
- BloopAI/vibe-kanban (28k★): kanban of agent tasks, a workspace per task (branch + terminal + dev server), **diff review with
  inline comments sent back to the agent**, built-in preview browser with device emulation, PR creation with AI descriptions.
- siteboon/claudecodeui (14k★): mobile-first web UI, file tree with live editing, **Git explorer (stage, commit, switch branches)**,
  session discovery from ~/.claude, plugin tabs, MCP config written straight into Claude Code's config.
- winfunc/opcode (22k★): custom agents library with system prompts, background agent runs with history, **usage analytics by
  model/project/time with export**, MCP server manager, timeline checkpoints with diffs, CLAUDE.md editor.
- stravu/crystal → Nimbalyst (3k★): parallel sessions in worktrees to **compare approaches**, multi-editor workspace.
Used so far: diff review (Next 3), smart search/palette (Next 6), usage analytics (already in Stats), checkpoints (rewind exists).
