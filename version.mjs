// Which agent-orch build runs and which one waits on disk (Settings → About, GET /api/version, the Machines view).
// A build number is `git rev-list --count <sha>`: it only grows along main, so "412" beats a sha for humans.
// createVersion({dir, boot?, unit?}): `running()` = the build captured at boot {build, sha, subject, committedAt,
// startedAt, serviceStartedAt} (times epoch ms; serviceStartedAt = systemd's ActiveEnterTimestamp when this process is
// a systemd service, else null); `disk()` = the checkout's HEAD {build, sha, subject, ahead} (ahead: commits newer than
// the running one), read on request; `buildOf(sha)` = a cached build number for another checkout's sha (null until
// the count lands, or when this repo doesn't have it). `ready` resolves once the boot read finished.
import { execFile } from 'node:child_process';

const git = (cwd, args) => new Promise((resolve) => execFile('git', args, { cwd, timeout: 5000 }, (err, out) => resolve(err ? '' : out.trim())));
const SHA_RE = /^[0-9a-f]{40}$/;

// {build, sha, subject, committedAt} of `rev` in `dir`, or null when it isn't a git checkout (or has no such rev).
export async function readBuild(dir, rev = 'HEAD') {
  const [log, count] = await Promise.all([git(dir, ['log', '-1', '--format=%H%x00%ct%x00%s', rev, '--']), git(dir, ['rev-list', '--count', rev, '--'])]);
  const [sha, ct, subject = ''] = log.split('\0');
  if (!SHA_RE.test(sha || '')) return null;
  return { build: Number(count) || null, sha, subject, committedAt: Number(ct) * 1000 || null };
}

// How many commits `to` has that `from` doesn't (0 when either is unknown).
export async function commitsAhead(dir, from, to = 'HEAD') {
  if (!from || from === to) return 0;
  return Number(await git(dir, ['rev-list', '--count', `${from}..${to}`, '--'])) || 0;
}

// When systemd last started `unit`, from its monotonic stamp (no timezone parsing), or null off systemd.
function serviceStart(unit) {
  if (process.platform !== 'linux' || !process.env.INVOCATION_ID) return Promise.resolve(null);
  return new Promise((resolve) => execFile('systemctl', ['show', '-P', 'ActiveEnterTimestampMonotonic', unit], { timeout: 5000 }, (err, out) => {
    const us = Number(String(out).trim());
    if (err || !us) return resolve(null);
    resolve(Math.round(Date.now() - (Number(process.hrtime.bigint() / 1000n) - us) / 1000));
  }));
}

export function createVersion({ dir, boot = '', unit = 'agent-orch.service' }) {
  const running = { build: null, sha: '', subject: '', committedAt: null, startedAt: Math.round(Date.now() - process.uptime() * 1000), serviceStartedAt: null };
  const ready = Promise.all([
    readBuild(dir, boot || 'HEAD').then((b) => { if (b) Object.assign(running, b); }),
    serviceStart(unit).then((t) => { running.serviceStartedAt = t; }),
  ]);
  async function disk() {
    await ready;
    const d = await readBuild(dir);
    if (!d) return null;
    return { build: d.build, sha: d.sha, subject: d.subject, ahead: running.sha && d.sha !== running.sha ? await commitsAhead(dir, running.sha, d.sha) : 0 };
  }
  const builds = new Map();
  function buildOf(sha) {
    if (!SHA_RE.test(sha || '')) return null;
    if (sha === running.sha) return running.build;
    if (!builds.has(sha)) {
      if (builds.size > 200) builds.clear();
      builds.set(sha, null);
      git(dir, ['rev-list', '--count', sha, '--']).then((n) => builds.set(sha, Number(n) || null));
    }
    return builds.get(sha);
  }
  return { ready, running: () => ({ ...running }), disk, buildOf };
}
