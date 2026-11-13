import { loadHost, definitionFormats } from '../../src/extension-catalog.mjs';

// Authored business choices for tests, never a production template or native handler.
export function conditionalFollowUpFixture({ projectId = 'project1', otherProjectId = 'project2', title = 'Follow up' } = {}) {
  const host = loadHost('TaskCompleted');
  const cel = cel => ({ cel }), literal = literal => ({ literal });
  const source = JSON.stringify({ language: definitionFormats(host.pins).source, name: 'priority-follow-up',
    domain: { id: host.pins.modelRef.domainId, version: host.pins.modelRef.domainVersion, fingerprint: host.pins.modelDigest },
    entrypoint: 'TaskCompleted', steps: [
      { id: 'projectId', let: { literal: projectId, type: 'ProjectId' } },
      { id: 'source', call: 'tasks.get', args: { taskId: cel('input.taskId') } },
      { id: 'eligible', let: cel('source.projectId == projectId && source.status == "COMPLETED" && source.priority == "high"') },
      { id: 'match', call: 'tasks.openMatch', when: 'eligible', args: { projectId: cel('projectId'), title: literal(title) } },
      { id: 'shouldCreate', let: cel('eligible ? !match.matches : false') },
      { id: 'created', call: 'tasks.create', when: 'shouldCreate', args: { projectId: cel('projectId'), title: literal(title) } },
    ], return: { record: { status: cel('shouldCreate ? "CREATED" : "NO_OP"') } } }, null, 2);
  const input = { taskId: 'task1', occurredAt: '2026-03-07T16:00:00.417Z' };
  const operation = (step, capability, version, args, response) => ({ step, capability, version, args, protectedArgs: { actorId: 'user1' }, response });
  const task = { id: 'task1', projectId, title: 'Send the collection preview', status: 'COMPLETED', priority: 'high', tags: [] };
  const read = (changes = {}, response) => operation('source', 'tasks.get', '3', { taskId: 'task1' }, response ?? { kind: 'SUCCESS', value: { ...task, ...changes } });
  const match = response => operation('match', 'tasks.openMatch', '1', { projectId, title }, response);
  const create = operation('created', 'tasks.create', '2', { projectId, title }, { kind: 'SUCCESS', value: { id: 'task2' }, effect: 'CONFIRMED' });
  // Independently specify expected dispatches, complete traces and effect semantics.
  function example(id, { changes, eligible = true, found = false, failedRead = false, failedLookup = false } = {}) {
    const stubs = [read(changes, failedRead ? { kind: 'TRANSIENT_FAILURE' } : undefined)];
    if (!failedRead && eligible) stubs.push(match(failedLookup ? { kind: 'TRANSIENT_FAILURE' } : { kind: 'SUCCESS', value: { matches: found } }));
    const created = !failedRead && eligible && !found && !failedLookup;
    if (created) stubs.push(create);
    const events = [{ event: 'INVOCATION_START' }];
    const step = (event, step, more = {}) => events.push({ event, step, ...more });
    const call = (event, step, capability, more) => events.push({ event, step, capability, ...more });
    step('STEP_START', 'projectId'); step('VALUE_BOUND', 'projectId');
    step('STEP_START', 'source'); call('CALL_DISPATCHED', 'source', 'tasks.get');
    if (!failedRead) {
      call('CALL_SUCCEEDED', 'source', 'tasks.get');
      step('STEP_START', 'eligible'); step('VALUE_BOUND', 'eligible');
      step('STEP_START', 'match'); step('GUARD_EVALUATED', 'match', { taken: eligible });
      if (eligible) { call('CALL_DISPATCHED', 'match', 'tasks.openMatch'); if (!failedLookup) call('CALL_SUCCEEDED', 'match', 'tasks.openMatch'); }
      else step('STEP_SKIPPED', 'match');
      if (!failedLookup) {
        step('STEP_START', 'shouldCreate'); step('VALUE_BOUND', 'shouldCreate');
        step('STEP_START', 'created'); step('GUARD_EVALUATED', 'created', { taken: created });
        if (created) {
          call('EFFECT_INTENT', 'created', 'tasks.create'); call('CALL_DISPATCHED', 'created', 'tasks.create');
          call('EFFECT_RECORDED', 'created', 'tasks.create', { state: 'CONFIRMED' }); call('CALL_SUCCEEDED', 'created', 'tasks.create');
        } else step('STEP_SKIPPED', 'created');
        events.push({ event: 'RETURNED' });
      }
    }
    const error = failedRead || failedLookup ? { code: 'ADAPTER_TRANSIENT', path: failedRead ? '/steps/1' : '/steps/3' } : null;
    events.push({ event: 'TERMINATED', ...(error && { code: error.code }) });
    const outcome = { classification: error ? 'FAILED' : 'COMPLETED', ...(error ? { error } : { result: { status: created ? 'CREATED' : 'NO_OP' } }),
      effects: created ? [{ step: 'created', capability: 'tasks.create', state: 'CONFIRMED' }] : [] };
    return JSON.stringify({ format: definitionFormats(host.pins).scenario, id, given: { input, fixture: 'normal' }, stubs,
      expect: { outcome: { ...outcome, trace: events.map((row, sequence) => ({ sequence, ...row })) },
        calls: stubs.map(({ response, ...call }) => call), consumption: { status: 'REPORTED', ...outcome } } });
  }
  const cases = [example('eligible-absent'), example('eligible-found', { found: true }),
    example('normal-priority', { changes: { priority: 'normal' }, eligible: false }),
    example('other-project', { changes: { projectId: otherProjectId }, eligible: false }),
    example('lookup-unavailable', { failedLookup: true }), example('task-unavailable', { failedRead: true })];
  return { host, source, cases, metadata: { conditionalFollowUp: true, projectId, otherProjectId, title, source, cases } };
}
