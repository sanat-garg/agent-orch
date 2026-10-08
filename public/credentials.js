'use strict';
// ---------- Credentials (server: credentials.mjs, /api/credentials) ----------
// The sidebar's "Credentials" sheet: one card per service (Stripe, Postgres, the domain registrar…) with its logins and
// keys, so the owner reads them here instead of digging through .env files and docs. Secret values show as dots until
// tapped (eye), every value copies with one tap, and "Copy .env" copies the whole service as KEY=value lines. The
// editor (in place of the list) takes fields one by one or pasted .env lines. Everything is dropped from the page when
// the sheet closes. Loaded after app.js and uses its helpers ($, el, api, toast, coarse, closeSidebar, copyToClipboard).
(() => {
  const CR = { list: [], loaded: false, error: '', edit: null, shown: new Set(), q: '', lastFocus: null };
  const ICON = {
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.9"/>',
    hide: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.9"/>',
    edit: '<path d="M4.5 19.5l1-4L15.8 5.2a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8L8.5 18.5z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
    env: '<path d="M7 8l-4 4 4 4M17 8l4 4-4 4M13.5 5.5l-3 13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    x: '<path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  };
  const svg = (name, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${ICON[name]}</svg>`;
  const btn = (cls, text, onclick) => { const b = el('button', cls, text); b.type = 'button'; if (onclick) b.onclick = onclick; return b; };
  const iconBtn = (cls, icon, label, onclick) => { const b = btn(cls, null, onclick); b.innerHTML = svg(icon); b.setAttribute('aria-label', label); b.title = label; return b; };
  const host = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; } };
  // "Secret key" → SECRET_KEY; an env-style label stays as it is.
  const envKey = (label) => (/^[A-Z_][A-Z0-9_]*$/.test(label) ? label : label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'VALUE');
  const envLine = (f) => `${envKey(f.label)}=${/[\s#"'$`\\]/.test(f.value) ? JSON.stringify(f.value) : f.value}`;
  // Labels that name a value nobody needs hidden.
  const PLAIN = /(^|[\s_-])(user(name)?|login|e-?mail|host(name)?|url|uri|endpoint|port|region|account|org(anization)?|project|database|db|bucket|domain|id|from|sender|name)$/i;
  // "KEY=value" lines (export, quotes and comments allowed) as fields.
  function parseEnv(text) {
    const out = [];
    for (const line of String(text).split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[=:]\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if (/^"(.*)"$/.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } } else if (/^'(.*)'$/.test(v)) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      out.push({ label: m[1], value: v, secret: !PLAIN.test(m[1]) });
    }
    return out;
  }

  async function load() {
    try { CR.list = (await api('/api/credentials')).services; CR.loaded = true; CR.error = ''; } catch (e) { CR.error = e.message; }
  }
  function open() {
    closeSidebar();
    if ($('credModal').hidden) CR.lastFocus = document.activeElement;
    $('credModal').hidden = false;
    CR.edit = null;
    render();
    load().then(render);
    if (!coarse) $('credModal').querySelector('[data-close].icon-btn').focus();
  }
  function close() {
    if ($('credModal').hidden) return;
    $('credModal').hidden = true;
    // Nothing secret stays in the page once the sheet is closed.
    Object.assign(CR, { list: [], loaded: false, edit: null, q: '' });
    CR.shown.clear();
    $('crBody').replaceChildren();
    CR.lastFocus?.focus?.();
  }

  async function copy(text, what) {
    if (await copyToClipboard(text)) toast(`Copied ${what}`, { kind: 'success', duration: 2000 });
    else toast(`Couldn't copy ${what}`, { kind: 'error' });
  }

  function render() {
    if ($('credModal').hidden || CR.edit) return;
    const body = $('crBody');
    const top = el('div', 'cr-top');
    const add = btn('btn small primary', 'Add service', () => startEdit(null));
    if (CR.list.length > 3) {
      const search = el('input', 'cr-search');
      search.type = 'search'; search.placeholder = 'Search services'; search.value = CR.q;
      search.setAttribute('aria-label', 'Search services');
      search.oninput = () => { CR.q = search.value; renderList(); };
      top.append(search, add);
    } else top.append(el('p', 'cr-hint', 'Add a service, then its usernames, passwords and API keys. Tap the dots to see a secret, and the copy button to copy it.'), add);
    const list = el('div', 'cr-list');
    list.id = 'crList';
    body.replaceChildren(top, list);
    renderList();
  }
  function renderList() {
    const list = $('crList');
    if (!list) return;
    if (!CR.loaded) return list.replaceChildren(el('p', 'cr-empty', CR.error || 'Loading…'));
    if (!CR.list.length) return list.replaceChildren(el('p', 'cr-empty', 'No credentials yet.'));
    const q = CR.q.trim().toLowerCase();
    const rows = CR.list.filter((s) => !q || s.name.toLowerCase().includes(q) || s.url.toLowerCase().includes(q) || s.fields.some((f) => f.label.toLowerCase().includes(q)));
    list.replaceChildren(...(rows.length ? rows.map(card) : [el('p', 'cr-empty', `Nothing matches "${CR.q.trim()}".`)]));
  }

  function card(s) {
    const c = el('article', 'cr-card');
    const head = el('div', 'cr-head');
    const id = el('div', 'cr-id');
    id.append(el('h3', 'cr-name', s.name));
    if (s.url) {
      const a = el('a', 'cr-url', host(s.url));
      a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      id.append(a);
    }
    head.append(id);
    c.append(head);
    if (s.fields.length) {
      const dl = el('div', 'cr-fields');
      s.fields.forEach((f, i) => dl.append(fieldRow(s, f, i)));
      c.append(dl);
    }
    if (s.notes) c.append(el('p', 'cr-notes', s.notes));
    const acts = el('div', 'cr-acts');
    const env = btn('cr-act', null, () => copy(s.fields.map(envLine).join('\n') + '\n', `${s.name} as .env`));
    env.innerHTML = `${svg('env', 17)}<span>Copy .env</span>`;
    env.disabled = !s.fields.length;
    const edit = btn('cr-act', null, () => startEdit(s));
    edit.innerHTML = `${svg('edit', 17)}<span>Edit</span>`;
    edit.setAttribute('aria-label', `Edit ${s.name}`);
    acts.append(env, edit);
    c.append(acts);
    return c;
  }
  function fieldRow(s, f, i) {
    const key = `${s.id}:${i}`, wrap = el('div', 'cr-field');
    const shown = !f.secret || CR.shown.has(key);
    const val = el('div', `cr-val${shown ? '' : ' masked'}`);
    val.textContent = shown ? f.value || '—' : '••••••••••••';
    if (!f.value) val.classList.add('empty');
    const tools = el('div', 'cr-tools');
    if (f.secret && f.value) {
      const eye = iconBtn('cr-icon', shown ? 'hide' : 'eye', `${shown ? 'Hide' : 'Show'} ${f.label}`, () => {
        if (CR.shown.has(key)) CR.shown.delete(key); else CR.shown.add(key);
        wrap.replaceWith(fieldRow(s, f, i));
        $('credModal').querySelector(`[data-key="${CSS.escape(key)}"] .cr-icon`)?.focus();
      });
      // Tapping the dots reveals too: the biggest target on a phone.
      if (!shown) { val.setAttribute('role', 'button'); val.tabIndex = -1; val.onclick = eye.onclick; }
      tools.append(eye);
    }
    if (f.value) tools.append(iconBtn('cr-icon', 'copy', `Copy ${f.label}`, () => copy(f.value, f.label)));
    wrap.dataset.key = key;
    const text = el('div', 'cr-text');
    text.append(el('span', 'cr-label', f.label), val);
    wrap.append(text, tools);
    return wrap;
  }

  // ---- the editor (in place of the list)
  function input(value, placeholder, label) {
    const i = el('input');
    i.value = value || ''; i.placeholder = placeholder || '';
    i.autocomplete = 'off'; i.spellcheck = false; i.autocapitalize = 'none';
    if (label) i.setAttribute('aria-label', label);
    return i;
  }
  function labeled(label, control, hint) {
    const w = el('label', 'cr-lf');
    w.append(el('span', 'cr-lbl', label), control);
    if (hint) w.append(el('small', 'cr-fhint', hint));
    return w;
  }
  function startEdit(s) {
    CR.edit = { id: s?.id ?? null };
    const body = $('crBody');
    const form = el('form', 'cr-form');
    form.noValidate = true;
    form.autocomplete = 'off';
    const name = input(s?.name, 'e.g. Stripe, Postgres, Namecheap', 'Service');
    name.maxLength = 80;
    const url = input(s?.url, 'Optional, e.g. dashboard.stripe.com', 'Link');
    url.inputMode = 'url';
    const rows = el('div', 'cr-rows');
    const addRow = (f = { label: '', value: '', secret: true }) => {
      const r = el('div', 'cr-row');
      const lab = input(f.label, 'Name, e.g. API key', 'Field name');
      lab.className = 'cr-flabel';
      const val = input(f.value, 'Value', 'Value');
      val.className = 'cr-fvalue';
      // A hidden field still reads as dots while it's being typed, unless the eye is on.
      let secret = !!f.secret, peek = !f.value;
      const hideBox = el('label', 'cr-secret');
      const cb = el('input');
      cb.type = 'checkbox'; cb.checked = secret;
      cb.onchange = () => { secret = cb.checked; r.dataset.touched = '1'; sync(); };
      hideBox.append(cb, document.createTextNode('Secret'));
      hideBox.title = 'Show as dots until tapped';
      const eye = iconBtn('cr-icon', 'eye', 'Show the value', () => { peek = !peek; sync(); });
      const del = iconBtn('cr-icon cr-del', 'x', 'Remove this field', () => { r.remove(); if (!rows.children.length) addRow(); });
      const sync = () => {
        val.type = secret && !peek ? 'password' : 'text';
        eye.hidden = !secret;
        eye.innerHTML = svg(peek ? 'hide' : 'eye');
        eye.setAttribute('aria-label', peek ? 'Hide the value' : 'Show the value');
      };
      // A username or URL needs no dots: guess from the name until the box is touched.
      lab.onblur = () => { if (!r.dataset.touched && lab.value.trim()) { secret = cb.checked = !PLAIN.test(lab.value.trim()); sync(); } };
      sync();
      r.read = () => ({ label: lab.value, value: val.value, secret });
      const v = el('div', 'cr-vwrap');
      v.append(val, eye);
      r.append(lab, v, hideBox, del);
      rows.append(r);
      return lab;
    };
    for (const f of s?.fields?.length ? s.fields : [{ label: '', value: '', secret: false }, { label: '', value: '', secret: true }]) addRow(f);
    const more = el('div', 'cr-more');
    const pasteBox = el('div', 'cr-paste');
    pasteBox.hidden = true;
    const ta = el('textarea');
    ta.rows = 4; ta.spellcheck = false; ta.autocapitalize = 'none';
    ta.placeholder = 'STRIPE_SECRET_KEY=sk_live_…\nSTRIPE_PUBLISHABLE_KEY=pk_live_…';
    ta.setAttribute('aria-label', '.env lines');
    const pasteAdd = btn('btn small', 'Add these', () => {
      const got = parseEnv(ta.value);
      if (!got.length) { err.textContent = 'No KEY=value lines found'; return; }
      for (const r of [...rows.children]) { const f = r.read(); if (!f.label && !f.value) r.remove(); }
      for (const f of got) addRow(f).closest('.cr-row').dataset.touched = '1';
      ta.value = ''; pasteBox.hidden = true; err.textContent = '';
      toast(`Added ${got.length} field${got.length === 1 ? '' : 's'}`, { kind: 'success', duration: 2000 });
    });
    pasteBox.append(ta, pasteAdd);
    more.append(btn('btn small', 'Add field', () => addRow().focus()), btn('btn small', 'Paste .env lines', () => { pasteBox.hidden = !pasteBox.hidden; if (!pasteBox.hidden) ta.focus(); }));
    const notes = el('textarea');
    notes.rows = 3; notes.value = s?.notes || ''; notes.placeholder = 'Optional: what it is for, where it is used, recovery codes…';
    const err = el('div', 'cr-err');
    err.setAttribute('role', 'alert');
    const foot = el('div', 'cr-foot');
    if (s) foot.append(btn('btn danger', 'Delete', async () => {
      if (!confirm(`Delete ${s.name} and all its credentials? This can't be undone.`)) return;
      try { await api(`/api/credentials/${s.id}`, 'DELETE'); toast(`Deleted ${s.name}`); CR.edit = null; await load(); render(); }
      catch (x) { err.textContent = x.message; }
    }));
    const submit = el('button', 'btn primary', s ? 'Save' : 'Add service');
    submit.type = 'submit';
    foot.append(el('span', 'cr-gap'), btn('btn', 'Cancel', () => { CR.edit = null; render(); }), submit);
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!name.value.trim()) { err.textContent = 'Give the service a name'; return name.focus(); }
      const data = { name: name.value, url: url.value, notes: notes.value, fields: [...rows.children].map((r) => r.read()) };
      submit.disabled = true;
      try {
        const r = s ? await api(`/api/credentials/${s.id}`, 'PUT', data) : await api('/api/credentials', 'POST', data);
        toast(`${s ? 'Saved' : 'Added'} ${r.service.name}`, { kind: 'success' });
        CR.edit = null;
        await load(); render();
      } catch (x) { err.textContent = x.message; } finally { submit.disabled = false; }
    };
    const fieldsSec = el('div', 'cr-lf');
    fieldsSec.append(el('span', 'cr-lbl', 'Credentials'), rows, more, pasteBox);
    form.append(el('h3', 'cr-etitle', s ? `Edit ${s.name}` : 'New service'), labeled('Service', name), labeled('Link', url), fieldsSec,
      labeled('Notes', notes), err, foot);
    body.replaceChildren(form);
    if (!coarse) name.focus();
  }

  $('credBtn').addEventListener('click', open);
  $('credModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('credModal').hidden) return;
    e.stopImmediatePropagation();
    if (CR.edit) { document.activeElement?.blur?.(); CR.edit = null; render(); } else close();
  }, true);

  window.Credentials = { open, parseEnv, envLine };
})();
