// Machines → this server → Storage (storage.mjs). First: how full the disk is, one bar split by what fills it (same order
// as the list under it, so no colour has to say which is which), the categories, and what can safely go. A category
// or folder opens its contents, largest first, each with Remove or the reason it can't go. Measured only when this tab
// opens or the owner presses Rescan; a removal measures again, and the old numbers stay up meanwhile.
const SG = { data: null, err: '', loading: false, box: null, stack: [], busy: new Set() };
function sgOpen(box) {
  SG.box = box;
  if (!SG.data && !SG.loading) sgLoad();
  sgRender();
}
async function sgLoad(fresh = false) {
  SG.loading = true;
  SG.err = '';
  sgRender();
  try { SG.data = await api(`/api/storage${fresh ? '?fresh=1' : ''}`); } catch (e) { SG.err = e.message; }
  SG.loading = false;
  sgRender();
}
const sgBtn = (cls, text, run) => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', run);
  return b;
};
function sgRender() {
  if (!SG.box) return;
  const top = SG.stack.at(-1), scroll = $('ndBody').scrollTop;
  SG.box.replaceChildren(...(top ? sgListView(top) : sgHome()));
  $('ndBody').scrollTop = scroll;
}
function sgHome() {
  const d = SG.data;
  if (!d) {
    const out = [el('p', SG.err ? 'nd-note bad' : 'st-wait', SG.err || 'Measuring this disk. It takes under a minute at low priority.')];
    if (SG.err) out.push(sgBtn('btn small', 'Try again', () => sgLoad(true)));
    return out;
  }
  const pct = (d.disk.used / d.disk.total) * 100, [cls, word] = pct >= 92 ? ['crit', 'Nearly full'] : pct >= 80 ? ['warn', 'Filling up'] : ['', ''];
  const sum = el('div', 'st-sum'), free = el('div', 'st-free'), bar = el('div', 'st-bar'), read = el('p', 'st-read');
  free.append(el('b', '', fmtBytes(d.disk.free)), document.createTextNode(` free of ${fmtBytes(d.disk.total)}`));
  const status = el('span', `status${cls ? ` ${cls}` : ''}`, word);
  const head = el('div', 'st-head');
  head.append(free, status, sgBtn('btn small st-rescan', SG.loading ? 'Measuring…' : 'Rescan', () => sgLoad(true)));
  head.lastChild.disabled = SG.loading;
  const idle = `${fmtBytes(d.disk.used)} used · measured ${relTime(d.at)}`;
  read.textContent = idle;
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `${fmtBytes(d.disk.used)} used of ${fmtBytes(d.disk.total)}, ${d.categories.map((c) => `${c.label} ${fmtBytes(c.bytes)}`).join(', ')}`);
  const list = el('div', 'st-list');
  const mark = (id) => {
    bar.classList.toggle('hovering', !!id);
    for (const s of bar.children) s.classList.toggle('on', s.dataset.cat === id);
    for (const r of list.children) r.classList.toggle('on', r.dataset.cat === id);
    const c = d.categories.find((x) => x.id === id);
    read.textContent = c ? `${c.label} · ${fmtBytes(c.bytes)} · ${Math.round((c.bytes / d.disk.total) * 100)}% of the disk` : idle;
  };
  for (const c of d.categories) {
    const s = el('i');
    s.dataset.cat = c.id;
    s.style.flexGrow = c.bytes;
    s.addEventListener('pointerenter', () => mark(c.id));
    s.addEventListener('pointerleave', () => mark(null));
    bar.append(s);
    const r = el(c.items.length ? 'button' : 'div', 'st-row');
    r.dataset.cat = c.id;
    const t = el('span', 'st-rt');
    t.append(el('span', 'st-rl', c.label), el('span', 'st-rh', c.hint));
    r.append(t, el('span', 'st-size', fmtBytes(c.bytes)), el('span', c.items.length ? 'st-chev' : 'st-nochev'));
    if (c.items.length) {
      r.type = 'button';
      r.addEventListener('click', () => { SG.stack.push({ label: c.label, cat: c.id }); sgRender(); $('ndBody').scrollTop = 0; });
    }
    r.addEventListener('pointerenter', () => mark(c.id));
    r.addEventListener('pointerleave', () => mark(null));
    list.append(r);
  }
  const rest = el('i', 'st-freeseg');
  rest.style.flexGrow = Math.max(0, d.disk.total - d.disk.used);
  bar.append(rest);
  const cols = el('div', 'st-cols'), main = el('div'), clean = sgCleanups(d), line = el('div', 'st-readline');
  line.append(read);
  if (d.reclaimable > 0) {
    const go = sgBtn('link-btn st-jump', `${fmtBytes(d.reclaimable)} can be removed`, () => clean.scrollIntoView({ block: 'start' }));
    line.append(go);
  }
  sum.append(head, bar, line);
  main.append(list);
  cols.append(main, clean);
  return [sum, cols];
}
function sgCleanups(d) {
  const sec = el('div', 'st-clean'), h = el('h3', '', 'Can be removed');
  sec.append(h);
  if (!d.cleanups.length) { sec.append(el('p', 'nd-note', 'Nothing obvious right now. Open a category to look through the largest folders.')); return sec; }
  if (d.reclaimable > 0) h.append(el('span', 'st-total', `up to ${fmtBytes(d.reclaimable)}`));
  for (const g of d.cleanups) {
    const box = el('div', 'st-group'), gh = el('div', 'st-ghead'), gt = el('div', 'st-gt');
    gt.append(el('h4', '', g.title), el('p', 'st-why', g.why));
    gh.append(gt);
    if (g.items.length > 1 && g.items.every((x) => x.path)) gh.append(sgBtn('btn small', `Remove all · ${fmtBytes(g.bytes)}`, () => sgRemoveAll(g)));
    box.append(gh);
    for (const it of g.items) {
      const r = el('div', 'st-row st-item'), t = el('span', 'st-rt');
      t.append(el('span', 'st-rl st-path', it.label));
      const note = [it.touched && `last changed ${relTime(it.touched)}`, it.restore && `restore with ${it.restore}`].filter(Boolean).join(' · ');
      if (note) t.append(el('span', 'st-rh', note));
      r.append(t, el('span', 'st-size', fmtBytes(it.bytes)), sgRemoveBtn(it, g));
      box.append(r);
    }
    sec.append(box);
  }
  return sec;
}
function sgRemoveBtn(it, g) {
  const key = it.clean || it.path, busy = SG.busy.has(key);
  const b = sgBtn('btn small st-rm', busy ? 'Removing…' : 'Remove', () => (it.clean ? sgClean(it) : sgRemove([it], g)));
  b.disabled = busy;
  b.setAttribute('aria-label', `Remove ${it.label || it.name}`);
  return b;
}
// One folder's contents, largest first: a category's list from the scan, or a folder measured now.
function sgListView(v) {
  const crumbs = el('nav', 'st-crumbs');
  crumbs.setAttribute('aria-label', 'Where you are');
  crumbs.append(sgBtn('link-btn', 'Storage', () => { SG.stack = []; sgRender(); }));
  SG.stack.forEach((c, i) => {
    crumbs.append(el('span', 'st-sep', '›'));
    if (i === SG.stack.length - 1) crumbs.append(el('span', 'st-here', c.label));
    else crumbs.append(sgBtn('link-btn', c.label, () => { SG.stack.length = i + 1; sgRender(); }));
  });
  const cat = v.cat && SG.data?.categories.find((c) => c.id === v.cat);
  const rows = cat?.items || v.data?.entries, total = cat?.bytes ?? v.data?.bytes, more = cat?.more ?? v.data?.more;
  const head = el('div', 'st-lhead');
  head.append(el('h3', '', v.label), el('span', 'st-size', total != null ? fmtBytes(total) : ''));
  const out = [crumbs, head];
  if (v.path) out.push(el('p', 'st-pathline', v.path));
  if (cat?.hint) out.push(el('p', 'st-why', cat.hint));
  if (v.err) out.push(el('p', 'nd-note bad', v.err));
  else if (!rows) out.push(el('p', 'st-wait', 'Measuring…'));
  else if (!rows.length) out.push(el('p', 'nd-note', 'Nothing here takes real space.'));
  else {
    const max = Math.max(1, ...rows.map((x) => x.bytes)), list = el('div', 'st-list');
    for (const it of rows) {
      const r = el('div', 'st-row st-item'), t = el(it.dir ? 'button' : 'span', 'st-rt');
      const name = el('span', 'st-rl st-path', it.name), bar = el('span', 'st-rel'), fill = el('i');
      fill.style.width = `${Math.max(1, (it.bytes / max) * 100)}%`;
      bar.append(fill);
      t.append(name, bar);
      if (it.dir) {
        t.type = 'button';
        t.addEventListener('click', () => sgDrill(it));
      }
      r.append(t, el('span', 'st-size', fmtBytes(it.bytes)));
      if (it.why) {
        const w = el('span', 'st-lock', it.why);
        w.title = it.why;
        r.append(w);
      } else {
        const act = el('span', 'st-act');
        act.append(sgRemoveBtn(it));
        r.append(act);
      }
      list.append(r);
    }
    out.push(list);
    if (more) out.push(el('p', 'nd-note', `${more} smaller ${more === 1 ? 'item' : 'items'} not shown.`));
  }
  return out;
}
async function sgDrill(it) {
  const v = { label: it.name, path: it.path };
  SG.stack.push(v);
  sgRender();
  $('ndBody').scrollTop = 0;
  await sgLoadDir(v);
}
async function sgLoadDir(v) {
  v.err = '';
  try { v.data = await api(`/api/storage/dir?path=${encodeURIComponent(v.path)}`); } catch (e) { v.err = e.message; }
  sgRender();
}
function sgAfter(r, keys) {
  for (const k of keys) SG.busy.delete(k);
  const done = r?.removed?.length || 0, why = r?.skipped?.[0];
  if (done) toast(r.freed > 0 ? `Freed ${fmtBytes(r.freed)}` : 'Removed');
  if (why) toast(`${r.skipped.length > 1 ? `${r.skipped.length} items not removed. First: ` : "Couldn't remove it: "}${why.reason}`, { kind: 'error' });
  if (r?.disk && SG.data) SG.data.disk = r.disk;
  // Out of the lists now; the fresh measure that follows corrects the rest.
  const gone = new Set((r?.removed || []).map((x) => x.path));
  for (const v of SG.stack) if (v.data) v.data.entries = v.data.entries.filter((x) => !gone.has(x.path));
  for (const c of SG.data?.categories || []) c.items = c.items.filter((x) => !gone.has(x.path));
  for (const g of SG.data?.cleanups || []) g.items = g.items.filter((x) => !gone.has(x.path) && !gone.has(x.clean));
  if (SG.data) SG.data.cleanups = SG.data.cleanups.filter((g) => g.items.length);
  const top = SG.stack.at(-1);
  if (top?.path && gone.size) sgLoadDir(top);
  sgLoad(true);
}
async function sgRemove(items) {
  const bytes = items.reduce((a, x) => a + x.bytes, 0), name = items.length === 1 ? items[0].path : `these ${items.length} items`;
  const restore = items.length === 1 && items[0].restore ? `\n\nTo get it back: ${items[0].restore}.` : "\n\nThis can't be undone.";
  if (!confirm(`Remove ${name}? That frees about ${fmtBytes(bytes)}.${restore}`)) return;
  const keys = items.map((x) => x.path);
  keys.forEach((k) => SG.busy.add(k));
  sgRender();
  let r = null;
  try { r = await api('/api/storage/remove', 'POST', { paths: keys }); } catch (e) { toast(e.message, { kind: 'error' }); }
  sgAfter(r, keys);
}
const sgRemoveAll = (g) => sgRemove(g.items);
async function sgClean(it) {
  if (!confirm(`Remove ${it.label.toLowerCase()}? That frees about ${fmtBytes(it.bytes)}.\n\nThis can't be undone.`)) return;
  SG.busy.add(it.clean);
  sgRender();
  let r = null;
  try { r = await api('/api/storage/clean', 'POST', { id: it.clean }); } catch (e) { toast(e.message, { kind: 'error' }); }
  if (r) r.removed = [...r.removed, { path: it.clean }];
  sgAfter(r, [it.clean]);
}
