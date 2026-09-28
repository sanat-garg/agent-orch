// A stand-in MCP streamable http server (test/gate-proxy-http.test.mjs): `node fake-http-mcp.mjs <log.jsonl>` listens on a
// free port and prints its url on stdout. initialize answers with an Mcp-Session-Id header; any later request without it
// gets 400. tools/list has `send_message` (outbound) and `read_inbox`; tools/call answers as JSON, or as an SSE body when
// the url has ?sse=1 or the tool is read_inbox; the tool `broken` gets a 500. Notifications get 202. Every request is
// appended to the log as {method, rpc, name, session, protocol, auth, url, status, sse}. A POST to /reset (not logged) plays
// a restart: the current session is forgotten (404 from then on) and the next initialize issues fake-session-<n+1>; with
// ?gone=1 every request carrying any session id gets 404 afterwards.
import fs from 'node:fs';
import http from 'node:http';

const log = process.argv[2];
let gen = 1, gone = false;
const session = () => `fake-session-${gen}`, forgotten = new Set();
const TOOLS = [
  { name: 'send_message', description: 'Sends a message', inputSchema: { type: 'object' } },
  { name: 'read_inbox', description: 'Reads the inbox', inputSchema: { type: 'object' } },
];

const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let m = null; try { m = JSON.parse(body); } catch { /* recorded as null */ }
    const sse = new URL(req.url, 'http://x').searchParams.get('sse') === '1';
    const record = (status, streamed = false) => log && fs.appendFileSync(log, `${JSON.stringify({ method: req.method, rpc: m?.method ?? null,
      name: m?.params?.name ?? null, session: req.headers['mcp-session-id'] ?? null, protocol: req.headers['mcp-protocol-version'] ?? null,
      auth: req.headers.authorization ?? null, url: req.url, status, sse: streamed })}\n`);
    const send = (status, headers = {}, out = '') => {
      record(status);
      res.writeHead(status, headers);
      res.end(out);
    };
    const json = (msg, headers = {}) => send(200, { 'Content-Type': 'application/json', ...headers }, JSON.stringify({ jsonrpc: '2.0', ...msg }));
    const stream = (msg, headers = {}) => {
      // A log notification first, then the answer split across writes, so the proxy must buffer events.
      const note = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'working' } });
      const ans = JSON.stringify({ jsonrpc: '2.0', ...msg });
      record(200, true);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...headers });
      res.write(`event: message\ndata: ${note}\n\n`);
      const half = Math.floor(ans.length / 2);
      res.write(`id: 1\ndata: ${ans.slice(0, half)}`);
      setTimeout(() => { res.write(`${ans.slice(half)}\n\n`); res.end(); }, 20);
    };
    const u = new URL(req.url, 'http://x'), sid = req.headers['mcp-session-id'];
    if (req.method === 'POST' && u.pathname.endsWith('/reset')) {
      forgotten.add(session()); gen++; gone = u.searchParams.get('gone') === '1';
      res.writeHead(204); return res.end();
    }
    if (req.method !== 'POST' || !m) return send(405);
    if (sid && (gone || forgotten.has(sid))) return send(404, { 'Content-Type': 'text/plain' }, 'unknown session');
    if (m.method !== 'initialize' && sid !== session()) return send(400, { 'Content-Type': 'text/plain' }, 'missing session');
    if (m.id == null) return send(202);
    if (m.method === 'initialize') {
      const msg = { id: m.id, result: { protocolVersion: m.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-http', version: '1' } } };
      return sse ? stream(msg, { 'Mcp-Session-Id': session() }) : json(msg, { 'Mcp-Session-Id': session() });
    }
    if (m.method === 'tools/list') return sse ? stream({ id: m.id, result: { tools: TOOLS } }) : json({ id: m.id, result: { tools: TOOLS } });
    if (m.method === 'tools/call') {
      const name = m.params?.name;
      if (name === 'broken') return send(500, { 'Content-Type': 'text/plain' }, 'boom');
      const text = name === 'read_inbox' ? 'inbox: 2 messages' : `${name}: done ${JSON.stringify(m.params?.arguments || {})}`;
      const msg = { id: m.id, result: { content: [{ type: 'text', text }] } };
      return sse || name === 'read_inbox' ? stream(msg) : json(msg);
    }
    json({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`http://127.0.0.1:${server.address().port}/mcp\n`));
