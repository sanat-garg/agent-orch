'use strict';
// ---------- Users (server: users.mjs) ----------
// Settings → Account: who is signed in, and Sign out. For the admin, Settings → "Users & usage caps" opens a sheet
// listing every account with its estimated share of each weekly limit the agent CLIs report (Claude's all-models week
// and per-model weeks such as Fable; codex's weekly) and the cap on it, plus add / reset password / role / delete.
// A non-admin's sidebar shows "Your usage" instead of the machine and plan cards: their share of each weekly limit
// against their caps. Loaded after app.js and uses its helpers ($, el, api, toast, coarse, me, loadMe, meAdmin).
(() => {
  const UM = { list: [], me: null, loaded: false, error: null, lastFocus: null, open: null, adding: false };
  const btn = (cls, text, onclick) => { const b = el('button', cls, text); b.type = 'button'; if (onclick) b.onclick = onclick; return b; };
  const pct = (n) => `${Number(n) < 10 && Number(n) % 1 ? Number(n).toFixed(1) : Math.round(Number(n))}%`;
  const resets = (s) => (s ? `resets ${new Date(s * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '');

  // ---- Settings → Account (everyone)
  function renderAccount() {
    const u = me.user;
    $('stMeName').textContent = u ? `Signed in as ${u.name}` : 'Signed in';
    $('stMeHint').textContent = !u ? '' : u.role === 'admin' ? 'Admin: you manage users, machines and sign-ins'
      : 'Your admin manages machines, sign-ins and your usage caps';
  }
  $('stSignOut').addEventListener('click', () => $('logout').click()); // the same confirm and sign-out as Connections

  // ---- "Your usage" (non-admins): their share of each weekly limit, against the cap
  function renderMine() {
    const card = $('myUsage');
    card.hidden = meAdmin() || !me.user;
    if (card.hidden) return;
    const rows = (me.usage || []).filter((w) => w.cap != null || w.mine > 0);
    const head = el('div', 'ms-head');
    head.append(el('span', 'ms-title', 'Your usage'), el('span', 'ms-sum', 'this week'));
    const body = rows.map((w) => {
      const r = el('div', 'ms-row mu-row');
      r.title = `${w.label}: you've used about ${pct(w.mine)} of the account's weekly limit${w.cap != null ? `; your cap is ${pct(w.cap)}` : ''}. ${resets(w.resetsAt)}`;
      const bar = el('span', 'ms-bar'), fill = el('i');
      const of = w.cap != null ? (w.cap > 0 ? w.mine / w.cap : 1) : w.mine / 100;
      fill.style.width = `${Math.min(100, Math.max(0, of * 100))}%`;
      if (w.cap != null && w.mine >= w.cap) r.classList.add('full');
      bar.append(fill);
      r.append(el('span', 'mu-name', w.label.replace(/^Claude · /, '')), bar, el('span', 'ms-val', w.cap != null ? `${pct(w.mine)} / ${pct(w.cap)}` : pct(w.mine)));
      return r;
    });
    card.replaceChildren(head, ...(body.length ? body : [el('div', 'ms-note', 'No usage this week yet')]));
  }

  // ---- the admin's Users sheet
  async function load() {
    try { const r = await api('/api/users'); UM.list = r.users; UM.me = r.me; UM.loaded = true; UM.error = null; }
    catch (e) { UM.error = e.message; }
  }
  function open() {
    if ($('usersModal').hidden) UM.lastFocus = document.activeElement;
    $('settingsModal').hidden = true;
    $('usersModal').hidden = false;
    render();
    load().then(render);
    if (!coarse) $('usersModal').querySelector('.icon-btn[data-close]').focus();
  }
  function close() {
    if ($('usersModal').hidden) return;
    $('usersModal').hidden = true;
    UM.adding = false;
    UM.lastFocus?.focus?.();
  }
  const field = (label, input, hint) => {
    const f = el('label', 'um-field');
    f.append(el('span', 'um-label', label), input);
    if (hint) f.append(el('span', 'um-hint', hint));
    return f;
  };
  const input = (type, attrs = {}) => { const i = el('input'); i.type = type; Object.assign(i, attrs); return i; };

  function addForm() {
    const form = el('form', 'um-add');
    const name = input('text', { autocomplete: 'off', spellcheck: false, autocapitalize: 'off', placeholder: 'e.g. sam', maxLength: 32 });
    const pw = input('password', { autocomplete: 'new-password', placeholder: 'At least 8 characters' });
    const role = el('select');
    role.append(new Option('User', 'user'), new Option('Admin', 'admin'));
    const err = el('p', 'um-err');
    const foot = el('div', 'um-foot');
    foot.append(btn('btn small', 'Cancel', () => { UM.adding = false; render(); }), Object.assign(el('button', 'btn small primary', 'Add user'), { type: 'submit' }));
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      try {
        const r = await api('/api/users', 'POST', { name: name.value, password: pw.value, role: role.value });
        toast(`Added ${r.user.name}. They sign in with that username and password.`, { kind: 'success' });
        UM.adding = false; UM.open = r.user.id;
        await load(); render();
      } catch (x) { err.textContent = x.message; }
    };
    form.append(el('h3', 'um-etitle', 'New user'), field('Username', name, 'Lowercase letters, digits, . _ or -'), field('Password', pw), field('Role', role, 'Admins manage users, machines and sign-ins, and are never capped'), err, foot);
    setTimeout(() => { if (!coarse) name.focus(); });
    return form;
  }

  // One account: name, role, chats; each weekly window with its share and cap; actions.
  function userCard(u) {
    const card = el('section', 'um-user');
    const isMe = u.id === UM.me;
    const head = el('div', 'um-head');
    head.append(el('span', 'um-name', u.name), el('span', `um-role ${u.role}`, u.role === 'admin' ? 'Admin' : 'User'));
    if (isMe) head.append(el('span', 'um-you', 'you'));
    head.append(el('span', 'um-meta', `${u.chats} chat${u.chats === 1 ? '' : 's'}`));
    card.append(head);

    // Every weekly window reported now, plus any capped one with no current reading (so its cap isn't lost).
    const rows = [...u.usage];
    for (const [k, cap] of Object.entries(u.caps || {})) {
      const [agent, ...w] = k.split('/');
      if (!rows.some((r) => `${r.agent}/${r.window}` === k)) rows.push({ agent, window: w.join('/'), label: `${agent === 'claude' ? 'Claude' : agent} · ${w.join('/')}`, pct: null, mine: 0, cap, resetsAt: null });
    }
    const caps = new Map();
    const table = el('div', 'um-table');
    if (!rows.length) table.append(el('p', 'um-hint', 'No weekly limits reported yet. Refresh the usage card once an agent is signed in.'));
    for (const w of rows) {
      const key = `${w.agent}/${w.window}`;
      const r = el('div', 'um-row');
      const info = el('div', 'um-win');
      info.append(el('span', 'um-wname', w.label),
        el('span', 'um-wsub', w.pct == null ? 'no reading right now' : `uses about ${pct(w.mine)} of this week · account at ${pct(w.pct)}${w.resetsAt ? ` · ${resets(w.resetsAt)}` : ''}`));
      const bar = el('span', 'um-bar'), mine = el('i'), cap = el('b');
      mine.style.width = `${Math.min(100, w.mine)}%`;
      if (w.cap != null) { cap.style.left = `${Math.min(100, w.cap)}%`; bar.append(cap); }
      if (w.cap != null && w.mine >= w.cap) r.classList.add('full');
      bar.prepend(mine);
      info.append(bar);
      r.append(info);
      if (u.role === 'admin') r.append(el('span', 'um-nocap', 'No cap'));
      else {
        const box = el('label', 'um-cap');
        const i = input('number', { min: 0, max: 100, step: 1, inputMode: 'decimal', placeholder: 'none', value: w.cap ?? '' });
        i.setAttribute('aria-label', `${u.name}'s cap on ${w.label}, percent of the weekly limit`);
        box.append(el('span', 'um-capk', 'Cap'), i, el('span', 'um-pct', '%'));
        caps.set(key, i);
        r.append(box);
      }
      table.append(r);
    }
    card.append(table);

    const err = el('p', 'um-err');
    const acts = el('div', 'um-acts');
    if (u.role !== 'admin' && caps.size) {
      acts.append(btn('btn small primary', 'Save caps', async () => {
        err.textContent = '';
        const body = {};
        for (const [k, i] of caps) body[k] = i.value === '' ? null : Number(i.value);
        try { await api(`/api/users/${u.id}`, 'PATCH', { caps: body }); toast(`Saved ${u.name}'s caps`, { kind: 'success' }); await load(); render(); }
        catch (x) { err.textContent = x.message; }
      }));
    }
    acts.append(btn('btn small', isMe ? 'Change my password' : 'Reset password', async () => {
      const pw = prompt(`New password for ${u.name} (at least 8 characters)${isMe ? '' : '. They are signed out everywhere.'}`);
      if (pw == null) return;
      try { await api(`/api/users/${u.id}`, 'PATCH', { password: pw }); toast(`${isMe ? 'Your' : `${u.name}'s`} password is changed`, { kind: 'success' }); }
      catch (x) { err.textContent = x.message; }
    }));
    if (!isMe) {
      acts.append(btn('btn small', u.role === 'admin' ? 'Make user' : 'Make admin', async () => {
        try { await api(`/api/users/${u.id}`, 'PATCH', { role: u.role === 'admin' ? 'user' : 'admin' }); await load(); render(); }
        catch (x) { err.textContent = x.message; }
      }));
      acts.append(btn('btn small danger', 'Delete', async () => {
        if (!confirm(`Delete ${u.name}? They are signed out, and their ${u.chats} chat${u.chats === 1 ? '' : 's'} move to you.`)) return;
        try { const r = await api(`/api/users/${u.id}`, 'DELETE'); toast(`Deleted ${u.name}${r.moved ? `; ${r.moved} chat${r.moved === 1 ? '' : 's'} moved to you` : ''}`); await load(); render(); }
        catch (x) { err.textContent = x.message; }
      }));
    }
    card.append(err, acts);
    return card;
  }

  function render() {
    if ($('usersModal').hidden) return;
    const body = $('umBody');
    const top = el('div', 'um-top');
    top.append(el('p', 'um-intro', "Each user has their own chats and projects. A cap is the most of a weekly limit they may use; past it their chats on that model stop, and their tasks move to a fallback or wait for the reset. Usage per user is estimated from their share of the tokens, since the plan only reports the account's total."));
    if (!UM.adding) top.append(btn('btn small primary', 'Add user', () => { UM.adding = true; render(); }));
    const parts = [top];
    if (UM.adding) parts.push(addForm());
    if (!UM.loaded) parts.push(el('p', 'um-hint', UM.error || 'Loading…'));
    else parts.push(...UM.list.map(userCard));
    body.replaceChildren(...parts);
  }

  $('stUsersOpen').addEventListener('click', open);
  $('usersModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('usersModal').hidden) return;
    e.stopImmediatePropagation();
    if (UM.adding) { UM.adding = false; render(); } else close();
  }, true);
  // A non-admin's numbers move as they work: re-read them each minute while the page is visible (server-side only, no CLI).
  setInterval(() => { if (!document.hidden && !meAdmin()) loadMe(); }, 60e3);

  window.Users = {
    open,
    changed() { renderAccount(); renderMine(); },
  };
  window.Users.changed();
})();
