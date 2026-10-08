'use strict';
// ---------- Live previews (server: previews.mjs) ----------
// Each project can be served at https://<slug>.<domain>, or the bare domain (slug APEX '@'). Three places:
//   - the new-project screen offers an address (none unless the owner adds one; typed, checked live),
//   - the chat header links to the open project's preview with a status dot,
//   - the sidebar's "Live previews" manager lists every project's address and status (set, move, restart, logs, remove)
//     and the owner's domains (add, remove, make default).
// Loaded after app.js and uses its helpers ($, el, api, toast, state, currentConvo, closeSidebar, coarse).
(() => {
  const APEX = '@';
  const PV = { domains: [], list: [], loaded: false, draft: { slug: '', skip: true, domain: null, apex: false, check: null }, timer: 0, seq: 0,
    lastFocus: null, logsOpen: new Set(), editing: new Set() };
  const STATUS = { running: 'Live', building: 'Deploying…', waiting: 'Waiting for code', error: 'Error', stopped: 'Stopped' };
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  const host = (v) => (v.slug === APEX ? v.domain : `${v.slug}.${v.domain}`);
  const dot = (status) => { const d = el('span', `pv-dot ${status || 'stopped'}`); d.setAttribute('aria-hidden', 'true'); return d; };
  const statusText = (v) => (v.status === 'error' && v.error ? `Error: ${v.error}` : v.status === 'waiting' ? v.error || STATUS.waiting : STATUS[v.status] || v.status);

  async function load() {
    try {
      const r = await api('/api/previews');
      PV.domains = r.domains; PV.list = r.previews; PV.loaded = true;
    } catch { /* an older server: no previews */ }
  }
  const defaultDomain = () => PV.domains[0]?.domain || 'greygoose.baby';

  // The domain part: a subdomain of each domain (".example.com") or the bare domain itself. onChange(domain, apex).
  function domainPicker(value, apex, onChange, label = 'Domain') {
    const s = document.createElement('select');
    s.className = 'pv-domain';
    s.setAttribute('aria-label', label);
    for (const d of PV.domains) for (const a of [false, true]) {
      const o = document.createElement('option');
      o.value = `${a ? APEX : '.'}${d.domain}`;
      o.textContent = a ? `${d.domain} (no subdomain)` : `.${d.domain}`;
      s.append(o);
    }
    s.value = `${apex ? APEX : '.'}${value || defaultDomain()}`;
    const fitSelect = () => { s.style.width = `${(s.selectedOptions[0]?.textContent.length || 10) + 3}ch`; };
    fitSelect();
    s.addEventListener('change', () => { fitSelect(); onChange(s.value.slice(1), s.value[0] === APEX); });
    return s;
  }
  // The address box is a label: a tap anywhere in it (not just on the typed text) focuses the slug.
  function addrBox(input, picker, apex) {
    const addr = el('label', 'pv-addr');
    input.hidden = apex;
    addr.append(el('span', 'pv-https', 'https://'), input, picker);
    return addr;
  }
  // Debounced availability check: cb({ok, url, error}).
  function checker() {
    let t = 0, seq = 0;
    return (slug, domain, cid, cb) => {
      clearTimeout(t);
      const n = ++seq;
      if (slug !== APEX && !norm(slug)) return cb(null);
      t = setTimeout(async () => {
        const q = new URLSearchParams({ slug, ...(domain && { domain }), ...(cid && { cid }) });
        try { const r = await api(`/api/previews/check?${q}`); if (n === seq) cb(r); } catch (e) { if (n === seq) cb({ ok: false, error: e.message }); }
      }, 300);
    };
  }
  // The slug input is as wide as its text, so the domain sits right after it.
  // Measured in the input's own font (bold), so the domain follows the last letter without a gap.
  const fit = (input) => {
    if (!input.isConnected) { input.style.width = `${Math.max((input.value || input.placeholder).length, 3) + 1}ch`; return; }
    const ctx = fit.ctx ||= document.createElement('canvas').getContext('2d');
    const cs = getComputedStyle(input);
    ctx.font = `${input.value ? cs.fontWeight : 400} ${cs.fontSize} ${cs.fontFamily}`;
    input.style.width = `${Math.ceil(ctx.measureText(input.value || input.placeholder).width) + 4}px`;
    if (input.scrollWidth > input.clientWidth) input.style.width = `${input.scrollWidth + 4}px`; // a font the canvas guessed narrower
  };
  function renderCheck(box, r) {
    box.className = `pv-check ${r ? (r.ok ? 'ok' : 'bad') : ''}`;
    box.textContent = !r ? '' : r.ok ? `✓ ${r.url.replace(/^https:\/\//, '')} is free` : `✕ ${r.error}`;
  }

  // ---- New project: the address field under "Project".
  const draftCheck = checker();
  function renderDraft() {
    const empty = document.querySelector('#messages .empty');
    if (!empty) return;
    let line = empty.querySelector('.preview-line');
    const show = !currentConvo() && state.draft.type === 'new' && PV.loaded;
    if (!show) { if (line) line.hidden = true; return; }
    const d = PV.draft;
    if (!d.domain || !PV.domains.some((x) => x.domain === d.domain)) d.domain = defaultDomain();
    if (!line) {
      line = el('div', 'preview-line');
      empty.querySelector('.project-line')?.after(line);
    }
    line.hidden = false;
    if (d.skip) {
      const add = el('button', 'pv-skip', 'Add a live preview address');
      add.type = 'button';
      add.onclick = () => { d.skip = false; renderDraft(); line.querySelector('input')?.focus(); };
      line.replaceChildren(el('span', 'pv-lbl', 'Live preview'), el('span', 'pv-none', 'None'), add);
      return;
    }
    let input = line.querySelector('input');
    if (!input) {
      input = document.createElement('input');
      input.id = 'pvDraftSlug';
      input.className = 'pv-slug';
      input.autocomplete = 'off'; input.spellcheck = false; input.autocapitalize = 'none';
      input.placeholder = 'my-app';
      input.setAttribute('aria-label', 'Live preview address');
      input.setAttribute('aria-describedby', 'pvDraftCheck');
      input.addEventListener('input', () => { d.slug = input.value; fit(input); runDraftCheck(); });
      input.addEventListener('blur', () => { if (d.slug && norm(d.slug) !== d.slug) { d.slug = norm(d.slug); input.value = d.slug; } });
      const lbl = el('span', 'pv-lbl', 'Live preview');
      const addr = addrBox(input, el('span'), d.apex);
      const check = el('span', 'pv-check');
      check.id = 'pvDraftCheck';
      check.setAttribute('aria-live', 'polite');
      const skip = el('button', 'pv-skip', 'Skip');
      skip.type = 'button';
      skip.title = 'No live preview for this project (add or change one anytime from Live previews in the sidebar)';
      skip.onclick = () => { d.skip = true; renderDraft(); };
      line.replaceChildren(lbl, addr, skip, check);
    }
    const addr = line.querySelector('.pv-addr');
    addr.lastElementChild.replaceWith(domainPicker(d.domain, d.apex, (v, apex) => {
      Object.assign(d, { domain: v, apex });
      input.hidden = apex;
      runDraftCheck();
      if (!apex) input.focus();
    }));
    input.hidden = d.apex;
    if (document.activeElement !== input) input.value = d.slug;
    fit(input);
    runDraftCheck();
  }
  function runDraftCheck() {
    const d = PV.draft, box = $('pvDraftCheck');
    if (!box) return;
    const slug = d.apex ? APEX : d.slug, key = `${d.apex ? APEX : norm(slug)}|${d.domain}`;
    if (d.check?.key === key) return renderCheck(box, d.check.r);
    draftCheck(slug, d.domain, null, (r) => { d.check = { key, r }; if ($('pvDraftCheck')) renderCheck($('pvDraftCheck'), r); });
    if (!d.apex && !norm(slug)) renderCheck(box, null);
  }
  // What the new project posts: {slug, domain}, or nothing (skipped or empty).
  function draftPick() {
    const d = PV.draft, slug = d.apex ? APEX : norm(d.slug);
    return PV.loaded && !d.skip && slug ? { slug, domain: d.domain || defaultDomain() } : {};
  }
  // Once the project exists, the next new project starts without one again.
  const resetDraft = () => { PV.draft = { slug: '', skip: true, domain: null, apex: false, check: null }; };

  // ---- The chat header link (and its row in the phone header's menu).
  function renderHeader() {
    const a = $('previewLink');
    if (!a) return;
    const c = currentConvo(), v = c?.preview;
    a.hidden = !v || $('repoLink').hidden;
    if (a.hidden) return;
    a.href = v.url;
    a.replaceChildren(dot(v.status), el('span', '', host(v)));
    a.title = `${statusText(v)} · ${v.url}`;
    a.classList.toggle('warn', v.status === 'error');
  }

  // ---- The manager sheet.
  function open() {
    closeSidebar();
    if ($('previewsModal').hidden) PV.lastFocus = document.activeElement;
    $('previewsModal').hidden = false;
    render();
    load().then(render);
    if (!coarse) $('previewsModal').querySelector('[data-close].icon-btn').focus();
  }
  function close() {
    if ($('previewsModal').hidden) return;
    $('previewsModal').hidden = true;
    PV.editing.clear();
    PV.lastFocus?.focus?.();
  }

  function render() {
    if ($('previewsModal').hidden) return;
    const body = $('pvBody');
    // Never rebuild under the owner's fingers (a status push mid-typing).
    if (body.contains(document.activeElement) && document.activeElement.matches('input, select')) return refreshStatuses();
    const scroll = body.scrollTop;
    body.replaceChildren(...projectsSection(), domainsSection());
    for (const i of body.querySelectorAll('.pv-slug')) fit(i);
    body.scrollTop = scroll;
  }
  // Status dots, pills and details only (the rest of the sheet stays as typed).
  function refreshStatuses() {
    for (const row of $('pvBody').querySelectorAll('.pv-row[data-cid]')) {
      const v = PV.list.find((x) => x.cid === row.dataset.cid);
      if (v) setStatus(row, v);
    }
  }

  // Line icons for the card actions (fixed markup, never user text).
  const ICONS = {
    open: '<path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>',
    restart: '<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/>',
    logs: '<path d="M5 6h14M5 12h14M5 18h9"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',
  };
  function act(tag, kind, label) {
    const b = el(tag, 'pv-act');
    if (tag === 'button') b.type = 'button';
    b.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind]}</svg>`);
    b.append(el('span', '', label));
    return b;
  }
  // The status pill's word, and the line under the card that explains an error or what it waits for.
  const detailOf = (v) => (v.status === 'error' ? v.error || '' : v.status === 'waiting' ? v.error || '' : '');
  function setStatus(row, v) {
    const pill = row.querySelector('.pv-pill');
    if (pill) { pill.className = `pv-pill ${v.status || 'stopped'}`; pill.textContent = STATUS[v.status] || v.status; }
    const det = row.querySelector('.pv-detail');
    if (det) { det.textContent = detailOf(v); det.hidden = !det.textContent; det.classList.toggle('bad', v.status === 'error'); }
  }

  // Projects with an address first (cards), then the rest (a list with "Add address"). Main chats only.
  function projectsSection() {
    const byCid = new Map(PV.list.filter((v) => v.cid).map((v) => [v.cid, v]));
    const convos = state.convos.filter((c) => !c.mainId || c.mainId === c.id).sort((a, b) => b.updatedAt - a.updatedAt);
    const live = convos.filter((c) => byCid.has(c.id)), rest = convos.filter((c) => !byCid.has(c.id));
    const orphans = PV.list.filter((x) => !x.cid); // previews whose chat is gone (kept until removed)
    const sec = el('section', 'pv-sec');
    sec.append(el('h3', '', 'Live'));
    if (!live.length && !orphans.length) sec.append(el('p', 'pv-empty', convos.length ? 'No project has an address yet. Add one below.' : 'No projects yet. Start one with New project.'));
    for (const c of live) sec.append(liveRow(c, byCid.get(c.id)));
    for (const v of orphans) {
      const row = el('div', 'pv-row');
      const id = el('div', 'pv-id');
      const url = el('a', 'pv-url', host(v));
      url.href = v.url; url.target = '_blank'; url.rel = 'noopener';
      id.append(el('span', 'pv-name', v.title || 'Project'), url);
      const head = el('div', 'pv-head');
      head.append(id, el('span', 'pv-pill', 'Chat deleted'));
      row.append(head);
      sec.append(row);
    }
    if (!rest.length) return [sec];
    const sec2 = el('section', 'pv-sec');
    sec2.append(el('h3', '', 'No address'));
    const list = el('div', 'pv-list');
    for (const c of rest) list.append(addRow(c));
    sec2.append(list);
    return [sec, sec2];
  }

  function liveRow(c, v) {
    const row = el('div', 'pv-row');
    row.dataset.cid = c.id;
    const head = el('div', 'pv-head');
    const id = el('div', 'pv-id');
    const url = el('a', 'pv-url', host(v));
    url.href = v.url; url.target = '_blank'; url.rel = 'noopener';
    url.title = `Open ${v.url}`;
    id.append(el('span', 'pv-name', c.title || folderName(c.cwd)), url);
    head.append(id, el('span', 'pv-pill'));
    const det = el('p', 'pv-detail');
    row.append(head, det);
    setStatus(row, v);
    if (PV.editing.has(c.id)) { row.append(editor(c, v)); return row; }
    const acts = el('div', 'pv-acts');
    const openA = act('a', 'open', 'Open');
    openA.href = v.url; openA.target = '_blank'; openA.rel = 'noopener';
    const restart = act('button', 'restart', 'Restart');
    restart.title = 'Rebuild and restart it from the main branch';
    restart.onclick = async () => {
      restart.disabled = true;
      try { await api(`/api/convos/${c.id}/preview/restart`, 'POST'); toast(`Redeploying ${host(v)}`); } catch (e) { toast(e.message, { kind: 'error' }); }
      finally { restart.disabled = false; }
    };
    const logsBtn = act('button', 'logs', 'Logs');
    logsBtn.setAttribute('aria-expanded', String(PV.logsOpen.has(c.id)));
    const pre = el('pre', 'pv-logs');
    pre.hidden = !PV.logsOpen.has(c.id);
    const loadLogs = async () => {
      pre.textContent = 'Loading…';
      try { pre.textContent = (await api(`/api/convos/${c.id}/preview/logs`)).text.trim() || '(no output yet)'; pre.scrollTop = pre.scrollHeight; }
      catch (e) { pre.textContent = e.message; }
    };
    if (!pre.hidden) loadLogs();
    logsBtn.onclick = () => {
      const on = !PV.logsOpen.has(c.id);
      if (on) PV.logsOpen.add(c.id); else PV.logsOpen.delete(c.id);
      pre.hidden = !on;
      logsBtn.setAttribute('aria-expanded', String(on));
      if (on) loadLogs();
    };
    const edit = act('button', 'edit', 'Edit');
    edit.title = 'Change or remove the address';
    edit.onclick = () => startEdit(c.id);
    acts.append(openA, restart, logsBtn, edit);
    row.append(pre, acts);
    return row;
  }
  function addRow(c) {
    const item = el('div', 'pv-item');
    item.dataset.cid = c.id;
    item.append(el('span', 'pv-name', c.title || folderName(c.cwd)));
    if (PV.editing.has(c.id)) { item.classList.add('editing'); item.append(editor(c, null)); return item; }
    const add = el('button', 'pv-addbtn', 'Add address');
    add.type = 'button';
    add.setAttribute('aria-label', `Add a live preview address for ${c.title || folderName(c.cwd)}`);
    add.onclick = () => startEdit(c.id);
    item.append(add);
    return item;
  }
  function startEdit(cid) {
    PV.editing.add(cid);
    render();
    const at = $('pvBody').querySelector(`[data-cid="${CSS.escape(cid)}"]`);
    const f = at?.querySelector('.pv-slug:not([hidden])') || at?.querySelector('.pv-domain');
    f?.focus();
    at?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  // Back to the card's actions (or the list's Add address), focus on that button. Blur first: render() never rebuilds
  // under a focused field.
  function stopEdit(cid) {
    if ($('pvBody').contains(document.activeElement)) document.activeElement.blur();
    PV.editing.delete(cid);
    render();
    $('pvBody').querySelector(`[data-cid="${CSS.escape(cid)}"] :is(.pv-act:last-child, .pv-addbtn)`)?.focus({ preventScroll: true });
  }

  // The address editor: https://[slug][.domain ▾], then Remove (a set address only), Cancel and Save/Add.
  function editor(c, v) {
    const name = c.title || folderName(c.cwd);
    const box = el('div', 'pv-editor');
    const ed = { domain: v?.domain || defaultDomain(), apex: v?.slug === APEX };
    const slugOf = () => (ed.apex ? APEX : norm(input.value));
    const input = document.createElement('input');
    input.className = 'pv-slug'; input.value = v && !ed.apex ? v.slug : ''; input.placeholder = 'my-app';
    input.autocomplete = 'off'; input.spellcheck = false; input.autocapitalize = 'none'; input.enterKeyHint = 'done';
    input.setAttribute('aria-label', `${name} live preview address`);
    const addr = addrBox(input, domainPicker(ed.domain, ed.apex, (d, apex) => {
      Object.assign(ed, { domain: d, apex });
      input.hidden = apex;
      changed();
      if (!apex) input.focus();
    }, `${name} domain`), ed.apex);
    const check = el('div', 'pv-check');
    check.setAttribute('aria-live', 'polite');
    const save = el('button', 'btn small primary', v ? 'Save' : 'Add');
    save.type = 'button';
    const cancel = el('button', 'btn small', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = () => stopEdit(c.id);
    const rowCheck = checker();
    const changed = () => {
      const same = v && slugOf() === v.slug && ed.domain === v.domain;
      save.disabled = !slugOf() || !!same;
      if (same || !slugOf()) return renderCheck(check, null);
      rowCheck(ed.apex ? APEX : input.value, ed.domain, c.id, (r) => { renderCheck(check, r); if (r && !r.ok) save.disabled = true; });
    };
    input.addEventListener('input', () => { fit(input); changed(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (!save.disabled) save.click(); }
    });
    save.onclick = async () => {
      const slug = slugOf();
      if (!slug) return input.focus();
      save.disabled = true;
      try {
        await api(`/api/convos/${c.id}/preview`, 'PUT', { slug, domain: ed.domain });
        toast(`Live preview: https://${host({ slug, domain: ed.domain })}`, { kind: 'success' });
        input.blur(); PV.editing.delete(c.id);
        await load(); render();
      } catch (e) { renderCheck(check, { ok: false, error: e.message }); save.disabled = false; }
    };
    const bar = el('div', 'pv-ed-acts');
    if (v) {
      const remove = el('button', 'pv-remove', 'Remove address');
      remove.type = 'button';
      remove.onclick = async () => {
        if (!confirm(`Take ${host(v)} offline? The project's files stay.`)) return;
        try { await api(`/api/convos/${c.id}/preview`, 'PUT', { slug: '' }); PV.editing.delete(c.id); await load(); render(); }
        catch (e) { toast(e.message, { kind: 'error' }); }
      };
      bar.append(remove);
    }
    bar.append(el('span', 'pv-grow'), cancel, save);
    box.append(addr, check, bar);
    changed();
    return box;
  }

  function domainsSection() {
    const sec = el('section', 'pv-sec');
    sec.append(el('h3', '', 'Domains'));
    const list = el('div', 'pv-list');
    for (const [i, d] of PV.domains.entries()) {
      const row = el('div', 'pv-item');
      const id = el('div', 'pv-id');
      id.append(el('span', 'pv-name', d.domain), el('span', 'pv-sub', `${d.previews} preview${d.previews === 1 ? '' : 's'}`));
      row.append(id);
      if (i === 0) row.append(el('span', 'pv-default', 'Default'));
      else {
        const def = el('button', 'pv-addbtn', 'Make default');
        def.type = 'button';
        def.onclick = () => domainAction('POST', '/api/previews/domains', { domain: d.domain, default: true });
        row.append(def);
      }
      if (PV.domains.length > 1) {
        const rm = el('button', 'pv-addbtn danger', 'Remove');
        rm.type = 'button';
        rm.disabled = d.previews > 0;
        rm.title = d.previews ? 'Move or remove its previews first' : `Stop offering ${d.domain}`;
        rm.onclick = () => { if (confirm(`Stop offering ${d.domain}?`)) domainAction('DELETE', `/api/previews/domains/${encodeURIComponent(d.domain)}`); };
        row.append(rm);
      }
      list.append(row);
    }
    if (PV.domains.length) sec.append(list);
    const form = el('form', 'pv-add');
    const input = document.createElement('input');
    input.placeholder = 'Add a domain, e.g. example.com'; input.autocomplete = 'off'; input.spellcheck = false; input.autocapitalize = 'none';
    input.inputMode = 'url'; input.enterKeyHint = 'done';
    input.setAttribute('aria-label', 'New domain');
    const add = el('button', 'btn small primary', 'Add');
    add.type = 'submit';
    add.disabled = true;
    input.addEventListener('input', () => { add.disabled = !input.value.trim(); });
    const note = el('div', 'pv-check');
    note.setAttribute('aria-live', 'polite');
    form.append(input, add);
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      add.disabled = true;
      try {
        const r = await api('/api/previews/domains', 'POST', { domain: input.value });
        await load(); render();
        const n = $('pvBody').querySelector('.pv-add + .pv-check');
        if (n) renderCheck(n, r.wildcard.length ? { ok: true, url: `*.${r.domain}`, error: '' } : { ok: false, error: `*.${r.domain} doesn't resolve yet: add a wildcard A record pointing at this server.` });
        if (n && r.wildcard.length) n.textContent = `✓ Added ${r.domain} (*.${r.domain} → ${r.wildcard.join(', ')})`;
      } catch (err) { renderCheck(note, { ok: false, error: err.message }); add.disabled = false; }
    };
    sec.append(form, note, el('p', 'pv-hint', 'Each domain needs a wildcard DNS record (* → this server). New addresses use the default domain.'));
    return sec;
  }
  async function domainAction(method, url, body) {
    try { await api(url, method, body); await load(); render(); } catch (e) { toast(e.message, { kind: 'error' }); }
  }

  $('previewsBtn').addEventListener('click', open);
  $('previewsModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('previewsModal').hidden) return;
    e.stopImmediatePropagation();
    // Inside an open address editor, Escape cancels the edit; otherwise it closes the sheet.
    const at = document.activeElement?.closest?.('#pvBody [data-cid]');
    if (at && PV.editing.has(at.dataset.cid)) stopEdit(at.dataset.cid);
    else close();
  }, true);

  window.Previews = {
    renderDraft, renderHeader, draftPick, resetDraft, open,
    // A chat list push (statuses ride on each chat's `preview`) or {t:'previews'}.
    async changed(full) {
      renderHeader();
      if (full || !$('previewsModal').hidden) { await load(); render(); }
      renderDraft();
    },
  };
  load().then(() => { renderDraft(); renderHeader(); });
})();
