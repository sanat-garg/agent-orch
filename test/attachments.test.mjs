// Composer attachments (uploads.mjs): the store, what agents get (a path note; Claude image blocks; Codex -i), and the
// round trip through server.mjs: POST /api/uploads, GET it back, then a message over the WebSocket that names them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { saveUpload, readUpload, placeUploads, attachmentNote, claudeImageBlocks, safeName, MAX_UPLOAD_BYTES, INLINE_IMAGE_BYTES } from '../uploads.mjs';
import { runAgentCli } from '../agents.mjs';
import { isolatedPath } from './helpers/isolated-path.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (f) => path.join(ROOT, 'test/fixtures', f);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A real w×h RGB PNG (solid colour).
export function png(w = 4, h = 3) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (~c) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x7f);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('safeName keeps a plain file name and nothing that could leave the folder', () => {
  assert.equal(safeName('report Q3.pdf'), 'report Q3.pdf');
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('..\\evil'), '_evil');
  assert.equal(safeName('.env'), 'env');
  assert.equal(safeName('a\u0000b<c>.txt'), 'a_b_c_.txt');
  assert.equal(safeName(''), 'file');
  assert.equal(safeName('x'.repeat(300)).length, 120);
});

test('saveUpload: images are typed from their bytes and shown from the media store; other files keep their type', () => {
  const data = tmp('cw-up-');
  try {
    const img = saveUpload(data, png(40, 30), { name: 'shot.png', type: 'text/html' });
    assert.equal(img.type, 'image/png', 'a claimed type never overrides the bytes');
    assert.deepEqual([img.image.w, img.image.h], [40, 30]);
    assert.ok(fs.existsSync(path.join(data, 'media', img.image.id)));
    const doc = saveUpload(data, Buffer.from('hello'), { name: 'notes.md', type: 'text/markdown' });
    assert.equal(doc.type, 'text/markdown');
    assert.equal(doc.image, undefined);
    assert.equal(readUpload(data, doc.id).name, 'notes.md');
    assert.equal(readUpload(data, '../../x'), null);
    assert.equal(readUpload(data, 'f'.repeat(24)), null);
    assert.equal(saveUpload(data, Buffer.alloc(0), { name: 'x' }).status, 400);
    assert.equal(saveUpload(data, Buffer.alloc(MAX_UPLOAD_BYTES + 1), { name: 'x' }).status, 413);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('placeUploads copies them into the project, git-ignored; the note and Claude image blocks describe them', () => {
  const data = tmp('cw-up-'), project = tmp('cw-up-p-');
  try {
    const img = saveUpload(data, png(), { name: 'mock.png' }), doc = saveUpload(data, Buffer.from('a,b\n1,2\n'), { name: 'data.csv', type: 'text/csv' });
    const files = placeUploads(data, [doc.id, img.id, img.id, 'nope'], project);
    assert.deepEqual(files.map((f) => f.name), ['data.csv', 'mock.png'], 'in order, once each, unknown ids dropped');
    for (const f of files) {
      assert.equal(path.dirname(f.path), path.join(project, '.agent-orch', 'uploads'));
      assert.ok(fs.existsSync(f.path));
    }
    assert.equal(fs.readFileSync(path.join(project, '.agent-orch', 'uploads', '.gitignore'), 'utf8').trim().split('\n').pop(), '*');
    const note = attachmentNote(files);
    assert.match(note, /attached 2 files/);
    assert.ok(note.includes(`- ${files[0].path} (text/csv, 8 B)`) && note.includes(`- ${files[1].path} (image,`), note);
    assert.equal(attachmentNote([]), '');
    const blocks = claudeImageBlocks(files);
    assert.equal(blocks.length, 1);
    assert.deepEqual(Buffer.from(blocks[0].source.data, 'base64'), png());
    assert.equal(blocks[0].source.media_type, 'image/png');
    assert.deepEqual(claudeImageBlocks([{ ...files[1], size: INLINE_IMAGE_BYTES + 1 }]), [], 'too big to inline: read from its path');
  } finally { for (const d of [data, project]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('Codex gets each attached image with -i, on exec and on exec resume', async () => {
  const dir = tmp('cw-up-cx-'), log = path.join(dir, 'argv.json');
  try {
    const run = async (opts) => {
      fs.rmSync(log, { force: true });
      await runAgentCli({ agent: 'codex', bin: fixture('codex-stub.mjs'), prompt: 'look', cwd: dir, env: { ...process.env, CODEX_STUB_LOG: log }, ...opts });
      return JSON.parse(fs.readFileSync(log, 'utf8')).argv;
    };
    const pairs = (argv) => argv.flatMap((a, i) => (a === '-i' ? [argv[i + 1]] : []));
    const argv = await run({ images: ['/p/a.png', '/p/b.jpg'] });
    assert.deepEqual(pairs(argv), ['/p/a.png', '/p/b.jpg']);
    assert.ok(argv.indexOf('-i') < argv.indexOf('--'), 'before the prompt');
    assert.deepEqual(pairs(await run({ images: ['/p/c.png'], resume: 'thread-1' })), ['/p/c.png']);
    assert.deepEqual(pairs(await run({})), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- over the server: a Codex chat (the stub logs what it was run with), no orchestrator.
const PASSWORD = 'attachments-password', CID = 'chat-att';
let child, base, dataDir, home, project, cookie;
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  dataDir = tmp('cw-att-'); home = tmp('cw-att-home-'); project = tmp('cw-att-p-');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ salt, hash: crypto.scryptSync(PASSWORD, salt, 64).toString('hex') }));
  fs.writeFileSync(path.join(dataDir, 'convos.json'), JSON.stringify([{ id: CID, title: 'Attach', cwd: project, mode: 'bypassPermissions', agent: 'codex', model: '',
    createdAt: 1, updatedAt: 1, fullAccess: true }]));
  const bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(fixture('codex-stub.mjs'), path.join(bin, 'codex'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HOME: home, PATH: isolatedPath(bin), PORT: String(port), CW_DATA_DIR: dataDir,
    CW_NO_ORCHESTRATOR: '1', CODEX_STUB_LOG: path.join(home, 'codex-argv.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (out.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await r.arrayBuffer();
});
after(() => {
  child?.kill('SIGKILL');
  for (const d of [dataDir, home, project]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const upload = (buf, name, type, headers = { cookie }) => fetch(base + '/api/uploads', { method: 'POST', body: buf,
  headers: { ...headers, 'content-type': type, 'x-file-name': encodeURIComponent(name) } });

test('POST /api/uploads stores a file; GET serves images inline and everything else as a download', { timeout: 30000 }, async () => {
  const unauth = await upload(png(), 'a.png', 'image/png', {});
  assert.equal(unauth.status, 401); await unauth.arrayBuffer();
  const empty = await upload(Buffer.alloc(0), 'a.txt', 'text/plain');
  assert.equal(empty.status, 400); await empty.arrayBuffer();
  const img = await (await upload(png(8, 6), 'Screen Shot.png', 'image/png')).json();
  assert.match(img.id, /^[a-f0-9]{24}$/);
  assert.deepEqual([img.name, img.type, img.image.w, img.image.h], ['Screen Shot.png', 'image/png', 8, 6]);
  let r = await fetch(`${base}/api/uploads/${img.id}`, { headers: { cookie } });
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('content-disposition'), /^inline;/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), png(8, 6));
  // An HTML file is only ever a download: never rendered by the browser from this origin.
  const html = await (await upload(Buffer.from('<script>alert(1)</script>'), 'x.html', 'text/html')).json();
  r = await fetch(`${base}/api/uploads/${html.id}`, { headers: { cookie } });
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.match(r.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''x\.html$/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  await r.arrayBuffer();
  const anon = await fetch(`${base}/api/uploads/${img.id}`);
  assert.equal(anon.status, 401); await anon.arrayBuffer();
  const missing = await fetch(`${base}/api/uploads/${'0'.repeat(24)}`, { headers: { cookie } });
  assert.equal(missing.status, 404); await missing.arrayBuffer();
});

test('a message with several attachments: copied into the project, logged with the message, and passed to the agent', { timeout: 60000 }, async () => {
  const img1 = await (await upload(png(10, 10), 'ui.png', 'image/png')).json();
  const img2 = await (await upload(png(12, 9), 'error.png', 'image/png')).json();
  const doc = await (await upload(Buffer.from('# Spec\nMake it blue.\n'), 'spec.md', 'text/markdown')).json();
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const events = [];
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.cid === CID) events.push(m); });
  ws.send(JSON.stringify({ t: 'open', cid: CID }));
  // Text plus three files, then files alone (no text).
  ws.send(JSON.stringify({ t: 'send', cid: CID, text: 'Match the mockup and fix the error', attachments: [img1.id, doc.id, img2.id] }));
  const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 100)); };
  await until(() => events.some((e) => e.t === 'result'));
  const argv = JSON.parse(fs.readFileSync(path.join(home, 'codex-argv.json'), 'utf8')).argv;
  const user = events.find((e) => e.t === 'user');
  ws.send(JSON.stringify({ t: 'send', cid: CID, text: '', attachments: [doc.id] }));
  await until(() => events.filter((e) => e.t === 'user').length === 2);
  ws.send(JSON.stringify({ t: 'send', cid: CID, text: '   ' })); // nothing to send: ignored
  ws.close();

  const placed = path.join(project, '.agent-orch', 'uploads');
  const onDisk = fs.readdirSync(placed).sort();
  assert.deepEqual(onDisk, ['.gitignore', `${doc.id.slice(0, 8)}-spec.md`, `${img1.id.slice(0, 8)}-ui.png`, `${img2.id.slice(0, 8)}-error.png`].sort());
  assert.equal(user.text, 'Match the mockup and fix the error', 'the log keeps the owner\'s words; the note is for the agent');
  assert.deepEqual(user.attachments.map((a) => [a.name, !!a.image]), [['ui.png', true], ['spec.md', false], ['error.png', true]]);
  assert.ok(user.attachments.every((a) => a.path.startsWith(placed)));
  const images = argv.flatMap((a, i) => (a === '-i' ? [argv[i + 1]] : []));
  assert.deepEqual(images, [path.join(placed, `${img1.id.slice(0, 8)}-ui.png`), path.join(placed, `${img2.id.slice(0, 8)}-error.png`)]);
  const prompt = argv.at(-1);
  assert.match(prompt, /Match the mockup and fix the error/);
  assert.ok(prompt.includes(path.join(placed, `${doc.id.slice(0, 8)}-spec.md`)), 'the markdown file is named by its path');
  const second = events.filter((e) => e.t === 'user')[1];
  assert.deepEqual([second.text, second.attachments.map((a) => a.name)], ['', ['spec.md']]);
  assert.equal(events.filter((e) => e.t === 'user').length, 2);
  // The log on disk keeps them for replay.
  const logged = fs.readFileSync(path.join(dataDir, 'logs', `${CID}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.t === 'user');
  assert.equal(logged[0].attachments.length, 3);
});

// ---- in a real browser (skipped when Playwright's Chromium can't launch)
const { chromium } = await import('playwright-core');
let browser = null, noBrowser = false;
try { browser = await chromium.launch(); } catch (e) { noBrowser = `cached Chromium unavailable: ${e.message.split('\n')[0]}`; }
after(async () => { await browser?.close(); });

async function page(viewport = { width: 1280, height: 860 }, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  await p.goto(`${base}/#${CID}`);
  await p.waitForFunction(() => !document.getElementById('app').inert, null, { timeout: 15000 }).catch(() => p.click('#splashSkip'));
  return p;
}

test('composer: the paperclip, paste and drop add several attachments; each uploads, can be removed, and goes with the message', { skip: noBrowser, timeout: 90000 }, async () => {
  const p = await page();
  const dir = tmp('cw-att-ui-');
  try {
    const files = { 'mock.png': png(60, 40), 'bug.png': png(30, 30), 'notes.txt': Buffer.from('keep the header'), 'drop.csv': Buffer.from('a,b\n') };
    for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
    // The paperclip opens a multi-file picker.
    const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('#attBtn')]);
    assert.equal(chooser.isMultiple(), true);
    await chooser.setFiles(['mock.png', 'bug.png', 'notes.txt'].map((n) => path.join(dir, n)));
    await p.waitForFunction(() => document.querySelectorAll('#attTray .att-item.ready').length === 3);
    assert.equal(await p.locator('#attTray .att-item.img img').count(), 2);
    assert.match(await p.locator('#attTray .att-item.file').textContent(), /notes\.txt/);
    // Pasting a copied image attaches it (as a named file); pasting text doesn't.
    await p.evaluate(async () => {
      const dt = new DataTransfer();
      const b = await (await fetch('data:image/png;base64,' + btoa(String.fromCharCode(...new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]))))).blob();
      dt.items.add(new File([b], 'image.png', { type: 'image/png' }));
      document.getElementById('input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      const t = new DataTransfer();
      t.setData('text/plain', 'just text');
      document.getElementById('input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: t, bubbles: true, cancelable: true }));
    });
    await p.waitForFunction(() => document.querySelectorAll('#attTray .att-item').length === 4);
    assert.match(await p.locator('#attTray .att-item').nth(3).getAttribute('title'), /^pasted-.*\.png/);
    // Dropping a file on the chat attaches it; the veil shows while dragging.
    const dropped = await p.evaluate((csv) => {
      const dt = new DataTransfer();
      dt.items.add(new File([csv], 'drop.csv', { type: 'text/csv' }));
      const view = document.getElementById('chatView');
      view.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const shown = !document.getElementById('dropZone').hidden;
      view.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return { shown, hidden: document.getElementById('dropZone').hidden };
    }, 'a,b\n');
    assert.deepEqual(dropped, { shown: true, hidden: true });
    await p.waitForFunction(() => document.querySelectorAll('#attTray .att-item.ready').length === 5);
    // Remove the pasted one; the send button works with attachments even before any text.
    await p.locator('#attTray .att-item').nth(3).locator('.att-x').click();
    assert.equal(await p.locator('#attTray .att-item').count(), 4);
    assert.equal(await p.locator('#send').isDisabled(), false);
    await p.fill('#input', 'Use these');
    await p.click('#send');
    await p.waitForFunction(() => [...document.querySelectorAll('#messages .msg.user')].some((m) => m.textContent.startsWith('Use these')));
    assert.equal(await p.locator('#attTray').isHidden(), true, 'the tray empties once sent');
    const bubble = p.locator('#messages .msg.user.has-atts').last();
    assert.equal(await bubble.locator('.shot img').count(), 2);
    assert.deepEqual(await bubble.locator('.att-file .att-name').allTextContents(), ['notes.txt', 'drop.csv']);
    const href = await bubble.locator('.att-file').first().getAttribute('href');
    assert.match(href, /^\/api\/uploads\/[a-f0-9]{24}$/);
    await p.waitForFunction(() => document.querySelector('#send:not(.stop)'));
    const argv = JSON.parse(fs.readFileSync(path.join(home, 'codex-argv.json'), 'utf8')).argv;
    assert.equal(argv.filter((a) => a === '-i').length, 2, 'both pictures went to Codex');
    assert.match(argv.at(-1), /notes\.txt/);
    // Opening an attached picture uses the lightbox.
    await bubble.locator('.shot button').first().click();
    await p.locator('#lightbox').waitFor();
    assert.deepEqual(p.errors, []);
  } finally {
    await p.context().close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('390px: the tray and the paperclip fit; no sideways scroll', { skip: noBrowser, timeout: 60000 }, async () => {
  const p = await page({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  try {
    await p.evaluate(() => addAttachments([1, 2, 3].map((i) => new File([new Uint8Array(2048)], `long-file-name-number-${i}-for-the-tray.pdf`, { type: 'application/pdf' }))));
    await p.waitForFunction(() => document.querySelectorAll('#attTray .att-item.ready').length === 3);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const sel of ['#attBtn', '#attTray']) {
      const b = await p.locator(sel).boundingBox();
      assert.ok(b.x >= 0 && b.x + b.width <= 390, `${sel}: ${JSON.stringify(b)}`);
    }
    assert.deepEqual(p.errors, []);
  } finally { await p.context().close(); }
});
