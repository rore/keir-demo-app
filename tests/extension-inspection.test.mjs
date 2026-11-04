import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openData, transaction } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { digest, json, loadCatalog, loadHost } from '../src/extension-catalog.mjs';

const authorize = () => {};
function setup(t) {
  const db = openData(':memory:');
  t.after(() => db.close());
  const artifact = readFileSync(new URL('../extensions/task-read/maya.json', import.meta.url));
  return { db, artifact, lifecycle: createLifecycle(db, { compiler: { compile: async () => ({ artifact }) } }) };
}

test('inspection returns exact pinned model, authored artifact and prepared source bytes', async t => {
  const { db, artifact, lifecycle } = setup(t);
  const host = loadHost(), model = lifecycle.hostCatalog().model;
  assert.equal(model.dcm, host.dcmBytes.toString('utf8'));
  assert.equal(digest(model.dcm), model.digest);
  assert.equal(model.digest, host.pins.modelDigest);
  assert.deepEqual({ profile: model.profile, hook: model.hook, consumer: model.consumer, compiler: model.compiler },
    { profile: host.pins.profile, hook: host.pins.hook, consumer: host.pins.consumer, compiler: host.pins.compiler });
  assert.ok(Buffer.byteLength(JSON.stringify(lifecycle.hostCatalog())) < 262144);

  const source = 'independent source fixture';
  const state = await lifecycle.createFromSource('sam', { operationId: 'inspect-source', source, label: 'Inspection' }, authorize);
  const value = lifecycle.source('sam', state.revisionId, state.extension.id);
  assert.equal(value.source, source);
  assert.equal(value.artifact, artifact.toString('utf8'));
  assert.equal(digest(value.artifact), value.pins.artifactDigest);
  assert.equal(digest(value.source), value.pins.rawSourceDigest);
  assert.equal(value.pins.modelDigest, model.digest);
  assert.deepEqual(value.pins, JSON.parse(db.prepare('SELECT identity FROM extension_revisions WHERE id=?').get(state.revisionId).identity));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 1048576);

  const preparedState = lifecycle.state('maya', lifecycle.collection('maya').items[0].extension.id);
  const prepared = lifecycle.source('maya', preparedState.selection.revision.id, preparedState.extension.id);
  const template = loadCatalog().find(item => item.id === 'pending');
  assert.equal(prepared.artifact, template.artifactBytes.toString('utf8'));
  assert.equal(prepared.source, readFileSync(new URL('../extensions/task-read/maya.yaml', import.meta.url), 'utf8'));
  assert.equal(digest(prepared.source), prepared.pins.sourceDigest);
  assert.equal(digest(prepared.artifact), prepared.pins.artifactDigest);
  assert.equal(prepared.hostCases.length, 1);
  assert.equal(prepared.hostCases[0].editable, false);
  assert.equal(prepared.cases.length, 5);
});

test('inspection rejects another owner/item and unavailable saved model identity', async t => {
  const { db, lifecycle } = setup(t);
  const a = await lifecycle.createFromSource('sam', { operationId: 'inspect-a', source: 'a' }, authorize);
  const b = await lifecycle.createFromSource('sam', { operationId: 'inspect-b', source: 'b' }, authorize);
  assert.throws(() => lifecycle.source('maya', a.revisionId, a.extension.id), { status: 404 });
  assert.throws(() => lifecycle.source('sam', a.revisionId, b.extension.id), { status: 404 });
  const pins = JSON.parse(db.prepare('SELECT identity FROM extension_revisions WHERE id=?').get(a.revisionId).identity);
  db.prepare('UPDATE extension_revisions SET identity=? WHERE id=?').run(json({ ...pins, modelDigest: digest('old model') }), a.revisionId);
  assert.throws(() => lifecycle.source('sam', a.revisionId, a.extension.id), { status: 404 });
  const prepared = lifecycle.state('maya', lifecycle.collection('maya').items[0].extension.id);
  const id = prepared.selection.revision.id;
  const preparedPins = JSON.parse(db.prepare('SELECT identity FROM extension_revisions WHERE id=?').get(id).identity);
  db.prepare('UPDATE extension_revisions SET identity=? WHERE id=?').run(json({ ...preparedPins, modelDigest: digest('old model') }), id);
  assert.throws(() => lifecycle.source('maya', id, prepared.extension.id), { status: 404 });
});

test('admission requires the caller transaction and rolls back with its enclosing operation', t => {
  const { db, lifecycle } = setup(t);
  const input = { extensionId: 'transaction-only', operationId: 'transaction-only', hash: digest('transaction-only'), name: 'New' };
  assert.throws(() => lifecycle.admit('sam', input, authorize), { status: 409 });
  assert.equal(lifecycle.collection('sam').items.length, 0);
  assert.throws(() => transaction(db, () => { lifecycle.admit('sam', input, authorize); throw new Error('later admission failure'); }), /later admission failure/);
  assert.equal(lifecycle.collection('sam').items.length, 0);
  transaction(db, () => lifecycle.admit('sam', input, authorize));
  assert.equal(lifecycle.state('sam', input.extensionId).extension.hookId, null);
  assert.equal(lifecycle.state('sam', input.extensionId).draftVersion, 0);
});
