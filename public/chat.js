'use strict';
// Chat (server: chat-mode.mjs): the signed-in account's plain conversations with Claude (every model the CLI lists). Replies stream
// as server-sent events over a fetch; a reply keeps going on the server if the page closes, and reopening the chat
// joins it (GET …/stream). The open chat is the URL's hash. Phones show the chat list as a drawer.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const coarse = matchMedia('(pointer: coarse)').matches;
  const phone = () => matchMedia('(max-width: 767px)').matches;
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  marked.setOptions({ gfm: true, breaks: false });
  DOMPurify.addHook('afterSanitizeAttributes', (n) => { if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); } });
  const md = (t) => DOMPurify.sanitize(marked.parse(t || ''), { ADD_ATTR: ['target'] });

  const S = { me: null, models: [], defaultModel: null, chats: [], cur: null, msgs: [], live: null, menu: null, loadSeq: 0 };

  async function api(url, method = 'GET', body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status });
    return j;
  }
  const note = (text = '', err = false) => { $('note').textContent = text; $('note').classList.toggle('err', err); };
  const modelLabel = (id) => S.models.find((m) => m.id === id)?.label || id || '';

  // ---------- the list of chats
  function groupOf(t) {
    const d = new Date(t), now = new Date(), day = 864e5;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (t >= start) return 'Today';
    if (t >= start - day) return 'Yesterday';
    if (t >= start - 6 * day) return 'Previous 7 days';
    if (t >= start - 29 * day) return 'Previous 30 days';
    return d.toLocaleDateString([], { month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }
  function renderList() {
    const nav = $('list'), out = [];
    let last = null;
    for (const c of S.chats) {
      const g = groupOf(c.updatedAt);
      if (g !== last) { out.push(el('div', 'cm-group', g)); last = g; }
      const row = el('div', `cm-item${c.id === S.cur ? ' on' : ''}`);
      row.dataset.id = c.id;
      const a = el('a', '', c.title);
      a.href = `#${c.id}`;
      if (c.id === S.cur) a.setAttribute('aria-current', 'page');
      a.onclick = (e) => { e.preventDefault(); openChat(c.id); };
      row.append(a);
      if (c.busy || S.live?.id === c.id) { const b = el('span', 'cm-busy'); b.title = 'Answering'; row.append(b); }
      const more = el('button', 'cm-icon cm-more');
      more.type = 'button';
      more.setAttribute('aria-label', `Options for ${c.title}`);
      more.setAttribute('aria-haspopup', 'menu');
      more.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>';
      more.onclick = (e) => { e.stopPropagation(); itemMenu(c, more); };
      row.append(more);
      out.push(row);
    }
    if (!S.chats.length) out.push(el('p', 'cm-none', 'Your chats show up here.'));
    nav.replaceChildren(...out);
  }
  function closeMenu() { if (!S.menu) return; S.menu.btn.setAttribute('aria-expanded', 'false'); S.menu.pop.remove(); S.menu = null; }
  function itemMenu(c, btn) {
    const again = S.menu?.btn === btn;
    closeMenu();
    if (again) return;
    const pop = el('div', 'cm-menu-pop');
    pop.setAttribute('role', 'menu');
    const item = (text, fn, cls) => { const b = el('button', cls, text); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.onclick = () => { closeMenu(); fn(); }; pop.append(b); return b; };
    item('Rename', () => rename(c));
    item('Delete', () => remove(c), 'danger');
    document.body.append(pop);
    const r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
    pop.style.top = `${r.bottom + 4 + h > innerHeight ? r.top - h - 4 : r.bottom + 4}px`;
    btn.setAttribute('aria-expanded', 'true');
    S.menu = { pop, btn };
    pop.querySelector('button').focus();
  }
  function rename(c) {
    const row = $('list').querySelector(`.cm-item[data-id="${c.id}"]`);
    if (!row) return;
    const input = el('input');
    input.value = c.title;
    input.setAttribute('aria-label', 'Chat title');
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const t = input.value.trim();
      if (save && t && t !== c.title) {
        try { const r = await api(`/api/chat/chats/${c.id}`, 'PATCH', { title: t }); Object.assign(c, r.chat); } catch (e) { note(e.message, true); }
      }
      renderList(); renderTitle();
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } };
    input.onblur = () => finish(true);
    row.replaceChildren(input);
    input.focus(); input.select();
  }
  async function remove(c) {
    if (!confirm(`Delete "${c.title}"? This can't be undone.`)) return;
    try {
      await api(`/api/chat/chats/${c.id}`, 'DELETE');
      S.chats = S.chats.filter((x) => x.id !== c.id);
      if (S.cur === c.id) newChat(); else renderList();
    } catch (e) { note(e.message, true); }
  }

  // ---------- the thread
  function renderTitle() {
    const c = S.chats.find((x) => x.id === S.cur);
    $('title').textContent = c ? c.title : 'New chat';
    document.title = c ? `${c.title} · Chat` : 'Chat';
  }
  const iconBtn = (label, svg, fn) => { const b = el('button', 'cm-icon'); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.innerHTML = svg; b.onclick = fn; return b; };
  const COPY_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  const DONE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch { const t = el('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
    btn.innerHTML = DONE_SVG;
    setTimeout(() => { btn.innerHTML = COPY_SVG; }, 1500);
  }
  function addCodeCopy(box) {
    for (const pre of box.querySelectorAll('pre')) {
      if (pre.querySelector('.cm-copy')) continue;
      const b = iconBtn('Copy code', COPY_SVG, () => copy(pre.querySelector('code')?.innerText ?? pre.innerText, b));
      b.classList.add('cm-copy');
      pre.append(b);
    }
  }
  function thinkNode(text, liveNow) {
    const d = el('details', 'cm-think');
    const s = el('summary');
    s.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    s.append(el('span', '', liveNow ? 'Thinking…' : 'Thoughts'));
    const body = el('div', 'md');
    body.innerHTML = md(text);
    d.append(s, body);
    return d;
  }
  function userNode(m) { return el('div', 'cm-msg user', m.text); }
  function botNode(m) {
    const n = el('div', 'cm-msg bot');
    if (m.thinking) n.append(thinkNode(m.thinking, false));
    if (m.text) { const body = el('div', 'md'); body.innerHTML = md(m.text); addCodeCopy(body); n.append(body); }
    if (m.error) n.append(el('div', 'cm-err', m.error));
    const meta = el('div', 'cm-meta');
    if (m.text) { const b = iconBtn('Copy reply', COPY_SVG, () => copy(m.text, b)); meta.append(b); }
    meta.append(el('span', '', [modelLabel(m.model), m.stopped ? 'Stopped' : ''].filter(Boolean).join(' · ')));
    n.append(meta);
    return n;
  }
  function renderThread() {
    const nodes = S.msgs.map((m) => (m.role === 'user' ? userNode(m) : botNode(m)));
    if (S.live?.id === S.cur) nodes.push(S.live.node);
    $('thread').replaceChildren(...nodes);
    $('empty').hidden = !!nodes.length;
    renderTitle();
    syncComposer();
  }
  const nearBottom = () => { const s = $('scroll'); return s.scrollHeight - s.scrollTop - s.clientHeight < 120; };
  const toBottom = () => { const s = $('scroll'); s.scrollTop = s.scrollHeight; };

  // ---------- a streaming reply
  function liveNode(L) {
    const n = el('div', 'cm-msg bot');
    L.think = null;
    L.body = el('div', 'md');
    L.dots = el('span', 'cm-dots');
    L.dots.setAttribute('aria-label', 'Claude is answering');
    L.dots.append(el('i'), el('i'), el('i'));
    n.append(L.body, L.dots);
    return n;
  }
  function paint(L) {
    if (L.raf) return;
    L.raf = requestAnimationFrame(() => {
      L.raf = 0;
      const stick = nearBottom();
      if (L.thinking && !L.think) { L.think = thinkNode(L.thinking, true); L.node.prepend(L.think); }
      else if (L.think) L.think.querySelector('.md').innerHTML = md(L.thinking);
      if (L.think && L.text) L.think.querySelector('summary span').textContent = 'Thoughts';
      L.body.innerHTML = md(L.text);
      if (stick) toBottom();
    });
  }
  // Reads a server-sent event stream: {t:'start'|'thinking'|'delta'|'done'|'error'|'idle'}.
  async function follow(id, res) {
    const L = { id, text: '', thinking: '', ctrl: null };
    L.node = liveNode(L);
    S.live = L;
    if (S.cur === id) { $('thread').append(L.node); $('empty').hidden = true; toBottom(); }
    renderList(); syncComposer();
    let done = null;
    try {
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.t === 'start') { L.text = ev.text || ''; L.thinking = ev.thinking || ''; paint(L); }
          else if (ev.t === 'delta') { L.text += ev.text; paint(L); }
          else if (ev.t === 'thinking') { L.thinking += ev.text; paint(L); }
          else if (ev.t === 'done') done = ev.message;
        }
      }
    } catch { /* the connection dropped: the reply goes on server-side; reopening the chat shows it */ }
    if (S.live === L) S.live = null;
    const c = S.chats.find((x) => x.id === id);
    if (c) { c.busy = false; if (done) c.updatedAt = done.ts; }
    if (S.cur === id) {
      if (done) { S.msgs.push(done); renderThread(); if (nearBottom()) toBottom(); }
      else openChat(id, { keepScroll: true }); // lost the stream: read what the server has
    }
    renderList(); syncComposer();
  }

  // ---------- open / new / send
  async function openChat(id, { keepScroll = false } = {}) {
    closeSide(); closeMenu();
    const seq = ++S.loadSeq;
    if (S.cur !== id) history.replaceState(null, '', `#${id}`);
    S.cur = id;
    renderList();
    let r;
    try { r = await api(`/api/chat/chats/${id}`); } catch (e) {
      if (seq !== S.loadSeq) return;
      if (e.status === 404) { S.chats = S.chats.filter((x) => x.id !== id); newChat(); return; }
      note(e.message, true); return;
    }
    if (seq !== S.loadSeq) return;
    S.msgs = r.messages;
    const c = S.chats.find((x) => x.id === id);
    if (c) Object.assign(c, r.chat); else S.chats.unshift(r.chat);
    $('model').value = r.chat.model;
    renderThread();
    if (!keepScroll) toBottom();
    // A reply still being written (from before a reload, or another device): join it.
    if (r.live && S.live?.id !== id) fetch(`/api/chat/chats/${id}/stream`).then((res) => (res.ok ? follow(id, res) : null)).catch(() => {});
    if (!coarse) $('input').focus();
  }
  function newChat() {
    closeSide(); closeMenu();
    S.loadSeq++;
    S.cur = null; S.msgs = [];
    history.replaceState(null, '', location.pathname);
    $('model').value = pickedModel();
    renderList(); renderThread(); note();
    if (!coarse) $('input').focus();
  }
  const pickedModel = () => { const m = store.get('cm.model'); return S.models.some((x) => x.id === m) ? m : S.defaultModel; };
  function syncComposer() {
    const busy = !!S.live && S.live.id === S.cur;
    const btn = $('send');
    btn.classList.toggle('stop', busy);
    btn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    btn.disabled = !busy && (!$('input').value.trim() || !S.models.length);
  }
  function grow() { const t = $('input'); t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, innerHeight * 0.4)}px`; }

  async function send() {
    if (S.live && S.live.id === S.cur) { api(`/api/chat/chats/${S.cur}/stop`, 'POST').catch(() => {}); return; }
    const text = $('input').value;
    if (!text.trim()) return;
    note();
    const model = $('model').value;
    let id = S.cur;
    try {
      if (!id) {
        const r = await api('/api/chat/chats', 'POST', { model });
        id = r.chat.id;
        S.chats.unshift(r.chat);
        S.cur = id; S.msgs = [];
        history.replaceState(null, '', `#${id}`);
      }
    } catch (e) { note(e.message, true); return; }
    const draft = text;
    $('input').value = ''; grow();
    S.msgs.push({ role: 'user', text, ts: Date.now() });
    const c = S.chats.find((x) => x.id === id);
    if (c && S.msgs.length === 1 && c.title === 'New chat') c.title = text.trim().split('\n')[0].slice(0, 48);
    if (c) { c.updatedAt = Date.now(); c.model = model; S.chats = [c, ...S.chats.filter((x) => x !== c)]; }
    renderThread(); toBottom();
    let res;
    try {
      res = await fetch(`/api/chat/chats/${id}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model }) });
    } catch { res = null; }
    if (!res || !res.ok) {
      const j = res ? await res.json().catch(() => ({})) : {};
      S.msgs.pop();
      if (S.cur === id) { $('input').value = draft; grow(); renderThread(); }
      if (res?.status === 401) { location.href = '/login'; return; }
      note(j.error || 'Not sent: the connection failed. Try again.', true);
      return;
    }
    follow(id, res);
  }

  // ---------- drawer (phones)
  function openSide() { $('cm').classList.add('side-open'); $('scrim').hidden = false; $('openSide').setAttribute('aria-expanded', 'true'); }
  function closeSide() { $('cm').classList.remove('side-open'); $('scrim').hidden = true; $('openSide').setAttribute('aria-expanded', 'false'); }

  // ---------- wiring
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('input').addEventListener('input', () => { grow(); syncComposer(); });
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); if (!(S.live && S.live.id === S.cur)) send(); }
  });
  $('model').addEventListener('change', async () => {
    const m = $('model').value;
    store.set('cm.model', m);
    const c = S.chats.find((x) => x.id === S.cur);
    if (c) { try { await api(`/api/chat/chats/${c.id}`, 'PATCH', { model: m }); c.model = m; } catch (e) { note(e.message, true); } }
  });
  $('newChat').onclick = newChat;
  $('newChat2').onclick = newChat;
  $('openSide').onclick = openSide;
  $('scrim').onclick = closeSide;
  $('signOut').onclick = async () => { await fetch('/api/logout', { method: 'POST' }).catch(() => {}); location.href = '/login'; };
  document.addEventListener('click', (e) => { if (S.menu && !S.menu.pop.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (S.menu) { const b = S.menu.btn; closeMenu(); b.focus(); } else closeSide(); }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); }
  });
  addEventListener('hashchange', () => { const id = location.hash.slice(1); if (id && id !== S.cur) openChat(id); });
  // The picker: the newest of each family, then 'Older models'. Kept in step with the server's list (rediscovered daily).
  function fillModels() {
    const sel = $('model'), keep = sel.value, opt = (m) => { const o = new Option(m.label, m.id); o.title = m.description; return o; };
    const old = S.models.filter((m) => !m.latest), grp = document.createElement('optgroup');
    grp.label = 'Older models';
    grp.append(...old.map(opt));
    sel.replaceChildren(...S.models.filter((m) => m.latest).map(opt), ...(old.length ? [grp] : []));
    if (!S.models.length) sel.append(new Option('No model', ''));
    if (keep && S.models.some((m) => m.id === keep)) sel.value = keep;
  }
  // Back from the background: a reply may have finished meanwhile, and a new model may have been listed.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    api('/api/chat').then((r) => { if (JSON.stringify(r.models) !== JSON.stringify(S.models)) { S.models = r.models; S.defaultModel = r.defaultModel; fillModels(); } }).catch(() => {});
    if (S.cur && !S.live) openChat(S.cur, { keepScroll: true });
  });

  (async () => {
    let r;
    try { r = await api('/api/chat'); } catch (e) { note(e.message, true); return; }
    S.me = r.me; S.models = r.models; S.defaultModel = r.defaultModel; S.chats = r.chats;
    $('who').textContent = r.me.name;
    $('appLink').hidden = r.me.role === 'chat';
    const h = new Date().getHours();
    $('hello').textContent = `${h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}, ${r.me.name}`;
    fillModels();
    if (!S.models.length) note('No model is available right now: Claude may be signed out on this server.', true);
    const id = location.hash.slice(1);
    if (id && S.chats.some((c) => c.id === id)) openChat(id); else newChat();
  })();
})();
