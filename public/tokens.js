'use strict';
// ---------- Token usage (server: chat-usage.mjs, GET /api/convos/:id/usage) ----------
// The top bar's token pill: how many tokens the open chat has used, and how much of a weekly plan limit that is.
// Its sheet breaks it down: this week and all time against each weekly window the account reports (Claude's
// all-models week, per-model weeks such as Fable, codex's week), tokens by model and, on a project's main chat, its
// tasks. All time / Last 7 days switches the totals, model tables and task totals between lifetime sums and the rolling
// seven days (the server's `recent`); the pill and the weekly-limit estimates always stay as they are. Refetched when the chat changes, after each reply (debounced) and when one of the project's tasks finishes.
// Loaded after app.js and uses its helpers ($, el, api, state, O, fmtTok, fmtResetAt, modelName, relTime, coarse).
(() => {
  const TK = { cid: null, data: null, error: '', seq: 0, timer: null, lastFocus: null, range: 'all' };
  const RANGES = [['all', 'All time'], ['week', 'Last 7 days']];
  const total = (s) => (s ? s.input + s.output + s.cached : 0);
  const pctText = (n) => (n == null ? '?' : n < 0.1 && n > 0 ? '<0.1%' : `${n >= 10 ? Math.round(n) : n.toFixed(1)}%`);
  // The pill's comparison: the account-wide week of the agent this chat used most.
  const mainWeek = (d) => {
    const agent = d?.chat.models[0]?.agent;
    return d?.weeks.find((w) => w.agent === agent && ['seven_day', 'weekly'].includes(w.window) && w.life != null) || null;
  };

  async function load() {
    const cid = TK.cid, seq = ++TK.seq;
    if (!cid) return;
    try {
      const d = await api(`/api/convos/${cid}/usage`);
      if (seq !== TK.seq || cid !== TK.cid) return;
      Object.assign(TK, { data: d, error: '' });
    } catch (e) {
      if (seq === TK.seq) TK.error = e.message;
    }
    renderHeader();
    render();
  }
  const later = (ms = 1500) => { clearTimeout(TK.timer); TK.timer = setTimeout(load, ms); };
  // The open chat (app.js updateHeader): a different chat starts empty and loads its own.
  function sync() {
    const cid = state.cid || null;
    if (cid !== TK.cid) {
      Object.assign(TK, { cid, data: null, error: '', range: 'all' });
      clearTimeout(TK.timer);
      if (cid) load();
      else close();
    }
    renderHeader();
  }
  // A reply finished (app.js setBusy).
  function onResult() { if (TK.cid) later(); }
  function onTask(t) { if (TK.data?.main && !['queued', 'running'].includes(t.status)) later(3000); }

  function renderHeader() {
    const a = $('tokLink');
    const d = TK.data, show = !!TK.cid && !!d && total(d.chat) > 0 && !['term', 'browser'].includes($('app').dataset.view);
    a.hidden = !show;
    if (!show) return;
    const w = mainWeek(d);
    $('tokText').textContent = `${fmtTok(total(d.chat))} tokens`;
    $('tokPct').hidden = !w;
    $('tokPct').textContent = w ? `${pctText(w.life)} of a week` : '';
    a.title = `This chat has used ${total(d.chat).toLocaleString()} tokens${w ? `, about ${pctText(w.life)} of a full ${w.label} weekly limit` : ''}`;
  }

  function open() {
    if (!TK.cid) return;
    if ($('tokModal').hidden) TK.lastFocus = document.activeElement;
    $('tokModal').hidden = false;
    render();
    load();
    if (!coarse) $('tokModal').querySelector('[data-close].icon-btn').focus();
  }
  function close() {
    if ($('tokModal').hidden) return;
    $('tokModal').hidden = true;
    TK.lastFocus?.focus?.();
  }

  const tile = (label, n, note) => {
    const t = el('div', 'tk-tile');
    t.append(el('span', 'tk-n', fmtTok(n)), el('span', 'tk-l', label));
    if (note) t.title = note;
    return t;
  };
  const tiles = (s) => {
    const row = el('div', 'tk-tiles');
    row.append(tile('Total', total(s)), tile('Input', s.input, 'New input, including cache writes'), tile('Output', s.output),
      tile('Cache reads', s.cached, 'Context read back from the cache: much cheaper than new input'));
    return row;
  };
  // One weekly window: a bar of the account's reading with this chat's part of it, then the two percentages.
  function weekRow(w) {
    const row = el('div', 'tk-week');
    const head = el('div', 'tk-wh');
    head.append(el('b', '', w.label), el('span', 'tk-reset', w.resetsAt ? `resets ${fmtResetAt(w.resetsAt * 1000)}` : ''));
    const bar = el('div', 'tk-bar');
    const acct = el('span', 'tk-acct'), mine = el('span', 'tk-mine');
    acct.style.width = `${Math.min(100, Number(w.pct) || 0)}%`;
    mine.style.width = `${Math.min(100, w.week || 0)}%`;
    bar.append(acct, mine);
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `Account ${w.pct}% used this week, this chat ${pctText(w.week)}`);
    row.append(head, bar);
    if (w.size == null) {
      row.append(el('p', 'tk-note', `The account is at ${w.pct}%: too little this week to size a full week yet.`));
      return row;
    }
    const facts = el('div', 'tk-facts');
    const fact = (n, label) => { const f = el('div', 'tk-fact'); f.append(el('b', '', pctText(n)), el('span', '', label)); return f; };
    facts.append(fact(w.life, 'of a full week, all time'), fact(w.week, 'of this week\'s limit, this week'), fact(w.pct, 'used by the whole account'));
    row.append(facts);
    if (TK.data.tasks && w.tasksLife) row.append(el('p', 'tk-note', `This project's tasks: ${pctText(w.tasksLife)} of a full week all time, ${pctText(w.tasksWeek)} this week.`));
    return row;
  }
  function modelTable(s) {
    const t = el('table', 'tk-models'), head = el('tr');
    for (const h of ['Model', 'Input', 'Output', 'Cache reads', 'Turns']) head.append(el('th', '', h));
    t.append(head);
    for (const m of s.models) {
      const r = el('tr');
      r.append(el('td', '', m.model ? modelName(m.agent, m.model) : agentLabel(m.agent)), el('td', '', fmtTok(m.input)), el('td', '', fmtTok(m.output)),
        el('td', '', fmtTok(m.cached)), el('td', '', String(m.turns)));
      t.append(r);
    }
    return t;
  }
  const label = (text) => el('h3', 'tk-label', text);
  const day = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const when = (t) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  function rangePicker() {
    const seg = el('span', 'seg-sm tk-range');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Token usage period');
    for (const [v, text] of RANGES) {
      const b = el('button', '', text);
      b.type = 'button';
      b.dataset.range = v;
      b.setAttribute('aria-pressed', String(v === TK.range));
      b.addEventListener('click', () => { if (v !== TK.range) { TK.range = v; render(); } });
      seg.append(b);
    }
    return seg;
  }

  function render() {
    if ($('tokModal').hidden) return;
    const body = $('tkBody'), d = TK.data;
    if (!d) {
      $('tkSub').textContent = '';
      body.replaceChildren(el('p', TK.error ? 'tk-note tk-err' : 'tk-note', TK.error ? `Couldn't load token usage: ${TK.error}` : 'Loading…'));
      return;
    }
    const week = TK.range === 'week' && !!d.recent, s = week ? d.recent.chat : d.chat, tasks = week ? d.recent.tasks : d.tasks;
    const replies = (n) => `${n} ${n === 1 ? 'reply' : 'replies'}`;
    $('tkSub').textContent = week ? `This chat · ${s.turns ? `${replies(s.turns)} in the last 7 days` : 'last 7 days'}`
      : s.turns ? `This chat · ${replies(s.turns)} since ${day(s.first)}` : 'This chat';
    const out = [];
    const bar = el('div', 'tk-rangebar');
    bar.append(rangePicker());
    if (week) bar.append(el('span', 'tk-span', `Rolling 7 days: ${when(d.recent.since)} – now`));
    out.push(bar);
    if (TK.error) out.push(el('p', 'tk-note tk-err', `Couldn't refresh token usage: ${TK.error}`));
    if (!s.turns) out.push(el('p', 'tk-note tk-empty', week ? 'No tokens recorded for this chat in the last 7 days.' : 'No tokens recorded for this chat yet.'));
    else out.push(tiles(s));
    if (s.models.length > 1) out.push(label(week ? 'By model · last 7 days' : 'By model'), modelTable(s));
    if (tasks && tasks.turns) {
      out.push(label(`This project's tasks · ${tasks.turns} ${tasks.turns === 1 ? 'run' : 'runs'}${week ? ' in the last 7 days' : ''}`), tiles(tasks));
      if (tasks.models.length > 1) out.push(modelTable(tasks));
    } else if (week && d.tasks?.turns) out.push(label("This project's tasks"), el('p', 'tk-note tk-empty', 'No task runs recorded in the last 7 days.'));
    out.push(label('Against your weekly limits'));
    if (d.weeks.length) out.push(...d.weeks.map(weekRow));
    else out.push(el('p', 'tk-note', 'No weekly reading yet. Refresh the plan limits on the usage card, then reopen this.'));
    const sized = d.weeks.find((w) => w.size);
    out.push(el('p', 'tk-foot', 'Estimated. The CLIs report weekly limits only as a percent, so agent-orch sizes a full week from the tokens it '
      + 'recorded this week up to that reading (cache reads count a tenth, output five times)'
      + `${sized ? `: a full ${sized.label} week is about ${fmtTok(sized.size)} weighted tokens` : ''}. Claude Code or Codex used outside `
      + `agent-orch makes these percentages read low. Turns from over 30 days before this view was added aren't counted.${sized ? ` Reading taken ${relTime(sized.readAt)}.` : ''}`));
    body.replaceChildren(...out);
  }

  $('tokLink').addEventListener('click', open);
  $('tokModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('tokModal').hidden) return;
    e.stopImmediatePropagation();
    close();
  }, true);

  window.Tokens = { sync, onResult, onTask, renderHeader, open };
  sync();
})();
