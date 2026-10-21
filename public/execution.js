// ---------- Execution Mode (server: execution.mjs, /api/execution; admin only) ----------
// The sidebar's Execution Mode button turns the whole page into Execution Mode (#execView over the app, which goes inert)
// through the nanotech transition (#exSuit: hex cells pour out of the pressed control and lock into a skin over the screen,
// the core lights, then the skin comes apart from the centre to show the new page); "Exit to Orchestrator" plays it back.
// The page has its own sidebar (#exNav): New execution, every execution started (its own page: progress, recent work, the
// brief, Open chat) and Connections (the services an execution can use). New execution is the idea (plus reference images)
// and labelled sections of chips for what shapes the build (products, app technology, design inspiration, domain plan,
// what needs the owner's permission, extras, which connected services to use), then "Bring it to life", which starts an
// orchestrator project and opens its page here. The mode and the open page survive a reload (localStorage cw.exec.on,
// cw.exec.view), the draft survives leaving it (cw.exec.draft). Loaded after app.js and uses its helpers ($, el, api,
// toast, coarse, closeSidebar, openConvo, openSettings, uploadAttachment, state).
(() => {
  const KEY = 'cw.exec.draft', ON = 'cw.exec.on', VIEW = 'cw.exec.view';
  const blank = () => ({ idea: '', name: '', products: { web: true, ios: false, android: false, admin: true }, appTech: 'react-native',
    inspiration: { mobbin: true, refs: '' }, domain: { mode: 'find', name: '', bought: true }, askBefore: ['spend', 'publish'], emails: true, demoData: true, services: null });
  const EX = { d: blank(), att: [], services: [], executions: [], options: null, github: true, loaded: false, error: '', busy: false, lastFocus: null, anim: null, view: 'new', poll: null };
  const btn = (cls, text, onclick) => { const b = el('button', cls, text); b.type = 'button'; if (onclick) b.onclick = onclick; return b; };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(EX.d)); } catch {} };
  const restore = () => { try { const j = JSON.parse(localStorage.getItem(KEY) || 'null'); if (j && typeof j === 'object') EX.d = { ...blank(), ...j, products: { ...blank().products, ...j.products }, inspiration: { ...blank().inspiration, ...j.inspiration }, domain: { ...blank().domain, ...j.domain } }; } catch {} };
  const remember = (on) => { try { on ? localStorage.setItem(ON, '1') : localStorage.removeItem(ON); } catch {} };
  const STATUS = { ready: 'Connected', partial: 'Some keys missing', missing: 'Not connected' };
  const isOn = () => !$('execView').hidden;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const OPTS = { products: [['web', 'Website / web app'], ['ios', 'iOS app'], ['android', 'Android app'], ['admin', 'Admin panel']],
    appTech: [['react-native', 'React Native (Expo)', 'One codebase for iOS and Android'], ['native', 'Native', 'SwiftUI for iOS, Kotlin for Android']],
    askBefore: [['spend', 'Spending money', 'buying a domain, a plan or a subscription'], ['publish', 'Publishing', 'submitting to the App Store or Google Play, going live on the domain'], ['emails', 'Creating email accounts', 'new mailboxes on the domain'], ['send', 'Sending email', 'to anyone but you'], ['delete', 'Deleting', 'domains, apps, data or accounts']] };
  const opts = () => EX.options || OPTS;

  // ----- The nanotech transition. `dir` 'in' or 'out'; `swap` runs while the skin covers the screen (shows or hides the
  // page); `from` is the control that was pressed, where the cells pour out (else the centre). Canvas 2D on #exNano:
  // a swarm of particles races ahead of a wave of hexagonal cells that lock into place with a bright seam (0-620 ms), a
  // shimmer crosses the finished skin while the core and the word show (DOM, execution.css), then the cells shrink and
  // drift apart from the centre out (1000-1520 ms). Reduced motion: a plain swap.
  const NANO = { assemble: 620, hold: 380, release: 520, form: 170 };
  function suit(dir, swap, from) {
    cancelAnimationFrame(EX.anim?.raf);
    if (EX.anim?.swap) EX.anim.swap(); // a transition cut short still lands where it was going
    const o = $('exSuit'), cv = $('exNano'), g = cv.getContext?.('2d');
    if (still() || !g) { swap(); o.hidden = true; return; }
    $('exSuitWord').textContent = dir === 'in' ? 'Execution Mode' : 'Orchestrator Mode';
    $('exSuitSub').textContent = dir === 'in' ? 'Nanites deployed' : 'Nanites retracting';
    o.className = `exs ${dir}`;
    o.hidden = false;
    void o.offsetWidth; // restart the core's keyframes
    o.classList.add('run');
    const W = innerWidth, H = innerHeight, dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = from?.getBoundingClientRect?.(), seen = r && r.width && r.right > 0 && r.left < W && r.bottom > 0 && r.top < H;
    const ox = seen ? r.left + r.width / 2 : W / 2, oy = seen ? r.top + r.height / 2 : H / 2;
    // Pointy-top hexagons; cell size follows the screen so a phone isn't a few blobs and a desktop isn't dust.
    const R = Math.max(11, Math.min(24, Math.min(W, H) / 34)), hw = Math.sqrt(3) * R, vh = 1.5 * R, cells = [];
    let maxD = 1, maxC = 1;
    for (let row = -1; row * vh < H + R; row++) for (let col = -1; col * hw < W + hw; col++) {
      const x = col * hw + (row & 1 ? hw / 2 : 0), y = row * vh, d = Math.hypot(x - ox, y - oy), c = Math.hypot(x - W / 2, y - H / 2), tone = Math.random();
      maxD = Math.max(maxD, d); maxC = Math.max(maxC, c);
      cells.push({ x, y, d, c, j: Math.random(), fill: `rgb(${17 + tone * 12 | 0},${14 + tone * 6 | 0},${16 + tone * 6 | 0})` });
    }
    const parts = Array.from({ length: Math.min(260, cells.length / 4 | 0) }, () => {
      const a = Math.random() * Math.PI * 2;
      return { dx: Math.cos(a), dy: Math.sin(a), v: (maxD / NANO.assemble) * (1.05 + Math.random() * 0.4), s: 0.8 + Math.random() * 1.4 };
    });
    const hex = (x, y, rad) => {
      g.moveTo(x, y - rad);
      for (let k = 1; k < 6; k++) { const a = Math.PI / 3 * k - Math.PI / 2; g.lineTo(x + rad * Math.cos(a), y + rad * Math.sin(a)); }
      g.closePath();
    };
    const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v), ease = (v) => 1 - (1 - v) ** 3;
    const A = NANO.assemble, B = A + NANO.hold, T = B + NANO.release, t0 = performance.now();
    EX.anim = { swap };
    const frame = (now) => {
      const t = now - t0;
      if (t >= B && EX.anim.swap) { EX.anim.swap = null; swap(); }
      if (t >= T) { g.clearRect(0, 0, W, H); o.hidden = true; o.className = 'exs'; EX.anim = null; return; }
      g.clearRect(0, 0, W, H);
      const band = t > A ? ((t - A) / (T - A)) * (W + H) * 1.2 - H * 0.2 : -1e4; // the shimmer, a diagonal x + y = band
      for (const c of cells) {
        const lock = (c.d / maxD) * (A - NANO.form - 40) + c.j * 60, k = clamp((t - lock) / NANO.form);
        if (k <= 0) continue;
        const rel = B + (c.c / maxC) * (NANO.release - 210) + c.j * 50, out = t > rel ? clamp((t - rel) / 210) : 0;
        if (out >= 1) continue;
        const grow = ease(k), shrink = 1 - ease(out), push = out * R * 0.9;
        const ux = (c.x - W / 2) / (c.c || 1), uy = (c.y - H / 2) / (c.c || 1);
        const x = c.x + ux * push, y = c.y + uy * push, rad = (R + 0.6) * (0.35 + 0.65 * grow) * shrink;
        g.beginPath(); hex(x, y, rad);
        g.globalAlpha = Math.min(1, k * 1.8) * (out ? 1 - out * 0.6 : 1);
        g.fillStyle = c.fill; g.fill();
        // The seam: white-gold while a cell locks, then a faint gold line; brighter where the shimmer passes.
        const fresh = 1 - clamp((t - lock - NANO.form) / 240), near = Math.max(0, 1 - Math.abs(c.x + c.y - band) / 70);
        g.lineWidth = 1;
        g.strokeStyle = fresh > 0.02 ? `rgba(246,226,170,${0.25 + 0.7 * fresh})` : `rgba(224,180,76,${0.14 + 0.5 * near})`;
        g.stroke();
        if (out > 0 && out < 1 && c.j > 0.7) { g.fillStyle = `rgba(246,226,170,${1 - out})`; g.fillRect(x + ux * push, y + uy * push, 1.6, 1.6); }
      }
      g.globalAlpha = 1;
      if (t < A + 160) for (const p of parts) { // the swarm ahead of the wave
        const dist = p.v * t, fade = 1 - clamp((t - A + 60) / 220);
        if (dist > maxD * 1.15) continue;
        const x = ox + p.dx * dist, y = oy + p.dy * dist;
        g.strokeStyle = `rgba(246,226,170,${0.8 * fade})`; g.lineWidth = p.s;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x - p.dx * 10 * p.s, y - p.dy * 10 * p.s); g.stroke();
      }
      EX.anim.raf = requestAnimationFrame(frame);
    };
    EX.anim.raf = requestAnimationFrame(frame);
  }
  function show() {
    $('execView').hidden = false;
    $('app').inert = true;
    document.documentElement.classList.add('exec-on');
    render();
    if (!coarse && EX.view === 'new') $('exIdea')?.focus({ preventScroll: true });
    clearInterval(EX.poll);
    // Progress on the open page and the sidebar, while the mode is on screen.
    EX.poll = setInterval(() => { if (isOn() && !document.hidden) load().then(() => { renderNav(); if (EX.view !== 'new') renderMain(); }); }, 15000);
  }
  function enter({ instant = false } = {}) {
    if (isOn()) return;
    const from = $('execBtn');
    closeSidebar();
    EX.lastFocus = document.activeElement;
    remember(true);
    restore();
    try { EX.view = localStorage.getItem(VIEW) || 'new'; } catch {}
    load().then(render);
    instant ? show() : suit('in', show, from);
  }
  function exit(from = $('exExit')) {
    if (!isOn()) return;
    save();
    remember(false);
    clearInterval(EX.poll);
    suit('out', () => {
      $('execView').hidden = true;
      $('app').inert = false;
      document.documentElement.classList.remove('exec-on');
      (EX.lastFocus?.isConnected ? EX.lastFocus : $('execBtn')).focus?.();
    }, from);
  }
  // Leave the mode for a chat (a project's Open chat): the transition plays, then the chat opens.
  function exitTo(cid, from) { EX.lastFocus = null; exit(from); setTimeout(() => openConvo(cid), still() ? 0 : NANO.assemble + NANO.hold); }

  async function load() {
    try { Object.assign(EX, await api('/api/execution'), { loaded: true, error: '' }); } catch (e) { EX.error = e.message; }
    // Services default to every connected one until the owner deselects some.
    if (EX.d.services == null && EX.loaded) EX.d.services = EX.services.filter((s) => s.status !== 'missing').map((s) => s.id);
  }
  function go(view) {
    if (EX.view === 'new') save();
    EX.view = view;
    try { localStorage.setItem(VIEW, view); } catch {}
    render();
    $('exMain').scrollTop = 0;
    if (view !== 'new') load().then(() => { renderNav(); if (EX.view === view) renderMain(); });
  }

  // ----- The sidebar: New execution, the projects, Connections.
  function phase(e) {
    const c = e.counts || {};
    if (e.needsYou) return ['needs', 'Needs you'];
    if (e.project?.status === 'paused') return ['paused', 'Paused'];
    if (e.busy) return ['busy', 'Planning'];
    if (c.running) return ['busy', 'Building'];
    if (e.total && (c.done || 0) === e.total) return ['done', 'Done'];
    if (c.failed) return ['failed', 'Has failures'];
    if (c.queued) return ['busy', 'Queued'];
    return ['idle', 'Starting'];
  }
  function navItem(view, label, meta, cls = '') {
    const b = btn(`exv-item ${cls}`, null, () => go(view));
    if (EX.view === view) b.setAttribute('aria-current', 'page');
    b.append(...label, el('span', 'exv-meta', meta || ''));
    return b;
  }
  function renderNav() {
    const nav = $('exNav'), list = el('div', 'exv-projects');
    const add = btn('exv-new', null, () => go('new'));
    if (EX.view === 'new') add.setAttribute('aria-current', 'page');
    add.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    add.append('New execution');
    for (const e of EX.executions) {
      const [k, word] = phase(e), done = e.counts?.done || 0;
      const dot = el('span', `exv-pdot ${k}`); dot.title = word;
      list.append(navItem(e.cid, [dot, el('span', 'exv-name', e.title || e.name)], e.needsYou ? String(e.needsYou) : e.total ? `${done}/${e.total}` : '', e.needsYou ? 'needs' : ''));
    }
    if (!EX.executions.length) list.append(el('p', 'exv-empty', EX.loaded ? 'Projects you start show up here.' : 'Loading…'));
    const ready = EX.services.filter((s) => s.status === 'ready').length;
    const conn = navItem('connections', [el('span', 'exv-name', 'Connections')], EX.loaded ? `${ready}/${EX.services.length}` : '', 'exv-conn');
    nav.replaceChildren(add, el('p', 'exv-navh', 'Projects'), list, conn);
  }

  // ----- Building blocks: a section is a label column (title, hint) beside its controls; choices are chips.
  function sec(title, hint) {
    const s = el('section', 'ex-sec'), lab = el('div', 'ex-lab'), ctl = el('div', 'ex-ctl');
    lab.append(el('h3', 'ex-h', title));
    if (hint) lab.append(el('p', 'ex-hint', hint));
    s.append(lab, ctl);
    return [s, ctl];
  }
  // A chip: a real checkbox or radio inside a pill, so keys, labels and forms work as usual. `k` keeps focus across renders.
  function chip(label, on, onchange, { type = 'checkbox', name, disabled, title, k } = {}) {
    const l = el('label', 'ex-chip'), i = el('input');
    i.type = type; i.checked = !!on; i.disabled = !!disabled; if (name) i.name = name; if (k) i.dataset.k = k;
    i.onchange = () => { onchange(i.checked); save(); render(); };
    l.append(i, el('span', null, label));
    if (title) l.title = title;
    return l;
  }
  const chips = (items, cls = 'ex-chips', aria) => { const d = el('div', cls); if (aria) { d.setAttribute('role', cls === 'ex-seg' ? 'radiogroup' : 'group'); d.setAttribute('aria-label', aria); } d.append(...items); return d; };
  const note = (text) => el('p', 'ex-note', text);
  const link = (text, onclick) => btn('ex-link', text, onclick);

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
    renderNav();
    renderMain();
  }
  function renderMain() {
    const main = $('exMain'), k = document.activeElement?.dataset?.k, e = EX.executions.find((x) => x.cid === EX.view);
    if (EX.view !== 'new' && EX.view !== 'connections' && !e && EX.loaded) EX.view = 'new'; // deleted, or not ours
    const page = el('div', 'exv-page');
    if (EX.error) page.append(el('p', 'ex-err', EX.error));
    if (EX.view === 'connections') page.append(...connectionsPage());
    else if (e) page.append(...projectPage(e));
    else if (EX.view !== 'new') page.append(el('p', 'ex-hint', 'Loading…'));
    else page.append(...newPage());
    main.replaceChildren(page);
    if (k) main.querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus({ preventScroll: true });
  }
  const hero = (title, text) => { const h = el('div', 'exv-hero'); h.append(el('h1', null, title)); if (text) h.append(el('p', null, text)); return h; };

  // ----- New execution
  function newPage() {
    const d = EX.d, o = opts();
    const steps = el('ol', 'exv-steps');
    for (const [h, t] of [['Plan', 'The planner turns the idea into a build plan and asks what it can\'t decide.'], ['Build', 'Website, apps and admin panel are coded in parallel, tested and reviewed.'],
      ['Connect', 'Domain, hosting, email, payments and store accounts are set up through your connections.'], ['Launch', 'It goes live and you get the links. Anything under "Ask me before" waits for you.']]) {
      const li = el('li'); li.append(el('strong', null, h), el('span', null, t)); steps.append(li);
    }
    const form = el('form', 'ex-form');
    form.noValidate = true;

    // The idea
    const [s1, c1] = sec('The idea', 'What it is, who it is for, how it makes money, what makes it special. Paste anything you have.');
    const idea = el('textarea', 'ex-idea'); idea.id = 'exIdea'; idea.rows = 6; idea.value = d.idea; idea.required = true;
    idea.placeholder = 'A dating app where men pay a high monthly fee and women join free. Verified profiles, one match a day, built-in video dates…';
    idea.setAttribute('aria-label', 'The idea');
    idea.oninput = () => { d.idea = idea.value; save(); };
    const attHost = el('div', 'ex-thumbs'), pick = el('input'); pick.type = 'file'; pick.accept = 'image/*'; pick.multiple = true; pick.hidden = true;
    pick.onchange = () => { addFiles([...pick.files], attHost); pick.value = ''; };
    const name = el('input', 'ex-name'); name.type = 'text'; name.placeholder = 'Project name (optional)'; name.maxLength = 60; name.value = d.name;
    name.setAttribute('aria-label', 'Project name'); name.oninput = () => { d.name = name.value; save(); };
    const tools = el('div', 'ex-tools'); tools.append(btn('btn small', 'Add reference images', () => pick.click()), name, pick);
    c1.append(idea, tools, attHost);
    renderAtt(attHost);

    // What to build
    const hints = { web: 'Deployed on your domain', ios: 'Published to the App Store', android: 'Published to Google Play', admin: 'Manage users, content and payments' };
    const [s2, c2] = sec('Build', 'Everything selected goes live.');
    c2.append(chips(o.products.map(([k, l]) => chip(l, d.products[k], (v) => { d.products[k] = v; }, { title: hints[k], k: `p-${k}` })), 'ex-chips', 'What to build'));
    const apps = d.products.ios || d.products.android;
    if (apps) {
      const both = d.products.ios && d.products.android;
      c2.append(chips(o.appTech.map(([k, l]) => chip(l, d.appTech === k, () => { d.appTech = k; }, { type: 'radio', name: 'exTech', k: `t-${k}` })), 'ex-seg', 'How to build the apps'));
      const [, , h] = o.appTech.find(([k]) => k === d.appTech) || [];
      c2.append(note(d.appTech === 'native' && !both ? (d.products.ios ? 'SwiftUI' : 'Kotlin') : h || ''));
    }

    // Design
    const [s3, c3] = sec('Design', 'Apple-style, minimal and classy unless you say otherwise.');
    const mob = EX.services.find((s) => s.id === 'mobbin');
    c3.append(chips([chip('Inspiration from Mobbin', d.inspiration.mobbin, (v) => { d.inspiration.mobbin = v; }, { k: 'mobbin' })], 'ex-chips', 'Inspiration'));
    if (d.inspiration.mobbin && mob && mob.status !== 'ready') { const n = note('Mobbin isn\'t connected. '); n.append(link('Connect it', () => go('connections'))); c3.append(n); }
    const refs = el('textarea'); refs.rows = 2; refs.value = d.inspiration.refs; refs.placeholder = 'Apps or sites you like, and what about them';
    refs.setAttribute('aria-label', 'Design references');
    refs.oninput = () => { d.inspiration.refs = refs.value; save(); };
    c3.append(refs);

    // Domain
    const [s4, c4] = sec('Domain');
    const DOM = [['find', 'Find one', 'The agent proposes available names; you approve one before it buys.'], ['have', 'I have one', ''], ['none', 'Not yet', 'Runs on a live preview address.']];
    c4.append(chips(DOM.map(([k, l]) => chip(l, d.domain.mode === k, () => { d.domain.mode = k; }, { type: 'radio', name: 'exDom', k: `d-${k}` })), 'ex-seg', 'Domain'));
    if (d.domain.mode === 'have') {
      const dn = el('input'); dn.type = 'text'; dn.placeholder = 'example.com'; dn.value = d.domain.name; dn.autocapitalize = 'none'; dn.spellcheck = false;
      dn.setAttribute('aria-label', 'Domain'); dn.oninput = () => { d.domain.name = dn.value; save(); };
      const row = el('div', 'ex-inline');
      row.append(dn, chips([chip('Already bought', d.domain.bought, () => { d.domain.bought = true; }, { type: 'radio', name: 'exBought', k: 'b-1' }),
        chip('Buy it for me', !d.domain.bought, () => { d.domain.bought = false; }, { type: 'radio', name: 'exBought', k: 'b-0' })], 'ex-seg', 'Bought?'));
      c4.append(row);
    } else c4.append(note(DOM.find(([k]) => k === d.domain.mode)?.[2] || ''));

    // Permissions
    const [s5, c5] = sec('Ask me before', 'Anything not selected runs without asking.');
    c5.append(chips(o.askBefore.map(([k, l, h]) => chip(l, d.askBefore.includes(k), (v) => { d.askBefore = o.askBefore.map(([id]) => id).filter((id) => (id === k ? v : d.askBefore.includes(id))); }, { title: h, k: `a-${k}` })), 'ex-chips', 'Ask me before'));

    // Extras
    const [s6, c6] = sec('Also');
    c6.append(chips([chip('Email addresses', d.emails, (v) => { d.emails = v; }, { title: 'hello@, support@ and noreply@ on the domain', k: 'x-mail' }),
      chip('Demo data', d.demoData, (v) => { d.demoData = v; }, { title: 'Realistic demo users and content, so it looks alive on day one', k: 'x-demo' })], 'ex-chips', 'Also'));
    c6.append(note([d.emails && 'hello@, support@ and noreply@ on the domain', d.demoData && 'realistic demo users and content'].filter(Boolean).join('; ') || 'Nothing extra.'));

    // Services
    const [s7, c7] = sec('Use', 'Connected services; their keys go into the project\'s .env.');
    const usable = EX.services.filter((s) => s.status !== 'missing' && s.env);
    if (usable.length) c7.append(chips(usable.map((s) => chip(s.name, d.services?.includes(s.id), (v) => { d.services = EX.services.map((x) => x.id).filter((id) => (id === s.id ? v : d.services?.includes(id))); },
      { title: `${s.role}${s.status === 'partial' ? ' (some keys missing)' : ''}`, k: `s-${s.id}` })), 'ex-chips', 'Services to use'));
    const n7 = note(!EX.loaded ? 'Checking your connections… ' : usable.length ? '' : 'Nothing connected yet. ');
    n7.append(link('Manage connections', () => go('connections')));
    c7.append(n7);

    // Go
    const err = el('p', 'ex-err'); err.id = 'exErr';
    const goBtn = el('button', 'btn primary ex-go', EX.busy ? 'Starting…' : 'Bring it to life'); goBtn.type = 'submit'; goBtn.id = 'exGo'; goBtn.disabled = EX.busy;
    const foot = el('div', 'ex-foot');
    foot.append(el('p', 'ex-hint', EX.github === false ? 'Link GitHub first: every project gets its own repo.' : 'Starts a project, writes the brief and the keys, and the planner begins right away.'), goBtn);
    form.append(s1, s2, s3, s4, s5, s6, s7, err, foot);
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      err.textContent = '';
      if (EX.att.some((a) => a.status === 'uploading')) { err.textContent = 'Still uploading your images. Try again in a moment.'; return; }
      if (d.idea.trim().length < 20) { err.textContent = 'Describe the idea in a few sentences first.'; idea.focus(); return; }
      EX.busy = true; renderMain();
      try {
        const r = await api('/api/execution', 'POST', { ...d, attachments: EX.att.filter((a) => a.id).map((a) => a.id) });
        EX.d = blank(); EX.att = []; save();
        toast(`Execution started: ${r.convo.title}`, { kind: 'success' });
        if (!state.convos.find((x) => x.id === r.convo.id)) state.convos.unshift(r.convo);
        EX.busy = false;
        await load();
        go(r.convo.id);
      } catch (x) {
        err.textContent = x.message;
        if (/github/i.test(x.message)) EX.github = false;
        EX.busy = false; renderMain();
        $('exErr').textContent = x.message;
      }
    };
    return [hero('Ideas in. Products out.', 'Describe the product. It gets built, published and brought online: domain, website, apps, store listings, with as little of your time as possible.'), steps, form];
  }

  // ----- A project: where it stands, what's happening, what it was asked to be.
  function projectPage(e) {
    const c = e.counts || {}, [k, word] = phase(e), done = c.done || 0, b = e.brief || {};
    const top = el('div', 'exv-phead'), titles = el('div', 'exv-ptitle');
    const st = el('p', `exv-pstate ${k}`); st.append(el('span', `exv-pdot ${k}`), word);
    titles.append(el('h1', null, e.title || e.name), st);
    const acts = el('div', 'exv-pacts');
    if (e.preview) { const a = el('a', 'btn', 'Open live site'); a.href = e.preview; a.target = '_blank'; a.rel = 'noopener'; acts.append(a); }
    const open = btn('btn primary', 'Open chat'); open.onclick = () => exitTo(e.cid, open);
    acts.append(open);
    top.append(titles, acts);
    const out = [top];
    if (e.needsYou) {
      const n = el('div', 'exv-needs');
      n.append(el('span', null, `${e.needsYou} ${e.needsYou === 1 ? 'thing waits' : 'things wait'} for your answer.`), link('Answer in the chat', () => exitTo(e.cid)));
      out.push(n);
    }
    // Progress: a hairline bar and the counts as label/value columns.
    const bar = el('div', 'exv-bar-p'), fill = el('span');
    fill.style.width = `${e.total ? Math.round((done / e.total) * 100) : 0}%`;
    bar.append(fill);
    bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(e.total || 0)); bar.setAttribute('aria-valuenow', String(done));
    bar.setAttribute('aria-label', 'Tasks done');
    const stats = el('dl', 'exv-stats');
    for (const [l, v] of [['Done', `${done}${e.total ? ` of ${e.total}` : ''}`], ['Running', c.running || 0], ['Queued', c.queued || 0], ['Failed', c.failed || 0]]) {
      const d = el('div'); d.append(el('dt', null, l), el('dd', null, String(v))); stats.append(d);
    }
    out.push(bar, stats);
    // Recent work
    const [s1, c1] = sec('Recent work');
    if (e.recent?.length) {
      const ul = el('ul', 'exv-tasks');
      for (const t of e.recent) { const li = el('li'); li.append(el('span', 'exv-tname', t.title), el('span', `exv-tst ${t.status}`, t.status.replace(/_/g, ' '))); ul.append(li); }
      c1.append(ul);
    } else c1.append(note(e.busy ? 'The planner is writing the build plan.' : e.recent ? 'No tasks yet. The planner adds them as it goes.' : 'Open the chat to see its tasks.'));
    out.push(s1);
    // The brief
    const [s2, c2] = sec('The brief');
    const dl = el('dl', 'exv-brief'), row = (l, v) => { if (!v) return; const d = el('div'); d.append(el('dt', null, l), el('dd', null, v)); dl.append(d); };
    row('Idea', b.idea);
    row('Build', opts().products.filter(([key]) => b.products?.[key]).map(([, l]) => l).join(', '));
    if (b.products?.ios || b.products?.android) row('Apps', opts().appTech.find(([key]) => key === b.appTech)?.[1]);
    const dm = b.domain;
    row('Domain', dm && (dm.mode === 'have' ? `${dm.name || 'Your domain'}${dm.bought ? '' : ', to buy'}` : dm.mode === 'find' ? 'The agent proposes names for you to approve' : 'A live preview address for now'));
    row('Services', (b.services || []).map((id) => EX.services.find((s) => s.id === id)?.name || id).join(', '));
    if (e.createdAt) row('Started', new Date(e.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
    if (!dl.childElementCount) c2.append(note('The full brief is in the project\'s .agent-orch/EXECUTION.md.'));
    c2.append(dl);
    out.push(s2);
    return out;
  }

  // ----- Connections: every service an execution can use, how it is connected and how to connect it.
  function connectionsPage() {
    const ready = EX.services.filter((s) => s.status === 'ready').length;
    const list = el('ul', 'exv-conns');
    for (const s of EX.services) {
      const li = el('li'), t = el('div', 'exv-cname');
      t.append(el('strong', null, s.name), el('span', null, s.role));
      const how = el('code', 'exv-ckeys', s.mcp ? `MCP server "${s.mcp}"` : s.env.join('\n'));
      const status = el('span', `ex-st ${s.status}`, STATUS[s.status]);
      const acts = el('div', 'exv-cacts');
      if (s.url && s.status !== 'ready') { const a = el('a', 'ex-link', s.mcp ? 'Get it' : 'Get keys'); a.href = s.url; a.target = '_blank'; a.rel = 'noopener'; acts.append(a); }
      const a = s.mcp ? btn('btn small', s.status === 'ready' ? 'Settings' : 'Add server', () => { save(); exit(); setTimeout(openSettings, still() ? 0 : NANO.assemble + NANO.hold); })
        : btn('btn small', s.status === 'ready' ? 'Edit' : s.status === 'partial' ? 'Add keys' : 'Add key', () => { save(); window.Credentials?.open(); });
      a.title = s.mcp ? 'Settings → Skills & tools' : `A "${s.name}" card in Credentials with ${s.env.join(', ')}`;
      acts.append(a);
      li.append(t, how, status, acts);
      if (s.status === 'ready') li.classList.add('ready');
      list.append(li);
    }
    const out = [hero('Connections', 'The services an execution can use. Keys live in your Credentials sheet: name the card after the service, or label its fields with these key names. MCP servers live in Settings → Skills & tools.')];
    if (EX.loaded) out.push(el('p', 'exv-count', `${ready} of ${EX.services.length} connected`), list);
    else out.push(note('Checking your connections…'));
    return out;
  }

  $('execBtn').addEventListener('click', () => enter());
  $('exExit').addEventListener('click', () => exit());
  // Keys stay in the page: the app's shortcuts (⌘K, Escape handlers, …) don't fire under it.
  $('execView').addEventListener('keydown', (e) => e.stopPropagation());
  // Credentials (a sheet over the page) may have connected a service: re-check when it closes.
  document.addEventListener('visibilitychange', () => { if (isOn() && !document.hidden) load().then(() => { renderNav(); if (EX.view !== 'new') renderMain(); }); });
  // Back in the mode after a reload, once /api/me says this is the admin (users.css hides it from everyone else).
  const resume = () => { if (document.documentElement.dataset.role && document.documentElement.dataset.role !== 'user') { mo.disconnect(); let on = false; try { on = !!localStorage.getItem(ON); } catch {} if (on) enter({ instant: true }); } };
  const mo = new MutationObserver(resume);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-role'] });
  resume();

  window.Execution = { enter, exit, open: enter, close: exit, go };
})();
