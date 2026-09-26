# Project Brief

_Maintained by the orchestrator's planner from conversations with the owner._

## Vision
agent-orch: a self-hosted web UI for Claude Code on this arm64 Oracle VM. It has a login-protected chat UI
that drives Claude Code through the Agent SDK, a browser terminal (ttyd proxied by Caddy at /shell/), and
an agent orchestrator that plans work and runs autonomous Claude Code tasks so the owner's plan usage
limits get used around the clock.

## Goals (current push, set 2026-09-24)
(Earlier pushes are finished: Antigravity reliability landed in #148/#149, and the Auto Delegate popup work (#132/#133)
was retired when benchmark ranking was removed in #152/#153. Current work hardens goals 8–10 below.)
1. Repo hygiene: the GitHub repo is github.com/sanat-garg/agent-orch (private; `origin`). No secrets or
   runtime data are tracked, and a README explains setup.
2. Find and fix existing bugs and gaps in the server, orchestrator and UI.
3. Add high-value usability features and polish the overall experience.

4. Naming (owner, 2026-09-24): the product is called **agent-orch** everywhere: UI, titles, docs, prompts,
   code identifiers, the memory dir, the DB file, systemd units and the install directory. No user-visible
   "Claude Web", "claude-web" or "AO2" should remain. ("Claude Code" is the real product name of the CLI, so it stays.)

5. Multi-agent (owner, 2026-09-25): besides Claude Code, chats and orchestrator tasks can run on other coding
   agent CLIs: OpenAI Codex CLI and Google Antigravity's CLI (or Gemini CLI if Antigravity has no headless CLI).
   The owner can say in chat, e.g., "use codex for tests" or "use gemini-2.5-pro for UI work", and the planner
   records that as routing rules. Each task then runs on the agent and model its rule picks. Every agent must use
   the owner's subscription login (ChatGPT / Google account), never a paid API key, just like Claude.

6. Mobile-first PWA (owner, 2026-09-25): agent-orch saved to the iPhone home screen must feel like a native app,
   good enough that the owner prefers it to desktop. Follow Apple's HIG via the apple-design skill
   (~/.claude/skills/apple-design/SKILL.md and references/): safe areas, standalone display, 44pt touch targets,
   keyboard-aware composer, sheets instead of popovers, and smooth performance on iOS Safari.
7. Honest data: model selectors list only the models each CLI actually reports, never hardcoded guesses. Each
   agent's rate limits are fully independent: one agent's limit never blocks or mislabels another's.
8. Delegation (owner, revised 2026-09-26): no benchmarks or automatic ranking (LiveBench and Artificial Analysis
   are removed). The owner enters fallbacks by hand as an ordered list, per chat, plus one list for reflection tasks.
   When a task's model is rate-limited, it moves to the first fallback that has usage left. With an empty list the
   task waits. The UI must make it obvious which model a task is on, whether it was delegated, and what happens
   when a limit hits. Keep it simple and foolproof.
9. Parallel agents: resource-aware (owner, 2026-09-26 19:40). Parallel runs had kept the VPS RAM at 100%. Now a
   resource monitor measures CPU and RAM per process, reaps leftover processes (orphaned agent CLIs, stale test
   servers, headless browsers, dead login sessions), and grants extra task slots only while there's measured
   headroom. The default is one task at a time. Plan sequential chains with true prerequisites; the scheduler adds
   parallelism only when the machine can afford it. Worktrees must stay cheap on disk and memory.
10. More agent CLIs (owner, 2026-09-26): OpenCode CLI, Kiro CLI and GitHub Copilot CLI, each fully runnable
   (headless commands, model discovery, limits) and connectable from the Connections modal.

## Constraints & Preferences
- Chat and agents must run on the Claude subscription, never on API credits (see API_ENV stripping in
  server.mjs). Never weaken that.
- This checkout (/home/ubuntu/agent-orch; systemd unit agent-orch.service) IS the live app. Never restart or kill the running server or orchestrator. To test, use
  another port (e.g. `PORT=3999 node server.mjs &`) and kill only your own test process.
- Never commit anything under data/ (logins, password hash, chats, the orchestrator DB) or any secrets.
- Keep dependencies minimal: plain Node ESM with no build step.

## Definition of Done (this push)
- A README.md exists and covers what the app is, setup (Caddy, ttyd, systemd/env vars) and security notes.
- `npm test` runs a real smoke test suite that passes.
- .agent-orch/AUDIT.md lists the bugs found, and each one is either fixed or explicitly deferred.
