// credentials.mjs: each user's services, encrypted at rest, validated, and moved to the admin when a user is deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCredentials, cleanService } from '../credentials.mjs';

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
