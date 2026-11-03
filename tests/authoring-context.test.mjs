import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openData } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';
import { createLifecycle, simulationCases, situation } from '../src/extension-lifecycle.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { loadHost } from '../src/extension-catalog.mjs';
import { authoringExample, businessContext, evidenceSummary } from '../src/authoring-example.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { join } from 'node:path';

const input = state => ({ revisionId: state.draft.id, draftVersion: state.draftVersion });
const config = readAuthoringConfig({ KEIR_AI_PROVIDER: 'openai', KEIR_AI_MODEL: 'gpt-5.6-terra', KEIR_AI_MAX_USD: '1', OPENAI_API_KEY: 'synthetic-key' });
const noAiConfig = readAuthoringConfig({});

async function api(t, options = {}) {
  const db = openData(':memory:'), origin = 'http://127.0.0.1:32124';
  const app = await createApp({ db, origin, compiler: {}, ...options });
  t.after(async () => { await app.close(); db.close(); });
  let auth = {};
  const call = (path, payload, headers = {}) => app.inject({ url: '/api/' + path, method: payload === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:32124', origin, 'content-type': 'application/json', ...auth, ...headers },
    ...(payload === undefined ? {} : { payload }) });
  return { db, call, getAuth: () => ({ ...auth }), async login(userId = 'maya') {
    const bootstrap = (await call('session')).json();
    const response = await call('session', { userId }, { 'x-session-context': bootstrap.contextToken });
    assert.equal(response.statusCode, 200);
    auth = { cookie: response.headers['set-cookie'].split(';')[0], 'x-session-context': response.json().contextToken };
  } };
}

async function settled(call, id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await call('authoring/conversations/' + id);
    assert.equal(response.statusCode, 200);
    const value = response.json();
    if (!['RUNNING', 'CANCELLING'].includes(value.status)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Authoring did not settle within the bounded poll.');
}

test('example GET is authenticated, queryless, inert and returns original synthetic situations', async t => {
  let providerCalls = 0;
  const { db, call, login, getAuth } = await api(t, { authoring: { config: noAiConfig, fetchImpl: async () => { providerCalls++; throw Error('unexpected'); } } });
  assert.equal((await call('authoring/example')).statusCode, 401);
  await login();
  const before = db.prepare('SELECT * FROM extension_states ORDER BY owner_id').all();
  const beforeSelection = db.prepare('SELECT * FROM extension_selections ORDER BY owner_id').all();
  const beforeBudget = db.prepare('SELECT * FROM authoring_budget').all();
  assert.equal((await call('authoring/example?owner=leo')).statusCode, 400);
  const response = await call('authoring/example');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), authoringExample());
  const example = response.json(), cases = example.cases.map(JSON.parse);
  assert.equal(cases.length, 5);
  assert.equal(cases.some(item => item.id === 'host-denied'), false);
  assert.deepEqual(example.situations.map(({ id, taskStatus }) => [id, taskStatus]), [
    ['open', 'OPEN'], ['completed', 'COMPLETED'], ['missing', null], ['business-denied', null], ['transient', null],
  ]);
  assert.equal(providerCalls, 0);
  assert.deepEqual(db.prepare('SELECT * FROM extension_states ORDER BY owner_id').all(), before);
  assert.deepEqual(db.prepare('SELECT * FROM authoring_budget').all(), beforeBudget);
  assert.equal(db.prepare('SELECT count(*) n FROM authoring_conversations').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_approvals').get().n, 0);
  assert.deepEqual(db.prepare('SELECT * FROM extension_selections ORDER BY owner_id').all(), beforeSelection);
  const oldSession = getAuth();
  await login('leo');
  assert.equal((await call('authoring/example', undefined, oldSession)).statusCode, 401);
});

test('agent discovery sends static supported context and worked source/scenario without task records', async t => {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body), index = requests.length; requests.push(body);
    const call = index === 0 ? { id: 'call-0', call_id: 'call-0', name: 'discover_catalog', arguments: '{}' } : null;
    const output = [{ type: 'reasoning', id: 'reason-' + index, encrypted_content: 'private-reasoning', summary: [] },
      ...(call ? [{ type: 'function_call', ...call }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I can help with the supported task advice.' }] }])];
    return new Response(JSON.stringify({ status: 'completed', output, usage: { input_tokens: 4, output_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
  };
  const { db, call, login } = await api(t, { authoring: { config, fetchImpl } });
  await login();
  const taskIds = db.prepare('SELECT id FROM tasks').all().map(row => row.id);
  const started = await call('authoring/turn', { conversationId: null, operationId: 'discover-context', text: 'Help with task advice.', expectedVersion: 0, expectedDraftVersion: 0 });
  assert.equal(started.statusCode, 202);
  let current;
  for (let tries = 0; tries < 100; tries++) {
    current = (await call('authoring/conversations/' + started.json().conversation.id)).json();
    if (!['RUNNING', 'CANCELLING'].includes(current.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(current.status, 'IDLE', JSON.stringify(current));
  assert.equal(requests.length, 2);
  assert.match(requests[0].instructions, /plain text, without Markdown, tool names, UUIDs/);
  assert.match(requests[0].instructions, /two or three concise sentences/);
  const receipt = JSON.parse(requests[1].input.find(item => item.type === 'function_call_output').output).result;
  assert.deepEqual(receipt.businessContext, businessContext);
  assert.ok(receipt.sourceExample.includes('NEEDS_ATTENTION'));
  assert.ok(JSON.parse(receipt.scenarioExample).expect);
  assert.deepEqual(receipt.scenarioExamples, authoringExample().cases);
  assert.deepEqual(receipt.scenarioExamples.map(text => JSON.parse(text).id), ['open', 'completed', 'missing', 'business-denied', 'transient']);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 131072);
  for (const text of receipt.scenarioExamples) {
    const row = JSON.parse(text);
    assert.deepEqual(Object.keys(row.stubs[0].args), ['taskId']);
    if (row.stubs[0].response.kind !== 'SUCCESS') assert.deepEqual(row.expect.consumption, { status: 'NOT_DISPLAYED' });
  }
  for (const id of taskIds) assert.equal(JSON.stringify(receipt).includes(id), false);
  assert.equal(JSON.stringify(current).includes('scenarioExample'), false);
});

test('rediscovery carries the saved Pending proposal and clarified intent while isolating owners', async t => {
  const requests = [], source = readFileSync(new URL('../extensions/task-read/maya.yaml', import.meta.url), 'utf8');
  const cases = simulationCases('pending').filter(item => item.id !== 'host-denied').map(item => item.bytes.toString());
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body), index = requests.length; requests.push(body);
    const call = index === 0 ? { name: 'ask_clarification', arguments: { question: 'Should completed tasks still show Done?' } }
      : index === 1 ? { name: 'discover_catalog', arguments: {} } : null;
    const output = [{ type: 'reasoning', id: 'reason-' + index, encrypted_content: 'private-reasoning', summary: [] },
      ...(call ? [{ type: 'function_call', id: 'call-' + index, call_id: 'call-' + index, name: call.name, arguments: JSON.stringify(call.arguments) }]
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I have the saved behavior and your clarification.' }] }])];
    return new Response(JSON.stringify({ status: 'completed', output, usage: { input_tokens: 4, output_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
  };
  const java = process.env.KEIR_JAVA_BIN ?? (process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java');
  const compiler = createCompiler({ modelBytes: loadHost().dcmBytes, javaExecutable: java });
  const { db, call, login, getAuth } = await api(t, { compiler, authoring: { config, fetchImpl } });
  await login('maya');
  const created = await call('extensions/compile', { source, label: 'Pending preference', draftVersion: 0 });
  assert.equal(created.statusCode, 200);
  const saved = await call('extensions/scenarios', { revisionId: created.json().draft.id, draftVersion: created.json().draftVersion, cases });
  assert.equal(saved.statusCode, 200);
  const proposal = await call('extensions/revisions/' + saved.json().draft.id);
  const initialAuth = getAuth();
  const started = await call('authoring/turn', { conversationId: null, operationId: 'clarify-pending', text: 'When a task is open, keep showing Pending.',
    expectedVersion: 0, expectedDraftVersion: saved.json().draftVersion });
  assert.equal(started.statusCode, 202);
  const first = await settled(call, started.json().conversation.id);
  assert.equal(first.status, 'AWAITING_USER');

  await login('leo');
  assert.equal((await call('authoring')).json().conversations.length, 0);
  assert.notEqual((await call('extensions')).json().revisionId, saved.json().draft.id);
  assert.equal((await call('authoring/conversations/' + first.id, undefined, initialAuth)).statusCode, 401);

  await login('maya');
  const continuation = await call('authoring/turn', { conversationId: first.id, operationId: 'clarified-pending', text: 'Yes, show Done after completion.',
    expectedVersion: first.version, expectedDraftVersion: saved.json().draftVersion });
  assert.equal(continuation.statusCode, 202);
  const result = await settled(call, first.id);
  assert.equal(result.status, 'IDLE');
  const discovered = JSON.parse(requests[2].input.find(item => item.type === 'function_call_output').output).result;
  assert.deepEqual(discovered.currentProposal, { ...proposal.json(), truncated: false });
  assert.equal(discovered.currentProposal.source, source);
  assert.deepEqual(discovered.currentProposal.cases, cases);
  assert.deepEqual(discovered.conversationContext.messages.map(item => item.text), [
    'When a task is open, keep showing Pending.', 'Should completed tasks still show Done?', 'Yes, show Done after completion.',
  ]);
  assert.equal(discovered.conversationContext.truncated, false);
  assert.equal(JSON.stringify(result).includes(source), false, 'raw proposal remains out of the transcript DTO');
  assert.equal(db.prepare('SELECT count(*) n FROM extension_authored WHERE owner_id=?').get('maya').n, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_authored WHERE owner_id=?').get('leo').n, 0);
});

test('example source and independent cases pass the real compiler/runtime with separate review and activation', async t => {
  const java = process.env.KEIR_JAVA_BIN ?? (process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java');
  const db = openData(':memory:'), lifecycle = createLifecycle(db, { compiler: createCompiler({ modelBytes: loadHost().dcmBytes, javaExecutable: java }) });
  t.after(() => db.close());
  const example = authoringExample(), initial = lifecycle.state('maya'), selection = initial.selection;
  let state = await lifecycle.compile('maya', { source: example.source, label: example.label, draftVersion: initial.draftVersion }, () => true);
  const wrongConsumption = JSON.parse(example.cases[0]);
  wrongConsumption.expect.consumption = { status: 'NOT_DISPLAYED' };
  const wrongConsumptionCase = JSON.stringify(wrongConsumption);
  state = await lifecycle.proposeScenarios('maya', { ...input(state), cases: [wrongConsumptionCase, ...example.cases.slice(1)] }, () => true);
  const consumptionSuite = lifecycle.source('maya', state.draft.id).cases;
  assert.deepEqual(consumptionSuite, [wrongConsumptionCase, ...example.cases.slice(1)]);
  state = await lifecycle.simulate('maya', input(state), () => true);
  const consumptionProof = lifecycle.evidence('maya', state.evidence.id);
  assert.equal(consumptionProof.passed, false);
  assert.deepEqual(consumptionProof.reports[0].expected.consumption, { status: 'NOT_DISPLAYED' });
  const storedProof = JSON.parse(db.prepare('SELECT payload FROM extension_evidence WHERE id=?').get(state.evidence.id).payload);
  assert.equal(Object.hasOwn(storedProof.reports[0].expected, 'consumption'), false, 'public projection must not rewrite exact stored evidence');
  const consumerReport = consumptionProof.reports[0].report;
  assert.deepEqual(consumerReport.native, { classification: 'COMPLETED' });
  assert.deepEqual(consumerReport.consumption, { status: 'DISPLAYED', code: 'NEEDS_ATTENTION' });
  assert.deepEqual(consumerReport.mismatches.map(item => [item.stage, item.code]), [['CONSUMER', 'CONSUMPTION_MISMATCH']]);
  const consumerSummary = evidenceSummary(consumptionProof, consumptionSuite).cases[0];
  assert.equal(consumerSummary.expected.code, 'NEEDS_ATTENTION');
  assert.deepEqual(consumerSummary.expected.consumption, { status: 'NOT_DISPLAYED' });
  assert.deepEqual(consumerSummary.actual.consumption, { status: 'DISPLAYED', code: 'NEEDS_ATTENTION' });
  assert.deepEqual(lifecycle.source('maya', state.draft.id).cases, consumptionSuite);
  await assert.rejects(Promise.resolve().then(() => lifecycle.approve('maya', { ...input(state), evidenceId: state.evidence.id }, () => true)), { status: 409 });

  const wrong = JSON.parse(example.cases[0]);
  wrong.expect.outcome.result.classification = 'DONE'; wrong.expect.consumption.code = 'DONE';
  const wrongCase = JSON.stringify(wrong);
  state = await lifecycle.proposeScenarios('maya', { ...input(state), cases: [wrongCase, ...example.cases.slice(1)] }, () => true);
  const wrongSuite = lifecycle.source('maya', state.draft.id).cases;
  assert.deepEqual(wrongSuite, [wrongCase, ...example.cases.slice(1)]);
  state = await lifecycle.simulate('maya', input(state), () => true);
  const mismatchProof = lifecycle.evidence('maya', state.evidence.id);
  assert.equal(mismatchProof.passed, false);
  const mismatch = evidenceSummary(mismatchProof, wrongSuite).cases[0];
  assert.equal(mismatch.status, 'MISMATCH');
  assert.equal(mismatch.expected.code, 'DONE');
  assert.equal(mismatch.actual.consumption.code, 'NEEDS_ATTENTION');
  await assert.rejects(Promise.resolve().then(() => lifecycle.approve('maya', { ...input(state), evidenceId: state.evidence.id }, () => true)), { status: 409 });
  state = await lifecycle.proposeScenarios('maya', { ...input(state), cases: example.cases }, () => true);
  const savedSuite = lifecycle.source('maya', state.draft.id).cases;
  assert.deepEqual(savedSuite, example.cases);
  state = await lifecycle.simulate('maya', input(state), () => true);
  const evidence = lifecycle.evidence('maya', state.evidence.id);
  assert.equal(evidence.passed, true);
  assert.deepEqual(evidence.reports.map(({ taskStatus, readFailure }) => [taskStatus, readFailure]), [
    ['OPEN', null], ['COMPLETED', null], [null, 'TASK_NOT_FOUND'], [null, 'ACCESS_DENIED'], [null, 'TRANSIENT_FAILURE'],
  ]);
  const savedProof = JSON.parse(db.prepare('SELECT payload FROM extension_evidence WHERE id=?').get(state.evidence.id).payload);
  assert.ok(savedProof.reports.every(item => !Object.hasOwn(item, 'taskStatus') && !Object.hasOwn(item, 'readFailure')));
  assert.deepEqual(evidence.reports.map(row => row.report.status), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
  assert.deepEqual(evidence.reports.slice(0, 2).map(row => row.report.native), [
    { classification: 'COMPLETED' }, { classification: 'COMPLETED' },
  ]);
  assert.deepEqual(evidence.reports.slice(0, 2).map(row => row.report.consumption), [
    { status: 'DISPLAYED', code: 'NEEDS_ATTENTION' }, { status: 'DISPLAYED', code: 'DONE' },
  ]);
  assert.equal(evidence.reports[2].report.native.classification, 'BUSINESS_REJECTION');
  assert.deepEqual(evidence.reports[2].report.consumption, { status: 'NOT_DISPLAYED' });
  state = lifecycle.approve('maya', { ...input(state), evidenceId: state.evidence.id }, () => true);
  assert.deepEqual(state.selection, selection, 'approval does not activate or select');
  await assert.rejects(lifecycle.proposeScenarios('maya', { ...input(state), cases: example.cases, draftVersion: state.draftVersion - 1 }, () => true), { status: 409 });
  state = lifecycle.activate('maya', { ...input(state), generation: state.selection.generation }, () => true);
  assert.equal(state.selection.revision.id, state.draft.id);
  assert.equal(state.selection.generation, selection.generation + 1);
});

test('a provider request limit keeps the saved source and explains manual recovery without guessing quota or retrying', async t => {
  let requests = 0;
  const source = readFileSync(new URL('../extensions/task-read/maya.yaml', import.meta.url), 'utf8');
  const artifact = readFileSync(new URL('../extensions/task-read/maya.json', import.meta.url));
  const { db, call, login } = await api(t, { compiler: { compile: async () => ({ artifact, diagnostics: [] }) },
    authoring: { config, fetchImpl: async () => { requests++; return new Response('', { status: 429 }); } } });
  await login();
  const initial = (await call('extensions')).json();
  const prepared = await call('extensions/compile', { source, draftVersion: initial.draftVersion });
  assert.equal(prepared.statusCode, 200);
  const draft = prepared.json();
  const started = await call('authoring/turn', { conversationId: null, operationId: 'limited-continuation',
    text: 'Keep the saved advice and continue checking the examples.', expectedVersion: 0, expectedDraftVersion: draft.draftVersion });
  assert.equal(started.statusCode, 202);
  let current;
  for (let tries = 0; tries < 100; tries++) {
    current = (await call('authoring/conversations/' + started.json().conversation.id)).json();
    if (!['RUNNING', 'CANCELLING'].includes(current.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(current.status, 'BLOCKED');
  assert.equal(current.code, 'PROVIDER_RATE_LIMIT');
  assert.match(current.messages.at(-1).text, /request or account limit/);
  assert.match(current.messages.at(-1).text, /saved proposal and examples are kept/);
  assert.match(current.messages.at(-1).text, /retrying manually/);
  assert.equal(requests, 1, 'no automatic retry');
  assert.equal(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros, config.reserveMicros);
  assert.equal((await call('extensions/revisions/' + draft.draft.id)).json().source, source);
  assert.deepEqual((await call('extensions')).json().selection, initial.selection);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_approvals').get().n, 0);
});

test('historical prepared evidence never borrows display expectations from a different suite with reused case IDs', async t => {
  const db = openData(':memory:'), lifecycle = createLifecycle(db);
  t.after(() => db.close());
  let state = lifecycle.load('maya', { templateId: 'attention', draftVersion: 0 }, () => true);
  state = await lifecycle.simulate('maya', input(state), () => true);
  const id = state.evidence.id;
  const original = JSON.parse(db.prepare('SELECT payload FROM extension_evidence WHERE id=?').get(id).payload);
  assert.deepEqual(lifecycle.evidence('maya', id).reports[0].expected.consumption, { status: 'DISPLAYED', code: 'NEEDS_ATTENTION' });
  db.prepare('UPDATE extension_evidence SET suite_identity=? WHERE id=?').run('sha256:' + '0'.repeat(64), id);
  const historical = lifecycle.evidence('maya', id);
  assert.equal(historical.passed, false);
  assert.deepEqual(historical.reports, original.reports, 'a reused open case ID cannot confer current-suite expectations');
  const summary = evidenceSummary(historical, authoringExample().cases);
  assert.ok(summary.cases.every(item => item.taskStatus === null && item.readFailure === null), 'provider summaries cannot infer historical situations from reused IDs');
});

test('synthetic situation facts stay finite and unknown rather than guessing a task or observation', () => {
  for (const response of [undefined, { kind: 'SUCCESS', value: { status: 'UNKNOWN' } },
    { kind: 'BUSINESS_REJECTION', code: 'OTHER' }, { kind: 'FAILURE', code: 'TASK_NOT_FOUND' }]) {
    assert.deepEqual(situation({ stubs: response ? [{ capability: 'tasks.get', response }] : [] }), { taskStatus: null, readFailure: null });
  }
  const stubs = [{ capability: 'tasks.get', response: { kind: 'SUCCESS', value: { status: 'OPEN' } } }];
  assert.deepEqual(situation({ stubs: [...stubs, ...stubs] }), { taskStatus: null, readFailure: null });
  const summary = evidenceSummary({ reports: [{ id: 'case', label: 'case', ...situation({ stubs }), expected: {},
    report: { status: 'PASS', mismatches: [] } }] }, []);
  assert.equal(summary.cases[0].taskStatus, 'OPEN');
  assert.deepEqual(summary.cases[0].actual.consumption, {}, 'configured synthetic status is not an observed receipt');
});

test('mismatch receipts keep independent expectations and actual results without advice on errors', () => {
  const example = authoringExample(), incorrect = JSON.parse(example.cases[0]);
  incorrect.expect.outcome.result.classification = 'DONE'; incorrect.expect.consumption.code = 'DONE';
  const original = JSON.stringify(incorrect), proof = { reports: [{ id: 'open', label: 'Open task', ...situation(incorrect), expected: { classification: 'COMPLETED', code: 'DONE' },
    report: { status: 'MISMATCH', native: { classification: 'COMPLETED' }, consumption: { status: 'DISPLAYED', code: 'NEEDS_ATTENTION' },
      mismatches: [{ stage: 'CONSUMPTION', code: 'VALUE_MISMATCH' }] } }] };
  const summary = evidenceSummary(proof, [original]);
  assert.equal(summary.cases[0].expected.code, 'DONE');
  assert.equal(summary.cases[0].actual.consumption.code, 'NEEDS_ATTENTION');
  assert.equal(summary.cases[0].mismatches[0].code, 'VALUE_MISMATCH');
  assert.equal(summary.cases[0].taskStatus, 'OPEN');
  assert.equal(summary.truncated, false);
  const changing = structuredClone(incorrect);
  changing.stubs.push({ ...structuredClone(changing.stubs[0]), response: { kind: 'SUCCESS', value: { id: 'sample-task', status: 'COMPLETED' } } });
  assert.equal(situation(changing).taskStatus, null,
    'several synthetic reads must not be presented as one known task state');
  assert.equal(evidenceSummary(proof, [JSON.stringify(changing)]).cases[0].taskStatus, 'OPEN', 'summary uses verified proof projection instead of joining another supplied case');
  assert.equal(JSON.stringify(summary).includes('synthetic-key'), false);
  assert.equal(JSON.parse(original).expect.outcome.result.classification, 'DONE');
  const clipped = evidenceSummary({ reports: Array.from({ length: 9 }, (_, index) => ({ id: 'case-' + index, label: 'x'.repeat(140), expected: {},
    report: { status: 'PASS', native: {}, consumption: {}, mismatches: Array.from({ length: 9 }, () => ({ code: 'MISMATCH' })) } })) },
    Array.from({ length: 9 }, (_, index) => JSON.stringify({ id: 'case-' + index })));
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.cases.length, 8);
  assert.equal(clipped.cases[0].label.length, 128);
  assert.ok(businessContext.supported && businessContext.unavailable && businessContext.checking);
});
