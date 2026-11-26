import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { createApp } from '../src/app.mjs';
import { openData, resetData, taskService } from '../src/data.mjs';
import { teamProjectService } from '../src/team-native.mjs';
import { triageOffer } from './fixtures/team-authored.mjs';
import { readAuthoringConfig, estimateAuthoringMicros } from '../src/authoring-config.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { admitTaskDraft, seedEarlierTeamDiscussion } from './fixtures/task-authoring.mjs';

for (const failure of ['malformed usage', 'lost replies', 'incomplete replies'])
test(`Personal and Team settle the same durable allowance, preserving ${failure}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'daymark-settlement-')), path = join(directory, 'app.sqlite');
  const origin = 'http://127.0.0.1:32089';
  const config = readAuthoringConfig({ KEIR_AI_PROVIDER: 'openai', KEIR_AI_MODEL: 'gpt-5.6-terra', KEIR_AI_MAX_USD: '0.4', OPENAI_API_KEY: 'synthetic-key' });
  let db = openData(path), app, sent = 0, final = false;
  t.after(async () => { await app?.close(); db?.close(); rmSync(directory, { recursive: true, force: true }); });
  const team = taskService(db).createProject('maya', { name: 'Settlement team', mode: 'TEAM' });
  seedEarlierTeamDiscussion(db, team.id);
  const earlier = admitTaskDraft(db, createLifecycle(db));
  const fetchImpl = async (_url, request) => {
    sent++;
    assert.ok(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros >= config.reserveMicros);
    if (final && failure === 'lost replies') throw new Error('synthetic lost reply');
    assert.ok(JSON.parse(request.body).tools.every(tool => tool.name !== 'resolve_intent'));
    if (final && failure === 'incomplete replies') return Response.json({
      status: 'incomplete', id: 'private-incomplete-reply-id',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'private-incomplete-reply-text' }] }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'You can review and discuss changes.' }] }];
    const usage = { input_tokens: 100, output_tokens: 10,
      input_tokens_details: { cached_tokens: final && failure === 'malformed usage' ? 101 : 10, cache_write_tokens: 20 } };
    return Response.json({ status: 'completed', output, usage });
  };
  async function boot() {
    app = await createApp({ db, origin, authoring: { config, fetchImpl } });
    const headers = { host: '127.0.0.1:32089', origin, 'content-type': 'application/json' };
    const initial = (await app.inject({ url: '/api/session', headers })).json();
    const login = await app.inject({ method: 'POST', url: '/api/session', headers: { ...headers, 'x-session-context': initial.contextToken }, payload: { userId: 'maya' } });
    assert.equal(login.statusCode, 200, login.body);
    Object.assign(headers, { cookie: `keir_demo_session=${login.cookies[0].value}`, 'x-session-context': login.json().contextToken });
    return (url, payload) => app.inject({ method: payload ? 'POST' : 'GET', url, headers, ...(payload && { payload }) });
  }
  async function settled(call, url, expected) {
    for (let i = 0; i < 50; i++) {
      const response = await call(url);
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json();
      const conversation = result.conversation ?? result;
      if (conversation?.status === expected) return conversation;
      if (conversation?.status && !['RUNNING', 'CANCELLING'].includes(conversation.status))
        assert.equal(conversation.status, expected, JSON.stringify({ status: conversation.status, code: conversation.code }));
      await setImmediate();
    }
    assert.fail(`No ${expected} reply through ${url}`);
  }
  let call = await boot();
  const base = `/api/projects/${team.id}/authoring`;
  const personal = { conversationId: earlier.conversationId, operationId: randomUUID(), expectedVersion: 0, expectedDraftVersion: 0,
    text: 'What can I do?', intent: 'auto', target: { kind: 'resume', extensionId: earlier.extensionId } };
  const start = await call('/api/authoring/turn', personal);
  assert.equal(start.statusCode, 202, start.body);
  await settled(call, `/api/authoring/conversations/${start.json().conversation.id}`, 'IDLE');
  const input = { operationId: randomUUID(), expectedVersion: 0, expectedDraftVersion: 0, text: 'What can we do?' };
  assert.equal((await call(base + '/turn', input)).statusCode, 202);
  await settled(call, base, 'IDLE');
  assert.equal(sent, 2, 'The cap is smaller than two full holds, yet both turns finish.');
  const estimated = 2 * 312;
  assert.deepEqual((await call('/api/authoring/setup')).json().allowance, { estimatedMicros: estimated, heldMicros: 0 });
  await app.close(); app = null; db.close(); db = openData(path); call = await boot();
  assert.equal((await call(base + '/turn', input)).statusCode, 202);
  assert.equal(sent, 2);
  assert.deepEqual((await call('/api/authoring/setup')).json().allowance, { estimatedMicros: estimated, heldMicros: 0 });
  final = true;
  const finalInput = { ...input, operationId: randomUUID(), expectedVersion: 1 };
  assert.equal((await call(base + '/turn', finalInput)).statusCode, 202);
  const stopped = await settled(call, base, failure === 'malformed usage' ? 'IDLE' : 'BLOCKED');
  const incomplete = failure === 'incomplete replies';
  assert.equal(stopped.code, incomplete ? 'PROVIDER_REPLY_INCOMPLETE' : failure === 'lost replies' ? 'PROVIDER_UNAVAILABLE' : null);
  const dispatches = 3;
  if (incomplete) {
    assert.match(stopped.messages.at(-1).text, /stopped without retrying/);
    assert.equal(stopped.agreement, null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM team_revisions').get().n, 0);
    assert.deepEqual(db.prepare('SELECT kind,outcome FROM authoring_dispatches WHERE run_id=? ORDER BY ordinal')
      .all(stopped.runId).map(row => [row.kind, row.outcome]), [['provider', 'UNKNOWN']]);
    const durable = db.prepare(`SELECT state,view FROM authoring_conversations WHERE run_id=?`).get(stopped.runId);
    assert.doesNotMatch(JSON.stringify([durable, stopped]), /private-incomplete-reply/);
    await app.close(); app = null; db.close(); db = openData(path); call = await boot();
    assert.equal((await settled(call, base, 'BLOCKED')).code, 'PROVIDER_REPLY_INCOMPLETE');
    assert.equal((await call(base + '/turn', finalInput)).statusCode, 202);
  }
  assert.equal(sent, dispatches);
  assert.deepEqual((await call('/api/authoring/setup')).json().allowance, { estimatedMicros: estimated, heldMicros: config.reserveMicros });
  const other = taskService(db).createProject('maya', { name: 'Uncertain team', mode: 'TEAM' });
  seedEarlierTeamDiscussion(db, other.id);
  const blocked = await call(`/api/projects/${other.id}/authoring/turn`, { ...input, operationId: randomUUID() });
  assert.equal(blocked.statusCode, 202);
  await settled(call, `/api/projects/${other.id}/authoring`, 'BLOCKED');
  assert.equal(sent, dispatches);
  const row = db.prepare("SELECT outcome,estimated_micros FROM authoring_dispatches WHERE kind='provider' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(row.outcome, failure === 'malformed usage' ? 'SUCCESS' : 'UNKNOWN');
  assert.equal(row.estimated_micros, null);
  await app.close(); app = null; db.close(); db = null;
  await resetData(directory, true);
  db = openData(path); call = await boot();
  const afterReset = (await call('/api/authoring/setup')).json().allowance;
  assert.equal(afterReset.estimatedMicros, estimated, 'Deleting history cannot reclassify settled spend as a legacy hold.');
  assert.ok(afterReset.heldMicros >= config.reserveMicros);
});

test('usage estimates price observed tokens without inventing cache discounts', () => {
  assert.equal(estimateAuthoringMicros('openai', { input_tokens: 100, output_tokens: 10 }), 370);
  assert.equal(estimateAuthoringMicros('openai', { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 101 } }), null);
  assert.equal(estimateAuthoringMicros('anthropic', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20,
    cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 } }), 20);
  assert.equal(estimateAuthoringMicros('anthropic', { input_tokens: 100_000, output_tokens: 10, cache_read_input_tokens: 1 }), 50_026);
  assert.equal(estimateAuthoringMicros('anthropic', { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: -1 }), null);
});

test('Team discussion is durable and project-scoped, and late provider output cannot survive stop or loss of access', async t => {
  const db = openData(':memory:');
  const launch = taskService(db).createProject('maya', { name: 'Launch', mode: 'TEAM' });
  const other = taskService(db).createProject('maya', { name: 'Other', mode: 'TEAM' });
  seedEarlierTeamDiscussion(db, launch.id);
  seedEarlierTeamDiscussion(db, other.id);
  const projects = teamProjectService(db);
  projects.addMember('maya', launch.id, { userId: 'leo' });
  projects.addMember('maya', other.id, { userId: 'leo' });
  const gates = [], providerRequests = [];
  const response = (calls = [], text = '') => ({ calls, text, usage: { inputTokens: 1, outputTokens: 1 } });
  const config = { status: 'ready', provider: 'openai', model: 'fixture', reserveMicros: 1, maxMicros: 100 };
  const providerFactory = () => ({ reserveMicros: 1, maxMicros: 100, async complete(request) {
    providerRequests.push(request);
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
  assert.deepEqual(current.messages.map(message => message.text), ['Earlier Team discussion', input.text]);
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
   assert.equal(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, 1);

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
  gates[3](response([{ id: 'offer', name: 'offer_proposal', arguments: triageOffer() }]));
  const offered = await waitFor(async () => {
    const value = (await call(maya, 'GET', foreign)).json().conversation;
    return value.agreement && value;
  });
  assert.equal(offered.status, 'AWAITING_USER');
  assert.ok(offered.agreement.claims.length);
  assert.equal(Object.hasOwn(offered, 'proposal'), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM team_revisions').get().n, 0);
  const decision = { runId: offered.runId, expectedVersion: offered.version };
  assert.equal((await call(maya, 'POST', foreign + '/confirm', { ...decision, expectedVersion: offered.version - 1 })).statusCode, 409);
  db.prepare("DELETE FROM project_members WHERE project_id=? AND user_id='leo'").run(other.id);
  assert.equal((await call(maya, 'POST', foreign + '/confirm', decision)).statusCode, 409);
  assert.equal(db.prepare('SELECT count(*) AS n FROM team_revisions').get().n, 0);
  db.prepare("INSERT INTO project_members VALUES (?,'leo','MEMBER')").run(other.id);
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
  gates[4](response([{ id: 'offer', name: 'offer_proposal', arguments: triageOffer() }]));
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

  const before = db.prepare('SELECT * FROM team_drafts WHERE project_id=?').get(other.id);
  const malformed = triageOffer();
  malformed.TaskCreated.outcomes[0].expected.linkedTask.assigneeId = 'Private malformed value';
  const badOffer = { name: 'offer_proposal', arguments: malformed };
  const requestsBefore = providerRequests.length;
  const invalidTurn = { ...input, operationId: randomUUID(), expectedVersion: newOffer.version, expectedDraftVersion: 2 };
  assert.equal((await call(maya, 'POST', foreign + '/turn', invalidTurn)).statusCode, 202);
  await waitFor(() => gates[5]);
  gates[5](response([{ id: 'invalid1', ...badOffer }]));
  await waitFor(() => gates[6]);
  const repair = providerRequests.at(-1);
  assert.deepEqual(repair.tools.map(tool => tool.name), ['offer_proposal']);
  assert.deepEqual(JSON.parse(repair.toolResult.output).diagnostics, [
    { code: 'ASSIGNEE_NOT_CURRENT', path: '/TaskCreated/outcomes/0/expected/linkedTask/assigneeId' },
  ]);
  assert.ok(!repair.toolResult.output.includes('Private malformed value'));
  gates[6](response([{ id: 'invalid2', ...badOffer }]));
  const blocked = await waitFor(async () => {
    const value = (await call(maya, 'GET', foreign)).json().conversation;
    return value.status === 'BLOCKED' && value;
  });
  assert.equal(blocked.code, 'TEAM_OFFER_INVALID');
  assert.equal(blocked.agreement, null);
  assert.match(blocked.messages.at(-1).text, /No draft was saved.*send a new message/);
  assert.ok(!JSON.stringify(blocked).includes('Private malformed value'));
  assert.equal((await call(maya, 'POST', foreign + '/confirm', { runId: blocked.runId, expectedVersion: blocked.version })).statusCode, 409);
  assert.equal((await call(maya, 'POST', foreign + '/turn', invalidTurn)).statusCode, 202);
  assert.equal(providerRequests.length - requestsBefore, 2, 'One offer, one repair; replay spends nothing.');
  assert.deepEqual(db.prepare('SELECT * FROM team_drafts WHERE project_id=?').get(other.id), before);
});
