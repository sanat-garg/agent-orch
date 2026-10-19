'use strict';
// ---------- Schedules (server: cron.mjs + orchestrator `schedules`) ----------
// Cron jobs: whenever a schedule's time comes round (in the owner's time zone, this browser's) the server runs its
// command in the project folder (cron-run.mjs; Output shows each run's exit code and output, GET …/runs), or, for an
// "Ask an agent" schedule, queues a task. The sidebar's "Schedules" sheet lists every project's, with on/off, Run now,
// Output, Edit and Delete; the editor builds the cron from simple choices (or takes one typed) and checks it live
// (GET /api/orch/cron-preview). Copy opens the editor as a draft of a new schedule prefilled from one (any project,
// its zone, agent and model kept; never its runs) that saves switched off. The chat planner makes them too ("every night at 2, run the scraper"). Loaded after app.js and uses its helpers
// ($, el, api, toast, fmtWhen, closeSidebar, coarse, routeHash, O).
(() => {
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const SC = { projects: [], list: [], loaded: false, edit: null, lastFocus: null, reload: 0, open: new Set() };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const JOB = { running: 'running…', ok: 'finished', failed: 'failed', timeout: 'stopped after 1 hour', interrupted: 'interrupted' };
  const jobText = (j) => (j.status === 'failed' && j.exit_code != null ? `failed (exit ${j.exit_code})` : JOB[j.status] || j.status);
  const took = (j) => { const s = Math.round((j.finished_at || Date.now() / 1000) - j.started_at); return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`; };
  const STATUS = { queued: 'queued', running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled', paused: 'paused', needs_integration: 'merging' };
  const pad = (n) => String(n).padStart(2, '0');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const btn = (cls, text, onclick) => { const b = el('button', cls, text); b.type = 'button'; if (onclick) b.onclick = onclick; return b; };

  async function load() {
    try {
      const r = await api(`/api/orch/schedules?tz=${encodeURIComponent(TZ)}`);
      SC.projects = r.projects; SC.list = r.schedules; SC.loaded = true;
    } catch (e) { SC.error = e.message; }
  }

  // ---- the simple choices ⇄ a cron expression
  const PRESETS = [['minutes', 'Every few minutes'], ['hours', 'Every few hours'], ['daily', 'Every day'], ['weekdays', 'Every weekday'],
    ['weekly', 'Every week'], ['monthly', 'Every month'], ['custom', 'Custom (cron)']];
  function toCron(f) {
    const [h, m] = (f.time || '09:00').split(':').map(Number);
    switch (f.preset) {
      case 'minutes': return `*/${f.every} * * * *`;
      case 'hours': return f.every === 1 ? '0 * * * *' : `0 */${f.every} * * *`;
      case 'daily': return `${m} ${h} * * *`;
      case 'weekdays': return `${m} ${h} * * 1-5`;
      case 'weekly': return `${m} ${h} * * ${[...f.days].sort().join(',') || '1'}`;
      case 'monthly': return `${m} ${h} ${f.dom} * *`;
      default: return f.cron.trim();
    }
  }
  function fromCron(cron) {
    const f = { preset: 'custom', cron, every: 15, time: '09:00', days: new Set([1]), dom: 1 };
    const p = String(cron || '').trim().split(/\s+/);
    if (p.length !== 5) return f;
    const [mi, ho, dom, mon, dow] = p, num = (s) => (/^\d+$/.test(s) ? Number(s) : null);
    const step = (s) => /^\*\/(\d+)$/.exec(s)?.[1];
    if (num(mi) != null && num(ho) != null) f.time = `${pad(num(ho))}:${pad(num(mi))}`;
    if (step(mi) && ho === '*' && dom === '*' && mon === '*' && dow === '*' && [5, 10, 15, 30].includes(+step(mi))) return { ...f, preset: 'minutes', every: +step(mi) };
    if (mi === '0' && dom === '*' && mon === '*' && dow === '*' && (ho === '*' || [2, 3, 4, 6, 8, 12].includes(+step(ho)))) return { ...f, preset: 'hours', every: ho === '*' ? 1 : +step(ho) };
    if (num(mi) == null || num(ho) == null || mon !== '*') return f;
    if (dom === '*' && dow === '*') return { ...f, preset: 'daily' };
    if (dom === '*' && dow === '1-5') return { ...f, preset: 'weekdays' };
    if (dom === '*' && /^[0-6](,[0-6])*$/.test(dow)) return { ...f, preset: 'weekly', days: new Set(dow.split(',').map(Number)) };
    if (dow === '*' && num(dom) != null && num(dom) <= 28) return { ...f, preset: 'monthly', dom: num(dom) };
    return f;
  }

  function open(opts = {}) {
    closeSidebar();
    if ($('schedModal').hidden) SC.lastFocus = document.activeElement;
    $('schedModal').hidden = false;
    SC.edit = opts.edit ?? null;
    render();
    load().then(() => { if (opts.create) startEdit(null, opts.projectId); else render(); });
    if (!coarse) $('schedModal').querySelector('[data-close].icon-btn').focus();
  }
  function close() {
    if ($('schedModal').hidden) return;
    $('schedModal').hidden = true;
    SC.edit = null;
    SC.lastFocus?.focus?.();
  }

  function render() {
    if ($('schedModal').hidden || SC.edit) return;
    const body = $('scBody');
    const top = el('div', 'sc-top');
    top.append(el('p', 'sc-hint', `Like cron: at the times you set, in your time zone (${TZ}), the server runs a command in the project folder. You can also ask in chat, e.g. "every night at 2, run the scraper".`),
      btn('btn small primary', 'New schedule', () => startEdit(null)));
    const parts = [top];
    if (!SC.loaded) parts.push(el('p', 'sc-empty', SC.error || 'Loading…'));
    else if (!SC.projects.length) parts.push(el('p', 'sc-empty', 'Start a project first: schedules run tasks inside a project.'));
    else if (!SC.list.length) parts.push(el('p', 'sc-empty', 'No schedules yet.'));
    for (const p of SC.projects) {
      const rows = SC.list.filter((s) => s.project_id === p.id);
      if (!rows.length) continue;
      const sec = el('section', 'sc-sec');
      sec.append(el('h3', '', p.name), ...rows.map(row));
      parts.push(sec);
    }
    body.replaceChildren(...parts);
  }

  function row(s) {
    const r = el('div', `sc-row${s.enabled ? '' : ' off'}`);
    const head = el('div', 'sc-head');
    const sw = document.createElement('input');
    sw.type = 'checkbox'; sw.className = 'st-switch'; sw.setAttribute('role', 'switch'); sw.checked = s.enabled;
    sw.setAttribute('aria-label', `${s.title}: ${s.enabled ? 'on' : 'off'}`);
    sw.onchange = () => save(s.id, { enabled: sw.checked, tz: s.tz }, sw.checked ? `${s.title} is on` : `${s.title} is off`);
    head.append(el('span', 'sc-title', s.title), sw);
    const what = s.kind === 'command' ? el('code', 'sc-cmd', s.command.split('\n')[0]) : el('div', 'sc-agent', 'Agent task');
    if (s.kind === 'command') what.title = s.command;
    const when = el('div', 'sc-when');
    when.append(el('span', 'sc-cron', s.when + (s.tz !== TZ ? ` (${s.tz})` : '')));
    if (s.enabled && s.next_run_at) when.append(el('span', '', ` · Next ${fmtWhen(s.next_run_at * 1000)}`));
    else if (!s.enabled) when.append(el('span', '', ' · Off'));
    const meta = el('div', 'sc-meta');
    if (s.last_job) {
      const j = s.last_job;
      meta.append(el('span', `sc-job ${j.status}`, `Last run ${jobText(j)}`), `, ${fmtWhen(j.started_at * 1000)}${j.status === 'running' ? '' : ` in ${took(j)}`} · ${plural(s.runs, 'run')}`);
    } else if (s.last_task) {
      const a = btn('sc-task', `#${s.last_task.id}`, () => { close(); routeHash(`task-${s.last_task.id}`); });
      a.title = 'Open the task from the last run';
      meta.append('Last run ', a, ` ${STATUS[s.last_task.status] || s.last_task.status}${s.last_run_at ? `, ${fmtWhen(s.last_run_at * 1000)}` : ''} · ${plural(s.runs, 'run')}`);
    } else meta.append('Not run yet');
    if (s.skipped) meta.append(` · ${plural(s.skipped, 'run')} skipped while the previous one was still going`);
    if (s.created_by === 'planner') meta.append(' · made from chat');
    else if (s.created_by === 'project') meta.append(' · logged by the project');
    const acts = el('div', 'sc-acts');
    const run = btn('btn small', 'Run now', async () => {
      run.disabled = true;
      try {
        const x = await api(`/api/orch/schedules/${s.id}/run`, 'POST');
        toast(x.task ? `Queued #${x.task}: ${s.title}` : `Started: ${s.title}`, { kind: 'success' });
        await load(); render();
      }
      catch (e) { toast(e.message, { kind: 'error' }); } finally { run.disabled = false; }
    });
    const edit = btn('btn small', 'Edit', () => startEdit(s));
    const copy = btn('btn small', 'Copy', () => startEdit(null, null, s));
    const out = el('div', 'sc-out');
    out.hidden = !SC.open.has(s.id);
    const log = s.kind === 'command' && btn('btn small', 'Output', () => {
      if (SC.open.has(s.id)) SC.open.delete(s.id); else SC.open.add(s.id);
      out.hidden = !SC.open.has(s.id);
      log.setAttribute('aria-expanded', String(!out.hidden));
      if (!out.hidden) runs(s, out);
    });
    if (log) { log.setAttribute('aria-expanded', String(!out.hidden)); if (!out.hidden) runs(s, out); }
    const del = btn('btn small danger', 'Delete', async () => {
      if (!confirm(s.kind === 'command' ? `Delete the schedule "${s.title}"?${s.last_job?.status === 'running' ? ' Its run in progress is stopped.' : ''}`
        : `Delete the schedule "${s.title}"? Tasks it already queued stay.`)) return;
      try { await api(`/api/orch/schedules/${s.id}`, 'DELETE'); await load(); render(); } catch (e) { toast(e.message, { kind: 'error' }); }
    });
    acts.append(...[run, log, edit, copy, del].filter(Boolean));
    r.append(head, what, when, meta, acts, out);
    return r;
  }

  // A command schedule's latest runs, newest first: the newest one's output shown, older ones folded.
  async function runs(s, box) {
    if (!box.childElementCount) box.append(el('p', 'sc-empty', 'Loading…'));
    let list;
    try { list = (await api(`/api/orch/schedules/${s.id}/runs`)).runs; } catch (e) { box.replaceChildren(el('p', 'sc-empty', e.message)); return; }
    if (!list.length) { box.replaceChildren(el('p', 'sc-empty', 'Not run yet.')); return; }
    box.replaceChildren(...list.map((j, i) => {
      const d = document.createElement('details');
      d.className = 'sc-run'; d.open = i === 0;
      const sum = el('summary', '');
      sum.append(el('span', `sc-job ${j.status}`, jobText(j)), ` · ${fmtWhen(j.started_at * 1000)}${j.status === 'running' ? '' : ` · ${took(j)}`}${j.manual ? ' · Run now' : ''}`);
      d.append(sum, el('pre', 'sc-pre', j.output || '(no output)'));
      return d;
    }));
  }

  async function save(id, fields, ok) {
    try { await api(`/api/orch/schedules/${id}`, 'PATCH', fields); if (ok) toast(ok, { kind: 'success' }); }
    catch (e) { toast(e.message, { kind: 'error' }); }
    await load(); render();
  }

  // ---- the editor (in place of the list)
  function field(label, input, hint) {
    const w = el('label', 'sc-field');
    w.append(el('span', 'sc-label', label), input);
    if (hint) w.append(el('small', 'sc-fhint', hint));
    return w;
  }
  // s: the schedule being edited (null for a new one); src: the one a copy is drafted from (saved as a new, paused schedule).
  function startEdit(s, projectId, src = null) {
    const curProject = SC.projects.find((p) => p.path === O.project?.path)?.id;
    const from = s || src, tz = from?.tz || TZ;
    SC.edit = { id: s?.id ?? null, projectId: from?.project_id ?? projectId ?? curProject ?? SC.projects[0]?.id, ...fromCron(from?.cron || '0 9 * * *') };
    const f = SC.edit, body = $('scBody');
    const form = el('form', 'sc-form');
    form.noValidate = true;
    const proj = document.createElement('select');
    for (const p of SC.projects) { const o = el('option', '', p.name); o.value = p.id; proj.append(o); }
    proj.value = f.projectId ?? '';
    proj.disabled = !!s;
    const title = document.createElement('input');
    title.maxLength = 200; title.value = s?.title || (src ? `${src.title} (copy)`.slice(0, 200) : ''); title.placeholder = 'e.g. Nightly scrape'; title.required = true;
    let kind = from?.kind || 'command';
    const command = document.createElement('textarea');
    command.rows = 3; command.value = from?.command || ''; command.className = 'sc-cmdin'; command.placeholder = 'e.g. npm run scrape';
    command.spellcheck = false; command.autocapitalize = 'none'; command.setAttribute('autocorrect', 'off');
    const prompt = document.createElement('textarea');
    prompt.rows = 4; prompt.value = from?.prompt || ''; prompt.placeholder = 'What the task should do each time, e.g. "Read new email, file receipts in Drive and list what needs my reply."';
    const preset = document.createElement('select');
    for (const [v, t] of PRESETS) { const o = el('option', '', t); o.value = v; preset.append(o); }
    preset.value = f.preset;
    const params = el('div', 'sc-params');
    const preview = el('div', 'sc-preview');
    preview.setAttribute('aria-live', 'polite');
    const doneWhen = document.createElement('input');
    doneWhen.value = from?.done_when || ''; doneWhen.placeholder = 'Optional, e.g. npm test';
    const err = el('div', 'sc-err');
    err.setAttribute('role', 'alert');
    const cancel = btn('btn', 'Cancel', () => { SC.edit = null; render(); });
    const submit = el('button', 'btn primary', s ? 'Save' : src ? 'Save paused copy' : 'Add schedule');
    submit.type = 'submit';
    const foot = el('div', 'sc-foot');
    foot.append(cancel, submit);

    let seq = 0, timer = 0;
    const check = () => {
      clearTimeout(timer);
      const cron = toCron(f), n = ++seq;
      if (!cron) { preview.textContent = ''; return; }
      timer = setTimeout(async () => {
        try {
          const r = await api(`/api/orch/cron-preview?cron=${encodeURIComponent(cron)}&tz=${encodeURIComponent(tz)}`);
          if (n !== seq) return;
          preview.className = `sc-preview${r.error ? ' bad' : ''}`;
          preview.textContent = r.error || `${r.when}${tz !== TZ ? ` (${tz})` : ''}. Next: ${r.next.map((t) => fmtWhen(t * 1000)).join(', ')}`;
        } catch (e) { if (n === seq) { preview.className = 'sc-preview bad'; preview.textContent = e.message; } }
      }, 250);
    };
    const paramsFor = () => {
      const kids = [];
      const sel = (opts, value, on, label) => {
        const x = document.createElement('select');
        x.setAttribute('aria-label', label);
        for (const [v, t] of opts) { const o = el('option', '', t); o.value = v; x.append(o); }
        x.value = value;
        x.onchange = () => { on(x.value); check(); };
        return x;
      };
      const time = () => {
        const t = document.createElement('input');
        t.type = 'time'; t.value = f.time; t.required = true; t.setAttribute('aria-label', 'Time');
        t.oninput = () => { if (t.value) { f.time = t.value; check(); } };
        return t;
      };
      if (f.preset === 'minutes') kids.push(sel([5, 10, 15, 30].map((n) => [n, `every ${n} minutes`]), f.every, (v) => { f.every = +v; }, 'How often'));
      if (f.preset === 'hours') kids.push(sel([1, 2, 3, 4, 6, 8, 12].map((n) => [n, n === 1 ? 'every hour' : `every ${n} hours`]), f.every, (v) => { f.every = +v; }, 'How often'));
      if (f.preset === 'weekly') {
        const days = el('div', 'sc-days');
        days.setAttribute('role', 'group'); days.setAttribute('aria-label', 'Days');
        for (const d of [1, 2, 3, 4, 5, 6, 0]) {
          const b = btn(`sc-day${f.days.has(d) ? ' on' : ''}`, DAYS[d], () => {
            if (f.days.has(d) && f.days.size > 1) f.days.delete(d); else f.days.add(d);
            b.classList.toggle('on', f.days.has(d)); b.setAttribute('aria-pressed', String(f.days.has(d)));
            check();
          });
          b.setAttribute('aria-pressed', String(f.days.has(d)));
          days.append(b);
        }
        kids.push(days, el('span', 'sc-at', 'at'), time());
      }
      if (f.preset === 'monthly') kids.push(sel(Array.from({ length: 28 }, (_, i) => [i + 1, `on day ${i + 1}`]), f.dom, (v) => { f.dom = +v; }, 'Day of the month'), el('span', 'sc-at', 'at'), time());
      if (f.preset === 'daily' || f.preset === 'weekdays') kids.push(el('span', 'sc-at', 'at'), time());
      if (f.preset === 'custom') {
        const c = document.createElement('input');
        c.className = 'sc-cronin'; c.value = f.cron; c.placeholder = 'minute hour day month weekday, e.g. 30 8 * * 1-5';
        c.spellcheck = false; c.autocapitalize = 'none'; c.setAttribute('aria-label', 'Cron expression');
        c.oninput = () => { f.cron = c.value; check(); };
        kids.push(c);
      }
      params.replaceChildren(...kids);
      check();
    };
    preset.onchange = () => {
      if (preset.value === 'custom') f.cron = toCron(f);
      f.preset = preset.value;
      paramsFor();
    };
    paramsFor();

    form.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!title.value.trim()) { err.textContent = 'Give it a title'; return title.focus(); }
      const box = kind === 'command' ? command : prompt;
      if (!box.value.trim()) { err.textContent = kind === 'command' ? 'Say what command to run' : 'Say what the task should do'; return box.focus(); }
      const body = { title: title.value, cron: toCron(f), tz,
        ...(kind === 'command' ? { command: command.value, prompt: '', done_when: '' } : { command: '', prompt: prompt.value, done_when: doneWhen.value }),
        ...(src ? { enabled: false, ...(kind === 'agent' ? { agent: src.agent ?? null, model: src.model ?? null } : {}) } : {}) };
      submit.disabled = true;
      try {
        const r = s ? await api(`/api/orch/schedules/${s.id}`, 'PATCH', body) : await api(`/api/orch/projects/${proj.value}/schedules`, 'POST', body);
        toast(src ? `Copied, paused: ${r.schedule.title}. Switch it on to run it.` : `${s ? 'Saved' : 'Scheduled'}: ${r.schedule.title} · ${r.schedule.when}`, { kind: 'success' });
        SC.edit = null;
        await load(); render();
      } catch (x) { err.textContent = x.message; } finally { submit.disabled = false; }
    };
    const rep = el('div', 'sc-repeat');
    rep.append(preset, params);
    const kinds = el('div', 'sc-kind');
    kinds.setAttribute('role', 'tablist'); kinds.setAttribute('aria-label', 'What runs');
    const cmdField = field('Command', command, 'Runs with bash in the project folder, with its .env loaded, like a cron job. No agent and no plan usage. Stopped after 1 hour.');
    const agentFields = [field('What to do', prompt, 'A fresh agent runs this each time, with no memory of earlier runs, so make it self-contained. Uses your plan.'),
      field('Done when', doneWhen, 'A command that proves a run worked. Leave blank to skip the check.')];
    const showKind = () => {
      for (const b of kinds.children) b.setAttribute('aria-selected', String(b.dataset.kind === kind));
      cmdField.hidden = kind !== 'command';
      for (const x of agentFields) x.hidden = kind === 'command';
    };
    for (const [k, t] of [['command', 'Run a command'], ['agent', 'Ask an agent']]) {
      const b = btn('', t, () => { kind = k; showKind(); });
      b.dataset.kind = k; b.setAttribute('role', 'tab');
      kinds.append(b);
    }
    // A copy keeps its source's agent and model (no picker here: the server drops a model the agent doesn't have).
    if (src && (src.agent || src.model)) {
      const runsOn = el('p', 'sc-fhint sc-runson', `Runs on ${[src.agent, src.model].filter(Boolean).join(' · ')}, as "${src.title}" does.`);
      agentFields.splice(1, 0, runsOn);
    }
    showKind();
    const note = src && el('p', 'sc-copynote', `Saving creates a new paused schedule: it won't run until you switch it on. "${src.title}" stays as it is, and its runs aren't copied.`);
    form.append(el('h3', 'sc-etitle', s ? 'Edit schedule' : src ? 'Copy schedule' : 'New schedule'), ...(note ? [note] : []),
      field(src ? 'Copy to project' : 'Project', proj), field('Title', title), kinds, cmdField, ...agentFields.slice(0, -1),
      field('Repeat', rep), preview, agentFields.at(-1), err, foot);
    body.replaceChildren(form);
    if (!coarse) title.focus();
  }

  $('schedBtn').addEventListener('click', () => open());
  $('schedModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('schedModal').hidden) return;
    e.stopImmediatePropagation();
    if (SC.edit) { SC.edit = null; render(); } else close();
  }, true);

  window.Schedules = {
    open,
    // A project push (its schedules ride on oproject): refresh the open list, at most every half second.
    changed() {
      if ($('schedModal').hidden || SC.edit) return;
      clearTimeout(SC.reload);
      SC.reload = setTimeout(() => load().then(render), 500);
    },
  };
})();
