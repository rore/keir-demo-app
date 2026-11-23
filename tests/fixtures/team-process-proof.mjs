import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { bindModel, invokeProgram, prepareProgram } from '@keir/runtime-node';

const read = path => readFileSync(new URL(path, import.meta.url));
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
// This fixture has only ASCII keys and strings without control characters.
const sorted = value => Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const modelBytes = read('./team-process-model.json');
const model = JSON.parse(modelBytes);
const fingerprint = sha(JSON.stringify(sorted(model)));
const programs = JSON.parse(read('./team-process-programs.json'));
const jar = fileURLToPath(new URL('../../vendor/keir-compiler-java-0.5.0-cli.jar', import.meta.url));
const jarHash = 'sha256:1561dd1cce36c2eb3521442dcedbfd3a0ba4f1781b1e052a079ecdab32366c36';
const runtimeHash = 'sha256:9c59e4722f4d85bcd0e57580a1cef9526f7ceb52670e345576e39ca29d489736';

function compileAll() {
  assert.equal(sha(readFileSync(jar)), jarHash);
  assert.equal(sha(read('../../vendor/keir-runtime-node-0.5.0.tgz')), runtimeHash);
  const provenance = JSON.parse(read('../../vendor/provenance.json'));
  assert.equal(provenance.sha256, runtimeHash);
  const runtime = new URL('../', import.meta.resolve('@keir/runtime-node'));
  assert.equal(JSON.parse(readFileSync(new URL('package.json', runtime))).version, '0.5.0');
  for (const file of provenance.files) {
    assert.equal(sha(readFileSync(new URL(file.path, runtime))), file.sha256, file.path);
  }
  const dir = mkdtempSync(join(tmpdir(), 'daymark-team-proof-'));
  try {
    writeFileSync(join(dir, 'dcm.json'), modelBytes);
    const assets = new Map();
    for (const program of programs) {
      const source = JSON.stringify({
        language: 'keir/3', domain: { ...model.domain, fingerprint }, ...program,
      });
      writeFileSync(join(dir, 'source.json'), source);
      const bytes = execFileSync('java', ['-Xmx256m', '-XX:-UsePerfData', `-Djava.io.tmpdir=${dir}`,
        `-Duser.home=${dir}`, '-jar', jar, 'source.json', 'dcm.json'],
      { cwd: dir, timeout: 10_000, maxBuffer: 1_048_576, windowsHide: true });
      console.log(JSON.stringify({ program: program.name, source: sha(source), artifact: sha(bytes) }));
      assets.set(program.name, bytes);
    }
    console.log(JSON.stringify({ model: fingerprint, modelBytes: sha(modelBytes), compilerJar: jarHash, runtimeArchive: runtimeHash }));
    return assets;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ok = value => ({ kind: 'SUCCESS', value });
const wrote = id => ({ ...ok({ id }), effect: 'CONFIRMED' });
const rejection = (code, write) => ({ kind: 'BUSINESS_REJECTION', code, ...(write ? { effect: 'NONE' } : {}) });
const occurredAt = '2026-11-23T12:00:00.000Z';

// Disposable fixture only. Native isolation, durable admission, receipts, and commit races are Stage 1 work.
function makeHost(assets) {
  const tasks = new Map(), events = new Map(), attempts = new WeakMap(), writes = [], unavailable = new Set();
  const members = new Map([['team', new Set(['maya', 'leo'])], ['personal', new Set(['maya'])]]);
  let active, next = 0, response = 'confirmed';
  const allowed = (projectId, actorId) => members.get(projectId)?.has(actorId) === true;
  const readable = (task, scope) => task?.projectId === scope.projectId;
  const add = (projectId, properties) => {
    const task = { id: `task-${++next}`, projectId, status: 'OPEN', priority: 'normal', ...properties };
    tasks.set(task.id, task);
    return task;
  };
  const operations = {
    'tasks.get'({ taskId }, scope) {
      const task = tasks.get(taskId);
      if (!readable(task, scope)) return rejection('TASK_NOT_FOUND');
      const fields = Object.keys(model.types.Task.fields);
      return ok(Object.fromEntries(fields.filter(key => Object.hasOwn(task, key)).map(key => [key, task[key]])));
    },
    'tasks.childrenSummary'({ parentTaskId, originEventId }, scope) {
      if (!readable(tasks.get(parentTaskId), scope)) return rejection('TASK_NOT_FOUND');
      // ponytail: bounded test data in memory; real host needs an indexed, commit-consistent scoped read.
      const children = [...tasks.values()].filter(task => readable(task, scope) && task.parentTaskId === parentTaskId
        && (originEventId === undefined || task.originEventId === originEventId));
      return ok({ exists: children.length > 0, anyIncomplete: children.some(task => task.status !== 'COMPLETED') });
    },
    'tasks.create'({ projectId, parentTaskId, assigneeId, title }, scope) {
      if (projectId !== scope.projectId || (assigneeId !== undefined && !allowed(projectId, assigneeId))) {
        return rejection('ACCESS_DENIED', true);
      }
      if ((parentTaskId !== undefined && (!readable(tasks.get(parentTaskId), scope) || tasks.get(parentTaskId).parentTaskId))
          || !title.trim() || title.length > 120) return rejection('TASK_INVALID', true);
      if (response === 'rejected') return rejection('TASK_INVALID', true);
      const unknown = { kind: 'UNKNOWN_COMMIT', effect: 'UNKNOWN' };
      if (response === 'unknown-no-write') return unknown;
      const child = add(projectId, { title, ...(parentTaskId === undefined ? {} : { parentTaskId }),
        ...(assigneeId === undefined ? {} : { assigneeId }), originEventId: scope.eventId });
      return response === 'unknown-committed' ? unknown : wrote(child.id);
    },
    'tasks.update'(patch, scope) {
      const task = tasks.get(scope.taskId);
      if (!readable(task, scope)) return rejection('TASK_NOT_FOUND', true);
      if (patch.assigneeId !== undefined && !allowed(task.projectId, patch.assigneeId)) return rejection('ACCESS_DENIED', true);
      Object.assign(task, patch);
      return wrote(task.id);
    },
  };
  assert.deepEqual(Object.keys(operations).sort(), Object.keys(model.capabilities).sort());
  const { boundModel, diagnostic } = bindModel(modelBytes, Object.fromEntries(
    Object.entries(model.capabilities).map(([id, capability]) => [id, {
      version: capability.version, mode: 'simulation', keyType: model.hostKey.type,
      invoke(args, { actorId }, remaining, context) {
        const scope = attempts.get(context.requestKey);
        const write = capability.effect === 'WRITE';
        if (!scope || scope.actorId !== actorId || !allowed(scope.projectId, actorId) || remaining <= 0
            || context.event.id !== scope.eventId || context.event.source !== scope.taskId) {
          return rejection('ACCESS_DENIED', write);
        }
        if (write) writes.push({ id, taskId: scope.taskId, eventId: scope.eventId });
        return operations[id](args, scope);
      },
    }]),
  ));
  assert.equal(diagnostic, null);
  const prepared = new Map([...assets].map(([name, bytes]) => {
    const result = prepareProgram(bytes, boundModel);
    assert.equal(result.diagnostic, null, name);
    assert.ok(result.prepared, name);
    return [name, result.prepared];
  }));
  async function run(task, eventId, actorId, program, input) {
    if (unavailable.has(program) || !prepared.has(program)) return null;
    const requestKey = Object.freeze({ type: model.hostKey.type, value: eventId });
    attempts.set(requestKey, { projectId: task.projectId, taskId: task.id, actorId, eventId });
    try {
      return await invokeProgram(prepared.get(program), input, {
        bindings: { actorId }, requestKey, event: { id: eventId, source: task.id },
        deadline: { clock: { nowMs: () => 0 }, expiresAtMs: 1000 },
      });
    } finally { attempts.delete(requestKey); }
  }
  return {
    tasks, events, writes, unavailable,
    select(revision) { active = revision; },
    respond(mode) { response = mode; },
    add(projectId, actorId, properties = {}) {
      assert.ok(allowed(projectId, actorId));
      const task = add(projectId, { title: 'Example work', ...properties });
      const eventId = `created-${task.id}`;
      const pinned = projectId === 'team' && !task.parentTaskId ? active : undefined;
      events.set(task.id, { eventId, actorId, pinned });
      return task;
    },
    created(task) {
      const { eventId, actorId, pinned } = events.get(task.id);
      return pinned?.TaskCreated ? run(task, eventId, actorId, pinned.TaskCreated, { taskId: task.id, occurredAt }) : null;
    },
    async complete(task, actorId) {
      if (!allowed(task.projectId, actorId) || (task.assigneeId && task.assigneeId !== actorId)) return 'FORBIDDEN';
      const admission = events.get(task.id);
      if (admission?.pinned?.TaskBeforeComplete) {
        const outcome = await run(task, `attempt-${++next}`, actorId, admission.pinned.TaskBeforeComplete, {
          taskId: task.id, creationEventId: admission.eventId,
        });
        if (outcome?.classification !== 'COMPLETED' || outcome.effects.length !== 0
            || !['ALLOW', 'DENY'].includes(outcome.result?.decision)) return 'BLOCKED';
        if (outcome.result.decision === 'DENY') return 'DENIED';
      }
      task.status = 'COMPLETED';
      return 'COMPLETED';
    },
  };
}

const review = Object.freeze({ TaskCreated: 'request-review', TaskBeforeComplete: 'gate-deliverable-completion' });
const intake = Object.freeze({ TaskCreated: 'route-intake' });
const childrenOf = (host, task) => [...host.tasks.values()].filter(child => child.parentTaskId === task.id);
const receipt = outcome => outcome?.effects.map(effect => effect.state);
function check(t, event, observed, expected) {
  t.diagnostic(JSON.stringify({ event, expected, observed }));
  assert.deepEqual(observed, expected, event);
}

test('Stage 0: two business processes over one compiled model', async t => {
  const host = makeHost(compileAll());
  let deliverable;
  await t.test('review spans separate events without cascading or touching other work', async t => {
    host.select(review);
    deliverable = host.add('team', 'maya');
    const unrelated = host.add('personal', 'maya');
    assert.equal(await host.created(unrelated), null);
    assert.deepEqual(childrenOf(host, unrelated), []);
    const creation = await host.created(deliverable);
    assert.equal(creation.classification, 'COMPLETED');
    assert.deepEqual(receipt(creation), ['CONFIRMED']);
    const children = childrenOf(host, deliverable);
    assert.equal(children.length, 1);
    const [child] = children;
    check(t, 'create assigned review', child.assigneeId, 'leo');
    assert.equal(child.projectId, 'team');
    assert.equal(host.events.has(child.id), false, 'effect-created tasks do not queue creation events');
    assert.equal(host.writes.length, 1);
    const premature = await host.complete(deliverable, 'maya');
    check(t, 'attempt early completion', premature,
      process.env.DAYMARK_PROOF_WRONG_EXPECTATION === '1' ? 'COMPLETED' : 'DENIED');
    assert.equal(deliverable.status, 'OPEN');
    const decoy = host.add('team', 'maya', { parentTaskId: deliverable.id, title: child.title });
    assert.equal(await host.created(decoy), null);
    assert.equal(await host.complete(decoy, 'maya'), 'COMPLETED');
    assert.equal(await host.complete(deliverable, 'maya'), 'DENIED', 'manual child is not the requested effect');
    assert.equal(await host.complete(child, 'maya'), 'FORBIDDEN');
    check(t, 'assigned reviewer completes child', await host.complete(child, 'leo'), 'COMPLETED');
  });
  if (process.env.DAYMARK_PROOF_WRONG_EXPECTATION === '1') return;
  await t.test('version switch preserves the old gate while new work follows intake routing', async t => {
    const pending = host.add('team', 'maya', { priority: 'high' });
    host.select(intake);
    host.unavailable.add(review.TaskBeforeComplete);
    assert.equal(await host.complete(deliverable, 'maya'), 'BLOCKED');
    host.unavailable.clear();
    check(t, 'old deliverable completes under its pinned gate', await host.complete(deliverable, 'maya'), 'COMPLETED');
    assert.deepEqual(receipt(await host.created(pending)), ['CONFIRMED'], 'old queued creation retains its own program');
    assert.equal(childrenOf(host, pending).length, 1);
    assert.equal(pending.assigneeId, undefined);
    assert.equal(await host.complete(pending, 'maya'), 'DENIED', 'replacement must not remove a covered gate');
    const urgent = host.add('team', 'maya', { priority: 'high' });
    assert.deepEqual(receipt(await host.created(urgent)), ['CONFIRMED']);
    check(t, 'route high-priority task', { assigneeId: urgent.assigneeId, dueAt: urgent.dueAt },
      { assigneeId: 'leo', dueAt: '2026-11-24T12:00:00.000Z' });
    assert.deepEqual(childrenOf(host, urgent), []);
    const ordinary = host.add('team', 'maya');
    const outcome = await host.created(ordinary);
    assert.equal(outcome.classification, 'COMPLETED');
    assert.deepEqual(receipt(outcome), []);
    assert.equal(ordinary.assigneeId, undefined);
    assert.equal(ordinary.dueAt, undefined);
    assert.equal(await host.complete(ordinary, 'maya'), 'COMPLETED', 'the intake capability intentionally has no gate');
  });
  await t.test('rejected or uncertain effects do not retry or bypass the gate', async t => {
    host.select(review);
    for (const [mode, classification, effect, childCount] of [
      ['rejected', 'BUSINESS_REJECTION', 'NONE', 0],
      ['unknown-no-write', 'UNCERTAIN', 'UNKNOWN', 0],
      ['unknown-committed', 'UNCERTAIN', 'UNKNOWN', 1],
    ]) {
      host.respond(mode);
      const root = host.add('team', 'maya');
      const start = host.writes.length;
      const outcome = await host.created(root);
      assert.equal(outcome.classification, classification);
      check(t, `write receipt: ${mode}`, receipt(outcome), [effect]);
      assert.equal(childrenOf(host, root).length, childCount);
      assert.equal(await host.complete(root, 'maya'), 'DENIED');
      assert.equal(root.status, 'OPEN');
      assert.equal(host.writes.length - start, 1, 'no retry even when the write actually committed');
      if (childCount) {
        assert.equal(await host.complete(childrenOf(host, root)[0], 'leo'), 'COMPLETED');
        assert.equal(await host.complete(root, 'maya'), 'COMPLETED', 'observed linked state can establish readiness');
        assert.equal(host.writes.length - start, 1);
      }
    }
  });
});
