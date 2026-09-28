// Rigor levels (#778): projects.rigor 1-5 shapes the planner turn and the reflection prompt, the Rapid top-up, and
// GET /api/orch/rigor-levels' examples (all for the same sample request).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plannerTurnPrompt, reflectPrompt, RIGOR_LEVELS, RIGOR_SAMPLE_REQUEST, rigorLevelsView, rigorOf } from '../orchestrator.mjs';

const project = (rigor) => ({ name: 'site', path: '/tmp/site', priority: 50, mode: 'build', rigor });
const planner = (rigor) => plannerTurnPrompt(project(rigor), [], 'Add a contact form to the website', 'env');
const reflect = (rigor, rapid = null) => reflectPrompt(project(rigor), [], '', false, [], null, [], { done: 0, failed: 0 }, 'env', rapid);
const NO_AUDIT = /Do NOT queue AUDIT, audit, security, hardening or edge-case tasks/;

test('planner and reflection prompts differ by level and carry that level\'s guidance', () => {
  const plans = [1, 2, 3, 4, 5].map(planner), refls = [1, 2, 3, 4, 5].map((l) => reflect(l));
  assert.equal(new Set(plans).size, 5);
  assert.equal(new Set(refls).size, 5);
  for (const l of RIGOR_LEVELS) {
    const [p, r] = [plans[l.level - 1], refls[l.level - 1]];
    assert.ok(p.includes(`Rigor: ${l.level} · ${l.name}`), `planner context line for ${l.level}`);
    assert.ok(r.includes(`Rigor: ${l.level} · ${l.name}`));
    for (const g of l.guidance) { assert.ok(p.includes(g), `planner ${l.level}: ${g}`); assert.ok(r.includes(g), `reflect ${l.level}: ${g}`); }
    assert.ok(r.includes(`Rigor note: ${l.reflect}`));
    for (const other of RIGOR_LEVELS.filter((o) => o.level !== l.level)) assert.ok(!p.includes(`Rigor: ${other.level} ·`));
  }
  assert.match(planner(2), /^Rigor: 2 · Working product/m);
});

test('levels 1-2 forbid audit, security and edge-case tasks; 3-5 do not', () => {
  for (const l of [1, 2]) { assert.match(planner(l), NO_AUDIT); assert.match(reflect(l), NO_AUDIT); }
  for (const l of [3, 4, 5]) { assert.doesNotMatch(planner(l), NO_AUDIT); assert.doesNotMatch(reflect(l), NO_AUDIT); }
  // The low levels' reflection priorities drop security/test coverage and prefer polishing the BRIEF's features.
  assert.doesNotMatch(reflect(2), /security, performance, test coverage/);
  assert.match(reflect(2), /finishing and polishing/);
  assert.match(reflect(5), /security, performance, test coverage/);
  assert.match(reflect(5), /AUDIT\.md/);
});

test('the Rapid top-up asks for fewer speculative tasks at lower rigor', () => {
  const rapid = { slots: 12, running: 0, free: 12, ready: 0, requested: 14, workers: { slots: 12, running: 0, free: 12 }, hotFiles: [] };
  const asked = (l) => Number(reflect(l, rapid).match(/queue about (\d+) more/)[1]);
  assert.deepEqual([1, 2, 3, 4, 5].map(asked), [2, 4, 6, 14, 14]);
  assert.doesNotMatch(reflect(2, rapid), /bugs from AUDIT\.md/);
  assert.match(reflect(4, rapid), /bugs from AUDIT\.md/);
});

test('rigorOf: 1-5 as stored, anything else is the default 2', () => {
  assert.deepEqual([1, 2, 3, 4, 5, null, undefined, 0, 6, 2.5, 'x'].map((r) => rigorOf({ rigor: r })), [1, 2, 3, 4, 5, 2, 2, 2, 2, 2, 2]);
});

test('rigorLevelsView: 5 levels, each with an example for the same contact-form request', () => {
  const v = rigorLevelsView();
  assert.equal(RIGOR_SAMPLE_REQUEST, 'Add a contact form to the website');
  assert.deepEqual(v.map((l) => l.level), [1, 2, 3, 4, 5]);
  assert.deepEqual(v.map((l) => l.name), ['Just make it work', 'Working product', 'Balanced', 'Thorough', 'Enterprise']);
  for (const l of v) {
    assert.deepEqual(Object.keys(l).sort(), ['example', 'level', 'name', 'summary']);
    assert.deepEqual(Object.keys(l.example).sort(), ['done_when', 'prompt', 'title']);
    assert.match(l.example.title, /contact form/i);
    assert.match(l.example.prompt, /contact/i);
    assert.ok(l.summary && l.example.done_when);
  }
  assert.equal(new Set(v.map((l) => l.example.done_when)).size, 5, 'the examples differ');
});
