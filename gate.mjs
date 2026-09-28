// The approval gate (AGENTIC.md → Safety): every MCP tool call of a browser or connector run is classified read / draft /
// outbound (for the audit log) and judged against the owner's "Don't allow" rules (judge below): everything runs without
// asking except a call a rule matches (or a connector tool marked outbound), held for the owner BEFORE it executes; every
// call is audited. The enforcing piece is
// gate-proxy.mjs, a stdio MCP proxy wrapped around the Playwright MCP (and any MCP server marked as a connector); Claude
// runs on the controller also ask it from a PreToolUse permission hook (agents.mjs), so a held call never reaches the CLI's
// dispatcher. The proxy talks to its host (the orchestrator, or the worker that relays to the head) through files in a
// per-run gate dir: approvals/<id>.json asked, approvals/<id>.answer.json answered; checks/ the same for the hook; and
// audit.jsonl + shots/<sha256>.<ext> written by the proxy, tailed by the host. Files keep a worker free of listeners.
// Browser steps classified outbound: file uploads (any local file can reach the page; the "always" key hashes the
// paths), clicks and drags by coordinates (the target is unknown; no "always"), and navigating to javascript:/data:/blob:/
// vbscript: (code in the page; no "always") or to file:/chrome: and local or private hosts. browser_press_key's "always"
// key names the focused element, so one approved Enter doesn't cover Enter in every other field.
// Worker-safe: node built-ins only (test/compute-only.test.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CLASSES = ['read', 'draft', 'outbound'];
export const APPROVAL_TTL_MS = 24 * 3600_000; // an unanswered approval is denied after this
// Accessible names that make a browser step's class outbound (whole words, any case). They no longer hold anything by
// themselves: Settings → Browser shows them as suggestions for "Don't allow" rules.
export const DEFAULT_PATTERNS = ['Send', 'Pay', 'Transfer', 'Submit order', 'Publish', 'Share', 'Delete', 'Confirm', 'Place order', 'Sign',
  'Post', 'Reply', 'Submit', 'Buy', 'Order', 'Checkout', 'Tweet', 'Save & send'];
// Everyday names the default verbs would otherwise catch ("Sign in" is not signing anything, "Order history" orders nothing).
const BENIGN_RE = new RegExp('^\\s*(?:(?:sign|log)\\s*(?:-\\s*)?(?:in|up|out|on)\\b' +
  '|(?:(?:view|track|see|show|your|my|all|recent|past|previous)\\s+)*(?:orders|posts|replies|(?:order|checkout|post|reply|purchase)\\s+(?:history|details|status|number|tracking))\\s*(?:\\(\\d+\\))?\\s*$' +
  '|(?:view|track|see)\\s+(?:your\\s+|my\\s+|this\\s+)?(?:order|post|reply)\\s*$)', 'i');
// Navigating to (or clicking a link to) one of these is outbound: checkout, payment, billing, place-order pages.
export const CHECKOUT_URL_RE = /(^|[/._?=&#-])(checkout|payments?|pay|billing|purchase|place-?order|order-?confirm\w*)([/._?=&#-]|$)/i;

// Playwright MCP tools by class. Element tools resolve their target in a fresh snapshot; anything not listed is outbound.
const BROWSER_READ = new Set(['browser_snapshot', 'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests',
  'browser_network_request', 'browser_wait_for', 'browser_hover', 'browser_resize', 'browser_find', 'browser_emulate_media',
  'browser_install', 'browser_close', 'browser_generate_locator', 'browser_verify_element_visible', 'browser_verify_text_visible',
  'browser_verify_list_visible', 'browser_verify_value', 'browser_pdf_save', 'browser_mouse_move_xy']);
const BROWSER_DRAFT = new Set(['browser_navigate', 'browser_navigate_back', 'browser_navigate_forward', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_drag', 'browser_drop', 'browser_handle_dialog', 'browser_tabs']);
// Outbound whatever the page shows: the target of a coordinate click or drag is unknown.
const XY_TOOLS = new Set(['browser_mouse_click_xy', 'browser_mouse_drag_xy']);
const ELEMENT_TOOLS = new Set(['browser_click', 'browser_type', 'browser_select_option', 'browser_drag', 'browser_handle_dialog']);
export const isBrowserRead = (tool) => BROWSER_READ.has(tool);
// Connector tools with no explicit marking: names like send_email, create_payment, delete_file, publish_design, share_doc.
const OUTBOUND_TOOL_RE = /(^|[_.-])(send|reply|forward|pay|payments?|transfer|delete|remove|trash|purge|publish|post|share|permissions?|invite|submit|approve|authori[sz]e|void|sign)([_.-]|$)/i;
const DRAFT_TOOL_RE = /(^|[_.-])(create|update|draft|add|edit|write|label|archive|move|copy|upload|set|insert|append|modify|rename)([_.-]|$)/i;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A pattern: a phrase (whole words, any case, any spacing) or a /regex/ the owner typed.
export function patternRe(p) {
  const s = String(p || '').trim();
  const m = /^\/(.+)\/([a-z]*)$/.exec(s);
  if (m) { try { return new RegExp(m[1], m[2].replace(/[gy]/g, '') || 'i'); } catch { return null; } }
  if (!s) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${s.split(/\s+/).map(esc).join('[\\s_-]+')}(?![\\p{L}\\p{N}])`, 'iu');
}
// The first pattern `text` matches, or null.
export function matchPattern(text, patterns = DEFAULT_PATTERNS) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const p of patterns) {
    const re = patternRe(p);
    if (re && re.test(t) && !(DEFAULT_PATTERNS.includes(p) && BENIGN_RE.test(t))) return p;
  }
  return null;
}
// Extra phrases on top of the defaults, deduped (classify's ctx.patterns).
export const patternsWith = (extra) => [...new Set([...DEFAULT_PATTERNS, ...(Array.isArray(extra) ? extra : []).map((x) => String(x).trim()).filter(Boolean)])];

const unq = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };
// A Playwright MCP snapshot (the text of browser_snapshot, or any result that inlines one) → {url, title, dialog, refs:
// Map ref → {ref, role, name, value?, url?, active?}}. Nameless elements take their text children as the name; `active` is
// the focused element (Playwright marks it [active]).
export function parseSnapshot(text) {
  const s = String(text || ''), out = { url: null, title: null, dialog: null, refs: new Map() };
  out.url = /- Page URL: (\S+)/.exec(s)?.[1] || null;
  out.title = /- Page Title: (.*)/.exec(s)?.[1]?.trim() || null;
  out.dialog = unq(/dialog with message "((?:[^"\\]|\\.)*)"/.exec(s)?.[1] ?? '') || null;
  let last = null;
  for (const line of s.split('\n')) {
    const m = /^(\s*)- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?([^\n]*?)\[ref=([^\]\s]+)\](.*)$/.exec(line);
    if (m) {
      const [, ind, role, name, attrs, ref, rest] = m;
      const value = /^(?:\s*\[[^\]]*\])*:\s+(.+)$/.exec(rest)?.[1];
      last = { ref, role, name: name != null ? unq(name) : '', indent: ind.length, ...(value != null && { value: unq(value.trim().replace(/^"|"$/g, '')) }),
        ...(/\[active\]/.test(attrs) && { active: true }) };
      out.refs.set(ref, last);
      continue;
    }
    if (!last) continue;
    const ind = /^(\s*)/.exec(line)[1].length;
    if (ind <= last.indent) { last = null; continue; }
    const u = /^\s*- \/url: (.+)$/.exec(line);
    if (u) { last.url = u[1].trim(); continue; }
    const t = /^\s*- text: (.+)$/.exec(line);
    if (t && !last.name) last.name = unq(t[1].trim().replace(/^"|"$/g, ''));
  }
  return out;
}
// The text parts of an MCP tool result (content blocks, or whatever an SDK hook hands over).
export function resultText(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (Array.isArray(r)) return r.map(resultText).filter(Boolean).join('\n');
  if (typeof r === 'object') return r.type === 'text' ? String(r.text || '') : resultText(r.content ?? (r.type ? null : r.result ?? null));
  return '';
}
const hostOf = (u) => { try { const x = new URL(u); return x.host + (x.pathname === '/' ? '' : x.pathname); } catch { return String(u || '').slice(0, 120); } };
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
// Filled-in fields on the page, for the approval text ('To: bob@…, Subject: Invoice').
function fieldsOf(snap, n = 4) {
  return [...snap.refs.values()].filter((e) => /^(textbox|combobox|searchbox|spinbutton)$/.test(e.role) && e.name && e.value && !SENSITIVE_NAME_RE.test(e.name))
    .slice(0, n).map((e) => `${e.name}: ${clip(e.value, 60)}`);
}
const targetOf = (args) => args?.target ?? args?.ref ?? null;
// Keys that submit the focused field (Enter sends in Slack, WhatsApp and LinkedIn; Ctrl/Cmd+Enter sends in Gmail).
const SUBMIT_KEY_RE = /^(?:(?:control|ctrl|meta|cmd|command|controlormeta)\+)?(?:numpad)?enter$/i;
const TEXT_FIELD_RE = /^(textbox|combobox|searchbox)$/;
// A field where submitting only searches or filters the page.
const isSearchField = (e) => e?.role === 'searchbox' || /search|filter|find/i.test(e?.name || '');

// Arbitrary-code browser tools: no "always" covers them, since the next call's code can do anything.
const CODE_TOOL_RE = /evaluate|run_code|execute/i;
// URL schemes that run code in the page (like browser_evaluate), and ones that open the machine's own files or browser.
const CODE_SCHEMES = new Set(['javascript:', 'data:', 'blob:', 'vbscript:']);
const LOCAL_SCHEMES = new Set(['file:', 'chrome:', 'chrome-extension:', 'chrome-untrusted:', 'devtools:', 'view-source:']);
// A url's scheme as the browser reads it (leading spaces and embedded tabs/newlines stripped), lowercased.
const schemeOf = (u) => { try { return new URL(String(u || '')).protocol; } catch { return /^([a-z][a-z0-9+.-]*:)/i.exec(String(u || '').replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+/, ''))?.[1].toLowerCase() || ''; } };
// Connector args that say who or what a call reaches; their values go into the "always" key.
const RECIPIENT_ARG_RE = /^(to|cc|bcc|recipient|recipients|email|channel|chat|phone|number|account|payee|url|path|id)s?$/i;
// A url's host is loopback, link-local or private (a bare hostname like `caddy` counts): the controller's ttyd, app and
// Caddy admin API live there (AUDIT #41). Element urls resolve against a public dummy base, so relative links never match.
export function isLocalUrl(u, { base } = {}) {
  let h;
  try { h = new URL(String(u || ''), base).hostname; } catch {}
  if (!h && !base) try { h = new URL(`http://${u}`).hostname; } catch {}
  h = String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.includes(':')) {
    const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (m) { const a = parseInt(m[1], 16), b = parseInt(m[2], 16); h = [a >> 8, a & 255, b >> 8, b & 255].join('.'); } else {
      return h === '::1' || h === '::' || /^fe[89ab][0-9a-f]:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h);
    }
  }
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    return a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return !h.includes('.');
}

// Classifies one call. ctx: {server, kind: 'browser' | 'connector', snapshot (parseSnapshot, fresh), patterns,
// connector: {outbound: [names], read: [names], draft: [names]}}. Returns {cls, reason, action (what the owner reads),
// key (the "always allow" identity: null for arbitrary-code tools, coordinate clicks and code urls, so no "always" covers
// them; a connector's includes a hash of its recipient-like args, an upload's a hash of its paths), target?, url?}.
// Navigating to (or clicking a link to) a local or private host is outbound.
export function classify(tool, args = {}, ctx = {}) {
  const { server = 'mcp', kind = 'browser', patterns = DEFAULT_PATTERNS } = ctx;
  const snap = ctx.snapshot || { url: null, refs: new Map(), dialog: null };
  const url = snap.url;
  const where = url ? ` on ${hostOf(url)}` : '';
  if (kind !== 'browser') {
    const c = ctx.connector || {}, has = (list) => Array.isArray(list) && list.some((x) => x === tool || (x.endsWith('*') && tool.startsWith(x.slice(0, -1))));
    const summary = clip(Object.entries(redact(args)).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', '), 300);
    const who = Object.keys(args || {}).filter((k) => RECIPIENT_ARG_RE.test(k)).sort().map((k) => [k, args[k]]);
    const base = { action: `${server}: ${tool}${summary ? ` (${summary})` : ''}`, key: `${server}|${tool}${who.length ? `|${sha(JSON.stringify(who)).slice(0, 8)}` : ''}` };
    if (has(c.outbound)) return { cls: 'outbound', reason: 'marked outbound', ...base };
    if (has(c.read)) return { cls: 'read', reason: 'marked read', ...base };
    if (has(c.draft)) return { cls: 'draft', reason: 'marked draft', ...base };
    if (OUTBOUND_TOOL_RE.test(tool)) return { cls: 'outbound', reason: 'outbound verb in the tool name', ...base };
    return { cls: DRAFT_TOOL_RE.test(tool) ? 'draft' : 'read', reason: 'tool name', ...base };
  }
  const key = (...parts) => [server, tool, ...parts].map((x) => String(x ?? '').toLowerCase().trim()).join('|');
  if (BROWSER_READ.has(tool)) return { cls: 'read', reason: 'reads the page', action: `${tool.replace(/^browser_/, '')}${where}`, key: key() };
  if (tool === 'browser_navigate') {
    const to = String(args.url || ''), scheme = schemeOf(to);
    if (CODE_SCHEMES.has(scheme)) return { cls: 'outbound', reason: 'runs code in the page', action: `Open ${clip(to, 200)}`, key: null, url: to };
    if (LOCAL_SCHEMES.has(scheme)) return { cls: 'outbound', reason: 'opens a local or private service', action: `Open ${clip(to, 200)}`, key: key(hostOf(to)), url: to };
    const hit = CHECKOUT_URL_RE.test(safePath(to)), local = !hit && isLocalUrl(to);
    return { cls: hit || local ? 'outbound' : 'draft', reason: hit ? 'opens a checkout/payment page' : local ? 'opens a local or private service' : 'navigation', action: `Open ${clip(to, 200)}`, key: key(hostOf(to)), url: to };
  }
  if (tool === 'browser_file_upload') {
    const paths = (Array.isArray(args.paths) ? args.paths : args.paths != null ? [args.paths] : []).map(String);
    return { cls: 'outbound', reason: 'uploads local files', action: `Upload ${paths.length ? clip(paths.join(', '), 200) : 'nothing (cancel the file chooser)'}${where}`,
      key: key(sha(JSON.stringify([...paths].sort()))) };
  }
  if (XY_TOOLS.has(tool)) {
    const at = tool === 'browser_mouse_drag_xy' ? ` from (${args.startX}, ${args.startY}) to (${args.endX}, ${args.endY})` : ` at (${args.x}, ${args.y})`;
    return { cls: 'outbound', reason: 'clicks by coordinates, target unknown', action: `${tool === 'browser_mouse_drag_xy' ? 'Drag' : 'Click'}${at}${where}`, key: null };
  }
  if (tool === 'browser_handle_dialog') {
    const msg = snap.dialog || '', hit = args.accept !== false ? matchPattern(msg, patterns) : null;
    return { cls: hit ? 'outbound' : 'draft', reason: hit ? `dialog matches "${hit}"` : 'dialog', action: `${args.accept === false ? 'Dismiss' : 'Accept'} the dialog${msg ? ` "${clip(msg, 120)}"` : ''}${where}`, key: key(msg) };
  }
  if (ELEMENT_TOOLS.has(tool)) {
    const targets = tool === 'browser_drag' ? [args.startTarget ?? args.startRef, args.endTarget ?? args.endRef] : [targetOf(args)];
    const els = targets.filter((t) => t != null).map((t) => snap.refs.get(String(t)) || { ref: String(t), role: 'element', name: '', selector: String(t) });
    const el = els[0] || { role: 'element', name: '' };
    const label = el.name || el.selector || args.element || 'element';
    const verb = { browser_click: 'Click', browser_type: 'Type into', browser_select_option: 'Choose in', browser_drag: 'Drag' }[tool] || tool;
    const fields = fieldsOf(snap);
    const typed = tool === 'browser_type' ? ` "${clip(SENSITIVE_NAME_RE.test(el.name || '') ? '••••' : args.text, 80)}"${args.submit ? ' and submit' : ''}` : '';
    const action = `${verb} "${clip(label, 80)}"${el.role && el.role !== 'element' ? ` ${el.role}` : ''}${typed}${where}${fields.length && tool === 'browser_click' ? ` · ${fields.join(', ')}` : ''}`;
    const k = key(el.role, el.name || el.selector || args.element, url ? hostOf(url).split('/')[0] : '');
    // The element's own accessible name, a selector the agent passed, and the agent's description of it all count.
    const hit = els.map((e) => matchPattern(e.name, patterns) || matchPattern(e.selector, patterns)).find(Boolean)
      || (tool !== 'browser_type' || args.submit ? matchPattern(args.element, patterns) : null);
    if (hit && (tool === 'browser_click' || tool === 'browser_drag' || (tool === 'browser_type' && args.submit))) {
      return { cls: 'outbound', reason: `target matches "${hit}"`, action, key: k, target: pick(el) };
    }
    if (tool === 'browser_type' && args.submit && !isSearchField(el)) return { cls: 'outbound', reason: 'submits the field', action, key: k, target: pick(el) };
    // An icon-only button: only the agent's own description says what it does.
    if (tool === 'browser_click' && els.some((e) => e.role === 'button' && !e.name && !e.selector && !e.url)) {
      return { cls: 'outbound', reason: 'button with no accessible name', action, key: k, target: pick(el) };
    }
    if (tool === 'browser_click' && els.some((e) => e.url && CHECKOUT_URL_RE.test(safePath(e.url)))) {
      return { cls: 'outbound', reason: 'links to a checkout/payment page', action, key: k, target: pick(el) };
    }
    if (tool === 'browser_click' && els.some((e) => e.url && isLocalUrl(e.url, { base: 'https://page.invalid/' }))) {
      return { cls: 'outbound', reason: 'opens a local or private service', action, key: k, target: pick(el) };
    }
    return { cls: 'draft', reason: 'page interaction', action, key: k, target: pick(el) };
  }
  if (tool === 'browser_press_key') {
    const focus = [...snap.refs.values()].find((e) => e.active);
    const inField = focus && TEXT_FIELD_RE.test(focus.role) && !isSearchField(focus);
    const hit = focus && !TEXT_FIELD_RE.test(focus.role) ? matchPattern(focus.name, patterns) : null;
    const submits = SUBMIT_KEY_RE.test(String(args.key || '').replace(/\s+/g, '')) && (inField || hit || !snap.refs.size);
    const action = `press key ${args.key}${focus?.name ? ` in "${clip(focus.name, 80)}" ${focus.role}` : ''}${where}`;
    return { cls: submits ? 'outbound' : 'draft', reason: !submits ? 'page interaction' : hit ? `focused element matches "${hit}"` : 'may submit the focused field',
      action, key: key(args.key, focus?.role || 'none', focus ? focus.name || 'none' : 'none', url ? hostOf(url).split('/')[0] : ''), ...(focus && { target: pick(focus) }) };
  }
  if (BROWSER_DRAFT.has(tool)) {
    const detail = tool === 'browser_fill_form' ? ` (${(args.fields || []).length} fields)` : '';
    return { cls: 'draft', reason: 'page interaction', action: `${tool.replace(/^browser_/, '').replace(/_/g, ' ')}${detail}${where}`, key: key(args.key) };
  }
  // browser_evaluate, browser_run_code_unsafe and anything new: arbitrary effects, so the owner decides.
  const code = args.function ?? args.code, isCode = CODE_TOOL_RE.test(tool);
  return { cls: 'outbound', reason: 'unrecognised or arbitrary-code browser tool', action: `${tool.replace(/^browser_/, '').replace(/_/g, ' ')}${where}${code ? `: ${isCode ? String(code).slice(0, 120) : clip(code, 200)}` : ''}`,
    key: isCode ? null : key(url ? hostOf(url).split('/')[0] : '') };
}
const pick = (e) => (e ? { role: e.role, name: e.name || e.selector || '', ...(e.ref && { ref: e.ref }) } : undefined);
const safePath = (u) => { try { const x = new URL(u, 'http://x'); return `${x.pathname}${x.search}${x.hash}`; } catch { return String(u || ''); } };

// ---- the owner's "Don't allow" rules (Settings → Browser, kv gate_settings.rules): everything runs without asking except
// a call a rule matches, which is held for approval. One rule per line: a domain or URL (bank.example.com, *.shop.com,
// example.com/admin: the target or page URL's host, and path prefix), a line naming action kinds ('payments and checkout',
// 'send email': ACTION_KINDS below, as judge() infers them from the call), else a phrase matched case-insensitively in
// the element's accessible name (or the agent's description of it), the page title or the URL (a connector: its tool name).
export const ACTION_KINDS = ['send', 'pay', 'delete', 'publish', 'share', 'submit', 'upload', 'download', 'login'];
// Words in a rule line → kinds.
const RULE_KIND_RE = {
  send: /\b(send|sending|sends|reply|replies|replying|forward|forwarding)\b/i,
  pay: /\b(pay|pays|paying|payments?|checkouts?|check\s*out|purchases?|purchasing|buy|buying|orders?|ordering|transfers?|billing|money)\b/i,
  delete: /\b(delete|deletes|deleting|deletion|remove|removing|trash|erase|erasing)\b/i,
  publish: /\b(publish|publishing|post|posts|posting|tweet|tweets|tweeting|social\s+media)\b/i,
  share: /\b(share|shares|sharing|invite|invites|inviting)\b/i,
  submit: /\b(submit|submits|submitting|submissions?)\b/i,
  upload: /\b(upload|uploads|uploading)\b/i,
  download: /\b(download|downloads|downloading)\b/i,
  login: /\b(login|logins|log\s*in|logging\s+in|sign\s*in|signing\s+in|credentials?|passwords?)\b/i,
};
// Words in an element's name (or a connector tool's) → the kinds of action it performs.
const ACT_KIND_RE = {
  send: /(?<![\p{L}\p{N}])(send|reply|reply all|forward)(?![\p{L}\p{N}])/iu,
  pay: /(?<![\p{L}\p{N}])(pay|pay now|payment|checkout|check out|purchase|buy|buy now|place order|order now|submit order|complete order|transfer|subscribe|donate|charge)(?![\p{L}\p{N}])/iu,
  delete: /(?<![\p{L}\p{N}])(delete|remove|trash|discard|erase|purge|destroy)(?![\p{L}\p{N}])/iu,
  publish: /(?<![\p{L}\p{N}])(publish|post|tweet|repost|retweet|go live)(?![\p{L}\p{N}])/iu,
  share: /(?<![\p{L}\p{N}])(share|invite|permissions?|grant access)(?![\p{L}\p{N}])/iu,
  submit: /(?<![\p{L}\p{N}])(submit|confirm|place order|apply)(?![\p{L}\p{N}])/iu,
  upload: /(?<![\p{L}\p{N}])(upload|attach)(?![\p{L}\p{N}])/iu,
  download: /(?<![\p{L}\p{N}])(download|export)(?![\p{L}\p{N}])/iu,
  login: /(?<![\p{L}\p{N}])(log ?in|sign ?in|login|signin|password|credentials?|authorize|authorise)(?![\p{L}\p{N}])/iu,
};
const kindsIn = (text, table) => { const t = String(text || '').replace(/[_.-]+/g, ' '); return ACTION_KINDS.filter((k) => table[k].test(t)); };
const LOGIN_URL_RE = /(^|[/._?=&#-])(login|log-?in|sign-?in|signin|auth|oauth2?|sso)([/._?=&#-]|$)/i;
const MESSAGE_FIELD_RE = /message|reply|compose|body|chat|comment|write|post/i;
// One rule line → {text, type: 'url'|'kinds'|'phrase', host?, path?, glob?, kinds?, phrase?}, or null for a blank line.
export function parseRule(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  if (!/\s/.test(text)) {
    const u = /^(?:[a-z][a-z0-9+.-]*:\/\/)?((?:\*\.)?(?:[a-z0-9-]+\.)+(?:[a-z]{2,}|\d+)|localhost)(?::\d+)?(\/[^\s]*)?$/i.exec(text);
    if (u && !u[2]?.includes('*')) return { text, type: 'url', host: u[1].toLowerCase().replace(/^\*\./, ''), path: u[2] && u[2] !== '/' ? u[2] : null };
    if (/[/*]/.test(text)) return { text, type: 'url', glob: new RegExp(`^${text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('*').map(esc).join('.*')}`, 'i') };
  }
  const kinds = kindsIn(text, RULE_KIND_RE);
  if (kinds.length) return { text, type: 'kinds', kinds };
  return { text, type: 'phrase', phrase: text.toLowerCase() };
}
export const parseRules = (lines) => (Array.isArray(lines) ? lines : String(lines || '').split('\n')).map((r) => (r && typeof r === 'object' ? r : parseRule(r))).filter(Boolean);
const urlParts = (u) => { try { const x = new URL(String(u)); return { host: x.hostname.toLowerCase().replace(/\.$/, ''), path: x.pathname, bare: `${x.host}${x.pathname}${x.search}` }; } catch { return null; } };
// The first rule the facts {kinds, urls, names, title, unknown} match, or null. unknown: the call's target can't be told
// (a coordinate click, arbitrary code, an unreadable page), so any kind or phrase rule holds it.
export function matchRule(rules, f) {
  for (const r of parseRules(rules)) {
    if (r.type === 'url') {
      const hit = (f.urls || []).some((u) => {
        const p = urlParts(u);
        if (!p) return false;
        if (r.glob) return r.glob.test(p.bare);
        return (p.host === r.host || p.host.endsWith(`.${r.host}`)) && (!r.path || p.path.toLowerCase().startsWith(r.path.toLowerCase()));
      });
      if (hit) return r;
    } else if (f.unknown) return r;
    else if (r.type === 'kinds') { if (r.kinds.some((k) => f.kinds?.includes(k))) return r; }
    else if ([...(f.names || []), f.title, ...(f.urls || [])].some((s) => s && String(s).toLowerCase().includes(r.phrase))) return r;
  }
  return null;
}
// What a call is, for the rules: {kinds, urls, names, title, unknown}. c is classify()'s verdict for it.
export function factsOf(tool, args = {}, c = {}, ctx = {}) {
  const snap = ctx.snapshot || { url: null, title: null, refs: new Map(), dialog: null };
  if ((ctx.kind || 'browser') !== 'browser') {
    const urls = Object.values(args || {}).filter((v) => typeof v === 'string' && /^https?:\/\//i.test(v));
    return { kinds: kindsIn(tool, ACT_KIND_RE), urls, names: [tool, c.action] };
  }
  const page = snap.url ? [snap.url] : [], title = snap.title;
  if (tool === 'browser_navigate') {
    const to = String(args.url || '');
    return { kinds: [...(CHECKOUT_URL_RE.test(safePath(to)) ? ['pay'] : []), ...(LOGIN_URL_RE.test(safePath(to)) ? ['login'] : [])], urls: [to], names: [] };
  }
  if (tool === 'browser_file_upload') return { kinds: ['upload'], urls: page, names: [], title };
  if (XY_TOOLS.has(tool) || c.reason === 'unrecognised or arbitrary-code browser tool') return { kinds: [], urls: page, names: [], title, unknown: true };
  if (tool === 'browser_handle_dialog') {
    return { kinds: args.accept !== false ? kindsIn(snap.dialog, ACT_KIND_RE) : [], urls: page, names: [snap.dialog], title };
  }
  if (tool === 'browser_press_key') {
    const focus = [...snap.refs.values()].find((e) => e.active);
    const submits = SUBMIT_KEY_RE.test(String(args.key || '').replace(/\s+/g, '')) && (!focus || !isSearchField(focus));
    const kinds = !submits ? [] : focus && !TEXT_FIELD_RE.test(focus.role) ? kindsIn(focus.name, ACT_KIND_RE)
      : ['submit', ...(MESSAGE_FIELD_RE.test(focus?.name || '') ? ['send'] : [])];
    return { kinds, urls: page, names: focus ? [focus.name] : [], title };
  }
  if (ELEMENT_TOOLS.has(tool) || tool === 'browser_fill_form') {
    const targets = tool === 'browser_drag' ? [args.startTarget ?? args.startRef, args.endTarget ?? args.endRef]
      : tool === 'browser_fill_form' ? (args.fields || []).map(targetOf) : [targetOf(args)];
    const els = targets.filter((t) => t != null).map((t) => snap.refs.get(String(t)) || { name: '', selector: String(t) });
    const names = [...els.flatMap((e) => [e.name, e.selector]), args.element, ...(tool === 'browser_fill_form' ? (args.fields || []).map((x) => x?.name) : [])].filter(Boolean);
    const links = els.map((e) => e.url).filter(Boolean).map((u) => { try { return new URL(u, snap.url || undefined).href; } catch { return u; } });
    const kinds = new Set();
    const acts = tool === 'browser_click' || tool === 'browser_drag' || (tool === 'browser_type' && args.submit);
    if (acts) for (const k of kindsIn(names.join(' · '), ACT_KIND_RE)) kinds.add(k);
    if (tool === 'browser_click' && links.some((u) => CHECKOUT_URL_RE.test(safePath(u)))) kinds.add('pay');
    if (tool === 'browser_type' && args.submit && !isSearchField(els[0])) { kinds.add('submit'); if (MESSAGE_FIELD_RE.test(els[0]?.name || '')) kinds.add('send'); }
    if ((tool === 'browser_type' || tool === 'browser_fill_form') && els.some((e) => SENSITIVE_NAME_RE.test(e.name || ''))) kinds.add('login');
    if (tool === 'browser_click' && els.some((e) => e.role === 'button' && !e.name && !e.selector && !e.url) && !args.element) return { kinds: [], urls: page, names, title, unknown: true };
    return { kinds: [...kinds], urls: [...page, ...links], names, title };
  }
  return { kinds: [], urls: page, names: [], title };
}
// classify() plus the owner's rules (ctx.rules: lines or parseRules()): → {...classify, hold, rule?}. Reads never hold; a
// connector tool the owner marked outbound always does; anything else only when a rule matches.
export function judge(tool, args = {}, ctx = {}) {
  const c = classify(tool, args, ctx);
  if (c.cls === 'read') return { ...c, hold: false };
  if (ctx.kind && ctx.kind !== 'browser' && c.reason === 'marked outbound') return { ...c, hold: true };
  const rule = matchRule(ctx.rules || [], factsOf(tool, args, c, ctx));
  return rule ? { ...c, hold: true, rule: rule.text, reason: `your rule "${rule.text}"` } : { ...c, hold: false };
}

// Redaction for the audit log and approval records: secret-looking keys, token shapes, and text typed into
// password/code fields. Strings are clipped.
const SECRET_KEY_RE = /(token|secret|password|passwd|passcode|api_?key|apikey|cookie|credentials?|authorization|bearer|otp|cvv|cvc)$/i;
export const SENSITIVE_NAME_RE = /pass(word|code|phrase)?\b|one[- ]time|\botp\b|2fa|verification code|security code|\bpin\b|cvv|cvc|card number|secret/i;
const TOKEN_RE = /\b(ya29\.[\w-]{10,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*|sk-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|aon_[\w-]{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16})/g;
export function redact(v, depth = 0) {
  if (typeof v === 'string') return clip(v.replace(TOKEN_RE, '[redacted]'), 2000);
  if (!v || typeof v !== 'object' || depth > 6) return v;
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => redact(x, depth + 1));
  const sensitive = SENSITIVE_NAME_RE.test(String(v.name ?? v.element ?? '')) || /^password$/i.test(String(v.type ?? ''));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k,
    SECRET_KEY_RE.test(k) || (sensitive && /^(text|value)$/.test(k)) ? '[redacted]' : redact(x, depth + 1)]));
}
// A call's args for the log: redacted, plus text typed into a field the snapshot names as a password/code.
export function redactCall(tool, args, snap) {
  const out = redact(args || {});
  const el = snap?.refs?.get(String(targetOf(args) ?? ''));
  if (el && SENSITIVE_NAME_RE.test(el.name || '') && 'text' in out) out.text = '[redacted]';
  if (Array.isArray(out.fields)) out.fields = out.fields.map((f, i) => (SENSITIVE_NAME_RE.test(snap?.refs?.get(String(targetOf(args.fields[i]) ?? ''))?.name || '') ? { ...f, value: '[redacted]' } : f));
  return out;
}

// ---- the audit log: one JSON line per call, hash-chained (prev = sha256 of the line before), append-only.
const lastHash = new Map();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export function appendAudit(file, entry) {
  let prev = lastHash.get(file);
  if (prev === undefined) {
    prev = null;
    try {
      const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
      if (lines.at(-1)) prev = sha(lines.at(-1));
    } catch {}
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ ...entry, prev });
  fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  lastHash.set(file, sha(line));
  return JSON.parse(line);
}
// Entries, oldest first (the last `limit`), with `ok: false` on a line whose chain doesn't match (edited or missing).
export function readAudit(file, { limit = 500 } = {}) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  let prev = null;
  const out = lines.map((l) => {
    let e;
    try { e = JSON.parse(l); } catch { e = { bad: true }; }
    if ((e.prev ?? null) !== prev) e.broken = true;
    prev = sha(l);
    return e;
  });
  return out.slice(-limit);
}

// ---- the file channel: ask() writes <dir>/<box>/<id>.json and waits for <id>.answer.json; serve() answers.
const writeAtomic = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// Calls fn on changes to `dir` (fs.watch) and every `ms` as a fallback; returns stop().
function watchDir(dir, fn, ms = 1000) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let w = null;
  try { w = fs.watch(dir, () => fn()); w.on('error', () => {}); } catch {}
  const t = setInterval(fn, ms);
  t.unref?.();
  return () => { clearInterval(t); try { w?.close(); } catch {} };
}
export const newId = () => `${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
export function ask(dir, box, body, { timeoutMs = APPROVAL_TTL_MS, signal, id = body?.id || newId() } = {}) {
  const q = path.join(dir, box, `${id}.json`), a = path.join(dir, box, `${id}.answer.json`);
  writeAtomic(q, { ...body, id });
  return new Promise((resolve) => {
    let done = false, stop = () => {};
    const end = (v) => { if (done) return; done = true; stop(); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(v); };
    const check = () => { const v = readJson(a); if (v) end(v); };
    const onAbort = () => end(null);
    const timer = setTimeout(() => end(null), timeoutMs);
    timer.unref?.();
    if (signal?.aborted) return end(null);
    signal?.addEventListener('abort', onAbort, { once: true });
    stop = watchDir(path.dirname(q), check, 500);
    check();
  });
}
export const answer = (dir, box, id, body) => writeAtomic(path.join(dir, box, `${id}.answer.json`), body);
// Answers every unanswered question in <dir>/<box> once: handler(question) → answer (may be async; undefined = later).
export function serve(dir, box, handler) {
  const d = path.join(dir, box), busy = new Set();
  const scan = () => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const m = /^([\w-]+)\.json$/.exec(n);
      if (!m || busy.has(m[1]) || names.includes(`${m[1]}.answer.json`)) continue;
      const q = readJson(path.join(d, n));
      if (!q) continue;
      busy.add(m[1]);
      Promise.resolve().then(() => handler(q)).then((r) => { if (r !== undefined) answer(dir, box, m[1], r); else busy.delete(m[1]); },
        (e) => answer(dir, box, m[1], { decision: 'deny', reason: `gate error: ${e?.message || e}` }));
    }
  };
  const stop = watchDir(d, scan, 1000);
  scan();
  return stop;
}
// The host's side of a run's gate dir: approval requests (onRequest(approval) → Promise<answer>) and the proxy's audit
// lines (onAudit(entry)), in order, each once. Returns stop().
export function hostGate(dir, { onRequest, onAudit }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'audit.jsonl');
  let off = 0, rest = '';
  const tail = () => {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= off) return;
      const buf = Buffer.alloc(size - off);
      fs.readSync(fd, buf, 0, buf.length, off);
      off = size;
      const lines = (rest + buf.toString('utf8')).split('\n');
      rest = lines.pop();
      for (const l of lines) { if (!l.trim()) continue; let e; try { e = JSON.parse(l); } catch { continue; } try { onAudit?.(e); } catch {} }
    } finally { fs.closeSync(fd); }
  };
  const stopTail = watchDir(dir, tail, 1000);
  const stopServe = serve(dir, 'approvals', (a) => onRequest(a));
  tail();
  return () => { tail(); stopTail(); stopServe(); };
}
// Whether the gate dir has approvals nobody has answered yet (the run is paused on the owner).
export function pendingIn(dir) {
  try {
    const names = fs.readdirSync(path.join(dir, 'approvals'));
    return names.filter((n) => /^[\w-]+\.json$/.test(n) && !n.endsWith('.answer.json') && !names.includes(n.replace(/\.json$/, '.answer.json'))).length;
  } catch { return 0; }
}
// A stable identity for one exact call (the hook's pre-approval ticket must match what the CLI then sends).
export const callKey = (tool, args) => sha(`${tool}\n${stableJson(args ?? {})}`);
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
// The owner's answer → {allow, decision, reason}. 'always' approves this one and, host-side, every later call with its key.
export function verdict(ans) {
  if (!ans) return { allow: false, decision: 'expired', reason: 'No answer from the owner in time' };
  const d = String(ans.decision || '');
  if (d === 'approve' || d === 'always' || d === 'auto') return { allow: true, decision: d, by: ans.by || null };
  return { allow: false, decision: d === 'expired' ? 'expired' : 'deny', reason: String(ans.reason || '').slice(0, 1000) || null, by: ans.by || null };
}
export const denialText = (v, action) => `The owner ${v.decision === 'expired' ? 'did not approve in time' : 'denied'} this action (${action})${v.reason ? `: ${v.reason}` : ''}. ` +
  'It was NOT performed. Do not retry it or look for another way to do it; continue with other work or end your turn and report.';
