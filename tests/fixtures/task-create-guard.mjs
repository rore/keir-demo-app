import assert from 'node:assert/strict';

// These selectors choose authored test programs; the host has no rule-specific handlers.
export function taskCreateGuardFixture({ host, rule, projectId = 'project1', otherProjectId = 'project2' }) {
  assert.ok(typeof projectId === 'string' && projectId.isWellFormed() && projectId);
  assert.ok(typeof otherProjectId === 'string' && otherProjectId.isWellFormed() && otherProjectId && otherProjectId !== projectId);
  const model = JSON.parse(Buffer.from(host.dcmBytes).toString('utf8'));
  assert.equal(model.format, 'keir-dcm/3');
  assert.equal(host.pins.hook, 'TaskBeforeCreate');
  assert.equal(host.pins.modelRef.domainId, model.domain.id);
  assert.equal(host.pins.modelRef.domainVersion, model.domain.version);
  assert.match(host.pins.modelDigest, /^sha256:[0-9a-f]{64}$/);

  const proposal = changes => ({ projectId, priority: 'normal', tags: [], hasNotes: false, hasDueDate: false, ...changes });
  const examples = {
    'client-due': {
      condition: '"client" in input.tags && !input.hasDueDate',
      message: 'Add a due date for this client task.',
      matchingAllow: proposal({ tags: ['client'], hasDueDate: true }),
      matchingDeny: proposal({ tags: ['client'] }),
      nonmatchingAllow: proposal({ tags: ['internal'] }),
    },
    'priority-note': {
      condition: 'input.priority == "high" && !input.hasNotes',
      message: 'Add a note for this high-priority task.',
      matchingAllow: proposal({ priority: 'high', hasNotes: true }),
      matchingDeny: proposal({ priority: 'high' }),
      nonmatchingAllow: proposal({ priority: 'low' }),
    },
    'project-review': {
      condition: 'input.projectId == chosenProject && !("review" in input.tags)',
      message: 'Add the review tag for this project.',
      matchingAllow: proposal({ tags: ['review'] }),
      matchingDeny: proposal({}),
      nonmatchingAllow: proposal({ projectId: otherProjectId }),
    },
    'project-priority': {
      condition: 'input.projectId == chosenProject && input.priority == "normal"',
      message: 'Choose a priority for this task.',
      matchingAllow: proposal({ priority: 'high' }),
      matchingDeny: proposal({ priority: 'normal' }),
      nonmatchingAllow: proposal({ projectId: otherProjectId, priority: 'normal' }),
    },
  };
  assert.ok(Object.hasOwn(examples, rule), 'Choose a supported authored test rule.');
  const example = examples[rule];
  const projectStep = ['project-review', 'project-priority'].includes(rule)
    ? [{ id: 'chosenProject', let: { literal: projectId, type: 'ProjectId' } }] : [];
  const source = JSON.stringify({ language: 'keir/2', name: 'task-create-guard-' + rule,
    domain: { id: host.pins.modelRef.domainId, version: host.pins.modelRef.domainVersion, fingerprint: host.pins.modelDigest },
    entrypoint: 'TaskBeforeCreate',
    steps: [...projectStep, { id: 'restricted', let: { cel: example.condition } }],
    return: { record: { decision: { cel: 'restricted ? "DENY" : "ALLOW"' },
      message: { cel: 'restricted ? ' + JSON.stringify(example.message) + ' : ""' } } },
  }, null, 2);

  const bindIds = ['project-review', 'project-priority'].includes(rule) ? ['chosenProject', 'restricted'] : ['restricted'];
  const completed = (id, input, decision, message) => {
    const result = { decision, message };
    const events = [{ event: 'INVOCATION_START' },
      ...bindIds.flatMap(step => [{ event: 'STEP_START', step }, { event: 'VALUE_BOUND', step }]),
      { event: 'RETURNED' }, { event: 'TERMINATED' }];
    return { format: 'keir-scenario/3', id, given: { input, fixture: 'normal' }, stubs: [],
      expect: { outcome: { classification: 'COMPLETED', result, effects: [],
        trace: events.map((event, sequence) => ({ sequence, ...event })) }, calls: [],
      consumption: { status: decision === 'ALLOW' ? 'ALLOWED' : 'DENIED', result } } };
  };
  // Expected decisions come from the examples above, independently of CEL or runtime evaluation.
  const cases = [
    completed(rule + '-matching-allow', example.matchingAllow, 'ALLOW', ''),
    completed(rule + '-matching-deny', example.matchingDeny, 'DENY', example.message),
    completed(rule + '-nonmatch-allow', example.nonmatchingAllow, 'ALLOW', ''),
    { format: 'keir-scenario/3', id: rule + '-unavailable',
      given: { input: rule === 'project-priority' ? example.matchingAllow : example.matchingDeny, fixture: 'invalid-key' }, stubs: [],
      expect: { outcome: { classification: 'FAILED', error: { code: 'HOST_CONTEXT_INVALID', path: '' }, effects: [],
        trace: [{ sequence: 0, event: 'INVOCATION_START' }, { sequence: 1, event: 'TERMINATED', code: 'HOST_CONTEXT_INVALID' }] },
      calls: [], consumption: { status: 'BLOCKED' } } },
  ].map(row => JSON.stringify(row, null, 2));
  return { source, cases, metadata: { rule, projectId, otherProjectId, message: example.message, source, cases } };
}
