import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { bindModel, prepareProgram, invokeProgram } from '@keir/runtime-node';
import { AppError, taskService, taskEffectService } from './data.mjs';
import { hostBindings, json, loadHost, TASK_HOOK, TASK_DEFINITION, taskDefinitionIds, digest } from './extension-catalog.mjs';
import { consumeTaskEffect } from './task-effect-simulation.mjs';

const denied = effect => ({ kind: 'BUSINESS_REJECTION', code: 'ACCESS_DENIED', ...(effect ? { effect: 'NONE' } : {}) });

export function createTaskDispatcher({ db, lifecycle, clock = () => Math.floor(performance.now()) }) {
  const tasks = taskService(db);
  const effects = taskEffectService(db);
  let closing = false, running = null, requested = false, after = 0, preparedSlot;
  const bindings = new Map();
  function current(owner, invocation) {
    const captured = effects.contextFor(owner, invocation), now = invocation.deadline.clock.nowMs();
    if (closing || captured.revokedAt !== null || captured.state !== 'STARTED'
        || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(invocation.deadline.expiresAtMs) || now >= invocation.deadline.expiresAtMs
        || !lifecycle.admissionCurrent(captured)) return null;
    return captured;
  }
  const mode = 'real', keyType = 'demo.TaskCompletionKey/1';
  const readTask = withTitle => ({ version: withTitle ? '2' : '1', mode, keyType, invoke: async (args, protectedArgs, remainingMs, context) => {
      try {
        if (remainingMs <= 0 || !current(protectedArgs.actorId, context)) return denied();
        const task = withTitle ? tasks.getTaskForCustomization(protectedArgs.actorId, args.taskId) : tasks.getTask(protectedArgs.actorId, args.taskId);
        if (!current(protectedArgs.actorId, context)) return denied();
        return { kind: 'SUCCESS', value: { id: task.id, projectId: task.projectId, status: task.status === 'open' ? 'OPEN' : 'COMPLETED',
          ...(withTitle ? { title: task.title } : {}) } };
      } catch (error) {
        if (['HOST_KEY_INVALID', 'HOST_CONTEXT_INVALID', 'AUTHORITY_DENIED'].includes(error.code)) return denied();
        return error.status === 404 ? { kind: 'BUSINESS_REJECTION', code: 'TASK_NOT_FOUND' } : { kind: 'TRANSIENT_FAILURE' };
      }
  } });
  const createTask = { version: '1', mode, keyType, invoke: async (args, protectedArgs, remainingMs, context) => {
      try {
        if (remainingMs <= 0 || !current(protectedArgs.actorId, context)) return denied(true);
        return effects.createTaskOnce(protectedArgs.actorId, context.requestKey, args, context);
      } catch (error) {
        if (['HOST_KEY_INVALID', 'HOST_CONTEXT_INVALID', 'AUTHORITY_DENIED', 'EVENT_NOT_STARTED'].includes(error.code)) return denied(true);
        if (error.status === 400) return { kind: 'BUSINESS_REJECTION', code: 'TASK_INVALID', effect: 'NONE' };
        return { kind: 'UNKNOWN_COMMIT', effect: 'UNKNOWN' };
      }
  } };
  for (const id of taskDefinitionIds) {
    try {
      const host = loadHost(TASK_HOOK, id);
      const binding = bindModel(host.dcmBytes, { 'tasks.get': readTask(id === TASK_DEFINITION), 'tasks.create': createTask });
      if (binding.boundModel && !binding.diagnostic) bindings.set(id, { host, boundModel: binding.boundModel });
    } catch { /* An unavailable model leaves the other binding and native tasks available. */ }
  }
  function eventForTask(owner, taskId) {
    tasks.getTask(owner, taskId);
    return db.prepare('SELECT event_id FROM task_completion_events WHERE owner_id=? AND source_task_id=?').get(owner, taskId)?.event_id;
  }
  function publicStatus(owner, taskId) {
    const eventId = eventForTask(owner, taskId);
    if (!eventId) return { state: 'NO_BINDING', outcome: null, receipt: null, reconciliation: null };
    const value = effects.status(owner, eventId);
    const visible = receipt => {
      if (receipt?.kind === 'SUCCESS' && receipt.effect === 'CONFIRMED') {
        try { tasks.getTask(owner, receipt.value.id); } catch { return null; }
      }
      return receipt;
    };
    return { state: value.state, outcome: value.outcome, receipt: visible(value.receipt),
      reconciliation: value.reconciliation ? { ...value.reconciliation, receipt: visible(value.reconciliation.receipt) } : null,
      ...(value.revokedAt !== null ? { message: 'This admission is no longer allowed to run. Your completed task is kept.' }
        : value.state === 'PENDING' ? { message: 'This reaction has not started. Its exact execution dependencies may be unavailable. Your completed task is kept.' } : {}) };
  }
  async function firstAttempt(row) {
    if (row.revoked_at !== null) return;
    const pins = JSON.parse(row.pins ?? 'null');
    // Legacy admissions remain historical; package support must never upgrade their authority.
    const binding = pins?.profile === 'keir-effect/4' ? bindings.get(pins.definitionId) : null;
    if (!binding) return;
    const { host, boundModel } = binding;
    let execution;
    try { execution = lifecycle.execution(row.owner_id, row.revision_id, row.item_id); } catch { /* Keep unavailable work unclaimed. */ }
    if (!execution || json(execution.host.pins) !== json(host.pins)) {
      return;
    }
    const captured = effects.status(row.owner_id, row.event_id), artifactDigest = digest(execution.artifactBytes);
    if (artifactDigest !== captured.pins.artifactDigest || !lifecycle.admissionCurrent(captured)) return;
    const modelDigest = host.pins.modelDigest;
    if (preparedSlot?.artifactDigest !== artifactDigest || preparedSlot.modelDigest !== modelDigest) {
      const result = prepareProgram(execution.artifactBytes, boundModel);
      if (result.diagnostic || !result.prepared) return;
      preparedSlot = { modelDigest, artifactDigest, prepared: result.prepared };
    }
    // Preparation grants no execution authority; the native deadline covers claim and invocation.
    const deadline = { clock: { nowMs: clock }, expiresAtMs: clock() + 1000 };
    const key = effects.keyFor(row.owner_id, row.event_id);
    const invocation = { requestKey: key, event: { id: captured.eventId, source: captured.sourceTaskId }, deadline };
    let claim;
    try {
      if (closing || !lifecycle.admissionCurrent(effects.contextFor(captured.owner, invocation))) return;
      claim = effects.claim(captured.owner, captured.eventId, invocation);
    }
    catch { return; }
    if (!claim) return;
    if (json(claim.input) !== json(captured.input) || json(claim.pins) !== json(captured.pins)
        || claim.originalKey !== captured.originalKey || claim.owner !== captured.owner || claim.sourceTaskId !== captured.sourceTaskId) return;
    const outcome = await invokeProgram(preparedSlot.prepared, claim.input, { ...invocation, bindings: hostBindings(execution.artifactBytes, claim.owner) });
    // Save the actual immutable runtime result, including failed-with-CONFIRMED or UNKNOWN.
    effects.finish(claim.owner, claim.eventId, outcome);
    consumeTaskEffect(outcome, host); // Consumer validation grants no task authority or substitute outcome.
  }
  async function drain() {
    do {
      requested = false;
      let pages = 0;
      while (!closing) {
        const rows = db.prepare("SELECT rowid AS sequence,* FROM task_completion_events WHERE state='PENDING' AND rowid>? ORDER BY rowid LIMIT 20").all(after);
        if (!rows.length) break;
        for (const row of rows) {
          after = row.sequence;
          if (closing) break;
          try { await firstAttempt(row); } catch { /* Persisted state and native receipts remain authoritative. */ }
        }
        // Yield bounded pages without restarting at an unavailable first row.
        if (++pages % 4 === 0) await nextTurn();
      }
    } while (requested && !closing);
  }
  function wake() {
    if (closing) return Promise.resolve();
    requested = true;
    if (!running) running = Promise.resolve().then(drain).finally(() => { running = null; if (requested && !closing) void wake(); });
    return running;
  }
  return Object.freeze({
    wake,
    availability() { return bindings.has(TASK_DEFINITION) ? { available: true }
      : { available: false, message: 'Task customizations are unavailable. Your tasks still work.' }; },
    dependenciesChanged() { after = 0; return wake(); },
    status: publicStatus,
    reconcile(owner, taskId) {
      const eventId = eventForTask(owner, taskId);
      if (!eventId) throw new AppError(404, 'This task has no recorded completion reaction.');
      effects.reconcile(owner, eventId); return publicStatus(owner, taskId);
    },
    async close() { closing = true; await running; preparedSlot = null; },
  });
}
