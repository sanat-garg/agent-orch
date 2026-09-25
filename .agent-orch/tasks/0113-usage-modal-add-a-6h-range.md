# Task #113: Usage modal: add a 6h range

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 14:02

## Prompt

Add a 'Last 6h' range to the usage modal. In usage.mjs, add RANGES['6h'] = { ms: 6*3600e3, bucket: 15*60e3 } (15-minute token buckets) and make /api/usage/history accept range=6h. In public/app.js (~line 2047, the U state and the range switch), add '6h' as the first option (order: 6h, 24h, 7d, 30d), accept it in the persisted cw.urange value, and format axis labels as clock times for 6h. Extend the usage tests for the 6h bucketing.

## Done when

`npm test` passes with a 6h bucketing test, and GET /api/usage/history?range=6h returns 15-minute buckets

## Result — done (check passed) (2026-09-25 18:59)

AGENT-ORCH-STATUS: done — Usage modal offers 6h range with 15-minute token buckets
