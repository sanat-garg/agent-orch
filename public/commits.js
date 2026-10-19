'use strict';
// ---------- History (server: GET /api/orch/projects/:id/commits and /commit?sha=) ----------
// The top bar's "History" pill: the open project's commits (chat auto-commits and `agent-orch #N:` task merges) in one
// sheet, newest first, 50 at a time ('Load older' passes before = the last sha). A row shows the subject, when, who and
// +add −del, plus a 'Task #N' chip that opens the task. Tapping a row swaps the sheet to that commit: its message, the
// files with their counts and the coloured patch (app.css .diff lines). The pill shows whenever a project is open,
// except in the term/browser views; nothing is fetched until the sheet opens. Loaded after app.js and uses its helpers
// ($, el, api, O, relTime, showTask, coarse).
(() => {
  const CM = { pid: null, branch: '', list: [], more: false, loaded: false, loading: false, error: '', seq: 0, detail: null, lastFocus: null };
  const shown = () => !$('commitsModal').hidden;

  // A page of commits: from the top (older = false) or the page after the last one shown.
  async function load(older = false) {
    const pid = CM.pid, seq = ++CM.seq;
    if (!pid) return;
    const before = older ? CM.list.at(-1)?.sha : '';
    Object.assign(CM, { loading: true, error: '' });
    render();
    try {
      const r = await api(`/api/orch/projects/${pid}/commits?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      if (seq !== CM.seq || pid !== CM.pid) return;
      Object.assign(CM, { branch: r.branch || '', list: older ? CM.list.concat(r.commits || []) : r.commits || [], more: !!r.more, loaded: true });
    } catch (e) {
      if (seq !== CM.seq || pid !== CM.pid) return;
      CM.error = e.message;
      if (!older) Object.assign(CM, { list: [], more: false }); // a failed refresh shows its error, not a stale list
    }
    CM.loading = false;
    render();
  }
  async function loadDetail(sha) {
    const pid = CM.pid, d = CM.detail = { sha, data: null, error: '' };
    render();
    try {
      d.data = await api(`/api/orch/projects/${pid}/commit?sha=${encodeURIComponent(sha)}`);
    } catch (e) {
      d.error = e.message;
    }
    if (CM.detail === d && pid === CM.pid) render();
  }

  // The open chat's project (applyOrchSnapshot, updateHeader): a different project starts empty.
  function sync() {
    const pid = O.project?.id || null;
    if (pid !== CM.pid) {
      CM.seq++;
      Object.assign(CM, { pid, branch: '', list: [], more: false, loaded: false, loading: false, error: '', detail: null });
      if (!pid) close();
      else if (shown()) load();
    }
    renderHeader();
  }
  function renderHeader() {
    $('commitsLink').hidden = !CM.pid || CM.pid !== O.project?.id || ['term', 'browser'].includes($('app').dataset.view);
  }

  function open() {
    if (!CM.pid) return;
    if (!shown()) CM.lastFocus = document.activeElement;
    $('commitsModal').hidden = false;
    CM.detail = null;
    load();
    if (!coarse) $('commitsModal').querySelector('[data-close].icon-btn').focus();
  }
  function close() {
    if (!shown()) return;
    $('commitsModal').hidden = true;
    CM.detail = null;
    $('cmBody').replaceChildren();
    CM.lastFocus?.focus?.();
  }

  const counts = (c) => {
    const s = el('span', 'cm-counts');
    s.append(el('span', 'cm-add', `+${c.add || 0}`), el('span', 'cm-del', `−${c.del || 0}`));
    s.setAttribute('aria-label', `${c.add || 0} added, ${c.del || 0} removed`);
    return s;
  };
  // 'Task #12': opens the task (the sheet closes first so the drawer is in view).
  function taskChip(id) {
    const b = el('button', 'cm-task', `Task #${id}`);
    b.type = 'button';
    b.title = `Open task #${id}`;
    b.onclick = () => { close(); showTask(id); };
    return b;
  }
  const failed = (text, retry) => {
    const p = el('div', 'cm-error');
    const b = el('button', 'btn small', 'Retry');
    b.type = 'button';
    b.onclick = retry;
    p.append(el('p', 'cm-empty', text), b);
    return p;
  };

  function row(c) {
    const li = el('li', 'cm-item');
    li.dataset.sha = c.sha;
    const b = el('button', 'cm-open');
    b.type = 'button';
    const meta = el('span', 'cm-meta');
    meta.append(el('span', 'cm-sha', c.sha.slice(0, 7)), el('span', '', c.at ? relTime(c.at) : ''), el('span', 'cm-author', c.author || ''), counts(c));
    if (c.at) meta.children[1].title = new Date(c.at).toLocaleString();
    b.append(el('span', 'cm-subj', c.subject || '(no message)'), meta);
    b.onclick = () => loadDetail(c.sha);
    li.append(b);
    if (c.task) li.append(taskChip(c.task));
    return li;
  }

  function renderList(body) {
    $('cmSub').textContent = CM.list.length ? `${CM.branch ? `${CM.branch} · ` : ''}${CM.list.length}${CM.more ? '+' : ''} commit${CM.list.length === 1 ? '' : 's'}, newest first` : '';
    if (!CM.list.length) {
      if (CM.error) return body.replaceChildren(failed(`Couldn't load the history: ${CM.error}`, () => load()));
      return body.replaceChildren(el('p', 'cm-empty', CM.loaded ? 'No commits yet' : 'Loading…'));
    }
    const ul = el('ul', 'cm-list');
    ul.append(...CM.list.map(row));
    const out = [ul];
    if (CM.error) out.push(failed(`Couldn't load older commits: ${CM.error}`, () => load(true)));
    else if (CM.more) {
      const b = el('button', 'btn small cm-more', CM.loading ? 'Loading…' : 'Load older');
      b.type = 'button';
      b.disabled = CM.loading;
      b.onclick = () => load(true);
      out.push(b);
    }
    body.replaceChildren(...out);
  }

  // A unified diff, one line per row: added/removed lines and hunk/file headers coloured (app.css .diff .a/.d/.h).
  function patchLines(patch) {
    const box = el('div', 'diff cm-patch');
    for (const line of patch.replace(/\n$/, '').split('\n')) {
      const cls = /^(diff |index |\+\+\+ |--- |@@|new file|deleted file|similarity|rename |Binary )/.test(line) ? 'h'
        : line[0] === '+' ? 'a' : line[0] === '-' ? 'd' : '';
      box.append(el('div', cls, line || ' '));
    }
    return box;
  }

  function renderDetail(body) {
    const d = CM.detail, c = d.data || CM.list.find((x) => x.sha === d.sha) || { sha: d.sha };
    const back = el('button', 'btn small cm-back', '‹ Back');
    back.type = 'button';
    back.onclick = () => {
      CM.detail = null;
      render();
      if (!coarse) $('cmBody').querySelector(`.cm-item[data-sha="${d.sha}"] .cm-open`)?.focus();
    };
    const head = el('div', 'cm-dhead');
    head.append(back);
    if (c.task) head.append(taskChip(c.task));
    const out = [head, el('h3', 'cm-dsubj', c.subject || '(no message)')];
    const meta = el('p', 'cm-meta');
    meta.append(el('span', 'cm-sha', c.sha.slice(0, 7)), el('span', '', c.at ? relTime(c.at) : ''), el('span', 'cm-author', c.author || ''));
    out.push(meta);
    $('cmSub').textContent = c.sha.slice(0, 12);
    if (d.error) out.push(failed(`Couldn't load this commit: ${d.error}`, () => loadDetail(d.sha)));
    else if (!d.data) out.push(el('p', 'cm-empty', 'Loading…'));
    else {
      if (c.body?.trim()) out.push(el('pre', 'cm-body', c.body.trim()));
      const files = el('ul', 'cm-files');
      for (const f of c.files || []) {
        const li = el('li', 'cm-file');
        li.append(el('span', 'cm-path', f.path), f.binary ? el('span', 'cm-bin', 'binary') : counts(f));
        files.append(li);
      }
      if (c.files?.length) out.push(el('h4', 'cm-label', `${c.files.length} file${c.files.length === 1 ? '' : 's'} changed`), files);
      if (c.patch) out.push(patchLines(c.patch));
      if (c.truncated) out.push(el('p', 'cm-trunc', 'Diff truncated: it is too large to show in full.'));
    }
    body.replaceChildren(...out);
    body.scrollTop = 0;
  }

  function render() {
    if (!shown()) return;
    const body = $('cmBody');
    if (CM.detail) renderDetail(body);
    else renderList(body);
  }

  $('commitsLink').addEventListener('click', open);
  $('commitsModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !shown()) return;
    e.stopImmediatePropagation();
    close();
  }, true);
  // The term/browser views hide the pill; updateHeader returns before syncing there, so watch the view itself.
  new MutationObserver(renderHeader).observe($('app'), { attributes: true, attributeFilter: ['data-view'] });

  window.Commits = { sync, open };
  sync();
})();
