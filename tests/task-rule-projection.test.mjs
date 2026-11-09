import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { before } from 'node:test';
import { openData } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { loadHost, json } from '../src/extension-catalog.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { taskRuleDescription } from '../src/task-rule-description.mjs';
import { taskEffectSyntax } from '../src/task-effect-simulation.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';
import { taskWorkflowSource, taskWorkflowCases } from './fixtures/task-workflow-source.mjs';

const host = loadHost('TaskCreated'), authorize = () => {}, programs = new Map();
const genericYaml = `language: keir/2
domain:
  id: demo.tasks
  version: '5'
  fingerprint: ${host.pins.modelDigest}
entrypoint: TaskCreated
name: format-only-task-example
steps:
  - id: source
    call: tasks.get
    args:
      taskId:
        cel: input.taskId
  - id: eligible
    let:
      cel: '!has(source.dueAt)'
  - id: changed
    call: tasks.update
    when: eligible
    args:
      dueAt:
        cel: 'input.occurredAt + duration("604800s")'
return:
  record:
    status:
      cel: 'eligible ? "UPDATED" : "NO_OP"'
`;
before(async () => {
  const compiler = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN });
  const partial = JSON.parse(taskWorkflowSource(host, 'missing-due'));
  partial.steps[1].let.cel = '!has(source.dueAt) || source.priority == "high"';
  const guardHost = loadHost('TaskBeforeCreate');
  const unsupportedGuard = JSON.parse(taskEffectSyntax(guardHost));
  unsupportedGuard.steps[0].let.cel = 'input.priority == "high" || !input.hasNotes';
  const capturedGuard = JSON.parse(readFileSync(new URL('./fixtures/task-guard-summary.json', import.meta.url)));
  for (const [key, source, definition] of [
    ['complete', genericYaml, host], ['partial', JSON.stringify(partial), host],
    ['unavailable', JSON.stringify(unsupportedGuard), guardHost], ['guard', capturedGuard.source, guardHost],
  ]) {
    const result = await compiler.compile(Buffer.from(source), { definition });
    assert.deepEqual(result.diagnostics, []);
    programs.set(key, { source, definition, artifact: result.artifact });
  }
  const equivalent = await compiler.compile(taskWorkflowSource(host, 'missing-due'), { definition: host });
  assert.deepEqual(equivalent.diagnostics, []);
  assert.deepEqual(equivalent.artifact, programs.get('complete').artifact);
});
const compiler = { compile: async bytes => {
  const program = [...programs.values()].find(program => program.source === Buffer.from(bytes).toString());
  assert.ok(program, 'Compile only an independently checked synthetic source.');
  return { artifact: program.artifact, diagnostics: [] };
} };
function setup(t) {
  const db = openData(':memory:');
  const lifecycle = createLifecycle(db, { compiler });
  t.after(() => db.close());
  return { db, lifecycle };
}
const input = state => ({ extensionId: state.extension.id, revisionId: state.draft.id, draftVersion: state.draftVersion });
async function create(f, coverage = 'complete', { owner = 'maya', name = 'Task customization' } = {}) {
  const { extensionId } = admitTaskDraft(f.db, f.lifecycle, { owner, name });
  const program = programs.get(coverage);
  return f.lifecycle.compile(owner, { extensionId, source: program.source, hookId: program.definition.pins.hook, draftVersion: 0 }, authorize);
}
async function checked(f, { failed = false } = {}) {
  let state = await create(f);
  const cases = taskWorkflowCases(host, 'missing-due');
  if (failed) {
    const mismatch = JSON.parse(cases[0]);
    mismatch.expect.outcome.result.status = 'NO_OP';
    mismatch.expect.consumption.result.status = 'NO_OP';
    cases[0] = JSON.stringify(mismatch);
  }
  state = await f.lifecycle.proposeScenarios('maya', { ...input(state), cases }, authorize);
  return f.lifecycle.simulate('maya', input(state), authorize);
}
function snapshot(db) {
  const schema = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  return { schema, rows: schema.map(({ name }) => db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()) };
}
async function api(t, f) {
  const origin = 'http://127.0.0.1:32123', app = await createApp({ db: f.db, origin, compiler });
  t.after(() => app.close());
  let auth = {};
  const call = (path, body, headers = {}) => app.inject({ url: '/api/' + path, method: body === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...auth, ...headers },
    ...(body === undefined ? {} : { payload: body }) });
  const bootstrap = (await call('session')).json();
  const login = await call('session', { userId: 'maya' }, { 'x-session-context': bootstrap.contextToken });
  assert.equal(login.statusCode, 200);
  auth = { cookie: login.headers['set-cookie'].split(';')[0], 'x-session-context': login.json().contextToken };
  await new Promise(setImmediate);
  return call;
}

test('one checked projection is reused in source, revision, state and collection with no GET writes or renames', async t => {
  const f = setup(t), states = [];
  for (const [coverage, name] of [['complete', 'Task customization'], ['partial', 'My chosen name'], ['unavailable', 'Before save check'], ['guard', 'Chosen check name']])
    states.push(await create(f, coverage, { name }));
  const checkedState = await checked(f);
  const call = await api(t, f);
  const before = snapshot(f.db), changes = f.db.prepare('SELECT total_changes() AS count').get().count;
  f.db.exec('PRAGMA query_only=ON');
  for (const [index, state] of states.entries()) {
    const coverage = ['complete', 'partial', 'unavailable', 'guard'][index], extensionId = state.extension.id, revisionId = state.draft.id;
    const expected = taskRuleDescription(JSON.parse(programs.get(coverage).artifact), programs.get(coverage).definition);
    assert.equal(expected.coverage, coverage === 'guard' ? 'complete' : coverage);
    if (coverage === 'guard') assert.deepEqual(expected.guard.conditions, [
      { field: 'projectId', value: 'summary-project' }, { field: 'priority', value: 'normal' },
    ]);
    assert.deepEqual(f.lifecycle.source('maya', revisionId, extensionId).ruleDescription, expected);
    assert.deepEqual(f.lifecycle.revisionPage('maya', extensionId).rows[0].ruleDescription, expected);
    assert.deepEqual(f.lifecycle.state('maya', extensionId).draft.ruleDescription, expected);
    assert.deepEqual(f.lifecycle.collection('maya').items.find(item => item.extension.id === extensionId).draft.ruleDescription, expected);
    for (const [path, select] of [
      [`extensions/${extensionId}/revisions/${revisionId}`, value => value.ruleDescription],
      [`extensions/${extensionId}/revisions`, value => value.rows[0].ruleDescription],
      [`extensions/${extensionId}`, value => value.draft.ruleDescription],
      ['extensions', value => value.items.find(item => item.extension.id === extensionId).draft.ruleDescription],
    ]) {
      const response = await call(path);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(select(response.json()), expected);
    }
    const reopened = (await call(`extensions/${extensionId}`)).json();
    assert.equal(reopened.extension.name, state.extension.name);
    assert.equal(reopened.approved, false);
    assert.deepEqual(reopened.selection, state.selection);
  }
  const proof = await call(`extensions/${checkedState.extension.id}/evidence/${checkedState.evidence.id}`);
  assert.equal(proof.statusCode, 200, proof.body);
  assert.equal(proof.json().summary.counts.verification.matched, 4);
  assert.equal(proof.json().summary.counts.outcome['handled-problem'], 1);
  assert.equal(f.db.prepare('SELECT total_changes() AS count').get().count, changes);
  assert.deepEqual(snapshot(f.db), before, 'Descriptions and summaries create no stored records, approvals, selections or names.');
  f.db.exec('PRAGMA query_only=OFF');
});

test('associated failed evidence remains displayable and never becomes passing approval', async t => {
  const f = setup(t), state = await checked(f, { failed: true });
  const proof = f.lifecycle.evidence('maya', state.evidence.id, state.extension.id);
  assert.equal(proof.passed, false);
  assert.equal(proof.summary.cases[0].verification, 'mismatched');
  assert.equal(proof.summary.cases[0].outcome, 'mismatch');
  assert.equal(proof.summary.counts.verification.matched, 3);
  assert.throws(() => f.lifecycle.approve('maya', { ...input(state), evidenceId: proof.id }, authorize), { status: 409 });
  assert.equal(f.lifecycle.state('maya', state.extension.id).approved, false);
  const call = await api(t, f), response = await call(`extensions/${state.extension.id}/evidence/${proof.id}`);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().passed, false);
  assert.deepEqual(response.json().summary, proof.summary);
});

test('proof, source, artifact, suite and payload identities must associate exactly before summary projection', async t => {
  const f = setup(t), state = await checked(f), extensionId = state.extension.id, proofId = state.evidence.id;
  const proof = f.db.prepare('SELECT * FROM extension_evidence WHERE id=?').get(proofId);
  const read = () => f.lifecycle.evidence('maya', proofId, extensionId);
  assert.equal(read().summary.counts.verification.matched, 4);
  for (const mutate of [
    row => { row.identity += ' '; }, row => { row.suite_identity = 'sha256:' + '0'.repeat(64); },
    ...['rawSourceDigest', 'artifactDigest', 'compiledSourceDigest', 'suiteDigest'].map(key => row => {
      const payload = JSON.parse(row.payload); payload.identity.dependencies[key] = 'sha256:' + '0'.repeat(64); row.payload = json(payload);
    }),
  ]) {
    const changed = { ...proof }; mutate(changed);
    f.db.prepare('UPDATE extension_evidence SET identity=?,suite_identity=?,payload=? WHERE id=?').run(changed.identity, changed.suite_identity, changed.payload, proofId);
    assert.equal(read().summary, null, mutate.toString());
    assert.equal(read().passed, false);
    f.db.prepare('UPDATE extension_evidence SET identity=?,suite_identity=?,payload=? WHERE id=?').run(proof.identity, proof.suite_identity, proof.payload, proofId);
  }
  const authored = f.db.prepare('SELECT * FROM extension_authored WHERE revision_id=?').get(state.draft.id);
  for (const field of ['source', 'artifact', 'suite']) {
    const changed = field === 'suite' ? authored[field] + ' ' : Buffer.concat([Buffer.from(authored[field]), Buffer.from(' ')]);
    f.db.prepare(`UPDATE extension_authored SET ${field}=? WHERE revision_id=?`).run(changed, state.draft.id);
    assert.equal(read().summary, null, field);
    assert.equal(f.lifecycle.state('maya', extensionId).draft.ruleDescription.coverage, 'unavailable');
    assert.throws(() => f.lifecycle.source('maya', state.draft.id, extensionId), { status: 404 });
    f.db.prepare(`UPDATE extension_authored SET ${field}=? WHERE revision_id=?`).run(authored[field], state.draft.id);
  }
  assert.equal(read().summary.counts.verification.matched, 4);
});

test('foreign owners, another item and another revision never borrow a saved proof summary', async t => {
  const f = setup(t), state = await checked(f), extensionId = state.extension.id, proofId = state.evidence.id;
  const other = await create(f), foreign = await create(f, 'complete', { owner: 'leo' });
  assert.throws(() => f.lifecycle.evidence('maya', proofId, other.extension.id), { status: 404 });
  assert.throws(() => f.lifecycle.evidence('leo', proofId, foreign.extension.id), { status: 404 });
  assert.throws(() => f.lifecycle.source('maya', other.draft.id, extensionId), { status: 404 });
  assert.equal(f.lifecycle.state('maya', other.extension.id).evidence, null);
  const later = await f.lifecycle.compile('maya', { extensionId, source: programs.get('partial').source,
    hookId: 'TaskCreated', draftVersion: state.draftVersion }, authorize);
  assert.equal(later.evidence, null);
  assert.equal(f.lifecycle.currentReviewEvidence('maya', { ...input(later), suiteDigest: state.suiteDigest }), null);
  f.db.prepare('UPDATE extension_evidence SET revision_id=? WHERE id=?').run(later.draft.id, proofId);
  const displaced = f.lifecycle.evidence('maya', proofId, extensionId);
  assert.equal(displaced.revisionId, later.draft.id);
  assert.equal(displaced.summary, null);
  assert.equal(displaced.passed, false);
  const call = await api(t, f);
  for (const path of [`extensions/${other.extension.id}/evidence/${proofId}`, `extensions/${foreign.extension.id}/evidence/${proofId}`,
    `extensions/${extensionId}/revisions/${other.draft.id}`]) assert.equal((await call(path)).statusCode, 404);
});
