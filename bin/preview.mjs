#!/usr/bin/env node
// Publish the project this runs in as a live preview and print its link (owner, 2026-10-24: agents create previews
// themselves and give the link, instead of asking the owner to deploy). Run from anywhere inside a project folder or one
// of its task worktrees; it talks to the agent-orch head on this machine (<data>/agent-api.json, written at each boot).
//   node bin/preview.mjs [name]      give the project https://<name or folder>.<default domain> (keeps one it already has)
//   node bin/preview.mjs --logs      the preview's last log lines
//   node bin/preview.mjs --restart   redeploy it
// Exit 1 on any error (the message says why).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: {
  logs: { type: 'boolean' }, restart: { type: 'boolean' },
  data: { type: 'string', default: process.env.CW_DATA_DIR || path.join(ROOT, 'data') },
} });
const fail = (m) => { console.error(m); process.exit(1); };

// A task worktree's main tree is where the preview is served from: git's common dir is <main tree>/.git.
let dir = process.cwd();
try {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (path.basename(common) === '.git') dir = path.dirname(common);
} catch {}

let api;
try { api = JSON.parse(fs.readFileSync(path.join(opt.data, 'agent-api.json'), 'utf8')); }
catch { fail("This machine isn't running the agent-orch head, so it can't publish previews here. Say in your reply that the project still needs a live preview."); }

const action = opt.logs ? 'logs' : opt.restart ? 'restart' : null;
let r, body;
try {
  r = await fetch(`${api.url}/api/agent/preview`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-orch-key': api.key },
    body: JSON.stringify({ dir, name: positionals[0] || null, action }), signal: AbortSignal.timeout(120_000) });
  body = await r.json();
} catch (e) { fail(`agent-orch didn't answer (${e.message}).`); }
if (!r.ok) fail(body.error || `agent-orch answered ${r.status}.`);

const v = body.preview;
if (action === 'logs') { process.stdout.write(body.text ? `${body.text.replace(/\n?$/, '\n')}` : '(no log lines yet)\n'); process.exit(0); }
console.log(v.url);
const status = { running: 'running', building: 'building', installing: 'installing', waiting: 'waiting for something to serve', error: 'failed', stopped: 'stopped' }[v.status] || v.status;
console.log(`${action === 'restart' ? 'Redeploying. ' : body.existed ? 'Already published. ' : 'Published. '}Status: ${status}${v.kind ? ` (${v.kind})` : ''}.`
  + (v.cert === 'pending' ? ' The HTTPS certificate is still being issued: the link works within a minute.' : v.cert === 'failed' ? ' No HTTPS certificate yet: Caddy keeps retrying.' : ''));
if (v.error) console.log(`Note: ${v.error}`);
