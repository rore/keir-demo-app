// Scripted UX model only. No compiler, model provider, host service or real activation.
export const people = ['Maya', 'Leo', 'Sam'];
export function draft(project = 'Launch', title = 'Review completion') {
  return { revision: 1, project, title, request: `When a task is completed in ${project}, create a task called “${title}”.`, started: false, validated: false, tested: false, mismatch: false, expectation: 'skip', approved: false, error: '', step: 'describe' };
}
export function initialState() {
  return { user: 'Maya', provider: true, users: Object.fromEntries(people.map(name => [name, { draft: draft(name === 'Leo' ? 'Operations' : 'Launch', name === 'Leo' ? 'Plan next step' : 'Review completion'), active: null, history: [], activity: [], messages: [{ role: 'assistant', text: 'What would you like to change about your task workflow? We can work it out together. I’ll use the canvas when a sketch, choice or example makes it easier to understand.' }] }])) };
}
export function transition(state, action) {
  const s = structuredClone(state);
  if (action.type === 'reset') return initialState();
  if (action.type === 'user') { if (people.includes(action.user)) s.user = action.user; return s; }
  if (action.type === 'provider') {
    s.provider = !s.provider;
    if (s.provider) for (const u of Object.values(s.users)) if (u.draft.error.includes('provider')) u.draft.error = '';
    return s;
  }
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
      d.request = action.request; d.started = true; d.step = 'behavior'; d.validated = d.tested = d.approved = false;
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

function exchange(state, text, action, reply) {
  const s = action ? transition(state, action) : structuredClone(state);
  const u = s.users[s.user];
  u.messages.push({ role: 'user', text }, { role: 'assistant', text: u.draft.error || reply });
  return s;
}

// These explicit routes illustrate a conversation; they do not interpret arbitrary requests with AI.
export function talk(state, text) {
  text = String(text).trim();
  if (!text) return state;
  const d = state.users[state.user].draft, lower = text.toLowerCase();
  if (/schedule|every monday|every day/.test(lower)) return exchange(state, text, { type: 'unsupported' }, '');
  if (!d.started) {
    return exchange(state, text, { type: 'generate', request: text }, `Let’s make that concrete. I’ve sketched the supported task-completion example on the canvas. Should this apply to ${d.project}, and should the new task be called “${d.title}”? This prototype demonstrates that one pattern; confirm or change those choices.`);
  }
  const project = /\boperations\b/i.test(text) ? 'Operations' : /\blaunch\b/i.test(text) ? 'Launch' : null;
  const title = text.match(/(?:call|title|name)[\s\S]*?["“]([^"”]+)["”]/i)?.[1] ?? text.match(/^title:\s*(.+)$/i)?.[1];
  if ((project && /use|apply|instead|switch|project:/.test(lower)) || title) {
    const s = exchange(state, text, { type: 'edit', project: project ?? d.project, title: title ?? d.title }, 'I updated the draft on the canvas. The active version is unchanged. We’ll check this revision again before it can replace anything.');
    s.users[s.user].draft.step = 'behavior'; return s;
  }
  if (/fix.*expectation|expect.*no change/.test(lower)) {
    let s = transition(state, { type: 'expectation', value: 'skip' }); s = transition(s, { type: 'validate' });
    return exchange(s, text, { type: 'simulate' }, 'You changed the expected result to no changes. I reran the scripted examples; they now match. The canvas shows expected and observed outcomes side by side.');
  }
  if (/mismatch/.test(lower)) {
    let s = transition(state, { type: 'expectation', value: 'create' }); s = transition(s, { type: 'validate' });
    return exchange(s, text, { type: 'simulate' }, 'The outside-project example disagrees with the draft. I’ve highlighted it on the canvas. We should decide whether the behavior or your expectation needs changing; I won’t silently change your test.');
  }
  if (/test|simulate|run.*scenario/.test(lower)) {
    const s = transition(state, { type: 'validate' });
    return exchange(s, text, { type: 'simulate' }, d.expectation === 'skip' ? 'The three scripted examples match. On the canvas you can inspect what was expected and what happened, including the no-op and missing-task cases. What would you like to examine or change?' : 'There is a mismatch on the canvas. The draft skips other projects, but the expectation says to create a task. Which behavior do you intend?');
  }
  if (/scenario|example cases/.test(lower)) return exchange(state, text, { type: 'validate' }, 'I put three example scenarios on the canvas. Please inspect their expected outcomes; you can change an expectation there before asking me to run them.');
  if (/review|approv|activat/.test(lower)) return exchange(state, text, { type: 'step', step: 'review' }, 'Here is the current revision and its evidence. The canvas has the explicit review controls. I can explain or revise it, but approval and activation are your decisions.');
  if (/lost response|uncertain/.test(lower)) {
    const s = exchange(state, text, { type: 'unknown' }, 'The canvas shows an uncertain result: the write may have happened. There is no blind retry action. A real integration would need host evidence to resolve it.');
    s.users[s.user].draft.step = 'activity'; return s;
  }
  if (/try.*complet|show.*task|show.*result/.test(lower)) {
    const s = exchange(state, text, { type: 'example' }, 'I added an illustrative before/after result to the canvas. This is the point where the real demo will show the native app’s actual task and execution evidence.');
    s.users[s.user].draft.step = 'activity'; return s;
  }
  if (/disable|turn.*off/.test(lower)) {
    const s = exchange(state, text, { type: 'disable' }, 'This example is disabled for future events. Existing tasks and earlier effects are not undone.'); s.users[s.user].draft.step = 'activity'; return s;
  }
  if (/roll.?back/.test(lower)) {
    const s = exchange(state, text, { type: 'rollback' }, 'I restored the previous selection for future example events. Earlier effects are unchanged.'); s.users[s.user].draft.step = 'activity'; return s;
  }
  if (/cancel|stop/.test(lower)) return exchange(state, text, null, 'There is no in-flight operation in this scripted prototype. Your draft and conversation are retained. Real generation and simulation will need explicit cancellation states.');
  if (/behavior|diagram|explain|why|rule/.test(lower)) return exchange(state, text, { type: 'step', step: 'behavior' }, 'I brought the behavior sketch back onto the canvas. It reads the completed task, checks the project and conditionally creates one task. We can change the choices without changing the active version.');
  return exchange(state, text, null, 'This scripted prototype supports the task-completion example. Try asking me to show the behavior, prepare scenarios, test it, review it, or change the title using quotes. A real agent will clarify your own request rather than use these fixed routes.');
}

export function canvasAction(state, action) {
  if (['user', 'reset'].includes(action.type)) return transition(state, action);
  const d = state.users[state.user].draft;
  const descriptions = {
    edit: [`On the canvas: use ${action.project ?? d.project} and title “${action.title ?? d.title}”.`, 'The draft reflects your choices. Prior approval is invalidated when behavior changes; the active version stays as it was.'],
    expectation: [`On the canvas: for another project, expect ${action.value === 'create' ? 'a created task' : 'no changes'}.`, 'That is your expected outcome. Ask me to run the examples again so we can compare it with the behavior.'],
    approve: [`I reviewed the behavior and expectations for revision ${d.revision} and clicked Approve.`, 'You approved this revision. Nothing has been activated yet. The canvas now offers a separate activation decision.'],
    activate: [`Activate the reviewed prototype revision ${d.revision}.`, 'The reviewed example is selected for future events. We can inspect an illustrative task result, edit the draft or disable it; no real task was changed.'],
    provider: ['I toggled the prototype provider setup state.', 'This only changes the example setup state; no credentials are collected or provider called.'],
  };
  const [text, reply] = descriptions[action.type] ?? ['I used a canvas control.', 'The canvas now reflects that action.'];
  const s = exchange(state, text, action, reply);
  if (action.type === 'edit') s.users[s.user].draft.step = 'behavior';
  return s;
}
