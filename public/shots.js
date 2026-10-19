'use strict';
// ---------- Screenshots (server: orchestrator projectShots, GET /api/orch/projects/:id/shots) ----------
// The top bar's "Screenshots" pill: the open project's latest task screenshots in one sheet, so the owner sees what the
// agents built without opening tasks one by one. The newest is shown large, then the rest grouped by task (each group's
// heading opens its task). The pill shows only once the project has screenshots; "N new" counts ones taken since the
// gallery was last opened (per project, this browser). Refetched when the project changes and when one of its tasks
// changes status (a finished task has its final screens). Compare: tick exactly two screenshots, then Compare shows them
// side by side (stacked on phones) at their own aspect ratios, each labelled with its task, name and time; Back returns to
// the gallery, Clear drops the picks. Picks reset when the project changes. Loaded after app.js and uses its helpers ($, el, api, store,
// O, relTime, shotNode, shotGrid, shotsByTime, showTask, closeSidebar, coarse).
(() => {
  const SH = { pid: null, list: [], loaded: false, error: '', seq: 0, timer: null, status: new Map(), lastFocus: null, picks: [], comparing: false };
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
    Object.assign(SH, { pid, list: [], loaded: false, error: '', picks: [], comparing: false });
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
    SH.comparing = false;
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

  // Compare picks: media ids are unique in SH.list, so two picks are always two distinct images. A pick keeps its shot
  // even if a refetch drops it (the comparison then shows "No longer available" when the image is gone).
  const picked = (s) => SH.picks.some((p) => p.id === s.id);
  function togglePick(s, on) {
    if (on && !picked(s) && SH.picks.length < 2) SH.picks.push(s);
    else if (!on) SH.picks = SH.picks.filter((p) => p.id !== s.id);
    render();
    [...$('shBody').querySelectorAll('.shot')].find((f) => f.dataset.id === s.id)?.querySelector('.sh-pick input')?.focus();
  }
  function clearPicks() { Object.assign(SH, { picks: [], comparing: false }); render(); }
  function setComparing(on) {
    SH.comparing = on && SH.picks.length === 2 && SH.picks[0].id !== SH.picks[1].id;
    render();
    const focus = $('shBody').querySelector(SH.comparing ? '.shc-back' : '.sh-cmp-go');
    if (!coarse) (focus || $('shotsModal').querySelector('[data-close].icon-btn')).focus();
  }
  // The gallery's tile with a "select for comparison" tick (top left; the star badge sits top right).
  function pickable(s, fig) {
    const lab = el('label', 'sh-pick'), box = el('input');
    box.type = 'checkbox';
    box.checked = picked(s);
    box.disabled = !box.checked && SH.picks.length >= 2;
    box.setAttribute('aria-label', `Select ${s.name || 'screenshot'} from task #${s.task.id} to compare`);
    box.onchange = () => togglePick(s, box.checked);
    lab.title = box.disabled ? 'Two selected: clear one to pick another' : 'Select to compare';
    lab.append(box);
    fig.classList.toggle('picked', box.checked);
    fig.append(lab);
    return fig;
  }
  function cmpBar() {
    const n = SH.picks.length, bar = el('div', 'sh-cmp-bar');
    bar.append(el('span', 'sh-cmp-msg', n === 2 ? '2 selected' : n ? '1 selected · pick one more to compare' : 'Tick two screenshots to compare them'));
    if (n) {
      const clear = el('button', 'btn sh-cmp-clear', 'Clear');
      clear.type = 'button';
      clear.onclick = clearPicks;
      bar.append(clear);
    }
    if (n === 2) {
      const go = el('button', 'btn primary sh-cmp-go', 'Compare');
      go.type = 'button';
      go.onclick = () => setComparing(true);
      bar.append(go);
    }
    return bar;
  }
  function comparePanel(s) {
    const sec = el('section', 'shc-panel'), fig = shotNode(s), when = el('time', 'shc-time', s.at ? relTime(s.at * 1000) : '');
    if (s.at) { when.dateTime = new Date(s.at * 1000).toISOString(); when.title = new Date(s.at * 1000).toLocaleString(); }
    fig.classList.add('shc-shot');
    const label = el('div', 'shc-label');
    label.append(taskHead(s.task, null, 'shc-task'), el('div', 'shc-file'));
    label.lastChild.append(el('span', 'shc-name', s.name || 'image'), when);
    sec.append(label, fig);
    return sec;
  }
  function renderCompare() {
    const [a, b] = SH.picks;
    $('shSub').textContent = 'Comparing two screenshots. Tap one to enlarge.';
    const bar = el('div', 'sh-cmp-bar shc-bar'), back = el('button', 'btn shc-back', 'Back'), clear = el('button', 'btn sh-cmp-clear', 'Clear');
    back.type = clear.type = 'button';
    back.onclick = () => setComparing(false);
    clear.onclick = () => { SH.picks = []; setComparing(false); };
    bar.append(back, el('span', 'sh-cmp-msg', `#${a.task.id} vs #${b.task.id}`), clear);
    const grid = el('div', 'shc');
    grid.append(comparePanel(a), comparePanel(b));
    $('shBody').replaceChildren(bar, grid);
  }

  function render() {
    if ($('shotsModal').hidden) return;
    $('shotsModal').querySelector('.shm').classList.toggle('comparing', SH.comparing);
    if (SH.comparing) return renderCompare();
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
    const fig = pickable(latest, shotNode(latest));
    fig.classList.add('shot-final');
    top.append(el('h3', 'sh-label', 'Latest'), taskHead(latest.task, latest.at), fig);
    const out = list.length > 1 ? [cmpBar(), top] : [top];
    // The rest by task, the task with the newest shot first; each task's own shots in the order they were taken.
    const groups = new Map();
    for (const s of rest) {
      if (!groups.has(s.task.id)) groups.set(s.task.id, { task: s.task, at: s.at, shots: [] });
      groups.get(s.task.id).shots.push(s);
    }
    if (groups.size) out.push(el('h3', 'sh-label', 'Earlier'));
    for (const g of groups.values()) {
      const sec = el('section', 'sh-group');
      const grid = el('div', 'shots');
      for (const s of shotsByTime(g.shots)) grid.append(pickable(s, shotNode(s)));
      sec.append(taskHead(g.task, g.at), grid);
      out.push(sec);
    }
    body.replaceChildren(...out);
  }

  $('shotsLink').addEventListener('click', open);
  $('shotsModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('shotsModal').hidden || !$('lightbox').hidden) return;
    e.stopImmediatePropagation();
    if (SH.comparing) setComparing(false); // Escape steps back out of a comparison first
    else close();
  }, true);

  window.Shots = { sync, onTask, renderHeader, open };
  sync();
})();
