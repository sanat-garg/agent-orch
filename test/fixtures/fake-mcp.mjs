// A stand-in stdio MCP server (test/browser-live.test.mjs): answers initialize, and every tools/call with the argv it
// was started with, so a test sees both when a call got through and how the shim launched it.
import readline from 'node:readline';
const out = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: m.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  else if (m.method === 'tools/call') out({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ tool: m.params?.name, argv: process.argv.slice(2) }) }] } });
});
