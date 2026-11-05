import test from 'node:test';
import assert from 'node:assert/strict';
import { openData, transaction } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { digest, json, loadHost } from '../src/extension-catalog.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { compileTaskCustomization } from './fixtures/task-customization.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

const authorize = () => {};
async function setup(t) {
  const db = openData(':memory:');
  t.after(() => db.close());
  const fixture = await compileTaskCustomization();
  return { db, ...fixture, lifecycle: createLifecycle(db, { compiler: createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN }) }) };
}
async function create(db, lifecycle, owner, operationId, source, name) {
  const { extensionId } = admitTaskDraft(db, lifecycle, { owner, operationId, name });
  return lifecycle.compile(owner, { extensionId, source, hookId: 'TaskCompleted', draftVersion: 0 }, authorize);
}

test('inspection returns exact pinned model, authored artifact and source bytes', async t => {
  const { db, artifactBytes, source, lifecycle } = await setup(t);
  const host = loadHost('TaskCompleted'), model = lifecycle.hostCatalog().model;
  assert.equal(model.dcm, host.dcmBytes.toString('utf8'));
  assert.equal(digest(model.dcm), model.digest);
  assert.equal(model.digest, host.pins.modelDigest);
  assert.deepEqual({ hook: model.hook, consumer: model.consumer, compiler: model.compiler },
    { hook: host.pins.hook, consumer: host.pins.consumer, compiler: host.pins.compiler });
  assert.ok(Buffer.byteLength(JSON.stringify(lifecycle.hostCatalog())) < 262144);

  const state = await create(db, lifecycle, 'sam', 'inspect-source', source, 'Inspection');
  const value = lifecycle.source('sam', state.revisionId, state.extension.id);
  assert.equal(value.source, source);
  assert.equal(value.artifact, artifactBytes.toString('utf8'));
  assert.equal(digest(value.artifact), value.pins.artifactDigest);
  assert.equal(digest(value.source), value.pins.rawSourceDigest);
  assert.equal(value.pins.modelDigest, model.digest);
  assert.deepEqual(value.pins, JSON.parse(db.prepare('SELECT identity FROM extension_revisions WHERE id=?').get(state.revisionId).identity));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 1048576);

});

test('inspection rejects another owner/item and unavailable saved model identity', async t => {
  const { db, lifecycle, source } = await setup(t);
  const a = await create(db, lifecycle, 'sam', 'inspect-a', source, 'A');
  const b = await create(db, lifecycle, 'sam', 'inspect-b', source + '\n', 'B');
  assert.throws(() => lifecycle.source('maya', a.revisionId, a.extension.id), { status: 404 });
  assert.throws(() => lifecycle.source('sam', a.revisionId, b.extension.id), { status: 404 });
  const pins = JSON.parse(db.prepare('SELECT identity FROM extension_revisions WHERE id=?').get(a.revisionId).identity);
  db.prepare('UPDATE extension_revisions SET identity=? WHERE id=?').run(json({ ...pins, modelDigest: digest('old model') }), a.revisionId);
  assert.throws(() => lifecycle.source('sam', a.revisionId, a.extension.id), { status: 404 });

});

test('admission requires the caller transaction and rolls back with its enclosing operation', t => {
  const db = openData(':memory:'), lifecycle = createLifecycle(db);
  t.after(() => db.close());
  const input = { extensionId: 'transaction-only', operationId: 'transaction-only', hash: digest('transaction-only'), name: 'New' };
  assert.throws(() => lifecycle.admit('sam', input, authorize), { status: 409 });
  assert.equal(lifecycle.collection('sam').items.length, 0);
  assert.throws(() => transaction(db, () => { lifecycle.admit('sam', input, authorize); throw new Error('later admission failure'); }), /later admission failure/);
  assert.equal(lifecycle.collection('sam').items.length, 0);
  transaction(db, () => lifecycle.admit('sam', input, authorize));
  assert.equal(lifecycle.state('sam', input.extensionId).extension.hookId, null);
  assert.equal(lifecycle.state('sam', input.extensionId).draftVersion, 0);
});
