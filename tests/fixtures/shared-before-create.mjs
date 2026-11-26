export const correction = 'Add intake notes before saving this task.';
export const guardRequest = 'Before saving a new task with normal priority and no due date, require intake notes.';

export function beforeCreateOffer(model, projectId, message = correction) {
  const { domain, fingerprint } = model;
  const source = {
    language: 'keir/3', name: 'intake-notes-check', entrypoint: 'TaskBeforeCreate', domain: { ...domain, fingerprint },
    steps: [{ id: 'blocked', let: { cel: 'input.priority == "normal" && !input.hasDueDate && !input.hasNotes' } }],
    return: { record: { decision: { cel: 'blocked ? "DENY" : "ALLOW"' }, message: { cel: `blocked ? ${JSON.stringify(correction)} : ""` } } },
  };
  const candidate = { projectId, priority: 'normal', tags: ['intake'], hasNotes: false, hasDueDate: false, openTitles: [] };
  return { bindings: { TaskBeforeComplete: null, TaskBeforeCreate: JSON.stringify(source), TaskCompleted: null, TaskCreated: null },
    cases: [{ ...candidate, id: 'denied', expect: { decision: 'DENY', message } },
      { ...candidate, id: 'near-miss', hasNotes: true, expect: { decision: 'ALLOW', message: '' } }] };
}
