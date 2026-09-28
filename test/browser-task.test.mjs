import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { browserSteps, browserTaskStatus, stripStatusMarker } from '../browser-task.mjs';
import { toolInput } from '../agents.mjs';
import { validate, FEATURE_LIST } from '../cluster-protocol.mjs';
import { createBrowserViews } from '../browser-view.mjs';

for (const mode of ['queue', 'local', 'remote']) test(`browser tasks: ${mode}`, { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-task-'));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['test/fixtures/browser-task-orch.mjs', mode, dir], { timeout: 25000 });
    assert.match(stdout, /PASS/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('steps use normalised Playwright inputs and omit typed values', () => {
  const steps = browserSteps([
    { k: 'tool', name: 'mcp__playwright__browser_fill_form', input: toolInput('browser_fill_form', { fields: [{ name: 'Email', value: 'private' }] }) },
    { k: 'tool', name: 'Bash', input: { command: 'ls' } },
    { k: 'text', text: 'Ready' },
  ]);
  assert.deepEqual(steps, [{ ts: 0, kind: 'type', label: 'Email' }, { ts: 0, kind: 'text', label: 'Ready' }]);
  assert.equal(browserTaskStatus('Finished reading.'), 'done');
  assert.equal(browserTaskStatus('AGENT-ORCH-STATUS: continue — needs sign-in'), 'failed');
});

test('AUDIT #58 replies without a marker: a blocker fails only when no completion follows it in the last paragraph', () => {
  assert.equal(browserTaskStatus("I couldn't find a cheaper fare, so I booked the 9:40 flight as you asked."), 'done');
  assert.equal(browserTaskStatus('Posted the reply. The first click showed "We were unable to complete your request", the retry worked.'), 'done');
  assert.equal(browserTaskStatus("I can't confirm the email arrived, but it was sent."), 'done');
  assert.equal(browserTaskStatus('The site asks for a sign-in, so I stopped; nothing was submitted.'), 'failed');
  assert.equal(browserTaskStatus('Blocked by a CAPTCHA on the checkout page.'), 'failed');
  assert.equal(browserTaskStatus('I couldn’t proceed past the login page.'), 'failed');
  assert.equal(browserTaskStatus('Sent the invoice, then I stopped at the CAPTCHA.'), 'failed');
  // Only the final paragraph counts.
  assert.equal(browserTaskStatus("I couldn't open the first link.\n\nOrdered the replacement part."), 'done');
});

test('the status marker wins over contradicting prose', () => {
  assert.equal(browserTaskStatus('Blocked by a CAPTCHA at first; I could not proceed.\nAGENT-ORCH-STATUS: done — order placed'), 'done');
  assert.equal(browserTaskStatus('Booked the flight and sent the confirmation.\nAGENT-ORCH-STATUS: failed — payment declined'), 'failed');
  assert.equal(browserTaskStatus('Saved the draft, all done.\n\nagent-orch-status: continue — needs sign-in\n'), 'failed');
  assert.equal(browserTaskStatus('Posted it.\n**AO2-STATUS: blocked** by 2FA'), 'failed');
  assert.equal(browserTaskStatus('Checked out.\nAGENT-ORCH-STATUS: done — order placed'), 'done');
});

test('stripStatusMarker removes only the marker line', () => {
  assert.equal(stripStatusMarker('Booked the 9:40 flight.\n\nSeat 12A.\nAGENT-ORCH-STATUS: done — flight booked\n'), 'Booked the 9:40 flight.\n\nSeat 12A.');
  assert.equal(stripStatusMarker('The status line reads AGENT-ORCH-STATUS: done inline.'), 'The status line reads AGENT-ORCH-STATUS: done inline.');
  assert.equal(stripStatusMarker('No marker here.'), 'No marker here.');
});

test('profile validation rejects unknown identity and node; takeover follows hand back', async () => {
  const views = createBrowserViews({ send() {}, local: { home: '/nonexistent', profiles: async () => [{ identity: 'default' }], close() {} } });
  try {
    assert.deepEqual(await views.profile('controller', 'default'), { node: 'controller', identity: 'default' });
    await assert.rejects(views.profile('unknown', 'default'), /Unknown browser node/);
    await assert.rejects(views.profile('controller', 'missing'), /Unknown browser identity/);
    await assert.rejects(views.profile('controller', '../default'), /Unknown browser identity/);
    views.sessions.set('controller/default', { state: { takeover: true } });
    assert.equal(views.isTakenOver('controller', 'default'), true);
    views.sessions.get('controller/default').state.takeover = false;
    assert.equal(views.isTakenOver('controller', 'default'), false);
  } finally { await views.close(); }
});

test('wire contract allows git-free browser jobs only with the browser capability', () => {
  assert.ok(FEATURE_LIST.includes('browser-task'));
  const m = { t: 'job.start', seq: 1, ts: Date.now(), job: 1, title: 'Read', prompt: 'Read', agent: 'claude', timeouts: {}, execution: 'browser', capabilities: ['browser'], identity: 'default' };
  assert.equal(validate(m), null);
  assert.match(validate({ ...m, execution: undefined }), /git execution/);
  assert.match(validate({ ...m, capabilities: [] }), /capability/);
});
