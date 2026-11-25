import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { createApp } from '../src/app.mjs';
import { openData, taskService } from '../src/data.mjs';
import { teamProjectService } from '../src/team-native.mjs';
import { triageProposal } from './fixtures/team-authored.mjs';

test('Team discussion is durable and project-scoped, and late provider output cannot survive stop or loss of access', async t => {
  const db = openData(':memory:');
  const launch = taskService(db).createProject('maya', { name: 'Launch', mode: 'TEAM' });
  const other = taskService(db).createProject('maya', { name: 'Other', mode: 'TEAM' });
  const projects = teamProjectService(db);
  projects.addMember('maya', launch.id, { userId: 'leo' });
  projects.addMember('maya', other.id, { userId: 'leo' });
  const gates = [];
  const response = (calls = [], text = '') => ({ calls, text, usage: { inputTokens: 1, outputTokens: 1 } });
  const config = { status: 'ready', provider: 'openai', model: 'fixture', reserveMicros: 1, maxMicros: 100 };
  const providerFactory = () => ({ reserveMicros: 1, maxMicros: 100, async complete(request) {
    if (request.tools[0].name === 'resolve_intent') return response([{ id: 'intent', name: 'resolve_intent', arguments: { intent: 'prepare', question: '' } }]);
    const { promise, resolve } = Promise.withResolvers();
    gates.push(resolve);
    return promise;
  } });
  const origin = 'http://127.0.0.1:32089';
  const app = await createApp({ db, origin, authoring: { config, providerFactory } });
  t.after(async () => { for (const resolve of gates) resolve(response()); await app.close(); db.close(); });
  const call = (auth, method, url, payload) => app.inject({ method, url, headers: { host: '127.0.0.1:32089', origin, 'content-type': 'application/json', ...auth },
    ...(payload === undefined ? {} : { payload }) });
  async function login(userId, prior = {}) {
    const session = (await call(prior, 'GET', '/api/session')).json();
    const r = await call({ ...prior, 'x-session-context': session.contextToken }, 'POST', '/api/session', { userId });
    assert.equal(r.statusCode, 200, r.body);
    return { cookie: `keir_demo_session=${r.cookies[0].value}`, 'x-session-context': r.json().contextToken };
  }
  const waitFor = async fn => {
    for (let i = 0; i < 30; i++) { const result = await fn(); if (result) return result; await setImmediate(); }
    assert.fail('The offline turn did not settle');
  };
  let maya = await login('maya');
  const leo = await login('leo');
  const base = `/api/projects/${launch.id}/authoring`;
  const foreign = `/api/projects/${other.id}/authoring`;
  assert.equal((await call(leo, 'GET', base)).statusCode, 403);
  const input = { operationId: randomUUID(), expectedVersion: 0, expectedDraftVersion: 0, text: 'Create a follow-up.' };
  const first = await call(maya, 'POST', base + '/turn', input);
  assert.equal(first.statusCode, 202, first.body);
  const current = first.json().conversation;
  assert.equal(current.status, 'RUNNING');
  assert.deepEqual(current.messages.map(message => message.text), [input.text]);
  assert.equal((await call(maya, 'GET', `/api/authoring/conversations/${current.id}`)).statusCode, 404);
  assert.equal((await call(maya, 'POST', foreign + '/turn', input)).statusCode, 409);
  const cancel = { runId: current.runId, expectedVersion: current.version };
  assert.equal((await call(maya, 'POST', foreign + '/cancel', cancel)).statusCode, 409);
  assert.equal((await call(leo, 'POST', base + '/cancel', cancel)).statusCode, 403);
  assert.equal((await call(maya, 'POST', base + '/turn', input)).statusCode, 202);
  await waitFor(() => gates[0]);
  assert.equal((await call(maya, 'POST', base + '/cancel', cancel)).statusCode, 200);
  gates[0](response([], 'Late cancelled reply'));
  const settled = await waitFor(async () => {
    const value = (await call(maya, 'GET', base)).json().conversation;
    return value.status === 'CANCELLED' && value;
  });
  assert.ok(!settled.messages.some(message => /Late/.test(message.text)));
  assert.equal(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, 2);

  for (const [index, lose, status] of [
    [1, async () => { maya = await login('maya', maya); }, 'CANCELLED'],
    [2, () => { db.prepare("UPDATE project_members SET role='MEMBER' WHERE project_id=? AND user_id='maya'").run(launch.id); }, 'BLOCKED'],
  ]) {
    const turn = await call(maya, 'POST', base + '/turn', { ...input, operationId: randomUUID(), expectedVersion: index });
    assert.equal(turn.statusCode, 202, turn.body);
    await waitFor(() => gates[index]);
    await lose();
    gates[index](response([], 'Late unauthorized reply'));
    const row = await waitFor(() => {
      const value = db.prepare('SELECT status FROM authoring_conversations WHERE id=?').get(current.id);
      return value.status === status && value;
    });
    assert.equal(row.status, status);
    assert.equal(db.prepare("SELECT count(*) AS n FROM authoring_messages WHERE payload LIKE '%Late unauthorized%'").get().n, 0);
  }
  assert.equal((await call(maya, 'GET', base)).statusCode, 403);
  assert.equal(db.prepare('SELECT count(*) AS n FROM team_revisions').get().n, 0);

  const newTurn = await call(maya, 'POST', foreign + '/turn', { ...input, operationId: randomUUID() });
  assert.equal(newTurn.statusCode, 202, newTurn.body);
  await waitFor(() => gates[3]);
  gates[3](response([{ id: 'offer', name: 'offer_proposal', arguments: { proposalJson: JSON.stringify(triageProposal()) } }]));
  const offered = await waitFor(async () => {
    const value = (await call(maya, 'GET', foreign)).json().conversation;
    return value.agreement && value;
  });
  assert.equal(offered.status, 'AWAITING_USER');
  assert.ok(offered.agreement.claims.length);
  assert.equal(Object.hasOwn(offered, 'proposal'), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM team_revisions').get().n, 0);
  const decision = { runId: offered.runId, expectedVersion: offered.version };
  const confirmed = await call(maya, 'POST', foreign + '/confirm', decision);
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().conversation.agreement, null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM team_revisions').get().n, 1);
  const checked = (await call(maya, 'GET', `/api/projects/${other.id}/capability`)).json();
  assert.equal(checked.eligibility.eligible, true);
  assert.equal(checked.evidence.revisionId, checked.draft.revisionId);
  assert.equal(checked.selection.revisionId, null);
  assert.equal((await call(maya, 'POST', foreign + '/confirm', decision)).statusCode, 409);

  const replacement = await call(maya, 'POST', foreign + '/turn', {
    ...input, operationId: randomUUID(), expectedVersion: offered.version, expectedDraftVersion: 1,
  });
  assert.equal(replacement.statusCode, 202, replacement.body);
  await waitFor(() => gates[4]);
  gates[4](response([{ id: 'offer', name: 'offer_proposal', arguments: { proposalJson: JSON.stringify(triageProposal()) } }]));
  const newOffer = await waitFor(async () => {
    const value = (await call(maya, 'GET', foreign)).json().conversation;
    return value.agreement && value;
  });
  db.exec("CREATE TEMP TRIGGER fail_team_evidence BEFORE INSERT ON team_evidence BEGIN SELECT RAISE(ABORT,'Test: evidence unavailable'); END");
  const nextDecision = { runId: newOffer.runId, expectedVersion: newOffer.version };
  const withoutEvidence = await call(maya, 'POST', foreign + '/confirm', nextDecision);
  assert.equal(withoutEvidence.statusCode, 200, withoutEvidence.body);
  assert.equal(withoutEvidence.json().conversation.checkUnavailable, true);
  assert.equal(withoutEvidence.json().conversation.agreement, null);
  const saved = (await call(maya, 'GET', `/api/projects/${other.id}/capability`)).json();
  assert.equal(saved.draftVersion, 2);
  assert.equal(saved.evidence, null);
  assert.equal(saved.eligibility.eligible, false);
  assert.equal((await call(maya, 'POST', foreign + '/confirm', nextDecision)).statusCode, 409);
});
