# Task #44: Dedupe concurrent gh.ensureRepo calls per directory (AUDIT #12)

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-25 03:55

## Prompt

Fix AUDIT #12 in .agent-orch/AUDIT.md. In github.mjs, `ensureRepo(dir)` can run concurrently for the same dir: server.mjs `setupRepo` calls it directly (not awaited), outside the inflight dedupe that `push` has. Both calls see no `origin` and both run `gh repo create`, which leaves a duplicate `name-2` repo or an 'origin already exists' error. Add a per-dir inflight Map inside ensureRepo itself (like the one `push` uses at github.mjs ~78-91): a second call for the same dir returns the same promise, and the entry is deleted in finally. Keep the exported API unchanged. Add a test in test/github.test.mjs that uses a stub `gh` binary on PATH (put it in test/fixtures/, as the agents.mjs tests do) which records each `repo create` invocation to a temp file and sleeps briefly. Call ensureRepo twice in parallel on a temp git dir and assert only one create happened. Look at how github.mjs is constructed and invoked before writing the test. Mark AUDIT #12 `- **Fixed** (task #N): ...` with a one-line note. Never touch the running server; don't commit data/.

## Done when

`npm test` passes and `grep -A12 '### 12\.' .agent-orch/AUDIT.md | grep -q Fixed`
