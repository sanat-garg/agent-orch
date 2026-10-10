// Rigor levels (#778): projects.rigor 1-5 shapes the planner turn and the reflection prompt, the Rapid top-up, and
// GET /api/orch/rigor-levels' examples (all for the same sample request).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANNER_SYSTEM, plannerTurnPrompt, reflectPrompt, RIGOR_LEVELS, RIGOR_SAMPLE_REQUEST, rigorLevelsView, rigorOf } from '../orchestrator.mjs';

const project = (rigor) => ({ name: 'site', path: '/tmp/site', priority: 50, mode: 'build', rigor });
const planner = (rigor) => plannerTurnPrompt(project(rigor), [], 'Add a contact form to the website', 'env');
const reflect = (rigor, rapid = null) => reflectPrompt(project(rigor), [], '', false, [], null, [], { done: 0, failed: 0 }, 'env', rapid);
const NO_AUDIT = /Do NOT queue AUDIT, audit, security, hardening, infrastructure or edge-case tasks/;

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
  assert.match(planner(2), /^Rigor: 2 · Ship it .*this one suits: most new features, for fast/m);
});

test('levels 1-3 forbid audit, security and edge-case tasks; 4-5 do not', () => {
  for (const l of [1, 2, 3]) { assert.match(planner(l), NO_AUDIT); assert.match(reflect(l), NO_AUDIT); }
  for (const l of [4, 5]) { assert.doesNotMatch(planner(l), NO_AUDIT); assert.doesNotMatch(reflect(l), NO_AUDIT); }
  // Levels 1-3 put new features first and leave security/infrastructure to the owner; 4-5 add them back.
  for (const l of [1, 2, 3]) {
    assert.doesNotMatch(reflect(l), /security, performance, test coverage/);
    assert.match(reflect(l), /Leave security and infrastructure hardening alone unless the owner asked/);
    assert.match(reflect(l), /Favour new,\n {3}user-facing features/);
  }
  assert.match(reflect(5), /security, performance, test coverage/);
  assert.match(reflect(5), /AUDIT\.md/);
});

test('every level asks for new feature ideas drawn from similar open-source projects', () => {
  for (const l of [1, 2, 3, 4, 5]) {
    assert.match(reflect(l), /gh search repos/);
    assert.match(reflect(l), /"Inspiration" in ROADMAP\.md/);
  }
  assert.match(PLANNER_SYSTEM, /Ship features/);
  assert.match(PLANNER_SYSTEM, /gh search repos/);
  // A resumed planner session never re-reads PLANNER_SYSTEM, so every turn carries the one-line version.
  for (const l of [1, 3, 5]) assert.match(planner(l), /^Focus: ship user-visible features fast/m);
});

test('the levels are an even ladder: every dial rises step by step and every step turns some dial up', () => {
  const v = rigorLevelsView();
  for (let i = 1; i < v.length; i++) {
    const [a, b] = [v[i - 1].dials, v[i].dials];
    assert.ok(b.every((d, k) => d.value >= a[k].value), `no dial goes down from ${i} to ${i + 1}`);
    const up = b.reduce((n, d, k) => n + d.value - a[k].value, 0);
    assert.ok(up >= 2 && up <= 7, `${i} → ${i + 1} raises the dials by ${up} notches in all`);
  }
  // Security starts at 4; below it only the owner's explicit ask adds any.
  assert.deepEqual(v.map((l) => l.dials.find((d) => d.key === 'security').value), [0, 0, 0, 2, 4]);
  for (const l of v) for (const d of l.dials) assert.ok(Number.isInteger(d.value) && d.value >= 0 && d.value <= 4 && d.text && d.label);
});

test('the Rapid top-up asks for fewer speculative tasks at lower rigor', () => {
  const rapid = { slots: 12, running: 0, free: 12, ready: 0, requested: 14, workers: { slots: 12, running: 0, free: 12 }, hotFiles: [] };
  const asked = (l) => Number(reflect(l, rapid).match(/queue about (\d+) more/)[1]);
  assert.deepEqual([1, 2, 3, 4, 5].map(asked), [3, 6, 9, 12, 14]);
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
  assert.deepEqual(v.map((l) => l.name), ['Sketch', 'Ship it', 'Solid', 'Robust', 'Hardened']);
  for (const l of v) {
    assert.deepEqual(Object.keys(l).sort(), ['dials', 'example', 'level', 'name', 'summary', 'use']);
    assert.deepEqual(Object.keys(l.example).sort(), ['done_when', 'prompt', 'title']);
    assert.match(l.example.title, /contact form/i);
    assert.match(l.example.prompt, /contact/i);
    assert.ok(l.summary && l.example.done_when);
  }
  assert.equal(new Set(v.map((l) => l.example.done_when)).size, 5, 'the examples differ');
});
