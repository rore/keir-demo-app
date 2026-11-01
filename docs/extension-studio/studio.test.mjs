import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transition as next, talk, canvasAction, workingState, evidenceView, inspectEvidence, followConversation, holdCanvas, operationAction, restoreSession } from './studio.mjs';
import { prototypeServer } from './serve.mjs';
function reviewed(s = initialState()) { s = next(s, { type: 'validate' }); s = next(s, { type: 'simulate' }); return next(s, { type: 'approve', behavior: true, scenarios: true }); }
test('activation requires current validation, simulation and explicit review', () => {
  let s = next(initialState(), { type: 'activate' }); assert.equal(s.users.Maya.active, null);
  s = next(s, { type: 'validate' }); s = next(s, { type: 'approve', behavior: true, scenarios: true }); assert.equal(s.users.Maya.draft.approved, false);
  s = reviewed(); assert.equal(s.users.Maya.active, null); s = next(s, { type: 'activate' }); assert.equal(s.users.Maya.active.revision, 1);
});
test('draft edits invalidate review but preserve the exact active snapshot', () => {
  let s = next(reviewed(), { type: 'activate' }); s = next(s, { type: 'edit', title: 'A different task' });
  assert.equal(s.users.Maya.draft.revision, 2); assert.equal(s.users.Maya.draft.approved, false); assert.equal(s.users.Maya.active.title, 'Review completion');
  s = next(s, { type: 'activate' }); assert.equal(s.users.Maya.active.revision, 1);
});
test('changing scenario expectations invalidates approval and mismatch blocks it', () => {
  let s = next(reviewed(), { type: 'expectation', value: 'create' }); assert.equal(s.users.Maya.draft.approved, false);
  s = next(s, { type: 'simulate' }); assert.equal(s.users.Maya.draft.mismatch, true);
  s = next(s, { type: 'approve', behavior: true, scenarios: true }); assert.equal(s.users.Maya.draft.approved, false);
  s = next(s, { type: 'expectation', value: 'skip' }); s = reviewed(s); assert.equal(s.users.Maya.draft.approved, true);
});
test('user switching and actions preserve other user drafts and selections', () => {
  let s = next(reviewed(), { type: 'activate' }); const maya = structuredClone(s.users.Maya);
  s = next(s, { type: 'user', user: 'Leo' }); s = next(s, { type: 'edit', title: 'Leo only' }); s = next(reviewed(s), { type: 'activate' }); s = next(s, { type: 'disable' });
  assert.deepEqual(s.users.Maya, maya); assert.equal(s.users.Leo.active.enabled, false); assert.equal(s.users.Sam.active, null);
});
test('rollback changes future selection without mutating earlier activity', () => {
  let s = next(reviewed(), { type: 'activate' }); s = next(s, { type: 'example' }); s = next(s, { type: 'edit', title: 'Second revision' }); s = next(reviewed(s), { type: 'activate' });
  s = next(s, { type: 'rollback' }); assert.equal(s.users.Maya.active.revision, 1); assert(s.users.Maya.activity.some(a => a.kind === 'example'));
});
test('missing provider blocks generation, not review of existing work', () => {
  let s = next(initialState(), { type: 'provider' }); s = next(s, { type: 'generate', request: 'Create follow-up work' }); assert.equal(s.users.Maya.draft.step, 'describe'); assert.match(s.users.Maya.draft.error, /provider/);
  s = reviewed(s); assert.equal(s.users.Maya.draft.approved, true);
});
test('unknown effect stays uncertain and is not retried by the prototype', () => {
  let s = next(reviewed(), { type: 'activate' }); s = next(s, { type: 'unknown' }); assert.match(s.users.Maya.activity[0].text, /UNKNOWN/); assert.equal(s.users.Maya.activity.filter(a => a.kind === 'example').length, 0);
});
test('selecting the same active revision does not invent another activation or rollback entry', () => {
  const s = next(reviewed(), { type: 'activate' }); const again = next(s, { type: 'activate' });
  assert.deepEqual(again.users.Maya.history, []); assert.equal(again.users.Maya.activity.length, 1);
});
test('reset restores an untouched review walkthrough', () => {
  assert.deepEqual(next(next(reviewed(), { type: 'activate' }), { type: 'reset' }), initialState());
});
test('local prototype server exposes only its two public assets', async t => {
  const server = prototypeServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const root = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(root); assert.equal(page.status, 200); assert.match(await page.text(), /INTERACTIVE DESIGN PROTOTYPE/);
  const script = await fetch(root + '/studio.mjs'); assert.equal(script.status, 200); assert.match(script.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(root + '/README.md')).status, 404);
  assert.equal((await fetch(root, { method: 'POST' })).status, 405);
});
test('chat introduces a contextual canvas without approving or activating anything', () => {
  const s = talk(initialState(), 'When I complete a task, create a follow-up.');
  assert.equal(s.users.Maya.draft.step, 'behavior'); assert.equal(s.users.Maya.messages.length, 3);
  assert.equal(s.users.Maya.messages[1].role, 'user'); assert.equal(s.users.Maya.active, null); assert.equal(s.users.Maya.draft.approved, false);
});
test('conversation can revisit behavior while retaining prior tests and messages', () => {
  let s = talk(initialState(), 'A completion follow-up'); s = talk(s, 'Show some scenarios'); s = talk(s, 'Test it');
  assert.equal(s.users.Maya.draft.tested, true); s = talk(s, 'Explain the behavior in Launch');
  assert.equal(s.users.Maya.draft.step, 'behavior'); assert.equal(s.users.Maya.draft.tested, true); assert.equal(s.users.Maya.messages.length, 9);
});
test('canvas edits return user input to chat and invalidate review', () => {
  let s = reviewed(talk(initialState(), 'Completion follow-up')); s = next(s, { type: 'activate' });
  s = canvasAction(s, { type: 'edit', title: 'New title' });
  assert.equal(s.users.Maya.draft.approved, false); assert.equal(s.users.Maya.draft.step, 'behavior');
  assert.equal(s.users.Maya.active.title, 'Review completion'); assert.match(s.users.Maya.messages.at(-2).text, /preview/);
  assert.match(s.users.Maya.messages.at(-2).text, /New title/);
});
test('a chat request to activate brings up human review instead of self-approval', () => {
  const s = talk(reviewed(talk(initialState(), 'Completion follow-up')), 'Activate it');
  assert.equal(s.users.Maya.draft.step, 'review'); assert.equal(s.users.Maya.active, null);
});
test('chat and canvas history remain scoped when changing demo users', () => {
  let s = talk(initialState(), 'Maya request'); const maya = structuredClone(s.users.Maya);
  s = canvasAction(s, { type: 'user', user: 'Leo' }); s = talk(s, 'Leo request');
  assert.deepEqual(s.users.Maya, maya); assert.equal(s.users.Leo.messages[1].text, 'Leo request');
});
test('restoring example setup clears a stale missing-provider error', () => {
  let s = canvasAction(initialState(), { type: 'provider' }); s = talk(s, 'Create a completion follow-up');
  assert.match(s.users.Maya.draft.error, /provider/); s = canvasAction(s, { type: 'provider' });
  assert.equal(s.provider, true); assert.equal(s.users.Maya.draft.error, '');
});

test('saved evidence reopens the exact draft and results after later edits', () => {
  let s = talk(talk(initialState(), 'Completion follow-up'), 'Test it');
  const result = structuredClone(evidenceView(s));
  s = canvasAction(s, { type: 'edit', title: 'A later title' });
  s = inspectEvidence(s, result.id);
  assert.deepEqual(evidenceView(s), result);
  assert.equal(s.users.Maya.draft.title, 'A later title');
  assert.equal(evidenceView(s).draft.title, 'Review completion');
  assert.equal(evidenceView(s).active, null);
});
test('held canvas offers new evidence without replacing the inspected snapshot', () => {
  let s = holdCanvas(workingState());
  const held = structuredClone(evidenceView(s));
  s = talk(s, 'Test it');
  assert.deepEqual(evidenceView(s), held);
  assert.equal(s.users.Maya.pendingEvidence, s.users.Maya.evidence.at(-1).id);
  s = followConversation(s);
  assert.equal(evidenceView(s).draft.mismatch, true);
  assert.equal(s.users.Maya.pendingEvidence, null);
  assert.equal(s.users.Maya.held, false);
});
test('historical review cannot approve or activate a later proposal', () => {
  let s = talk(talk(talk(initialState(), 'Follow-up'), 'Test it'), 'Review this revision');
  const oldId = evidenceView(s).id;
  s = canvasAction(s, { type:'edit', title:'Changed' });
  s = talk(s, 'Test it');
  s = inspectEvidence(s, oldId);
  s = canvasAction(s, { type:'approve', behavior:true, scenarios:true, evidenceId:oldId });
  assert.equal(s.users.Maya.draft.approved, false);
  s = canvasAction(s, { type:'activate', evidenceId:oldId });
  assert.equal(s.users.Maya.active, null);
  assert.match(s.users.Maya.messages.at(-1).text, /no longer current/);
});
test('current exact review approves separately from activation', () => {
  let s = talk(workingState(), 'For another project, expect no change');
  s = talk(s, 'Review this revision');
  s = canvasAction(s, { type:'approve', behavior:true, scenarios:true, evidenceId:evidenceView(s).id });
  assert.equal(s.users.Maya.active.revision, 1);
  assert.equal(s.users.Maya.draft.approved, true);
  s = canvasAction(s, { type:'activate', evidenceId:evidenceView(s).id });
  assert.equal(s.users.Maya.active.revision, 2);
});
test('paused run ignores late completion and resumes with a fresh operation identity', () => {
  let s = operationAction(workingState(), { type:'start' });
  const first = s.users.Maya.operation.id;
  s = operationAction(s, { type:'pause' });
  const paused = structuredClone(s);
  s = operationAction(s, { type:'finish', id:first, owner:'Maya' });
  assert.deepEqual(s, paused);
  s = operationAction(s, { type:'resume' });
  assert.notEqual(s.users.Maya.operation.id, first);
  s = operationAction(s, { type:'finish', id:s.users.Maya.operation.id, owner:'Maya' });
  assert.equal(s.users.Maya.operation.status, 'complete');
  assert.equal(evidenceView(s).draft.mismatch, true);
  assert.equal(s.users.Maya.active.revision, 1);
});
test('reload marks running work interrupted and keeps draft, evidence and ownership', () => {
  const running = operationAction(workingState(), { type:'start' });
  const resumed = restoreSession(JSON.parse(JSON.stringify(running)));
  assert.equal(resumed.users.Maya.operation.status, 'interrupted');
  assert.deepEqual(resumed.users.Maya.draft, running.users.Maya.draft);
  assert.deepEqual(resumed.users.Maya.evidence, running.users.Maya.evidence);
  assert.equal(operationAction(resumed, { type:'resume' }).users.Maya.operation.status, 'running');
});
test('late results cannot cross users or apply to changed drafts', () => {
  let s = operationAction(workingState(), { type:'start' });
  const id = s.users.Maya.operation.id;
  s = canvasAction(s, { type:'user', user:'Leo' });
  assert.deepEqual(operationAction(s, { type:'finish', id, owner:'Maya' }), s);
  s = canvasAction(s, { type:'user', user:'Maya' });
  s = canvasAction(s, { type:'edit', title:'Different draft' });
  assert.equal(s.users.Maya.operation.status, 'superseded');
  assert.deepEqual(operationAction(s, { type:'finish', id, owner:'Maya' }), s);
});
test('populated proposal has distinct user histories and an empty first-use user', () => {
  const s = workingState();
  assert.equal(s.users.Maya.active.title, 'Review completion');
  assert.equal(s.users.Maya.draft.title, 'Prepare next step');
  assert.equal(s.users.Leo.draft.project, 'Operations');
  assert.equal(s.users.Sam.active, null);
  assert.equal(s.users.Sam.draft.started, false);
});
test('correcting a completed run does not leave a false interruption notice', () => {
  let s = operationAction(workingState(), { type:'start' });
  s = operationAction(s, { type:'finish', id:s.users.Maya.operation.id, owner:'Maya' });
  s = talk(s, 'For another project, expect no change');
  assert.equal(s.users.Maya.operation.status, 'complete');
  assert.equal(s.users.Maya.draft.tested, true);
  s = operationAction(s, { type:'start' });
  assert.equal(s.users.Maya.draft.mismatch, false);
  s = canvasAction(s, { type:'user', user:'Leo' });
  assert.equal(s.users.Maya.operation.status, 'interrupted');
});

test('ordinary-language scope choice checks examples without changing the current setup', () => {
  let s = talk(workingState(), 'Only Operations');
  assert.equal(s.users.Maya.draft.project, 'Operations');
  assert.equal(s.users.Maya.draft.expectation, 'skip');
  assert.equal(s.users.Maya.draft.tested, true);
  assert.equal(s.users.Maya.draft.approved, false);
  assert.equal(s.users.Maya.active.project, 'Launch');
  s = talk(s, 'Show me what will change');
  assert.equal(s.users.Maya.draft.step, 'review');
  s = talk(s, 'Turn this on');
  assert.equal(s.users.Maya.draft.approved, false);
  assert.equal(s.users.Maya.active.revision, 1);
});

test('visible conversation suggestions lead to examples, editable preview and human review', () => {
  let s = talk(workingState(), 'Try a few examples');
  assert.equal(s.users.Maya.operation.status, 'running');
  s = talk(s, 'Pause');
  assert.equal(s.users.Maya.operation.status, 'paused');
  s = talk(s, 'Continue');
  assert.equal(s.users.Maya.operation.status, 'running');
  s = talk(s, 'Only Launch');
  assert.equal(s.users.Maya.operation.status, 'complete');
  for (const prompt of ['Show me an example', 'Change the task title', 'Talk it through']) {
    s = talk(s, prompt);
    assert.equal(s.users.Maya.draft.step, 'behavior');
    assert.equal(s.users.Maya.draft.tested, true);
  }
  s = talk(s, 'Looks right');
  assert.equal(s.users.Maya.draft.step, 'review');
  assert.equal(s.users.Maya.draft.approved, false);
});

test('asking for all projects explains the preview limit without silently narrowing intent', () => {
  const before = workingState(), after = talk(before, 'Other projects too');
  assert.deepEqual(after.users.Maya.draft, before.users.Maya.draft);
  assert.deepEqual(after.users.Maya.active, before.users.Maya.active);
  assert.match(after.users.Maya.messages.at(-1).text, /one project at a time/);
});
