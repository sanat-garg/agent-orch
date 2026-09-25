# Task #129: Backend: owner-defined fallback list per chat for Auto Delegate

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 19:45

## Prompt

Let the owner curate the Auto Delegate fallbacks. 1) Storage: each chat (convo in data/convos.json, via server.mjs) gets an optional `fallbacks` value: an ordered array of {agent, model}. `fallbacks: null` means automatic (the current delegate.mjs ranking); an array, even an empty one, means owner-curated. Add PUT /api/convos/:id/fallbacks {fallbacks|null} (login-protected), validated against the discovered model lists (reject unknown agent/model with 400), and include the value in the convo payload sent to the client. 2) Snapshot: when a chat message is sent with autoDelegate, the tasks the planner queues from that turn store the list in effect (new tasks.fallbacks TEXT JSON column, with migration). A later edit to the chat's list doesn't silently change already-queued tasks, but the manual 'Delegate…' action still works. 3) delegate.mjs: if a task has a curated list, candidates come ONLY from that list, in the owner's order, filtered by availability (per-agent blocks/usage windows), and ignore the 'comparable' threshold, because the owner chose them. Metrics are still returned for display. With an empty list, the task never auto-delegates and waits for its start model. With null, keep the current automatic ranking. 4) /api/delegate/preview accepts ?convo=<id> and returns the curated list (with availability and metrics) when one is set, plus `suggested` (the automatic top 3) so the UI can offer them. Tests: curated order respected; an unavailable curated model is skipped; an empty list never delegates; null falls back to automatic; PUT validation rejects unknown models.

## Done when

`npm test` passes with curated-fallback tests (order, skip unavailable, empty list, null=auto, validation)
