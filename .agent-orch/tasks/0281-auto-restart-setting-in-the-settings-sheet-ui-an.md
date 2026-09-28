# Task #281: Auto-restart setting in the Settings sheet ui and banner wording

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 05:57  
- starts after: #280  
- files: public/app.js, public/index.html, public/app.css, test/ui-static.test.mjs

## Prompt

Goal: let the owner turn on the new `autoRestart` setting from the UI. The backend (previous task) stores `autoRestart` in kv `parallel_settings`, accepts it via `PUT /api/orch/parallel {autoRestart: boolean}` and shows it in the orchestrator state the UI already receives (look at how `controllerWork` reaches app.js `renderSettings()` near line 5401 and is saved near line 5369).

Do:
1. public/index.html + public/app.js: add an `.st-switch` toggle in the gear's Settings sheet next to the controller-work switch, labelled like 'Restart automatically once idle after server code changes', with a one-line hint that a restart waits for running tasks and chat turns. Save it through the same PUT; never overwrite what the owner is typing (follow the existing renderSettings guard).
2. The update banner (`renderUpdateBanner`, `upd.pending`, `upd.commits`): when `autoRestart` is on and a restart is pending, say it is automatic (e.g. 'Restarting once idle (automatic)'), and when commits are waiting but no server file changed, keep today's wording.
3. Tests: extend test/ui-static.test.mjs with a static check that index.html has the switch and app.js sends `autoRestart` in the PUT; if a Playwright test already exercises the Settings sheet switches (grep test/ for `st-switch`), add the toggle there too.

Constraints: HIG sizes as in CONTEXT.md (44pt on touch is inherited from `.st-switch`); no new dependencies; keep #orchBar unchanged.

## Done when

`npm test -- test/ui-static.test.mjs` && `grep -q autoRestart public/app.js` && `grep -q autoRestart public/index.html`
