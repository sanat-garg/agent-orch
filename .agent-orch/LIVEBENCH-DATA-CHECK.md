# LiveBench data check (task #136)

## Verified official results source
- https://github.com/livebench/livebench is the evaluation framework (question datasets, judging scripts); it
  publishes no model-score feed, so nothing is run or read from it. Its README links the leaderboard https://livebench.ai.
- https://livebench.ai is GitHub Pages for https://github.com/LiveBench/livebench.github.io (`/CNAME` = `livebench.ai`).
  The deployed bundle (`static/js/main.20d28c99.js`, fetched 2026-09-25) loads, per release R, `./table_R.csv`,
  `./categories_R.json` and optional `./cost_R.csv`; its release list (`2024-06-24` … `2026-06-25`) equals the
  `table_*.csv`/`categories_*.json` pairs in that repo's `public/` directory.
- Leaderboard math (same bundle): a category = mean of its non-empty task columns; the global average = mean of categories.
  `livebench.mjs` reproduces this.
- No API exists. Release discovery uses the real GitHub contents API listing of that `public/` dir
  (`https://api.github.com/repos/LiveBench/livebench.github.io/contents/public`); if that fails, the cached release is reused.

## Real fetch (2026-09-25T23:24:26Z, fresh temp CW data dir, live `data/models.json` catalog)
```
refresh ok: true
status ready, stale false, error null, release 2026-06-25
table      https://livebench.ai/table_2026_06_25.csv
categories https://livebench.ai/categories_2026_06_25.json
categories: Reasoning, Coding, Agentic Coding, Mathematics, Data Analysis, Language, IF
models in release: 63
mapped antigravity:gemini-3.8-flash-high -> gemini-3.8-flash-high exact global 75.829 AgenticCoding 54.242
mapped antigravity:gemini-3.7-flash-high -> gemini-3.7-flash-high exact global 78.826 AgenticCoding 58.283
mapped antigravity:gemini-3.6-flash-high -> gemini-3.6-flash-high exact global 73.588 AgenticCoding 43.434
top3 claude-fable-5-1-max-effort 83.414 | claude-opus-5-5-max-effort 83.217 | claude-fable-5-max-effort 82.971
```
All other installed models are unmatched: LiveBench only lists fixed effort configurations (e.g.
`claude-opus-5-5-max-effort`, `claude-opus-5-5-xhigh-effort`, `gpt-6-sol-max`, `gemini-3.1-pro-preview-high`) and the
CLIs do not report which one they run, so no alias was added (`.agent-orch/livebench-map.json` is empty by design).

## Checks
`node --test test/livebench.test.mjs` — 6/6 pass (fixtures in `test/fixtures/livebench/`, recorded from the real files):
- valid scores: release discovery, task scores, category means, global average, empty cell = not run;
- malformed responses: HTML, empty, wrong header, missing task column, non-numeric / out-of-range cell, short row,
  duplicate model, bad categories JSON, GitHub rate-limit object → rejected whole;
- mapping: exact id/resolved id or explicit alias only; no other effort/version, missing alias target → unmatched;
- cache: unavailable before any success, 1 h retry wait, successful fetch cached to disk, malformed and HTTP-failure
  refreshes keep last-known-good (also after a restart) with `stale: true` + `data_error`, recovery clears it.

`npm test` — 187/187 pass.

Not yet done here: delegation ranking (`delegate.mjs`) and the popup still read `aa.mjs`; the store is not started
by server.mjs. Switching them to `createLiveBenchStore().view()` is a separate task.
