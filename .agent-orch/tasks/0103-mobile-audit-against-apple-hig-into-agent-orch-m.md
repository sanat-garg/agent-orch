# Task #103: Mobile audit against Apple HIG into .agent-orch/MOBILE.md

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 13:22  
- starts after: #102

## Prompt

Read the apple-design skill: ~/.claude/skills/apple-design/SKILL.md and the relevant files in its references/ (layout, safe areas, navigation, sheets, text fields/keyboard, touch targets, typography, dark mode, PWA/web app considerations). Then audit agent-orch's UI (public/index.html, app.css, app.js, login.html, manifest.webmanifest) for iPhone Safari and the home-screen standalone mode. Start a test server on a separate port (CW_DATA_DIR=$(mktemp -d), CW_NO_ORCHESTRATOR=1) and capture screenshots at 390x844 and 430x932 with bin/shot.mjs --mobile (if it exists, else Playwright directly with iPhone emulation) of: login, chat, sidebar open, a task drawer, the Connections/Usage/Server modals, the model picker and the terminal view. Write .agent-orch/MOBILE.md: a ranked list of concrete issues (file:line, HIG reference, fix), grouped into the upcoming tasks: A) PWA shell (manifest, apple meta tags, icons, splash, safe areas, standalone quirks), B) navigation and sidebar, C) chat composer and keyboard, D) modals as sheets and the drawer, E) touch/gesture/perf polish. Don't change code in this task.

## Done when

.agent-orch/MOBILE.md exists with issues grouped under A-E, each with a file:line reference, and mobile screenshots exist in .agent-orch/shots/
