# Project Brief

_Maintained by the orchestrator's planner from conversations with the owner._

## Vision
agent-orch: a self-hosted web UI for Claude Code on this arm64 Oracle VM. It has a login-protected chat UI
that drives Claude Code through the Agent SDK, a browser terminal (ttyd proxied by Caddy at /shell/), and
an agent orchestrator that plans work and runs autonomous Claude Code tasks so the owner's plan usage
limits get used around the clock.

## Goals (current push, set 2026-09-24)
Antigravity reliability (owner, #134): diagnose reported file-tool failures from session evidence, preserve tool paths and errors, and regression-test the smallest supported adapter fix without changing Claude/Codex permissions. A successful read must be distinguished from provider quota exhaustion; live orchestrated acceptance belongs to #135.
Immediate goals (owner, tasks #132–133): restore missing Artificial Analysis data in the Auto Delegate fallback popup with honest loading, unconfigured, provider-error and unavailable-metric states. Then simplify the popup to the starting model and a compact ordered fallback list, with scores and technical explanations behind one optional details disclosure; preserve ranking and saved per-chat choices. Task #132 fixes the data path only; #133 owns the simplification.
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
8. Delegation policy (owner, 2026-09-25): a queued task may be delegated to another agent/model that still has
   usage available and whose benchmark scores are comparable. Source (owner, #136): **LiveBench** (livebench.ai
   category scores: Coding, Agentic Coding, Reasoning, …) replaces the planned reliance on Artificial Analysis; models
   without an exact LiveBench identity have no score rather than a borrowed one. Reflection-generated tasks: delegation is allowed automatically. Tasks from the owner's
   chat: delegate only if that chat message was sent with "Auto Delegate" chosen in the model selector. If the
   owner picked a specific model (e.g. Opus), never swap it for a "comparable" one.

## Constraints & Preferences
- Chat and agents must run on the Claude subscription, never on API credits (see API_ENV stripping in
  server.mjs). Never weaken that.
- This checkout (/home/ubuntu/agent-orch; systemd unit agent-orch.service) IS the live app. Never restart or kill the running server or orchestrator. To test, use
  another port (e.g. `PORT=3999 node server.mjs &`) and kill only your own test process.
- Never commit anything under data/ (logins, password hash, chats, the orchestrator DB) or any secrets.
- Keep dependencies minimal: plain Node ESM with no build step.

## Definition of Done (this push)
- Task #132: `.agent-orch/DELEGATE-DATA-CHECK.md` identifies the verified cause and passing provider-to-popup regression, including unavailable/error cases.
- Task #133: `.agent-orch/DELEGATE-POPUP-CHECK.md` records the simplified popup at desktop and 375 pixels with real score details and actionable unavailable states.
- A README.md exists and covers what the app is, setup (Caddy, ttyd, systemd/env vars) and security notes.
- `npm test` runs a real smoke test suite that passes.
- .agent-orch/AUDIT.md lists the bugs found, and each one is either fixed or explicitly deferred.
