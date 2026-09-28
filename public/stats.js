'use strict';
// ---------- Stats: you and the orchestrator (server: stats.mjs, GET /api/stats) ----------
// The server sends raw records; everything here is sliced by the chosen range and project, bucketed in the browser's
// timezone and turned into tiles, charts and plain-language insights. Tabs: Overview · You · Agents · Projects.
// Loaded after app.js and uses its helpers ($, el, api, store, fmtTok, fmtDur, closeSidebar, modelName, agentLabel).
(() => {
  const MIN = 60e3, H = 3600e3, DAY = 864e5;
  const RANGE_MS = { all: 0, '30d': 30 * DAY, '7d': 7 * DAY, '24h': DAY };
  const TABS = ['overview', 'you', 'agents', 'projects'];
  const SX = {
    data: null, err: '', loading: null, lastFocus: null, observers: [],
    tab: TABS.includes(store.get('cw.sx.tab')) ? store.get('cw.sx.tab') : 'overview',
    range: store.get('cw.sx.range') in RANGE_MS ? store.get('cw.sx.range') : 'all',
    project: 'all',
  };
  // Agents keep one color everywhere (validated set: blue, orange, aqua); "you" is blue and the orchestrator orange.
  const AGENT_VAR = { codex: 'var(--sx-c1)', claude: 'var(--sx-c2)' };
  const agentColor = (a) => AGENT_VAR[a] || 'var(--sx-c3)';
  // Past Claude and Codex, agents fold into one "Other" (a fourth hue would be indistinguishable). Stack order keeps
  // the validated neighbours: blue | orange | aqua.
  const agentGroup = (a) => (AGENT_VAR[a] ? a : 'other');
  const GROUPS = ['codex', 'claude', 'other'];
  const OUTCOMES = [['ok', 'Finished', 'var(--ok)'], ['rate_limited', 'Hit a limit', 'var(--warn)'], ['aborted', 'Stopped', 'var(--faint)'], ['error', 'Error', 'var(--danger)']];
  const NOTES = /^\.(agent-orch|ao2)\//; // the agents' own memory files (journal, context), touched by every task
  const STEER = { reorder: 'Reordered', cancel: 'Cancelled', settings: 'Changed settings', delegate: 'Moved to another model', urgency: 'Changed urgency', retry: 'Retried', review: 'Reviewed', pause: 'Paused or handed off' };
  const STOP = new Set(('a an the and or of for to in on with me my our your i we you it its it\'s this that these those please can could would should make ' +
    'be is are was were been being do does did done have has had not no yes so if then than but also just like as at by from into out up down ' +
    'there their them they he she his her what which who when where why how all any each every some more most other such only own same ' +
    'too very will shall may might must need want let lets use using used get got add new now one two also i\'m im dont don\'t isnt isn\'t ' +
    'should\'ve there\'s thats that\'s it\'ll we\'ll you\'re u ok okay still even well way thing things something anything able sure etc via ' +
    'about after before again against over under while because until both few many much here see look way first after instead already').split(/\s+/));

  // ---------- formatting ----------
  const num = (n) => Math.round(n).toLocaleString();
  const compact = (n) => fmtTok(Math.max(0, n || 0));
  const pct = (x) => `${Math.round(x * 100)}%`;
  const hrs = (ms) => (ms >= H ? `${(ms / H).toFixed(ms >= 10 * H ? 0 : 1)} h` : `${Math.round(ms / MIN)} min`);
  const dur = (ms) => fmtDur(ms / 1000);
  const dayName = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const shortDay = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const hourName = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
  const weekdayName = (i) => new Date(2000, 0, 2 + i).toLocaleDateString([], { weekday: 'short' }); // 2000-01-02 was a Sunday
  const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
  const dayStart = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const nextDay = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); };
  const nextHour = (ms) => { const d = new Date(ms); d.setMinutes(60, 0, 0); return d.getTime(); };
  const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + (f(x) || 0), 0);
  const countBy = (xs, f) => { const m = new Map(); for (const x of xs) { const k = f(x); if (k != null) m.set(k, (m.get(k) || 0) + 1); } return m; };
  const top = (m) => [...m].sort((a, b) => b[1] - a[1]);
  const words = (s) => String(s || '').toLowerCase().replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ').match(/[a-z][a-z'-]{2,}/g) || [];
  // A model's display name; runs from before models were recorded have none.
  const safeModel = (agent, model) => { if (!model) return 'Model not recorded'; try { return modelName(agent, model); } catch { return model; } };
  const safeAgent = (a) => { try { return agentLabel(a); } catch { return a; } };
  const svgNs = (tag, attrs = {}) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };

  // ---------- slicing ----------
  function cut(from, to) {
    const d = SX.data, inP = (p) => SX.project === 'all' || String(p) === SX.project;
    const inR = (t) => t != null && t >= from && t <= to;
    const taskP = new Map(d.tasks.map((t) => [t.id, t.p]));
    const end = (r) => r.end ?? d.at;
    return {
      from, to, inR,
      tasks: d.tasks.filter((t) => inP(t.p)),
      runs: d.runs.filter((r) => inP(r.p) && r.start <= to && end(r) >= from),
      you: d.you.filter((m) => inP(m.p) && inR(m.t)),
      chat: SX.project === 'all' ? d.chat.filter((c) => inR(c.t)) : [],
      owner: d.owner.filter((o) => (SX.project === 'all' || o.p == null || inP(o.p)) && inR(o.t)),
      checks: d.checks.filter((c) => inP(taskP.get(c.task)) && inR(c.t)),
      moves: d.moves.filter((m) => inP(taskP.get(m.task)) && inR(m.t)),
      commits: d.commits.filter((c) => inP(c.p) && inR(c.t)),
      allCommits: d.commits.filter((c) => inP(c.p)),
      windows: d.windows.filter((w) => w.closed && inR(w.resetsAt)),
      limits: d.limits.filter((l) => inR(l.t)),
      machine: d.machine.filter((m) => inR(m.t)),
    };
  }
  function slices() {
    const d = SX.data, span = RANGE_MS[SX.range], to = d.at;
    const from = span ? to - span : d.since;
    // A previous period only when this one starts after the data does (else every delta would be "up from nothing").
    return { cur: cut(from, to), prev: span && from > d.since ? cut(from - span, from) : null };
  }
  // How long each run overlapped [from, to].
  const runMs = (r, from, to) => Math.max(0, Math.min(r.end ?? SX.data.at, to) - Math.max(r.start, from));
  // Splits run time into local-hour cells: cb(hourStart, ms, run).
  function eachHour(runs, from, to, cb) {
    for (const r of runs) {
      let t = Math.max(r.start, from);
      const e = Math.min(r.end ?? SX.data.at, to);
      while (t < e) { const n = Math.min(nextHour(t), e); cb(t, n - t, r); t = n; }
    }
  }

  function metrics(c) {
    const work = c.tasks.filter((t) => t.kind === 'work');
    const shipped = work.filter((t) => t.status === 'done' && c.inR(t.finished));
    const created = work.filter((t) => c.inR(t.created));
    const cancelled = work.filter((t) => t.status === 'cancelled' && c.inR(t.finished ?? t.created));
    const failed = work.filter((t) => t.status === 'failed' && c.inR(t.finished ?? t.created));
    const runsEnded = c.runs.filter((r) => c.inR(r.end ?? r.start));
    const agentMs = sum(c.runs, (r) => runMs(r, c.from, c.to));
    const tok = { in: sum(runsEnded, (r) => r.in) + sum(c.chat, (x) => x.in), out: sum(runsEnded, (r) => r.out) + sum(c.chat, (x) => x.out),
      cached: sum(runsEnded, (r) => r.cached) + sum(c.chat, (x) => x.cached) };
    tok.total = tok.in + tok.out + tok.cached;
    // A shipped task passed first time when its first done-when check (ever) passed.
    const firstCheck = new Map();
    for (const k of SX.data.checks) if (!firstCheck.has(k.task)) firstCheck.set(k.task, k.ok);
    const checked = shipped.filter((t) => firstCheck.has(t.id));
    const days = new Set();
    for (const m of c.you) days.add(dayStart(m.t));
    for (const t of shipped) days.add(dayStart(t.finished));
    return {
      shipped, created, cancelled, failed, runsEnded, agentMs, tok,
      commits: c.commits, add: sum(c.commits, (x) => x.add), del: sum(c.commits, (x) => x.del),
      firstPass: checked.length ? checked.filter((t) => firstCheck.get(t.id)).length / checked.length : null, checkedN: checked.length,
      caught: c.checks.filter((k) => !k.ok).length,
      lead: median(shipped.map((t) => t.finished - t.created)),
      autonomy: created.length ? created.filter((t) => t.from === 'reflection').length / created.length : null,
      messages: c.you.length, activeDays: days.size,
    };
  }

  // ---------- tooltip ----------
  function tipEl() {
    let t = $('sxTip');
    if (!t) { t = el('div', 'sx-tip'); t.id = 'sxTip'; t.setAttribute('role', 'tooltip'); t.hidden = true; $('statsModal').append(t); }
    return t;
  }
  function showTip(lines, x, y) {
    const t = tipEl();
    t.replaceChildren(...lines.map((l, i) => el(i ? 'span' : 'strong', '', l)));
    t.hidden = false;
    const w = t.offsetWidth, h = t.offsetHeight;
    t.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, x - w / 2))}px`;
    t.style.top = `${y - h - 12 < 8 ? y + 18 : y - h - 12}px`;
  }
  const hideTip = () => { const t = $('sxTip'); if (t) t.hidden = true; };
  // Any element with data-tip (lines split by \n) shows it on hover and keyboard focus.
  function wireTips(root) {
    const at = (e) => e.target.closest?.('[data-tip]');
    let mouse = null; // where the mouse rests, so a scroll re-targets the tip to what is under it now instead of dropping it
    root.addEventListener('pointermove', (e) => {
      mouse = e.pointerType === 'mouse' ? { x: e.clientX, y: e.clientY } : null;
      const n = at(e); if (n) showTip(n.dataset.tip.split('\n'), e.clientX, e.clientY); else hideTip();
    });
    root.addEventListener('pointerleave', () => { mouse = null; hideTip(); });
    root.addEventListener('focusin', (e) => { const n = at(e); if (!n) return; const r = n.getBoundingClientRect(); showTip(n.dataset.tip.split('\n'), r.left + r.width / 2, r.top); });
    root.addEventListener('focusout', hideTip);
    // Scrolling (wheel, or a scroll-into-view that lands after the pointer arrived) moves content under a resting mouse.
    root.addEventListener('scroll', () => {
      const n = mouse && document.elementFromPoint(mouse.x, mouse.y)?.closest('[data-tip]');
      if (n) showTip(n.dataset.tip.split('\n'), mouse.x, mouse.y); else hideTip();
    }, { passive: true, capture: true });
  }

  // ---------- building blocks ----------
  function card(title, sub, cls = '') {
    const c = el('section', `m-card sx-card ${cls}`);
    if (title) { const h = el('div', 'sx-card-head'); h.append(el('h3', '', title)); if (sub) h.append(el('p', 'sx-card-sub', sub)); c.append(h); }
    return c;
  }
  function legend(items) {
    const l = el('div', 'sx-legend');
    for (const [label, color, shape = 'box'] of items) { const s = el('span', shape, label); s.style.setProperty('--c', color); l.append(s); }
    return l;
  }
  // A stat tile: label, value, optional detail and delta against the previous period.
  function tile(label, value, detail, delta) {
    const t = el('div', 'sx-tile');
    t.append(el('span', 'sx-label', label), el('strong', 'sx-value', value));
    if (delta) { const d = el('span', `sx-delta ${delta.cls}`, delta.text); t.append(d); }
    if (detail) t.append(el('span', 'sx-detail', detail));
    return t;
  }
  // Delta vs the previous period: up/down arrow; good/bad colouring when "more" has a direction.
  function delta(cur, prev, { good = 1, fmt = num, label } = {}) {
    if (prev == null || cur == null || !SX.data || RANGE_MS[SX.range] === 0) return null;
    const diff = cur - prev;
    const vs = label || `vs previous ${SX.range}`;
    if (Math.abs(diff) < 1e-9) return { text: `No change ${vs}`, cls: 'flat' };
    const up = diff > 0;
    return { text: `${up ? '▲' : '▼'} ${fmt(Math.abs(diff))} ${vs}`, cls: good === 0 ? 'flat' : (up === (good > 0)) ? 'good' : 'bad' };
  }
  function empty(text) { return el('p', 'na sx-empty', text); }

  // Columns (optionally stacked). cols: [{label, tip, parts: [{v, color}]}]; ticks: indexes to label on the axis.
  function columns(cols, { height = 132, ticks, unit = '', aria } = {}) {
    const wrap = el('div', 'sx-cols');
    const max = Math.max(1, ...cols.map((c) => sum(c.parts, (p) => p.v)));
    const plot = el('div', 'sx-cols-plot');
    plot.style.height = `${height}px`;
    plot.setAttribute('role', 'img');
    if (aria) plot.setAttribute('aria-label', aria);
    const grid = el('span', 'sx-cols-max', `${num(max)}${unit}`);
    plot.append(grid);
    cols.forEach((c) => {
      const col = el('div', 'sx-col');
      if (c.tip) { col.dataset.tip = c.tip; col.tabIndex = cols.length <= 40 ? 0 : -1; }
      const stack = el('div', 'sx-stack');
      for (const p of c.parts) {
        if (!p.v) continue;
        const seg = el('i');
        seg.style.height = `${(p.v / max) * 100}%`;
        seg.style.background = p.color;
        stack.append(seg);
      }
      col.append(stack);
      plot.append(col);
    });
    wrap.append(plot);
    const axis = el('div', 'sx-cols-axis');
    const show = new Set(ticks || [0, cols.length - 1]);
    cols.forEach((c, i) => axis.append(el('span', '', show.has(i) ? c.label : '')));
    wrap.append(axis);
    return wrap;
  }

  // Horizontal bars: rows [{label, v, text, tip, color, sub}]. One series → one color.
  function bars(rows, { color = 'var(--sx-c2)', max } = {}) {
    const list = el('div', 'sx-bars');
    const m = max ?? Math.max(1, ...rows.map((r) => r.v));
    for (const r of rows) {
      const row = el('div', 'sx-bar-row');
      if (r.tip) { row.dataset.tip = r.tip; row.tabIndex = 0; }
      const name = el('span', 'sx-bar-name', r.label);
      name.title = r.label;
      const track = el('span', 'sx-bar-track');
      const fill = el('i');
      fill.style.width = `${Math.max(r.v > 0 ? 1.5 : 0, (r.v / m) * 100)}%`;
      fill.style.background = r.color || color;
      track.append(fill);
      row.append(name, track, el('span', 'sx-bar-val', r.text ?? num(r.v)));
      list.append(row);
    }
    return list;
  }

  // A 100% bar split into parts: [{label, v, color}] with a legend under it.
  function splitBar(parts, fmt = num) {
    const w = el('div', 'sx-split');
    const total = sum(parts, (p) => p.v) || 1;
    const bar = el('div', 'sx-split-bar');
    for (const p of parts) {
      if (!p.v) continue;
      const seg = el('i');
      seg.style.flexGrow = String(p.v / total);
      seg.style.background = p.color;
      seg.dataset.tip = `${fmt(p.v)} · ${pct(p.v / total)}\n${p.label}`;
      bar.append(seg);
    }
    w.append(bar, legend(parts.filter((p) => p.v).map((p) => [`${p.label} ${pct(p.v / total)}`, p.color])));
    return w;
  }

  // A line over time with a crosshair: pts [{t, v}] (sorted), redrawn to the host's width.
  function lineChart(pts, { height = 150, fmt = num, label = '', color = 'var(--sx-c2)' } = {}) {
    const host = el('div', 'sx-line');
    host.style.height = `${height}px`;
    const svg = svgNs('svg', { role: 'img', 'aria-label': label });
    host.append(svg);
    const axis = el('div', 'sx-cols-axis sx-line-axis');
    const wrap = el('div');
    wrap.append(host, axis);
    if (pts.length < 2) return wrap;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const lo = Math.min(0, ...pts.map((p) => p.v)), hi = Math.max(1, ...pts.map((p) => p.v)) * 1.06;
    axis.append(el('span', '', shortDay(t0)), el('span', '', shortDay(t1)));
    let hover = null;
    const draw = () => {
      const w = host.clientWidth, h = height;
      if (!w) return;
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * (w - 8) + 4, y = (v) => h - 4 - ((v - lo) / (hi - lo)) * (h - 22);
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
      svg.replaceChildren(
        svgNs('line', { class: 'grid', x1: 0, x2: w, y1: y(hi / 1.06), y2: y(hi / 1.06) }),
        svgNs('text', { class: 'gl', x: 0, y: y(hi / 1.06) - 4 }),
        svgNs('line', { class: 'base', x1: 0, x2: w, y1: y(0), y2: y(0) }),
        svgNs('path', { class: 'area', d: `${d}L${x(t1)},${y(0)}L${x(t0)},${y(0)}Z`, style: `fill:${color}` }),
        svgNs('path', { class: 'ln', d, style: `stroke:${color}` }),
      );
      svg.querySelector('.gl').textContent = fmt(hi / 1.06);
      const last = pts[pts.length - 1];
      svg.append(svgNs('circle', { class: 'dot', cx: x(last.t), cy: y(last.v), r: 4, style: `fill:${color}` }));
      if (hover != null) {
        const p = pts.reduce((a, b) => (Math.abs(b.t - hover) < Math.abs(a.t - hover) ? b : a));
        svg.append(svgNs('line', { class: 'cross', x1: x(p.t), x2: x(p.t), y1: 0, y2: h }), svgNs('circle', { class: 'dot', cx: x(p.t), cy: y(p.v), r: 4, style: `fill:${color}` }));
        const r = host.getBoundingClientRect();
        showTip([fmt(p.v), `${p.note ? `${p.note} · ` : ''}${dayName(p.t)} ${new Date(p.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`], r.left + x(p.t), r.top + y(p.v));
      }
    };
    host.addEventListener('pointermove', (e) => { const r = host.getBoundingClientRect(); hover = t0 + ((e.clientX - r.left - 4) / Math.max(1, r.width - 8)) * (t1 - t0); draw(); });
    host.addEventListener('pointerleave', () => { hover = null; hideTip(); draw(); });
    observe(host, draw);
    return wrap;
  }
  function observe(node, fn) {
    const ro = new ResizeObserver(() => fn());
    ro.observe(node);
    SX.observers.push(ro);
  }

  // ---------- heatmap: who worked when ----------
  // Always the last 30 days (whatever the range picker says; the project filter applies): one row per local day,
  // one column per local hour. Cell shade (orange) = agent time in that hour (agent-minutes: two tasks at once count
  // twice); a small neutral dot = you sent messages then. Totals use their own ramp (blue): a square at the end of each
  // row for the day, and a bottom row for each hour of the day across the month. Details are in the tooltips.
  const HEAT_DAYS = 30;
  function monthCut() {
    let from = dayStart(SX.data.at);
    for (let i = 1; i < HEAT_DAYS; i++) from = dayStart(from - 1); // local midnights, DST-safe
    return cut(from, SX.data.at);
  }
  function heatData(c) {
    const k = (t) => `${dayStart(t)}|${new Date(t).getHours()}`;
    const cells = new Map(); // key -> { ms, msgs, agents: Map(agent -> ms), tasks: Set, spans: [[s, e]] }
    const at = (key) => cells.get(key) || cells.set(key, { ms: 0, msgs: 0, agents: new Map(), tasks: new Set(), spans: [] }).get(key);
    eachHour(c.runs, c.from, c.to, (t, ms, r) => {
      const x = at(k(t));
      x.ms += ms;
      x.agents.set(r.agent, (x.agents.get(r.agent) || 0) + ms);
      x.tasks.add(r.task);
      x.spans.push([t, t + ms]);
    });
    for (const m of c.you) at(k(m.t)).msgs++;
    const rows = [];
    for (let d = dayStart(c.from); d <= c.to; d = nextDay(d)) rows.push(d);
    const days = rows.map((r) => { let ms = 0, n = 0; for (let hr = 0; hr < 24; hr++) { const x = cells.get(`${r}|${hr}`); ms += x?.ms || 0; n += x?.msgs || 0; } return { ms, n }; });
    const hours = Array.from({ length: 24 }, (_, hr) => ({ ms: sum(rows, (r) => cells.get(`${r}|${hr}`)?.ms || 0), n: sum(rows, (r) => cells.get(`${r}|${hr}`)?.msgs || 0) }));
    return { rows, cells, days, hours, max: Math.max(1, ...[...cells.values()].map((x) => x.ms)) };
  }
  // Most runs at once inside one cell (its clipped run spans).
  const overlap = (spans) => { let n = 0, best = 0; for (const [, d] of spans.flatMap(([s, e]) => [[s, 1], [e, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1])) best = Math.max(best, n += d); return best; };
  function heatSummary(c, h) {
    const agentMs = sum(h.days, (d) => d.ms);
    if (!agentMs) return `Last ${HEAT_DAYS} days · ${c.you.length ? `no agent work · ${plural(c.you.length, 'message')} from you` : 'no activity'}`;
    const active = h.days.filter((d) => d.ms).length, away = awayShare(c);
    return `Last ${HEAT_DAYS} days · ${hrs(agentMs)} of agent work on ${plural(active, 'day')}${away && away.share >= 0.05 ? ` · ${pct(away.share)} while you were away` : ''}`;
  }
  const step = (v, max, n) => (v ? Math.min(n, Math.ceil((v / max) * n)) : 0);
  function heatmap(c, h = heatData(c)) {
    const { rows, cells, days, hours, max } = h;
    const grid = el('div', 'sx-heat');
    grid.setAttribute('role', 'img');
    grid.setAttribute('aria-label', `Agent time and your messages by day and hour: ${heatSummary(c, h)}`);
    grid.append(el('span'));
    for (let hr = 0; hr < 24; hr++) grid.append(el('span', `sx-heat-h${hr && hr % 6 === 0 ? ' g' : ''}`, hr % 6 === 0 ? (hr === 12 ? 'Noon' : hourName(hr)) : ''));
    grid.append(el('span', 'sx-heat-h sx-heat-toth', 'Day'));
    const nowH = Math.floor(Date.now() / H);
    const taskTitle = (id) => SX.data.tasks.find((t) => t.id === id)?.title || '';
    // "Sep 28" on the first row and on the 1st of a month, else "Mon 28".
    const rowName = (r, i) => new Date(r).toLocaleDateString([], i === 0 || new Date(r).getDate() === 1 ? { month: 'short', day: 'numeric' } : { weekday: 'short', day: 'numeric' });
    const dayMax = Math.max(1, ...days.map((d) => d.ms)), hourMax = Math.max(1, ...hours.map((x) => x.ms));
    rows.forEach((r, ri) => {
      grid.append(el('span', 'sx-heat-row', rowName(r, ri)));
      for (let hr = 0; hr < 24; hr++) {
        const x = cells.get(`${r}|${hr}`), v = x?.ms || 0, n = x?.msgs || 0;
        const cell = el('span', `sx-heat-c${hr && hr % 6 === 0 ? ' g' : ''}`);
        const cellStart = new Date(new Date(r).setHours(hr)).getTime();
        if (cellStart + H <= c.from || Math.floor(cellStart / H) > nowH) cell.classList.add('out');
        cell.dataset.s = String(step(v, max, 4));
        if (n) cell.append(el('i', 'msg'));
        if (v || n) {
          const lines = [`${dayName(r)}, ${hourName(hr)}–${hourName((hr + 1) % 24)}`];
          if (v) {
            const at = overlap(x.spans);
            lines.push(`${hrs(v)} of agent time${at > 1 ? ` · ${at} at once` : ''}`);
            lines.push([...x.agents].sort((a, b) => b[1] - a[1]).map(([a, ms]) => `${safeAgent(a)} ${hrs(ms)}`).join(' · '));
            const ids = [...x.tasks];
            lines.push(ids.slice(0, 3).map((id) => `#${id} ${taskTitle(id)}`.trim()).join('\n') + (ids.length > 3 ? `\n+${ids.length - 3} more` : ''));
          }
          if (n) lines.push(`You sent ${plural(n, 'message')}`);
          cell.dataset.tip = lines.join('\n');
        }
        grid.append(cell);
      }
      const t = days[ri], tot = el('span', 'sx-heat-c sx-heat-tot sx-heat-dtot');
      tot.dataset.t = String(step(t.ms, dayMax, 4));
      tot.dataset.tip = `${dayName(r)}\n${t.ms ? `${hrs(t.ms)} of agent time` : 'No agent work'}${t.n ? ` · ${plural(t.n, 'message')} from you` : ''}`;
      grid.append(tot);
    });
    // Each hour of the day across the month.
    grid.append(el('span', 'sx-heat-row sx-heat-totlab', 'Total'));
    hours.forEach((x, hr) => {
      const tot = el('span', `sx-heat-c sx-heat-tot sx-heat-htot${hr && hr % 6 === 0 ? ' g' : ''}`);
      tot.dataset.t = String(step(x.ms, hourMax, 4));
      tot.dataset.tip = `${hourName(hr)}–${hourName((hr + 1) % 24)}, last ${HEAT_DAYS} days\n${x.ms ? `${hrs(x.ms)} of agent time` : 'No agent work'}${x.n ? ` · ${plural(x.n, 'message')} from you` : ''}`;
      grid.append(tot);
    });
    const all = sum(days, (d) => d.ms), allN = sum(days, (d) => d.n);
    const corner = el('span', 'sx-heat-sum', all ? hrs(all).replace(' ', '') : '–');
    corner.dataset.tip = `Last ${HEAT_DAYS} days\n${hrs(all)} of agent time${allN ? ` · ${plural(allN, 'message')} from you` : ''}`;
    grid.append(corner);
    const wrap = el('div', 'sx-heat-wrap');
    const key = el('div', 'sx-heat-scale');
    const ramp = (attr, label) => {
      const g = el('span', 'sx-heat-key');
      g.append(el('span', '', label));
      for (let s = 0; s <= 4; s++) { const i = el('i'); i.dataset[attr] = String(s); g.append(i); }
      return g;
    };
    key.append(ramp('s', 'Agent time per hour'), ramp('t', 'Totals per day and hour'), el('span', 'sx-heat-you', 'Your messages'));
    wrap.append(grid, key);
    return wrap;
  }

  // Share of agent time with no message from you in the hour before (sampled every 5 min).
  function awayShare(c) {
    const ts = SX.data.you.map((m) => m.t);
    if (!c.runs.length) return null;
    let away = 0, total = 0;
    for (const r of c.runs) {
      const e = Math.min(r.end ?? SX.data.at, c.to);
      for (let t = Math.max(r.start, c.from); t < e; t += 5 * MIN) {
        const step = Math.min(5 * MIN, e - t);
        total += step;
        // binary search for the last message at or before t
        let lo = 0, hi = ts.length - 1, last = null;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m] <= t) { last = ts[m]; lo = m + 1; } else hi = m - 1; }
        if (last == null || t - last > H) away += step;
      }
    }
    return total ? { share: away / total, ms: away } : null;
  }

  // Tasks shipped per local day, split by who asked for them.
  function shippedPerDay(c, m) {
    const days = [];
    for (let d = dayStart(c.from); d <= c.to; d = nextDay(d)) days.push(d);
    if (days.length > 62) return null;
    const by = new Map(days.map((d) => [d, { you: 0, reflection: 0 }]));
    for (const t of m.shipped) { const b = by.get(dayStart(t.finished)); if (b) b[t.from]++; }
    const cols = days.map((d) => {
      const b = by.get(d);
      return { label: shortDay(d), tip: `${plural(b.you + b.reflection, 'task')} shipped\n${dayName(d)} · ${b.you} you asked for · ${b.reflection} the orchestrator's idea`,
        parts: [{ v: b.you, color: 'var(--sx-c1)' }, { v: b.reflection, color: 'var(--sx-c2)' }] };
    });
    const ticks = cols.length <= 8 ? cols.map((_, i) => i) : [0, Math.floor(cols.length / 2), cols.length - 1];
    return columns(cols, { ticks, aria: `Tasks shipped per day, ${m.shipped.length} in total` });
  }

  // ---------- insights ----------
  // Candidate findings, each {score, tag, text}; the sheet shows the most telling ones.
  function insights(c, m, prevM) {
    const out = [];
    const add = (score, tag, text) => { if (text) out.push({ score, tag, text }); };
    const d = SX.data;

    const away = awayShare(c);
    if (away && m.agentMs > 30 * MIN) add(90 + away.share * 10, 'Leverage', `${pct(away.share)} of agent time (${hrs(away.ms)}) ran while you were away — no message from you in the hour before.`);
    if (m.messages && m.agentMs) add(80, 'Leverage', `Each message you sent bought about ${dur(m.agentMs / m.messages)} of agent work and ${(m.shipped.length / m.messages).toFixed(1)} shipped tasks.`);

    // Who drives: reflection share and how its ideas fared.
    const createdYou = m.created.filter((t) => t.from === 'you'), createdRef = m.created.filter((t) => t.from === 'reflection');
    if (createdRef.length >= 3 && createdYou.length >= 3) {
      const keep = (xs) => xs.filter((t) => t.status === 'done').length / xs.length;
      const cancel = (xs) => xs.filter((t) => t.status === 'cancelled').length / xs.length;
      add(70, 'Autonomy', `The orchestrator came up with ${pct(createdRef.length / m.created.length)} of the work itself. ${pct(keep(createdRef))} of its ideas shipped vs ${pct(keep(createdYou))} of yours; you cancelled ${pct(cancel(createdRef))} of its ideas and ${pct(cancel(createdYou))} of your own.`);
    }

    // Rhythm: your peak hour vs the agents'.
    if (m.messages >= 5) {
      const yh = top(countBy(c.you, (x) => new Date(x.t).getHours()))[0];
      const ah = new Map(); eachHour(c.runs, c.from, c.to, (t, ms) => ah.set(new Date(t).getHours(), (ah.get(new Date(t).getHours()) || 0) + ms));
      const ap = top(ah)[0];
      if (yh && ap) add(60, 'Rhythm', yh[0] === ap[0] ? `You and the agents peak at the same hour: ${hourName(yh[0])}.`
        : `You're most active around ${hourName(yh[0])}; the agents work hardest around ${hourName(ap[0])}.`);
    }

    // Quality gate.
    if (m.caught) add(65, 'Quality', `"Done when" checks caught ${plural(m.caught, 'unfinished attempt')} before ${m.caught === 1 ? 'it' : 'they'} could ship${m.firstPass != null ? `; ${pct(m.firstPass)} of shipped tasks passed on the first check` : ''}.`);

    // Quota use: how full each Claude 5-hour window got before it reset.
    for (const [agent, win, name] of [['claude', 'five_hour', '5-hour'], ['claude', 'seven_day', 'weekly'], ['codex', '5h', 'Codex 5-hour']]) {
      const ws = c.windows.filter((w) => w.agent === agent && w.window === win && w.n >= 2);
      if (ws.length < 2) continue;
      const avg = sum(ws, (w) => w.peak) / ws.length, full = ws.filter((w) => w.peak >= 90).length;
      add(win === 'five_hour' ? 85 : 55, 'Quota', `${name} windows peaked at ${Math.round(avg)}% on average before resetting (${full} of ${ws.length} reached 90%+)${avg < 70 ? ` — about ${Math.round(100 - avg)}% of that quota went unused` : ''}.`);
    }
    const hits = c.limits.filter((l) => l.status === 'hit');
    if (hits.length) {
      const moved = c.moves.filter((x) => x.by === 'limit').length;
      add(58, 'Limits', `Plan limits were hit ${plural(hits.length, 'time')}${moved ? `; ${plural(moved, 'task')} moved to another model instead of waiting` : ''}.`);
    }

    // Speed by model: median finished run.
    const byModel = new Map();
    for (const r of c.runs) {
      if (r.outcome !== 'ok' || !r.end || r.purpose !== 'work' || !r.model) continue;
      const k = `${safeModel(r.agent, r.model)} (${safeAgent(r.agent)})`;
      (byModel.get(k) || byModel.set(k, []).get(k)).push(r.end - r.start);
    }
    const meds = [...byModel].filter(([, xs]) => xs.length >= 3).map(([k, xs]) => [k, median(xs)]).sort((a, b) => a[1] - b[1]);
    if (meds.length >= 2) {
      const [fk, fv] = meds[0], [sk, sv] = meds[meds.length - 1];
      if (sv / fv >= 1.3) add(50, 'Agents', `${fk} finishes a task run in ${dur(fv)} (median); ${sk} takes ${dur(sv)} — ${(sv / fv).toFixed(1)}× as long.`);
    }

    // Cache.
    const inAll = m.tok.in + m.tok.cached;
    if (inAll > 1e6 && m.tok.cached / inAll > 0.5) add(45, 'Tokens', `${pct(m.tok.cached / inAll)} of input tokens were cache reads — ${compact(m.tok.cached)} tokens the agents didn't have to re-read from scratch.`);
    if (m.shipped.length >= 3) {
      const perTask = median(m.shipped.map((t) => sum(c.runs.filter((r) => r.task === t.id), (r) => r.in + r.out + r.cached)).filter((x) => x > 0));
      const lines = median(m.shipped.map((t) => sum(c.commits.filter((x) => x.task === t.id), (x) => x.add + x.del)).filter((x) => x > 0));
      if (perTask) add(40, 'Tokens', `A typical shipped task used ${compact(perTask)} tokens${lines ? ` and changed ${num(lines)} lines` : ''}.`);
    }

    // Busiest day and streak.
    const perDay = countBy(m.shipped, (t) => dayStart(t.finished));
    const best = top(perDay)[0];
    if (best && best[1] >= 3) add(48, 'Records', `Busiest day: ${dayName(best[0])}, with ${plural(best[1], 'task')} shipped.`);
    const streak = longestStreak([...perDay.keys()]);
    if (streak >= 3) add(35, 'Records', `Longest streak: ${streak} days in a row with something shipped.`);

    // Hotspot.
    const files = countBy(c.commits.flatMap((x) => x.files), (f) => f);
    const hot = top(files).filter(([f]) => !NOTES.test(f))[0];
    if (hot && hot[1] >= 5) add(42, 'Code', `Hotspot: ${hot[0]} changed in ${plural(hot[1], 'commit')} — ${pct(hot[1] / Math.max(1, c.commits.length))} of all commits.`);
    const agentLines = sum(c.commits.filter((x) => x.by === 'task' || x.by === 'reflect'), (x) => x.add), allLines = sum(c.commits, (x) => x.add);
    if (allLines > 200) add(47, 'Code', `Agents wrote ${pct(agentLines / allLines)} of the lines added (${num(agentLines)} of ${num(allLines)}); the rest came from chat edits and manual commits.`);

    // Server load while working.
    const busyHours = new Set(); eachHour(c.runs, c.from, c.to, (t) => busyHours.add(Math.floor(t / H) * H));
    const mb = c.machine.filter((x) => busyHours.has(x.t)), mi = c.machine.filter((x) => !busyHours.has(x.t));
    if (mb.length >= 3 && mi.length >= 3) add(30, 'Server', `The server's CPU averaged ${Math.round(sum(mb, (x) => x.cpu) / mb.length)}% in hours with agent work vs ${Math.round(sum(mi, (x) => x.cpu) / mi.length)}% when idle.`);

    // Ask → ship.
    const a2s = askToShip(c);
    if (a2s) add(62, 'Speed', `From your message to the first shipped result took ${dur(a2s)} (median).`);

    // Trend vs previous period.
    if (prevM && prevM.shipped.length) {
      const ch = (m.shipped.length - prevM.shipped.length) / prevM.shipped.length;
      if (Math.abs(ch) >= 0.2) add(75, 'Trend', `${ch > 0 ? 'Up' : 'Down'} ${pct(Math.abs(ch))}: ${plural(m.shipped.length, 'task')} shipped vs ${prevM.shipped.length} in the previous ${SX.range}.`);
    }
    return out.sort((a, b) => b.score - a.score);
  }
  function longestStreak(dayStarts) {
    const s = [...new Set(dayStarts)].sort((a, b) => a - b);
    let best = 0, run = 0, prev = null;
    for (const d of s) { run = prev != null && dayStart(nextDay(prev)) === d ? run + 1 : 1; best = Math.max(best, run); prev = d; }
    return best;
  }
  // Median time from a message of yours to the first task it led to being done (tasks you asked for created ≤ 20 min later).
  function askToShip(c) {
    const shipped = c.tasks.filter((t) => t.kind === 'work' && t.status === 'done' && t.from === 'you' && t.finished);
    const xs = [];
    for (const m of c.you) {
      const spawned = shipped.filter((t) => t.created >= m.t && t.created <= m.t + 20 * MIN && (m.p == null || t.p === m.p));
      if (spawned.length) xs.push(Math.min(...spawned.map((t) => t.finished)) - m.t);
    }
    return xs.length >= 2 ? median(xs) : null;
  }

  function insightList(list, n = 10) {
    if (!list.length) return empty('Not enough activity in this range for insights yet.');
    const ul = el('ul', 'sx-insights');
    for (const i of list.slice(0, n)) { const li = el('li'); li.append(el('span', 'sx-tag', i.tag), el('span', 'sx-ins', i.text)); ul.append(li); }
    return ul;
  }

  // ---------- tabs ----------
  function overview(c, m, pm) {
    const out = [];
    // Hero: the one number — shipped tasks — with the sentence that explains it.
    const hero = el('section', 'sx-hero');
    const since = SX.range === 'all' ? `Since ${new Date(c.from).toLocaleDateString([], { month: 'long', day: 'numeric' })}` : `In the last ${{ '30d': '30 days', '7d': '7 days', '24h': '24 hours' }[SX.range]}`;
    hero.append(el('span', 'sx-label', since));
    const big = el('div', 'sx-hero-num');
    big.append(el('strong', '', num(m.shipped.length)), el('span', '', m.shipped.length === 1 ? 'task shipped' : 'tasks shipped'));
    hero.append(big);
    const d = delta(m.shipped.length, pm?.shipped.length);
    if (d) hero.append(el('span', `sx-delta ${d.cls}`, d.text));
    hero.append(el('p', 'sx-hero-line', m.messages
      ? `${plural(m.messages, 'message')} from you turned into ${hrs(m.agentMs)} of agent work, ${plural(m.commits.length, 'commit')} and ${compact(m.tok.total)} tokens.`
      : `${hrs(m.agentMs)} of agent work, ${plural(m.commits.length, 'commit')} and ${compact(m.tok.total)} tokens.`));
    out.push(hero);

    const g = el('div', 'sx-tiles');
    g.append(
      tile('Agent time', hrs(m.agentMs), `${plural(c.runs.length, 'run')}`, delta(m.agentMs, pm?.agentMs, { fmt: hrs })),
      tile('Commits', num(m.commits.length), `+${num(m.add)} −${num(m.del)} lines`, delta(m.commits.length, pm?.commits.length)),
      tile('Tokens', compact(m.tok.total), `${compact(m.tok.out)} written`, delta(m.tok.total, pm?.tok.total, { fmt: compact, good: 0 })),
      tile('Your messages', num(m.messages), `${m.activeDays} active ${m.activeDays === 1 ? 'day' : 'days'}`, delta(m.messages, pm?.messages, { good: 0 })),
      tile('Passed first check', m.firstPass == null ? '–' : pct(m.firstPass), m.checkedN ? `of ${plural(m.checkedN, 'checked task')}` : 'No checks yet', delta(m.firstPass, pm?.firstPass, { fmt: pct })),
      tile('Lead time', m.lead == null ? '–' : dur(m.lead), 'median, queued to done', delta(m.lead, pm?.lead, { fmt: dur, good: -1 })),
      tile('Orchestrator\'s ideas', m.autonomy == null ? '–' : pct(m.autonomy), 'of new tasks came from reflection', delta(m.autonomy, pm?.autonomy, { fmt: pct, good: 0 })),
      tile('Not shipped', num(m.cancelled.length + m.failed.length), `${m.cancelled.length} cancelled · ${m.failed.length} failed`, delta(m.cancelled.length + m.failed.length, pm ? pm.cancelled.length + pm.failed.length : null, { good: -1 })),
    );
    out.push(g);

    const ins = card('What stands out', 'Generated from this range', 'wide');
    ins.append(insightList(insights(c, m, pm)));
    out.push(ins);

    const mc = monthCut(), hd = heatData(mc);
    const hm = card('Who worked when', heatSummary(mc, hd), 'wide');
    hm.append(heatmap(mc, hd));
    out.push(hm);

    const sp = card('Shipped per day', 'Work tasks that finished, by who asked for them');
    const chart = m.shipped.length ? shippedPerDay(c, m) : null;
    if (chart) { sp.append(legend([['You asked', 'var(--sx-c1)'], ["Orchestrator's idea", 'var(--sx-c2)']]), chart); }
    else sp.append(empty(m.shipped.length ? 'Too many days to show; pick a shorter range.' : 'Nothing shipped in this range.'));
    out.push(sp);

    out.push(records(c, m));
    return out;
  }

  function records(c, m) {
    const r = card('Records', 'The extremes in this range');
    const rows = [];
    const byTask = new Map();
    for (const x of c.runs) { const b = byTask.get(x.task) || { ms: 0, tok: 0, runs: 0 }; b.ms += runMs(x, c.from, c.to); b.tok += x.in + x.out + x.cached; b.runs++; byTask.set(x.task, b); }
    const title = (id) => SX.data.tasks.find((t) => t.id === id)?.title || `#${id}`;
    const pick = (f) => [...byTask].sort((a, b) => f(b[1]) - f(a[1]))[0];
    const longest = pick((b) => b.ms), hungriest = pick((b) => b.tok), stubborn = pick((b) => b.runs);
    if (longest) rows.push(['Longest task', `#${longest[0]} ${title(longest[0])}`, hrs(longest[1].ms)]);
    if (hungriest) rows.push(['Most tokens', `#${hungriest[0]} ${title(hungriest[0])}`, compact(hungriest[1].tok)]);
    if (stubborn && stubborn[1].runs > 1) rows.push(['Most sessions', `#${stubborn[0]} ${title(stubborn[0])}`, plural(stubborn[1].runs, 'session')]);
    // Fastest ship: least agent time across all of a shipped task's runs.
    const fastest = m.shipped.map((t) => [t, byTask.get(t.id)?.ms]).filter(([, v]) => v > 0).sort((a, b) => a[1] - b[1])[0];
    if (fastest) rows.push(['Fastest ship', `#${fastest[0].id} ${fastest[0].title}`, dur(fastest[1])]);
    const biggest = [...c.commits].filter((x) => x.by !== 'other').sort((a, b) => (b.add + b.del) - (a.add + a.del))[0];
    if (biggest) rows.push(['Biggest commit', `${biggest.sha}${biggest.task ? ` · task #${biggest.task}` : biggest.by === 'you' ? ' · your chat edits' : ''}`, `+${num(biggest.add)} −${num(biggest.del)}`]);
    if (!rows.length) { r.append(empty('No runs in this range.')); return r; }
    const ul = el('ul', 'sx-records');
    for (const [k, what, v] of rows) { const li = el('li'); li.append(el('span', 'k', k), el('span', 'w', what), el('strong', 'v', v)); ul.append(li); }
    r.append(ul);
    return r;
  }

  function youTab(c, m, pm) {
    const out = [];
    const wordsAll = c.you.flatMap((x) => words(x.text));
    const steer = countBy(c.owner, (o) => o.kind);
    const spawned = m.created.filter((t) => t.from === 'you').length;
    const a2s = askToShip(c);
    const yh = top(countBy(c.you, (x) => new Date(x.t).getHours()))[0];
    const g = el('div', 'sx-tiles');
    g.append(
      tile('Messages', num(m.messages), m.messages ? `${num(sum(c.you, (x) => x.words))} words · ${num(sum(c.you, (x) => x.words) / m.messages)} per message` : 'None in this range', delta(m.messages, pm?.messages, { good: 0 })),
      tile('Tasks per message', m.messages ? (spawned / m.messages).toFixed(1) : '–', `${plural(spawned, 'task')} from your asks`),
      tile('Ask → first result', a2s == null ? '–' : dur(a2s), 'median, message to first shipped task'),
      tile('Peak hour', yh ? hourName(yh[0]) : '–', yh ? `${plural(yh[1], 'message')} in that hour` : 'No messages'),
      tile('Steering actions', num(c.owner.length), top(steer)[0] ? `mostly ${STEER[top(steer)[0][0]].toLowerCase()}` : 'Reorders, cancels, settings'),
      tile('Active days', num(m.activeDays), `longest streak ${longestStreak(c.you.map((x) => dayStart(x.t)))} ${longestStreak(c.you.map((x) => dayStart(x.t))) === 1 ? 'day' : 'days'}`),
    );
    out.push(g);

    const rh = card('Your rhythm vs the agents\'', 'By hour of day, your local time', 'wide');
    const yourHours = Array.from({ length: 24 }, () => 0), agentHours = Array.from({ length: 24 }, () => 0);
    for (const x of c.you) yourHours[new Date(x.t).getHours()]++;
    eachHour(c.runs, c.from, c.to, (t, ms) => { agentHours[new Date(t).getHours()] += ms; });
    const ticks = [0, 6, 12, 18, 23];
    const twin = el('div', 'sx-twin');
    const a = el('div'); a.append(el('h4', '', 'Your messages'), columns(yourHours.map((v, h) => ({ label: hourName(h), tip: `${plural(v, 'message')}\n${hourName(h)}–${hourName((h + 1) % 24)}`, parts: [{ v, color: 'var(--sx-c1)' }] })), { height: 96, ticks, aria: 'Your messages by hour of day' }));
    const b = el('div'); b.append(el('h4', '', 'Agent time'), columns(agentHours.map((v, h) => ({ label: hourName(h), tip: `${hrs(v)} of agent time\n${hourName(h)}–${hourName((h + 1) % 24)}`, parts: [{ v: v / MIN, color: 'var(--sx-c2)' }] })), { height: 96, ticks, unit: ' min', aria: 'Agent time by hour of day' }));
    twin.append(a, b);
    rh.append(twin);
    out.push(rh);

    const wd = card('By weekday', 'Messages you sent');
    const byWd = Array.from({ length: 7 }, () => 0);
    for (const x of c.you) byWd[new Date(x.t).getDay()]++;
    wd.append(c.you.length ? bars([1, 2, 3, 4, 5, 6, 0].map((i) => ({ label: weekdayName(i), v: byWd[i], color: 'var(--sx-c1)' }))) : empty('No messages in this range.'));
    out.push(wd);

    const st = card('How you steer', 'What you changed after the agents started');
    st.append(c.owner.length ? bars(top(steer).map(([k, v]) => ({ label: STEER[k] || k, v, color: 'var(--sx-c1)' }))) : empty('No reorders, cancels or setting changes in this range.'));
    out.push(st);

    const ask = card('What you ask for', 'Most-used words in your messages', 'wide');
    const counts = countBy(wordsAll.filter((w) => !STOP.has(w) && w.length > 2), (w) => w);
    // "tasks" counts as "task" when both appear.
    for (const [w, n] of [...counts]) if (w.endsWith('s') && counts.has(w.slice(0, -1))) { counts.set(w.slice(0, -1), counts.get(w.slice(0, -1)) + n); counts.delete(w); }
    const wc = top(counts).slice(0, 24);
    if (wc.length) {
      const chips = el('div', 'sx-words');
      const maxW = wc[0][1];
      for (const [w, n] of wc) { const s = el('span', 'sx-word', w); s.append(el('b', '', String(n))); s.style.setProperty('--w', String(0.35 + 0.65 * (n / maxW))); s.dataset.tip = `${plural(n, 'time')}\n“${w}”`; chips.append(s); }
      ask.append(chips);
    } else ask.append(empty('No messages in this range.'));
    out.push(ask);

    return out;
  }

  function agentsTab(c, m) {
    const out = [];
    // Agent time split by agent, then a card per model.
    const byAgent = new Map(), others = new Set();
    for (const r of c.runs) {
      const g = agentGroup(r.agent);
      if (g === 'other') others.add(safeAgent(r.agent));
      byAgent.set(g, (byAgent.get(g) || 0) + runMs(r, c.from, c.to));
    }
    const share = card('Agent time by agent', `${hrs(m.agentMs)} in total`, 'wide');
    const groupLabel = (g) => (g === 'other' ? (others.size === 1 ? [...others][0] : `Other (${[...others].join(', ')})`) : safeAgent(g));
    share.append(byAgent.size ? splitBar(GROUPS.filter((g) => byAgent.has(g)).map((g) => ({ label: groupLabel(g), v: byAgent.get(g), color: agentColor(g) })), hrs) : empty('No runs in this range.'));
    out.push(share);

    // One row per model (by display name, so an alias and its full id are one row).
    const models = new Map();
    for (const r of c.runs) {
      const label = safeModel(r.agent, r.model), k = `${r.agent}|${label}`;
      const b = models.get(k) || { agent: r.agent, label, runs: [], ms: 0, tok: 0, cached: 0, in: 0 };
      b.runs.push(r); b.ms += runMs(r, c.from, c.to);
      if (c.inR(r.end ?? r.start)) { b.tok += r.in + r.out + r.cached; b.cached += r.cached; b.in += r.in; }
      models.set(k, b);
    }
    const mc = card('Models', 'Every model that ran a task or reflection in this range', 'wide');
    const COLS = ['Model', 'Agent time', 'Runs', 'Median run', 'Shipped', 'Tokens', 'Per task', 'Cache hits', 'Outcomes'];
    if (!models.size) mc.append(empty('No runs in this range.'));
    else {
      const table = el('div', 'sx-table');
      table.setAttribute('role', 'table');
      table.setAttribute('aria-label', 'Models');
      const hr = el('div', 'sx-tr sx-th');
      hr.setAttribute('role', 'row');
      for (const h of COLS) { const x = el('span', '', h); x.setAttribute('role', 'columnheader'); if (h === 'Per task') x.title = 'Tokens per shipped task'; hr.append(x); }
      table.append(hr);
      for (const b of [...models.values()].sort((x, y) => y.ms - x.ms)) {
        const ok = b.runs.filter((r) => r.outcome === 'ok');
        const shippedN = m.shipped.filter((t) => (t.agent || 'claude') === b.agent && safeModel(t.agent || 'claude', t.model) === b.label).length;
        const tr = el('div', 'sx-tr');
        tr.setAttribute('role', 'row');
        const name = el('span', 'sx-td-name');
        const sw = el('i', 'sx-sw'); sw.style.background = agentColor(b.agent);
        const nm = el('span'); nm.append(el('strong', '', b.label), el('small', '', safeAgent(b.agent)));
        name.append(sw, nm);
        const cells = [name];
        for (const [i, v] of [hrs(b.ms), num(b.runs.length), ok.length ? dur(median(ok.filter((r) => r.end).map((r) => r.end - r.start))) : '–', num(shippedN),
          compact(b.tok), shippedN ? compact(b.tok / shippedN) : '–', b.in + b.cached ? pct(b.cached / (b.in + b.cached)) : '–'].entries()) {
          const x = el('span', 'sx-td', v); x.dataset.label = COLS[i + 1]; cells.push(x);
        }
        const oc = countBy(b.runs, (r) => r.outcome || 'running');
        const outcome = el('span', 'sx-td sx-outcome');
        outcome.dataset.label = 'Outcomes';
        const bar = el('span', 'sx-split-bar thin');
        for (const [id, label, color] of OUTCOMES) {
          const v = oc.get(id) || 0; if (!v) continue;
          const seg = el('i'); seg.style.flexGrow = String(v); seg.style.background = color; seg.dataset.tip = `${plural(v, 'run')}\n${label}`; bar.append(seg);
        }
        outcome.append(bar, el('small', '', b.runs.length ? `${pct(ok.length / b.runs.length)} finished` : ''));
        outcome.title = OUTCOMES.filter(([id]) => oc.get(id)).map(([id, label]) => `${label} ${oc.get(id)}`).join(' · ');
        cells.push(outcome);
        for (const x of cells) x.setAttribute('role', 'cell');
        tr.append(...cells);
        table.append(tr);
      }
      mc.append(table, legend(OUTCOMES.map(([, label, color]) => [label, color])));
    }
    out.push(mc);

    // Plan quota: each finished window as a meter of how much of it was used.
    const qc = card('How full each plan window got', 'Peak usage seen before each window reset · all projects', 'wide');
    const groups = new Map();
    for (const w of c.windows) (groups.get(`${w.agent}|${w.window}`) || groups.set(`${w.agent}|${w.window}`, []).get(`${w.agent}|${w.window}`)).push(w);
    const winName = (w) => { try { return winLabel(w); } catch { return w; } };
    const rank = (k) => (k.startsWith('claude|') ? 0 : 1) + (/five_hour|\|5h$/.test(k) ? 0 : 0.5);
    let any = false;
    for (const [k, ws] of [...groups].sort((a, b) => rank(a[0]) - rank(b[0]))) {
      const [agent, win] = k.split('|');
      const good = ws.filter((w) => w.n >= 2);
      if (!good.length) continue;
      any = true;
      const avg = sum(good, (w) => w.peak) / good.length;
      const g = el('div', 'sx-quota');
      const h = el('div', 'sx-quota-head');
      h.append(el('strong', '', `${safeAgent(agent)} · ${winName(win)}`), el('span', '', `avg peak ${Math.round(avg)}% · ${good.filter((w) => w.peak >= 90).length} of ${good.length} reached 90%+`));
      const meters = el('div', 'sx-meters');
      meters.setAttribute('role', 'img');
      meters.setAttribute('aria-label', `${good.length} windows, average peak ${Math.round(avg)}%`);
      for (const w of good) {
        const mtr = el('span', 'sx-meter');
        const f = el('i'); f.style.height = `${Math.min(100, w.peak)}%`; f.style.background = agentColor(agent);
        mtr.append(f);
        mtr.dataset.tip = `${Math.round(w.peak)}% peak\nreset ${dayName(w.resetsAt)} ${new Date(w.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${plural(w.n, 'reading')}`;
        meters.append(mtr);
      }
      g.append(h, meters);
      qc.append(g);
    }
    if (!any) qc.append(empty('No plan windows reset in this range, or there were too few readings.'));
    out.push(qc);

    // Limits and delegation.
    const lc = card('Limits and hand-offs', 'When a model ran out, where its work went');
    const hits = c.limits.filter((l) => l.status === 'hit');
    const facts = el('div', 'sx-facts wide');
    let blocked = 0;
    const open = new Map();
    for (const l of [...c.limits].sort((a, b) => a.t - b.t)) {
      if (l.status === 'hit') open.set(l.agent, l.t);
      else if (open.has(l.agent)) { blocked += l.t - open.get(l.agent); open.delete(l.agent); }
    }
    for (const [k, v] of [['Limit hits', num(hits.length)], ['Time limited', blocked ? hrs(blocked) : '–'], ['Tasks moved', num(c.moves.length)], ['By you', num(c.moves.filter((x) => x.by === 'owner').length)]]) {
      const f = el('span'); f.append(el('small', '', k), el('b', '', v)); facts.append(f);
    }
    lc.append(facts);
    const routes = top(countBy(c.moves, (x) => `${x.from} → ${x.to}`)).slice(0, 6);
    if (routes.length) {
      const nm = (s) => { const [a, ...rest] = s.split('/'); return safeModel(a, rest.join('/') || null); };
      lc.append(bars(routes.map(([k, v]) => { const [f, t] = k.split(' → '); return { label: `${nm(f)} → ${nm(t)}`, v, color: 'var(--sx-c2)' }; })));
    }
    out.push(lc);

    const tc = card('Tokens', 'Where they went in this range');
    const chatTok = sum(c.chat, (x) => x.in + x.out + x.cached);
    const work = sum(m.runsEnded.filter((r) => r.purpose === 'work'), (r) => r.in + r.out + r.cached), refl = sum(m.runsEnded.filter((r) => r.purpose === 'reflect'), (r) => r.in + r.out + r.cached);
    if (m.tok.total) {
      tc.append(splitBar([{ label: 'Tasks', v: work, color: 'var(--sx-c2)' }, { label: 'Reflection', v: refl, color: 'var(--sx-c3)' }, { label: 'Chat', v: chatTok, color: 'var(--sx-c1)' }], compact));
      const f2 = el('div', 'sx-facts wide');
      for (const [k, v] of [['Cache reads', compact(m.tok.cached)], ['Fresh input', compact(m.tok.in)], ['Written', compact(m.tok.out)], ['Turns', num(sum(c.runs, (r) => r.turns))]]) { const f = el('span'); f.append(el('small', '', k), el('b', '', v)); f2.append(f); }
      tc.append(f2);
    } else tc.append(empty('No tokens recorded in this range.'));
    out.push(tc);
    return out;
  }

  function projectsTab(c, m) {
    const out = [];
    // All projects: only the active ones (paused or detached projects are left out, their commits too); picking one in
    // the project filter still shows it whatever its status.
    const allP = SX.project === 'all', paused = SX.data.projects.filter((p) => p.status !== 'active');
    const projects = SX.data.projects.filter((p) => (allP ? p.status === 'active' : String(p.id) === SX.project));
    const ids = new Set(projects.map((p) => p.id)), mine = (xs) => (allP ? xs.filter((x) => ids.has(x.p)) : xs);
    c = { ...c, commits: mine(c.commits), allCommits: mine(c.allCommits) };
    const pc = card('Projects', allP ? `${plural(projects.length, 'active project')}${paused.length ? ` · ${num(paused.length)} paused not shown` : ''}` : '', 'wide');
    const list = el('div', 'sx-models');
    for (const p of projects) {
      const runs = c.runs.filter((r) => r.p === p.id), commits = c.commits.filter((x) => x.p === p.id);
      const shipped = m.shipped.filter((t) => t.p === p.id), open = SX.data.tasks.filter((t) => t.p === p.id && ['queued', 'running', 'paused', 'awaiting_review'].includes(t.status));
      const last = Math.max(0, ...SX.data.tasks.filter((t) => t.p === p.id).map((t) => t.finished || t.created || 0));
      const row = el('div', 'sx-model');
      const head = el('div', 'sx-model-head');
      head.append(el('strong', '', p.name), el('span', `sx-pill ${p.status}`, p.status === 'paused' ? 'Paused' : 'Active'), el('span', 'sx-model-agent', last ? `last activity ${fmtWhen(last)}` : ''));
      const facts = el('div', 'sx-facts');
      for (const [k, v] of [['Shipped', num(shipped.length)], ['Open', num(open.length)], ['Commits', num(commits.length)], ['Lines', `+${compact(sum(commits, (x) => x.add))} −${compact(sum(commits, (x) => x.del))}`],
        ['Agent time', hrs(sum(runs, (r) => runMs(r, c.from, c.to)))], ['Tokens', compact(sum(runs.filter((r) => c.inR(r.end ?? r.start)), (r) => r.in + r.out + r.cached))]]) {
        const f = el('span'); f.append(el('small', '', k), el('b', '', v)); facts.append(f);
      }
      row.append(head, facts);
      list.append(row);
    }
    pc.append(projects.length ? list : empty(allP && paused.length ? 'No active projects.' : 'No projects yet.'));
    out.push(pc);

    // Code size over time: running total of lines added minus removed (generated files excluded).
    const gc = card('Code growth', 'Net lines (added − removed) across all commits, generated files excluded', 'wide');
    const all = c.allCommits;
    if (all.length >= 2) {
      let acc = 0;
      const pts = [];
      for (const x of all) { acc += x.add - x.del; if (x.t >= c.from) pts.push({ t: x.t, v: acc, note: `${x.sha} +${num(x.add)} −${num(x.del)}` }); }
      if (pts.length >= 2) gc.append(lineChart(pts, { fmt: (v) => `${num(v)} lines`, label: `Net lines of code grew to ${num(acc)}` }));
      else gc.append(empty('Fewer than two commits in this range.'));
    } else gc.append(empty('No git history for this selection.'));
    out.push(gc);

    const wc = card('Who wrote the code', 'Lines added, by where the commit came from');
    const byWho = (k) => sum(c.commits.filter((x) => x.by === k), (x) => x.add);
    const nWho = (k) => c.commits.filter((x) => x.by === k).length;
    if (c.commits.length) {
      const parts = (f, unit) => [{ label: 'You (chat and manual edits)', v: f('you') + f('other'), color: 'var(--sx-c1)' }, { label: 'Agent tasks', v: f('task'), color: 'var(--sx-c2)' }, { label: 'Reflection', v: f('reflect'), color: 'var(--sx-c3)' }]
        .map((p) => ({ ...p, unit }));
      wc.append(el('h4', 'sx-sub', 'Lines added'), splitBar(parts(byWho), (v) => `${num(v)} lines`), el('h4', 'sx-sub', 'Commits'), splitBar(parts(nWho), (v) => plural(v, 'commit')));
      const perTask = median(c.commits.filter((x) => x.by === 'task').map((x) => x.add + x.del));
      if (perTask != null) wc.append(el('p', 'sx-note', `A typical agent commit changes ${num(perTask)} lines; ${pct(c.commits.filter((x) => x.by === 'task' && x.files.some((f) => /(^|\/)test\/|\.test\./.test(f))).length / Math.max(1, nWho('task')))} of them touch tests.`));
    } else wc.append(empty('No commits in this range.'));
    out.push(wc);

    const hc = card('Hotspots', 'Files changed in the most commits (the agents\' .agent-orch notes left out)');
    const files = top(countBy(c.commits.flatMap((x) => x.files.filter((f) => !NOTES.test(f))), (f) => f)).slice(0, 10);
    hc.append(files.length ? bars(files.map(([f, v]) => ({ label: f, v, text: plural(v, 'commit'), tip: `${plural(v, 'commit')}\n${f}` }))) : empty('No commits in this range.'));
    out.push(hc);
    return out;
  }

  // ---------- sheet ----------
  function render() {
    if ($('statsModal').hidden) return;
    for (const b of document.querySelectorAll('#sxTabs [role=tab]')) {
      const on = b.dataset.tab === SX.tab;
      b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
    }
    for (const b of document.querySelectorAll('#sxRange button')) b.setAttribute('aria-pressed', String(b.dataset.range === SX.range));
    chip.firstChild.textContent = `${document.querySelector(`#sxRange [data-range="${SX.range}"]`).textContent} `;
    placeSub();
    const d = SX.data, body = $('sxBody');
    $('sxSub').textContent = SX.err ? `Couldn't load stats: ${SX.err}` : !d ? 'Loading…' : `You and the orchestrator · updated ${fmtWhen(d.at)}`;
    if (!d) { body.classList.toggle('busy', !SX.err); return; }
    body.classList.remove('busy');
    const sel = $('sxProject');
    const opts = [['all', 'All projects'], ...d.projects.map((p) => [String(p.id), p.name])];
    if (sel.options.length !== opts.length) sel.replaceChildren(...opts.map(([v, t]) => { const o = el('option', '', t); o.value = v; return o; }));
    if (!opts.some(([v]) => v === SX.project)) SX.project = 'all';
    sel.value = SX.project;
    sel.hidden = d.projects.length < 2;
    for (const ro of SX.observers) ro.disconnect();
    SX.observers = [];
    hideTip();
    const { cur, prev } = slices();
    const m = metrics(cur), pm = prev && metrics(prev);
    const content = SX.tab === 'you' ? youTab(cur, m, pm) : SX.tab === 'agents' ? agentsTab(cur, m) : SX.tab === 'projects' ? projectsTab(cur, m) : overview(cur, m, pm);
    const grid = el('div', 'sx-grid');
    grid.append(...content);
    const y = body.scrollTop;
    body.replaceChildren(...(phone.matches ? [$('sxSub')] : []), grid);
    body.scrollTop = y;
  }
  async function load(fresh = false) {
    if (SX.loading) return SX.loading;
    return (SX.loading = api(`/api/stats${fresh ? '?fresh=1' : ''}`).then((d) => { SX.data = d; SX.err = ''; })
      .catch((e) => { SX.err = e.message; }).finally(() => { SX.loading = null; render(); }));
  }
  function open() {
    closeSidebar();
    if ($('statsModal').hidden) SX.lastFocus = document.activeElement;
    $('statsModal').hidden = false;
    render();
    load();
    $('statsModal').querySelector('.icon-btn[data-close]').focus();
  }
  function close() {
    rangeMenu(false);
    $('statsModal').hidden = true;
    hideTip();
    for (const ro of SX.observers) ro.disconnect();
    SX.observers = [];
    SX.lastFocus?.focus?.();
  }

  // Phones (UI-REVIEW #27): the range picker folds into a menu chip beside the tabs (project select and range buttons
  // open below it), and the subtitle scrolls with the body, so only the grabber, title and tabs row stay pinned.
  const phone = matchMedia('(max-width: 600px)');
  const chip = el('button', 'sx-range-chip');
  chip.id = 'sxRangeChip'; chip.type = 'button';
  chip.setAttribute('aria-haspopup', 'true'); chip.setAttribute('aria-expanded', 'false'); chip.setAttribute('aria-controls', 'sxRangePop');
  chip.setAttribute('aria-label', 'Time range');
  chip.append(document.createTextNode('All '), el('span', 'caret', '▾'));
  const pop = el('div', 'sx-range-pop');
  pop.id = 'sxRangePop';
  $('sxRange').before(chip);
  pop.append($('sxProject'), $('sxRange'));
  chip.after(pop);
  function rangeMenu(on) {
    chip.parentNode.classList.toggle('open', on);
    chip.setAttribute('aria-expanded', String(on));
    if (on) document.querySelector('#sxRange [aria-pressed="true"]')?.focus();
  }
  // The subtitle lives in the head on desktop and at the top of the scrolling body on phones.
  function placeSub() {
    const sub = $('sxSub'), body = $('sxBody');
    if (phone.matches && sub.parentNode !== body) body.prepend(sub);
    else if (!phone.matches && sub.parentNode === body) $('sxTitle').after(sub);
  }
  phone.addEventListener('change', () => { rangeMenu(false); placeSub(); });
  chip.addEventListener('click', () => rangeMenu(chip.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('click', (e) => { if (chip.getAttribute('aria-expanded') === 'true' && !e.target.closest('.sx-filters')) rangeMenu(false); });
  // Up/down arrows walk the open menu's range buttons.
  pop.addEventListener('keydown', (e) => {
    if (!phone.matches || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const bs = [...document.querySelectorAll('#sxRange button')], i = bs.indexOf(document.activeElement);
    e.preventDefault();
    bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length].focus();
  });

  $('statsBtn').addEventListener('click', open);
  $('statsModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('statsModal').hidden) return;
    e.stopImmediatePropagation();
    if (chip.getAttribute('aria-expanded') === 'true') { rangeMenu(false); chip.focus(); } else close();
  }, true);
  $('sxTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[role=tab]');
    if (!b || b.dataset.tab === SX.tab) return;
    SX.tab = b.dataset.tab; store.set('cw.sx.tab', SX.tab);
    $('sxBody').scrollTop = 0;
    render();
  });
  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  $('sxTabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.indexOf(SX.tab), n = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    SX.tab = n; store.set('cw.sx.tab', n); render();
    document.querySelector(`#sxTabs [data-tab="${n}"]`).focus();
  });
  $('sxRange').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    if (chip.getAttribute('aria-expanded') === 'true') { rangeMenu(false); chip.focus(); }
    if (b.dataset.range === SX.range) return;
    SX.range = b.dataset.range; store.set('cw.sx.range', SX.range);
    render();
  });
  $('sxProject').addEventListener('change', (e) => { SX.project = e.target.value; render(); });
  $('sxRefresh').addEventListener('click', () => load(true));
  wireTips($('statsModal'));
})();
