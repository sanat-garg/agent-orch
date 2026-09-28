// Browser tasks through Claude in Chrome (`claude --chrome`, .agent-orch/CHROME.md): a node whose own logged-in macOS
// user runs Google Chrome with the Claude extension reports the 'chrome' capability (detectChrome); browser tasks prefer
// such a node (browserRoute) and run Claude with the SDK option CHROME_OPTIONS instead of the Playwright MCP, falling
// back to the built-in (Playwright) browser only while no chrome node is online. The extension's tool calls
// (mcp__claude-in-chrome__*) go through the owner's "Don't allow" rules like the Playwright ones (judgeChrome; the
// PreToolUse hook in agents.mjs holds a match for approval).
// Worker-safe: node built-ins and gate.mjs only (test/compute-only.test.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CHECKOUT_URL_RE, matchRule } from './gate.mjs';

export const CHROME_SERVER = 'claude-in-chrome';
export const CHROME_EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
export const CHROME_HOST = 'com.anthropic.claude_code_browser_extension';
// The Agent SDK's extraArgs for `claude --chrome` (a flag without a value is null).
export const CHROME_OPTIONS = { extraArgs: { chrome: null } };
const TOOL_RE = new RegExp(`^mcp__${CHROME_SERVER}__(.+)$`);
export const chromeTool = (name) => TOOL_RE.exec(String(name || ''))?.[1] || null;

// What `claude --chrome` needs on this node → {capable, chrome, extension, nativeHost, gui, reason?}. All paths and the
// GUI probe are injectable (tests). The CLI looks for the extension in every Chrome profile (Default, Profile N) and talks
// to it through the native messaging host it registers in Chrome's NativeMessagingHosts dir, over a socket in
// /tmp/claude-mcp-browser-bridge-<user>: Chrome and Claude must run as the same, logged-in macOS user. A setup-token
// sign-in (CLAUDE_CODE_OAUTH_TOKEN, how workers use the head's account) lacks the OAuth scope the integration needs.
export function detectChrome({ home = os.homedir(), platform = process.platform, env = process.env, apps = ['/Applications', path.join(home, 'Applications')],
  gui = () => guiSession(), exists = fs.existsSync, readdir = (d) => fs.readdirSync(d) } = {}) {
  if (platform !== 'darwin') return { capable: false, chrome: false, extension: false, nativeHost: false, gui: false, reason: 'Claude in Chrome runners are Macs' };
  const support = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  const chrome = apps.some((d) => exists(path.join(d, 'Google Chrome.app')));
  let profiles = [];
  try { profiles = readdir(support).filter((n) => n === 'Default' || /^Profile \d+$/.test(n)); } catch {}
  const extension = profiles.some((p) => exists(path.join(support, p, 'Extensions', CHROME_EXTENSION_ID)));
  const nativeHost = exists(path.join(support, 'NativeMessagingHosts', `${CHROME_HOST}.json`));
  let hasGui = false;
  try { hasGui = !!gui(); } catch {}
  const token = !!env.CLAUDE_CODE_OAUTH_TOKEN;
  const reason = !chrome ? 'Google Chrome is not installed' : !extension ? 'the Claude extension is not installed in Chrome'
    : !nativeHost ? 'the Claude in Chrome native host is not registered (run `claude --chrome` once)'
      : !hasGui ? 'no desktop session for this user' : token ? "Claude uses a setup token, which can't drive Chrome (sign in with `claude login`)" : null;
  return { capable: !reason, chrome, extension, nativeHost, gui: hasGui, ...(reason && { reason }) };
}
// This user owns the Mac's console: logged in at the desktop (fast user switching: the active session).
export function guiSession() {
  const who = execFileSync('/usr/bin/stat', ['-f', '%Su', '/dev/console'], { encoding: 'utf8', timeout: 3000 }).trim();
  return who && who === os.userInfo().username;
}

// ---- the runner's Claude sign-in (#525)
// Browser tasks at once on a Chrome runner when its slots are Auto: Chrome tabs are cheap, so its cores don't matter.
export const CHROME_RUNNER_SLOTS = 2;
// A runner runs Claude as the owner, on the owner's own config: never the head's shared setup token (it can't drive
// Chrome, see above) nor a CLAUDE_CONFIG_DIR pointing elsewhere. worker.mjs strips these from its environment at start.
export const OWNER_ENV_STRIP = /^(CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR)$/;
// The owner's own Claude sign-in as the runner sees it: `cli` is what `claude auth status --json` said on the owner's
// config (the email, true, or false when it said no, hung on a keychain prompt or failed). When the CLI says no, the
// owner's ~/.claude.json still tells: an interactive `claude login` writes `oauthAccount` there (a setup token never
// does), so a slow or prompt-blocked probe can't hide a real sign-in. {ok, email, via: 'cli' | 'config' | 'none'}.
export function ownerClaudeLogin({ home = os.homedir(), cli = false, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  let acct = null;
  try { acct = JSON.parse(read(path.join(home, '.claude.json')))?.oauthAccount || null; } catch {}
  if (cli) return { ok: true, email: typeof cli === 'string' ? cli : acct?.emailAddress || null, via: 'cli' };
  if (acct?.emailAddress) return { ok: true, email: acct.emailAddress, via: 'config' };
  return { ok: false, email: null, via: 'none' };
}
// A node's Claude is installed and signed in (its inventory, as the worker reported it).
export const claudeSignedIn = (n) => (n?.inventory?.agents || []).some((a) => a.id === 'claude' && a.installed && a.signedIn);
// The Mac a runner runs on: its name without the "Chrome on " prefix the installer gives runners.
export const runnerMac = (n) => String(n?.name || n?.id || 'the Mac').replace(/^chrome on /i, '');
export const ownerSignInHint = (mac) => `Sign in to Claude on ${mac} as yourself: run \`claude\` in Terminal`;
// What a Chrome runner whose Claude is signed out needs (the Machines view and the Browser tab say it), else null.
export const runnerSignIn = (n) => (n?.inventory?.chromeRunner && !claudeSignedIn(n) ? ownerSignInHint(runnerMac(n)) : null);

// ---- routing
// A worker that can run a browser task through Claude in Chrome (and ask the head for approvals).
export const chromeCapable = (n) => n?.inventory?.chrome?.capable === true && (n.features || []).includes('chrome') && (n.features || []).includes('approvals');
// …and whose Claude is signed in, so a task sent there starts (a signed-out runner would queue it forever, #525).
export const chromeReady = (n) => chromeCapable(n) && claudeSignedIn(n);
const online = (n) => !n.local && n.enabled !== false && n.connected && (n.status || 'online') === 'online';
// How a browser task runs now: {mode: 'chrome', nodes: [ids], name} when a chrome node is online with Claude signed in
// (Claude only: the integration is Claude Code's), else {mode: 'builtin', note} (the Playwright browser, browser.mjs).
export function browserRoute(nodes, { agent = 'claude' } = {}) {
  const chrome = (nodes || []).filter((n) => online(n) && chromeReady(n));
  if (chrome.length && agent === 'claude') return { mode: 'chrome', nodes: chrome.map((n) => n.id), name: chrome[0].name || chrome[0].id };
  return { mode: 'builtin', note: chrome.length ? 'Codex runs use the built-in browser (Claude in Chrome is Claude only)' : 'No Chrome runner is online, so the built-in browser is used' };
}
// The Browser tab's line for a route.
export const runnerLabel = (r) => (r?.mode === 'chrome' ? `Using ${/^chrome on /i.test(r.name) ? r.name : `Chrome on ${r.name}`}` : 'Built-in browser');

// ---- the owner's "Don't allow" rules on the extension's tools (gate.mjs matchRule). The page itself can't be read
// before a call (no snapshot as with Playwright), so clicks by coordinates, key presses that may submit and page scripts
// count as unknown targets: any action or phrase rule holds them, and url rules match the page the run last opened.
const READ = new Set(['tabs_context_mcp', 'tabs_context', 'tabs_create_mcp', 'read_page', 'find', 'get_page_text', 'read_console_messages',
  'read_network_requests', 'resize_window', 'update_plan', 'shortcuts_list', 'turn_answer_start']);
const READ_ACTIONS = new Set(['screenshot', 'zoom', 'scroll', 'scroll_to', 'wait', 'hover', 'mouse_move', 'cursor_position']);
const LOGIN_URL_RE = /(^|[/._?=&#-])(login|log-?in|sign-?in|signin|auth|oauth2?|sso)([/._?=&#-]|$)/i;
const SUBMIT_KEY_RE = /(^|\+)(enter|return|kp_enter)$/i;
const pathOf = (u) => { try { const x = new URL(u); return `${x.pathname}${x.search}${x.hash}`; } catch { return String(u || ''); } };
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// → {cls, reason, action, facts} for one extension call; page: the URL the run last navigated to (null when unknown).
export function classifyChrome(tool, args = {}, page = null) {
  const urls = page ? [page] : [], where = page ? ` on ${(() => { try { return new URL(page).host; } catch { return page; } })()}` : '';
  if (READ.has(tool)) return { cls: 'read', reason: 'reads the browser', action: `${tool.replace(/_mcp$/, '').replace(/_/g, ' ')}${where}`, facts: { kinds: [], urls } };
  if (tool === 'navigate') {
    const to = String(args.url || '');
    if (/^(back|forward)$/i.test(to)) return { cls: 'draft', reason: 'navigation', action: `Go ${to.toLowerCase()}${where}`, facts: { kinds: [], urls } };
    const url = /^[a-z][a-z0-9+.-]*:/i.test(to) ? to : `https://${to}`;
    const kinds = [...(CHECKOUT_URL_RE.test(pathOf(url)) ? ['pay'] : []), ...(LOGIN_URL_RE.test(pathOf(url)) ? ['login'] : [])];
    return { cls: kinds.includes('pay') ? 'outbound' : 'draft', reason: 'navigation', action: `Open ${clip(to, 200)}`, url, facts: { kinds, urls: [url] } };
  }
  if (tool === 'computer') {
    const a = String(args.action || '');
    if (READ_ACTIONS.has(a)) return { cls: 'read', reason: 'reads the page', action: `${a.replace(/_/g, ' ')}${where}`, facts: { kinds: [], urls } };
    if (a === 'type') return { cls: 'draft', reason: 'types text', action: `Type "${clip(args.text, 80)}"${where}`, facts: { kinds: [], urls, names: [] } };
    if (a === 'key') {
      const submits = String(args.text || '').split(/\s+/).some((k) => SUBMIT_KEY_RE.test(k));
      return { cls: submits ? 'outbound' : 'draft', reason: submits ? 'may submit the focused field' : 'page interaction', action: `Press ${clip(args.text, 40)}${where}`,
        facts: submits ? { kinds: ['submit'], urls, unknown: true } : { kinds: [], urls } };
    }
    const at = Array.isArray(args.coordinate) ? ` at (${args.coordinate.join(', ')})` : args.ref ? ` on ${args.ref}` : '';
    return { cls: 'outbound', reason: 'clicks a target the gate cannot read', action: `${a.replace(/_/g, ' ') || 'computer'}${at}${where}`, facts: { kinds: [], urls, unknown: true } };
  }
  if (tool === 'form_input') return { cls: 'draft', reason: 'fills a field', action: `Set ${args.ref || 'a field'}${where}`, facts: { kinds: [], urls, names: [] } };
  if (/upload/.test(tool)) return { cls: 'outbound', reason: 'uploads a file', action: `Upload${where}`, facts: { kinds: ['upload'], urls } };
  if (tool === 'gif_creator') {
    const exp = args.action === 'export';
    return { cls: exp ? 'draft' : 'read', reason: 'records the tab', action: `GIF ${args.action || ''}${where}`, facts: { kinds: exp && args.download ? ['download'] : [], urls } };
  }
  if (tool === 'tabs_close_mcp') return { cls: 'draft', reason: 'closes a tab', action: `Close a tab${where}`, facts: { kinds: [], urls } };
  // javascript_tool, shortcuts_execute and anything new: arbitrary effects on the page.
  const code = args.text ?? args.code ?? args.command;
  return { cls: 'outbound', reason: 'unrecognised or arbitrary-code browser tool', action: `${tool.replace(/_/g, ' ')}${where}${code ? `: ${clip(code, 120)}` : ''}`,
    facts: { kinds: [], urls, unknown: true } };
}
// classifyChrome plus the rules → {...classify, hold, rule?}. Reads never hold.
export function judgeChrome(tool, args = {}, { rules = [], page = null } = {}) {
  const c = classifyChrome(tool, args, page);
  if (c.cls === 'read') return { ...c, hold: false };
  const rule = matchRule(rules, c.facts);
  return rule ? { ...c, hold: true, rule: rule.text, reason: `your rule "${rule.text}"` } : { ...c, hold: false };
}

// ---- direct mode (#512): a Browser-tab prompt goes to the extension nearly verbatim, behind this short fixed preface and
// the owner's "Don't allow" rules as text (they are still enforced on each call by the gate hook). No system prompt.
export const CHROME_PREFACE = 'Use the Claude in Chrome tools to do this in the browser. Stop and ask if a login or 2FA is needed.';
export function chromePrompt(prompt, rules = []) {
  const deny = (rules || []).map((r) => String(r).trim()).filter(Boolean);
  return [CHROME_PREFACE, ...(deny.length ? [`Don't allow without asking the owner first: ${deny.join('; ')}.`] : []), '', String(prompt ?? '').trim()].join('\n');
}
// One Mac's line on the Browser tab's setup card, from its inventory.chrome (detectChrome): 'ready' or what is missing.
export function chromeSetupStatus(n) {
  const c = n?.inventory?.chrome;
  if (!c) return n?.inventory?.chromeRunner ? 'checking Chrome' : 'no Chrome runner';
  if (c.capable) return !chromeCapable(n) ? 'worker needs an update' : runnerSignIn(n) || 'ready';
  if (!c.chrome) return 'Chrome not installed';
  if (!c.extension) return 'extension missing';
  if (!c.nativeHost) return 'run `claude --chrome` once';
  if (!c.gui) return 'no desktop session';
  return c.reason || 'not ready';
}
// Every paired Mac and its line: [{id, name, online, status}], runners first.
export const chromeSetup = (nodes) => (nodes || []).filter((n) => !n.local && n.os === 'darwin')
  .map((n) => ({ id: n.id, name: n.name || n.id, online: online(n), runner: !!n.inventory?.chromeRunner, status: online(n) ? chromeSetupStatus(n) : 'offline' }))
  .sort((a, b) => b.runner - a.runner);
