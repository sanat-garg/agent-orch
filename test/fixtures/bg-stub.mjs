#!/usr/bin/env node
// Stand-in for a codex run whose tools leave background commands behind: starts `sleep 300` (and one that ignores
// SIGTERM), writes their pids to BG_STUB_PIDS as JSON, prints a completed turn and exits cleanly.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const bg = (args) => { const c = spawn(args[0], args.slice(1), { stdio: 'ignore' }); c.unref(); return c.pid; };
const plain = bg(['sleep', '300']);
const stubborn = bg(['sh', '-c', 'trap "" TERM; exec sleep 300']);
fs.writeFileSync(process.env.BG_STUB_PIDS, JSON.stringify({ plain, stubborn }));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'thread.started', thread_id: 'bg' });
out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Started the server.' } });
out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
