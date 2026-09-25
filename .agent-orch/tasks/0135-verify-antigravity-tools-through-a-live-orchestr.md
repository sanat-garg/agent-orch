# Task #135: Verify Antigravity tools through a live orchestrator run

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 20:41  
- starts after: #134

## Prompt

After the Antigravity fix, read .agent-orch/ANTIGRAVITY-TOOLS.md and locate the normal orchestrator launch path. Run a bounded Antigravity smoke session through that path using the installed CLI and existing authentication, not a mocked adapter or substitute coding agent. Have Antigravity explicitly call view_file against a temporary fixture containing a unique marker and confirm the actual tool result includes it. Exercise each additional tool observed failing in the prior session with harmless temporary fixtures; for any mutation tool use only a disposable directory. Capture tool-level success/error evidence so a natural-language claim from the model cannot count as success. Respect usage limits and avoid repeated retries. Record the exact launch/check procedure and results in ANTIGRAVITY-TOOLS.md, clean up fixtures, and update CONTEXT.md with any runtime requirements. If authentication, quota or an independent unresolved tool failure blocks verification, report it accurately and leave the check failing.

## Done when

.agent-orch/ANTIGRAVITY-TOOLS.md contains live tool-call evidence from the normal orchestrator launch path that view_file returned the fixture marker and every other previously failing tool passed its fixture check.
