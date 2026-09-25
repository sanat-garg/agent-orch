# Task #108: Artificial Analysis client: API key in Connections, cached model metrics

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-25 13:22  
- starts after: #99

## Prompt

Integrate the Artificial Analysis data API (docs: https://artificialanalysis.ai/data-api/docs; read them with WebFetch first: the LLM models endpoint and the auth header, likely x-api-key). 1) Key storage: add an 'Artificial Analysis' row to the Connections modal with a password field for the API key, saved server-side to <DATA>/secrets.json (0600, never sent back to the client, only 'configured: true'), plus a Remove button. Also accept the AA_API_KEY env var. 2) aa.mjs: fetch the models list with the evaluations (Coding Index, Agentic Index and Intelligence Index if present, individual benchmarks including Terminal-Bench and SciCode and whatever else is returned), speed (output tokens/s), latency (TTFT), context window and pricing. Cache it to <DATA>/aa-models.json and refresh every 24 h, respecting their rate limits and attribution requirements. 3) Map AA model entries to the models discovered from our CLIs (claude/codex/antigravity), with a normalised-name matcher and an override file .agent-orch/model-map.json for manual fixes. Report unmatched models. 4) Fallback without a key: read .agent-orch/model-metrics.json (a hand-maintained table) and label the data source 'manual' in all outputs. 5) GET /api/models/metrics returns the merged per-model metrics with source and fetched_at. Tests use recorded fixture JSON; don't call the real API in tests.

## Done when

`npm test` passes with aa.mjs fixture tests for parsing and CLI-model mapping, and GET /api/models/metrics returns entries with a source field
