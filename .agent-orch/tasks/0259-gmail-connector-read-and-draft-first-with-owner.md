# Task #259: Gmail connector (read and draft first) with owner OAuth

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 01:58  
- starts after: #258  
- files: gmail-mcp.mjs, extensions.mjs, connections.mjs, server.mjs, public/app.js, README.md, test/gmail-connector*.test.mjs

## Prompt

Add the first real connector per .agent-orch/AGENTIC.md: Gmail via the official Gmail API (or the MCP server that AGENTIC.md recommends). 1) Connections modal: 'Gmail', connected with the owner's Google account via OAuth (the owner creates a Google Cloud OAuth desktop client; the modal shows step-by-step instructions and accepts the client JSON, or uses the device/loopback flow on this headless server with the redirect handled via the head's URL). Start with the least scopes: gmail.readonly plus gmail.compose (drafts). Sending needs gmail.send, which is opt-in and always passes the approval gate. Tokens are encrypted at rest in <DATA>/secrets. 2) An MCP server (gmail-mcp.mjs, stdio) exposes the tools search_messages, read_message (plain text plus attachments list), download_attachment (to the task's workspace), list_labels, create_draft and send_draft (outbound → gated), and it's registered through extensions.mjs for tasks with capabilities ['gmail']. 3) Treat email content as untrusted (wrap it in delimiters with a note). 4) Tests with a mocked Gmail API (recorded fixtures): search/read, a draft created, and send_draft held by the approval gate. Document the setup in README.

## Done when

`node --test test/gmail-connector*.test.mjs` passes (search/read/draft with mocked API; send_draft gated), and the Connections modal lists Gmail
