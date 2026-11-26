import { beforeCreateOffer } from './shared-before-create.mjs';

const cel = value => ({ cel: value }), occurredAt = '2026-05-10T12:00:00.417Z';
export const bundleRequest = 'Require notes before saving undated normal tasks. For a receipt task, create a check after saving and an archive after completion.';

export function composedOffer({ bindings, cases }, projectId) {
  return { bindings, cases: Object.fromEntries(Object.entries(bindings).map(([hook, source]) => [
    hook, source === null ? null : (Array.isArray(cases) ? cases : cases[hook]).map(c => ({ projectId, ...c })),
  ])) };
}

// The runtime fixtures use exact compiler source. Only provider replies use the structured authoring form.
export function studioOffer({ bindings, cases }) {
  const value = expression => Object.hasOwn(expression, 'literal') ? { type: null, ...expression } : expression;
  const fields = record => Object.entries(record).map(([name, expression]) => ({ name, value: value(expression) }));
  return {
    bindings: Object.fromEntries(Object.entries(bindings).map(([hook, source]) => {
      if (source === null) return [hook, null];
      const { name, domain, steps, return: result } = JSON.parse(source);
      return [hook, { name, domain, steps: steps.map(step => Object.hasOwn(step, 'let')
        ? { id: step.id, let: value(step.let) }
        : { id: step.id, call: step.call, args: fields(step.args), when: step.when ?? null,
          onError: Object.entries(step.onError ?? {}).map(([code, result]) => ({ code, return: fields(result.record) })) }),
        return: fields(result.record) }];
    })),
    cases: Object.fromEntries(Object.entries(cases).map(([hook, examples]) => [
      hook, examples?.map(({ id, ...example }) => example) ?? null,
    ])),
  };
}

export const fieldGateRequest = 'Keep high-priority tasks open until they have notes.';
export const linkedGateRequest = 'For receipts, add a linked check for Leo due in two minutes. Keep the original open until its own check is done.';
export const ownedProjectRequest = 'When I finish a task tagged invoices, create a Ledger packet in the second project unless that project already has an open task with that title.';
export const ownedProjectTitle = 'Ledger packet';
export function ownedProjectOffer(model, hook, sourceProject, destination, lookupProject = destination) {
  const { domain, fingerprint } = model;
  const source = { language: 'keir/3', name: 'route-ledger-packet', domain: { ...domain, fingerprint }, entrypoint: hook, steps: [
    { id: 'source', call: 'tasks.get', args: { taskId: cel('input.taskId') } },
    { id: 'existing', call: 'tasks.openMatch', args: { projectId: { literal: lookupProject, type: 'ProjectId' }, title: { literal: ownedProjectTitle } } },
    { id: 'match', let: cel('"invoices" in source.tags && !existing.matches') },
    { id: 'followup', call: 'tasks.create', when: 'match', args: { projectId: { literal: destination, type: 'ProjectId' },
      title: { literal: ownedProjectTitle }, notes: { literal: 'Carry the invoice reference.' } } },
  ], return: { record: { status: cel('match ? "CREATED" : "NO_OP"') } } };
  const caseBase = { projectId: sourceProject, title: 'Reconcile invoices', priority: 'normal', tags: ['invoices'], sourceDueAt: null, occurredAt };
  const openProjects = [...new Set([sourceProject, lookupProject, destination])].map(projectId => ({
    projectId, titles: projectId === sourceProject && projectId !== lookupProject ? [ownedProjectTitle] : [],
  }));
  const expect = { title: ownedProjectTitle, project: destination, dueAt: null, notes: 'Carry the invoice reference.',
    tags: [], priority: 'normal', assigneeId: null, linked: false };
  return composedOffer({ bindings: { TaskBeforeCreate: null, TaskCreated: null, TaskBeforeComplete: null, TaskCompleted: null,
    [hook]: JSON.stringify(source) }, cases: [
    { ...caseBase, id: 'clear-target', openProjects, expect },
    { ...caseBase, id: 'target-has-match', openProjects: openProjects.map(p => p.projectId === lookupProject ? { ...p, titles: [ownedProjectTitle] } : p), expect: null },
  ] }, sourceProject);
}

export const createdUpdateRequest = 'On saving a task tagged intake, set it to high priority, clear its due date and add ready.';
export const completedUpdateRequest = dueAt => `On completing a task tagged intake, set it to high priority, ${dueAt ? `set its due date to ${dueAt}` : 'clear its due date'} and add ready.`;
export const ownedLookupUpdateRequest = hook => `After ${hook === 'TaskCreated' ? 'save' : 'completion'}, set intake to high priority, clear the date and add ready if Dispatch is open in the index project.`;
export const ownedUpdateTitle = 'Dispatch';
export function ownedLookupUpdateOffer(projectId, lookupId, model, hook, match = true) {
  const offer = sourceUpdateOffer(projectId, model, hook);
  const program = JSON.parse(offer.bindings[hook]);
  program.steps.splice(1, 0, { id: 'lookup', call: 'tasks.openMatch',
    args: { projectId: { literal: lookupId, type: 'ProjectId' }, title: { literal: ownedUpdateTitle } } });
  program.steps[2].let.cel += match ? ' && lookup.matches' : ' && !lookup.matches';
  offer.bindings[hook] = JSON.stringify(program);
  const [changed, unchanged, skipped] = offer.cases[hook];
  offer.cases[hook] = [changed, unchanged, skipped, { ...changed, id: 'opposite-match', expect: null }]
    .map(({ openTitles, ...c }, i) => ({ ...c, openProjects: [{ projectId, titles: [ownedUpdateTitle] },
      { projectId: lookupId, titles: [ownedUpdateTitle.toLowerCase(), ...((i !== 3) === match ? [ownedUpdateTitle] : [])] }] }));
  return offer;
}

export const exactLookupUpdateRequest = hook => `For ${hook}, update intake when the exact reference is high priority and Dispatch is absent in Index.`;
export function exactLookupUpdateOffer(projectId, lookupId, model, hook, reference, match = false) {
  const offer = ownedLookupUpdateOffer(projectId, lookupId, model, hook, match);
  const program = JSON.parse(offer.bindings[hook]);
  program.steps[2].let.cel += ' && reference.priority == "high"';
  program.steps.unshift({ id: 'reference', call: 'tasks.get', args: { taskId: { literal: reference.id, type: 'TaskId' } } });
  offer.bindings[hook] = JSON.stringify(program);
  const selected = { ...reference, status: 'OPEN', priority: 'high', tags: [], dueAt: null };
  const distractor = { ...selected, id: 'same-title-other-task' };
  const [applies] = offer.cases[hook];
  offer.cases[hook] = [...offer.cases[hook].map(c => ({ ...c, referenceTasks: [selected, distractor] })),
    { ...applies, id: 'wrong-reference', expect: null, referenceTasks: [{ ...selected, priority: 'low' }, distractor] }];
  return offer;
}

export const createdUpdateOffer = (projectId, model) => sourceUpdateOffer(projectId, model, 'TaskCreated');
export const exactReadRequest = hook => `Use the exact reference task to check ${hook}.`;
export const exactCreateRequest = hook => `Create one ledger packet for ${hook} when the exact reference is high priority and Index has no open packet.`;
export function exactCreateOffer(model, hook, projectId, destination, reference, lookupId) {
  const offer = ownedProjectOffer(model, hook, projectId, destination, lookupId);
  const program = JSON.parse(offer.bindings[hook]), guard = program.steps[2];
  program.steps[0] = { id: 'reference', call: 'tasks.get', args: { taskId: { literal: reference.id, type: 'TaskId' } } };
  guard.let.cel = `reference.priority == "high"${lookupId ? ' && !existing.matches' : ''}`;
  if (!lookupId) program.steps.splice(1, 1);
  offer.bindings[hook] = JSON.stringify(program);
  const selected = { ...reference, status: 'OPEN', priority: 'high', tags: [], dueAt: null };
  const distractor = { ...selected, id: 'same-title-other-task' };
  const [created, lookupHit] = offer.cases[hook];
  offer.cases[hook] = [
    { ...created, referenceTasks: [selected, distractor] },
    { ...created, id: 'other-task-is-high', expect: null, referenceTasks: [{ ...selected, priority: 'normal' }, distractor] },
    ...(lookupId ? [{ ...lookupHit, referenceTasks: [selected, distractor] }] : []),
  ];
  return offer;
}

export function exactReadOffer(projectId, reference, model, hook, lookupId) {
  const read = { id: 'reference', call: 'tasks.get', args: { taskId: { literal: reference.id, type: 'TaskId' } } };
  const task = { ...reference, status: 'OPEN', priority: 'high', tags: [], dueAt: null };
  const distractor = { ...task, id: 'same-title-other-task' };
  const absent = { ...task, priority: 'normal' };
  if (hook === 'TaskBeforeCreate') {
    const steps = [read];
    if (lookupId) steps.push({ id: 'lookup', call: 'tasks.openMatch',
      args: { projectId: { literal: lookupId, type: 'ProjectId' }, title: { literal: ownedUpdateTitle } } });
    steps.push({ id: 'blocked', let: cel(`reference.priority == "high"${lookupId ? ' && lookup.matches' : ''}`) });
    const message = 'Resolve the reference first.';
    const source = JSON.stringify({ language: 'keir/3', domain: { ...model.domain, fingerprint: model.fingerprint },
      entrypoint: hook, name: 'check-reference', steps, return: { record: {
        decision: cel('blocked ? "DENY" : "ALLOW"'), message: cel(`blocked ? "${message}" : ""`),
      } } });
    const example = (id, selected, hit, deny) => ({ id, projectId, priority: 'normal', tags: [], hasNotes: false, hasDueDate: false,
      expect: deny ? { decision: 'DENY', message } : { decision: 'ALLOW', message: '' },
      referenceTasks: [selected, distractor], openProjects: lookupId ? [{ projectId: lookupId, titles: hit ? [ownedUpdateTitle] : [] }] : [] });
    return composedOffer({ bindings: { TaskBeforeCreate: source, TaskCreated: null, TaskBeforeComplete: null, TaskCompleted: null },
      cases: { TaskBeforeCreate: [example('block', task, true, true), example('other-task-is-high', absent, true, false),
        ...(lookupId ? [example('index-miss', task, false, false)] : [])] } }, projectId);
  }
  const offer = sourceUpdateOffer(projectId, model, hook);
  const source = JSON.parse(offer.bindings[hook]);
  source.steps.unshift(read);
  source.steps[2].let.cel += ' && reference.priority == "high"';
  offer.bindings[hook] = JSON.stringify(source);
  const { openTitles, ...changed } = offer.cases[hook][0];
  offer.cases[hook] = [{ ...changed, referenceTasks: [task, distractor] },
    { ...changed, id: 'other-task-is-high', expect: null, referenceTasks: [absent, distractor] }];
  return offer;
}

export function sourceUpdateOffer(projectId, model, hook, dueAt = null) {
  const { domain, fingerprint } = model;
  const source = {
    language: 'keir/3', domain: { ...domain, fingerprint }, entrypoint: hook, name: 'prepare-intake',
    steps: [{ id: 'source', call: 'tasks.get', args: { taskId: cel('input.taskId') } },
      { id: 'applies', let: cel('"intake" in source.tags') },
      { id: 'update', call: 'tasks.update', when: 'applies',
        args: { priority: { literal: 'high' }, addTag: { literal: 'ready' },
          ...(dueAt ? { dueAt: cel(`timestamp("${dueAt}")`) } : { clearDue: { literal: true } }) } }],
    return: { record: { status: cel('applies ? "UPDATED" : "NO_OP"') } },
  };
  const input = { title: 'File intake', tags: ['intake'], priority: 'low', occurredAt,
    openTitles: [], sourceDueAt: '2026-05-16T09:45:00.000Z' };
  const expect = { sourceAfter: { priority: 'high', dueAt, tags: ['intake', 'ready'] } };
  return composedOffer({ bindings: { TaskBeforeCreate: null, TaskCreated: null, TaskBeforeComplete: null, TaskCompleted: null,
    [hook]: JSON.stringify(source) },
    cases: [{ ...input, id: 'changed', expect },
      { ...input, id: 'unchanged', priority: 'high', sourceDueAt: dueAt, tags: ['intake', 'ready'], expect },
      { ...input, id: 'skipped', tags: ['other'], expect: null }] }, projectId);
}

export function teamGateOffer(projectId, models, linked = false, suffix = '') {
  const { domain, fingerprint } = models.TaskBeforeComplete;
  const fieldMessage = 'Add notes before completing this task.', linkedMessage = 'Finish the linked check before completing this task.';
  const message = linked ? linkedMessage : fieldMessage;
  const steps = linked ? [{ id: 'checkTask', call: 'tasks.linkedTask',
    args: { parentTaskId: cel('input.taskId'), originEventId: cel('input.creationEventId') } }] : [];
  steps.push({ id: 'hold', let: cel(linked ? '"receipt" in input.tags && checkTask.status != "COMPLETED"'
    : 'input.priority == "high" && !input.hasNotes') });
  const source = JSON.stringify({ language: 'keir/3', domain: { ...domain, fingerprint }, entrypoint: 'TaskBeforeComplete', name: 'completion-check',
    steps, return: { record: { decision: cel('hold ? "DENY" : "ALLOW"'), message: cel(`hold ? ${JSON.stringify(message)} : ""`) } } });
  const proposal = linked ? authoredTaskBundle(projectId, models, suffix) : {
    bindings: { TaskBeforeCreate: null, TaskCreated: null, TaskCompleted: null }, cases: {},
  };
  proposal.bindings.TaskBeforeComplete = source;
  proposal.bindings.TaskBeforeCreate = proposal.bindings.TaskCompleted = null;
  const base = { projectId, title: 'File receipt', priority: 'high', tags: ['receipt'], hasNotes: false, hasDueDate: false };
  const decide = deny => ({ decision: deny ? 'DENY' : 'ALLOW', message: deny ? message : '' });
  proposal.cases.TaskBeforeComplete = linked ? ['MISSING', 'OPEN', 'COMPLETED'].map(linkedStatus =>
    ({ ...base, id: linkedStatus, linkedStatus, expect: decide(linkedStatus !== 'COMPLETED') }))
    : [false, true].map(hasNotes => ({ ...base, id: hasNotes ? 'with-notes' : 'without-notes', hasNotes, linkedStatus: null, expect: decide(!hasNotes) }));
  if (linked) {
    const program = JSON.parse(proposal.bindings.TaskCreated);
    Object.assign(program.steps.at(-1).args, { parentTaskId: cel('input.taskId'), assigneeId: { literal: 'leo', type: 'UserId' },
      dueAt: cel('input.occurredAt + duration("120s")') });
    proposal.bindings.TaskCreated = JSON.stringify(program);
    Object.assign(proposal.cases.TaskCreated[0].expect, { linked: true, assigneeId: 'leo', dueAt: '2026-05-10T12:02:00.417Z' });
    const hit = proposal.cases.TaskCreated[0], title = hit.expect.title, tags = ['receipt', 'urgent'];
    Object.assign(hit, { title, tags });
    for (const example of proposal.cases.TaskBeforeComplete) Object.assign(example, { title, tags });
    proposal.cases.TaskBeforeComplete.push({ ...base, id: 'near-miss', tags: ['receipts'], linkedStatus: 'MISSING', expect: decide(false) });
  }
  return composedOffer(proposal, projectId);
}

export function authoredTaskBundle(projectId, models, suffix = '') {
  const { bindings, cases: guard } = beforeCreateOffer(models.TaskBeforeCreate, projectId);
  const cases = { TaskBeforeCreate: guard };
  for (const [hook, status, prefix] of [
    ['TaskCreated', 'OPEN', 'Check receipt' + suffix],
    ['TaskCompleted', 'COMPLETED', 'Archive receipt' + suffix],
  ]) {
    const { domain, fingerprint } = models[hook];
    bindings[hook] = JSON.stringify({ language: 'keir/3', domain: { ...domain, fingerprint }, entrypoint: hook, name: 'receipt-check',
      steps: [{ id: 'source', call: 'tasks.get', args: { taskId: cel('input.taskId') } },
        { id: 'matches', let: cel(`source.status == "${status}" && "receipt" in source.tags`) },
        { id: 'followup', call: 'tasks.create', when: 'matches', args: { projectId: cel('source.projectId'), title: { literal: prefix },
          notes: { literal: 'Keep the intake record.' } } }],
      return: { record: { status: cel('matches ? "CREATED" : "NO_OP"') } } });
    const example = { projectId, title: 'File the receipt', tags: ['receipt'], priority: 'normal', occurredAt, openTitles: [], sourceDueAt: null };
    cases[hook] = [{ ...example, id: 'matching', expect: { title: prefix, notes: 'Keep the intake record.', tags: [], priority: 'normal', dueAt: null,
      linked: false, assigneeId: null, project: 'SAME_PROJECT' } },
    { ...example, id: 'near-miss', tags: ['receipts'], expect: null }];
  }
  return { bindings, cases };
}
