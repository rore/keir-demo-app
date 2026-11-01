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
function respond(state, text) {
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

function actOnCanvas(state, action) {
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

// Snapshots keep old chat receipts honest when the working draft changes.
export function draftKey(d) {
  return JSON.stringify([d.revision, d.project, d.title, d.expectation]);
}
function recordEvidence(state) {
  const u = state.users[state.user];
  u.evidence ??= [];
  const item = { id: u.evidence.length + 1, owner: state.user, draft: structuredClone(u.draft), active: structuredClone(u.active), activity: structuredClone(u.activity) };
  u.evidence.push(item);
  if (u.messages.at(-1)?.role === 'assistant') u.messages.at(-1).evidenceId = item.id;
  if (u.held) u.pendingEvidence = item.id;
  else { u.canvasId = item.id; u.pendingEvidence = null; }
  return state;
}
export function evidenceView(state) {
  const u = state.users[state.user];
  return u.evidence?.find(item => item.id === u.canvasId) ?? null;
}
export function inspectEvidence(state, id) {
  const s = structuredClone(state), u = s.users[s.user];
  const item = u.evidence?.find(entry => entry.id === id);
  if (!item) return s;
  u.canvasId = id; u.held = true;
  u.pendingEvidence = id === u.evidence.at(-1).id ? null : u.evidence.at(-1).id;
  return s;
}
export function followConversation(state) {
  const s = structuredClone(state), u = s.users[s.user];
  u.held = false; u.pendingEvidence = null; u.canvasId = u.evidence?.at(-1)?.id;
  return s;
}
export function holdCanvas(state) {
  const s = structuredClone(state); s.users[s.user].held = true; return s;
}
export function talk(state, text) {
  if (!String(text).trim()) return state;
  if (/^run scenarios$/i.test(text.trim())) return operationAction(state, { type: 'start' });
  if (/^(pause|stop|cancel)( run)?$/i.test(text.trim())) return operationAction(state, { type: 'pause' });
  if (/^resume( run)?$/i.test(text.trim())) return operationAction(state, { type: 'resume' });
  const s = respond(state, text);
  const u = s.users[s.user];
  if (['running', 'paused', 'interrupted'].includes(u.operation?.status) && u.operation.key !== draftKey(u.draft)) u.operation.status = 'superseded';
  if (u.operation && (u.draft.tested || u.draft.mismatch)) u.operation.status = 'complete';
  return recordEvidence(s);
}
export function canvasAction(state, action) {
  if (['approve', 'activate'].includes(action.type) && action.evidenceId != null) {
    const u = state.users[state.user], item = evidenceView(state);
    if (!item || item.id !== action.evidenceId || item.id !== u.evidence.at(-1).id || draftKey(item.draft) !== draftKey(u.draft)) {
      return exchange(state, 'I tried to use an earlier review.', null, 'That review is no longer current. Open the latest proposal and review its evidence.');
    }
  }
  if (action.type === 'user') {
    const s = structuredClone(state), op = s.users[s.user].operation;
    if (action.user !== s.user && people.includes(action.user) && op?.status === 'running') op.status = 'interrupted';
    return actOnCanvas(s, action);
  }
  if (action.type === 'reset') return actOnCanvas(state, action);
  const s = actOnCanvas(followConversation(state), action), u = s.users[s.user];
  if (['running', 'paused', 'interrupted'].includes(u.operation?.status) && u.operation.key !== draftKey(u.draft)) u.operation.status = 'superseded';
  return recordEvidence(s);
}

export function operationAction(state, action) {
  const s = structuredClone(state), u = s.users[s.user], d = u.draft;
  const message = (input, reply) => {
    if (input) u.messages.push({ role: 'user', text: input });
    u.messages.push({ role: 'assistant', text: reply });
    return s;
  };
  if (action.type === 'start') {
    if (!d.started) return message('Run scenarios', 'First, describe the behavior you want.');
    if (u.operation?.status === 'running') return s;
    u.operation = { id: (u.operation?.id ?? 0) + 1, owner: s.user, key: draftKey(d), status: 'running' };
    d.tested = d.approved = d.mismatch = false; d.error = '';
    return message('Run scenarios', `Checking three scripted scenarios for draft r${d.revision}. You can keep talking or pause this run.`);
  }
  if (action.type === 'pause') {
    if (u.operation?.status !== 'running') return message('Pause run', 'No run is in progress. Your draft and evidence are retained.');
    u.operation.status = 'paused';
    return message('Pause run', 'Run paused. No new result is available; your draft, conversation and earlier evidence are saved in this tab.');
  }
  if (action.type === 'resume') {
    if (!['paused', 'interrupted'].includes(u.operation?.status) || u.operation.key !== draftKey(d)) return message('Resume run', 'That run cannot resume against this draft. Start a new run for the current revision.');
    u.operation.status = 'running'; u.operation.id++;
    return message('Resume run', `Resuming the scripted check for draft r${d.revision}.`);
  }
  if (action.type === 'finish') {
    const op = u.operation;
    if (!op || op.status !== 'running' || op.id !== action.id || op.owner !== action.owner || op.key !== draftKey(d)) return s;
    let result = transition(s, { type: 'validate' }); result = transition(result, { type: 'simulate' });
    result.users[s.user].operation.status = 'complete';
    result.users[s.user].messages.push({ role: 'assistant', text: result.users[s.user].draft.mismatch ? 'One scenario differs from your expectation. The other-project case expects a new task, but this draft makes no change. Which result do you intend?' : 'All three scripted scenarios match. Review the behavior, scope and remaining limits before approving this revision.' });
    return recordEvidence(result);
  }
  return s;
}

export function restoreSession(saved) {
  const s = structuredClone(saved);
  for (const u of Object.values(s.users)) if (u.operation?.status === 'running') u.operation.status = 'interrupted';
  return s;
}

export function workingState() {
  let s = initialState();
  for (const user of ['Maya', 'Leo']) {
    s.user = user;
    s = talk(s, 'When I complete a task, create a follow-up.');
    s = talk(s, 'Test it');
    s = canvasAction(s, { type: 'approve', behavior: true, scenarios: true });
    s = canvasAction(s, { type: 'activate' });
    s = canvasAction(s, { type: 'edit', title: user === 'Maya' ? 'Prepare next step' : 'Review next step' });
    const u = s.users[user];
    u.draft.expectation = 'create';
    u.messages.push({ role: 'user', text: 'I want to change the follow-up. Does it also apply to completed tasks in another project?' }, { role: 'assistant', text: `The active version still creates “${u.active.title}”. This draft proposes “${u.draft.title}” in ${u.draft.project}. Should another project create a follow-up too, or make no change? We can compare that expectation with the draft.` });
    s = recordEvidence(s);
  }
  s.user = 'Maya';
  return s;
}
