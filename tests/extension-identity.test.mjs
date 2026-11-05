import test from 'node:test';
import assert from 'node:assert/strict';
import { openData, transaction } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { digest } from '../src/extension-catalog.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { compileTaskCustomization, taskCustomizationFixture } from './fixtures/task-customization.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

const authorized = () => {};
const sourceFor = title => taskCustomizationFixture({ title }).source;
const casesFor = title => taskCustomizationFixture({ title }).cases;
function setup(t, compiler = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN })) {
  const db = openData(':memory:');
  t.after(() => db.close());
  return { db, lifecycle: createLifecycle(db, { compiler }) };
}
async function create(db, lifecycle, operationId, title, label) {
  const { extensionId } = admitTaskDraft(db, lifecycle, { operationId, name: label });
  return lifecycle.compile('maya', { extensionId, hookId: 'TaskCompleted', source: sourceFor(title), label, draftVersion: 0 }, authorized);
}
function current(state) {
  return { extensionId: state.extension.id, revisionId: state.draft.id, draftVersion: state.draftVersion };
}
async function prepare(lifecycle, extensionId, title) {
  let state = lifecycle.state('maya', extensionId);
  state = await lifecycle.compile('maya', { extensionId, hookId: 'TaskCompleted', source: sourceFor(title), draftVersion: state.draftVersion }, authorized);
  state = await lifecycle.proposeScenarios('maya', { ...current(state), cases: casesFor(title) }, authorized);
  const input = current(state);
  state = await lifecycle.simulate('maya', input, authorized);
  return { state, input };
}

test('creation identity, original receipt, item-fenced sources and separate approval/use stay isolated', async t => {
  const { db, lifecycle } = setup(t);
  const a = await create(db, lifecycle, 'create-a', 'fixture source A', 'Extension A');
  const b = await create(db, lifecycle, 'create-b', 'fixture source B', 'Extension B');
  const idA = a.extension.id, idB = b.extension.id;
  assert.notEqual(idA, idB);
  assert.equal(a.extension.ownerId ?? a.owner.id, 'maya');
  assert.equal(b.extension.ownerId ?? b.owner.id, 'maya');
  assert.equal(a.draftVersion, 1);
  assert.equal(b.draftVersion, 1);
  const receipt = a.creationReceipt;
  assert.equal(receipt.extensionId, idA);
  assert.equal(receipt.revisionId, a.draft.id);

  assert.equal(lifecycle.source('maya', a.draft.id, idA).source, sourceFor('fixture source A'));
  assert.equal(lifecycle.source('maya', b.draft.id, idB).source, sourceFor('fixture source B'));
  assert.throws(() => lifecycle.source('maya', b.draft.id, idA), { status: 404 });
  assert.throws(() => lifecycle.source('maya', a.draft.id, idB), { status: 404 });

  const advanced = await lifecycle.compile('maya', { extensionId: idA, hookId: 'TaskCompleted', source: sourceFor('fixture source A advanced'), label: 'Extension A', draftVersion: a.draftVersion }, authorized);
  assert.equal(advanced.draftVersion, 2);
  const creation = db.prepare('SELECT creation_hash hash FROM extensions WHERE id=?').get(idA);
  const replay = transaction(db, () => lifecycle.admit('maya', { extensionId: idA, operationId: 'create-a', hash: creation.hash, name: 'Extension A' }, authorized));
  assert.equal(replay.draftVersion, 2);
  assert.deepEqual(replay.creationReceipt, receipt);
  assert.throws(() => transaction(db, () => lifecycle.admit('maya', { extensionId: idA, operationId: 'create-a', hash: digest('different admission'), name: 'Extension A' }, authorized)), { status: 409 });

  let preparedA = await prepare(lifecycle, idA, 'attention');
  let preparedB = await prepare(lifecycle, idB, 'pending');
  const proofA = preparedA.state.evidence, proofB = preparedB.state.evidence;
  assert.equal(proofA.passed, true);
  assert.equal(proofB.passed, true);
  assert.throws(() => lifecycle.evidence('maya', proofB.id, idA), { status: 404 });
  assert.throws(() => lifecycle.evidence('maya', proofA.id, idB), { status: 404 });

  const originalSelectionId = preparedA.state.selection.revision?.id ?? null;
  preparedA.state = lifecycle.approve('maya', { ...preparedA.input, evidenceId: proofA.id }, authorized);
  assert.equal(preparedA.state.selection.revision?.id ?? null, originalSelectionId, 'approval leaves the current extension selected');
  preparedA.state = lifecycle.activate('maya', { ...preparedA.input, generation: preparedA.state.selection.generation }, authorized);
  assert.equal(preparedA.state.selection.revision.extensionId, idA);
  assert.equal(lifecycle.state('maya', idB).evidence.id, proofB.id, 'B remains saved while A is active');

  preparedB.state = lifecycle.approve('maya', { ...preparedB.input, evidenceId: proofB.id }, authorized);
  assert.equal(preparedB.state.selection.revision.id, preparedA.state.draft.id, 'approving B keeps A active');
  const generationForB = preparedB.state.selection.generation;
  preparedB.state = lifecycle.activate('maya', { ...preparedB.input, generation: generationForB }, authorized);
  assert.equal(preparedB.state.selection.revision.extensionId, idB);
  const afterB = lifecycle.state('maya', idB);
  assert.throws(() => lifecycle.activate('maya', { ...preparedB.input, generation: generationForB }, authorized), { status: 409 });
  assert.throws(() => lifecycle.disable('maya', { extensionId: idA, generation: afterB.selection.generation }, authorized), { status: 404 });
  assert.deepEqual(lifecycle.state('maya', idB), afterB, 'stale use and wrong-item disable leave B selected');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('restart makes a clean head from the active revision and retains later draft source and proof', async t => {
  const { db, lifecycle } = setup(t);
  const created = await create(db, lifecycle, 'restart-create', 'fixture source', 'Restart item');
  const extensionId = created.extension.id;
  let active = await prepare(lifecycle, extensionId, 'attention');
  active.state = lifecycle.approve('maya', { ...active.input, evidenceId: active.state.evidence.id }, authorized);
  active.state = lifecycle.activate('maya', { ...active.input, generation: active.state.selection.generation }, authorized);
  const activeRevision = active.state.draft.id;

  let later = await prepare(lifecycle, extensionId, 'pending');
  const laterRevision = later.state.draft.id, laterProof = later.state.evidence.id;
  const laterSource = lifecycle.source('maya', laterRevision, extensionId);
  const laterEvidence = lifecycle.evidence('maya', laterProof, extensionId);
  const expectedDraft = lifecycle.state('maya', extensionId);
  const beforeSelection = expectedDraft.selection;
  assert.notEqual(laterRevision, activeRevision);

  assert.throws(() => lifecycle.restart('maya', { extensionId, revisionId: activeRevision, draftVersion: expectedDraft.draftVersion,
    generation: beforeSelection.generation - 1 }, authorized), { status: 409 });
  assert.deepEqual(lifecycle.state('maya', extensionId), expectedDraft, 'stale restart has no state or history side effect');

  const restarted = lifecycle.restart('maya', { extensionId, revisionId: activeRevision, draftVersion: expectedDraft.draftVersion,
    generation: beforeSelection.generation }, authorized);
  assert.notEqual(restarted.draft.id, laterRevision);
  assert.equal(restarted.draft.templateId, 'authored');
  assert.equal(restarted.draftVersion, expectedDraft.draftVersion + 1);
  assert.equal(restarted.evidence, null);
  assert.equal(restarted.approved, false);
  assert.equal(restarted.approvedEvidenceId, null);
  assert.equal(restarted.selection.revision.id, activeRevision);
  assert.deepEqual(lifecycle.source('maya', laterRevision, extensionId), laterSource);
  assert.deepEqual(lifecycle.evidence('maya', laterProof, extensionId), laterEvidence);
  assert.ok(restarted.evidenceHistory.some(item => item.id === laterProof));
});

for (const approved of [false, true]) test(`restart exposes a displaced never-active ${approved ? 'approved' : 'unchecked'} draft through read-only item history`, async t => {
  const { db, lifecycle } = setup(t);
  const created = await create(db, lifecycle, 'history-create', 'initial source', 'History item');
  const extensionId = created.extension.id;
  let active = await prepare(lifecycle, extensionId, 'attention');
  active.state = lifecycle.approve('maya', { ...active.input, evidenceId: active.state.evidence.id }, authorized);
  active.state = lifecycle.activate('maya', { ...active.input, generation: active.state.selection.generation }, authorized);
  const bytes = sourceFor('Never-active saved source: original λ') + '\n';
  let later = await lifecycle.compile('maya', { extensionId, hookId: 'TaskCompleted', source: bytes, draftVersion: active.state.draftVersion }, authorized);
  if (approved) {
    const cases = casesFor('Never-active saved source: original λ');
    later = await lifecycle.proposeScenarios('maya', { ...current(later), cases }, authorized);
    later = await lifecycle.simulate('maya', current(later), authorized);
    later = lifecycle.approve('maya', { ...current(later), evidenceId: later.evidence.id }, authorized);
  }
  const before = later.selection;
  lifecycle.restart('maya', { extensionId, revisionId: before.revision.id, draftVersion: later.draftVersion, generation: before.generation }, authorized);
  const reopened = createLifecycle(db, {});
  const saved = reopened.state('maya', extensionId);
  const entry = saved.history.find(row => row.operation === 'draft-superseded');
  assert.ok(entry, 'A normal item read discovers the displaced draft without a simulation or caller-retained ID.');
  assert.equal(entry.revisionId, later.draft.id);
  assert.equal(entry.label, later.draft.label);
  assert.equal(reopened.source('maya', entry.revisionId, extensionId).source, bytes);
  assert.deepEqual(saved.selection, before);
  assert.equal(saved.approved, false);
  assert.equal(saved.evidence, null);
  assert.equal(saved.restoreTargets.some(row => row.id === entry.revisionId), false);
  assert.throws(() => reopened.rollback('maya', { extensionId, revisionId: entry.revisionId, generation: before.generation }, authorized), { status: 409 });
  assert.throws(() => reopened.approve('maya', { ...current(saved), evidenceId: later.evidence?.id ?? 'missing-proof' }, authorized));
  assert.throws(() => reopened.source('leo', entry.revisionId, extensionId), { status: 404 });
  assert.deepEqual(reopened.state('maya', extensionId).selection, before);
});

test('an admitted unbound item binds its hook only after valid compilation at the current draft version', async t => {
  const { db, lifecycle } = setup(t);
  const extensionId = 'unbound-item', operationId = 'unbound-operation';
  const { source } = await compileTaskCustomization();
  const admitted = admitTaskDraft(db, lifecycle, { extensionId, operationId, name: 'Unbound item' }).state;
  assert.equal(admitted.revisionId, null);
  assert.equal(admitted.draftVersion, 0);
  assert.equal(admitted.extension.hookId, null);

  const invalidCompiler = createLifecycle(db, { compiler: { compile: async () => ({ artifact: Buffer.from('not an artifact'), diagnostics: [] }) } });
  await assert.rejects(invalidCompiler.compile('maya', { extensionId, hookId: 'TaskCompleted', source, draftVersion: 0 }, authorized), { status: 422 });
  assert.equal(lifecycle.state('maya', extensionId).extension.hookId, null);
  assert.equal(lifecycle.state('maya', extensionId).draftVersion, 0);

  let compileCalls = 0;
  const actual = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN });
  const validCompiler = createLifecycle(db, { compiler: { compile: async (...args) => { compileCalls++; return actual.compile(...args); } } });
  await assert.rejects(validCompiler.compile('maya', { extensionId, hookId: 'TaskCompleted', source, draftVersion: 1 }, authorized), { status: 409 });
  assert.equal(compileCalls, 0);
  assert.equal(lifecycle.state('maya', extensionId).extension.hookId, null);
  const compiled = await validCompiler.compile('maya', { extensionId, hookId: 'TaskCompleted', source, draftVersion: 0 }, authorized);
  assert.equal(compiled.extension.hookId, 'TaskCompleted');
  assert.equal(compiled.draftVersion, 1);
  assert.equal(validCompiler.source('maya', compiled.draft.id, extensionId).source, source);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('authored revisions remain usable beyond 32 saves, including scenarios, creation and restart', async t => {
  let compileCalls = 0;
  const repeated = await compileTaskCustomization({ title: 'source-0' });
  const actual = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN });
  const { db, lifecycle } = setup(t, { compile: async (...args) => {
    compileCalls++;
    // This is a revision-count regression; reuse verified bytes only for the exact same source.
    return Buffer.from(args[0]).toString() === repeated.source
      ? { artifact: repeated.artifactBytes, diagnostics: [] } : actual.compile(...args);
  } });
  let state = await create(db, lifecycle, 'many-saves', 'source-0', 'Saved item');
  const first = lifecycle.source('maya', state.draft.id, state.extension.id);
  for (let index = 1; index < 35; index++) {
    state = await lifecycle.compile('maya', { extensionId: state.extension.id, hookId: 'TaskCompleted', source: repeated.source, label: `Saved item ${index}`, draftVersion: state.draftVersion }, authorized);
  }
  assert.equal(state.draftVersion, 35);
  assert.equal(compileCalls, 35);
  state = await lifecycle.proposeScenarios('maya', { ...current(state), cases: repeated.cases }, authorized);
  state = await lifecycle.simulate('maya', current(state), authorized);
  state = lifecycle.approve('maya', { ...current(state), evidenceId: state.evidence.id }, authorized);
  state = lifecycle.activate('maya', { ...current(state), generation: state.selection.generation }, authorized);
  const proof = lifecycle.evidence('maya', state.evidence.id, state.extension.id), selected = state.selection;
  state = await lifecycle.compile('maya', { extensionId: state.extension.id, hookId: 'TaskCompleted', source: sourceFor('later source'), draftVersion: state.draftVersion }, authorized);
  const later = lifecycle.source('maya', state.draft.id, state.extension.id);
  state = lifecycle.restart('maya', { extensionId: state.extension.id, revisionId: selected.revision.id,
    draftVersion: state.draftVersion, generation: selected.generation }, authorized);
  assert.equal(state.draftVersion, 38);
  assert.deepEqual(state.selection, selected);
  assert.equal(state.approved, false);
  assert.deepEqual(lifecycle.source('maya', first.revisionId, state.extension.id), first);
  assert.deepEqual(lifecycle.source('maya', later.revisionId, state.extension.id), later);
  assert.deepEqual(lifecycle.evidence('maya', proof.id, state.extension.id), proof);
  const another = await create(db, lifecycle, 'another-item', 'another source', 'Another item');
  assert.notEqual(another.extension.id, state.extension.id);
  assert.equal(db.prepare("SELECT count(*) n FROM extension_authored WHERE owner_id='maya'").get().n, 39);
});
