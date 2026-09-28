#!/usr/bin/env node
// A stand-in for @playwright/mcp (stdio, newline-delimited JSON-RPC): one "compose" page with To / Password / Subject
// fields and Send / Save draft buttons. Clicking Send marks the page sent. It doubles as a mail connector (search_messages,
// send_email). Every executed tools/call is appended to $FAKE_MCP_LOG (one JSON line), so a test can tell a held or
// denied call never ran. FAKE_MCP_SNAPSHOT=error makes browser_snapshot fail (isError); =hang makes it never answer.
import fs from 'node:fs';

const logFile = process.env.FAKE_MCP_LOG, snapMode = process.env.FAKE_MCP_SNAPSHOT || '';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let page = null;
const reset = (url) => { page = { url, to: 'bob@example.com', subject: '', password: '', status: 'Not sent' }; };
const snapshot = () => (page ? `### Page
- Page URL: ${page.url}
- Page Title: Compose
### Snapshot
\`\`\`yaml
- generic [ref=e1]:
  - textbox "To" [ref=e2]: ${page.to}
  - textbox "Password" [ref=e7]${page.password ? `: ${page.password}` : ''}
  - textbox "Subject" [ref=e5]${page.subject ? `: ${page.subject}` : ''}
  - link "Checkout" [ref=e8] [cursor=pointer]:
    - /url: /shop/checkout
  - button "Send" [ref=e3] [cursor=pointer]
  - button "Save draft" [ref=e4]
  - button [ref=e9]:
    - text: Delete
  - paragraph [ref=e6]: ${page.status}
\`\`\`` : '### Page\n- Page URL: about:blank');
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const TOOLS = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_take_screenshot', 'browser_evaluate', 'search_messages', 'send_email'];

function call(name, a = {}) {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ name, args: a })}\n`);
  switch (name) {
    case 'browser_navigate': reset(a.url); return text(`### Ran Playwright code\nawait page.goto('${a.url}');\n${snapshot()}`);
    case 'browser_snapshot': return snapMode === 'error' ? { ...text('Error: page crashed'), isError: true } : text(snapshot());
    case 'browser_take_screenshot': return { content: [{ type: 'text', text: '### Result\n- Screenshot of viewport' }, { type: 'image', data: PNG, mimeType: 'image/png' }] };
    case 'browser_click': {
      if (!page) return { ...text('No page open'), isError: true };
      if (a.target === 'e3') page.status = 'Sent!';
      if (a.target === 'e9') page.status = 'Deleted';
      return text(`### Ran Playwright code\nawait page.click();\n${snapshot()}`);
    }
    case 'browser_type': {
      if (a.target === 'e5') page.subject = a.text;
      if (a.target === 'e7') page.password = '••••';
      return text(snapshot());
    }
    case 'browser_evaluate': return text('### Result\n"ok"');
    case 'search_messages': return text('2 messages: "Invoice 42", "Lunch"');
    case 'send_email': return text(`Sent to ${a.to}`);
    default: return { ...text(`Unknown tool ${name}`), isError: true };
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id == null) continue;
    let result;
    if (m.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-browser', version: '1' } };
    else if (m.method === 'tools/list') result = { tools: TOOLS.map((name) => ({ name, inputSchema: { type: 'object' } })) };
    else if (m.method === 'tools/call' && m.params?.name === 'browser_snapshot' && snapMode === 'hang') {
      if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ name: 'browser_snapshot', args: {}, hung: true })}\n`);
      continue;
    } else if (m.method === 'tools/call') result = call(m.params?.name, m.params?.arguments || {});
    else { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } })}\n`); continue; }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n`);
  }
});
process.stdin.on('end', () => process.exit(0));
