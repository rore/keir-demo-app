import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import { bindModel, prepareProgram, invokeProgram, ENVIRONMENT } from '@keir/runtime-node';

const consumer = Object.freeze({ id: 'demo.taskadvice', version: '1', kind: 'DISPLAY' });
const unavailable = () => ({ status: 'NOT_DISPLAYED', message: 'Task advice is unavailable. Your task has not changed.' });
const record = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));

export function consumeAdvice(outcome) {
  if (outcome?.classification !== 'COMPLETED' || !record(outcome.result, ['classification'])
      || !['DONE', 'PENDING', 'NEEDS_ATTENTION'].includes(outcome.result.classification)) return unavailable();
  return { status: 'DISPLAYED', classification: outcome.result.classification };
}

export function loadTaskReadBundle() {
  const load = name => readFileSync(new URL(`../extensions/task-read/${name}`, import.meta.url));
  const selection = JSON.parse(load('selection.json'));
  return { dcm: load('dcm.json'), modelDigest: selection.modelDigest, compiler: selection.compiler,
    programs: Object.fromEntries(['maya', 'leo'].map(user => [user,
      { bytes: load(`${user}.json`), digest: selection.programs[user].digest }])) };
}

// The host owns this finite catalog. Request fields cannot choose programs, scope or identity.
export function createTaskRead({ getTask, bundle, mode = 'real' }) {
  const selections = new Map();
  let active = 0;
  try {
    bundle ??= loadTaskReadBundle();
    for (const userId of ['maya', 'leo']) {
      const scope = `demo.task-advice:${userId}`;
      const program = bundle.programs[userId];
      const binding = bindModel(bundle.dcm, { scope, modelRef: { domainId: 'demo.tasks', domainVersion: '1',
        format: 'keir-dcm/read-2', digest: bundle.modelDigest, descriptorRecipe: 'keir-record-descriptors/1' },
      profile: 'keir-read/2', environment: ENVIRONMENT, mode }, {
        'tasks.get': { version: '1', mode, invoke: async (args, protectedArgs, remainingMs) => {
          const call = calls.getStore();
          if (!call || call.userId !== userId || protectedArgs.actorId !== userId || remainingMs <= 0 || !call.authorize())
            return { kind: 'BUSINESS_REJECTION', code: 'ACCESS_DENIED' };
          let task;
          try { task = await getTask(userId, args.taskId); }
          catch (error) {
            if (error.status === 404) return { kind: 'BUSINESS_REJECTION', code: 'TASK_NOT_FOUND' };
            throw error;
          }
          if (!call.authorize()) return { kind: 'BUSINESS_REJECTION', code: 'ACCESS_DENIED' };
          if (task?.id !== args.taskId || !['open', 'completed'].includes(task.status)) throw new Error('Invalid task projection');
          return { kind: 'SUCCESS', value: { id: task.id, status: task.status === 'open' ? 'OPEN' : 'COMPLETED' } };
        } },
      });
      if (binding.diagnostic) continue;
      const selected = prepareProgram(program.bytes, binding.boundModel, { expectedArtifactDigest: program.digest,
        expectedDcmDigest: bundle.modelDigest, entrypoint: 'ClassifyTask', consumer, compiler: bundle.compiler,
        environment: ENVIRONMENT, mode });
      if (!selected.diagnostic) selections.set(userId, Object.freeze({ scope, prepared: selected.prepared }));
    }
  } catch { /* An invalid deployment disables advice; native tasks remain usable. */ }
  return async ({ userId, taskId, authorize }) => {
    const selected = selections.get(userId);
    if (!selected || active >= 8 || typeof taskId !== 'string' || !taskId || Buffer.byteLength(taskId) > 256) return unavailable();
    const current = () => selections.get(userId) === selected && authorize() === true;
    active++;
    try {
      if (!current()) return unavailable();
      const clock = { nowMs: () => Math.floor(performance.now()) };
      const outcome = await calls.run({ userId, authorize: current }, () => invokeProgram(selected.prepared, { taskId }, {
        scope: selected.scope, bindings: { actorId: userId }, deadline: { clock, expiresAtMs: clock.nowMs() + 1000 },
        authorize: request => current() && request.entrypoint === 'ClassifyTask'
          && (record(request, ['entrypoint']) || record(request, ['entrypoint', 'capability', 'version'])
            && request.capability === 'tasks.get' && request.version === '1'),
      }));
      return current() ? consumeAdvice(outcome) : unavailable();
    } catch { return unavailable(); }
    finally { active--; }
  };
}

const calls = new AsyncLocalStorage();
