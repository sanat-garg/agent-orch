# Roadmap

_Maintained by the orchestrator's reflection loop._

## Assessment

_2026-10-19 (reflect #2256)._ agent-orch already has multi-project chats, a task queue, Files, Stats, schedules, screenshots, token usage, and a Browser view with persistent profiles. The active queue covers the previous reflection's seven features (#2249–#2255) plus the task diff, digest, voice input, command palette, chat export, retry note, slash commands, sidebar order, and Zen mode. #2233's task-changes API is done; its UI is still running as #2234. Let those features finish rather than queueing duplicates.

The built-in Browser has an address bar and profiles but no saved site shortcuts. That is a practical gap for repeated office work in signed-in web apps. A small, browser-only shortcuts feature is the next independent user-facing addition. It must not assign a public preview address or start a service.

Check: `node --test test/ui-static.test.mjs` passed (1/1). `npm test -- test/ui-static.test.mjs` stopped before running tests because its temp-dir selector chose the read-only `/home/ubuntu/.cache`; this is a check-runner environment limitation, not a confirmed app failure. No full-suite or live-browser claim is made.

## Next

1. **Saved sites in the built-in Browser:** save the current HTTP(S) page to a named shortcut, revisit it through the existing navigation action, and remove it. Scope shortcuts to the signed-in user and machine/profile, clear them when that profile is cleared, and show an empty state. Keep Chrome direct mode's UI as it is. This is one independent task touching `public/browser.js`, `public/browser.css`, and a focused UI test.
2. **Finish the active queue:** land #2234's Changes section on top of #2233's API, then the already queued digest, command palette, dictation, sidebar order, and reusable/export features. No duplicate tasks are needed.

## Later (feature ideas)

- Inline feedback on a task diff that can become a follow-up instruction, after #2234 lands (vibe-kanban).
- Read-only project Git history with commit titles and diffs. Stats already gathers commit counts and file names, but does not provide a navigable history; keep this separate from autonomous merge controls (claudecodeui).
- Per-turn chat changes using the hidden commit events and the task diff renderer, once the latter is stable.
- Sync saved prompts across devices after #2249's browser-local version proves useful; consider variables only if owners reuse them.
- Compare alternative task approaches in parallel worktrees after screenshot comparison #2250 shows what comparison UX owners need (crystal).

## Inspiration

The earlier reflection researched these open-source repos. Several useful ideas remain, so this reflection reuses that research instead of searching again. These are design patterns to study, not code to copy; respect each repository's licence.

- [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) → task workspaces, inline diff feedback, embedded previews and device-size inspection. #2234, #2250 and #2251 cover the first visual steps; inline feedback remains open.
- [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) → mobile navigation, file editing, Git explorer and discoverable tools. #2254 and #2255 cover Files and Skills navigation; read-only Git history remains open. Profile-specific Browser shortcuts are a small adaptation of making frequently used destinations easy to reach.
- [winfunc/opcode](https://github.com/winfunc/opcode) → reusable agent instructions and usage reporting. #2249 and #2252 cover saved project prompts and CSV export.
- [stravu/crystal](https://github.com/stravu/crystal) → comparing approaches in parallel workspaces. #2250 begins with comparison of existing screenshots; full alternative-run comparison remains open.
