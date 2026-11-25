import { teamModel } from '../../src/team-runtime.mjs';
import { digest, json } from '../../src/extension-catalog.mjs';

// Independent offline authoring fixtures, never a production request dispatcher.
const domain = () => ({ ...teamModel.domain, fingerprint: digest(json(teamModel)) });
const actors = () => [{ id: 'author', userId: 'maya', role: 'ADMIN' }, { id: 'teammate', userId: 'leo', role: 'MEMBER' }];
const create = priority => ({ op: 'create', actor: 'author', ref: 'work', title: 'Prepare the release notes', priority, expect: { status: 'open' } });
const yes = { outcome: 'COMPLETED', children: 1, receipt: 'CONFIRMED', childTitle: 'Prepare priority triage', childAssigneeId: 'leo', reportStatus: 'CREATED' };
const no = { outcome: 'COMPLETED', children: 0, receipt: 'NONE', reportStatus: 'NO_OP' };

export function triageProposal() {
  const program = { language: 'keir/3', domain: domain(), name: 'priority-triage', entrypoint: 'TaskCreated', steps: [
    { id: 'task', call: 'tasks.get', args: { taskId: { cel: 'input.taskId' } } },
    { id: 'matches', let: { cel: 'task.priority == "high"' } },
    { id: 'followUp', call: 'tasks.create', when: 'matches', args: {
      projectId: { cel: 'task.projectId' }, parentTaskId: { cel: 'task.id' },
      assigneeId: { literal: 'leo', type: 'UserId' }, title: { literal: 'Prepare priority triage' },
    } },
  ], return: { record: { status: { cel: 'matches ? "CREATED" : "NO_OP"' } } } };
  const examples = ['high', 'normal', 'low'].map(priority => ({ id: priority, name: `A ${priority} priority task`,
    actors: actors(), initialTasks: [], fault: 'NONE', actions: [create(priority),
      { op: 'dispatch', ref: 'work', covers: { claimId: 'follow-up', outcomeId: priority === 'high' ? 'match' : 'miss' }, expect: priority === 'high' ? { ...yes } : { ...no } },
      { op: 'complete', actor: 'author', ref: 'work', expect: { decision: 'ALLOW', status: 'completed' } }] }));
  examples.push(...writeLossExamples('Prepare priority triage'));
  return { bindings: { TaskCreated: json(program), TaskBeforeComplete: null },
    agreement: { format: 'daymark-team-agreement/1', summary: 'Only high-priority tasks get a triage follow-up. Completion never waits.',
      claims: [{ id: 'follow-up', hook: 'TaskCreated', description: 'Create the exact triage task only when priority matches.',
        outcomes: [{ id: 'match', when: { priority: 'high' }, expect: { ...yes } },
          { id: 'miss', when: { priority: ['normal', 'low'] }, expect: { ...no } }] }],
      examples } };
}

export function linkedProposal() {
  const added = { language: 'keir/3', domain: domain(), name: 'linked-check', entrypoint: 'TaskCreated', steps: [
    { id: 'task', call: 'tasks.get', args: { taskId: { cel: 'input.taskId' } } },
    { id: 'review', call: 'tasks.create', args: { projectId: { cel: 'task.projectId' }, parentTaskId: { cel: 'task.id' },
      assigneeId: { literal: 'leo', type: 'UserId' }, title: { literal: 'Review the deliverable' } } },
  ], return: { record: { status: { literal: 'CREATED' } } } };
  const gate = { language: 'keir/3', domain: domain(), name: 'hold-for-linked-check', entrypoint: 'TaskBeforeComplete', steps: [
    { id: 'linked', call: 'tasks.childrenSummary', args: { parentTaskId: { cel: 'input.taskId' }, originEventId: { cel: 'input.creationEventId' } } },
    { id: 'ready', let: { cel: 'linked.exists && !linked.anyIncomplete' } },
  ], return: { record: { decision: { cel: 'ready ? "ALLOW" : "DENY"' },
    message: { cel: 'ready ? "" : "Complete its linked review first."' } } } };
  const effect = { outcome: 'COMPLETED', children: 1, receipt: 'CONFIRMED', childTitle: 'Review the deliverable', childAssigneeId: 'leo', reportStatus: 'CREATED' };
  const waiting = { decision: 'DENY', status: 'open', message: 'Complete its linked review first.' };
  const ready = { decision: 'ALLOW', status: 'completed', message: '' };
  return { bindings: { TaskCreated: json(added), TaskBeforeComplete: json(gate) },
    agreement: { format: 'daymark-team-agreement/1', summary: 'Request a linked review and hold completion until that exact review is done.',
      claims: [{ id: 'request-check', hook: 'TaskCreated', description: 'Save one review assigned to the named teammate.',
        outcomes: [{ id: 'saved', when: {}, expect: effect }] },
      { id: 'completion', hook: 'TaskBeforeComplete', description: 'The same deliverable is denied before its linked review is complete, then allowed.',
        outcomes: [{ id: 'waiting', when: { childStatus: ['absent', 'open'] }, expect: waiting },
          { id: 'ready', when: { childStatus: 'completed' }, expect: ready }] }],
      examples: [{ id: 'linked-check', name: 'The exact linked review unlocks completion', actors: actors(), initialTasks: [], fault: 'NONE', actions: [
        create('normal'),
        { op: 'complete', actor: 'author', ref: 'work', covers: { claimId: 'completion', outcomeId: 'waiting' }, expect: { ...waiting } },
        { op: 'dispatch', ref: 'work', covers: { claimId: 'request-check', outcomeId: 'saved' }, expect: { ...effect } },
        { op: 'complete', actor: 'author', ref: 'work', covers: { claimId: 'completion', outcomeId: 'waiting' }, expect: { ...waiting } },
        { op: 'complete', actor: 'teammate', ref: 'work.child', expect: { decision: 'ALLOW', status: 'completed' } },
        { op: 'complete', actor: 'author', ref: 'work', covers: { claimId: 'completion', outcomeId: 'ready' }, expect: { ...ready } },
      ] }, ...writeLossExamples('Review the deliverable')] } };
}

function writeLossExamples(childTitle) {
  return ['BEFORE_WRITE', 'LOST_REPLY'].map((fault, i) => ({ id: i ? 'lost-reply' : 'no-write', name: i ? 'A committed reply is lost' : 'The write never commits',
    actors: actors(), initialTasks: [], fault, actions: [create('high'),
      { op: 'dispatch', ref: 'work', expect: { outcome: 'UNCERTAIN', children: i ? 1 : 0, receipt: i ? 'CONFIRMED' : 'NONE',
        ...(i ? { childTitle, childAssigneeId: 'leo' } : {}) } },
      { op: 'reconcile', actor: 'author', ref: 'work', expect: { effect: i ? 'CONFIRMED' : 'NONE', children: i ? 1 : 0 } }] }));
}

export function triageOffer({ priority = 'high', title = 'Prepare priority triage', assigneeId = 'leo' } = {}) {
  const program = JSON.parse(triageProposal().bindings.TaskCreated);
  program.steps[1].let.cel = `task.priority == "${priority}"`;
  program.steps[2].args.title.literal = title;
  program.steps[2].args.assigneeId.literal = assigneeId;
  return { summary: `Add ${title} for ${priority}-priority tasks. Completion never waits.`, TaskBeforeComplete: null,
    TaskCreated: { source: json(program), outcomes: [
      { when: { priority: [priority] }, expected: { linkedTask: { title, assigneeId } } },
      { when: { priority: ['low', 'normal', 'high'].filter(p => p !== priority) }, expected: { linkedTask: null } },
    ] } };
}

export function linkedOffer() {
  const { bindings, agreement } = linkedProposal();
  return { summary: agreement.summary,
    TaskCreated: { source: bindings.TaskCreated, outcomes: [
      { when: { priority: null }, expected: { linkedTask: { title: 'Review the deliverable', assigneeId: 'leo' } } },
    ] },
    TaskBeforeComplete: { source: bindings.TaskBeforeComplete, outcomes: [
      { when: { priority: null, linkedTask: ['absent', 'open'] }, expected: { allow: false, message: 'Complete its linked review first.' } },
      { when: { priority: null, linkedTask: ['completed'] }, expected: { allow: true, message: null } },
    ] },
  };
}
