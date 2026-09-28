'use strict';
// ---------- Skills & tools: skills, MCP servers, subagents and personas (server: extensions.mjs, /api/ext*) ----------
// Settings → Skills & tools opens the sheet (#extModal) on one kind's tab: its list, and an editor that takes the list's
// place (Back, Cancel or Esc returns, asking first when something was typed). The composer's persona chip (#personaChip)
// picks the open chat's persona, or the next new chat's. Loaded after app.js and uses its helpers ($, el, api, toast,
// store, state, currentConvo, menuOpt, bindMenu, openSettings, closeSettings, CM).
const EX = { data: null, err: '', tab: 'skills', edit: null, dirty: false, saving: false, lastFocus: null, fromSettings: false, seq: 0, personas: null, draft: store.get('cw.persona') || null };
const EX_KINDS = {
  skills: { label: 'Skills', one: 'skill', key: (s) => s.folder,
    sub: 'Instructions, and any files they need, that an agent loads when a task calls for them. Saved in ~/.claude/skills and ~/.codex/skills, so chats, tasks and the Terminal all use them. Skills synced from your Claude account show here too.',
    empty: 'No skills yet. Add one from GitHub or a .zip file (drop it here), or write your own.' },
  mcp: { label: 'MCP servers', one: 'server', key: (s) => s.name,
    sub: 'Servers that give agents extra tools: a browser, a database, docs, other apps. agent-orch starts the ones that are on for its chat turns and task runs on this server (not for the Terminal), so each uses some memory while they run.',
    empty: 'No MCP servers yet.' },
  agents: { label: 'Subagents', one: 'subagent', key: (a) => a.file,
    sub: 'Specialists Claude Code can hand part of a task to, each with its own instructions, tools and model. Saved in ~/.claude/agents. Claude Code only: Codex has no subagents.',
    empty: 'No subagents yet.' },
  personas: { label: 'Personas', one: 'persona', key: (p) => p.id,
    sub: "How a chat's agents work and talk. Pick one per chat with the persona button next to the model; the chat's planner and tasks follow it too.",
    empty: 'No personas yet. Start from a suggestion or write your own.' },
};
const EX_AGENT_NAMES = { claude: 'Claude', codex: 'Codex' };
const EX_MCP_TYPES = [['stdio', 'Command'], ['http', 'HTTP'], ['sse', 'SSE']];
const EX_MODELS = [['', 'Default'], ['inherit', 'Same as the chat'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const EX_MCP_EXAMPLES = [
  { label: 'Playwright (browser)', name: 'playwright', type: 'stdio', commandLine: 'npx -y @playwright/mcp@latest --headless' },
  { label: 'Context7 (library docs)', name: 'context7', type: 'http', url: 'https://mcp.context7.com/mcp' },
];
const EX_PERSONA_STARTERS = [
  { name: 'Staff engineer', description: 'Pragmatic, simple designs, tested', prompt: 'You are a pragmatic staff engineer. Prefer the simplest design that works and fits the existing code. Explain trade-offs in a sentence or two, push back on scope creep, add tests for what you change, and leave the code cleaner than you found it.' },
  { name: 'Product designer', description: 'Hierarchy, spacing, accessibility', prompt: 'You are a senior product designer who writes code. Care about visual hierarchy, spacing, typography, dark mode, accessibility and small-screen layouts, and follow platform conventions. Check UI changes with screenshots before calling them done.' },
  { name: 'Security reviewer', description: 'Finds and fixes security gaps', prompt: 'You are a security engineer. Look for injection, broken authentication and permissions, secrets in code or logs, unsafe defaults and missing input validation. Fix what you find, and add a test that proves each fix.' },
  { name: 'Teacher', description: 'Explains what and why, plainly', prompt: 'You are a patient teacher. Explain what you are doing and why in plain language, define jargon the first time it comes up, keep answers short, and end with one thing worth learning next.' },
];

// ----- data
async function exLoad() {
  try { exApply(await api('/api/ext')); EX.err = ''; } catch (e) { EX.err = e.message; }
  exRender();
}
async function exLoadPersonas() {
  try { EX.personas = (await api('/api/ext/personas')).personas || []; } catch { return; }
  if (EX.data) EX.data.personas = EX.personas;
  exRenderChip();
}
function exApply(r) {
  EX.data = { ...EX.data };
  for (const k of Object.keys(EX_KINDS)) if (Array.isArray(r[k])) EX.data[k] = r[k];
  if (r.paths) EX.data.paths = r.paths;
  EX.personas = EX.data.personas || EX.personas;
  exCounts();
  exRenderChip();
}
// Settings → Agents → Skills & tools: one line summing up what is set up ("2 skills · 1 MCP server"), enabled MCP servers only.
function exCounts() {
  if (!EX.data) return;
  const names = { skills: ['skill', 'skills'], mcp: ['MCP server', 'MCP servers'], agents: ['subagent', 'subagents'], personas: ['persona', 'personas'] };
  const parts = Object.entries(names).map(([k, [one, many]]) => {
    const list = EX.data[k] || [], n = k === 'mcp' ? list.filter((s) => s.enabled !== false).length : list.length;
    return n ? `${n} ${n === 1 ? one : many}` : null;
  }).filter(Boolean);
  $('stExtSummary').textContent = parts.length ? parts.join(' · ') : 'Skills, MCP servers, subagents and personas';
}

// ----- sheet
// fromSettings: opened from a Settings row, so closing returns to Settings and the header shows "‹ Settings".
function exOpen(tab = EX.tab, { fromSettings = false } = {}) {
  const m = $('extModal');
  if (m.hidden) { EX.lastFocus = document.activeElement; EX.fromSettings = fromSettings; }
  $('extBackSettings').hidden = !EX.fromSettings;
  EX.tab = EX_KINDS[tab] ? tab : 'skills';
  EX.edit = null;
  EX.dirty = false;
  m.hidden = false;
  exTabs();
  exRender();
  exLoad(); // skills and subagents can change on disk, so every open reads them again
  $(`extTab-${EX.tab}`).focus();
}
function exClose() {
  if (!exDiscardOk()) return;
  $('extModal').hidden = true;
  EX.edit = null;
  EX.dirty = false;
  (EX.lastFocus?.isConnected ? EX.lastFocus : $('settingsBtn')).focus?.();
  if (EX.fromSettings) { EX.fromSettings = false; openSettings(); }
}
const exDiscardOk = () => !EX.dirty || confirm('Discard your changes?');
function exTabs() {
  for (const b of $('extTabs').querySelectorAll('[role="tab"]')) {
    const on = b.dataset.tab === EX.tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('extBody').setAttribute('aria-labelledby', `extTab-${EX.tab}`);
}
function exSelectTab(tab) {
  if (tab === EX.tab && !EX.edit) return;
  if (!exDiscardOk()) return;
  EX.tab = tab;
  EX.edit = null;
  EX.dirty = false;
  exTabs();
  exRender();
}
$('extTabs').addEventListener('click', (e) => { const b = e.target.closest('[role="tab"]'); if (b) exSelectTab(b.dataset.tab); });
$('extTabs').addEventListener('keydown', (e) => {
  const tabs = [...$('extTabs').querySelectorAll('[role="tab"]')], i = tabs.indexOf(document.activeElement);
  const j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
  if (j == null || i < 0) return;
  e.preventDefault();
  const t = tabs[(j + tabs.length) % tabs.length];
  t.focus();
  exSelectTab(t.dataset.tab);
});
$('extModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) exClose(); });
{ // "‹ Settings", above the title; shown only when the sheet was opened from Settings (closing goes back there too)
  const back = exBtn('', 'link-btn ext-back ext-back-settings', () => exClose());
  back.id = 'extBackSettings';
  back.hidden = true;
  back.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  back.append(el('span', null, 'Settings'));
  back.setAttribute('aria-label', 'Back to Settings');
  $('extTitle').before(back);
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('extModal').hidden || CM.open) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (EX.edit) exBack(); else exClose();
}, true);
// Settings → Skills & tools rows (their counts load with the sheet).
for (const b of document.querySelectorAll('[data-ext-open]')) b.addEventListener('click', () => { closeSettings(); exOpen(b.dataset.extOpen, { fromSettings: true }); });
$('settingsBtn').addEventListener('click', () => exLoad());

// ----- list
function exRender() {
  if ($('extModal').hidden || EX.edit) return; // an open editor is never rebuilt under the owner's typing
  const k = EX_KINDS[EX.tab], body = $('extBody');
  const frag = document.createDocumentFragment();
  frag.append(el('p', 'ext-sub', k.sub));
  const acts = el('div', 'ext-acts');
  acts.append(EX.tab === 'skills' ? exBtn('Add skill', 'btn small primary', () => exEdit(null, 'add')) : exBtn(`New ${k.one}`, 'btn small primary', () => exEdit(null)));
  frag.append(acts);
  const items = EX.data?.[EX.tab];
  if (!items) frag.append(el('p', 'ext-empty', EX.err ? `Couldn't load: ${EX.err}` : 'Loading…'));
  else if (!items.length) frag.append(el('p', 'ext-empty', k.empty));
  else {
    const ul = el('ul', 'ext-list');
    ul.setAttribute('aria-label', k.label);
    for (const it of items) ul.append(exRow(it));
    frag.append(ul);
  }
  const top = body.scrollTop;
  body.replaceChildren(frag);
  body.scrollTop = top;
}
function exBtn(label, cls, onclick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.onclick = onclick;
  return b;
}
function exRow(it) {
  const li = el('li', 'ext-item'), open = el('button', 'ext-open');
  open.type = 'button';
  open.dataset.key = EX_KINDS[EX.tab].key(it);
  const main = el('span', 'ext-main');
  main.append(el('strong', null, it.name));
  const sum = EX.tab === 'mcp' ? it.commandLine || it.url : EX.tab === 'personas' ? it.description || it.prompt : it.description;
  if (sum) main.append(el('small', EX.tab === 'mcp' ? 'mono' : null, sum));
  const tags = el('span', 'ext-tags');
  for (const t of exTags(it)) tags.append(el('span', 'ext-tag', t));
  if (EX.tab === 'mcp' && it.ungatedOutbound) {
    const warn = el('span', 'ext-tag ext-tag-warn', 'not gated');
    warn.title = "Outbound tools can't be held for your approval over SSE; this server stays out of task runs until you add it as http or a stdio command";
    tags.append(warn);
  }
  open.append(main, tags);
  open.insertAdjacentHTML('beforeend', '<svg class="ext-chev" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>');
  open.onclick = () => exEdit(it);
  li.append(open);
  if (EX.tab === 'mcp') {
    const sw = el('input', 'st-switch');
    sw.type = 'checkbox';
    sw.setAttribute('role', 'switch');
    sw.checked = it.enabled !== false;
    sw.setAttribute('aria-label', `Use ${it.name}`);
    sw.title = sw.checked ? 'On: started for chats and tasks' : 'Off';
    sw.onchange = async () => {
      sw.disabled = true;
      try { exApply(await api(`/api/ext/mcp/${encodeURIComponent(it.name)}`, 'PATCH', { enabled: sw.checked })); }
      catch (e) { sw.checked = !sw.checked; toast(`Couldn't switch ${it.name}: ${e.message}`, { kind: 'error' }); }
      sw.disabled = false;
      exRender();
      $('extBody').querySelector(`.ext-open[data-key="${CSS.escape(it.name)}"]`)?.parentElement.querySelector('.st-switch')?.focus();
    };
    li.append(sw);
  } else li.classList.add('no-switch');
  return li;
}
function exTags(it) {
  const agents = (list) => (list || []).map((a) => EX_AGENT_NAMES[a] || a);
  if (EX.tab === 'skills') return [...(it.source === 'synced' ? ['Synced'] : []), ...agents(it.agents), ...(it.files > 1 ? [`${it.files} files`] : [])];
  if (EX.tab === 'agents') return it.model ? [EX_MODELS.find(([v]) => v === it.model)?.[1] || it.model] : [];
  if (EX.tab === 'mcp') return [EX_MCP_TYPES.find(([v]) => v === it.type)?.[1] || it.type, ...agents(it.agents)];
  const n = state.convos.filter((c) => c.persona === it.id).length;
  return n ? [`${n} chat${n > 1 ? 's' : ''}`] : [];
}

// ----- editor
function exField(label, input, hint) {
  const wrap = el('div', 'ext-field'), id = `exf-${++EX.seq}`;
  input.id = id;
  const l = el('label', null, label);
  l.htmlFor = id;
  wrap.append(l, input);
  if (hint) {
    const h = el('small', null, hint);
    h.id = `${id}-h`;
    input.setAttribute('aria-describedby', h.id);
    wrap.append(h);
  }
  return wrap;
}
function exInput(name, value = '', { placeholder = '', mono = false, type = 'text', maxLength } = {}) {
  const i = el('input', mono ? 'mono' : null);
  Object.assign(i, { type, name, value: value ?? '', placeholder, autocomplete: 'off', spellcheck: false });
  i.setAttribute('autocapitalize', 'off');
  if (maxLength) i.maxLength = maxLength;
  return i;
}
function exArea(name, value = '', { rows = 4, placeholder = '', mono = false, maxLength } = {}) {
  const t = el('textarea', mono ? 'mono' : null);
  Object.assign(t, { name, value: value ?? '', rows, placeholder, spellcheck: !mono });
  if (mono) t.setAttribute('autocapitalize', 'off');
  if (maxLength) t.maxLength = maxLength;
  return t;
}
function exAgentsBox(selected, { codex = true, note = '' } = {}) {
  const fs = el('fieldset', 'ext-agents');
  fs.append(el('legend', null, 'Use with'));
  for (const [id, label] of [['claude', 'Claude Code'], ['codex', 'Codex']]) {
    const l = el('label', 'ext-check'), c = el('input');
    Object.assign(c, { type: 'checkbox', name: 'agents', value: id, checked: selected.includes(id) });
    if (id === 'codex' && !codex) { c.disabled = true; c.checked = false; }
    l.append(c, el('span', null, label));
    fs.append(l);
  }
  if (note) fs.append(el('small', null, note));
  return fs;
}
function exChips(label, items, onpick) {
  const row = el('div', 'ext-starters');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', label);
  row.append(el('span', 'ext-starters-k', label));
  for (const it of items) row.append(exBtn(it.label || it.name, 'chip', () => onpick(it)));
  return row;
}
// One entry's editor (item null = new), in place of the list. Skills also have modes: 'add' (GitHub link, upload or
// from scratch), 'import' (the GitHub link), 'preview' (item = a staged skill to install); a synced skill is read-only.
function exEdit(item, mode = null) {
  EX.edit = { item, mode, tab: EX.tab };
  EX.dirty = false;
  const k = EX_KINDS[EX.tab], body = $('extBody');
  const form = el('form', 'ext-form');
  form.noValidate = true;
  const head = el('div', 'ext-edit-head');
  const back = exBtn('', 'link-btn ext-back', () => exBack());
  back.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  back.append(el('span', null, k.label));
  back.setAttribute('aria-label', `Back to ${k.label}`);
  const title = { add: 'Add a skill', import: 'Add a skill from GitHub', preview: `Install ${item?.name}` }[mode] || (item ? item.name : `New ${k.one}`);
  const readOnly = !!item?.readOnly || mode === 'add';
  head.append(back, el('h3', null, title));
  form.append(head);
  const fields = el('div', 'ext-fields');
  form.append(fields);
  ({ skills: exSkillFields, mcp: exMcpFields, agents: exAgentFields, personas: exPersonaFields })[EX.tab](fields, item, mode, form);
  const err = el('p', 'ext-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;
  const acts = el('div', 'ext-form-acts');
  if (item && !mode && !readOnly) acts.append(exBtn('Delete', 'btn small danger', () => exDelete(item)));
  acts.append(el('span', 'ext-gap'));
  acts.append(exBtn(readOnly && mode !== 'add' ? 'Done' : 'Cancel', 'btn small', () => exBack()));
  const save = el('button', 'btn small primary', { import: 'Preview', preview: 'Install' }[mode] || (item ? 'Save' : 'Add'));
  save.type = 'submit';
  if (!readOnly && !(mode === 'preview' && item.exists === 'synced')) acts.append(save);
  form.append(err, acts);
  form.addEventListener('input', () => { EX.dirty = true; });
  form.addEventListener('submit', (e) => { e.preventDefault(); if (save.isConnected) exSubmit(form, item, mode, save, err); });
  body.replaceChildren(form);
  body.scrollTop = 0;
  form.querySelector(readOnly ? '.ext-choice, .ext-back' : 'input:not([type="checkbox"]):not([type="radio"]), textarea')?.focus({ preventScroll: true });
}
function exBack() {
  if (!exDiscardOk()) return;
  const key = EX.edit?.item && EX_KINDS[EX.tab].key(EX.edit.item);
  EX.edit = null;
  EX.dirty = false;
  exRender();
  const row = key != null && $('extBody').querySelector(`.ext-open[data-key="${CSS.escape(key)}"]`);
  (row || $('extBody').querySelector('.ext-acts button'))?.focus();
}
function exSkillFields(f, s, mode) {
  if (mode === 'add') {
    const ul = el('ul', 'ext-list ext-choices');
    ul.setAttribute('aria-label', 'Ways to add a skill');
    const choice = (label, hint, onclick) => {
      const li = el('li', 'ext-item no-switch'), b = exBtn('', 'ext-open ext-choice', onclick), main = el('span', 'ext-main');
      main.append(el('strong', null, label), el('small', null, hint));
      b.append(main);
      b.insertAdjacentHTML('beforeend', '<svg class="ext-chev" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>');
      li.append(b);
      ul.append(li);
    };
    choice('From a GitHub link', 'A repository, a folder in one, or a SKILL.md. For example from github.com/anthropics/skills.', () => exEdit(null, 'import'));
    choice('Upload a .zip or .skill file', 'A folder with a SKILL.md, zipped. You can also drop the file onto the skills list.', () => exPickFile());
    choice('Create from scratch', 'Write the instructions yourself.', () => exEdit(null));
    f.append(ul);
    return;
  }
  if (mode === 'import') {
    f.append(exField('GitHub link', exInput('url', '', { placeholder: 'https://github.com/anthropics/skills/tree/main/skills/pdf', type: 'url' }),
      'A repository, a folder with a SKILL.md, or the SKILL.md itself (public, or private ones your GitHub sign-in can read). Its other files come along. You see what it holds before anything is installed.'));
    return;
  }
  if (mode === 'preview') {
    const dl = el('dl', 'ext-preview');
    const files = s.files.length > 30 ? [...s.files.slice(0, 30), `…and ${s.files.length - 30} more`] : s.files;
    for (const [k, v] of [['Name', s.name], ['When to use it', s.description], [`Files (${s.files.length})`, files.join('\n')]]) dl.append(el('dt', null, k), el('dd', k.startsWith('Files') ? 'mono' : null, v));
    f.append(dl);
    if (s.exists === 'synced') f.append(el('p', 'ext-note ext-warn', `A skill named ${s.folder} is already synced from your Claude account, so this one can't be installed next to it.`));
    else if (s.exists) f.append(el('p', 'ext-note ext-warn', `A skill named ${s.folder} is already installed. Installing replaces it.`));
    f.append(exAgentsBox(['claude', 'codex']));
    return;
  }
  if (s?.readOnly) {
    f.append(el('p', 'ext-note', 'Synced from your Claude account. agent-orch can read it but not change or delete it: the next sync would undo that. Change it in Claude and it syncs back. Used by Claude Code on this machine only (workers get it from their own Claude sign-in).'));
    const desc = exArea('description', s.description, { rows: 2 }), body = exArea('body', s.body, { rows: 12, mono: true });
    desc.readOnly = body.readOnly = true;
    f.append(exField('When to use it', desc), exField('Instructions', body));
    if (s.files > 1) f.append(el('p', 'ext-note', `Plus ${s.files - 1} more file${s.files > 2 ? 's' : ''} in ~/.claude/skills/${s.path}.`));
    return;
  }
  f.append(exField('Name', exInput('name', s?.name ?? s?.folder, { placeholder: 'e.g. release-notes', maxLength: 64 }), 'Lowercase letters, numbers and hyphens. Also the folder name.'));
  f.append(exField('When to use it', exArea('description', s?.description, { rows: 2, maxLength: 1024, placeholder: 'e.g. Use when writing release notes or a changelog entry.' }),
    'The agent reads this to decide when to load the skill, so name the situations.'));
  f.append(exField('Instructions', exArea('body', s?.body, { rows: 12, mono: true, placeholder: '# Release notes\n\n1. Read the commits since the last tag…' }), 'Markdown. Loaded only when the skill is used.'));
  if (s?.files > 1) f.append(el('p', 'ext-note', `This skill has ${s.files - 1} more file${s.files > 2 ? 's' : ''} (scripts or references). Saving keeps them.`));
  f.append(exAgentsBox(s?.agents || ['claude', 'codex']));
}
function exMcpFields(f, s, _mode, form) {
  if (!s) f.append(exChips('Examples', EX_MCP_EXAMPLES, (x) => {
    form.elements.name.value = x.name;
    form.querySelector(`input[name="type"][value="${x.type}"]`).checked = true;
    form.elements.commandLine.value = x.commandLine || '';
    form.elements.url.value = x.url || '';
    EX.dirty = true;
    sync();
  }));
  f.append(exField('Name', exInput('name', s?.name, { placeholder: 'e.g. playwright', maxLength: 64 }), 'Letters, numbers, - and _. Its tools show up as mcp__<name>__<tool>.'));
  const type = el('fieldset', 'ext-seg');
  type.append(el('legend', null, 'Connects with'));
  for (const [v, label] of EX_MCP_TYPES) {
    const l = el('label'), r = el('input');
    Object.assign(r, { type: 'radio', name: 'type', value: v, checked: (s?.type || 'stdio') === v });
    l.append(r, el('span', null, label));
    type.append(l);
  }
  f.append(type);
  const cmd = exField('Command', exInput('commandLine', s?.commandLine, { mono: true, placeholder: 'npx -y @playwright/mcp@latest' }), 'Started on this server, as your user, when a chat or task starts.');
  const env = exField('Environment variables', exArea('env', exPairs(s?.env, '='), { rows: 3, mono: true, placeholder: 'API_KEY=…' }),
    'One KEY=value per line. Saved values show as ••••••; leave those as they are to keep them.');
  // A connector (gate.mjs): the tools named here are held for the owner's approval in task runs, and every call is logged.
  const outbound = exField('Outbound tools', exInput('outbound', (s?.outbound || []).join(', '), { mono: true, placeholder: 'e.g. send_email, create_payment, delete_*' }),
    "Optional. Makes it a connector: in task runs these tools wait for your approval (tools named like send, pay, delete, publish or share do too), and every call shows in the task's Actions.");
  const sseNote = el('p', 'ext-note', "Outbound tools can't be held for your approval over SSE; this server stays out of task runs until you add it as http or a stdio command");
  outbound.append(sseNote);
  const url = exField('URL', exInput('url', s?.url, { mono: true, type: 'url', placeholder: 'https://example.com/mcp' }));
  const headers = exField('Headers', exArea('headers', exPairs(s?.headers, ': '), { rows: 3, mono: true, placeholder: 'Authorization: Bearer …' }),
    'One Name: value per line. Saved values show as ••••••; leave those as they are to keep them.');
  const agents = exAgentsBox(s?.agents || ['claude', 'codex']);
  const on = el('label', 'ext-on');
  const sw = el('input', 'st-switch');
  Object.assign(sw, { type: 'checkbox', name: 'enabled', checked: s ? s.enabled !== false : true });
  sw.setAttribute('role', 'switch');
  on.append(el('span', null, 'On'), sw);
  f.append(cmd, env, outbound, url, headers, agents, on);
  const sync = () => {
    const t = form.querySelector('input[name="type"]:checked')?.value || 'stdio';
    cmd.hidden = env.hidden = t !== 'stdio';
    url.hidden = headers.hidden = t === 'stdio';
    sseNote.hidden = t !== 'sse';
    const codex = agents.querySelector('input[value="codex"]');
    codex.disabled = t === 'sse';
    if (t === 'sse') codex.checked = false;
    agents.querySelector('small')?.remove();
    if (t === 'sse') agents.append(el('small', null, "Codex can't use SSE servers."));
  };
  type.addEventListener('change', sync);
  sync();
}
const exPairs = (o, sep) => Object.entries(o || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');
function exAgentFields(f, a) {
  f.append(exField('Name', exInput('name', a?.name ?? a?.file, { placeholder: 'e.g. code-reviewer', maxLength: 64 }), 'Lowercase letters, numbers and hyphens.'));
  f.append(exField('When to use it', exArea('description', a?.description, { rows: 2, maxLength: 1024, placeholder: 'e.g. Reviews a diff for bugs and missing tests. Use after finishing a change.' }),
    'Claude reads this to decide when to hand work to it.'));
  f.append(exField('Instructions', exArea('prompt', a?.prompt, { rows: 10, mono: true, placeholder: 'You are a careful code reviewer…' }), 'Its system prompt.'));
  f.append(exField('Tools', exInput('tools', a?.tools, { placeholder: 'All tools', mono: true }), 'Optional. Comma-separated, e.g. Read, Grep, Glob, Bash. Blank = the same tools as the chat.'));
  const sel = el('select');
  sel.name = 'model';
  const opts = [...EX_MODELS];
  if (a?.model && !opts.some(([v]) => v === a.model)) opts.push([a.model, a.model]);
  for (const [v, label] of opts) sel.append(new Option(label, v, false, (a?.model || '') === v));
  f.append(exField('Model', sel, 'Default: the subagent model Claude Code is set to use, else the chat’s.'));
}
function exPersonaFields(f, p, _mode, form) {
  if (!p) f.append(exChips('Start from', EX_PERSONA_STARTERS, (x) => {
    form.elements.name.value = x.name;
    form.elements.description.value = x.description;
    form.elements.prompt.value = x.prompt;
    EX.dirty = true;
  }));
  f.append(exField('Name', exInput('name', p?.name, { placeholder: 'e.g. Staff engineer', maxLength: 60 })));
  f.append(exField('Summary', exInput('description', p?.description, { placeholder: 'Optional. Shown in the persona menu', maxLength: 200 })));
  f.append(exField('Instructions', exArea('prompt', p?.prompt, { rows: 9, maxLength: 20000, placeholder: 'You are… Focus on… When you reply…' }),
    "Added to the system prompt of every chat that uses it and of that chat's planner and tasks."));
  const n = p ? state.convos.filter((c) => c.persona === p.id).length : 0;
  if (n) f.append(el('p', 'ext-note', `Used by ${n} chat${n > 1 ? 's' : ''}. Changes apply from their next message.`));
}
async function exSubmit(form, item, mode, save, err) {
  if (EX.saving) return;
  const fd = new FormData(form), body = {};
  for (const [k, v] of fd.entries()) if (k !== 'agents' && k !== 'enabled') body[k] = v;
  if (form.querySelector('fieldset.ext-agents')) body.agents = fd.getAll('agents');
  if (EX.tab === 'mcp') body.enabled = !!form.elements.enabled?.checked;
  if (mode === 'import') body.preview = true;
  else if (mode === 'preview') { body.id = item.id; if (item.exists === 'local') body.replace = true; }
  else if (item) { if (EX.tab === 'personas') body.id = item.id; else body.prev = EX_KINDS[EX.tab].key(item); }
  const tab = EX.tab, url = mode === 'import' || mode === 'preview' ? '/api/ext/import' : `/api/ext/${tab}`, label = save.textContent;
  EX.saving = true;
  save.disabled = true;
  save.textContent = { import: 'Fetching…', preview: 'Installing…' }[mode] || 'Saving…';
  err.hidden = true;
  try {
    let r;
    if (mode === 'import') {
      r = await api(url, 'POST', body);
      if (EX.edit?.tab === tab) { EX.dirty = false; exEdit(r.preview, 'preview'); }
      return;
    }
    try { r = await api(url, 'POST', body); }
    catch (e) {
      const m = mode === 'preview' && /^A skill named (\S+) already exists$/.exec(e.message);
      if (!m || !confirm(`${m[1]} is already installed. Replace it with this one?`)) throw e;
      r = await api(url, 'POST', { ...body, replace: true });
    }
    exApply(r);
    if (EX.edit?.tab !== tab) return;
    EX.edit = null;
    EX.dirty = false;
    exRender();
    const name = r.item?.name || body.name || '';
    toast(mode === 'preview' ? `Installed ${name}` : item ? `Saved ${name}` : `Added ${name}`, { kind: 'success' });
    const key = r.item && EX_KINDS[tab].key(r.item);
    (key != null && $('extBody').querySelector(`.ext-open[data-key="${CSS.escape(key)}"]`))?.focus();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    err.scrollIntoView({ block: 'nearest' });
  } finally {
    EX.saving = false;
    if (save.isConnected) { save.disabled = false; save.textContent = label; }
  }
}
// ----- skill uploads: a .zip or .skill file (the picker, or dropped onto the skills list) is staged and previewed.
function exPickFile() {
  const i = el('input');
  Object.assign(i, { type: 'file', accept: '.zip,.skill,application/zip' });
  i.onchange = () => { if (i.files[0]) exUpload(i.files[0]); };
  i.click();
}
async function exUpload(file) {
  if (!/\.(zip|skill)$/i.test(file.name)) return toast('Upload a .zip or .skill file', { kind: 'error' });
  if (file.size > 25 << 20) return toast('That file is too big (max 25 MB)', { kind: 'error' });
  toast(`Reading ${file.name}…`);
  try {
    const r = await fetch('/api/ext/import/upload', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
    if (r.status === 401) { location.href = '/login'; return; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    if ($('extModal').hidden || !exDiscardOk()) return;
    EX.tab = 'skills';
    exTabs();
    exEdit(data.preview, 'preview');
  } catch (e) { toast(`Couldn't read ${file.name}: ${e.message}`, { kind: 'error' }); }
}
{
  const body = $('extBody'), files = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const on = (e) => EX.tab === 'skills' && !EX.edit && files(e);
  body.addEventListener('dragover', (e) => { if (!on(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; body.classList.add('ext-drop'); });
  body.addEventListener('dragleave', (e) => { if (!body.contains(e.relatedTarget)) body.classList.remove('ext-drop'); });
  body.addEventListener('drop', (e) => {
    body.classList.remove('ext-drop');
    if (!on(e)) return;
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) exUpload(f);
  });
}
async function exDelete(item) {
  const tab = EX.tab, name = item.name;
  const n = tab === 'personas' ? state.convos.filter((c) => c.persona === item.id).length : 0;
  const ask = {
    skills: `Delete the skill ${name}? Its folder is removed for ${(item.agents || []).map((a) => EX_AGENT_NAMES[a]).join(' and ')}.`,
    mcp: `Remove the MCP server ${name}? Chats and tasks stop starting it.`,
    agents: `Delete the subagent ${name}?`,
    personas: `Delete the persona ${name}?${n ? ` ${n} chat${n > 1 ? 's' : ''} using it go back to no persona.` : ''}`,
  }[tab];
  if (!confirm(ask)) return;
  try {
    exApply(await api(`/api/ext/${tab}/${encodeURIComponent(EX_KINDS[tab].key(item))}`, 'DELETE'));
    EX.edit = null;
    EX.dirty = false;
    exRender();
    toast(`Deleted ${name}`, { kind: 'success' });
    $('extBody').querySelector('.ext-acts button')?.focus();
  } catch (e) { toast(`Couldn't delete ${name}: ${e.message}`, { kind: 'error' }); }
}

// ----- composer persona chip: the open chat's persona (PUT /api/convos/:id/persona), or the next new chat's (stored)
const exCurrentPersona = () => { const c = currentConvo(); return c ? c.persona ?? null : EX.draft; };
function exRenderChip() {
  const chip = $('personaChip'), list = EX.personas || [], p = list.find((x) => x.id === exCurrentPersona());
  chip.hidden = !list.length && !p;
  chip.classList.toggle('on', !!p);
  $('personaLabel').textContent = p ? p.name : 'Persona';
  const t = p ? `Persona: ${p.name}` : 'Persona: none';
  chip.title = t;
  chip.setAttribute('aria-label', t);
}
bindMenu($('personaChip'), $('personaPop'), (menu) => {
  const cur = exCurrentPersona();
  menu.append(menuOpt('No persona', { value: '', selected: !cur, hint: 'Agents work in their own style' }));
  for (const p of EX.personas || []) menu.append(menuOpt(p.name, { value: p.id, selected: p.id === cur, hint: p.description || '', title: p.prompt.slice(0, 400) }));
  menu.append(el('div', 'cm-sep'));
  menu.append(menuOpt('Manage personas…', { value: '__manage' }));
}, (v) => exPickPersona(v));
async function exPickPersona(v) {
  if (v === '__manage') return exOpen('personas');
  const persona = v || null, c = currentConvo();
  if (!c) {
    EX.draft = persona;
    if (persona) store.set('cw.persona', persona); else store.del('cw.persona');
    return exRenderChip();
  }
  const was = c.persona ?? null;
  c.persona = persona;
  exRenderChip();
  try { c.persona = (await api(`/api/convos/${c.id}/persona`, 'PUT', { persona })).persona ?? null; }
  catch (e) { c.persona = was; toast(`Couldn't change the persona: ${e.message}`, { kind: 'error' }); }
  exRenderChip();
}

window.Ext = {
  open: exOpen,
  renderChip: exRenderChip,
  // The next new chat's persona, if it still exists.
  draftPersona: () => ((EX.personas || []).some((p) => p.id === EX.draft) ? EX.draft : null),
  // Another tab (or this one) changed something: refresh what is on screen, never an open editor.
  changed(kind) {
    if (kind === 'personas') exLoadPersonas();
    if (!$('extModal').hidden || !$('settingsModal').hidden) exLoad();
  },
};
exLoadPersonas();
