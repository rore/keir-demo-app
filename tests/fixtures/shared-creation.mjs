// Held-out composition: no tag/title gate. The expected result is authored independently of the source.
export const handoffArgs = {
  title: { cel: '"Handoff: " + source.title' },
  notes: { literal: 'Check the café queue.\nUse the north desk.' },
  tagsText: { literal: 'Needs Review, handoff, needs review' },
  priority: { literal: 'high' },
};
export const handoffExpected = {
  title: 'Handoff: Pack samples', project: 'SAME_PROJECT', notes: 'Check the café queue.\nUse the north desk.',
  tags: ['needs review', 'handoff'], priority: 'high', dueAt: null,
};
