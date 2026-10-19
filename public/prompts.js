'use strict';
// ---------- Saved prompts (browser-local; no server) ----------
// A small library of reusable instructions (after winfunc/opcode's): save the composer's draft under a name, edit or
// delete it, and insert one at the composer's cursor (around the text already there, never sending it). Entries live
// only in this browser's localStorage, one list per signed-in user and project (`cw.prompts.v1.["<user>","<cwd>"]`:
// [{id, name, text, at}]); a new chat with no project yet has none. The composer's draft is never cleared or replaced
// here, and an unfinished edit survives closing the sheet. Desktop: the #promptsChip chip in the composer row; phones
// (<768px): a 'Saved prompts' row in the '+' sheet (#psPrompts). Both are added here, with their own handlers.
// Loaded after app.js and uses its helpers ($, el, toast, coarse, me, state, currentConvo, closePlusSheet).
(() => {
  const PL = { key: null, list: [], error: '', blocked: false, edit: null, sel: null, lastFocus: null };
  const PREFIX = 'cw.prompts.v1.';
  const NAME_MAX = 80;
  const input = $('input');
  const btn = (cls, text, onclick) => { const b = el('button', cls, text); b.type = 'button'; if (onclick) b.onclick = onclick; return b; };
  const ICON = '<svg viewBox="0 0 24 24" width="SZ" height="SZ" aria-hidden="true"><path d="M6 4h12v16l-6-4-6 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

  // The project the composer writes to: the open chat's folder, else a new chat's picked folder.
  const project = () => currentConvo()?.cwd || (state.draft.type === 'folder' ? state.draft.path : '') || null;
  const user = () => me.user?.id || 'admin';
  const keyOf = (u, p) => PREFIX + JSON.stringify([u, p]);

  function load() {
    const p = project();
    PL.key = p ? keyOf(user(), p) : null;
    PL.list = []; PL.error = ''; PL.blocked = false;
    if (!PL.key) return;
    let raw;
    try { raw = localStorage.getItem(PL.key); } catch (e) {
      PL.blocked = true;
      PL.error = `This browser won't let agent-orch use its storage (${e.message}), so prompts can't be saved here.`;
      return;
    }
    if (!raw) return;
    try {
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) throw new Error('not a list');
      PL.list = list.filter((x) => x && typeof x.name === 'string' && typeof x.text === 'string');
    } catch { PL.error = 'The saved prompts stored in this browser for this project could not be read; saving a prompt replaces them.'; }
  }
  // Writes the list; false (with PL.error set) when the browser refuses, e.g. its storage is full.
  function persist(list) {
    try {
      localStorage.setItem(PL.key, JSON.stringify(list));
    } catch (e) {
      PL.error = /quota/i.test(`${e.name} ${e.message}`)
        ? "Couldn't save: this browser's storage for agent-orch is full. Delete some saved prompts and try again."
        : `Couldn't save in this browser's storage (${e.message}).`;
      return false;
    }
    PL.list = list; PL.error = '';
    return true;
  }

  // ---- the sheet
  const modal = el('div', 'modal sheet');
  modal.id = 'plModal';
  modal.hidden = true;
  modal.innerHTML = `<div class="modal-backdrop" data-close></div>
  <div class="modal-panel plm" role="dialog" aria-modal="true" aria-labelledby="plTitle">
    <div class="sheet-grip" aria-hidden="true"></div>
    <div class="m-head">
      <div><h2 id="plTitle">Saved prompts</h2><p class="m-sub" id="plSub"></p></div>
      <button class="icon-btn" data-close aria-label="Close">
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="m-body pl-body" id="plBody"></div>
  </div>`;
  document.body.append(modal);
  const body = modal.querySelector('#plBody');

  function open(from) {
    if (modal.hidden) PL.lastFocus = from || document.activeElement;
    // Where an inserted prompt goes: the composer's cursor (the end of a selection, so nothing is replaced).
    PL.sel = input.selectionEnd ?? input.value.length;
    load();
    if (PL.edit && PL.edit.key !== PL.key) PL.edit = null; // an unfinished edit belongs to the project it started in
    modal.hidden = false;
    chip.setAttribute('aria-expanded', 'true');
    render();
    if (!coarse) (modal.querySelector('.pl-name') || modal.querySelector('.pl-insert') || modal.querySelector('[data-close].icon-btn')).focus();
  }
  function close() {
    if (modal.hidden) return;
    modal.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
    PL.lastFocus?.focus?.();
  }

  function render() {
    const p = project();
    $('plSub').textContent = p
      ? `Stored only in this browser, for ${me.user?.name || 'you'} in ${p.split('/').filter(Boolean).pop() || p}`
      : 'Stored only in this browser, per project';
    const out = [];
    if (PL.error) { const e = el('p', 'pl-err', PL.error); e.setAttribute('role', 'alert'); out.push(e); }
    if (!p) out.push(el('p', 'pl-empty', 'Open a project\'s chat (or pick a folder for this new one) to save prompts for it.'));
    else if (PL.edit) out.push(editor());
    else out.push(listView());
    body.replaceChildren(...out);
  }

  function listView() {
    const wrap = el('div', 'pl-list');
    const top = el('div', 'pl-top');
    top.append(el('p', 'pl-hint', 'Insert one at the composer\'s cursor; it isn\'t sent until you send it.'),
      btn('btn small primary pl-save-draft', 'Save current draft', () => startEdit(null)));
    wrap.append(top);
    if (!PL.list.length) wrap.append(el('p', 'pl-empty', 'No saved prompts for this project yet. Write one in the composer, then Save current draft.'));
    for (const x of PL.list) {
      const card = el('div', 'pl-card');
      card.dataset.id = x.id;
      const tools = el('div', 'pl-tools');
      const ins = btn('btn small primary pl-insert', 'Insert', () => insert(x));
      ins.setAttribute('aria-label', `Insert ${x.name}`);
      const ed = btn('btn small pl-edit', 'Edit', () => startEdit(x));
      ed.setAttribute('aria-label', `Edit ${x.name}`);
      const del = btn('btn small danger pl-del', 'Delete', () => remove(x));
      del.setAttribute('aria-label', `Delete ${x.name}`);
      tools.append(ins, ed, del);
      card.append(el('h3', 'pl-name-t', x.name), el('p', 'pl-text', x.text), tools);
      wrap.append(card);
    }
    return wrap;
  }

  // x: an entry to edit, or null to save the composer's draft as a new one.
  function startEdit(x) {
    PL.edit = { key: PL.key, id: x?.id || null, name: x ? x.name : '', text: x ? x.text : input.value, error: '' };
    render();
    modal.querySelector('.pl-name').focus();
  }
  function editor() {
    const ed = PL.edit;
    const form = el('form', 'pl-form');
    form.noValidate = true;
    const name = el('input', 'pl-name');
    Object.assign(name, { value: ed.name, maxLength: NAME_MAX, placeholder: 'e.g. Review checklist', autocomplete: 'off' });
    const text = el('textarea', 'pl-ta');
    Object.assign(text, { value: ed.text, rows: 8, placeholder: 'The prompt to insert' });
    name.oninput = () => (ed.name = name.value);
    text.oninput = () => (ed.text = text.value);
    const field = (label, ctl) => { const l = el('label', 'pl-field'); l.append(el('span', 'pl-label', label), ctl); return l; };
    const err = el('p', 'pl-err pl-form-err', ed.error);
    err.setAttribute('role', 'alert');
    err.hidden = !ed.error;
    const row = el('div', 'pl-actions');
    const save = el('button', 'btn small primary pl-save', ed.id ? 'Save changes' : 'Save prompt');
    save.type = 'submit';
    row.append(btn('btn small pl-cancel', 'Cancel', () => { PL.edit = null; render(); }), save);
    form.append(el('h3', 'pl-form-t', ed.id ? 'Edit saved prompt' : 'Save the draft as a prompt'), field('Name', name), field('Prompt', text), err, row);
    form.onsubmit = (e) => { e.preventDefault(); submit(); };
    return form;
  }
  function submit() {
    const ed = PL.edit, name = ed.name.trim();
    const fail = (msg, sel) => { ed.error = msg; render(); modal.querySelector(sel)?.focus(); };
    if (!name) return fail('Give the prompt a name.', '.pl-name');
    if (!ed.text.trim()) return fail('The prompt is empty. Type the text to save.', '.pl-ta');
    load(); // another tab may have changed the list
    if (PL.blocked) { const msg = PL.error; PL.error = ''; return fail(msg, '.pl-save'); }
    if (PL.list.some((x) => x.id !== ed.id && x.name.trim().toLowerCase() === name.toLowerCase())) return fail(`A saved prompt is already named “${name}”.`, '.pl-name');
    const entry = { id: ed.id || `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, text: ed.text, at: Date.now() };
    const list = ed.id && PL.list.some((x) => x.id === ed.id) ? PL.list.map((x) => (x.id === ed.id ? entry : x)) : [...PL.list, entry];
    if (!persist(list)) { const msg = PL.error; PL.error = ''; return fail(msg, '.pl-save'); }
    PL.edit = null;
    render();
    toast(`Saved “${name}” in this browser`);
  }
  function remove(x) {
    load();
    if (!persist(PL.list.filter((y) => y.id !== x.id))) return render();
    render();
    toast(`Deleted “${x.name}”`, { action: 'Undo', run: () => { load(); if (!PL.list.some((y) => y.id === x.id)) persist([...PL.list, x]); if (!modal.hidden) render(); } });
  }
  // Puts the text at the remembered cursor, keeps the text around it, and lets app.js save the draft (its input event).
  function insert(x) {
    const at = Math.min(PL.sel ?? input.value.length, input.value.length);
    input.setRangeText(x.text, at, at, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    PL.lastFocus = input;
    close();
  }

  // ---- the composer controls
  const chip = el('button', 'chip menu-chip pl-chip');
  chip.type = 'button';
  chip.id = 'promptsChip';
  chip.title = 'Saved prompts (stored in this browser)';
  chip.setAttribute('aria-haspopup', 'dialog');
  chip.setAttribute('aria-controls', 'plModal');
  chip.setAttribute('aria-expanded', 'false');
  chip.innerHTML = ICON.replaceAll('SZ', '14') + '<span>Prompts</span>';
  chip.addEventListener('click', () => open(chip));
  $('composer').querySelector('.controls .left').append(chip);

  const row = el('button', 'ps-row');
  row.type = 'button';
  row.id = 'psPrompts';
  row.innerHTML = ICON.replaceAll('SZ', '22') + '<span class="ps-l">Saved prompts</span>';
  row.addEventListener('click', () => { closePlusSheet(false); open($('plusBtn')); });
  $('plusSheet').querySelector('.ps-list .ps-sep').before(row);

  modal.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || modal.hidden) return;
    e.stopImmediatePropagation();
    close();
  }, true);

  window.Prompts = { open, close, keyOf };
})();
