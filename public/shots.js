'use strict';
// ---------- Screenshots (server: orchestrator projectShots, GET /api/orch/projects/:id/shots) ----------
// The top bar's "Screenshots" pill: the open project's latest task screenshots in one sheet, so the owner sees what the
// agents built without opening tasks one by one. The newest is shown large, then the rest grouped by task (each group's
// heading opens its task). The pill shows only once the project has screenshots; "N new" counts ones taken since the
// gallery was last opened (per project, this browser). Refetched when the project changes and when one of its tasks
// changes status (a finished task has its final screens). Loaded after app.js and uses its helpers ($, el, api, store,
// O, relTime, shotNode, shotGrid, shotsByTime, showTask, closeSidebar, coarse).
(() => {
  const SH = { pid: null, list: [], loaded: false, error: '', seq: 0, timer: null, status: new Map(), lastFocus: null };
  const seenKey = (pid) => `cw.shots.seen.${pid}`;
  const newest = () => SH.list[0]?.at || 0;
  const unseen = () => { const seen = Number(store.get(seenKey(SH.pid))) || 0; return SH.list.filter((s) => s.at > seen).length; };

  async function load() {
    const pid = SH.pid, seq = ++SH.seq;
    if (!pid) return;
    try {
      const { shots } = await api(`/api/orch/projects/${pid}/shots`);
      if (seq !== SH.seq || pid !== SH.pid) return;
      Object.assign(SH, { list: shots || [], loaded: true, error: '' });
      // First look at this project in this browser: what's already there isn't "new".
      if (store.get(seenKey(pid)) == null && SH.list.length) store.set(seenKey(pid), String(newest()));
    } catch (e) {
      if (seq === SH.seq) SH.error = e.message;
    }
    renderHeader();
    render();
  }
  // The open chat's project (applyOrchSnapshot): a different project starts empty and loads its own.
  function sync() {
    const pid = O.project?.id || null;
    if (pid === SH.pid) return;
    Object.assign(SH, { pid, list: [], loaded: false, error: '' });
    SH.status.clear();
    for (const t of O.tasks.values()) if (t.project_id === pid) SH.status.set(t.id, t.status);
    clearTimeout(SH.timer);
    renderHeader();
    if (pid) load();
    else close();
  }
  // A task of this project changed: refetch (debounced) when its status moved, or on any change while the sheet is open.
  function onTask(t) {
    const before = SH.status.get(t.id);
    SH.status.set(t.id, t.status);
    if (before === t.status && $('shotsModal').hidden) return;
    clearTimeout(SH.timer);
    SH.timer = setTimeout(load, 2500);
  }

  function renderHeader() {
    const a = $('shotsLink');
    const show = !!SH.pid && SH.pid === O.project?.id && SH.list.length > 0 && !['term', 'browser'].includes($('app').dataset.view);
    a.hidden = !show;
    if (!show) return;
    const n = unseen();
    $('shotsNew').hidden = !n;
    $('shotsNew').textContent = n ? `${n} new` : '';
    a.classList.toggle('has-new', n > 0);
    a.title = `Latest screenshots from this project's tasks (${SH.list.length})${n ? ` · ${n} new` : ''}`;
    a.setAttribute('aria-label', `Screenshots${n ? `, ${n} new` : ''}`);
  }

  function open() {
    if (!SH.pid) return;
    if ($('shotsModal').hidden) SH.lastFocus = document.activeElement;
    $('shotsModal').hidden = false;
    if (SH.list.length) store.set(seenKey(SH.pid), String(newest()));
    renderHeader();
    render();
    load();
    if (!coarse) $('shotsModal').querySelector('[data-close].icon-btn').focus();
  }
  function close() {
    if ($('shotsModal').hidden) return;
    $('shotsModal').hidden = true;
    $('shBody').replaceChildren();
    SH.lastFocus?.focus?.();
  }

  // "#12 Add login · Done · 2h ago": opens the task (the sheet closes first so the drawer is in view).
  function taskHead(task, at, cls) {
    const b = el('button', `sh-task ${cls || ''}`.trim());
    b.type = 'button';
    b.title = `Open task #${task.id}`;
    b.append(el('span', 'sh-tid', `#${task.id}`), el('span', 'sh-ttl', task.title || 'Task'),
      el('span', 'sh-meta', [task.status ? task.status.replace(/_/g, ' ') : '', at ? relTime(at * 1000) : ''].filter(Boolean).join(' · ')));
    b.onclick = () => { close(); showTask(task.id); };
    return b;
  }

  function render() {
    if ($('shotsModal').hidden) return;
    const body = $('shBody'), list = SH.list;
    const tasks = new Set(list.map((s) => s.task.id)).size;
    $('shSub').textContent = list.length ? `${list.length} from ${tasks} task${tasks === 1 ? '' : 's'}, newest first. Tap one to enlarge.` : '';
    if (!list.length) {
      body.replaceChildren(el('p', 'sh-empty', SH.error ? `Couldn't load screenshots: ${SH.error}` : SH.loaded
        ? 'No screenshots yet. Tasks that change something visual save before and after shots here.' : 'Loading…'));
      return;
    }
    const [latest, ...rest] = list;
    const top = el('section', 'sh-latest');
    const fig = shotNode(latest);
    fig.classList.add('shot-final');
    top.append(el('h3', 'sh-label', 'Latest'), taskHead(latest.task, latest.at), fig);
    const out = [top];
    // The rest by task, the task with the newest shot first; each task's own shots in the order they were taken.
    const groups = new Map();
    for (const s of rest) {
      if (!groups.has(s.task.id)) groups.set(s.task.id, { task: s.task, at: s.at, shots: [] });
      groups.get(s.task.id).shots.push(s);
    }
    if (groups.size) out.push(el('h3', 'sh-label', 'Earlier'));
    for (const g of groups.values()) {
      const sec = el('section', 'sh-group');
      sec.append(taskHead(g.task, g.at), shotGrid(shotsByTime(g.shots)));
      out.push(sec);
    }
    body.replaceChildren(...out);
  }

  $('shotsLink').addEventListener('click', open);
  $('shotsModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('shotsModal').hidden || !$('lightbox').hidden) return;
    e.stopImmediatePropagation();
    close();
  }, true);

  window.Shots = { sync, onTask, renderHeader, open };
  sync();
})();
