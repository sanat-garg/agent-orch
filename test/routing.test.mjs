// Task → agent/model routing: resolution order, route matching, the tasks-block fields, and the DB migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { resolveRoute, routeMatches, normalizeAgent, extractTasks } from '../orchestrator.mjs';

const project = { id: 1, model: 'sonnet' };
const all = () => true;
const routes = [
  { id: 1, project_id: 1, match: 'tests', agent: 'codex', model: 'gpt-5-codex' },
  { id: 2, project_id: null, match: 'tests', agent: 'antigravity', model: null },
  { id: 3, project_id: null, match: 'ui', agent: 'antigravity', model: 'gemini-3.8-flash-high' },
  { id: 4, project_id: 2, match: 'docs', agent: 'codex', model: null },
  { id: 5, project_id: null, match: 'reflect', agent: null, model: 'opus' },
];
const task = (title, extra = {}) => ({ id: 9, kind: 'work', title, ...extra });

test('a task with no explicit agent picks the matching project route first', () => {
  assert.deepEqual(resolveRoute(task('Add unit tests for the parser'), project, routes, all),
    { agent: 'codex', model: 'gpt-5-codex', source: 'project', routeId: 1 });
});

test('then the matching global route', () => {
  const r = resolveRoute(task('Polish the UI header'), project, routes, all);
  assert.deepEqual(r, { agent: 'antigravity', model: 'gemini-3.8-flash-high', source: 'global', routeId: 3 });
  // With the project route gone, 'tests' falls through to its global route.
  assert.equal(resolveRoute(task('Write tests'), project, routes.slice(1), all).agent, 'antigravity');
});

test('then the project default (Claude on project.model)', () => {
  assert.deepEqual(resolveRoute(task('Refactor the scheduler'), project, routes, all), { agent: 'claude', model: 'sonnet', source: 'default' });
  // Another project's route never applies.
  assert.equal(resolveRoute(task('Update docs'), project, routes, all).agent, 'claude');
  assert.deepEqual(resolveRoute(task('x'), { id: 3, model: null }, [], all), { agent: 'claude', model: null, source: 'default' });
});

test('explicit task fields win over routes', () => {
  assert.deepEqual(resolveRoute(task('Add tests', { agent: 'claude', model: 'opus' }), project, routes, all), { agent: 'claude', model: 'opus', source: 'task' });
  assert.deepEqual(resolveRoute(task('Add tests', { agent: 'antigravity' }), project, routes, all), { agent: 'antigravity', model: null, source: 'task' });
  // A model alone implies its agent; an unknown model stays on Claude.
  assert.equal(resolveRoute(task('Add tests', { model: 'gpt-5' }), project, routes, all).agent, 'codex');
  assert.deepEqual(resolveRoute(task('Add tests', { model: 'haiku' }), project, routes, all), { agent: 'claude', model: 'haiku', source: 'task' });
});

test('routes match a task kind; a model-only route keeps Claude', () => {
  assert.deepEqual(resolveRoute({ id: 2, kind: 'reflect', title: 'Reflect: what else should be done?' }, project, routes, all),
    { agent: 'claude', model: 'opus', source: 'global', routeId: 5 });
});

test('an unavailable agent falls back to Claude and says which', () => {
  const r = resolveRoute(task('Add tests'), project, routes, (id) => id !== 'codex');
  assert.deepEqual(r, { agent: 'claude', model: 'sonnet', source: 'project', fellBack: 'codex' });
});

test('routeMatches matches words, plurals and kinds, not substrings', () => {
  assert.ok(routeMatches('tests', { title: 'Add a test for login' }));
  assert.ok(routeMatches('test', { title: 'Testing the API' }));
  assert.ok(routeMatches('refactor', { title: 'Refactors in server.mjs' }));
  assert.ok(routeMatches('UI', { title: 'Tidy the ui' }));
  assert.ok(!routeMatches('ui', { title: 'Build a guide' }));
  assert.ok(!routeMatches('docs', { title: 'Fix Docker' }));
  assert.ok(routeMatches('work', { kind: 'work', title: 'anything' }));
  assert.ok(routeMatches('planning', { kind: 'plan', title: '' }));
  assert.ok(!routeMatches('', { kind: 'work', title: 'anything' }));
});

test('normalizeAgent accepts aliases and rejects unknown agents', () => {
  assert.equal(normalizeAgent('Gemini'), 'antigravity');
  assert.equal(normalizeAgent('agy'), 'antigravity');
  assert.equal(normalizeAgent('codex'), 'codex');
  assert.equal(normalizeAgent('cursor'), null);
  assert.equal(normalizeAgent(null), null);
});

test('extractTasks reads per-task agent/model and top-level routes', () => {
  const block = {
    tasks: [
      { title: 'Write tests', prompt: 'p', agent: 'Codex', model: 'gpt-5-codex' },
      { title: 'Plain', prompt: 'p', agent: 'nope' },
    ],
    routes: [
      { match: 'Tests', agent: 'codex' },
      { match: 'plan', model: 'opus', scope: 'global', note: 'owner: use opus for planning' },
      { match: 'ui', agent: 'gemini', model: 'gemini-3.8-flash-high', scope: 'weird' },
      { match: 'nothing' },
      { agent: 'codex' },
      { remove: '#4' },
      { remove: 'x' },
    ],
  };
  const [clean, payload] = extractTasks(`Saved.\n\n\`\`\`agent-orch-tasks\n${JSON.stringify(block)}\n\`\`\``);
  assert.equal(clean, 'Saved.');
  assert.equal(payload.tasks[0].agent, 'codex');
  assert.equal(payload.tasks[0].model, 'gpt-5-codex');
  assert.equal(payload.tasks[1].agent, null);
  assert.equal(payload.tasks[1].model, null);
  assert.deepEqual(payload.routes, [
    { match: 'tests', agent: 'codex', model: null, scope: 'project', note: null },
    { match: 'plan', agent: null, model: 'opus', scope: 'global', note: 'owner: use opus for planning' },
    { match: 'ui', agent: 'antigravity', model: 'gemini-3.8-flash-high', scope: 'project', note: null },
    { remove: 4 },
  ]);
  // A routes-only block still parses.
  const [, only] = extractTasks('```agent-orch-tasks\n{"tasks": [], "routes": [{"match": "docs", "agent": "codex"}]}\n```');
  assert.equal(only.tasks.length, 0);
  assert.equal(only.routes[0].agent, 'codex');
});

test('createOrchestrator adds agent/model columns and the routes table to an existing DB', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-routes-'));
  try {
    fs.mkdirSync(path.join(dataDir, 'orchestrator'), { recursive: true });
    const file = path.join(dataDir, 'orchestrator', 'agent-orch.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'work', title TEXT NOT NULL,
      prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', priority INTEGER NOT NULL DEFAULT 50,
      urgency TEXT NOT NULL DEFAULT 'normal', deadline REAL, depends_on INTEGER, done_when TEXT,
      continuations INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'user', session_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, not_before REAL NOT NULL DEFAULT 0, result TEXT, last_error TEXT,
      verify_output TEXT, commit_sha TEXT, created_at REAL NOT NULL, started_at REAL, finished_at REAL);
      INSERT INTO tasks(project_id,title,prompt,status,created_at) VALUES(1,'old','p','done',0);`);
    old.close();
    const script = `import { createOrchestrator } from ${JSON.stringify(new URL('../orchestrator.mjs', import.meta.url).href)};
      createOrchestrator({ dataDir: process.argv[1], claudeEnv: {}, getLimits: () => ({}), broadcast() {}, emitChat() {}, convoExists: () => false });
      process.exit(0);`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script, dataDir], { stdio: 'ignore' });
    const db = new DatabaseSync(file);
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(cols('tasks').includes('agent') && cols('tasks').includes('model'));
    assert.ok(cols('runs').includes('agent'));
    assert.deepEqual(cols('routes'), ['id', 'project_id', 'match', 'agent', 'model', 'note', 'created_at']);
    assert.equal(db.prepare('SELECT title, agent FROM tasks').get().agent, null);
    db.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
