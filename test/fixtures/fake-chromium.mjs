#!/usr/bin/env node
// A stand-in Chromium for tests on machines where a real one can't run (a macOS LaunchDaemon session): a DevTools
// endpoint (/json/version, plus a browser websocket that answers every call and exits on Browser.close), announced
// through <profile>/DevToolsActivePort as Chromium does. Takes Chromium's flags; reads only --user-data-dir.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const dir = process.argv.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
const id = crypto.randomUUID(), portFile = path.join(dir, 'DevToolsActivePort');
const server = http.createServer((req, res) => {
  if (req.url !== '/json/version') { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ Browser: 'FakeChromium/1.0', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/${id}` }));
});
const quit = () => { fs.rmSync(portFile, { force: true }); process.exit(0); };
new WebSocketServer({ server }).on('connection', (ws) => ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  ws.send(JSON.stringify({ id: m.id, result: {} }), () => { if (m.method === 'Browser.close') quit(); });
}));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, quit);
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, `${server.address().port}\n/devtools/browser/${id}\n`));
