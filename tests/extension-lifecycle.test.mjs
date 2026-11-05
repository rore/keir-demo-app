import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openData } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { digest, json, TASK_HOOK } from '../src/extension-catalog.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { runTaskEffectSimulation } from '../src/task-effect-simulation.mjs';
import { createApp } from '../src/app.mjs';
import { taskCustomizationFixture } from './fixtures/task-customization.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

const authorized = () => {};
const denied = () => { throw Object.assign(new Error('Session changed'), { status: 401 }); };
function itemId(lifecycle, owner = 'maya') {
  const items = lifecycle.collection(owner).items.filter(item => !item.retired);
  assert.equal(items.length, 1, 'Fixture has one explicitly scoped task customization.');
  return items[0].extension.id;
}
const currentInput = state => ({ extensionId: state.extension.id, revisionId: state.draft.id, draftVersion: state.draftVersion });
function create(db, options = {}) { return createLifecycle(db, { compiler: createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN }), ...options }); }
function setup(t, options) {
  const db = openData(':memory:'); t.after(() => db.close());
  const lifecycle = create(db, options);
  for (const owner of ['maya', 'leo', 'sam']) admitTaskDraft(db, lifecycle, { owner, extensionId: owner + '-task-fixture' });
  return { db, lifecycle };
}
const fixtureFor = title => taskCustomizationFixture({ title: title ?? 'Customer follow-up title' });
async function load(lifecycle, owner = 'maya', title) {
  const fixture = fixtureFor(title), before = lifecycle.state(owner, itemId(lifecycle, owner));
  let state = await lifecycle.compile(owner, { extensionId: before.extension.id, hookId: TASK_HOOK, source: fixture.source,
    label: title ?? 'Customer follow-up title', draftVersion: before.draftVersion }, authorized);
  return lifecycle.proposeScenarios(owner, { ...currentInput(state), cases: fixture.cases }, authorized);
}
async function approved(lifecycle, owner = 'maya', title) {
  let state = await load(lifecycle, owner, title), input = currentInput(state);
  state = await lifecycle.simulate(owner, input, authorized);
  assert.equal(state.evidence.passed, true);
  state = lifecycle.approve(owner, { ...input, evidenceId: state.evidence.id }, authorized);
  return { state, input };
}
const activate = (lifecycle, state, owner = 'maya') => lifecycle.activate(owner, { ...currentInput(state),
  generation: state.selection.generation, evidenceId: state.approvedEvidenceId }, authorized);
const nativeTasks = db => db.prepare('SELECT * FROM tasks ORDER BY id').all();

test('actual task evidence, separate approval/activation and named rollback affect only this owner', async t => {
  const { db, lifecycle } = setup(t), legacy = nativeTasks(db);
  assert.equal(lifecycle.collection('maya').selection.revision, null);
  assert.equal(lifecycle.collection('sam').selection.revision, null);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_approvals').get().n, 0);
  const first = await approved(lifecycle, 'maya', 'First title');
  const proof = lifecycle.evidence('maya', first.state.evidence.id, first.state.extension.id);
  assert.deepEqual(proof.reports.map(item => item.id), ['matching-project', 'other-project', 'unfinished-task', 'missing-task', 'access-denied', 'read-unavailable']);
  assert.ok(proof.reports.every(item => item.report.status === 'PASS'));
  assert.equal(proof.reports[0].report.observed.effect, 'CONFIRMED');
  assert.deepEqual(proof.reports[1].report.observed.createdTasks, []);
  assert.equal(first.state.selection.revision, null, 'Approval alone selects nothing.');
  const selected = activate(lifecycle, first.state);
  lifecycle.disable('maya', { extensionId: selected.extension.id, generation: selected.selection.generation }, authorized);
  const second = await approved(lifecycle, 'maya', 'Second title');
  assert.throws(() => lifecycle.rollback('maya', { extensionId: second.state.extension.id, revisionId: second.state.draft.id,
    generation: second.state.selection.generation }, authorized), { status: 409 });
  const restored = lifecycle.rollback('maya', { extensionId: second.state.extension.id, revisionId: first.state.draft.id,
    generation: second.state.selection.generation }, authorized);
  assert.equal(restored.selection.revision.id, first.state.draft.id);
  assert.equal(lifecycle.collection('leo').selection.revision, null);
  assert.deepEqual(nativeTasks(db), legacy, 'Checking, approval and activation create no task and preserve native rows.');
});

test('approved evidence stays pinned when a later sample run becomes latest', async t => {
  const { lifecycle } = setup(t), { state, input } = await approved(lifecycle), first = state.approvedEvidenceId;
  const second = await lifecycle.simulate('maya', input, authorized);
  assert.notEqual(second.evidence.id, first);
  assert.equal(second.approvedEvidenceId, first);
  assert.equal(second.evidence.id, second.evidenceHistory[0].id);
  assert.equal(lifecycle.state('maya', itemId(lifecycle)).approvedEvidenceId, first);
  assert.equal(lifecycle.state('leo', itemId(lifecycle, 'leo')).approvedEvidenceId, null);
  const selected = activate(lifecycle, second);
  assert.equal(selected.selection.approvedEvidenceId, first);
  assert.equal(lifecycle.approve('maya', { ...input, evidenceId: second.evidence.id }, authorized).approvedEvidenceId, second.evidence.id);
  const replacement = await load(lifecycle, 'maya', 'Later title');
  assert.equal(replacement.approvedEvidenceId, null);
  assert.throws(() => lifecycle.activate('maya', { ...input, generation: replacement.selection.generation, evidenceId: first }, authorized), { status: 409 });
});

test('an eligible task operator revision with no approval requires an explicit null evidence expectation', async t => {
  const { db, lifecycle } = setup(t), state = await load(lifecycle);
  db.prepare("UPDATE extension_revisions SET provenance='operator' WHERE id=?").run(state.draft.id);
  db.prepare("INSERT INTO extension_history(owner_id,revision_id,generation,operation) VALUES (?,?,?,'operator')")
    .run(state.owner.id, state.draft.id, state.selection.generation);
  const input = { ...currentInput(state), generation: state.selection.generation };
  assert.throws(() => lifecycle.activate('maya', input, authorized), { status: 409 });
  const active = lifecycle.activate('maya', { ...input, evidenceId: null }, authorized);
  assert.equal(active.selection.revision.id, state.draft.id);
  assert.equal(active.selection.revision.provenance, 'operator');
  assert.equal(active.selection.approvedEvidenceId, null);
  assert.equal(active.selection.eligible, true);
});

test('captured admission keeps exact approval authority without rereading deployment files', async t => {
  const { db, lifecycle } = setup(t), { state } = await approved(lifecycle);
  const active = activate(lifecycle, state), revisionId = active.draft.id, itemId = active.extension.id;
  const pins = JSON.parse(db.prepare("SELECT binding_pins FROM extension_selections WHERE owner_id='maya' AND hook_id=?").get(TASK_HOOK).binding_pins);
  assert.equal(Object.hasOwn(pins, 'profile'), false); assert.equal(pins.definitionId, 'daymark.task-completed/3');
  assert.equal(pins.approvedEvidenceId, state.approvedEvidenceId); assert.equal(Object.hasOwn(pins, 'qualification'), false);
  const context = { owner: 'maya', itemId, revisionId, pins };
  const later = await lifecycle.simulate('maya', currentInput(active), authorized);
  const reapproved = lifecycle.approve('maya', { ...currentInput(later), evidenceId: later.evidence.id }, authorized);
  assert.notEqual(reapproved.approvedEvidenceId, pins.approvedEvidenceId);
  assert.equal(reapproved.selection.approvedEvidenceId, pins.approvedEvidenceId, 'active inspection retains the proof captured at activation');
  const read = fs.readFileSync;
  fs.readFileSync = () => { throw new Error('Admission must use its trusted definition snapshot'); };
  syncBuiltinESMExports();
  try {
    assert.equal(lifecycle.admissionCurrent(context), true);
    assert.equal(lifecycle.admissionCurrent({ ...context, pins: { ...pins, approvedEvidenceId: null } }), false);
    assert.equal(lifecycle.admissionCurrent({ ...context, owner: 'leo' }), false);
    db.prepare('UPDATE extension_evidence SET payload=? WHERE id=?').run('{}', pins.approvedEvidenceId);
    assert.equal(lifecycle.admissionCurrent(context), false);
  } finally { fs.readFileSync = read; syncBuiltinESMExports(); }
});

test('active inspection exposes only its exact approved evidence, never a newer run or draft', async t => {
  const { db, lifecycle } = setup(t), first = await approved(lifecycle);
  const id = first.state.extension.id, proof = first.state.approvedEvidenceId;
  let state = activate(lifecycle, first.state);
  assert.equal(state.selection.approvedEvidenceId, proof);
  state = await lifecycle.simulate('maya', first.input, authorized);
  assert.notEqual(state.evidence.id, proof); assert.equal(state.selection.approvedEvidenceId, proof);
  state = await load(lifecycle, 'maya', 'New checked title');
  state = await lifecycle.simulate('maya', currentInput(state), authorized);
  assert.notEqual(state.evidence.id, proof); assert.equal(state.approvedEvidenceId, null); assert.equal(state.selection.approvedEvidenceId, proof);
  assert.equal(lifecycle.collection('leo').selection.approvedEvidenceId, null);
  assert.equal(lifecycle.collection('sam').selection.approvedEvidenceId, null);
  db.prepare('UPDATE extension_evidence SET payload=? WHERE id=?').run('{}', proof);
  state = lifecycle.state('maya', id);
  assert.equal(state.selection.eligible, false); assert.equal(state.selection.approvedEvidenceId, null);
});

test('an unavailable runtime archive blocks execution and preserves exact saved source and evidence', async t => {
  const { db, lifecycle } = setup(t), { state } = await approved(lifecycle);
  const active = activate(lifecycle, state), { id } = active.extension, revision = active.draft.id;
  const source = lifecycle.source('maya', revision, id);
  const proof = lifecycle.evidence('maya', active.approvedEvidenceId, id);
  const read = fs.readFileSync;
  fs.readFileSync = (path, ...args) => {
    if (String(path).endsWith('/vendor/keir-runtime-node-0.1.0.tgz')) throw new Error('Runtime archive unavailable');
    return read(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const reopened = createLifecycle(db);
    assert.equal(reopened.executionAvailability().available, false);
    assert.equal(reopened.state('maya', id).selection.eligible, false);
    assert.deepEqual(reopened.source('maya', revision, id), source);
    assert.deepEqual(reopened.evidence('maya', proof.id, id), proof);
    assert.throws(() => reopened.execution('maya', revision, id), { status: 503 });
  } finally { fs.readFileSync = read; syncBuiltinESMExports(); }
});

test('two source-owned customer titles use the same generic adapters and independently expected suites', async t => {
  const { lifecycle } = setup(t);
  for (const title of ['First customer title', 'Different customer title']) {
    const { state } = await approved(lifecycle, 'maya', title), proof = lifecycle.evidence('maya', state.evidence.id, state.extension.id);
    assert.equal(proof.reports[0].expected.createdTasks[0].title, title);
    assert.equal(proof.reports[0].report.observed.createdTasks[0].title, title);
    assert.deepEqual(proof.reports[0].report.calls.map(call => call.capability), ['tasks.get', 'tasks.create']);
    assert.equal(proof.reports.length, 6);
  }
});

test('stale draft rejects old activation with unchanged generation and never-active work cannot roll back', async t => {
  const { lifecycle } = setup(t), { state, input } = await approved(lifecycle);
  await load(lifecycle, 'maya', 'Replacement title');
  assert.throws(() => lifecycle.activate('maya', { ...input, generation: state.selection.generation,
    evidenceId: state.approvedEvidenceId }, authorized), { status: 409 });
  assert.throws(() => lifecycle.rollback('maya', { extensionId: state.extension.id, revisionId: input.revisionId,
    generation: state.selection.generation }, authorized), { status: 409 });
});

test('same-generation transitions admit only one and away-and-back invalidates the same captured artifact', async t => {
  const { lifecycle } = setup(t), first = await approved(lifecycle);
  const state = activate(lifecycle, first.state), original = lifecycle.capture('maya');
  lifecycle.disable('maya', { extensionId: state.extension.id, generation: state.selection.generation }, authorized);
  assert.throws(() => lifecycle.disable('maya', { extensionId: state.extension.id, generation: state.selection.generation }, authorized), { status: 409 });
  lifecycle.rollback('maya', { extensionId: state.extension.id, revisionId: original.revisionId, generation: state.selection.generation + 1 }, authorized);
  assert.equal(lifecycle.current(original), false);
  const captured = lifecycle.capture('maya');
  lifecycle.disable('maya', { extensionId: state.extension.id, generation: captured.generation }, authorized);
  assert.equal(lifecycle.current(captured), false);
});

test('foreign IDs, session revocation, forged dependencies and incomplete or reordered reports fail closed', async t => {
  const { db, lifecycle } = setup(t), { state, input } = await approved(lifecycle);
  assert.throws(() => lifecycle.evidence('leo', state.evidence.id, itemId(lifecycle, 'leo')), { status: 404 });
  assert.throws(() => lifecycle.approve('leo', { ...input, extensionId: itemId(lifecycle, 'leo'), evidenceId: state.evidence.id }, authorized), { status: 409 });
  assert.throws(() => lifecycle.disable('maya', { extensionId: state.extension.id, generation: 0 }, denied), { status: 401 });
  const original = db.prepare('SELECT payload FROM extension_evidence WHERE id=?').get(state.evidence.id).payload;
  for (const alter of [p => p.reports.pop(), p => p.reports.reverse(), p => { p.reports[0].report.status = 'FAIL'; },
    p => { p.identity.fixtureVersion = 'forged'; }, p => { p.reports[0].report.native.effects = []; },
    p => { p.reports[0].report.calls[1].args.title = 'Forged title'; }]) {
    const payload = JSON.parse(original); alter(payload);
    db.prepare('UPDATE extension_evidence SET payload=? WHERE id=?').run(JSON.stringify(payload), state.evidence.id);
    assert.equal(lifecycle.state('maya', state.extension.id).approved, false);
    assert.equal(lifecycle.state('maya', state.extension.id).approvedEvidenceId, null);
    assert.throws(() => activate(lifecycle, state), { status: 409 });
  }
  db.prepare('UPDATE extension_evidence SET payload=? WHERE id=?').run(original, state.evidence.id);
  db.prepare("UPDATE extension_revisions SET identity='{}' WHERE id=?").run(input.revisionId);
  assert.equal(lifecycle.state('maya', state.extension.id).approvedEvidenceId, null);
  assert.throws(() => activate(lifecycle, state), { status: 409 });
});

test('a malformed later scenario prevents any dispatch or saved evidence', async t => {
  let simulations = 0;
  const { db, lifecycle } = setup(t, { runTaskSimulation: async () => { simulations++; assert.fail('Preflight must reject the whole suite'); } });
  const state = await load(lifecycle), input = currentInput(state), examples = fixtureFor().cases;
  const malformed = [examples[0], examples[1].replace('"format":', '"format": "keir-scenario/1", "format":')];
  const evidenceCount = () => db.prepare('SELECT count(*) AS count FROM extension_evidence').get().count;
  await assert.rejects(lifecycle.proposeScenarios('maya', { ...input, cases: malformed }, authorized),
    { status: 400, diagnostics: [{ code: 'INVALID_SCENARIO', path: '/cases/1' }] });
  assert.equal(lifecycle.state('maya', input.extensionId).revisionId, input.revisionId);
  assert.equal(evidenceCount(), 0);

  const suite = json(malformed);
  db.prepare('UPDATE extension_authored SET suite=? WHERE revision_id=?').run(suite, input.revisionId);
  db.prepare('UPDATE extension_revisions SET identity=? WHERE id=?')
    .run(json({ ...state.draft.pins, suiteDigest: digest(suite) }), input.revisionId);
  await assert.rejects(lifecycle.simulate('maya', input, authorized), { status: 400 });
  assert.equal(simulations, 0);
  assert.equal(evidenceCount(), 0);
});

test('an independently wrong valid expectation runs the actual simulator and cannot create approval', async t => {
  const { lifecycle } = setup(t, { runTaskSimulation: options => {
    const scenarios = options.scenarios.map(text => JSON.parse(text));
    scenarios[0].expect.outcome.result.status = 'NO_OP'; scenarios[0].expect.consumption.result.status = 'NO_OP';
    return runTaskEffectSimulation({ ...options, scenarios: scenarios.map(row => JSON.stringify(row)) });
  } });
  const loaded = await load(lifecycle), state = await lifecycle.simulate('maya', currentInput(loaded), authorized);
  assert.equal(state.evidence.passed, false);
  const report = lifecycle.evidence('maya', state.evidence.id, state.extension.id).reports[0].report;
  assert.equal(report.status, 'FAIL'); assert.equal(report.observed.effect, 'CONFIRMED');
  assert.throws(() => lifecycle.approve('maya', { ...currentInput(state), evidenceId: state.evidence.id }, authorized), { status: 409 });
});

test('simulation slots reject concurrent owner work and stale draft settlement leaves no evidence', async t => {
  let release, entered, first = true;
  t.after(() => release?.());
  const started = new Promise(resolve => { entered = resolve; });
  const { db, lifecycle } = setup(t, { runTaskSimulation: async options => {
    if (first) { first = false; entered(); await new Promise(resolve => { release = resolve; }); }
    return runTaskEffectSimulation(options);
  } });
  const loaded = await load(lifecycle), input = currentInput(loaded), pending = lifecycle.simulate('maya', input, authorized);
  await started;
  await assert.rejects(lifecycle.simulate('maya', input, authorized), { status: 429 });
  await load(lifecycle, 'maya', 'A newer draft');
  release(); await assert.rejects(pending, { status: 409 });
  assert.equal(db.prepare('SELECT count(*) n FROM extension_evidence').get().n, 0);
  assert.equal((await lifecycle.simulate('maya', currentInput(lifecycle.state('maya', input.extensionId)), authorized)).evidence.passed, true);
});

test('owner history and restore metadata are bounded and historical evidence remains immutable', async t => {
  const { lifecycle } = setup(t), { state } = await approved(lifecycle);
  const saved = lifecycle.evidence('maya', state.evidence.id, state.extension.id);
  let current = activate(lifecycle, state);
  for (let n = 0; n < 25; n++) {
    current = lifecycle.disable('maya', { extensionId: state.extension.id, generation: current.selection.generation }, authorized);
    current = lifecycle.rollback('maya', { extensionId: state.extension.id, revisionId: state.draft.id, generation: current.selection.generation }, authorized);
  }
  assert.equal(current.history.length, 20);
  const page = lifecycle.history('maya', undefined, state.extension.id);
  assert.equal(page.rows.length, 20); assert.ok(page.next);
  assert.ok(lifecycle.history('maya', page.next, state.extension.id).rows.length > 0);
  assert.deepEqual(lifecycle.evidence('maya', state.evidence.id, state.extension.id), saved);
  assert.ok(Buffer.byteLength(JSON.stringify(current)) < 262144); assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 131072);
});

test('two global simulations reject a third owner before preparation; revoked sessions and errors release slots', async t => {
  const gates = [], entered = [];
  t.after(() => gates.forEach(release => release()));
  let start; const ready = new Promise(resolve => { start = resolve; });
  const { db, lifecycle } = setup(t, { runTaskSimulation: async options => {
    entered.push(entered.length);
    await new Promise(resolve => { gates.push(resolve); if (gates.length === 2) start(); });
    return runTaskEffectSimulation(options);
  } });
  const inputs = {};
  for (const owner of ['maya', 'leo', 'sam']) inputs[owner] = currentInput(await load(lifecycle, owner));
  let live = true;
  const first = lifecycle.simulate('maya', inputs.maya, () => { if (!live) denied(); });
  const second = lifecycle.simulate('leo', inputs.leo, authorized);
  await ready;
  await assert.rejects(lifecycle.simulate('sam', inputs.sam, authorized), { status: 429 }); assert.deepEqual(entered, [0, 1]);
  live = false; gates.forEach(release => release());
  await assert.rejects(first, { status: 401 }); assert.equal((await second).evidence.passed, true);
  assert.equal(db.prepare("SELECT count(*) n FROM extension_evidence WHERE owner_id='maya'").get().n, 0);
  const failing = create(db, { runTaskSimulation: async () => { throw new Error('Fixture failure'); } });
  for (let n = 0; n < 2; n++) await assert.rejects(failing.simulate('maya', inputs.maya, authorized), /Fixture failure/);
});

test('oversized evidence is rejected before persistence and invalid assets never become rollback targets', async t => {
  const { db, lifecycle } = setup(t, { runTaskSimulation: async options => {
    const result = await runTaskEffectSimulation(options); result.reports[0].report.extra = 'x'.repeat(131072); return result;
  } });
  const state = await load(lifecycle);
  await assert.rejects(lifecycle.simulate('maya', currentInput(state), authorized), { status: 413 });
  assert.equal(db.prepare('SELECT count(*) n FROM extension_evidence').get().n, 0);
  const good = create(db), { state: checked } = await approved(good), selected = activate(good, checked);
  db.prepare("UPDATE extension_revisions SET identity='malformed' WHERE id=?").run(selected.draft.id);
  assert.equal(good.state('maya', selected.extension.id).selection.eligible, false); assert.equal(good.capture('maya'), null);
  assert.throws(() => good.rollback('maya', { extensionId: selected.extension.id, revisionId: selected.draft.id,
    generation: selected.selection.generation }, authorized), { status: 409 });
});

test('transaction-time reauthorization rolls back selection and history atomically', async t => {
  const { db, lifecycle } = setup(t), { state } = await approved(lifecycle);
  const originalHistory = db.prepare('SELECT * FROM extension_history ORDER BY id').all();
  let checks = 0;
  assert.throws(() => lifecycle.activate('maya', { ...currentInput(state), generation: state.selection.generation,
    evidenceId: state.approvedEvidenceId }, () => { if (++checks === 2) denied(); }), { status: 401 });
  assert.deepEqual(lifecycle.state('maya', state.extension.id), state);
  assert.deepEqual(db.prepare('SELECT * FROM extension_history ORDER BY id').all(), originalHistory);
  const selected = activate(lifecycle, state);
  const before = lifecycle.state('maya', selected.extension.id), history = db.prepare('SELECT * FROM extension_history ORDER BY id').all();
  checks = 0;
  assert.throws(() => lifecycle.disable('maya', { extensionId: selected.extension.id, generation: selected.selection.generation },
    () => { if (++checks === 2) denied(); }), { status: 401 });
  assert.deepEqual(lifecycle.state('maya', selected.extension.id), before);
  assert.deepEqual(db.prepare('SELECT * FROM extension_history ORDER BY id').all(), history);
});

test('source names do not determine authority and a third owner selects only their own authored revision', async t => {
  const { db, lifecycle } = setup(t), before = nativeTasks(db), { state } = await approved(lifecycle, 'sam');
  const result = activate(lifecycle, state, 'sam');
  assert.equal(result.owner.id, 'sam'); assert.equal(result.selection.revision.provenance, 'customer');
  assert.equal(lifecycle.collection('maya').selection.revision, null); assert.equal(lifecycle.collection('leo').selection.revision, null);
  assert.throws(() => lifecycle.source('maya', state.draft.id, state.extension.id), { status: 404 });
  assert.deepEqual(nativeTasks(db), before);
});

test('real source compilation, independent suite edits and exact A/B approval/use survive restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'keir-task-authored-'));
  let db = openData(join(directory, 'app.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true }); });
  let lifecycle = create(db);
  admitTaskDraft(db, lifecycle, { extensionId: 'maya-task-fixture' });
  const legacy = nativeTasks(db), fixture = fixtureFor(), id = itemId(lifecycle);
  const duplicate = fixture.source.replace('"language": "keir/1"', '"language": "keir/1", "language": "keir/1"');
  await assert.rejects(lifecycle.compile('maya', { extensionId: id, hookId: TASK_HOOK, source: duplicate, draftVersion: 0 }, authorized), { status: 422 });
  assert.equal(lifecycle.state('maya', id).draftVersion, 0);
  let state = await lifecycle.compile('maya', { extensionId: id, hookId: TASK_HOOK, source: fixture.source, draftVersion: 0 }, authorized);
  assert.equal(state.draft.suiteDigest, null); assert.equal(state.draft.pins.rawSourceDigest, digest(Buffer.from(fixture.source)));
  assert.notEqual(state.draft.pins.rawSourceDigest, state.draft.pins.compiledSourceDigest);
  const sourceId = state.draft.id;
  await assert.rejects(lifecycle.simulate('maya', currentInput(state), authorized), { status: 409 });
  const wrong = JSON.parse(fixture.cases[0]); wrong.expect.outcome.result.status = 'NO_OP'; wrong.expect.consumption.result.status = 'NO_OP';
  state = await lifecycle.proposeScenarios('maya', { ...currentInput(state), cases: [JSON.stringify(wrong)] }, authorized);
  assert.notEqual(state.draft.id, sourceId);
  state = await lifecycle.simulate('maya', currentInput(state), authorized); assert.equal(state.evidence.passed, false);
  assert.throws(() => lifecycle.approve('maya', { ...currentInput(state), evidenceId: state.evidence.id }, authorized), { status: 409 });
  state = await lifecycle.proposeScenarios('maya', { ...currentInput(state), cases: [fixture.cases[0]] }, authorized);
  state = await lifecycle.simulate('maya', currentInput(state), authorized); assert.equal(state.evidence.passed, true);
  const a = state.draft, ea = state.evidence.id;
  state = lifecycle.approve('maya', { ...currentInput(state), evidenceId: ea }, authorized); assert.equal(state.selection.revision, null);
  state = activate(lifecycle, state);
  while (state.selection.generation < 7) state = lifecycle.rollback('maya', { extensionId: id, revisionId: a.id, generation: state.selection.generation }, authorized);
  state = await lifecycle.proposeScenarios('maya', { ...currentInput(state), cases: fixture.cases.slice(0, 2) }, authorized);
  const b = state.draft;
  assert.notEqual(b.id, a.id); assert.equal(b.pins.artifactDigest, a.pins.artifactDigest); assert.notEqual(b.suiteDigest, a.suiteDigest);
  assert.equal(state.approved, false); assert.equal(state.approvedEvidenceId, null); assert.equal(state.selection.revision.id, a.id);
  assert.equal(state.selection.eligible, true); assert.equal(state.selection.generation, 7);
  assert.throws(() => lifecycle.approve('maya', { ...currentInput(state), evidenceId: ea }, authorized), { status: 409 });
  state = await lifecycle.simulate('maya', currentInput(state), authorized); const eb = state.evidence.id;
  state = lifecycle.approve('maya', { ...currentInput(state), evidenceId: eb }, authorized); assert.equal(state.selection.revision.id, a.id);
  db.close(); db = openData(join(directory, 'app.sqlite')); lifecycle = create(db);
  state = lifecycle.state('maya', id);
  assert.equal(state.draft.id, b.id); assert.equal(state.approvedEvidenceId, eb); assert.equal(state.selection.revision.id, a.id);
  assert.equal(lifecycle.evidence('maya', ea, id).passed, true);
  state = activate(lifecycle, state); assert.equal(state.selection.generation, 8); assert.equal(state.selection.revision.id, b.id);
  assert.ok(state.restoreTargets.some(row => row.id === a.id));
  state = lifecycle.rollback('maya', { extensionId: id, revisionId: a.id, generation: 8 }, authorized); assert.equal(state.selection.revision.id, a.id);
  assert.deepEqual(nativeTasks(db), legacy);
});

function readOnlyProgram(steps) {
  const source = JSON.parse(fixtureFor().source);
  source.steps = steps.length ? steps.map(id => ({ id, call: 'tasks.get', args: { taskId: { cel: 'input.taskId' } } })) : [{ id: 'constant', let: { cel: 'true' } }];
  source.return = { record: { status: { cel: steps.length ? `${steps.at(-1)}.status == "COMPLETED" ? "NO_OP" : "NO_OP"` : 'constant ? "NO_OP" : "CREATED"' } } };
  const calls = steps.map(step => ({ step, capability: 'tasks.get', version: '2', args: { taskId: 'task1' }, protectedArgs: { actorId: 'user1' } }));
  const trace = [{ event: 'INVOCATION_START' }, ...(steps.length ? steps.flatMap(step => [{ event: 'STEP_START', step },
    { event: 'CALL_DISPATCHED', step, capability: 'tasks.get' }, { event: 'CALL_SUCCEEDED', step, capability: 'tasks.get' }])
    : [{ event: 'STEP_START', step: 'constant' }, { event: 'VALUE_BOUND', step: 'constant' }]), { event: 'RETURNED' }, { event: 'TERMINATED' }];
  const outcome = { classification: 'COMPLETED', result: { status: 'NO_OP' }, effects: [], trace: trace.map((event, sequence) => ({ sequence, ...event })) };
  return { source: JSON.stringify(source), row: { format: 'keir-scenario/1', id: 'normal', given: { input: { taskId: 'task1' }, fixture: 'normal' },
    stubs: calls.map(call => ({ ...call, response: { kind: 'SUCCESS', value: { id: 'task1', projectId: 'project1', status: 'COMPLETED', title: 'Example task' } } })),
    expect: { outcome, calls, consumption: { status: 'REPORTED', classification: 'COMPLETED', result: outcome.result, effects: [] } } } };
}
test('actual zero-call and renamed repeated-read task programs preserve bindings, call order and intended rejection', async t => {
  const { lifecycle } = setup(t);
  for (const steps of [[], ['firstTask', 'secondTask']]) {
    const { source, row } = readOnlyProgram(steps), before = lifecycle.state('maya', itemId(lifecycle));
    let state = await lifecycle.compile('maya', { extensionId: before.extension.id, hookId: TASK_HOOK, source, draftVersion: before.draftVersion }, authorized);
    state = await lifecycle.proposeScenarios('maya', { ...currentInput(state), cases: [JSON.stringify(row)] }, authorized);
    state = await lifecycle.simulate('maya', currentInput(state), authorized); assert.equal(state.evidence.passed, true);
    state = lifecycle.approve('maya', { ...currentInput(state), evidenceId: state.evidence.id }, authorized); state = activate(lifecycle, state);
    const proof = lifecycle.evidence('maya', state.evidence.id, state.extension.id);
    assert.equal(proof.reports[0].report.calls.length, steps.length); assert.deepEqual(proof.reports[0].report.observed.createdTasks, []);
    if (steps.length) {
      const failed = { classification: 'BUSINESS_REJECTION', error: { code: 'TASK_NOT_FOUND', path: '/steps/0' }, effects: [], trace: [
        { sequence: 0, event: 'INVOCATION_START' }, { sequence: 1, event: 'STEP_START', step: steps[0] },
        { sequence: 2, event: 'CALL_DISPATCHED', step: steps[0], capability: 'tasks.get' }, { sequence: 3, event: 'TERMINATED', code: 'TASK_NOT_FOUND' }] };
      row.stubs = [{ ...row.expect.calls[0], response: { kind: 'BUSINESS_REJECTION', code: 'TASK_NOT_FOUND' } }];
      row.expect = { outcome: failed, calls: [row.expect.calls[0]], consumption: { status: 'REPORTED', classification: failed.classification, error: failed.error, effects: [] } };
      state = await lifecycle.proposeScenarios('maya', { ...currentInput(state), cases: [JSON.stringify(row)] }, authorized);
      state = await lifecycle.simulate('maya', currentInput(state), authorized); assert.equal(state.evidence.passed, true);
      assert.equal(lifecycle.approve('maya', { ...currentInput(state), evidenceId: state.evidence.id }, authorized).approved, true);
    }
  }
});

test('more than 32 revisions retain snapshots and another owner cannot invalidate unchanged captured dependencies', async t => {
  const { db, lifecycle } = setup(t), first = await approved(lifecycle);
  activate(lifecycle, first.state); const captured = lifecycle.capture('maya');
  let state = await load(lifecycle, 'leo');
  for (let n = 0; n < 33; n++) {
    if (n) state = await lifecycle.proposeScenarios('leo', { ...currentInput(state), cases: fixtureFor().cases }, authorized);
    state = await lifecycle.simulate('leo', currentInput(state), authorized);
    state = lifecycle.approve('leo', { ...currentInput(state), evidenceId: state.evidence.id }, authorized); state = activate(lifecycle, state, 'leo');
    assert.equal(lifecycle.current(captured), true);
    assert.deepEqual(lifecycle.execution('maya', captured.revisionId, first.state.extension.id).artifactBytes, captured.template.artifactBytes);
  }
  assert.equal(db.prepare("SELECT count(*) n FROM extension_authored WHERE owner_id='leo'").get().n, 34);
  const saved = db.prepare('SELECT * FROM extension_authored WHERE revision_id=?').get(first.state.draft.id);
  for (const field of ['source', 'artifact', 'suite']) {
    db.prepare(`UPDATE extension_authored SET ${field}=? WHERE revision_id=?`).run(field === 'suite' ? '[]' : Buffer.from('changed'), first.state.draft.id);
    assert.equal(lifecycle.state('maya', first.state.extension.id).selection.eligible, false);
    db.prepare(`UPDATE extension_authored SET ${field}=? WHERE revision_id=?`).run(saved[field], first.state.draft.id);
  }
  assert.equal(lifecycle.current(captured), true);
  const revised = await load(lifecycle, 'leo', 'Another saved title');
  assert.equal(revised.draftVersion, state.draftVersion + 2);
  assert.equal(JSON.parse(lifecycle.source('leo', revised.draft.id, revised.extension.id).source).steps[3].args.title.literal, 'Another saved title');
  assert.equal(revised.selection.revision.id, state.selection.revision.id);
});

test('native startup and stored task source remain usable with a missing compile-only Java executable', async t => {
  const db = openData(':memory:'), lifecycle = create(db);
  const directory = mkdtempSync(join(tmpdir(), 'keir-task-missing-java-')), prior = process.env.KEIR_JAVA_BIN;
  let app;
  t.after(async () => { await app?.close(); db.close(); rmSync(directory, { recursive: true }); if (prior === undefined) delete process.env.KEIR_JAVA_BIN; else process.env.KEIR_JAVA_BIN = prior; });
  admitTaskDraft(db, lifecycle, { extensionId: 'maya-task-fixture' });
  const { state } = await approved(lifecycle);
  const selected = activate(lifecycle, state), source = lifecycle.source('maya', state.draft.id, state.extension.id);
  process.env.KEIR_JAVA_BIN = join(directory, 'missing-java');
  const origin = 'http://127.0.0.1:32124'; app = await createApp({ db, origin });
  const bootstrap = (await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:32124' } })).json();
  const signedIn = await app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:32124', origin,
    'content-type': 'application/json', 'x-session-context': bootstrap.contextToken }, payload: { userId: 'maya' } });
  const headers = { host: '127.0.0.1:32124', origin, 'content-type': 'application/json', cookie: signedIn.headers['set-cookie'].split(';')[0], 'x-session-context': signedIn.json().contextToken };
  assert.equal((await app.inject({ url: '/api/projects', headers })).statusCode, 200);
  assert.equal((await app.inject({ url: `/api/extensions/${state.extension.id}/revisions/${state.draft.id}`, headers })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/extensions/${state.extension.id}/compile`, headers,
    payload: { source: fixtureFor().source, hookId: TASK_HOOK, draftVersion: state.draftVersion } })).statusCode, 503);
  assert.deepEqual(lifecycle.source('maya', state.draft.id, state.extension.id), source);
  assert.equal(lifecycle.state('maya', state.extension.id).selection.revision.id, selected.selection.revision.id);
});
