# Task #2274: Download a schedule run's retained output, with tests (ui)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:35  
- files: public/schedules.js, public/schedules.css, test/ui-schedule-output-download.test.mjs

## Prompt

Add Download output to each command-run entry rendered by runs() in public/schedules.js, with scoped public/schedules.css styling. Use the already-loaded /api/orch/schedules/:id/runs data to create a UTF-8 text download containing schedule title, run ID, start time, status/exit code when available, then the exact retained output. Choose a safe filename containing schedule/run IDs. Label a running run's output as a snapshot and make clear that this exports retained output. Empty output still produces an identified report; a failed API load must show its error and offer no bogus download. Keep schedule creation, copying, Run now and backend behavior unchanged. Inspiration: [winfunc/opcode](https://github.com/winfunc/opcode)'s accessible execution logs, adapted to sharing scheduled-job results. Add test/ui-schedule-output-download.test.mjs verifying report bytes and filename, empty output, running snapshot labeling, API failure and phone usability. No new endpoint or dependency is needed.

## Done when

`npm test -- test/ui-schedule-output-download.test.mjs` passes.
