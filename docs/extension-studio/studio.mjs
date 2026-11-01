// Scripted UX model only. No compiler, model provider, host service or real activation.
export const people = ['Maya', 'Leo', 'Sam'];
export function draft(project = 'Launch', title = 'Review completion') {
  return { revision: 1, project, title, request: `When a task is completed in ${project}, create a task called “${title}”.`, validated: false, tested: false, mismatch: false, expectation: 'skip', approved: false, error: '', step: 'describe' };
}
export function initialState() {
  return { user: 'Maya', provider: true, users: Object.fromEntries(people.map(name => [name, { draft: draft(name === 'Leo' ? 'Operations' : 'Launch', name === 'Leo' ? 'Plan next step' : 'Review completion'), active: null, history: [], activity: [] }])) };
}
export function transition(state, action) {
  const s = structuredClone(state);
  if (action.type === 'reset') return initialState();
  if (action.type === 'user') { if (people.includes(action.user)) s.user = action.user; return s; }
  if (action.type === 'provider') { s.provider = !s.provider; return s; }
  const u = s.users[s.user], d = u.draft;
  const fail = message => { d.error = message; return s; };
  d.error = '';
  switch (action.type) {
    case 'step':
      if (['test', 'review'].includes(action.step) && !d.validated) return fail('Validate this draft before testing or review.');
      if (action.step === 'review' && !d.tested) return fail('Run and review the scenarios before approval.');
      if (['describe', 'behavior', 'test', 'review', 'activity'].includes(action.step)) d.step = action.step;
      break;
    case 'generate':
      if (!s.provider) return fail('Connect your own AI provider to create an extension. This prototype only simulates that setup.');
      if (!String(action.request ?? '').trim()) return fail('Describe the behavior you want first.');
      d.request = action.request; d.step = 'behavior'; d.validated = d.tested = d.approved = false;
      break;
    case 'edit': {
      const project = action.project ?? d.project, title = action.title ?? d.title;
      if (!['Launch', 'Operations'].includes(project) || !title.trim() || title.length > 120) return fail('Choose a project and a title of 1–120 characters.');
      if (project !== d.project || title !== d.title) { d.project = project; d.title = title; d.revision++; d.validated = d.tested = d.approved = false; d.mismatch = false; }
      break;
    }
    case 'validate': d.validated = true; d.step = 'test'; break;
    case 'unsupported': d.validated = d.tested = d.approved = false; d.step = 'behavior'; return fail('This request needs scheduled execution. Scheduling is outside the supported profile. Keep the event-triggered behavior or revise the request.');
    case 'expectation': d.expectation = action.value === 'create' ? 'create' : 'skip'; d.tested = d.approved = false; break;
    case 'simulate':
      if (!d.validated) return fail('Validate the current revision before running scenarios.');
      d.mismatch = d.expectation !== 'skip'; d.tested = !d.mismatch; d.approved = false;
      break;
    case 'approve':
      if (!d.validated || !d.tested || d.mismatch || !action.behavior || !action.scenarios) return fail('Review both the behavior and scenario expectations before approving this exact revision.');
      d.approved = true; break;
    case 'activate':
      if (!d.approved || !d.validated || !d.tested) return fail('This revision needs validation, passing scenarios and your approval before activation.');
      if (u.active?.enabled && u.active.revision === d.revision && u.active.project === d.project && u.active.title === d.title) { d.step = 'activity'; break; }
      if (u.active) u.history.push(structuredClone(u.active));
      u.active = { revision: d.revision, project: d.project, title: d.title, enabled: true }; d.step = 'activity';
      u.activity.unshift({ kind: 'activated', text: `Revision ${d.revision} selected for future example events.` });
      break;
    case 'example':
      if (!u.active?.enabled) return fail('There is no enabled customization for this user.');
      u.activity.unshift({ kind: 'example', text: `Illustration: completed “Prepare launch checklist” → created “${u.active.title}” in ${u.active.project}.` });
      break;
    case 'unknown':
      if (!u.active?.enabled) return fail('Activate an example revision first.');
      u.activity.unshift({ kind: 'unknown', text: 'Illustration: create response was lost. Outcome UNCERTAIN; effect UNKNOWN. A task may exist. Inspect host records; do not blindly retry.' });
      break;
    case 'disable':
      if (u.active) { u.active.enabled = false; u.activity.unshift({ kind: 'disabled', text: 'Disabled for future example events. Existing tasks and earlier effects are not undone.' }); }
      break;
    case 'rollback':
      if (!u.history.length) return fail('No previous active revision exists yet. Edit and activate a second revision to explore rollback.');
      u.active = u.history.pop(); u.active.enabled = true;
      u.activity.unshift({ kind: 'rollback', text: `Revision ${u.active.revision} restored for future example events; no earlier effects are undone.` }); break;
    case 'revise': d.step = 'behavior'; break;
    default: return fail('Unsupported prototype action.');
  }
  return s;
}
