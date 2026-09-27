#!/usr/bin/env node
// Stand-in `caffeinate` for the macOS worker tests: logs its start (argv) and its stop as JSON lines to $CAFFEINATE_LOG,
// and exits like the real one when the process it watches (-w <pid>) exits, or when it is signalled.
import fs from 'node:fs';

const log = (e) => fs.appendFileSync(process.env.CAFFEINATE_LOG, JSON.stringify({ ...e, pid: process.pid, at: Date.now() }) + '\n');
const args = process.argv.slice(2), watch = Number(args[args.indexOf('-w') + 1]);
log({ event: 'start', args });
const stop = (why) => { log({ event: 'stop', why }); process.exit(0); };
process.on('SIGTERM', () => stop('SIGTERM'));
setInterval(() => { try { process.kill(watch, 0); } catch { stop('the watched process exited'); } }, 200);
