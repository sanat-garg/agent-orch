// The head's git endpoint for paired workers (BRIEF goal 11, #345): each project's repo over git's smart HTTP at
// GIT_PATH/<projectId>.git (cluster-protocol.mjs), so workers clone, fetch and push through the head and need no GitHub
// access; the head merges their task branches locally and pushes main to GitHub itself. `git http-backend` runs as a CGI
// per request (no deps). Auth: the node's bearer token (the worker's cache clone sends it as an http.extraHeader), never
// the owner's session. Fetch: any ref (uploadpack.allowFilter and allowAnySHA1InWant for the worker's blob-less clone).
// Push: the command list is read here before git sees the pack, and only refs/heads/agent-orch/task-<id> of tasks the
// head has on that node right now pass; anything else (main, another task's branch) is refused with 403.
//   createClusterGit({ node(headers) → node row | null, repo(projectId) → project dir | null,
//     pushable(nodeId, projectId) → task ids, log }) → { handle(req, res) → Promise<status> }
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GIT_PATH } from './cluster-protocol.mjs';

const execFileP = promisify(execFile);
const PATH_RE = new RegExp(`^${GIT_PATH}/(\\d+)\\.git(/info/refs|/git-upload-pack|/git-receive-pack)$`);
const SERVICES = ['git-upload-pack', 'git-receive-pack'];
export const MAX_PUSH_BYTES = 1 << 30;

// The refs a receive-pack request updates (its pkt-line command list up to the first flush), or null when it can't be read.
export function pushedRefs(buf) {
  const refs = [];
  for (let i = 0; i + 4 <= buf.length;) {
    const hex = buf.toString('latin1', i, i + 4);
    if (!/^[0-9a-f]{4}$/.test(hex)) return null;
    const len = parseInt(hex, 16);
    if (len === 0) return refs;
    if (len < 5 || i + len > buf.length) return null;
    const line = buf.toString('utf8', i + 4, i + len).split('\0')[0].replace(/\n$/, '');
    i += len;
    if (line.startsWith('shallow ')) continue;
    const m = /^[0-9a-f]{40,64} [0-9a-f]{40,64} (\S+)$/.exec(line);
    if (!m) return null;
    refs.push(m[1]);
  }
  return null;
}

async function readAll(req, max) {
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > max) return null; chunks.push(c); }
  return Buffer.concat(chunks);
}

export function createClusterGit({ node, repo, pushable, log = () => {} }) {
  const dirs = new Map(); // project id -> {dir, at}: its git common dir, re-read after a minute
  async function gitDir(pid) {
    const hit = dirs.get(pid);
    if (hit && Date.now() - hit.at < 60_000) return hit.dir;
    const cwd = repo(pid);
    const dir = cwd ? await execFileP('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' })
      .then((r) => r.stdout.trim(), () => null) : null;
    dirs.set(pid, { dir, at: Date.now() });
    return dir;
  }

  async function handle(req, res) {
    const reply = (status, text = '', headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(text);
      return status;
    };
    const url = new URL(req.url, 'http://head');
    const m = PATH_RE.exec(url.pathname);
    const row = node(req.headers);
    if (!row) return reply(401, 'this machine is not paired with this head\n', { 'WWW-Authenticate': 'Bearer realm="agent-orch"' });
    if (!row.enabled) return reply(403, 'this machine is disabled on this head\n');
    // Smart HTTP only: GET info/refs?service=…, POST git-upload-pack / git-receive-pack.
    const service = m && (m[2] === '/info/refs' ? url.searchParams.get('service') : m[2].slice(1));
    if (!m || !SERVICES.includes(service) || req.method !== (m[2] === '/info/refs' ? 'GET' : 'POST')) return reply(404);
    const pid = Number(m[1]), dir = await gitDir(pid);
    if (!dir) return reply(404, `no project ${pid} on this head\n`);
    let body = null;
    if (m[2] === '/git-receive-pack') {
      body = await readAll(req, MAX_PUSH_BYTES);
      if (!body) return reply(413, 'push too large\n');
      let cmds = body;
      if (/gzip/i.test(req.headers['content-encoding'] || '')) { try { cmds = zlib.gunzipSync(body); } catch { cmds = Buffer.alloc(0); } }
      const refs = pushedRefs(cmds), mine = new Set([...pushable(row.id, pid)].map((id) => `refs/heads/agent-orch/task-${id}`));
      const bad = refs ? refs.filter((r) => !mine.has(r)) : ['(unreadable push)'];
      if (bad.length) {
        log(`node ${row.id}: push to ${bad.join(', ')} in project ${pid} refused`);
        return reply(403, `agent-orch: ${row.name} may push only the branches of its own running tasks, not ${bad.join(', ')}\n`);
      }
    }
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, GIT_PROJECT_ROOT: path.dirname(dir), PATH_INFO: `/${path.basename(dir)}${m[2]}`,
      GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: `node-${row.id}`, REMOTE_ADDR: req.socket.remoteAddress || '',
      REQUEST_METHOD: req.method, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] || '',
      ...(body ? { CONTENT_LENGTH: String(body.length) } : req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
      ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
      ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: req.headers['git-protocol'] } : {}),
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'http.receivepack', GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'uploadpack.allowFilter', GIT_CONFIG_VALUE_1: 'true', GIT_CONFIG_KEY_2: 'uploadpack.allowAnySHA1InWant', GIT_CONFIG_VALUE_2: 'true',
    };
    const cgi = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    cgi.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    cgi.stdin.on('error', () => {});
    if (body) cgi.stdin.end(body);
    else if (req.method === 'POST') req.pipe(cgi.stdin);
    else cgi.stdin.end();
    return new Promise((resolve) => {
      let head = Buffer.alloc(0), status = 0, done = false;
      const fail = (why) => {
        if (done) return;
        done = true;
        log(`node ${row.id}: git ${service} for project ${pid} failed: ${why}`);
        if (!res.headersSent) reply(500, 'git failed\n'); else res.destroy();
        resolve(500);
      };
      cgi.on('error', (e) => fail(e.message));
      cgi.stdout.on('data', (d) => {
        if (status) return void res.write(d);
        head = Buffer.concat([head, d]);
        const s = head.toString('latin1'), end = s.search(/\r?\n\r?\n/);
        if (end < 0) { if (head.length > 64 << 10) { cgi.kill(); fail('no CGI headers'); } return; }
        const headers = {};
        for (const l of s.slice(0, end).split(/\r?\n/)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
        status = Number(/^\d{3}/.exec(headers.Status || '')?.[0]) || 200;
        delete headers.Status;
        res.writeHead(status, headers);
        res.write(head.subarray(end + /^\r?\n\r?\n/.exec(s.slice(end))[0].length));
      });
      cgi.on('close', (code) => {
        if (!status) return fail(err.trim().split('\n').pop() || `exit ${code}`);
        if (done) return;
        done = true;
        if (code) log(`node ${row.id}: git ${service} for project ${pid} exited ${code}: ${err.trim().split('\n').pop() || ''}`);
        res.end();
        resolve(status);
      });
    });
  }

  return { handle };
}
