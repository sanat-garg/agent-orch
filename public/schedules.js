'use strict';
// ---------- Schedules (server: cron.mjs + orchestrator `schedules`) ----------
// Recurring tasks: each schedule queues a task in its project whenever its cron time comes round (in the owner's time
// zone, this browser's). The sidebar's "Schedules" sheet lists every project's, with on/off, Run now, Edit and Delete;
// the editor builds the cron from simple choices (or takes one typed) and checks it live (GET /api/orch/cron-preview).
// The chat planner makes them too ("every Monday at 8, check dependencies"). Loaded after app.js and uses its helpers
// ($, el, api, toast, fmtWhen, closeSidebar, coarse, routeHash, O).
(() => {
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const SC = { projects: [], list: [], loaded: false, edit: null, lastFocus: null, reload: 0 };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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
    top.append(el('p', 'sc-hint', `Each schedule queues a task in its project at the times you set, in your time zone (${TZ}). You can also ask in chat, e.g. "every weekday at 9, check the inbox".`),
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
    const when = el('div', 'sc-when');
    when.append(el('span', 'sc-cron', s.when + (s.tz !== TZ ? ` (${s.tz})` : '')));
    if (s.enabled && s.next_run_at) when.append(el('span', '', ` · Next ${fmtWhen(s.next_run_at * 1000)}`));
    else if (!s.enabled) when.append(el('span', '', ' · Off'));
    const meta = el('div', 'sc-meta');
    if (s.last_task) {
      const a = btn('sc-task', `#${s.last_task.id}`, () => { close(); routeHash(`task-${s.last_task.id}`); });
      a.title = 'Open the task from the last run';
      meta.append('Last run ', a, ` ${STATUS[s.last_task.status] || s.last_task.status}${s.last_run_at ? `, ${fmtWhen(s.last_run_at * 1000)}` : ''} · ${plural(s.runs, 'run')}`);
    } else meta.append('Not run yet');
    if (s.skipped) meta.append(` · ${plural(s.skipped, 'run')} skipped while the previous one was still going`);
    if (s.created_by === 'planner') meta.append(' · made from chat');
    const acts = el('div', 'sc-acts');
    const run = btn('btn small', 'Run now', async () => {
      run.disabled = true;
      try { const x = await api(`/api/orch/schedules/${s.id}/run`, 'POST'); toast(`Queued #${x.task}: ${s.title}`, { kind: 'success' }); await load(); render(); }
      catch (e) { toast(e.message, { kind: 'error' }); } finally { run.disabled = false; }
    });
    const edit = btn('btn small', 'Edit', () => startEdit(s));
    const del = btn('btn small danger', 'Delete', async () => {
      if (!confirm(`Delete the schedule "${s.title}"? Tasks it already queued stay.`)) return;
      try { await api(`/api/orch/schedules/${s.id}`, 'DELETE'); await load(); render(); } catch (e) { toast(e.message, { kind: 'error' }); }
    });
    acts.append(run, edit, del);
    r.append(head, when, meta, acts);
    return r;
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
  function startEdit(s, projectId) {
    const curProject = SC.projects.find((p) => p.path === O.project?.path)?.id;
    SC.edit = { id: s?.id ?? null, projectId: s?.project_id ?? projectId ?? curProject ?? SC.projects[0]?.id, ...fromCron(s?.cron || '0 9 * * *') };
    const f = SC.edit, body = $('scBody');
    const form = el('form', 'sc-form');
    form.noValidate = true;
    const proj = document.createElement('select');
    for (const p of SC.projects) { const o = el('option', '', p.name); o.value = p.id; proj.append(o); }
    proj.value = f.projectId ?? '';
    proj.disabled = !!s;
    const title = document.createElement('input');
    title.maxLength = 200; title.value = s?.title || ''; title.placeholder = 'e.g. Morning inbox triage'; title.required = true;
    const prompt = document.createElement('textarea');
    prompt.rows = 4; prompt.value = s?.prompt || ''; prompt.placeholder = 'What the task should do each time, e.g. "Read new email, file receipts in Drive and list what needs my reply."';
    const preset = document.createElement('select');
    for (const [v, t] of PRESETS) { const o = el('option', '', t); o.value = v; preset.append(o); }
    preset.value = f.preset;
    const params = el('div', 'sc-params');
    const preview = el('div', 'sc-preview');
    preview.setAttribute('aria-live', 'polite');
    const doneWhen = document.createElement('input');
    doneWhen.value = s?.done_when || ''; doneWhen.placeholder = 'Optional, e.g. npm test';
    const err = el('div', 'sc-err');
    err.setAttribute('role', 'alert');
    const cancel = btn('btn', 'Cancel', () => { SC.edit = null; render(); });
    const submit = el('button', 'btn primary', s ? 'Save' : 'Add schedule');
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
          const r = await api(`/api/orch/cron-preview?cron=${encodeURIComponent(cron)}&tz=${encodeURIComponent(s?.tz || TZ)}`);
          if (n !== seq) return;
          preview.className = `sc-preview${r.error ? ' bad' : ''}`;
          preview.textContent = r.error || `${r.when}. Next: ${r.next.map((t) => fmtWhen(t * 1000)).join(', ')}`;
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
      if (!prompt.value.trim()) { err.textContent = 'Say what the task should do'; return prompt.focus(); }
      const body = { title: title.value, prompt: prompt.value, cron: toCron(f), done_when: doneWhen.value, tz: s?.tz || TZ };
      submit.disabled = true;
      try {
        const r = s ? await api(`/api/orch/schedules/${s.id}`, 'PATCH', body) : await api(`/api/orch/projects/${proj.value}/schedules`, 'POST', body);
        toast(`${s ? 'Saved' : 'Scheduled'}: ${r.schedule.title} · ${r.schedule.when}`, { kind: 'success' });
        SC.edit = null;
        await load(); render();
      } catch (x) { err.textContent = x.message; } finally { submit.disabled = false; }
    };
    const rep = el('div', 'sc-repeat');
    rep.append(preset, params);
    form.append(el('h3', 'sc-etitle', s ? 'Edit schedule' : 'New schedule'),
      field('Project', proj), field('Title', title), field('What to do', prompt, 'A fresh agent runs this each time, with no memory of earlier runs, so make it self-contained.'),
      field('Repeat', rep), preview,
      field('Done when', doneWhen, 'A command that proves a run worked. Leave blank to skip the check.'), err, foot);
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
