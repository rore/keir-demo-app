import { taskEffectSyntax } from '../../src/task-effect-simulation.mjs';

const literal = value => ({ literal: value });
const cel = value => ({ cel: value });
const project = value => ({ literal: value, type: 'ProjectId' });
const defaults = {
  projectId: 'project1', destinationProjectId: 'project2', title: 'Quote for spring launch',
  reviewTitle: '  Review  ', tagsText: ' Review, REVIEW, Next ', followUpTitle: 'Follow-up',
};

export function taskWorkflowSource(host, workflow, options) {
  const { projectId, destinationProjectId, title, reviewTitle, tagsText, followUpTitle, elapsedSeconds = 604800 } = { ...defaults, ...options };
  const elapsedDue = cel(`input.occurredAt + duration("${elapsedSeconds}s")`);
  const source = JSON.parse(taskEffectSyntax(host));
  const inProject = 'source.projectId == projectId';
  const rules = {
    intake: [`${inProject} && source.title == ${JSON.stringify(title)} && "client" in source.tags`,
      'tasks.update', { priority: literal('high') }, 'UPDATED'],
    review: [`${inProject} && source.priority == "high" && "review" in source.tags`, 'tasks.create',
      { projectId: project(destinationProjectId), title: literal(reviewTitle), tagsText: literal(tagsText), dueAt: elapsedDue }, 'CREATED'],
    'follow-up': ['!source.matches', 'tasks.create',
      { projectId: project(destinationProjectId), title: literal(followUpTitle) }, 'CREATED'],
    onboarding: [`${inProject} && !has(source.dueAt)`, 'tasks.update', { dueAt: elapsedDue }, 'UPDATED'],
    'missing-due': ['!has(source.dueAt)', 'tasks.update', { dueAt: elapsedDue }, 'UPDATED'],
  };
  const [condition, write, writeArgs, status] = rules[workflow];
  const lookup = workflow === 'follow-up';
  source.steps = [
    ...(lookup || workflow === 'missing-due' ? [] : [{ id: 'projectId', let: project(projectId) }]),
    lookup ? { id: 'source', call: 'tasks.openMatch', args: { projectId: project(destinationProjectId), title: literal(followUpTitle) } }
      : { id: 'source', call: 'tasks.get', args: { taskId: cel('input.taskId') } },
    { id: 'eligible', let: cel(condition) },
    { id: 'changed', call: write, when: 'eligible', args: writeArgs },
  ];
  source.return.record.status = cel(`eligible ? "${status}" : "NO_OP"`);
  return Buffer.from(JSON.stringify(source));
}

const operation = (step, capability, version, args, response) =>
  ({ step, capability, version, args, protectedArgs: { actorId: 'user1' }, response });

function scenario(format, input, id, read, write, status = 'NO_OP', projectBinding = true) {
  const stubs = write ? [read, write] : [read];
  const calls = stubs.map(({ response, ...call }) => call);
  const effects = write ? [{ step: write.step, capability: write.capability, state: 'CONFIRMED' }] : [];
  const trace = [{ event: 'INVOCATION_START' }];
  const step = (event, step, more) => trace.push({ event, step, ...more });
  const call = (event, { step: id, capability }, more) => step(event, id, { capability, ...more });
  const readsTask = read.capability === 'tasks.get';
  if (readsTask && projectBinding) {
    step('STEP_START', 'projectId');
    step('VALUE_BOUND', 'projectId');
  }
  step('STEP_START', 'source');
  call('CALL_DISPATCHED', read);
  const outcome = { classification: 'COMPLETED', effects };
  if (read.response.kind === 'SUCCESS') {
    call('CALL_SUCCEEDED', read);
    step('STEP_START', 'eligible');
    step('VALUE_BOUND', 'eligible');
    step('STEP_START', 'changed');
    step('GUARD_EVALUATED', 'changed', { taken: !!write });
    if (write) {
      call('EFFECT_INTENT', write);
      call('CALL_DISPATCHED', write);
      call('EFFECT_RECORDED', write, { state: 'CONFIRMED' });
      call('CALL_SUCCEEDED', write);
    } else step('STEP_SKIPPED', 'changed');
    trace.push({ event: 'RETURNED' });
    outcome.result = { status };
    trace.push({ event: 'TERMINATED' });
  } else {
    outcome.classification = 'FAILED';
    outcome.error = { code: 'ADAPTER_TRANSIENT', path: readsTask && projectBinding ? '/steps/1' : '/steps/0' };
    trace.push({ event: 'TERMINATED', code: outcome.error.code });
  }
  const consumption = { status: 'REPORTED', ...outcome };
  outcome.trace = trace.map((event, sequence) => ({ sequence, ...event }));
  return { format, id, given: { input, fixture: 'normal' }, stubs, expect: { outcome, calls, consumption } };
}

export function taskWorkflowCases(host, workflow, options) {
  const { projectId, destinationProjectId, title, reviewTitle, tagsText, followUpTitle,
    taskId = 'task1', occurredAt = '2026-03-07T16:00:00.417Z', createdTaskId = 'task2', elapsedSeconds = 604800,
  } = { ...defaults, ...options };
  const input = { taskId, occurredAt };
  const dueAt = new Date(Date.parse(occurredAt) + elapsedSeconds * 1000).toISOString();
  const task = { id: taskId, projectId, title, status: host.pins.hook === 'TaskCreated' ? 'OPEN' : 'COMPLETED',
    tags: ['client', 'review'], priority: 'normal' };
  const read = changes => operation('source', 'tasks.get', '3', { taskId }, { kind: 'SUCCESS', value: { ...task, ...changes } });
  const matchArgs = { projectId: destinationProjectId, title: followUpTitle };
  const match = response => operation('source', 'tasks.openMatch', '1', matchArgs, response);
  const found = matches => match({ kind: 'SUCCESS', value: { matches } });
  const write = (capability, version, id, args) =>
    operation('changed', capability, version, args, { kind: 'SUCCESS', value: { id }, effect: 'CONFIRMED' });
  const create = args => write('tasks.create', '2', createdTaskId, args);
  const update = args => write('tasks.update', '1', taskId, args);
  const format = host.pins.modelRef.format === 'keir-dcm/3' ? 'keir-scenario/3' : 'keir-scenario/2';
  const example = (id, read, write, status) => scenario(format, input, id, read, write, status, workflow !== 'missing-due');
  const nearMiss = title === title.toLowerCase() ? title.toUpperCase() : title.toLowerCase();
  const cases = {
    intake: [
      example('intake-match', read(), update({ priority: 'high' }), 'UPDATED'),
      example('intake-near-miss', read({ title: nearMiss !== title && nearMiss.length <= 120 && Buffer.byteLength(nearMiss) <= 256
        ? nearMiss : title === 'Different task' ? 'Other task' : 'Different task' })),
    ],
    review: [
      example('review', read({ priority: 'high' }), create({ projectId: destinationProjectId, title: reviewTitle, tagsText, dueAt }), 'CREATED'),
      example('review-normal-priority', read()),
    ],
    'follow-up': [
      example('absent', found(false), create(matchArgs), 'CREATED'),
      example('present', found(true)),
      example('unavailable', match({ kind: 'TRANSIENT_FAILURE' })),
    ],
    onboarding: [
      example('missing-due', read(), update({ dueAt }), 'UPDATED'),
      example('existing-due', read({ dueAt: occurredAt })),
    ],
    'missing-due': [
      example('missing-due', read({ title: 'Plan launch' }), update({ dueAt }), 'UPDATED'),
      example('another-project', read({ projectId: destinationProjectId, title: 'Send invoice' }), update({ dueAt }), 'UPDATED'),
      example('existing-due', read({ title: 'Already scheduled', dueAt: occurredAt })),
      example('task-read-fails', operation('source', 'tasks.get', '3', { taskId }, { kind: 'TRANSIENT_FAILURE' })),
    ],
  };
  return cases[workflow].map(row => JSON.stringify(row));
}
