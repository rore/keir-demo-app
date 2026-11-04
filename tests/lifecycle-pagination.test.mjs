import test from 'node:test';
import assert from 'node:assert/strict';
import { openData } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { loadCatalog, digest } from '../src/extension-catalog.mjs';

const authorize = () => {};
const artifact = loadCatalog().find(row => row.id === 'attention').artifactBytes;
function setup(t) {
  const db = openData(':memory:');
  t.after(() => db.close());
  return { db, lifecycle: createLifecycle(db, { compiler: { compile: async () => ({ artifact, diagnostics: [] }) } }) };
}
const create = (api, id, owner = 'maya') => api.createFromSource(owner, { operationId: id, source: `source ${id}`, label: id }, authorize);
const current = state => ({ extensionId: state.extension.id, revisionId: state.draft.id, draftVersion: state.draftVersion });
function checkPage(page, field = 'rows') {
  assert.ok(page[field].length <= 20);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 262144);
}
function allPages(read, first) {
  let page = first ?? read();
  const rows = [...page.rows]; checkPage(page);
  while (page.next !== null) { page = read(page.next); checkPage(page); rows.push(...page.rows); }
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  return rows;
}

test('collection pages lightweight summaries, retains off-page selection and finds exact creation with no writes', async t => {
  const { db, lifecycle } = setup(t);
  const selected = lifecycle.collection('maya').selection;
  const created = [];
  for (let index = 0; index < 26; index++) created.push(await create(lifecycle, `collection-${index}`));
  const first = lifecycle.collection('maya');
  checkPage(first, 'items');
  assert.equal(first.items.length, 20);
  assert.deepEqual(first.selection, selected);
  assert.equal(first.items.some(row => row.extension.id === selected.revision.extensionId), false);
  for (const item of first.items) assert.deepEqual(Object.keys(item).sort(), ['approved', 'draft', 'draftVersion', 'extension']);
  const originalIds = db.prepare("SELECT id FROM extensions WHERE owner_id='maya' ORDER BY created_at DESC,id DESC").all().map(row => row.id);
  await create(lifecycle, 'created-after-first-page');
  const second = lifecycle.collection('maya', { before: first.next });
  checkPage(second, 'items');
  assert.deepEqual([...first.items, ...second.items].map(row => row.extension.id), originalIds);
  assert.equal(second.next, null);
  const target = originalIds.at(-2), operation = db.prepare('SELECT creation_operation_id FROM extensions WHERE id=?').get(target).creation_operation_id;
  const before = db.prepare('SELECT total_changes() n').get().n;
  assert.equal(lifecycle.findCreation('maya', operation).extension.id, target);
  assert.throws(() => lifecycle.findCreation('leo', operation), { status: 404 });
  assert.throws(() => lifecycle.collection('leo', { before: first.next }), { status: 400 });
  for (const value of ['', 'bad!', Buffer.from(JSON.stringify(['collection', 'maya', null, 0, 'missing'])).toString('base64url')])
    assert.throws(() => lifecycle.collection('maya', { before: value }), { status: 400 });
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
});

test('all revision, proof, restore and displaced-draft history stays reachable through scoped stable pages', async t => {
  const { db, lifecycle } = setup(t);
  let state = await create(lifecycle, 'paged-item');
  const extensionId = state.extension.id, proofs = [], activated = [], displaced = [];
  for (let index = 0; index < 23; index++) {
    state = lifecycle.load('maya', { extensionId, templateId: 'attention', draftVersion: state.draftVersion }, authorize);
    state = await lifecycle.simulate('maya', current(state), authorize);
    proofs.push(lifecycle.evidence('maya', state.evidence.id, extensionId));
    state = lifecycle.approve('maya', { ...current(state), evidenceId: state.evidence.id }, authorize);
    state = lifecycle.activate('maya', { ...current(state), generation: state.selection.generation }, authorize);
    activated.push(state.draft.id);
  }
  const selected = state.selection;
  for (let index = 0; index < 23; index++) {
    state = await lifecycle.compile('maya', { extensionId, source: `unchecked ${index}`, draftVersion: state.draftVersion }, authorize);
    displaced.push(lifecycle.source('maya', state.draft.id, extensionId));
    state = lifecycle.restart('maya', { extensionId, revisionId: selected.revision.id, draftVersion: state.draftVersion, generation: selected.generation }, authorize);
  }
  const initial = lifecycle.state('maya', extensionId);
  for (const key of ['evidenceHistory', 'restoreTargets', 'history']) assert.equal(initial[key].length, 20);
  for (const key of ['evidenceHistoryNext', 'restoreTargetsNext', 'historyNext']) assert.ok(initial[key]);
  const revisionsFirst = lifecycle.revisionPage('maya', extensionId);
  const originalRevisions = db.prepare('SELECT revision_id FROM extension_revision_links WHERE extension_id=? ORDER BY rowid DESC').all(extensionId).map(row => row.revision_id);
  state = await lifecycle.compile('maya', { extensionId, source: 'new while paging', draftVersion: state.draftVersion }, authorize);
  const before = db.prepare('SELECT total_changes() n').get().n;
  const revisions = allPages(cursor => lifecycle.revisionPage('maya', extensionId, cursor), revisionsFirst);
  assert.deepEqual(revisions.map(row => row.id), originalRevisions);
  const evidence = allPages(cursor => lifecycle.evidencePage('maya', extensionId, cursor));
  assert.deepEqual(evidence.map(row => row.id), proofs.map(row => row.id).reverse());
  const restore = allPages(cursor => lifecycle.restorePage('maya', extensionId, cursor));
  assert.deepEqual(restore.map(row => row.id), activated.slice().reverse());
  const history = allPages(cursor => lifecycle.history('maya', cursor, extensionId));
  assert.deepEqual(history.filter(row => row.operation === 'draft-superseded').map(row => row.revisionId), displaced.map(row => row.revisionId).reverse());
  for (const source of displaced) assert.deepEqual(lifecycle.source('maya', source.revisionId, extensionId), source);
  for (const proof of proofs) assert.deepEqual(lifecycle.evidence('maya', proof.id, extensionId), proof);
  assert.deepEqual(lifecycle.state('maya', extensionId).selection, selected);
  assert.equal(lifecycle.state('maya', extensionId).approved, false);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
  const other = await create(lifecycle, 'different-item');
  for (const [method, cursor] of [['revisionPage', revisionsFirst.next], ['evidencePage', initial.evidenceHistoryNext], ['restorePage', initial.restoreTargetsNext]]) {
    assert.throws(() => lifecycle[method]('maya', other.extension.id, cursor), { status: 400 });
    assert.throws(() => lifecycle[method]('leo', extensionId, cursor), { status: 404 });
    assert.throws(() => lifecycle[method]('maya', extensionId, 'malformed!'), { status: 400 });
    const forged = JSON.parse(Buffer.from(cursor, 'base64url').toString()); forged[4] = 'missing';
    assert.throws(() => lifecycle[method]('maya', extensionId, Buffer.from(JSON.stringify(forged)).toString('base64url')), { status: 400 });
  }
  assert.throws(() => lifecycle.history('maya', initial.historyNext, other.extension.id), { status: 400 });
  assert.throws(() => lifecycle.history('leo', initial.historyNext), { status: 400 });
  for (const cursor of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER]) assert.throws(() => lifecycle.history('maya', cursor, extensionId), { status: 400 });
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('original request excerpt uses the unique durable CREATE lineage, preserves NUL names and ignores recent projection', async t => {
  const { db, lifecycle } = setup(t);
  const created = await create(lifecycle, 'original-request');
  const id = created.extension.id, original = `  ${'😀'.repeat(170)} original request  `;
  db.prepare('UPDATE extensions SET name=? WHERE id=?').run('legacy\0name', id);
  db.prepare('INSERT INTO authoring_conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('create-chat', 'maya', 'original-request', 1,
    'run', 'IDLE', 0, 123, '{}', '[]', JSON.stringify({ messages: [{ id: 'original-request', role: 'user', text: 'recent projection' }] }), 123);
  db.prepare('INSERT INTO extension_conversation_links VALUES (?,?,?,?,NULL,NULL)').run('create-chat', 'maya', id, 'CREATE');
  db.prepare('INSERT INTO authoring_messages(conversation_id,owner_id,sequence,message_id,payload) VALUES (?,?,?,?,?)')
    .run('create-chat', 'maya', 1, 'original-request', JSON.stringify({ id: 'original-request', role: 'user', text: original }));
  const read = () => lifecycle.collection('maya').items.find(row => row.extension.id === id);
  const before = db.prepare('SELECT total_changes() n').get().n;
  assert.equal(read().requestExcerpt, '😀'.repeat(160));
  assert.equal(read().extension.name, 'legacy\0name');
  assert.equal(lifecycle.state('maya', id).extension.name, 'legacy\0name');
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
  db.prepare('UPDATE authoring_messages SET payload=? WHERE conversation_id=?').run(JSON.stringify({ id: 'wrong', role: 'user', text: original }), 'create-chat');
  assert.equal(Object.hasOwn(read(), 'requestExcerpt'), false);
  db.prepare('UPDATE authoring_messages SET payload=? WHERE conversation_id=?').run(JSON.stringify({ id: 'original-request', role: 'user', text: original }), 'create-chat');
  db.prepare('UPDATE authoring_conversations SET creation_operation_id=? WHERE id=?').run('different-operation', 'create-chat');
  assert.equal(Object.hasOwn(read(), 'requestExcerpt'), false);
  assert.equal(digest(lifecycle.source('maya', created.draft.id, id).source), created.draft.pins.rawSourceDigest);
});

test('encoded byte bounds shorten pages without losing a historical row that fits alone', async t => {
  const { db, lifecycle } = setup(t);
  let state = await create(lifecycle, 'large-metadata');
  const extensionId = state.extension.id, ids = [state.draft.id];
  for (let index = 0; index < 2; index++) {
    state = await lifecycle.compile('maya', { extensionId, source: `large ${index}`, draftVersion: state.draftVersion }, authorize);
    ids.push(state.draft.id);
  }
  // Legacy identities remain readable even when the current host cannot execute them.
  for (const id of ids) {
    const row = db.prepare('SELECT identity FROM extension_revisions WHERE id=?').get(id);
    db.prepare('UPDATE extension_revisions SET identity=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.identity), legacy: '😀'.repeat(40000) }), id);
  }
  const first = lifecycle.revisionPage('maya', extensionId);
  assert.equal(first.rows.length, 1);
  assert.ok(first.next);
  const rows = allPages(cursor => lifecycle.revisionPage('maya', extensionId, cursor), first);
  assert.deepEqual(rows.map(row => row.id), ids.reverse());
  const collection = lifecycle.collection('maya');
  checkPage(collection, 'items');
  assert.equal(collection.items.some(row => row.extension.id === extensionId), true);
});
