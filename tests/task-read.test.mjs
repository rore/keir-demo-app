import test from 'node:test';
import assert from 'node:assert/strict';
import { openData, taskService } from '../src/data.mjs';
import { createTaskRead, loadTaskReadBundle, consumeAdvice } from '../src/task-read.mjs';

const allowed = () => true;
const absent = result => assert.equal(result.status, 'NOT_DISPLAYED');
function setup(t) {
  const db = openData(':memory:');
  t.after(() => db.close());
  const service = taskService(db);
  const tasks = Object.fromEntries(['maya', 'leo'].map(user => {
    const project = service.createProject(user, { name: 'Test project' });
    return [user, service.createTask(user, { projectId: project.id, title: 'Saved task', notes: 'x'.repeat(4000) })];
  }));
  return { service, tasks };
}

test('installed read/2 runtime consumes real SQLite data with distinct source rules and exact-byte simulation parity', async t => {
  const { service, tasks } = setup(t);
  const bundle = loadTaskReadBundle();
  const real = createTaskRead({ getTask: service.getTask, bundle });
  const simulated = createTaskRead({ getTask: (owner, id) => ({ id, status: service.getTask(owner, id).status }), bundle, mode: 'simulation' });
  assert.notDeepEqual(bundle.programs.maya.bytes, bundle.programs.leo.bytes);
  for (const [userId, classification] of [['maya', 'PENDING'], ['leo', 'NEEDS_ATTENTION']]) {
    const input = { userId, taskId: tasks[userId].id, authorize: allowed };
    assert.deepEqual(await real(input), { status: 'DISPLAYED', classification });
    assert.deepEqual(await simulated(input), await real(input));
    service.completeTask(userId, input.taskId);
    assert.deepEqual(await real(input), { status: 'DISPLAYED', classification: 'DONE' });
    assert.deepEqual(await simulated(input), await real(input));
  }
});

test('foreign and missing tasks are indistinguishable; denied and unconfigured users never read', async t => {
  const { service, tasks } = setup(t);
  let calls = 0;
  const read = createTaskRead({ getTask: (...args) => { calls++; return service.getTask(...args); } });
  const invoke = (taskId, userId = 'maya', authorize = allowed) => read({ userId, taskId, authorize });
  assert.deepEqual(await invoke(tasks.leo.id), await invoke('missing'));
  const before = calls;
  absent(await invoke(tasks.maya.id, 'maya', () => false));
  absent(await invoke(tasks.maya.id, 'leo', () => false));
  absent(await invoke(tasks.maya.id, 'sam'));
  absent(await invoke(tasks.maya.id, 'unknown'));
  assert.equal(calls, before);
});

test('resource projection rejects wrong IDs/status and oversized values; native row fields are never exposed', async () => {
  for (const value of [{ id: 'other', status: 'open' }, { id: 'requested', status: 'unknown' }, null,
    { id: 'requested', status: 'OPEN' }, { id: 'requested', status: {} }]) {
    const read = createTaskRead({ getTask: () => value });
    absent(await read({ userId: 'maya', taskId: 'requested', authorize: allowed }));
  }
  let calls = 0;
  const read = createTaskRead({ getTask: () => { calls++; throw new Error('Unavailable'); } });
  for (const taskId of ['', null, {}, 'x'.repeat(257)]) absent(await read({ userId: 'maya', taskId, authorize: allowed }));
  assert.equal(calls, 0);
  absent(await read({ userId: 'maya', taskId: 'requested', authorize: allowed }));
});

test('external model, artifact, environment/compiler and consumer pins fail closed before service dispatch', async () => {
  const mutations = [b => b.modelDigest = 'sha256:' + '0'.repeat(64), b => b.compiler = 'other',
    b => b.programs.maya.digest = 'sha256:' + '0'.repeat(64), b => b.programs.maya.bytes[10] ^= 1,
    b => b.dcm = Buffer.from(b.dcm.toString().replace('demo.taskadvice', 'other.consumer'))];
  for (const mutate of mutations) {
    const bundle = loadTaskReadBundle(); mutate(bundle);
    let calls = 0;
    const read = createTaskRead({ bundle, getTask: () => { calls++; return { id: 'task', status: 'open' }; } });
    absent(await read({ userId: 'maya', taskId: 'task', authorize: allowed }));
    assert.equal(calls, 0);
  }
});

test('revocation before dispatch or during an awaited service result prevents display; other users stay scoped', async () => {
  let checks = 0, calls = 0;
  const read = createTaskRead({ getTask: () => { calls++; return { id: 'task', status: 'open' }; } });
  absent(await read({ userId: 'maya', taskId: 'task', authorize: () => ++checks < 3 }));
  assert.equal(calls, 0);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  let current = true;
  const pendingRead = createTaskRead({ getTask: (owner, id) => owner === 'maya'
    ? new Promise(resolve => { release = () => resolve({ id, status: 'open' }); entered(); })
    : { id, status: 'open' } });
  const pending = pendingRead({ userId: 'maya', taskId: 'task', authorize: () => current });
  await started;
  assert.deepEqual(await pendingRead({ userId: 'leo', taskId: 'different', authorize: allowed }),
    { status: 'DISPLAYED', classification: 'NEEDS_ATTENTION' });
  current = false; release(); absent(await pending);
});

test('consumer rejects failure/malformed/extra/oversized result without a fabricated classification', () => {
  for (const outcome of [null, {}, { classification: 'FAILED', result: { classification: 'DONE' } },
    ...[null, [], {}, { classification: 'OTHER' }, { classification: 'DONE', extra: true },
      { classification: 'x'.repeat(5000) }].map(result => ({ classification: 'COMPLETED', result }))]) absent(consumeAdvice(outcome));
});

test('authority is checked immediately before native read and before consuming a completed result', async () => {
  for (const threshold of [4, 6]) {
    let checks = 0, calls = 0;
    const read = createTaskRead({ getTask: () => { calls++; return { id: 'task', status: 'open' }; } });
    absent(await read({ userId: 'maya', taskId: 'task', authorize: () => ++checks < threshold }));
    assert.equal(calls, threshold === 4 ? 0 : 1);
  }
  const broken = createTaskRead({ bundle: {}, getTask: () => assert.fail('Invalid deployment dispatched') });
  absent(await broken({ userId: 'maya', taskId: 'task', authorize: allowed }));
});

test('finite invocation capacity fails closed without queueing or excess native reads, then recovers', async () => {
  const releases = [];
  let notify;
  const started = new Promise(resolve => { notify = resolve; });
  const read = createTaskRead({ getTask: (userId, id) => new Promise(resolve => {
    releases.push(() => resolve({ id, status: 'open' }));
    if (releases.length === 8) notify();
  }) });
  const input = { userId: 'maya', taskId: 'task', authorize: allowed };
  const pending = Array.from({ length: 8 }, () => read(input));
  await started;
  absent(await read(input));
  assert.equal(releases.length, 8);
  releases.forEach(release => release());
  for (const result of await Promise.all(pending)) assert.equal(result.status, 'DISPLAYED');
});
