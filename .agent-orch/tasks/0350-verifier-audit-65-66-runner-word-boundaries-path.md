# Task #350: Verifier AUDIT #65/#66: runner word boundaries, path-like snippets skipped, 2>&1, env prefixes and a leading cd accepted

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-09-28 12:31  
- files: taskrun.mjs, test/verify.test.mjs

## Prompt

Reliability fix in taskrun.mjs extractCommand/looksLikeCommand/checkCommand (read the file header and .agent-orch/AUDIT.md Round 7 findings #65 and #66 first; #64's line-splitting may already have landed, keep it). Verified today: 'Done when `node_modules` stays untracked and `npm test` passes' becomes `node_modules && npm test`, which exits 127 'command not found' and is then accepted unverified; `CI=1 npm test` and `npm test 2>&1 | grep -q ok` are REFUSED, which leaves the task with no check at all. Changes: (1) RUNNERS entries need a word boundary: `node\b`, `npm\b`, `go\b` etc. match, `node_modules`, `nodes.json`, `go.mod`, `bundle.js`, `yarn.lock` do not; a snippet that looks like a path with an extension and no space (`./README.md`, `makefile` alone, `src/x.mjs`) is never a command; (2) accept `2>&1` and `2>/dev/null` (a redirect of stderr only; any other `>` still refuses); (3) accept up to three `&&` in one snippet; (4) accept a leading env prefix (`CI=1 `, `TMPDIR=/x `, several) and a leading `cd <relative dir without ..> && ` in front of a runner; keep every other refusal (rm, sudo, git push, curl, `>` to a file, `$(`, backticks inside). Add tests in test/verify.test.mjs for each of those cases, positive and negative (e.g. `node_modules` yields no command while `npm test` in the same text still does; `CI=1 npm test` yields itself; `npm test 2>&1 | grep -q ok` yields itself; `cd ../x && npm test` is refused; `npm test > out.txt` is refused). The orchestrator's 127 rule and 'refused snippet fails the task' live in orchestrator.mjs, which other tasks hold: do NOT touch it or AUDIT.md. Verify with `npm test -- test/verify.test.mjs`.

## Done when

`npm test -- test/verify.test.mjs` passes and `node -e "import('./taskrun.mjs').then(m=>{const a=m.extractCommand('Done when \`node_modules\` stays untracked and \`npm test\` passes');const b=m.extractCommand('\`CI=1 npm test\` passes');process.exit(a==='npm test'&&b==='CI=1 npm test'?0:1)})"` exits 0
