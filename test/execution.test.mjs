// execution.mjs: the Execution Mode intake is validated, services are matched to the admin's Credentials cards and MCP
// servers, the chosen keys land in .env without clobbering, and the brief/system prompt carry what the owner chose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateIntake, serviceStatus, envExport, mergeEnv, executionBrief, kickoffMessage, createExecutions, EXECUTION_SYSTEM, SERVICES, envKey } from '../execution.mjs';

const idea = 'A dating app where men pay a high monthly fee and women join free; verified profiles and one match a day.';
const base = { idea, products: { web: true, ios: true }, appTech: 'native', domain: { mode: 'have', name: 'Example.COM', bought: false }, askBefore: ['spend', 'bogus'], services: ['godaddy', 'nope'] };

test('validateIntake: cleans and rejects', () => {
  const i = validateIntake(base);
  assert.equal(i.domain.name, 'example.com');
  assert.equal(i.domain.bought, false);
  assert.deepEqual(i.askBefore, ['spend']);
  assert.deepEqual(i.services, ['godaddy']);
  assert.deepEqual(i.products, { web: true, ios: true, android: false, admin: false });
  assert.equal(i.emails, true); assert.equal(i.demoData, true);
  assert.throws(() => validateIntake({ ...base, idea: 'short' }), { status: 400, message: /few sentences/ });
  assert.throws(() => validateIntake({ ...base, products: { admin: true } }), /at least one product/);
  assert.throws(() => validateIntake({ ...base, appTech: 'flutter' }), /React Native or native/);
  assert.throws(() => validateIntake({ ...base, domain: { mode: 'have', name: 'not a domain' } }), /example\.com/);
  assert.equal(validateIntake({ ...base, products: { web: true }, appTech: 'flutter' }).appTech, null, 'no app: technology is ignored');
  assert.equal(validateIntake({ ...base, domain: { mode: 'weird' } }).domain.mode, 'find');
  assert.deepEqual(validateIntake({ ...base, attachments: ['0123456789abcdef01234567', 'bad', 7] }).attachments, ['0123456789abcdef01234567']);
});

test('serviceStatus: cards by name or key, MCP servers by name', () => {
  const cards = [
    { name: 'GoDaddy', fields: [{ label: 'GODADDY_API_KEY', value: 'k' }, { label: 'Godaddy api secret', value: 's' }] },
    { name: 'Stripe prod', fields: [{ label: 'Secret key', value: 'sk_live' }] }, // key name does not match → the card's name does
    { name: 'Mail', fields: [{ label: 'RESEND_API_KEY', value: 're_x' }] }, // name does not match → the key does
    { name: 'Apple Developer', fields: [{ label: 'APP_STORE_CONNECT_KEY_ID', value: 'id' }] },
  ];
  const st = Object.fromEntries(serviceStatus(cards, [{ name: 'mobbin', enabled: true }]).map((s) => [s.id, s]));
  assert.equal(st.godaddy.status, 'ready'); // "Godaddy api secret" → GODADDY_API_SECRET
  assert.equal(envKey('Godaddy api secret'), 'GODADDY_API_SECRET');
  assert.equal(st.resend.status, 'ready'); assert.equal(st.resend.card, 'Mail');
  assert.equal(st.apple.status, 'partial'); assert.deepEqual(st.apple.have, ['APP_STORE_CONNECT_KEY_ID']);
  assert.equal(st.stripe.status, 'missing', 'a card named after the service still needs the key itself');
  assert.equal(st.mobbin.status, 'ready');
  assert.equal(serviceStatus(cards, [{ name: 'mobbin', enabled: false }]).find((s) => s.id === 'mobbin').status, 'missing');
  assert.equal(st.hostinger.status, 'missing');
});

test('godaddy with only one of two keys is partial', () => {
  const st = serviceStatus([{ name: 'GoDaddy', fields: [{ label: 'GODADDY_API_KEY', value: 'k' }] }]).find((s) => s.id === 'godaddy');
  assert.equal(st.status, 'partial');
});

test('envExport + mergeEnv: chosen services only, existing keys kept', () => {
  const cards = [{ name: 'GoDaddy', fields: [{ label: 'GODADDY_API_KEY', value: 'k' }, { label: 'Customer id', value: 'c 1' }] }, { name: 'Stripe', fields: [{ label: 'STRIPE_SECRET_KEY', value: 'sk' }] }];
  assert.deepEqual(envExport(cards, ['godaddy']), { GODADDY_API_KEY: 'k', CUSTOMER_ID: 'c 1' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-'));
  fs.writeFileSync(path.join(dir, '.env'), 'GODADDY_API_KEY=old');
  assert.deepEqual(mergeEnv(dir, envExport(cards, ['godaddy', 'stripe'])), ['CUSTOMER_ID', 'STRIPE_SECRET_KEY']);
  const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.match(env, /^GODADDY_API_KEY=old$/m);
  assert.match(env, /^CUSTOMER_ID="c 1"$/m);
  assert.match(env, /^STRIPE_SECRET_KEY=sk$/m);
  assert.deepEqual(mergeEnv(dir, { STRIPE_SECRET_KEY: 'x' }), []);
});

test('the brief and kick-off carry the choices; the system prompt names the rules', () => {
  const i = validateIntake({ ...base, inspiration: { mobbin: true, refs: 'Hinge' }, emails: false });
  const brief = executionBrief(i, SERVICES.filter((s) => s.id === 'godaddy'), { attachments: [{ path: '/p/.agent-orch/uploads/abc-ref.png' }], now: new Date('2026-10-21T00:00:00Z') });
  for (const want of ['dating app', 'iOS app', 'Native', 'SwiftUI', 'Mobbin (MCP): yes', 'Hinge', 'abc-ref.png', '**example.com**', 'not bought yet', 'Spending money', 'email addresses on the domain (hello@, support@, noreply@): no', 'demo users once the product runs: yes', 'GoDaddy', 'GODADDY_API_KEY', '## Stages'])
    assert.ok(brief.includes(want), `brief lacks ${want}`);
  assert.ok(!brief.includes('- Android app'));
  assert.match(kickoffMessage(i), /example\.com is available/);
  assert.match(kickoffMessage(validateIntake({ ...base, domain: { mode: 'find' } })), /find available domain names/);
  const none = executionBrief(validateIntake({ ...base, askBefore: [] }), []);
  assert.match(none, /wants no questions/);
  assert.match(none, /None connected/);
  assert.match(EXECUTION_SYSTEM, /EXECUTION\.md/);
  assert.match(EXECUTION_SYSTEM, /never queue it/);
});

test('createExecutions: add, list newest first, remove by chat', () => {
  const ex = createExecutions({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'exec-store-')) });
  const a = ex.add({ cid: 'c1', cwd: '/a', name: 'a' }), b = ex.add({ cid: 'c2', cwd: '/b', name: 'b' });
  assert.deepEqual(ex.list().map((x) => x.id), [b.id, a.id]);
  assert.equal(ex.update(a.id, { name: 'A' }).name, 'A');
  assert.equal(ex.remove('c1'), 1);
  assert.deepEqual(ex.list().map((x) => x.cid), ['c2']);
});
