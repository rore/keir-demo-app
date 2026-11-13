import { loadHost, definitionFormats } from '../../src/extension-catalog.mjs';

// Test-authored choices and independent expectations, never a production evaluator/template.
export function taskTagNotesFixture({ projectId = 'project1', otherProjectId = 'project2' } = {}) {
  const host = loadHost('TaskBeforeCreate');
  const threshold = 3;
  const message = `Add notes for tasks with more than ${threshold} tags.`;
  const source = JSON.stringify({ language: definitionFormats(host.pins).source,
    domain: { id: host.pins.modelRef.domainId, version: host.pins.modelRef.domainVersion, fingerprint: host.pins.modelDigest },
    entrypoint: 'TaskBeforeCreate', name: 'notes-for-tagged-tasks',
    steps: [{ id: 'restricted', let: { cel: `size(input.tags) > ${threshold} && !input.hasNotes` } }],
    return: { record: { decision: { cel: 'restricted ? "DENY" : "ALLOW"' },
      message: { cel: 'restricted ? ' + JSON.stringify(message) + ' : ""' } } } }, null, 2);
  const tags = count => Array.from({ length: count }, (_, index) => 'tag' + index);
  // Expected decisions are chosen explicitly, not derived by evaluating the authored condition.
  const cases = [
    ['empty-without-notes', [], false, 'ALLOW'],
    ['three-without-notes', tags(3), false, 'ALLOW'],
    ['four-without-notes', tags(4), false, 'DENY'],
    ['four-with-notes', tags(4), true, 'ALLOW'],
    ['eight-without-notes', tags(8), false, 'DENY'],
    ['eight-with-notes', tags(8), true, 'ALLOW'],
    ['normalized-duplicates', ['client', 'review', 'internal'], false, 'ALLOW'],
    ['check-unavailable', tags(4), true, null],
  ].map(([id, values, hasNotes, decision]) => {
    const result = decision && { decision, message: decision === 'DENY' ? message : '' };
    const trace = decision ? [{ event: 'INVOCATION_START' }, { event: 'STEP_START', step: 'restricted' },
      { event: 'VALUE_BOUND', step: 'restricted' }, { event: 'RETURNED' }, { event: 'TERMINATED' }]
      : [{ event: 'INVOCATION_START' }, { event: 'TERMINATED', code: 'HOST_CONTEXT_INVALID' }];
    return JSON.stringify({ format: definitionFormats(host.pins).scenario, id,
      given: { input: { projectId, priority: 'normal', tags: values, hasNotes, hasDueDate: false }, fixture: decision ? 'normal' : 'invalid-key' },
      stubs: [], expect: { outcome: { classification: decision ? 'COMPLETED' : 'FAILED', effects: [],
        ...(decision ? { result } : { error: { code: 'HOST_CONTEXT_INVALID', path: '' } }),
        trace: trace.map((event, sequence) => ({ sequence, ...event })) }, calls: [],
      consumption: decision ? { status: decision === 'ALLOW' ? 'ALLOWED' : 'DENIED', result } : { status: 'BLOCKED' } } });
  });
  return { host, source, cases, metadata: { tagNotes: true, hookId: 'TaskBeforeCreate', projectId, otherProjectId, threshold, message, source, cases } };
}
