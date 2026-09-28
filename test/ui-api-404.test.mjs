// A page newer than its server (#459): app.js api() meets a bare 404 on an /api/ route the old server doesn't know yet.
// The owner sees 'The server is updating, try again in a moment' instead of 'Request failed (404)', and the call is retried
// once the ws 'version' frame (onVersion, sent on every connect) reports a newer build. A 404 with a JSON error (a real
// "No such task") and non-/api/ URLs are unchanged. api(), its helpers and onVersion are pulled out of app.js's source
// and run against a fake fetch, like version-ui's aboutLines, so no browser is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const src = (re) => { const m = appJs.match(re); assert.ok(m, `app.js: ${re}`); return m[0]; };
const code = [/^async function api\(.*?^}$/ms, /^const API_UPDATING = .*$/m, /^const API_WAIT = .*$/m, /^async function apiAfterUpdate\(.*?^}$/ms,
  /^function apiServerVersion\(.*?^}$/ms, /^function onVersion\(.*?^}$/ms, /^function fmtVersion\(.*$/m].map(src).join('\n');

// A fresh app: `routes` answers fetch by url, in order (the last answer repeats); running = the server's build.
function app(routes, running = { build: 415 }) {
  const toasts = [], fetched = [], mem = {};
  const fetch = async (url) => {
    fetched.push(url);
    const list = routes[url] || [{ status: 404, text: 'Not found' }];
    const a = list.length > 1 ? list.shift() : list[0];
    return { status: a.status, ok: a.status < 400, json: async () => (a.json ? a.json : JSON.parse(a.text)) };
  };
  const env = { fetch, toast: (m, o) => toasts.push(m), location: {}, VER: { running }, store: { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } },
    renderSideVer() {}, loadAbout() {}, $: () => ({ hidden: true }) };
  const f = new Function(...Object.keys(env), `${code}\nreturn { api, onVersion, API_UPDATING, API_WAIT };`)(...Object.values(env));
  return { ...f, toasts, fetched };
}
const settled = (p) => Promise.race([p.then((v) => ({ v }), (e) => ({ e: e.message })), new Promise((r) => setTimeout(() => r('pending'), 30))]);

test('a bare 404 on an /api/ route shows the friendly message and retries once a newer build says hello', async () => {
  const a = app({ '/api/cluster/nodes/w1/assignable': [{ status: 404, text: 'Not found' }, { status: 200, json: { tasks: [7] } }] });
  assert.equal(a.API_UPDATING, 'The server is updating, try again in a moment');
  const p = a.api('/api/cluster/nodes/w1/assignable');
  assert.equal(await settled(p), 'pending', 'it waits for the new server');
  assert.deepEqual(a.toasts, [a.API_UPDATING], 'not "Request failed (404)"');
  a.onVersion({ build: 415 }); // a reconnect to the same old server
  assert.equal(await settled(p), 'pending');
  a.onVersion({ build: 416, sha: 'abc' }); // the hello of the restarted server
  assert.deepEqual(await settled(p), { v: { tasks: [7] } });
  assert.deepEqual(a.fetched, ['/api/cluster/nodes/w1/assignable', '/api/cluster/nodes/w1/assignable']);
  assert.equal(a.API_WAIT.waiters.length, 0);

  // Several calls at once: one toast, all retried.
  const m = app({ '/api/x': [{ status: 404, text: 'Not found' }, { status: 200, json: { ok: 1 } }] });
  const [p1, p2] = [m.api('/api/x'), m.api('/api/x')];
  await settled(p1);
  assert.deepEqual(m.toasts, [m.API_UPDATING]);
  m.onVersion({ build: 500 });
  assert.deepEqual([await p1, await p2], [{ ok: 1 }, { ok: 1 }]);

  // A page that never saw a build (hello not in yet) takes the next hello as the new server.
  const n = app({ '/api/y': [{ status: 404, text: 'Not found' }, { status: 200, json: { y: 1 } }] }, null);
  const py = n.api('/api/y');
  await settled(py);
  n.onVersion({ build: 3 });
  assert.deepEqual(await py, { y: 1 });
});

test('the retry is once, the wait is capped, and real 404s and non-API urls are unchanged', async () => {
  // Still 404 after the new build: the raw error, no second retry.
  const a = app({ '/api/gone': [{ status: 404, text: 'Not found' }] });
  const p = a.api('/api/gone');
  await settled(p);
  a.onVersion({ build: 416 });
  assert.deepEqual(await settled(p), { e: 'Request failed (404)' });
  assert.equal(a.fetched.length, 2);

  // No newer build within API_WAIT.ms: the friendly message as the error.
  const t = app({});
  t.API_WAIT.ms = 20;
  assert.deepEqual(await settled(t.api('/api/new-thing')), { e: t.API_UPDATING });
  assert.equal(t.API_WAIT.waiters.length, 0);

  // A route the server knows answering 404 with its own error, and a non-/api/ url: thrown at once, no toast.
  const r = app({ '/api/orch/tasks/9': [{ status: 404, json: { error: 'No such task' } }] });
  assert.deepEqual(await settled(r.api('/api/orch/tasks/9')), { e: 'No such task' });
  assert.deepEqual(await settled(r.api('/shell/x')), { e: 'Request failed (404)' });
  assert.deepEqual(r.toasts, []);
  assert.equal(r.fetched.length, 2);
});
