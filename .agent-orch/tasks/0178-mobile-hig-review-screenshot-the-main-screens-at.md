# Task #178: Mobile HIG review: screenshot the main screens at 390x844 and list prioritised UI findings

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-26 10:42  
- files: .agent-orch/UI-REVIEW.md, .agent-orch/shots/ui-review-*

## Prompt

Review only; do NOT change source code. Goal 6 in .agent-orch/BRIEF.md: saved to the iPhone home screen, agent-orch should feel native. Read the apple-design skill (~/.claude/skills/apple-design/SKILL.md and the references it points to for iOS layout, touch targets, sheets, toasts/alerts and typography). Start a test instance on a free port with a temp data dir: `PORT=<port> CW_DATA_DIR=$(mktemp -d) node server.mjs`. Never use port 3000 or the real data/, and kill only your process. Seed it with a login and a chat that has a project with a few tasks in different states (queued, running, done, failed, delegated) through its APIs, or copy the approach the test/ui-*.test.mjs files use. Use bin/shot.mjs (playwright-core) at 390×844 with deviceScaleFactor 3 to capture at least these: login, chat list, a chat with messages, the composer with the keyboard-style viewport, the task list/cards, the task drawer, the fallback editor, the Connections modal, the orchestrator settings popup, a toast, and the 'While you were away' sheet. Save them in .agent-orch/shots/ui-review-*.png. Write .agent-orch/UI-REVIEW.md with a table of findings. Each finding gets a severity (high/med/low), the screen and screenshot file, the HIG rule it breaks (touch target <44pt, safe-area, text too small, popover instead of sheet, contrast, clipped/overflowing content, inconsistent spacing, etc.) and a concrete fix naming the selector or function in public/. Order them by user impact and keep the list honest: note what already looks right. No more than 20 findings.

## Done when

`test -s .agent-orch/UI-REVIEW.md` and `ls .agent-orch/shots/ui-review-*.png` both succeed, and `git diff --quiet HEAD -- public server.mjs` shows no source changes.

## Result — done (check passed) (2026-09-26 10:48)

AGENT-ORCH-STATUS: done — UI-REVIEW.md has 17 HIG findings; 15 screenshots saved
