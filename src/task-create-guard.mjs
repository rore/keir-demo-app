import { randomUUID } from 'node:crypto';
import { bindModel, prepareProgram, invokeProgram } from '@keir/runtime-node';
import { taskService } from './data.mjs';
import { digest, json, hostBindings, definitionKey } from './extension-catalog.mjs';
import { createTaskDecisionConsumer } from './task-effect-simulation.mjs';

const hook = 'TaskBeforeCreate';
const blocked = Object.freeze({ status: 'BLOCKED' });
const denied = () => ({ kind: 'BUSINESS_REJECTION', code: 'ACCESS_DENIED' });

export function createTaskCreateGuard({ db, lifecycle, commitReserveMs }) {
  if (typeof db?.prepare !== 'function' || typeof lifecycle?.capture !== 'function'
      || typeof lifecycle.current !== 'function' || typeof lifecycle.execution !== 'function'
      || typeof lifecycle.admissionCurrent !== 'function'
      || !Number.isSafeInteger(commitReserveMs) || commitReserveMs <= 0)
    throw new TypeError('Task creation requires its native lifecycle and a positive commit reserve.');

  const tasks = taskService(db), invocations = new WeakMap(), decisions = new WeakMap(), running = new Set();
  let closing = false, preparedSlot;
  const bindings = new Map();
  const selection = owner => db.prepare('SELECT * FROM extension_selections WHERE owner_id=? AND hook_id=?').get(owner, hook);

  function withinDeadline(context, deadline) {
    const now = deadline.clock.nowMs();
    if (closing || context.signal?.aborted || !Number.isSafeInteger(now) || now < 0 || now < context.lastNow
        || !Number.isSafeInteger(deadline.expiresAtMs) || now >= deadline.expiresAtMs) return false;
    context.lastNow = now;
    return true;
  }

  function authority(context, deadline) {
    if (!withinDeadline(context, deadline)) return false;
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(context.owner)
        || !db.prepare('SELECT 1 FROM projects WHERE owner_id=? AND id=?').get(context.owner, context.projectId)
        || json(selection(context.owner)) !== context.selectionIdentity || !lifecycle.current(context.captured)
        || !lifecycle.admissionCurrent(context.admission)) return false;
    const execution = lifecycle.execution(context.owner, context.captured.revisionId, context.extensionId);
    return json(execution.host.pins) === context.hostPinsIdentity && json(execution.pins) === context.pinsIdentity
      && digest(execution.artifactBytes) === context.artifactDigest && withinDeadline(context, deadline);
  }

  function projection(capability, owner, args, deadline) {
    if (capability === 'tasks.openMatch') return tasks.hasOpenTask(owner, args.projectId, args.title, deadline);
    const task = tasks.getTaskForCustomization(owner, args.taskId);
    return { id: task.id, projectId: task.projectId, status: task.status === 'open' ? 'OPEN' : 'COMPLETED',
      title: task.title, tags: task.tags, priority: task.priority, ...(task.dueAt === null ? {} : { dueAt: task.dueAt }) };
  }

  function read(capability, version, keyType) {
    return { version, mode: 'real', keyType, invoke: async (args, protectedArgs, remainingMs, invocation) => {
      try {
        // Runtime copies event/deadline objects, but preserves the authenticated native key.
        const context = invocations.get(invocation?.requestKey)?.get(invocation?.event?.id);
        if (!context || protectedArgs.actorId !== context.owner || invocation.event.source !== context.projectId
            || invocation.deadline.expiresAtMs !== context.deadline.expiresAtMs || remainingMs <= 0
            || ++context.calls > 4 || !authority(context, context.deadline)) return denied();
        const value = projection(capability, context.owner, args, context.deadline);
        if (!authority(context, context.deadline)) return denied();
        context.reads.push({ capability, args: { ...args }, value: json(value) });
        return { kind: 'SUCCESS', value };
      } catch (error) {
        return error.status === 404
          ? { kind: 'BUSINESS_REJECTION', code: capability === 'tasks.get' ? 'TASK_NOT_FOUND' : 'PROJECT_NOT_FOUND' }
          : { kind: 'TRANSIENT_FAILURE' };
      }
    } };
  }

  function bindingFor(host) {
    const key = definitionKey(host.pins);
    if (bindings.has(key)) return bindings.get(key);
    const model = JSON.parse(host.dcmBytes), keyType = model.hostKey.type;
    const result = bindModel(host.dcmBytes, {
      'tasks.get': read('tasks.get', '3', keyType),
      'tasks.openMatch': read('tasks.openMatch', '1', keyType),
      'tasks.create': { version: '2', mode: 'real', keyType, invoke: async () => ({ ...denied(), effect: 'NONE' }) },
      'tasks.update': { version: '1', mode: 'real', keyType, invoke: async () => ({ ...denied(), effect: 'NONE' }) },
    });
    if (!result.diagnostic && result.boundModel)
      bindings.set(key, { key, modelDigest: host.pins.modelDigest, boundModel: result.boundModel, keyType });
    return bindings.get(key);
  }

  async function check({ owner, input, selection: selected, deadline, operationDeadline, signal, requestKey }) {
    let context, attempts, eventId;
    try {
      if (closing || typeof owner !== 'string' || !input || !selected?.revision_id
          || !requestKey || typeof requestKey !== 'object'
          || typeof requestKey.value !== 'string' || !Object.isFrozen(requestKey)
          || operationDeadline?.clock !== deadline?.clock
          || !Number.isSafeInteger(operationDeadline?.expiresAtMs) || !Number.isSafeInteger(deadline?.expiresAtMs)
          || deadline.expiresAtMs > operationDeadline.expiresAtMs - commitReserveMs) return blocked;
      const captured = lifecycle.capture(owner, hook);
      if (!captured || captured.owner !== owner || captured.hookId !== hook
          || captured.revisionId !== selected.revision_id || captured.generation !== selected.generation
          || json(selection(owner)) !== json(selected)) return blocked;
      const link = db.prepare('SELECT extension_id FROM extension_revision_links WHERE owner_id=? AND revision_id=?')
        .get(owner, captured.revisionId);
      if (!link) return blocked;
      const execution = lifecycle.execution(owner, captured.revisionId, link.extension_id);
      const binding = bindingFor(execution.host);
      if (!binding || requestKey.type !== binding.keyType) return blocked;
      const artifactDigest = digest(execution.artifactBytes), pins = execution.pins;
      const selectedPins = JSON.parse(selected.binding_pins);
      if (execution.host.pins.modelDigest !== binding.modelDigest
          || Object.entries(execution.host.pins).some(([name, value]) => json(pins[name]) !== json(value))
          || artifactDigest !== pins.artifactDigest
          || typeof selectedPins.approvedEvidenceId !== 'string'
          || json(selectedPins) !== json({ ...pins, approvedEvidenceId: selectedPins.approvedEvidenceId })) return blocked;
      context = { owner, projectId: input.projectId, captured, extensionId: link.extension_id, signal, deadline, operationDeadline,
        admission: { owner, itemId: link.extension_id, revisionId: captured.revisionId, hookId: hook, pins: selectedPins },
        selectionIdentity: json(selected), pinsIdentity: json(pins), hostPinsIdentity: json(execution.host.pins), artifactDigest, lastNow: -1, reads: [], calls: 0 };
      if (!authority(context, deadline)) return blocked;
      const modelDigest = binding.modelDigest;
      if (preparedSlot?.artifactDigest !== artifactDigest || preparedSlot.definitionKey !== binding.key) {
        const prepared = prepareProgram(execution.artifactBytes, binding.boundModel);
        if (prepared.diagnostic || !prepared.prepared) return blocked;
        preparedSlot = { artifactDigest, modelDigest, definitionKey: binding.key, prepared: prepared.prepared };
      }
      eventId = randomUUID();
      attempts = invocations.get(requestKey);
      if (!attempts) { attempts = new Map(); invocations.set(requestKey, attempts); }
      attempts.set(eventId, context);
      const outcome = await invokeProgram(preparedSlot.prepared, input, {
        bindings: hostBindings(execution.artifactBytes, owner), requestKey,
        event: { id: eventId, source: input.projectId }, deadline,
      });
      const consumed = createTaskDecisionConsumer(execution.host)(outcome);
      if (!['ALLOWED', 'DENIED'].includes(consumed.status) || !authority(context, deadline)) return blocked;
      const decision = Object.freeze({ status: consumed.status, message: consumed.result.message });
      decisions.set(decision, context);
      return decision;
    } catch { return blocked; }
    finally {
      if (attempts && eventId) {
        attempts.delete(eventId);
        if (!attempts.size) invocations.delete(requestKey);
      }
    }
  }

  return Object.freeze({
    commitReserveMs,
    check(context) {
      const pending = check(context);
      running.add(pending);
      pending.then(() => running.delete(pending), () => running.delete(pending));
      return pending;
    },
    current(decision, phase = 'BEFORE_WRITE') {
      try {
        const context = decisions.get(decision);
        if (!['BEFORE_WRITE', 'AFTER_WRITE'].includes(phase)
            || !context || !authority(context, context.operationDeadline)) return false;
        // The native transaction checks facts before its own write can legitimately change them.
        if (phase === 'AFTER_WRITE') return true;
        for (const read of context.reads) {
          if (json(projection(read.capability, context.owner, read.args, context.operationDeadline)) !== read.value) return false;
        }
        return authority(context, context.operationDeadline);
      } catch { return false; }
    },
    async close() { closing = true; await Promise.allSettled(running); preparedSlot = null; bindings.clear(); },
  });
}
