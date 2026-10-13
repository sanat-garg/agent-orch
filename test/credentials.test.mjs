// credentials.mjs: each user's services, encrypted at rest, validated, and moved to the admin when a user is deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCredentials, cleanService, projectSecrets } from '../credentials.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cred-'));
const stripe = { name: 'Stripe', url: 'dashboard.stripe.com', fields: [{ label: 'Secret key', value: 'sk_live_TOPSECRET', secret: true }, { label: 'Email', value: 'a@b.c' }] };

test('values are encrypted on disk (0600) and read back by a fresh instance', () => {
  const dir = tmp(), cr = createCredentials({ dataDir: dir });
  const s = cr.add('admin', stripe);
  assert.equal(s.url, 'https://dashboard.stripe.com');
  assert.deepEqual(s.fields, [{ label: 'Secret key', value: 'sk_live_TOPSECRET', secret: true }, { label: 'Email', value: 'a@b.c', secret: false }]);
  assert.equal(s.owner, undefined);
  const raw = fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8');
  assert.ok(!raw.includes('TOPSECRET') && !raw.includes('Stripe'));
  for (const f of ['credentials.json', 'credentials.key']) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
  assert.deepEqual(createCredentials({ dataDir: dir }).list('admin'), [s]);
});

test('each user sees and changes only their own', () => {
  const cr = createCredentials({ dataDir: tmp() });
  const a = cr.add('admin', stripe), b = cr.add('sam', { name: 'Postgres', fields: [] });
  assert.deepEqual(cr.list('sam').map((s) => s.name), ['Postgres']);
  assert.throws(() => cr.update('sam', a.id, stripe), { status: 404 });
  assert.throws(() => cr.remove('sam', a.id), { status: 404 });
  assert.equal(cr.update('sam', b.id, { name: 'Postgres prod', fields: [{ label: 'Password', value: 'x', secret: true }] }).name, 'Postgres prod');
  assert.equal(cr.reown('sam', 'admin'), 1);
  assert.deepEqual(cr.list('admin').map((s) => s.name).sort(), ['Postgres prod', 'Stripe']);
  cr.remove('admin', a.id);
  assert.deepEqual(cr.list('admin').map((s) => s.name), ['Postgres prod']);
});

test('validation: a name, named values, sane sizes and links; blank rows dropped', () => {
  assert.throws(() => cleanService({ name: ' ' }), /name/);
  assert.throws(() => cleanService({ name: 'X', fields: [{ label: '', value: 'v' }] }), /needs a name/);
  assert.throws(() => cleanService({ name: 'X', url: 'http://' }), /valid address/);
  assert.throws(() => cleanService({ name: 'X', fields: [{ label: 'k', value: 'v'.repeat(8001) }] }), /too long/);
  assert.deepEqual(cleanService({ name: 'X', fields: [{ label: '', value: '' }, { label: 'k', value: ' v ' }] }).fields, [{ label: 'k', value: ' v ', secret: false }]);
});

test('a lost key never silently replaces existing credentials', () => {
  const dir = tmp();
  createCredentials({ dataDir: dir }).add('admin', stripe);
  fs.rmSync(path.join(dir, 'credentials.key'));
  assert.throws(() => createCredentials({ dataDir: dir }).list('admin'), /credentials.key/);
  assert.ok(!fs.existsSync(path.join(dir, 'credentials.key')));
});

test('projectSecrets: keys from .env files (root and one folder down), not examples, placeholders or settings', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env'), [
    '# comment', 'OPENAI_API_KEY="sk-proj-abcdefgh123"', "export STRIPE_SECRET='sk_live_12345678'", 'PORT=3000',
    'SITE_URL=https://example.com', 'EMPTY_TOKEN=', 'GITHUB_TOKEN=your-token-here', 'SESSION_SECRET=changeme',
    'DATABASE_URL=postgres://app:hunter2pass@db:5432/app', 'PLAIN_DB_URL=postgres://db:5432/app', 'AUTH_URL=http://localhost:3000/auth',
    'SHORT_KEY=abc', 'WEBHOOK_SECRET=whsec_abcdefgh # inline comment',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, '.env.example'), 'OPENAI_API_KEY=sk-example-123456789\n');
  fs.mkdirSync(path.join(dir, 'web')); fs.mkdirSync(path.join(dir, 'node_modules')); fs.mkdirSync(path.join(dir, 'web', 'deep'));
  fs.writeFileSync(path.join(dir, 'web', '.env.local'), 'OPENAI_API_KEY=sk-proj-abcdefgh123\nSTRIPE_SECRET=sk_test_87654321\n');
  fs.writeFileSync(path.join(dir, 'node_modules', '.env'), 'NPM_TOKEN=npm_abcdefgh12345\n');
  fs.writeFileSync(path.join(dir, 'web', 'deep', '.env'), 'DEEP_TOKEN=abcdefgh12345\n');
  assert.deepEqual(projectSecrets(dir), [
    { label: 'OPENAI_API_KEY', value: 'sk-proj-abcdefgh123', file: '.env' },
    { label: 'STRIPE_SECRET', value: 'sk_live_12345678', file: '.env' },
    { label: 'DATABASE_URL', value: 'postgres://app:hunter2pass@db:5432/app', file: '.env' },
    { label: 'WEBHOOK_SECRET', value: 'whsec_abcdefgh', file: '.env' },
    { label: `STRIPE_SECRET (${path.join('web', '.env.local')})`, value: 'sk_test_87654321', file: path.join('web', '.env.local') },
  ]);
  assert.deepEqual(projectSecrets(path.join(dir, 'missing')), []);
});

test("importProject: one card per project, only changed values written, the owner's edits and deletions stick", () => {
  let t = 1;
  const cr = createCredentials({ dataDir: tmp(), now: () => t++ });
  const dir = '/work/shop', key = (v) => [{ label: 'API_KEY', value: v }, { label: 'DB_PASSWORD', value: 'pw-123456789' }];
  assert.deepEqual(cr.importProject('sam', dir, key('k-1111111111')), ['API_KEY', 'DB_PASSWORD']);
  let [card] = cr.list('sam');
  assert.equal(card.name, 'shop');
  assert.equal(card.auto, 'shop');
  assert.deepEqual(card.fields, [{ label: 'API_KEY', value: 'k-1111111111', secret: true }, { label: 'DB_PASSWORD', value: 'pw-123456789', secret: true }]);
  assert.equal(card.seen, undefined);
  assert.deepEqual(cr.list('admin'), []);
  assert.deepEqual(cr.importProject('sam', dir, key('k-1111111111')), []); // nothing new: no write
  // The owner drops a field and renames the card: an unchanged .env doesn't undo it, a changed key comes back.
  cr.update('sam', card.id, { name: 'Shop prod', fields: [card.fields[0]] });
  assert.deepEqual(cr.importProject('sam', dir, key('k-1111111111')), []);
  assert.deepEqual(cr.importProject('sam', dir, key('k-2222222222')), ['API_KEY']);
  [card] = cr.list('sam');
  assert.equal(card.name, 'Shop prod');
  assert.deepEqual(card.fields.map((f) => [f.label, f.value]), [['API_KEY', 'k-2222222222']]);
  // Deleting the card hides it until a value changes; then it returns with only that key.
  cr.remove('sam', card.id);
  assert.deepEqual(cr.list('sam'), []);
  assert.deepEqual(cr.importProject('sam', dir, key('k-2222222222')), []);
  assert.deepEqual(cr.list('sam'), []);
  assert.deepEqual(cr.importProject('sam', dir, key('k-3333333333')), ['API_KEY']);
  assert.deepEqual(cr.list('sam').map((s) => s.fields.map((f) => f.value)), [['k-3333333333']]);
  assert.throws(() => cr.update('sam', 'nope', stripe), { status: 404 });
});
