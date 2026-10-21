// Execution Mode (owner, 2026-10-21): the admin's one-stop executor that takes a product idea ("a dating app with high
// paywalls for men") and brings it to the real world: domain, email, web app, mobile app, store publishing, admin panel,
// demo data. The sidebar's Execution button (admin only, public/execution.js) collects an intake: the idea, reference
// images, the products wanted (website / iOS / Android / admin), the app technology, design inspiration (Mobbin MCP), the
// domain plan, what needs the owner's permission, extras, and which connected services to use. POST /api/execution then
// creates a normal orchestrator project whose main chat is marked `execution: true`: its planner and every task get
// EXECUTION_SYSTEM on top of the usual prompts, the intake lives in .agent-orch/EXECUTION.md (and BRIEF.md points at
// it), the chosen services' keys are written into the project's .env (the only place agents read keys), and the
// kick-off message starts the planner. From there it is the ordinary orchestrator: tasks, fallbacks, checkpoints.
//   SERVICES: the catalogue of outside services an execution can use, each with the .env keys it needs (or the MCP
//   server it comes as). serviceStatus(cards, mcp) says which are connected (the admin's Credentials cards, matched by
//   name or by a field whose label is one of the keys; MCP servers by name). envExport(cards, ids) → {KEY: value} of the
//   chosen services' fields; mergeEnv(cwd, vars) adds the missing ones to <cwd>/.env.
//   validateIntake(body) → a clean intake or throws {status: 400}. executionBrief(intake, services) is EXECUTION.md,
//   kickoffMessage(intake) the planner's first message, EXECUTION_SYSTEM the standing rules.
//   createExecutions({dataDir}) → {list(), add(e), update(id, patch), remove(cid)} over <dataDir>/executions.json.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LIMITS = { idea: 20000, name: 60, domain: 253, refs: 4000, attachments: 10 };
export const PRODUCTS = [
  ['web', 'Website / web app'], ['ios', 'iOS app'], ['android', 'Android app'], ['admin', 'Admin panel'],
];
export const APP_TECH = [
  ['react-native', 'React Native (Expo)', 'One codebase for iOS and Android'],
  ['native', 'Native', 'SwiftUI for iOS, Kotlin for Android'],
];
export const ASK_BEFORE = [
  ['spend', 'Spending money', 'buying a domain, a plan or a subscription'],
  ['publish', 'Publishing', 'submitting to the App Store or Google Play, going live on the domain'],
  ['emails', 'Creating email accounts', 'new mailboxes on the domain'],
  ['send', 'Sending email', 'to anyone but you'],
  ['delete', 'Deleting', 'domains, apps, data or accounts'],
];
// role: what the service is for. env: the .env keys an agent needs (all present = ready). mcp: the MCP server name
// (Settings → Skills & tools) it comes as instead. url: where the owner gets the keys.
export const SERVICES = [
  { id: 'godaddy', name: 'GoDaddy', role: 'Domains: check, buy, DNS', env: ['GODADDY_API_KEY', 'GODADDY_API_SECRET'], url: 'https://developer.godaddy.com/keys' },
  { id: 'hostinger', name: 'Hostinger', role: 'Hosting, DNS and mailboxes', env: ['HOSTINGER_API_TOKEN'], url: 'https://hpanel.hostinger.com/profile/api' },
  { id: 'cloudflare', name: 'Cloudflare', role: 'DNS and domains', env: ['CLOUDFLARE_API_TOKEN'], url: 'https://dash.cloudflare.com/profile/api-tokens' },
  { id: 'vercel', name: 'Vercel', role: 'Web hosting', env: ['VERCEL_TOKEN'], url: 'https://vercel.com/account/tokens' },
  { id: 'apple', name: 'Apple Developer', role: 'App Store Connect: publish iOS apps', env: ['APP_STORE_CONNECT_ISSUER_ID', 'APP_STORE_CONNECT_KEY_ID', 'APP_STORE_CONNECT_PRIVATE_KEY'], url: 'https://appstoreconnect.apple.com/access/integrations/api' },
  { id: 'google-play', name: 'Google Play Console', role: 'Publish Android apps', env: ['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'], url: 'https://play.google.com/console' },
  { id: 'google-workspace', name: 'Google Workspace', role: 'Create mailboxes on the domain', env: ['GOOGLE_WORKSPACE_ADMIN_EMAIL', 'GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON'], url: 'https://admin.google.com' },
  { id: 'resend', name: 'Resend', role: 'Transactional email', env: ['RESEND_API_KEY'], url: 'https://resend.com/api-keys' },
  { id: 'stripe', name: 'Stripe', role: 'Payments and paywalls', env: ['STRIPE_SECRET_KEY'], url: 'https://dashboard.stripe.com/apikeys' },
  { id: 'mobbin', name: 'Mobbin', role: 'Design inspiration (MCP server)', mcp: 'mobbin', url: 'https://mobbin.com/mcp' },
];

// "Secret key" → SECRET_KEY (the Credentials sheet's rule); an env-style label stays as it is.
export const envKey = (label) => (/^[A-Z_][A-Z0-9_]*$/.test(label) ? label : String(label).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'VALUE');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// The admin's credential cards (credentials.mjs list()) that hold a service: named after it, or holding one of its keys.
function cardsFor(service, cards) {
  if (!service.env) return [];
  const names = [service.id, service.name].map(norm), keys = new Set(service.env);
  return cards.filter((c) => names.includes(norm(c.name)) || norm(c.name).includes(names[0]) || (c.fields || []).some((f) => keys.has(envKey(f.label))));
}
// [{...service, status: 'ready' | 'partial' | 'missing', have: [keys found], card: the card's name | null}]; an MCP
// service is 'ready' when a server of that name is enabled (mcp: [{name, enabled}]).
export function serviceStatus(cards = [], mcp = []) {
  return SERVICES.map((s) => {
    if (s.mcp) {
      const m = mcp.find((x) => norm(x.name) === norm(s.mcp));
      return { ...s, status: m && m.enabled !== false ? 'ready' : 'missing', have: [], card: m?.name || null };
    }
    const found = cardsFor(s, cards);
    const have = s.env.filter((k) => found.some((c) => (c.fields || []).some((f) => envKey(f.label) === k && f.value)));
    return { ...s, status: have.length === s.env.length ? 'ready' : have.length ? 'partial' : 'missing', have, card: found[0]?.name || null };
  });
}
// Every field of the chosen services' cards as env vars (a card may hold more than the listed keys: customer ids, hosts).
export function envExport(cards = [], ids = []) {
  const out = {};
  for (const s of SERVICES) {
    if (!ids.includes(s.id)) continue;
    for (const c of cardsFor(s, cards)) for (const f of c.fields || []) if (f.value) out[envKey(f.label)] ??= String(f.value);
  }
  return out;
}
const envLine = (k, v) => `${k}=${/[\s#"'$`\\]/.test(v) || v === '' ? JSON.stringify(v) : v}`;
// Adds the vars missing from <cwd>/.env (an existing key keeps its value); returns the keys written.
export function mergeEnv(cwd, vars) {
  const file = path.join(cwd, '.env');
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch {}
  const present = new Set([...cur.matchAll(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/gm)].map((m) => m[1]));
  const add = Object.entries(vars).filter(([k]) => !present.has(k));
  if (!add.length) return [];
  const text = (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + (cur ? '\n' : '') + '# Added by agent-orch Execution Mode from your Credentials sheet\n' + add.map(([k, v]) => envLine(k, v)).join('\n') + '\n';
  fs.writeFileSync(file, text, { mode: 0o600 });
  return add.map(([k]) => k);
}

const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
const str = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
// The sheet's body as a clean intake. Throws a 400 Error with a sentence the sheet shows.
export function validateIntake(body = {}) {
  const idea = str(body.idea, LIMITS.idea);
  if (idea.length < 20) throw fail('Describe the idea in a few sentences first');
  const products = Object.fromEntries(PRODUCTS.map(([k]) => [k, body.products?.[k] === true]));
  if (!products.web && !products.ios && !products.android) throw fail('Tick at least one product: a website, an iOS app or an Android app');
  const app = products.ios || products.android;
  const appTech = app ? String(body.appTech || '') : null;
  if (app && !APP_TECH.some(([k]) => k === appTech)) throw fail('Pick how the app is built: React Native or native');
  const domainMode = ['have', 'find', 'none'].includes(body.domain?.mode) ? body.domain.mode : 'find';
  const domainName = domainMode === 'have' ? str(body.domain?.name, LIMITS.domain).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
  if (domainMode === 'have' && !DOMAIN_RE.test(domainName)) throw fail('Enter the domain, e.g. example.com');
  const askBefore = ASK_BEFORE.map(([k]) => k).filter((k) => Array.isArray(body.askBefore) && body.askBefore.includes(k));
  const services = SERVICES.map((s) => s.id).filter((id) => Array.isArray(body.services) && body.services.includes(id));
  const attachments = Array.isArray(body.attachments) ? body.attachments.filter((x) => typeof x === 'string' && /^[a-f0-9]{24}$/.test(x)).slice(0, LIMITS.attachments) : [];
  return {
    idea, name: str(body.name, LIMITS.name), products, appTech,
    inspiration: { mobbin: body.inspiration?.mobbin === true, refs: str(body.inspiration?.refs, LIMITS.refs) },
    domain: { mode: domainMode, name: domainName, bought: domainMode === 'have' && body.domain?.bought !== false },
    askBefore, emails: body.emails !== false, demoData: body.demoData !== false, services, attachments,
  };
}

const yes = (b) => (b ? 'yes' : 'no');
const label = (list, k) => list.find(([id]) => id === k)?.[1] || k;
// .agent-orch/EXECUTION.md: the intake as the durable brief every planner turn and task reads.
export function executionBrief(intake, services = [], { attachments = [], now = new Date() } = {}) {
  const i = intake, want = PRODUCTS.filter(([k]) => i.products[k]).map(([, l]) => l);
  const svc = services.filter((s) => i.services.includes(s.id));
  const lines = [
    '# Execution brief', '', `_Written by agent-orch Execution Mode on ${now.toISOString().slice(0, 10)} from the owner's intake. The planner and every task follow it._`, '',
    '## The idea', '', i.idea, '',
    '## What to build', '', ...want.map((l) => `- ${l}`),
    ...(i.appTech ? ['', `App technology: **${label(APP_TECH, i.appTech)}** (${APP_TECH.find(([k]) => k === i.appTech)[2]})`] : []), '',
    '## Design', '',
    `- Design inspiration from Mobbin (MCP): ${yes(i.inspiration.mobbin)}`,
    ...(i.inspiration.refs ? [`- References the owner named: ${i.inspiration.refs}`] : []),
    ...(attachments.length ? ['- Reference images (open them before designing anything):', ...attachments.map((f) => `  - ${f.path || f.name}`)] : []), '',
    '## Domain', '',
    i.domain.mode === 'have' ? `- Use **${i.domain.name}**${i.domain.bought ? ' (already bought; connect it)' : ' (not bought yet: check availability and buy it through the connected registrar)'}`
      : i.domain.mode === 'find' ? '- No domain yet: propose 5–8 available names (check availability through the registrar API), the owner approves one, then buy and connect it'
        : '- No domain for now: run on the live preview address', '',
    '## Permissions', '',
    i.askBefore.length ? ['Ask the owner (in the chat, one short message with the exact action and cost) and wait for the answer before:', ...i.askBefore.map((k) => { const [, l, d] = ASK_BEFORE.find(([id]) => id === k); return `- ${l}: ${d}`; })].join('\n')
      : 'The owner wants no questions: do everything, including buying and publishing, without asking.',
    '', 'Everything else runs on its own. Never ask what the brief already answers.', '',
    '## Extras', '', `- Create email addresses on the domain (hello@, support@, noreply@): ${yes(i.emails)}`, `- Seed demo data and demo users once the product runs: ${yes(i.demoData)}`, '',
    '## Connected services', '',
    ...(svc.length ? svc.map((s) => `- ${s.name}: ${s.role}${s.mcp ? ` (MCP server \`${s.mcp}\`)` : ` (keys in .env: ${s.env.join(', ')})`}`) : ['- None connected. Ask the owner for the keys of each service a stage needs (Credentials sheet → the project\'s .env) before that stage.']), '',
    '## Stages (in this order; stages that need nothing before them run in parallel)', '',
    '1. Preflight: read this brief, check every connected service answers, check the domain plan, write BRIEF.md and CONTEXT.md.',
    '2. Domain: have it, buy it, or propose names for approval; DNS pointed where the web app will live.',
    '3. Email: the addresses the product needs (if wanted), and transactional email set up.',
    '4. Web app: the product itself (and its API/backend), deployed on the domain.',
    '5. Mobile app: the chosen technology, against the same backend, with store assets.',
    '6. Publishing: App Store Connect and Google Play listings, builds uploaded, submitted for review (per permissions).',
    '7. Admin panel: manage users, content, payments and settings.',
    '8. Demo data: realistic seed users and content (if wanted), so the product looks alive on day one.',
  ];
  return lines.join('\n') + '\n';
}
// The planner's first message: everything it needs is in the brief; this says where and what to do first.
export function kickoffMessage(intake) {
  const first = intake.domain.mode === 'have' ? `check that ${intake.domain.name} is ${intake.domain.bought ? 'in the connected registrar' : 'available'}` : intake.domain.mode === 'find' ? 'find available domain names for approval' : 'skip the domain';
  return `Execution Mode. Bring the idea in .agent-orch/EXECUTION.md to life, end to end, following its stages and permissions. Start now: write the project's BRIEF.md and CONTEXT.md from the brief, ${first}, and queue the preflight and every stage that can already start (file-disjoint, parallel tasks with "after" only for true prerequisites). Report in one short message what is queued and what, if anything, you need from me.`;
}

export const EXECUTION_SYSTEM = `Execution Mode (the owner's standing rule for this project): you are the executor that turns the idea in .agent-orch/EXECUTION.md into a real, live product with the least owner time and effort. Read EXECUTION.md first in every session.
- Follow its stages in order (domain → email → web app → mobile app → publishing → admin panel → demo data), but queue every stage that can start now; stages wait only for true prerequisites ("after").
- Use the connected services through their official APIs with the keys in the project's .env (GoDaddy, Hostinger, Cloudflare, Vercel, App Store Connect, Google Play, Google Workspace, Resend, Stripe) and the Mobbin MCP server for design references. Prefer an official API or CLI (fastlane, eas, gh) over driving a website; use a browser task only when there is no API. If a stage needs a service that is not connected, finish everything else first, then ask the owner for the key in one message (they add it in the Credentials sheet; it lands in this project's .env).
- Permissions: for every action listed under "Ask the owner" in EXECUTION.md, never queue it; do all the work that does not depend on it, then ask in chat with the exact action, the cost and the one-word answer you need, and queue it only after the owner's reply. Everything else runs without asking. Never ask what the brief already answers, and never ask two things when one message can carry both.
- Money: never spend beyond what the brief or the owner's reply allows; report every purchase (what, where, how much) in chat.
- Keep the owner informed with short progress messages: what went live (with links), what is queued, what is blocked and on whom.
- Finished means live: a domain that resolves, a deployed web app, store listings submitted, an admin panel the owner can sign in to (credentials in the Credentials sheet via .env), and demo data in place when wanted.`;

// <dataDir>/executions.json: [{id, cid, cwd, name, createdAt, intake, keys: [env keys written]}], the sheet's list.
export function createExecutions({ dataDir }) {
  const file = path.join(dataDir, 'executions.json');
  const read = () => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } };
  const write = (list) => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(list, null, 2)); fs.renameSync(file + '.tmp', file); };
  return {
    list: () => read(),
    add(e) { const list = read(); const row = { id: crypto.randomBytes(6).toString('hex'), createdAt: Date.now(), ...e }; list.unshift(row); write(list); return row; },
    update(id, patch) { const list = read(), row = list.find((x) => x.id === id); if (!row) return null; Object.assign(row, patch); write(list); return row; },
    remove(cid) { const list = read(), keep = list.filter((x) => x.cid !== cid); if (keep.length !== list.length) write(keep); return list.length - keep.length; },
  };
}
