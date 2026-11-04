import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openData, taskService, taskEffectService } from '../src/data.mjs';

const physical = process.env.KEIR_NATIVE_PROCESS_TESTS === '1';
const options = { skip: !physical, timeout: 60000 };
const owner = 'maya';
const outcome = { status: 'UNKNOWN', reason: 'Process fixture settlement' };
const authority = { authorizeRead: () => true, authorizeWrite: () => true, isQualificationCurrent: () => true };
const cleanups = new WeakMap();

function sandbox(t) {
  const directory = mkdtempSync(join(tmpdir(), 'keir-native-process-'));
  const children = [];
  cleanups.set(t, children);
  t.after(async () => {
    await Promise.all(children.map(close => close()));
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'app.sqlite');
  return { path, open: () => openData(path) };
}

function worker(t, config) {
  const child = fork(new URL('./fixtures/native-task-effect-worker.mjs', import.meta.url), [JSON.stringify(config)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  const messages = [], waiters = [];
  let stderr = '', closed = false, exit;
  child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  function flush() {
    for (let i = waiters.length - 1; i >= 0; --i) {
      const pending = waiters[i], index = messages.findIndex(message => message.type === pending.type || message.type === 'error');
      if (index !== -1) {
        const [message] = messages.splice(index, 1);
        waiters.splice(i, 1);
        if (message.type === 'error') pending.reject(new Error(`Worker failed: ${JSON.stringify(message)}\n${stderr}`));
        else pending.resolve(message);
      } else if (closed) {
        waiters.splice(i, 1);
        pending.reject(new Error(`Worker exited before ${pending.type}: ${JSON.stringify(exit)}\n${stderr}`));
      }
    }
  }
  lines.on('line', line => { messages.push(JSON.parse(line)); flush(); });
  const done = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true; exit = { code, signal }; flush(); resolve(exit);
  }));
  child.once('error', error => { messages.push({ type: 'error', message: error.message }); flush(); });
  cleanups.get(t).push(async () => { if (!closed) child.kill('SIGKILL'); await done; });
  return {
    child, done,
    wait: type => new Promise((resolve, reject) => { waiters.push({ type, resolve, reject }); flush(); }),
    go: () => child.send('go'),
    async kill() {
      assert.equal(child.kill('SIGKILL'), true);
      const result = await done;
      assert.ok(result.signal === 'SIGKILL' || result.code !== 0, 'worker must terminate abruptly');
    },
  };
}

function setup(t, selected = false) {
  const fixture = sandbox(t), db = fixture.open(), native = taskService(db);
  const project = native.listProjects(owner)[0];
  const task = native.createTask(owner, { projectId: project.id, title: 'Source task' });
  const selection = binding(db);
  if (selected) db.prepare("UPDATE extension_selections SET revision_id=?,generation=1,binding_pins=? WHERE owner_id=? AND hook_id='TaskCompleted'")
    .run(selection.revisionId, JSON.stringify(selection.pins), owner);
  db.close();
  return { ...fixture, owner, selection, taskId: task.id, payload: { projectId: project.id, title: 'Process-created task' } };
}

function binding(db) {
  // Storage fixtures exercise trusted native admission; they do not qualify a runtime.
  const pins = {
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    modelRef: { domainId: 'demo.tasks', domainVersion: '2', format: 'keir-dcm/effect-3', digest: `sha256:${'b'.repeat(64)}`, descriptorRecipe: 'keir-record-descriptors/1' },
    compiler: { id: 'fixture', version: '1' }, environment: { id: 'fixture', version: '1' },
    consumer: { id: 'demo.task-effects', version: '1', kind: 'EVENT_REPORT' },
    qualification: { id: 'fixture-report', revision: 1, reportDigest: `sha256:${'c'.repeat(64)}`, hostBuild: `sha256:${'d'.repeat(64)}` },
  };
  const revision = db.prepare('SELECT r.id, l.extension_id FROM extension_revisions r JOIN extension_revision_links l ON l.revision_id=r.id WHERE r.owner_id=? LIMIT 1').get(owner);
  return { revisionId: revision.id, pins };
}

function complete(fixture) {
  const db = fixture.open();
  try {
    taskService(db).completeTask(owner, fixture.taskId);
    return db.prepare('SELECT * FROM task_completion_events WHERE source_task_id=?').get(fixture.taskId);
  } finally { db.close(); }
}

async function race(t, config) {
  const workers = [worker(t, config), worker(t, config)];
  await Promise.all(workers.map(child => child.wait('ready')));
  assert.notEqual(workers[0].child.pid, workers[1].child.pid);
  workers.forEach(child => child.go());
  const result = await Promise.all(workers.map(child => child.wait('result')));
  for (const child of workers) assert.equal((await child.done).code, 0);
  return result.map(message => message.result);
}

test('separate processes complete one task with one original event/key', options, async t => {
  const fixture = setup(t);
  const results = await race(t, { ...fixture, operation: 'complete' });
  assert.equal(results[0].completedAt, results[1].completedAt);
  const db = fixture.open();
  try {
    const events = db.prepare('SELECT * FROM task_completion_events WHERE source_task_id=?').all(fixture.taskId);
    assert.equal(events.length, 1);
    assert.equal(events[0].owner_id, owner);
    assert.notEqual(events[0].event_id, events[0].original_key);
    assert.equal(events[0].state, 'NO_BINDING');
  } finally { db.close(); }
});

test('separate processes claim once and create one stable receipt for the original key', options, async t => {
  const fixture = setup(t, true), event = complete(fixture);
  const config = { ...fixture, eventId: event.event_id };
  const claims = await race(t, { ...config, operation: 'claim' });
  assert.equal(claims.filter(Boolean).length, 1);
  const results = await race(t, { ...config, operation: 'create' });
  assert.equal(results[0].kind, 'SUCCESS');
  assert.deepEqual(results[0], results[1]);
  const db = fixture.open();
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM tasks WHERE owner_id=? AND title=?').get(owner, fixture.payload.title).n, 1);
    const receipts = db.prepare('SELECT * FROM task_effect_receipts WHERE original_key=?').all(event.original_key);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].owner_id, owner);
    assert.equal(receipts[0].created_task_id, results[0].value.id);
    assert.equal(taskEffectService(db, authority).claim(owner, event.event_id), null);
  } finally { db.close(); }
});

test('selection committed in one process is captured by later completion in another process', options, async t => {
  const fixture = setup(t);
  const selecting = worker(t, { ...fixture, operation: 'select', boundary: 'after' });
  await selecting.wait('ready');
  selecting.go();
  await selecting.wait('boundary');
  const completing = worker(t, { ...fixture, operation: 'complete' });
  await completing.wait('ready');
  completing.go();
  assert.equal((await completing.wait('result')).result.status, 'completed');
  assert.equal((await completing.done).code, 0);
  await selecting.kill();
  const db = fixture.open();
  try {
    const events = db.prepare('SELECT * FROM task_completion_events WHERE source_task_id=?').all(fixture.taskId);
    assert.equal(events.length, 1);
    assert.equal(events[0].state, 'PENDING');
    assert.equal(events[0].owner_id, owner);
    assert.equal(events[0].revision_id, fixture.selection.revisionId);
    assert.equal(events[0].selection_generation, 1);
    assert.deepEqual(JSON.parse(events[0].pins), fixture.selection.pins);
  } finally { db.close(); }
});

test('selection committed after completion cannot replace NO_BINDING or mint another event', options, async t => {
  const fixture = setup(t);
  const completing = worker(t, { ...fixture, operation: 'complete', boundary: 'after' });
  await completing.wait('ready');
  completing.go();
  await completing.wait('boundary');
  let db = fixture.open(), original;
  try {
    original = db.prepare('SELECT * FROM task_completion_events WHERE source_task_id=?').get(fixture.taskId);
    assert.equal(original.state, 'NO_BINDING');
    assert.equal(original.revision_id, null);
    assert.equal(original.pins, null);
  } finally { db.close(); }
  const selecting = worker(t, { ...fixture, operation: 'select' });
  await selecting.wait('ready');
  selecting.go();
  await selecting.wait('result');
  assert.equal((await selecting.done).code, 0);
  await completing.kill();
  const repeating = worker(t, { ...fixture, operation: 'complete' });
  await repeating.wait('ready');
  repeating.go();
  await repeating.wait('result');
  assert.equal((await repeating.done).code, 0);
  db = fixture.open();
  try {
    const events = db.prepare('SELECT * FROM task_completion_events WHERE source_task_id=?').all(fixture.taskId);
    assert.deepEqual(events, [original]);
    const selected = db.prepare("SELECT revision_id,binding_pins,generation FROM extension_selections WHERE owner_id=? AND hook_id='TaskCompleted'").get(owner);
    assert.equal(selected.revision_id, fixture.selection.revisionId);
    assert.equal(selected.generation, 1);
    assert.deepEqual(JSON.parse(selected.binding_pins), fixture.selection.pins);
  } finally { db.close(); }
});

for (const operation of ['complete', 'claim', 'create', 'finish']) {
  for (const boundary of ['before', 'after']) {
    test(`abrupt process termination ${boundary} ${operation} commit preserves atomic state on reopen`, options, async t => {
      const fixture = setup(t, operation !== 'complete');
      let event;
      if (operation !== 'complete') event = complete(fixture);
      if (operation === 'create' || operation === 'finish') {
        const db = fixture.open();
        try { assert.ok(taskEffectService(db, authority).claim(owner, event.event_id)); }
        finally { db.close(); }
      }
      const child = worker(t, { ...fixture, eventId: event?.event_id, operation, boundary, outcome });
      await child.wait('ready');
      child.go();
      assert.equal((await child.wait('boundary')).boundary, boundary);
      await child.kill();
      const db = fixture.open();
      try {
        assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        const saved = db.prepare('SELECT * FROM task_completion_events WHERE source_task_id=?').get(fixture.taskId);
        const committed = boundary === 'after';
        if (operation === 'complete') {
          assert.equal(taskService(db).getTask(owner, fixture.taskId).status, committed ? 'completed' : 'open');
          assert.equal(!!saved, committed);
          if (saved) assert.equal(saved.state, 'NO_BINDING');
        } else {
          assert.equal(saved.original_key, event.original_key);
          assert.equal(saved.owner_id, owner);
          assert.equal(saved.input, event.input);
          assert.equal(saved.pins, event.pins);
          const effects = taskEffectService(db, authority);
          if (operation === 'claim') {
            assert.equal(saved.state, committed ? 'STARTED' : 'PENDING');
            if (committed) assert.equal(effects.claim(owner, event.event_id), null);
          } else if (operation === 'create') {
            assert.equal(saved.state, 'STARTED');
            assert.equal(db.prepare('SELECT count(*) n FROM tasks WHERE owner_id=? AND title=?').get(owner, fixture.payload.title).n, Number(committed));
            const receipt = db.prepare('SELECT * FROM task_effect_receipts WHERE original_key=?').get(event.original_key);
            assert.equal(!!receipt, committed);
            assert.equal(effects.claim(owner, event.event_id), null);
            if (committed) {
              assert.equal(receipt.effect, 'CONFIRMED');
              assert.equal(effects.createTaskOnce(owner, effects.keyFor(owner, event.event_id), fixture.payload).value.id, receipt.created_task_id);
              assert.equal(db.prepare('SELECT count(*) n FROM tasks WHERE owner_id=? AND title=?').get(owner, fixture.payload.title).n, 1);
            }
          } else {
            assert.equal(saved.state, committed ? 'FINISHED' : 'STARTED');
            assert.deepEqual(saved.outcome ? JSON.parse(saved.outcome) : null, committed ? outcome : null);
            assert.equal(effects.claim(owner, event.event_id), null);
            if (committed) assert.equal(effects.finish(owner, event.event_id, outcome), false);
          }
        }
      } finally { db.close(); }
    });
  }
}
