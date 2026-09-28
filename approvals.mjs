// The head's side of the approval gate (gate.mjs): approval records (table `approvals`), the owner's decisions, the
// 24 h expiry, "always allow this action for this task", and the audit log <DATA>/audit/<task>.jsonl (hash-chained).
// A local run's gate dir is hosted here (host()); a worker relays its requests as job events and gets each decision
// back as job.approval (deliver). Statuses: pending → approved | always | denied | expired | cancelled (the run ended);
// auto = allowed without asking because the owner chose "always" for that action earlier in the task.
// A run holds at most MAX_PENDING_PER_RUN pending approvals: a request past that is stored denied (decided_by 'cap') and
// answered at once, so a looping or hostile run can't pile up rows and owner notices (AUDIT #42).
import fs from 'node:fs';
import path from 'node:path';
import { APPROVAL_TTL_MS, appendAudit, hostGate, readAudit } from './gate.mjs';
import { MEDIA_ID_RE, saveMedia } from './media.mjs';

export const DECISIONS = { approve: 'approved', always: 'always', deny: 'denied' };
export const MAX_PENDING_PER_RUN = 20;
const CAP_NOTE = 'Too many held actions in one run: answer or stop the task';

export function createApprovals({ db, dataDir, boot = true, settings = () => ({}), deliver = () => false, onChange = () => {}, now = () => Date.now() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, task_id INTEGER NOT NULL, run_id INTEGER, node TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, server TEXT, tool TEXT, action TEXT, reason_class TEXT, key TEXT, url TEXT,
    args TEXT, screenshot TEXT, status TEXT NOT NULL DEFAULT 'pending', note TEXT, decided_at INTEGER, decided_by TEXT);
    CREATE INDEX IF NOT EXISTS approvals_task ON approvals(task_id, status);`);
  const q1 = (sql, p = {}) => db.prepare(sql).get(p);
  const qa = (sql, p = {}) => db.prepare(sql).all(p);
  const run = (sql, p = {}) => db.prepare(sql).run(p);
  const auditDir = path.join(dataDir, 'audit');
  const waiters = new Map(); // approval id → resolve(answer), for gate dirs hosted in this process
  const ttlMs = () => Math.max(60_000, Number(settings().ttlMs) || APPROVAL_TTL_MS);

  const view = (r) => r && ({
    id: r.id, task: r.task_id, run: r.run_id, node: r.node, at: r.created_at, expires: r.expires_at, server: r.server, tool: r.tool,
    action: r.action, why: r.reason_class, url: r.url, args: (() => { try { return JSON.parse(r.args); } catch { return null; } })(),
    screenshot: r.screenshot, status: r.status, note: r.note, decided_at: r.decided_at, by: r.decided_by,
  });
  const get = (id) => view(q1('SELECT * FROM approvals WHERE id=:id', { id: String(id) }));
  function send(row, ans) {
    const w = waiters.get(row.id);
    if (w) { waiters.delete(row.id); w(ans); return true; }
    return deliver(row, ans);
  }

  // A held call arrived: {approval (from the proxy), taskId, runId, node}. A replay of a known id re-sends its decision.
  function request({ approval: a, taskId, runId = null, node = 'controller' }) {
    const id = String(a?.id || '');
    if (!/^[\w-]{6,64}$/.test(id)) throw new Error('bad approval id');
    const old = get(id);
    if (old) {
      if (old.status !== 'pending' && old.status !== 'cancelled') send(old, answerOf(old));
      return old;
    }
    const t = now();
    const always = a.key && q1("SELECT id FROM approvals WHERE task_id=:t AND key=:k AND status='always'", { t: taskId, k: String(a.key) });
    const capped = !always && runId != null
      && q1("SELECT COUNT(*) AS n FROM approvals WHERE run_id=:r AND status='pending'", { r: runId }).n >= MAX_PENDING_PER_RUN;
    run(`INSERT INTO approvals(id,task_id,run_id,node,created_at,expires_at,server,tool,action,reason_class,key,url,args,screenshot,status,decided_at,decided_by,note)
      VALUES(:id,:task,:run,:node,:at,:exp,:server,:tool,:action,:why,:key,:url,:args,:shot,:status,:dec,:by,:note)`, {
      id, task: taskId, run: runId, node, at: t, exp: t + Math.min(ttlMs(), Number(a.ttlMs) || Infinity), server: str(a.server, 80), tool: str(a.tool, 120),
      action: str(a.action, 2000), why: str(a.reason, 200), key: str(a.key, 500), url: str(a.url, 2000), args: JSON.stringify(a.args ?? null).slice(0, 20_000),
      shot: MEDIA_ID_RE.test(a.screenshot || '') ? a.screenshot : null, status: always ? 'auto' : capped ? 'denied' : 'pending',
      dec: always || capped ? t : null, by: always ? 'always' : capped ? 'cap' : null,
      note: always ? `allowed by your earlier "always" (${always.id})` : capped ? CAP_NOTE : null,
    });
    const row = get(id);
    if (always) send(row, { decision: 'auto', by: 'always' });
    else if (capped) send(row, answerOf(row)); // decided_by='cap'
    else armExpiry();
    onChange(row, always ? 'auto' : capped ? 'decided' : 'new');
    return row;
  }
  const answerOf = (r) => ({ decision: { approved: 'approve', always: 'always', auto: 'auto', denied: 'deny', expired: 'expired' }[r.status] || 'deny', reason: r.note || undefined, by: r.by || undefined });

  // The owner's answer: decision approve | always | deny, with an optional reason (fed back to the agent on deny).
  function decide(id, { decision, reason = null, by = 'owner' } = {}) {
    const status = DECISIONS[decision];
    if (!status) throw new Error('decision must be approve, always or deny');
    const r = get(id);
    if (!r) throw new Error('No such approval');
    if (r.status !== 'pending') throw new Error(r.status === 'cancelled' ? 'That run has ended' : `Already ${r.status}`);
    run('UPDATE approvals SET status=:s, note=:n, decided_at=:t, decided_by=:b WHERE id=:id', { s: status, n: reason ? String(reason).slice(0, 1000) : null, t: now(), b: String(by).slice(0, 80), id: r.id });
    const row = get(id);
    send(row, answerOf(row));
    onChange(row, 'decided');
    armExpiry();
    return row;
  }
  let timer = null;
  function armExpiry() {
    clearTimeout(timer);
    const next = q1("SELECT MIN(expires_at) AS at FROM approvals WHERE status='pending'")?.at;
    if (next == null) return;
    timer = setTimeout(expire, Math.max(0, Math.min(next - now(), 2 ** 31 - 1)));
    timer.unref?.();
  }
  function expire() {
    for (const r of qa("SELECT id FROM approvals WHERE status='pending' AND expires_at<=:t", { t: now() })) {
      run("UPDATE approvals SET status='expired', note=:n, decided_at=:t, decided_by='timeout' WHERE id=:id", { n: `No answer within ${Math.round(ttlMs() / 3600_000)} h`, t: now(), id: r.id });
      const row = get(r.id);
      send(row, answerOf(row));
      onChange(row, 'decided');
    }
    armExpiry();
  }
  // A run ended (or the head restarted under a local run): what it was waiting for can't be answered any more.
  function endRun(runId) {
    const rows = qa("SELECT id FROM approvals WHERE run_id=:r AND status='pending'", { r: runId });
    for (const r of rows) {
      run("UPDATE approvals SET status='cancelled', decided_at=:t WHERE id=:id", { t: now(), id: r.id });
      waiters.delete(r.id);
      onChange(get(r.id), 'decided');
    }
    if (rows.length) armExpiry();
  }
  // A worker re-attached a job: decisions it may have missed while away go out again (it ignores ones it has).
  function resend(taskId, node) {
    for (const r of qa("SELECT * FROM approvals WHERE task_id=:t AND node=:n AND status NOT IN ('pending','cancelled') AND decided_at>:since", { t: taskId, n: node, since: now() - 2 * ttlMs() })) {
      const row = view(r);
      deliver(row, answerOf(row));
    }
  }
  const pending = (taskId = null) => qa(`SELECT * FROM approvals WHERE status='pending'${taskId != null ? ' AND task_id=:t' : ''} ORDER BY created_at`, taskId != null ? { t: taskId } : {}).map(view);
  const forTask = (taskId) => qa('SELECT * FROM approvals WHERE task_id=:t ORDER BY created_at', { t: taskId }).map(view);
  // How long a run has been held on the owner so far (its timeout doesn't count that time).
  function heldMs(runId) {
    const t = now();
    return qa('SELECT created_at, decided_at FROM approvals WHERE run_id=:r AND status!=\'auto\'', { r: runId })
      .reduce((s, r) => s + Math.max(0, (r.decided_at ?? t) - r.created_at), 0);
  }
  const auditFile = (taskId) => path.join(auditDir, `${Number(taskId)}.jsonl`);
  const audit = (taskId, entry) => appendAudit(auditFile(taskId), { ...entry, task: Number(taskId) });
  // The task drawer's Actions timeline: audit entries, newest last, plus approvals still waiting (not yet in the log).
  function actions(taskId, limit = 500) {
    const entries = readAudit(auditFile(taskId), { limit });
    return { entries, pending: pending(taskId) };
  }
  // Hosts a local run's gate dir: requests → records (answered via waiters), audit lines → the task's log, screenshots →
  // the media store (same sha256 ids). Returns stop().
  function host(dir, { taskId, runId }) {
    const shot = (id) => {
      if (!MEDIA_ID_RE.test(id || '')) return;
      try { saveMedia(dataDir, fs.readFileSync(path.join(dir, 'shots', id)), 'approval screenshot'); } catch {}
    };
    return hostGate(dir, {
      onRequest: (a) => new Promise((resolve) => {
        shot(a.screenshot);
        waiters.set(String(a.id), resolve);
        try { request({ approval: a, taskId, runId, node: 'controller' }); } catch (e) { waiters.delete(String(a.id)); resolve({ decision: 'deny', reason: e.message }); }
      }),
      onAudit: (e) => { shot(e.screenshot); audit(taskId, e); },
    });
  }
  // At boot: local runs died with the old process; remote ones may still be waiting (their worker keeps the call held).
  if (boot) {
    run("UPDATE approvals SET status='cancelled', decided_at=:t WHERE status='pending' AND node='controller'", { t: now() });
    armExpiry();
  }

  return { request, decide, resend, endRun, pending, forTask, get, heldMs, audit, actions, host, expire, stop: () => clearTimeout(timer) };
}
const str = (v, n) => (v == null ? null : String(v).slice(0, n));
