// ---------- Execution Mode (server: execution.mjs, /api/execution; admin only) ----------
// The sidebar's Execution Mode button turns the whole page into Execution Mode (#execView over the app, which goes inert)
// through a suit-up transition (#exSuit: armour plates close in, the reactor lights, the plates open on the new page);
// "Exit to Orchestrator" plays it back. The page is the idea (plus reference images), then the questions that shape the
// build (products, app technology, design inspiration, domain plan, what needs the owner's permission, extras, which
// connected services to use) and "Bring it to life", which starts an orchestrator project and opens its chat; executions
// already started are listed beside it with their task counts. The mode survives a reload (localStorage cw.exec.on) and
// the draft survives leaving it (cw.exec.draft). Loaded after app.js and uses its helpers ($, el, api, toast, coarse,
// closeSidebar, openConvo, uploadAttachment, state).
(() => {
  const KEY = 'cw.exec.draft', ON = 'cw.exec.on';
  const blank = () => ({ idea: '', name: '', products: { web: true, ios: false, android: false, admin: true }, appTech: 'react-native',
    inspiration: { mobbin: true, refs: '' }, domain: { mode: 'find', name: '', bought: true }, askBefore: ['spend', 'publish'], emails: true, demoData: true, services: null });
  const EX = { d: blank(), att: [], services: [], executions: [], options: null, github: true, loaded: false, error: '', busy: false, lastFocus: null, anim: null };
  const btn = (cls, text, onclick) => { const b = el('button', cls, text); b.type = 'button'; if (onclick) b.onclick = onclick; return b; };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(EX.d)); } catch {} };
  const restore = () => { try { const j = JSON.parse(localStorage.getItem(KEY) || 'null'); if (j && typeof j === 'object') EX.d = { ...blank(), ...j, products: { ...blank().products, ...j.products }, inspiration: { ...blank().inspiration, ...j.inspiration }, domain: { ...blank().domain, ...j.domain } }; } catch {} };
  const remember = (on) => { try { on ? localStorage.setItem(ON, '1') : localStorage.removeItem(ON); } catch {} };
  const STATUS = { ready: 'Connected', partial: 'Some keys missing', missing: 'Not connected' };
  const isOn = () => !$('execView').hidden;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The suit-up: `dir` 'in' or 'out'; `swap` runs once the plates have closed over the screen (shows or hides the page).
  // Plates close (0-.55 s), the reactor lights (.45-1.1 s), the plates open (1.15-1.7 s). Reduced motion: a plain swap.
  function suit(dir, swap) {
    clearTimeout(EX.anim?.mid); clearTimeout(EX.anim?.end);
    const o = $('exSuit');
    if (still()) { swap(); o.hidden = true; return; }
    $('exSuitWord').textContent = dir === 'in' ? 'Execution Mode' : 'Orchestrator Mode';
    $('exSuitSub').textContent = dir === 'in' ? 'All systems online' : 'Standing down';
    o.className = `exs ${dir}`;
    o.hidden = false;
    void o.offsetWidth; // restart the keyframes
    o.classList.add('run');
    EX.anim = { mid: setTimeout(swap, 1100), end: setTimeout(() => { o.hidden = true; o.className = 'exs'; }, 1750) };
  }
  function show() {
    $('execView').hidden = false;
    $('app').inert = true;
    document.documentElement.classList.add('exec-on');
    render();
    if (!coarse) $('exIdea')?.focus({ preventScroll: true });
  }
  function enter({ instant = false } = {}) {
    if (isOn()) return;
    closeSidebar();
    EX.lastFocus = document.activeElement;
    remember(true);
    restore();
    load().then(render);
    instant ? show() : suit('in', show);
  }
  function exit() {
    if (!isOn()) return;
    save();
    remember(false);
    suit('out', () => {
      $('execView').hidden = true;
      $('app').inert = false;
      document.documentElement.classList.remove('exec-on');
      (EX.lastFocus?.isConnected ? EX.lastFocus : $('execBtn')).focus?.();
    });
  }

  async function load() {
    try { Object.assign(EX, await api('/api/execution'), { loaded: true, error: '' }); } catch (e) { EX.error = e.message; }
    // Services default to every connected one until the owner unticks some.
    if (EX.d.services == null) EX.d.services = EX.services.filter((s) => s.status !== 'missing').map((s) => s.id);
  }
  // ----- building blocks
  const sec = (title, hint) => { const s = el('section', 'ex-sec'); s.append(el('h3', 'ex-h', title)); if (hint) s.append(el('p', 'ex-hint', hint)); return s; };
  function check(label, hint, on, onchange, { type = 'checkbox', name, disabled } = {}) {
    const row = el('label', 'ex-row');
    const i = el('input'); i.type = type; i.checked = !!on; i.disabled = !!disabled; if (name) i.name = name;
    i.onchange = () => { onchange(i.checked); save(); render(); };
    const t = el('span', 'ex-text'); t.append(el('strong', null, label)); if (hint) t.append(el('small', null, hint));
    row.append(i, t);
    return row;
  }
  function toggle(label, hint, on, onchange) {
    const row = el('label', 'ex-row ex-toggle');
    const t = el('span', 'ex-text'); t.append(el('strong', null, label)); if (hint) t.append(el('small', null, hint));
    const i = el('input', 'st-switch'); i.type = 'checkbox'; i.setAttribute('role', 'switch'); i.checked = !!on;
    i.onchange = () => { onchange(i.checked); save(); };
    row.append(t, i);
    return row;
  }
  function field(label, input) { const l = el('label', 'ex-lf'); l.append(el('span', 'ex-lbl', label), input); return l; }

  // Reference images: uploaded at once (app.js uploadAttachment, POST /api/uploads) and shown as thumbnails.
  function renderAtt(host) {
    host.replaceChildren();
    for (const a of EX.att) {
      const c = el('span', 'ex-thumb' + (a.status === 'error' ? ' error' : ''));
      c.title = a.status === 'error' ? a.error : a.name;
      if (a.url) { const img = el('img'); img.src = a.url; img.alt = a.name; c.append(img); } else c.append(el('span', 'ex-thumb-name', a.name));
      if (a.status === 'uploading') c.append(el('span', 'ex-thumb-state', 'Uploading…'));
      const x = btn('ex-thumb-x', '×', () => { EX.att = EX.att.filter((b) => b !== a); if (a.url) URL.revokeObjectURL(a.url); renderAtt(host); });
      x.setAttribute('aria-label', `Remove ${a.name}`);
      c.append(x);
      host.append(c);
    }
  }
  function addFiles(files, host) {
    for (const f of files) {
      if (EX.att.length >= 10) { toast('Up to 10 reference images'); break; }
      const a = { name: f.name, status: 'uploading', url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
      EX.att.push(a);
      uploadAttachment(a, f).then(() => renderAtt(host));
    }
    renderAtt(host);
  }

  function render() {
    if (!isOn()) return;
    const d = EX.d, body = $('exBody'), frag = document.createDocumentFragment(), side = el('aside', 'exv-side');
    if (EX.error) frag.append(el('p', 'ex-err', EX.error));
    if (EX.executions.length) {
      const s = sec('In flight');
      const list = el('div', 'ex-list');
      for (const e of EX.executions) {
        const row = el('div', 'ex-exec');
        const c = e.counts || {};
        const parts = [c.running && `${c.running} running`, c.queued && `${c.queued} queued`, c.done && `${c.done} done`, c.failed && `${c.failed} failed`].filter(Boolean);
        const t = el('span', 'ex-text');
        t.append(el('strong', null, e.title || e.name), el('small', null, e.needsYou ? `Needs you: ${e.needsYou} waiting for your answer` : e.busy ? 'Planning…' : parts.join(' · ') || 'Starting'));
        if (e.needsYou) row.classList.add('needs');
        row.append(t, btn('btn small', 'Open', () => { exitTo(e.cid); }));
        list.append(row);
      }
      s.append(list);
      side.append(s);
    }
    side.append(howItWorks());

    const form = el('form', 'ex-form');
    form.noValidate = true;
    // 1. The idea
    const s1 = sec('The idea', 'What it is, who it is for, how it makes money, what makes it special. Paste anything you have.');
    const idea = el('textarea', 'ex-idea'); idea.id = 'exIdea'; idea.rows = 7; idea.value = d.idea; idea.required = true;
    idea.placeholder = 'A dating app where men pay a high monthly fee and women join free. Verified profiles, one match a day, built-in video dates…';
    idea.oninput = () => { d.idea = idea.value; save(); };
    s1.append(idea);
    const attHost = el('div', 'ex-thumbs'), pick = el('input'); pick.type = 'file'; pick.accept = 'image/*'; pick.multiple = true; pick.hidden = true;
    pick.onchange = () => { addFiles([...pick.files], attHost); pick.value = ''; };
    const addBtn = btn('btn small', 'Add reference images', () => pick.click());
    const name = el('input', 'ex-name'); name.type = 'text'; name.placeholder = 'Project name (optional)'; name.maxLength = 60; name.value = d.name;
    name.setAttribute('aria-label', 'Project name'); name.oninput = () => { d.name = name.value; save(); };
    const tools = el('div', 'ex-tools'); tools.append(addBtn, name, pick);
    s1.append(tools, attHost);
    renderAtt(attHost);
    form.append(s1);

    // 2. Products
    const s2 = sec('What to build', 'Tick everything you want. Each one goes live.');
    const opts = EX.options || { products: [['web', 'Website / web app'], ['ios', 'iOS app'], ['android', 'Android app'], ['admin', 'Admin panel']], appTech: [['react-native', 'React Native (Expo)', 'One codebase for iOS and Android'], ['native', 'Native', 'SwiftUI for iOS, Kotlin for Android']], askBefore: [['spend', 'Spending money', 'buying a domain, a plan or a subscription'], ['publish', 'Publishing', 'submitting to the App Store or Google Play, going live on the domain'], ['emails', 'Creating email accounts', 'new mailboxes on the domain'], ['send', 'Sending email', 'to anyone but you'], ['delete', 'Deleting', 'domains, apps, data or accounts']] };
    const g2 = el('div', 'ex-group');
    const hints = { web: 'Deployed on your domain', ios: 'Published to the App Store', android: 'Published to Google Play', admin: 'Manage users, content and payments' };
    for (const [k, l] of opts.products) g2.append(check(l, hints[k], d.products[k], (v) => { d.products[k] = v; }));
    s2.append(g2);
    if (d.products.ios || d.products.android) {
      const g = el('div', 'ex-group');
      g.append(el('p', 'ex-sub', d.products.ios && d.products.android ? 'How to build the apps' : `How to build the ${d.products.ios ? 'iOS' : 'Android'} app`));
      for (const [k, l, h] of opts.appTech) g.append(check(l, k === 'native' && !(d.products.ios && d.products.android) ? (d.products.ios ? 'SwiftUI' : 'Kotlin') : h, d.appTech === k, () => { d.appTech = k; }, { type: 'radio', name: 'exTech' }));
      s2.append(g);
    }
    form.append(s2);

    // 3. Design
    const s3 = sec('Design', 'Apple-style, minimal and classy unless you say otherwise.');
    const mob = EX.services.find((s) => s.id === 'mobbin');
    const g3 = el('div', 'ex-group');
    g3.append(toggle('Find inspiration on Mobbin', mob?.status === 'ready' ? 'Mobbin MCP connected' : 'Mobbin MCP not connected: add it in Settings → Skills & tools', d.inspiration.mobbin, (v) => { d.inspiration.mobbin = v; }));
    const refs = el('textarea'); refs.rows = 2; refs.value = d.inspiration.refs; refs.placeholder = 'Apps or sites you like, and what about them';
    refs.oninput = () => { d.inspiration.refs = refs.value; save(); };
    g3.append(field('References', refs));
    s3.append(g3);
    form.append(s3);

    // 4. Domain
    const s4 = sec('Domain');
    const g4 = el('div', 'ex-group');
    g4.append(check('I have a domain in mind', null, d.domain.mode === 'have', () => { d.domain.mode = 'have'; }, { type: 'radio', name: 'exDom' }));
    if (d.domain.mode === 'have') {
      const dn = el('input'); dn.type = 'text'; dn.placeholder = 'example.com'; dn.value = d.domain.name; dn.autocapitalize = 'none'; dn.spellcheck = false;
      dn.setAttribute('aria-label', 'Domain'); dn.oninput = () => { d.domain.name = dn.value; save(); };
      const sub = el('div', 'ex-indent');
      sub.append(dn, check('Already bought', 'Connect it', d.domain.bought, () => { d.domain.bought = true; }, { type: 'radio', name: 'exBought' }),
        check('Buy it for me', 'Through the connected registrar', !d.domain.bought, () => { d.domain.bought = false; }, { type: 'radio', name: 'exBought' }));
      g4.append(sub);
    }
    g4.append(check('Find one for me', 'The agent proposes available names; you approve one before it buys', d.domain.mode === 'find', () => { d.domain.mode = 'find'; }, { type: 'radio', name: 'exDom' }));
    g4.append(check('No domain for now', 'Runs on a live preview address', d.domain.mode === 'none', () => { d.domain.mode = 'none'; }, { type: 'radio', name: 'exDom' }));
    s4.append(g4);
    form.append(s4);

    // 5. Permissions
    const s5 = sec('Ask me before', 'Everything not ticked runs without asking.');
    const g5 = el('div', 'ex-group');
    for (const [k, l, h] of opts.askBefore) g5.append(check(l, h, d.askBefore.includes(k), (v) => { d.askBefore = opts.askBefore.map(([id]) => id).filter((id) => (id === k ? v : d.askBefore.includes(id))); }));
    s5.append(g5);
    form.append(s5);

    // 6. Extras
    const s6 = sec('Also');
    const g6 = el('div', 'ex-group');
    g6.append(toggle('Create email addresses', 'hello@, support@ and noreply@ on the domain', d.emails, (v) => { d.emails = v; }),
      toggle('Seed demo data', 'Realistic demo users and content, so it looks alive on day one', d.demoData, (v) => { d.demoData = v; }));
    s6.append(g6);
    form.append(s6);

    // 7. Services
    const s7 = sec('Services', 'Connected through your Credentials sheet (name the card after the service, or use these key names). Ticked ones go into the project\'s .env.');
    const g7 = el('div', 'ex-group');
    for (const s of EX.services) {
      const row = el('label', 'ex-row ex-svc');
      const i = el('input'); i.type = 'checkbox'; i.checked = d.services?.includes(s.id); i.disabled = s.status === 'missing';
      i.onchange = () => { d.services = EX.services.map((x) => x.id).filter((id) => (id === s.id ? i.checked : d.services?.includes(id))); save(); };
      const t = el('span', 'ex-text');
      t.append(el('strong', null, s.name), el('small', null, s.role));
      const st = el('span', `ex-st ${s.status}`, STATUS[s.status]);
      st.title = s.mcp ? `MCP server "${s.mcp}"` : `Keys: ${s.env.join(', ')}`;
      row.append(i, t, st);
      if (s.status !== 'ready') {
        const a = s.mcp ? btn('btn small', 'Add server', () => { save(); openSettings(); }) : btn('btn small', s.status === 'partial' ? 'Add keys' : 'Add key', () => { save(); window.Credentials?.open(); });
        a.title = s.mcp ? 'Settings → Skills & tools' : `Add a "${s.name}" card with ${s.env.join(', ')}`;
        row.append(a);
      }
      g7.append(row);
    }
    if (!EX.loaded) g7.append(el('p', 'ex-hint', 'Checking your services…'));
    s7.append(g7);
    form.append(s7);

    // Go
    const err = el('p', 'ex-err'); err.id = 'exErr';
    const go = el('button', 'btn primary ex-go', EX.busy ? 'Starting…' : 'Bring it to life'); go.type = 'submit'; go.id = 'exGo'; go.disabled = EX.busy;
    const foot = el('div', 'ex-foot');
    foot.append(el('p', 'ex-hint', EX.github === false ? 'Link GitHub first: every project gets its own repo.' : 'Starts a project, writes the brief and the keys, and the planner begins right away.'), go);
    form.append(err, foot);
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (EX.att.some((a) => a.status === 'uploading')) { err.textContent = 'Still uploading your images. Try again in a moment.'; return; }
      if (d.idea.trim().length < 20) { err.textContent = 'Describe the idea in a few sentences first.'; idea.focus(); return; }
      EX.busy = true; render();
      try {
        const r = await api('/api/execution', 'POST', { ...d, attachments: EX.att.filter((a) => a.id).map((a) => a.id) });
        EX.d = blank(); EX.att = []; save();
        toast(`Execution started: ${r.convo.title}`, { kind: 'success' });
        if (!state.convos.find((x) => x.id === r.convo.id)) state.convos.unshift(r.convo);
        exitTo(r.convo.id);
      } catch (x) {
        err.textContent = x.message;
        if (/github/i.test(x.message)) EX.github = false;
      } finally { EX.busy = false; render(); }
    };
    const col = el('div', 'exv-col'); col.append(...frag.childNodes, form);
    body.replaceChildren(col, side);
  }

  // The side column's steps: what happens after Go.
  function howItWorks() {
    const s = sec('What happens next');
    const ol = el('ol', 'exv-steps');
    for (const [h, t] of [['Plan', 'The planner turns the idea into a build plan and asks what it can\'t decide.'], ['Build', 'Website, apps and admin panel are coded in parallel, tested and reviewed.'],
      ['Connect', 'Domain, hosting, email, payments and store accounts are set up through your services.'], ['Launch', 'It goes live, and you get the links. Anything you ticked under "Ask me before" waits for you.']]) {
      const li = el('li'); li.append(el('strong', null, h), el('span', null, t)); ol.append(li);
    }
    s.append(ol);
    return s;
  }
  // Leave the mode for a chat (an execution's Open, or a new one): the transition plays, then the chat opens.
  function exitTo(cid) { EX.lastFocus = null; exit(); setTimeout(() => openConvo(cid), still() ? 0 : 1100); }

  $('execBtn').addEventListener('click', () => enter());
  $('exExit').addEventListener('click', exit);
  // Keys stay in the page: the app's shortcuts (⌘K, Escape handlers, …) don't fire under it.
  $('execView').addEventListener('keydown', (e) => e.stopPropagation());
  // Back in the mode after a reload, once /api/me says this is the admin (users.css hides it from everyone else).
  const resume = () => { if (document.documentElement.dataset.role && document.documentElement.dataset.role !== 'user') { mo.disconnect(); let on = false; try { on = !!localStorage.getItem(ON); } catch {} if (on) enter({ instant: true }); } };
  const mo = new MutationObserver(resume);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-role'] });
  resume();

  window.Execution = { enter, exit, open: enter, close: exit };
})();
