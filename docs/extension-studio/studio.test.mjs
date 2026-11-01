import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transition as next, talk, canvasAction } from './studio.mjs';
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
  assert.equal(s.users.Maya.active.title, 'Review completion'); assert.match(s.users.Maya.messages.at(-2).text, /canvas/);
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
