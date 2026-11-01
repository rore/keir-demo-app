// Scripted UX model only. No compiler, model provider, host service or real activation.
export const people = ['Maya', 'Leo', 'Sam'];
export function draft(project = 'Launch', title = 'Review completion') {
  return { revision: 1, project, title, request: `When a task is completed in ${project}, create a task called “${title}”.`, started: false, validated: false, tested: false, mismatch: false, expectation: 'skip', approved: false, error: '', step: 'describe' };
}
export function initialState() {
  return { user: 'Maya', provider: true, users: Object.fromEntries(people.map(name => [name, { draft: draft(name === 'Leo' ? 'Operations' : 'Launch', name === 'Leo' ? 'Plan next step' : 'Review completion'), active: null, history: [], activity: [], messages: [{ role: 'assistant', text: 'What would you like your task app to do for you? Tell me in your own words. I’ll show you an example as we work it out.' }] }])) };
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
      if (['test', 'review'].includes(action.step) && !d.validated) return fail('Let’s try a few examples before you decide.');
      if (action.step === 'review' && !d.tested) return fail('Let’s try a few examples first, so you can see what would happen.');
      if (['describe', 'behavior', 'test', 'review', 'activity'].includes(action.step)) d.step = action.step;
      break;
    case 'generate':
      if (!s.provider) return fail('The assistant is not connected. Ask the person who manages this app to connect its AI provider, then try again. Your saved work is still here.');
      if (!String(action.request ?? '').trim()) return fail('Tell me what you’d like the app to do.');
      d.request = action.request; d.started = true; d.step = 'behavior'; d.validated = d.tested = d.approved = false;
      break;
    case 'edit': {
      const project = action.project ?? d.project, title = action.title ?? d.title;
      if (!['Launch', 'Operations'].includes(project) || !title.trim() || title.length > 120) return fail('Choose a project and a title of 1–120 characters.');
      if (project !== d.project || title !== d.title) { d.project = project; d.title = title; d.revision++; d.validated = d.tested = d.approved = false; d.mismatch = false; }
      break;
    }
    case 'validate': d.validated = true; d.step = 'test'; break;
    case 'unsupported': d.validated = d.tested = d.approved = false; d.step = 'behavior'; return fail('This example can act when you finish a task, but it cannot run on a schedule. Would acting when a task is finished help?');
    case 'expectation': d.expectation = action.value === 'create' ? 'create' : 'skip'; d.tested = d.approved = false; break;
    case 'simulate':
      if (!d.validated) return fail('Let’s check your latest changes before trying the examples.');
      d.mismatch = d.expectation !== 'skip'; d.tested = !d.mismatch; d.approved = false;
      break;
    case 'approve':
      if (!d.validated || !d.tested || d.mismatch || !action.behavior || !action.scenarios) return fail('Please confirm both what will change and the examples before continuing.');
      d.approved = true; break;
    case 'activate':
      if (!d.approved || !d.validated || !d.tested) return fail('We need to check the examples and confirm this is what you want before turning it on.');
      if (u.active?.enabled && u.active.revision === d.revision && u.active.project === d.project && u.active.title === d.title) { d.step = 'activity'; break; }
      if (u.active) u.history.push(structuredClone(u.active));
      u.active = { revision: d.revision, project: d.project, title: d.title, enabled: true }; d.step = 'activity';
      u.activity.unshift({ kind: 'activated', text: `“${d.title}” is now the follow-up for completed tasks in ${d.project}.` });
      break;
    case 'example':
      if (!u.active?.enabled) return fail('This is not turned on yet. Review your change first.');
      u.activity.unshift({ kind: 'example', text: `Illustration: completed “Send the project update” → created “${u.active.title}” in ${u.active.project}.` });
      break;
    case 'unknown':
      if (!u.active?.enabled) return fail('Turn on your reviewed change first.');
      u.activity.unshift({ kind: 'unknown', text: 'We could not confirm whether the follow-up was added. Check your task list before trying again; another attempt could add it twice. Technical status: UNKNOWN / UNCERTAIN.' });
      break;
    case 'disable':
      if (u.active) { u.active.enabled = false; u.activity.unshift({ kind: 'disabled', text: 'Turned off. No new follow-ups will be added. Tasks already added stay in your list.' }); }
      break;
    case 'rollback':
      if (!u.history.length) return fail('There is no earlier setup to return to yet.');
      u.active = u.history.pop(); u.active.enabled = true;
      u.activity.unshift({ kind: 'rollback', text: `Returned to “${u.active.title}” for future follow-ups. Tasks already added stay in your list.` }); break;
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
    return exchange(state, text, { type: 'generate', request: text }, `This preview lets us explore adding a follow-up when you finish a task. Should it happen only in ${d.project}? I’ve shown a task and its follow-up beside our conversation.`);
  }
  if (/all projects|other projects too|every project/.test(lower)) return exchange(state, text, null, 'You want this in more than one project. This preview can show one project at a time: Launch or Operations. I haven’t changed your choice. Tell me which one to explore, or keep this request for the full app.');
  const project = /\boperations\b/i.test(text) ? 'Operations' : /\blaunch\b/i.test(text) ? 'Launch' : null;
  const title = text.match(/(?:call|title|name)[\s\S]*?["“]([^"”]+)["”]/i)?.[1] ?? text.match(/^title:\s*(.+)$/i)?.[1];
  if ((project && /use|apply|instead|switch|project:/.test(lower)) || title) {
    const s = exchange(state, text, { type: 'edit', project: project ?? d.project, title: title ?? d.title }, 'I updated the preview. Your current setup hasn’t changed. Let’s try a few examples before you turn this change on.');
    s.users[s.user].draft.step = 'behavior'; return s;
  }
  if (/\bdisable\b|\bturn\b.*\boff\b/.test(lower)) {
    const s = exchange(state, text, { type: 'disable' }, 'Turned off. Tasks already added stay in your list.'); s.users[s.user].draft.step = 'activity'; return s;
  }
  if (/fix.*expectation|expect.*no change|^only (launch|operations)[.!]?$/.test(lower)) {
    let s = /^only /i.test(text) && project ? transition(state, { type: 'edit', project }) : state;
    s = transition(s, { type: 'expectation', value: 'skip' }); s = transition(s, { type: 'validate' });
    return exchange(s, text, { type: 'simulate' }, 'Got it — leave other projects alone. I tried three examples: a finished task here, one in another project, and a task that no longer exists. They all do what you asked. Take a look, then we can review the change.');
  }
  if (/mismatch/.test(lower)) {
    let s = transition(state, { type: 'expectation', value: 'create' }); s = transition(s, { type: 'validate' });
    return exchange(s, text, { type: 'simulate' }, 'There’s one thing to decide. You wanted a follow-up in another project, but this change would leave that project alone. Which should happen?');
  }
  if (/test|simulate|run.*scenario/.test(lower)) {
    const s = transition(state, { type: 'validate' });
    return exchange(s, text, { type: 'simulate' }, d.expectation === 'skip' ? 'The three examples do what you asked. A finished task here gets a follow-up. Other projects stay as they are, and a missing task adds nothing. Take a look at the results.' : 'One example needs your decision: should finishing a task in another project add a follow-up, or leave that project alone?');
  }
  if (/scenario|example cases/.test(lower)) return exchange(state, text, { type: 'validate' }, 'Here are three situations we can try without changing your tasks. Tell me if you’d want a different result.');
  if (/review|approv|activat|looks right|\bturn\b.*\bon\b|what will change/.test(lower)) return exchange(state, text, { type: 'step', step: 'review' }, 'Here’s what will change. Check the summary and examples, then confirm that this is what you want. You’ll choose separately when to turn it on.');
  if (/lost response|uncertain/.test(lower)) {
    const s = exchange(state, text, { type: 'unknown' }, 'The follow-up may have been added, but we couldn’t confirm it. Check the task list before trying again, so you don’t add it twice.');
    s.users[s.user].draft.step = 'activity'; return s;
  }
  if (/try.*complet|show.*task|show.*result/.test(lower)) {
    const s = exchange(state, text, { type: 'example' }, 'Here’s an example of the follow-up being added. This preview uses sample tasks; your real task list hasn’t changed.');
    s.users[s.user].draft.step = 'activity'; return s;
  }
  if (/roll.?back/.test(lower)) {
    const s = exchange(state, text, { type: 'rollback' }, 'I returned to your previous setup. Tasks already added stay in your list.'); s.users[s.user].draft.step = 'activity'; return s;
  }
  if (/cancel|stop/.test(lower)) return exchange(state, text, null, 'Nothing is running right now. Your conversation and changes are saved in this tab.');
  if (/behavior|diagram|explain|why|rule|show me an example|change the task title|talk it through/.test(lower)) return exchange(state, text, { type: 'step', step: 'behavior' }, `When you finish a task in ${d.project}, this would add “${d.title}”. The preview shows an example. You can change the project or task name there, or tell me here.`);
  return exchange(state, text, null, 'This preview has a few example conversations. Try “Show me an example”, “Try a few examples”, or ‘Call the task “Plan next step”’. Your request hasn’t changed the setup.');
}

function actOnCanvas(state, action) {
  if (['user', 'reset'].includes(action.type)) return transition(state, action);
  const d = state.users[state.user].draft;
  const descriptions = {
    edit: [`In the preview: use ${action.project ?? d.project} and call the task “${action.title ?? d.title}”.`, 'I updated the preview. Your current setup stays as it is until you check and turn on this change.'],
    expectation: [`On the canvas: for another project, expect ${action.value === 'create' ? 'a created task' : 'no changes'}.`, 'That is your expected outcome. Ask me to run the examples again so we can compare it with the behavior.'],
    approve: [`I checked this change and its examples. This is what I want.`, 'Confirmed. You can turn it on when you’re ready. Your current setup hasn’t changed yet.'],
    activate: [`Turn on the change I just confirmed.`, `It’s on in this preview. Future finished tasks in ${d.project} will get “${d.title}”. You can change this or turn it off any time. No real tasks were changed.`],
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
  if (/^(run scenarios|try a few examples)$/i.test(text.trim())) return operationAction(state, { type: 'start' });
  if (/^(pause|stop|cancel)( run)?$/i.test(text.trim())) return operationAction(state, { type: 'pause' });
  if (/^(resume( run)?|continue)$/i.test(text.trim())) return operationAction(state, { type: 'resume' });
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
      return exchange(state, 'I tried to use an earlier review.', null, 'That review is no longer current. Open your latest changes and check their examples first.');
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
    if (!d.started) return message('Try a few examples', 'First, tell me what you’d like the app to do.');
    if (u.operation?.status === 'running') return s;
    u.operation = { id: (u.operation?.id ?? 0) + 1, owner: s.user, key: draftKey(d), status: 'running' };
    d.tested = d.approved = d.mismatch = false; d.error = '';
    return message('Try a few examples', 'I’m trying three examples without changing your tasks. You can keep talking or pause.');
  }
  if (action.type === 'pause') {
    if (u.operation?.status !== 'running') return message('Pause', 'Nothing is running. Your changes and earlier examples are saved.');
    u.operation.status = 'paused';
    return message('Pause', 'Paused. Your conversation and earlier examples are saved in this tab. Continue whenever you’re ready.');
  }
  if (action.type === 'resume') {
    if (!['paused', 'interrupted'].includes(u.operation?.status) || u.operation.key !== draftKey(d)) return message('Continue', 'Your changes are different now. Let’s try the examples again with your latest choices.');
    u.operation.status = 'running'; u.operation.id++;
    return message('Continue', `Continuing the examples for your latest changes.`);
  }
  if (action.type === 'finish') {
    const op = u.operation;
    if (!op || op.status !== 'running' || op.id !== action.id || op.owner !== action.owner || op.key !== draftKey(d)) return s;
    let result = transition(s, { type: 'validate' }); result = transition(result, { type: 'simulate' });
    result.users[s.user].operation.status = 'complete';
    result.users[s.user].messages.push({ role: 'assistant', text: result.users[s.user].draft.mismatch ? 'One example needs your decision. Should finishing a task in another project add a follow-up, or leave that project alone?' : 'All three examples do what you asked. Take a look at the results, then we can review what will change.' });
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
    u.messages.push({ role: 'user', text: 'I want to change the follow-up. Does it also apply to completed tasks in another project?' }, { role: 'assistant', text: `Your current setup still adds “${u.active.title}”. I’ve shown the change to “${u.draft.title}” beside our conversation. Should this happen only in ${u.draft.project}, or in other projects too?` });
    s = recordEvidence(s);
  }
  s.user = 'Maya';
  return s;
}
