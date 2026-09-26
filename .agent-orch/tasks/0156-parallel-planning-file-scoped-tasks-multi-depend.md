# Task #156: Parallel planning: file-scoped tasks, multi-dependencies, integrator tasks, agent spreading

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-26 04:21  
- starts after: #155

## Prompt

Teach the planner and scheduler to parallelise (BRIEF goal 9), building on the worktree isolation. 1) The tasks JSON gets an optional per-task "files": [paths or globs the task will modify], and "after" may be an array of indexes/ids (multi-dependency: the task starts only when ALL are done). Store it as a task_deps table (task_id, depends_on) with migration; keep tasks.depends_on working for single deps, and update cascade-cancel, reorder and the UI 'after #…' labels for multiple deps. 2) Scheduler: run tasks in parallel only if their declared file sets don't overlap (glob-aware) with any running task in the same project. Undeclared files count as 'everything', so the task runs alone. Raise the effective concurrency when parallel-safe work is waiting and usage allows it. 3) Agent spreading: when several parallel tasks are ready, assign them across agents/models from the task's fallback list that have usage left, so one agent's limit doesn't serialise everything. Prefer the primary model, and spill to fallbacks only for tasks that would otherwise wait. 4) Integrator tasks: the planner prompt explains that for a feature split into parallel parts, it should add a final task with after: [all parts] whose job is to integrate, reconcile and run the full test suite. The 'needs integration' outcome from worktree conflicts also auto-queues such a task. 5) Update the planner prompt (TASKS_FORMAT) with 'files' and multi-'after', and the rule that 'after' is for true prerequisites only. Tests: overlap detection including globs, multi-dep gating, spreading across two agents, and an integrator starting only after all parts.

## Done when

`npm test` passes with tests for file-overlap gating, multi-dependency gating, agent spreading and integrator ordering
