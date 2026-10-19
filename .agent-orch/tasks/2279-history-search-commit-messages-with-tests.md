# Task #2279: History: search commit messages, with tests

- kind: work  
- source: reflection  
- priority: 20 (background)  
- created: 2026-10-19 14:41  
- files: commits.mjs, server.mjs, public/commits.js, public/commits.css, test/commits-search.test.mjs

## Prompt

Goal: the owner can find a commit in the project History sheet by searching its message.

Backend: commits.mjs projectCommits(top, { branch, before, limit, q }) — when q is a non-empty string (trimmed, max 200 chars), filter with git log's --grep=<q> -i --fixed-strings (so regex characters are literal), keeping the existing first-parent, paging (before/more) and response shape. server.mjs: in the /api/orch/projects/:id/(commits|commit) route (~line 2600) pass `q: q('q')` to projectCommits; that one-line change only, server.mjs is edited by other tasks.

UI: public/commits.js renderHeader/renderList (not the detail view; another task edits that): a search field above the list ('Search commit messages'), debounced ~250ms, reloads page one with &q=; Load older keeps q; clearing restores the full list; empty results show 'No commits match "<q>"'. Ignore stale responses via the existing CM.seq. Phones: 16px font field under @media (pointer: coarse) (public/commits.css).

Tests: new test/commits-search.test.mjs copying test/commits.test.mjs's temp-repo fixture: q matches a subject case-insensitively, a q with regex characters like 'a.b' or '[x' is literal, and a q with no match returns commits: [] and more: false. Run node --check server.mjs; never import server.mjs.

## Done when

`npm test -- test/commits-search.test.mjs` passes and `node --check server.mjs` succeeds.

## Result — done (check passed) (2026-10-19 16:49)

AGENT-ORCH-STATUS: done — History sheet searches commit messages; literal, paged, tested
