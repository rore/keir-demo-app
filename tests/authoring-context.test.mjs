import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, openData, taskService } from '../src/data.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { createApp } from '../src/app.mjs';
import { createLifecycle as lifecycleFactory } from '../src/extension-lifecycle.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { loadHost, TASK_DEFINITION, TASK_HOOK } from '../src/extension-catalog.mjs';
import { authoringExample, businessContext, evidenceSummary } from '../src/authoring-example.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { join } from 'node:path';
import { taskCustomizationFixture, compileTaskCustomization } from './fixtures/task-customization.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

const taskFixture = taskCustomizationFixture();
let taskArtifact;
before(async () => { taskArtifact = (await compileTaskCustomization()).artifactBytes; });
const lifecycleDatabases = new WeakMap();
function createLifecycle(db, options) {
  const lifecycle = lifecycleFactory(db, options); lifecycleDatabases.set(lifecycle, db); return lifecycle;
}
function taskDraft(db, owner = 'maya') {
  const lifecycle = createLifecycle(db), operationId = 'context-fixture-' + owner;
  const row = db.prepare('SELECT id FROM extensions WHERE owner_id=? AND creation_operation_id=?').get(owner, operationId);
  return row ? { extensionId: row.id, state: lifecycle.state(owner, row.id) } : admitTaskDraft(db, lifecycle, { owner, operationId });
}

const taskTurn = operationId => ({ conversationId: null, operationId, text: 'When I complete a task in my chosen project, create the task I describe.',
  expectedVersion: 0, expectedDraftVersion: 0, target: { kind: 'create' } });
function authoringStorage(db) {
  return Object.fromEntries(['authoring_conversations', 'authoring_operations', 'authoring_dispatches', 'authoring_messages', 'authoring_budget']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test('task authoring admits immutable definition authority before failed compile and retains it through reload and continuation', async t => {
  assert.equal(TASK_DEFINITION, 'daymark.task-workflow/1');
  const db = openData(':memory:'), lease = { sessionId: 'task-definition-test', current: () => true };
  const definitionConfig = { ...config, maxMicros: 5_000_000 };
  let service, attempts = 0, requests = 0;
  const lifecycle = { ...createLifecycle(db), async compile(owner, input) {
    const row = db.prepare('SELECT state FROM authoring_conversations WHERE owner_id=? ORDER BY rowid DESC LIMIT 1').get(owner);
    assert.equal(JSON.parse(row.state).definitionId, TASK_DEFINITION);
    assert.equal(input.hookId, TASK_HOOK);
    assert.equal(db.prepare('SELECT hook_id FROM extensions WHERE id=?').get(input.extensionId).hook_id, null);
    attempts++;
    const failure = new AppError(422, 'Invalid source'); failure.diagnostics = [{ code: 'SYNTAX_INVALID', path: '/source' }]; throw failure;
  } };
  const providerFactory = () => ({ reserveMicros: definitionConfig.reserveMicros, maxMicros: definitionConfig.maxMicros, complete: async () => {
    const compile = requests++ % 2 === 0;
    return { calls: compile ? [{ id: 'compile-test', name: 'compile_draft', arguments: { hookId: TASK_HOOK, sourceJson: 'invalid source', expectedDraftVersion: 0 } }] : [],
      text: 'The draft needs correction; your tasks have not changed.', usage: { inputTokens: 1, outputTokens: 1 } };
  } });
  const open = () => createAuthoringService({ db, lifecycle, config: definitionConfig, providerFactory });
  t.after(async () => { await service?.close(); db.close(); });
  service = open();
  const original = taskTurn('definition-create'), started = await service.turn('maya', original, lease);
  let current = await service.wait('maya', started.conversation.id);
  assert.equal(current.status, 'IDLE'); assert.equal(current.retired, false); assert.equal(attempts, 1);
  const itemId = current.extensionId, held = db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros;
  assert.ok(held > 0);
  assert.equal(db.prepare('SELECT hook_id FROM extensions WHERE id=?').get(itemId).hook_id, null);
  await service.close(); service = open();
  current = service.read('maya', current.id);
  assert.equal(current.retired, false);
  const continued = await service.turn('maya', { conversationId: current.id, operationId: 'definition-continue', text: 'Please correct the draft.',
    expectedVersion: current.version, expectedDraftVersion: 0, target: { kind: 'resume', extensionId: itemId } }, lease);
  current = await service.wait('maya', continued.conversation.id);
  assert.equal(current.extensionId, itemId); assert.equal(attempts, 2);
  assert.equal(JSON.parse(db.prepare('SELECT state FROM authoring_conversations WHERE id=?').get(current.id).state).definitionId, TASK_DEFINITION);
  assert.ok(db.prepare('SELECT reserved_micros FROM authoring_budget').get().reserved_micros >= held);
  const recovered = service.recover('maya', original);
  assert.equal(recovered.conversation.id, current.id);
  assert.equal(recovered.operation.id, original.operationId);
  const item = lifecycle.state('maya', itemId);
  const fresh = await service.turn('maya', { conversationId: null, operationId: 'definition-fresh-discussion', text: 'Start a fresh discussion about this draft.',
    expectedVersion: 0, expectedDraftVersion: 0, target: { kind: 'revise', extensionId: itemId, baseRevisionId: null, selectionGeneration: item.selection.generation } }, lease);
  const freshResult = await service.wait('maya', fresh.conversation.id);
  assert.equal(freshResult.status, 'IDLE');
  assert.notEqual(freshResult.id, current.id); assert.equal(freshResult.extensionId, itemId); assert.equal(freshResult.retired, false);
  assert.equal(attempts, 3);
});

for (const definitionId of [undefined, 'daymark.task-completed/1']) test(`task authoring rejects receipts for ${definitionId ?? 'absent definition'} without rewriting spend or JSON`, async t => {
  const db = openData(':memory:'), lifecycle = createLifecycle(db), lease = { sessionId: 'legacy-recovery-test', current: () => true };
  let service, requests = 0;
  const providerFactory = () => ({ reserveMicros: config.reserveMicros, maxMicros: config.maxMicros, complete: async () => {
    requests++; return { calls: [], text: 'Saved discussion.', usage: { inputTokens: 1, outputTokens: 1 } };
  } });
  const open = () => createAuthoringService({ db, lifecycle, config, providerFactory });
  t.after(async () => { await service?.close(); db.close(); });
  service = open(); const original = taskTurn('legacy-original'), admitted = await service.turn('maya', original, lease);
  const current = await service.wait('maya', admitted.conversation.id); await service.close();
  const saved = JSON.parse(db.prepare('SELECT state FROM authoring_conversations WHERE id=?').get(current.id).state);
  if (definitionId === undefined) delete saved.definitionId;
  else saved.definitionId = definitionId;
  saved.continuation = { opaque: 'legacy-private' };
  db.prepare("UPDATE authoring_conversations SET state=?,status='RUNNING' WHERE id=?").run(JSON.stringify(saved), current.id);
  db.prepare('INSERT INTO authoring_dispatches VALUES (?,?,?,?,?,?,?,?)').run(current.id, 'maya', current.runId, 99, 'provider', null, 1, 'UNKNOWN');
  const before = authoringStorage(db), count = requests;
  service = open();
  assert.deepEqual(authoringStorage(db), before, 'startup does not rewrite retired continuation, receipts or accounting');
  assert.throws(() => service.recover('maya', original), { status: 404 });
  await assert.rejects(service.turn('maya', original, lease), { status: 404 });
  assert.throws(() => service.recover('maya', { ...original, text: 'Different payload' }), error => error.status === 409 && error.code === 'STALE_CONVERSATION');
  await assert.rejects(service.turn('maya', { ...original, text: 'Different payload' }, lease), error => error.status === 409 && error.code === 'STALE_CONVERSATION');
  await assert.rejects(service.turn('maya', { conversationId: current.id, operationId: 'retired-resume', text: 'Continue.', expectedVersion: current.version,
    expectedDraftVersion: 0, target: { kind: 'resume', extensionId: current.extensionId } }, lease), error => error.status === 410 && error.code === 'LEGACY_CUSTOMIZATION_RETIRED');
  assert.deepEqual(authoringStorage(db), before); assert.equal(requests, count);
});

test('task authoring discovers every project page without exposing other owners or native tasks and rejects foreign cursors', async t => {
  const db = openData(':memory:'), native = taskService(db), lifecycle = createLifecycle(db), pages = [];
  const projectConfig = { ...config, maxMicros: 5_000_000 };
  for (let index = 0; index < 25; index++) native.createProject('maya', { name: index < 2 ? 'Repeated project' : `Project ${index}` });
  const foreign = native.createProject('leo', { name: 'Private other-owner project' });
  const tasksBefore = db.prepare('SELECT * FROM tasks ORDER BY id').all(), authoredBefore = db.prepare('SELECT * FROM extension_authored').all();
  let requests = 0;
  const service = createAuthoringService({ db, lifecycle, config: projectConfig, providerFactory: () => ({ reserveMicros: projectConfig.reserveMicros, maxMicros: projectConfig.maxMicros,
    complete: async request => {
      const result = request.toolResult ? JSON.parse(request.toolResult.output) : null;
      const index = requests++;
      if (index === 1) pages.push(result.result.projects);
      if (index === 2) pages.push(result.result);
      if (index === 3) assert.deepEqual(result, { ok: false, code: 'INVALID_TOOL_ARGUMENTS' });
      const before = index === 1 ? pages[0].next : Buffer.from(JSON.stringify({ scope: JSON.stringify(['projects', 'leo']), id: foreign.id, createdAt: foreign.createdAt })).toString('base64url');
      return { calls: index === 0 ? [{ id: 'catalog', name: 'discover_catalog', arguments: {} }]
        : index < 3 ? [{ id: `projects-${index}`, name: 'discover_projects', arguments: { before } }] : [],
      text: 'Which existing project do you mean?', usage: { inputTokens: 1, outputTokens: 1 } };
    } }) });
  t.after(async () => { await service.close(); db.close(); });
  const started = await service.turn('maya', taskTurn('project-discovery'), { sessionId: 'projects-test', current: () => true });
  const settled = await service.wait('maya', started.conversation.id);
  assert.equal(settled.status, 'IDLE', JSON.stringify({ code: settled.code, messages: settled.messages, pages }));
  const projects = pages.flatMap(page => page.projects);
  assert.equal(pages[0].projects.length, 20); assert.equal(pages[1].next, null);
  assert.equal(projects.length, 26); assert.equal(new Set(projects.map(project => project.id)).size, 26);
  assert.equal(projects.filter(project => project.name === 'Repeated project').length, 2);
  assert.equal(JSON.stringify(pages).includes(foreign.id), false);
  for (const task of tasksBefore) assert.equal(JSON.stringify(pages).includes(task.id), false);
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), tasksBefore);
  assert.deepEqual(db.prepare('SELECT * FROM extension_authored').all(), authoredBefore);
});

test('effect summary preserves UNKNOWN and checked task differences without converting program labels into native creation', () => {
  const proof = { reports: [{ id: 'unknown', label: 'Unknown effect', expected: { outcome: { classification: 'UNCERTAIN' }, createdTasks: [] }, report: {
    status: 'PASS', native: { classification: 'UNCERTAIN', result: { status: 'CREATED' }, sourceSecret: 'private' }, consumption: { status: 'REPORTED' },
    scenario: { task: { id: 'example', title: 'Example task', status: 'COMPLETED', projectId: 'project-a', notes: 'private' } },
    observed: { effect: 'UNKNOWN', createdTasks: null }, mismatches: [], continuation: 'private',
  } }] };
  const summary = evidenceSummary(proof, [JSON.stringify({ id: 'unknown', expect: { consumption: { status: 'REPORTED' } } })]);
  assert.deepEqual(summary.cases[0].actual.observed, { effect: 'UNKNOWN', createdTasks: null });
  assert.deepEqual(summary.cases[0].expected.createdTasks, []);
  assert.equal(summary.cases[0].scenario.task.projectId, 'project-a');
  assert.equal(JSON.stringify(summary).includes('CREATED'), false); assert.equal(JSON.stringify(summary).includes('private'), false);
  const confirmed = structuredClone(proof); confirmed.reports[0].report.observed = { effect: 'CONFIRMED', createdTasks: [{ projectId: 'project-a', title: 'x'.repeat(140), private: 'private' }] };
  const clipped = evidenceSummary(confirmed, []);
  assert.equal(clipped.truncated, true); assert.equal(clipped.cases[0].actual.observed.createdTasks[0].title.length, 128);
  assert.equal(JSON.stringify(clipped).includes('private'), false);
});

function itemId(lifecycle, owner) {
  return taskDraft(lifecycleDatabases.get(lifecycle), owner).extensionId;
}

function extensionPath(db, suffix = '', owner = 'maya') {
  return 'extensions/' + taskDraft(db, owner).extensionId + (suffix ? '/' + suffix : '');
}

function authoringTarget(db, conversationId) {
  const extension = db.prepare('SELECT * FROM extensions WHERE id=?').get(taskDraft(db).extensionId);
  const selected = db.prepare("SELECT * FROM extension_selections WHERE owner_id='maya' AND hook_id='TaskCompleted'").get();
  return conversationId ? { kind: 'resume', extensionId: extension.id }
    : { kind: 'revise', extensionId: extension.id, baseRevisionId: extension.draft_revision_id ?? selected.revision_id, selectionGeneration: selected.generation };
}
const input = state => ({ extensionId: state.extension.id, revisionId: state.draft.id, draftVersion: state.draftVersion });
// Three scripted context requests reserve 1.161216 USD; retain a finite allowance.
const config = readAuthoringConfig({ KEIR_AI_PROVIDER: 'openai', KEIR_AI_MODEL: 'gpt-5.6-terra', KEIR_AI_MAX_USD: '1.2', OPENAI_API_KEY: 'synthetic-key' });

async function api(t, options = {}) {
  const db = openData(':memory:'), origin = 'http://127.0.0.1:32124';
  if (typeof options === 'function') options = options(db);
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

test('agent discovery sends static supported context and worked source/scenario without task records', async t => {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body), index = requests.length; requests.push(body);
    const call = index === 0 ? { id: 'call-0', call_id: 'call-0', name: 'discover_catalog', arguments: '{}' } : null;
    const output = [{ type: 'reasoning', id: 'reason-' + index, encrypted_content: 'private-reasoning', summary: [] },
      ...(call ? [{ type: 'function_call', ...call }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I can help with the supported task customization.' }] }])];
    return new Response(JSON.stringify({ status: 'completed', output, usage: { input_tokens: 4, output_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
  };
  const { db, call, login } = await api(t, { authoring: { config, fetchImpl } });
  await login();
  const taskIds = db.prepare('SELECT id FROM tasks').all().map(row => row.id);
  const started = await call('authoring/turn', { target: authoringTarget(db), conversationId: null, operationId: 'discover-context', text: 'Help with task completion.', expectedVersion: 0, expectedDraftVersion: 0 });
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
  assert.match(requests[0].instructions, /Rename for any saved name, including a deliberately chosen literal default/);
  assert.match(requests[0].instructions, /Never infer name origin from its spelling/);
  assert.match(requests[0].instructions, /Naming is optional and the person saves it explicitly/);
  assert.match(requests[0].instructions, /Turn off this customization \(Turn off on narrow screens\) is in the customization status strip/);
  assert.match(requests[0].instructions, /Authoring tools do not rename it/);
  assert.match(requests[0].instructions, /never claim a name was saved or invent a naming tool/);
  const receipt = JSON.parse(requests[1].input.find(item => item.type === 'function_call_output').output).result;
  assert.deepEqual(receipt.businessContext, businessContext);
  assert.equal(receipt.selectedHook, null);
  const { sourceExample, scenarioExample, scenarioExamples } = receipt.examplesByHook[TASK_HOOK];
  assert.ok(sourceExample.includes('TaskCompleted'));
  assert.ok(JSON.parse(scenarioExample).expect);
  assert.deepEqual(scenarioExamples, authoringExample(loadHost(TASK_HOOK)).cases);
  assert.deepEqual(scenarioExamples.map(text => JSON.parse(text).id),
    ['matching-project', 'other-project', 'other-status', 'missing-task', 'access-denied', 'read-unavailable']);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 131072);
  for (const text of scenarioExamples) {
    const row = JSON.parse(text);
    assert.deepEqual(Object.keys(row.stubs[0].args), ['taskId']);
    assert.equal(row.expect.consumption.status, 'REPORTED');
  }
  for (const id of taskIds) assert.equal(JSON.stringify(receipt).includes(id), false);
  assert.equal(JSON.stringify(current).includes('scenarioExample'), false);
});

test('rediscovery carries the saved task-creation proposal and clarified intent while isolating owners', async t => {
  const requests = [], source = taskFixture.source, cases = taskFixture.cases;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body), index = requests.length; requests.push(body);
    const call = index === 0 ? { name: 'ask_clarification', arguments: { question: 'Should tasks in another project create nothing?' } }
      : index === 1 ? { name: 'discover_catalog', arguments: {} } : null;
    const output = [{ type: 'reasoning', id: 'reason-' + index, encrypted_content: 'private-reasoning', summary: [] },
      ...(call ? [{ type: 'function_call', id: 'call-' + index, call_id: 'call-' + index, name: call.name, arguments: JSON.stringify(call.arguments) }]
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I have the saved behavior and your clarification.' }] }])];
    return new Response(JSON.stringify({ status: 'completed', output, usage: { input_tokens: 4, output_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
  };
  const java = process.env.KEIR_JAVA_BIN ?? (process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java');
  const compiler = createCompiler({ javaExecutable: java });
  const { db, call, login, getAuth } = await api(t, { compiler, authoring: { config, fetchImpl } });
  await login('maya');
  const created = await call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source, label: 'Task creation preference', draftVersion: 0 });
  assert.equal(created.statusCode, 200);
  const saved = await call(extensionPath(db, 'scenarios'), { revisionId: created.json().draft.id, draftVersion: created.json().draftVersion, cases });
  assert.equal(saved.statusCode, 200);
  const proposal = await call(extensionPath(db, 'revisions/' + saved.json().draft.id));
  const initialAuth = getAuth();
  const started = await call('authoring/turn', { target: authoringTarget(db), conversationId: null, operationId: 'clarify-task', text: 'When a task in my project is completed, create the follow-up task.',
    expectedVersion: 0, expectedDraftVersion: saved.json().draftVersion });
  assert.equal(started.statusCode, 202);
  const first = await settled(call, started.json().conversation.id);
  assert.equal(first.status, 'AWAITING_USER');

  await login('leo');
  assert.equal((await call('authoring')).json().conversations.length, 0);
  assert.notEqual((await call(extensionPath(db, '', 'leo'))).json().revisionId, saved.json().draft.id);
  assert.equal((await call('authoring/conversations/' + first.id, undefined, initialAuth)).statusCode, 401);

  await login('maya');
  const continuation = await call('authoring/turn', { target: authoringTarget(db, first.id), conversationId: first.id, operationId: 'clarified-task', text: 'Yes, create nothing for other projects.',
    expectedVersion: first.version, expectedDraftVersion: saved.json().draftVersion });
  assert.equal(continuation.statusCode, 202);
  const result = await settled(call, first.id);
  assert.equal(result.status, 'IDLE');
  const discovered = JSON.parse(requests[2].input.find(item => item.type === 'function_call_output').output).result;
  assert.deepEqual(discovered.currentProposal, { revisionId: proposal.json().revisionId, source: proposal.json().source,
    cases: proposal.json().cases, suiteDigest: proposal.json().suiteDigest, truncated: false });
  for (const key of ['artifact', 'pins', 'hostCases', 'extensionId']) assert.equal(Object.hasOwn(discovered.currentProposal, key), false);
  assert.equal(discovered.currentProposal.source, source);
  assert.deepEqual(discovered.currentProposal.cases, cases);
  assert.deepEqual(discovered.conversationContext.messages.map(item => item.text), [
    'When a task in my project is completed, create the follow-up task.', 'Should tasks in another project create nothing?', 'Yes, create nothing for other projects.',
  ]);
  assert.equal(discovered.conversationContext.truncated, false);
  assert.equal(JSON.stringify(result).includes(source), false, 'raw proposal remains out of the transcript DTO');
  assert.equal(db.prepare('SELECT count(*) n FROM extension_authored WHERE owner_id=?').get('maya').n, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_authored WHERE owner_id=?').get('leo').n, 0);
});

for (const oversizedSource of [false, true]) test(`discovery excludes large inspection artifacts and bounds ${oversizedSource ? 'escaped' : 'small'} saved source`, async t => {
  const requests = [];
  const artifact = taskArtifact;
  let inspectedBytes = 0;
  const source = oversizedSource ? '"'.repeat(64000) : 'Small saved source';
  const providerFactory = settings => ({ reserveMicros: settings.reserveMicros, maxMicros: settings.maxMicros,
    async complete(request) {
      requests.push(request);
      return { calls: requests.length === 1 ? [{ id: 'discover-only', name: 'discover_catalog', arguments: {} }] : [],
        text: requests.length === 1 ? '' : 'I have the available saved context.', usage: { inputTokens: 4, outputTokens: 2 } };
    } });
  const compiler = { compile: async () => ({ artifact, diagnostics: [] }) };
  const { db, call, login } = await api(t, db => {
    const lifecycle = createLifecycle(db, { compiler });
    return { compiler, authoring: { config, providerFactory, lifecycle: { ...lifecycle, source(...args) {
      const inspection = { ...lifecycle.source(...args), artifact: 'x'.repeat(140000), pins: { inspectionOnly: true }, hostCases: ['inspection-only'] };
      inspectedBytes = Buffer.byteLength(JSON.stringify(inspection));
      return inspection;
    } } } };
  });
  await login();
  const saved = await call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source, draftVersion: 0 });
  assert.equal(saved.statusCode, 200, saved.body);
  const inspected = (await call(extensionPath(db, 'revisions/' + saved.json().revisionId))).json();
  assert.equal(inspected.artifact, artifact.toString('utf8'), 'The separate human inspection DTO remains intact.');
  const started = await call('authoring/turn', { target: authoringTarget(db), conversationId: null, operationId: 'large-discovery',
    text: 'Continue these saved changes.', expectedVersion: 0, expectedDraftVersion: saved.json().draftVersion });
  assert.equal(started.statusCode, 202);
  const result = await settled(call, started.json().conversation.id);
  assert.equal(result.status, 'IDLE', JSON.stringify(result));
  assert.equal(requests.length, 2, 'Bounded discovery can reach the provider continuation.');
  assert.ok(inspectedBytes > 131072, 'The host inspection seam supplies large fields that the provider does not need.');
  const discovery = JSON.parse(requests[1].toolResult.output).result;
  assert.deepEqual(Object.keys(discovery.currentProposal).sort(), ['cases', 'revisionId', 'source', 'suiteDigest', 'truncated']);
  assert.equal(discovery.currentProposal.source, oversizedSource ? null : source);
  assert.equal(discovery.currentProposal.truncated, oversizedSource);
  assert.ok(Buffer.byteLength(JSON.stringify(discovery.currentProposal)) <= 65536);
  assert.ok(Buffer.byteLength(JSON.stringify(discovery)) <= 131072);
});

test('actual compiled task source retains independent expectations, exact proof and separate approval and activation', async t => {
  const db = openData(':memory:');
  const lifecycle = createLifecycle(db, { compiler: { compile: async () => ({ artifact: taskArtifact, diagnostics: [] }) } });
  t.after(() => db.close());
  const example = taskFixture, extensionId = itemId(lifecycle, 'maya'), initial = lifecycle.state('maya', extensionId), selection = initial.selection;
  const native = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  let state = await lifecycle.compile('maya', { extensionId, hookId: TASK_HOOK, source: example.source, draftVersion: initial.draftVersion }, () => true);
  const wrongConsumption = JSON.parse(example.cases[0]); wrongConsumption.expect.consumption = { status: 'NOT_REPORTED', code: 'OUTCOME_INVALID' };
  await assert.rejects(lifecycle.proposeScenarios('maya', { extensionId, ...input(state), cases: [JSON.stringify(wrongConsumption)] }, () => true),
    error => error.status === 400 && error.diagnostics[0].code === 'INVALID_SCENARIO');
  assert.equal(lifecycle.state('maya', extensionId).draftVersion, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_evidence').get().n, 0);
  const wrong = JSON.parse(example.cases[0]);
  wrong.expect.outcome.result.status = 'NO_OP';
  wrong.expect.consumption.result.status = 'NO_OP';
  const wrongCase = JSON.stringify(wrong);
  state = await lifecycle.proposeScenarios('maya', { extensionId, ...input(state), cases: [wrongCase, ...example.cases.slice(1)] }, () => true);
  const wrongSuite = lifecycle.source('maya', state.draft.id, extensionId).cases;
  assert.deepEqual(wrongSuite, [wrongCase, ...example.cases.slice(1)]);
  state = await lifecycle.simulate('maya', input(state), () => true);
  const mismatchProof = lifecycle.evidence('maya', state.evidence.id, extensionId), mismatch = evidenceSummary(mismatchProof, wrongSuite).cases[0];
  assert.equal(mismatchProof.passed, false); assert.equal(mismatch.status, 'FAIL');
  assert.equal(mismatchProof.reports[0].expected.outcome.result.status, 'NO_OP');
  assert.equal(mismatchProof.reports[0].report.native.result.status, 'CREATED');
  assert.deepEqual(mismatch.actual.observed, { effect: 'CONFIRMED', createdTasks: [{ id: 'task2', projectId: example.metadata.projectId,
    projectName: 'Example project', title: example.metadata.title, tags: [] }], updatedTasks: [] });
  await assert.rejects(Promise.resolve().then(() => lifecycle.approve('maya', { extensionId, ...input(state), evidenceId: state.evidence.id }, () => true)), { status: 409 });
  state = await lifecycle.proposeScenarios('maya', { extensionId, ...input(state), cases: example.cases }, () => true);
  assert.deepEqual(lifecycle.source('maya', state.draft.id, extensionId).cases, example.cases);
  state = await lifecycle.simulate('maya', input(state), () => true);
  const payload = db.prepare('SELECT payload FROM extension_evidence WHERE id=?').get(state.evidence.id).payload;
  const evidence = lifecycle.evidence('maya', state.evidence.id, extensionId);
  assert.equal(evidence.passed, true);
  assert.deepEqual(evidence.reports.map(row => row.report.status), Array(example.cases.length).fill('PASS'));
  assert.deepEqual(evidence.reports.map(row => row.report.native), example.cases.map(text => JSON.parse(text).expect.outcome));
  assert.deepEqual(evidence.reports.map(row => row.report.consumption), example.cases.map(text => JSON.parse(text).expect.consumption));
  assert.deepEqual(evidenceSummary(evidence, example.cases).cases.slice(0, 2).map(row => row.actual.observed.effect), ['CONFIRMED', 'NONE']);
  assert.equal(db.prepare('SELECT payload FROM extension_evidence WHERE id=?').get(state.evidence.id).payload, payload, 'reading and projecting do not rewrite immutable evidence');
  state = lifecycle.approve('maya', { extensionId, ...input(state), evidenceId: state.evidence.id }, () => true);
  assert.deepEqual(state.selection, selection, 'approval does not activate or select');
  await assert.rejects(lifecycle.proposeScenarios('maya', { extensionId, ...input(state), cases: example.cases, draftVersion: state.draftVersion - 1 }, () => true), { status: 409 });
  state = lifecycle.activate('maya', { extensionId, ...input(state), generation: state.selection.generation, evidenceId: state.approvedEvidenceId }, () => true);
  assert.equal(state.selection.revision.id, state.draft.id); assert.equal(state.selection.generation, selection.generation + 1);
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), native, 'checking, approval and activation create no native task');
});

test('a provider request limit keeps the saved source and explains manual recovery without guessing quota or retrying', async t => {
  let requests = 0;
  const source = taskFixture.source, artifact = taskArtifact;
  const { db, call, login } = await api(t, { compiler: { compile: async () => ({ artifact, diagnostics: [] }) },
    authoring: { config, fetchImpl: async () => { requests++; return new Response('', { status: 429 }); } } });
  await login();
  const initial = (await call(extensionPath(db))).json();
  const prepared = await call(extensionPath(db, 'compile'), { hookId: TASK_HOOK, source, draftVersion: initial.draftVersion });
  assert.equal(prepared.statusCode, 200);
  const draft = prepared.json();
  const started = await call('authoring/turn', { target: authoringTarget(db), conversationId: null, operationId: 'limited-continuation',
    text: 'Keep the saved changes and continue checking the examples.', expectedVersion: 0, expectedDraftVersion: draft.draftVersion });
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
  assert.equal((await call(extensionPath(db, 'revisions/' + draft.draft.id))).json().source, source);
  assert.deepEqual((await call(extensionPath(db))).json().selection, initial.selection);
  assert.equal(db.prepare('SELECT count(*) n FROM extension_approvals').get().n, 0);
});

test('proof summaries clip case count, labels and mismatch details', () => {
  const clipped = evidenceSummary({ reports: Array.from({ length: 9 }, (_, index) => ({ id: 'case-' + index, label: 'x'.repeat(140), expected: {},
    report: { status: 'PASS', native: {}, consumption: {}, mismatches: Array.from({ length: 9 }, () => ({ code: 'MISMATCH' })) } })) },
    Array.from({ length: 9 }, (_, index) => JSON.stringify({ id: 'case-' + index })));
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.cases.length, 8);
  assert.equal(clipped.cases[0].label.length, 128);
  assert.equal(clipped.cases[0].mismatches.length, 8);
  assert.ok(businessContext.supported && businessContext.unavailable && businessContext.checking);
});
