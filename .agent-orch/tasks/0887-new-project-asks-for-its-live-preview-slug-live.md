# Task #887: New project asks for its live preview slug; Live preview link per project

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-10-02 17:35  
- files: public/app.js, public/index.html, public/app.css, test/ui-previews*.test.mjs

## Prompt

UI for live previews (public/app.js, index.html, app.css). Contract (the parallel backend task implements it; code exactly to it): GET /api/previews/check?slug= → {ok, slug, url, error?}; project creation POST /api/orch/projects accepts {…, slug}; PATCH project {slug, previewPrivate}; GET /api/previews → [{projectId, slug, url, status, kind, port, error?, updatedAt}]; POST /api/previews/:projectId/restart; GET /api/previews/:projectId/logs. 1) The New project flow gets a field 'Live preview URL' showing `[ slug ].greygoose.baby` (the base domain comes from the check response url), prefilled from the project name slugified, with a live availability check (debounced 300 ms; a green check plus the full URL, or a red message such as 'taken' or 'reserved'). It's optional ('Skip, no live preview'). 2) Each project shows a 'Live preview' link (opens in a new tab) with a status dot (running green, building amber, error red with the reason) in the sidebar project row's menu, and in the chat header next to the repo link. 3) Settings → This project: change the slug (with the same check), a 'Private (requires agent-orch login)' switch, Restart preview, and 'View logs' (a modal with the last 200 lines). 4) Mobile: the field and link work at 390px. Tests with mocked endpoints: the slug field prefills from the name, the check result renders available/taken, creation posts the slug, the preview link renders with its status, and the settings change PATCHes. Run only the touched test files.

## Done when

`node --test test/ui-previews*.test.mjs` passes (prefilled slug, live check states, creation posts slug, preview link with status, settings PATCH)
