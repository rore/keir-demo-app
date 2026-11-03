import test from 'node:test';
import assert from 'node:assert/strict';
import { openData, transaction } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { digest, json, loadCatalog } from '../src/extension-catalog.mjs';

const authorized = () => {};
const artifact = loadCatalog().find(item => item.id === 'attention').artifactBytes;
function setup(t, compiler = { compile: async () => ({ artifact, diagnostics: [] }) }) {
  const db = openData(':memory:');
  t.after(() => db.close());
  return { db, lifecycle: createLifecycle(db, { compiler }) };
}
async function create(lifecycle, operationId, source, label) {
  return lifecycle.createFromSource('maya', { operationId, source, label }, authorized);
}
function current(state) {
  return { extensionId: state.extension.id, revisionId: state.draft.id, draftVersion: state.draftVersion };
}
async function prepare(lifecycle, extensionId, templateId) {
  let state = lifecycle.state('maya', extensionId);
  state = lifecycle.load('maya', { extensionId, templateId, draftVersion: state.draftVersion }, authorized);
  const input = current(state);
  state = await lifecycle.simulate('maya', input, authorized);
  return { state, input };
}

test('creation identity, original receipt, item-fenced sources and separate approval/use stay isolated', async t => {
  const { db, lifecycle } = setup(t);
  const a = await create(lifecycle, 'create-a', 'fixture source A', 'Extension A');
  const b = await create(lifecycle, 'create-b', 'fixture source B', 'Extension B');
  const idA = a.extension.id, idB = b.extension.id;
  assert.notEqual(idA, idB);
  assert.equal(a.extension.ownerId ?? a.owner.id, 'maya');
  assert.equal(b.extension.ownerId ?? b.owner.id, 'maya');
  assert.equal(a.draftVersion, 1);
  assert.equal(b.draftVersion, 1);
  const receipt = a.creationReceipt;
  assert.equal(receipt.extensionId, idA);
  assert.equal(receipt.revisionId, a.draft.id);

  assert.equal(lifecycle.source('maya', a.draft.id, idA).source, 'fixture source A');
  assert.equal(lifecycle.source('maya', b.draft.id, idB).source, 'fixture source B');
  assert.throws(() => lifecycle.source('maya', b.draft.id, idA), { status: 404 });
  assert.throws(() => lifecycle.source('maya', a.draft.id, idB), { status: 404 });

  const advanced = await lifecycle.compile('maya', { extensionId: idA, source: 'fixture source A advanced', label: 'Extension A', draftVersion: a.draftVersion }, authorized);
  assert.equal(advanced.draftVersion, 2);
  const replay = await create(lifecycle, 'create-a', 'fixture source A', 'Extension A');
  assert.equal(replay.draftVersion, 2);
  assert.deepEqual(replay.creationReceipt, receipt);
  await assert.rejects(create(lifecycle, 'create-a', 'different payload', 'Extension A'), { status: 409 });

  let preparedA = await prepare(lifecycle, idA, 'attention');
  let preparedB = await prepare(lifecycle, idB, 'pending');
  const proofA = preparedA.state.evidence, proofB = preparedB.state.evidence;
  assert.equal(proofA.passed, true);
  assert.equal(proofB.passed, true);
  assert.throws(() => lifecycle.evidence('maya', proofB.id, idA), { status: 404 });
  assert.throws(() => lifecycle.evidence('maya', proofA.id, idB), { status: 404 });

  const originalSelectionId = preparedA.state.selection.revision.id;
  preparedA.state = lifecycle.approve('maya', { ...preparedA.input, evidenceId: proofA.id }, authorized);
  assert.equal(preparedA.state.selection.revision.id, originalSelectionId, 'approval leaves the current extension selected');
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
  const { lifecycle } = setup(t);
  const created = await create(lifecycle, 'restart-create', 'fixture source', 'Restart item');
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
  assert.equal(restarted.draft.templateId, 'attention');
  assert.equal(restarted.draftVersion, expectedDraft.draftVersion + 1);
  assert.equal(restarted.evidence, null);
  assert.equal(restarted.approved, false);
  assert.equal(restarted.approvedEvidenceId, null);
  assert.equal(restarted.selection.revision.id, activeRevision);
  assert.deepEqual(lifecycle.source('maya', laterRevision, extensionId), laterSource);
  assert.deepEqual(lifecycle.evidence('maya', laterProof, extensionId), laterEvidence);
  assert.ok(restarted.evidenceHistory.some(item => item.id === laterProof));
});

test('an admitted unbound item binds its hook only after valid compilation at the current draft version', async t => {
  const { db, lifecycle } = setup(t);
  const extensionId = 'unbound-item', operationId = 'unbound-operation', source = 'fixture source';
  const hash = digest(json({ operationId, source, label: 'Unbound item' }));
  const admitted = transaction(db, () => lifecycle.admit('maya', { extensionId, operationId, hash, name: 'Unbound item' }, authorized));
  assert.equal(admitted.revisionId, null);
  assert.equal(admitted.draftVersion, 0);
  assert.equal(admitted.extension.hookId, null);

  const invalidCompiler = createLifecycle(db, { compiler: { compile: async () => ({ artifact: Buffer.from('not an artifact'), diagnostics: [] }) } });
  await assert.rejects(invalidCompiler.compile('maya', { extensionId, source, draftVersion: 0 }, authorized), { status: 422 });
  assert.equal(lifecycle.state('maya', extensionId).extension.hookId, null);
  assert.equal(lifecycle.state('maya', extensionId).draftVersion, 0);

  let compileCalls = 0;
  const validCompiler = createLifecycle(db, { compiler: { compile: async () => { compileCalls++; return { artifact, diagnostics: [] }; } } });
  await assert.rejects(validCompiler.compile('maya', { extensionId, source, draftVersion: 1 }, authorized), { status: 409 });
  assert.equal(compileCalls, 0);
  assert.equal(lifecycle.state('maya', extensionId).extension.hookId, null);
  const compiled = await validCompiler.compile('maya', { extensionId, source, draftVersion: 0 }, authorized);
  assert.equal(compiled.extension.hookId, 'ClassifyTask');
  assert.equal(compiled.draftVersion, 1);
  assert.equal(validCompiler.source('maya', compiled.draft.id, extensionId).source, source);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('authored revision quota remains owner-scoped across extension identities', async t => {
  let compileCalls = 0;
  const { lifecycle } = setup(t, { compile: async () => { compileCalls++; return { artifact, diagnostics: [] }; } });
  let state = await create(lifecycle, 'quota-create', 'source-0', 'Quota item');
  for (let index = 1; index < 32; index++) {
    state = await lifecycle.compile('maya', { extensionId: state.extension.id, source: `source-${index}`, label: 'Quota item', draftVersion: state.draftVersion }, authorized);
  }
  assert.equal(state.draftVersion, 32);
  assert.equal(compileCalls, 32);
  const itemCount = lifecycle.collection('maya').items.length;
  await assert.rejects(create(lifecycle, 'over-quota-create', 'another item', 'Another item'), { status: 409 });
  assert.equal(compileCalls, 32, 'quota rejection occurs before compilation');
  assert.equal(lifecycle.collection('maya').items.length, itemCount);
});
