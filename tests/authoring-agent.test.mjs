import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AUTHORING_TOOLS, createAuthoringState, runAuthoringTurn } from '../src/authoring-agent.mjs';
import { AuthoringError, createAuthoringProvider } from '../src/authoring-provider.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';

const suite = 'sha256:' + '1'.repeat(64);
const simulationSuiteIdentity = 'sha256:' + '2'.repeat(64);
const call = (name, args = {}, id) => ({ name, arguments: { ...(name === 'compile_draft' && { hookId: 'TaskCompleted' }), ...args }, ...(id && { id }) });

test('project discovery pages are read-only tool results and task compilation rejects unsupported hooks', async () => {
  const f = fixture([call('discover_projects', { before: '' }), call('discover_projects', { before: 'next-page' }),
    call('compile_draft', { hookId: 'ClassifyTask', sourceJson: '{}', expectedDraftVersion: 0 })]);
  const cursors = [];
  f.host.projects = before => { cursors.push(before); return { projects: [{ id: before ? 'project-b' : 'project-a', name: 'Repeated name' }], next: before ? null : 'next-page' }; };
  const result = await f.run();
  assert.equal(result.status, 'IDLE');
  assert.deepEqual(cursors, ['', 'next-page']);
  assert.deepEqual(f.events, []);
  assert.equal(f.state.handles.revisionId, null);
  const first = JSON.parse(f.requests[1].toolResult.output), second = JSON.parse(f.requests[2].toolResult.output);
  assert.equal(first.result.next, 'next-page');
  assert.equal(second.result.projects[0].id, 'project-b');
  assert.deepEqual(JSON.parse(f.requests[3].toolResult.output), { ok: false, code: 'INVALID_TOOL_ARGUMENTS' });
  const names = AUTHORING_TOOLS.map(tool => tool.name);
  assert.equal(names.some(name => /approve|activate|event|create_task|write_task/.test(name)), false);
});

for (const hook of ['TaskCreated', 'TaskBeforeCreate']) test('the compile tool passes the exact ' + hook + ' hook to the host', async () => {
  const f = fixture([call('discover_catalog'), call('compile_draft', {
    hookId: hook, sourceJson: JSON.stringify({ entrypoint: hook }), expectedDraftVersion: 0,
  })]);
  const compile = f.host.compile;
  f.host.compile = (source, version, signal, actualHook) => {
    assert.equal(actualHook, hook);
    assert.equal(JSON.parse(source).entrypoint, actualHook);
    return compile(source, version, signal);
  };
  await f.run();
  assert.equal(f.state.handles.revisionId, 'revision1');
});

test('task coaching requires discovered constants and independent expectations without treating program labels as native effects', async () => {
  const f = fixture(); await f.run();
  const instructions = f.requests[0].instructions;
  for (const phrase of ['discover_projects', 'Project names may repeat', 'selectedHook', 'FORMAT ONLY',
    'Only host-observed effect evidence', 'UNKNOWN never means no effect or safe retry', 'later completes that generated task',
    'independent expected scenarios', 'Numeric keir-dcm/4 uses source keir/3', 'retained keir-dcm/3 uses keir/2',
    'New compiler outputs use artifact/scenario /4', 'size(input.tags) > 3 && !input.hasNotes', 'duration("604800s")',
    'one ordinary-language question', 'never infer an existing task identity', 'TaskBeforeCreate is a read-only decision',
    'Whitespace-only native notes have hasNotes false', 'ALLOW permits normal native checks to continue',
    'matching ALLOW, matching DENY, nonmatching ALLOW and unavailable', 'exactly {status:"BLOCKED"}', 'exact guard proof when using a conditional lookup',
    'only that exact earlier unconditional Boolean BIND proves its result exists', 'If the CALL itself names an alias, use that exact identifier']) assert.ok(instructions.includes(phrase), phrase);
  assert.doesNotMatch(instructions, /choose Check task advice|outside the discovered read-only contract/);
});

test('retained 0.4 companion and historical guides keep their exact original pins', async () => {
  const metadata = JSON.parse(readFileSync(new URL('../vendor/authoring-companion-provenance.json', import.meta.url)));
  const guide = readFileSync(new URL('../vendor/customer-authoring-guide-v8.md', import.meta.url));
  const current = metadata.files['customer-authoring-guide-v8.md'];
  assert.equal(current.status, 'verified-candidate');
  assert.equal(current.release, 'v0.4.0');
  assert.equal(current.revision, 'dca92178dad7a9a4f65312128afec15abf88ce67');
  assert.equal(current.source, 'docs/agents/customer-authoring-guide-v8.md');
  assert.equal(current.bytes, 6851);
  assert.equal(current.sha256, 'sha256:bcb676ff6542594b960be11be126fa47cfb7b044f7dccc3fa89fefb0566ae14c');
  assert.deepEqual(current.distribution, { file: 'keir-authoring-v8-candidate.zip',
    sha256: 'sha256:4433908295095612c495b11447170fe542758db06acc4b1ce253359a10ac2676' });
  for (const [path, info] of Object.entries(metadata.files)) {
    const bytes = readFileSync(new URL('../vendor/' + path, import.meta.url));
    assert.equal(bytes.length, info.bytes);
    assert.equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), info.sha256);
  }
  const previous = metadata.files['customer-authoring-guide-v5.md'];
  assert.equal(previous.status, 'verified-release');
  assert.equal(previous.release, 'v0.3.0');
  assert.equal(previous.revision, 'f988c2b147933fcdd8b8f74ce7920f78acd4eca5');
  assert.equal(previous.sha256, 'sha256:f9bb403c6f2cb75d834b8113e87bb94de034754ecb10bf7001bd36e129216cb0');
  assert.equal(previous.distribution.sha256, 'sha256:20249307192494acb1cf07cc002e7203bda4f6baf8a8c2257dd752ce1d8cfe44');
  assert.equal('sha256:' + createHash('sha256').update(readFileSync(new URL('../vendor/' + current.distribution.file, import.meta.url))).digest('hex'), current.distribution.sha256);
  const old = metadata.files['customer-authoring-guide-v4.md'];
  assert.equal(old.status, 'historical-copy');
  assert.equal(old.sha256, 'sha256:aeece1c28713ba945743dca47ad4fc6242f3f94cfda4fac9005b5b9df7afb5f7');
  const f = fixture(); await f.run();
  assert.equal(f.requests[0].instructions.endsWith(guide.toString('utf8')), false);
});

test('authoring loads exact final candidate guide 9 with its matching archive, manifest and profile pairs', async () => {
  const read = name => readFileSync(new URL('../vendor/' + name, import.meta.url));
  const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const metadata = JSON.parse(read('authoring-companion-provenance.json'));
  const current = metadata.files['customer-authoring-guide-v9.md'], guide = read('customer-authoring-guide-v9.md');
  assert.equal(current.status, 'verified-candidate'); assert.equal(current.release, null);
  assert.equal(current.revision, '9435dfef2ade61af2d7617754c761775502d68b5');
  assert.equal(current.source, 'docs/agents/customer-authoring-guide-v9.md');
  assert.equal(current.qualification, 'https://github.com/rore/keir-core/actions/runs/43451868303');
  assert.equal(current.bytes, 11801); assert.equal(guide.length, current.bytes);
  assert.equal(current.sha256, 'sha256:21615e93fc426f11eb756e850a4e0660d3a5cab55f69f47f5b3e818fc3fb1257');
  assert.equal(hash(guide), current.sha256);
  assert.equal(current.distribution.file, 'keir-authoring-companion-v9.zip');
  assert.equal(current.distribution.bytes, 246443);
  assert.equal(current.distribution.sha256, 'sha256:c1ca8b6f2f3c5089afca5e134d0b21ed2477a570141c36fcc1ea55a2f6c41867');
  const archive = read(current.distribution.file);
  assert.equal(archive.length, current.distribution.bytes); assert.equal(hash(archive), current.distribution.sha256);
  const manifestPins = current.distribution.manifest, bytes = read(manifestPins.file), manifest = JSON.parse(bytes);
  assert.equal(manifestPins.file, 'keir-authoring-companion-v9-manifest.json');
  assert.equal(manifestPins.source, 'manifest.json'); assert.equal(manifestPins.bytes, 7159);
  assert.equal(manifestPins.sha256, 'sha256:a98c013fe2221073f93b280f8bc0223b49bd298ff7bc910e69a2dec97387a74b');
  assert.equal(bytes.length, manifestPins.bytes); assert.equal(hash(bytes), manifestPins.sha256);
  assert.equal(manifest.sourceRevision, current.revision); assert.equal(manifest.producer, 'keir-compiler-java/0.5.0');
  assert.ok(Object.hasOwn(manifest.files, 'docs/specs/README.md'), 'The guide-linked offline qualification index must be packaged.');
  assert.deepEqual(manifest.files['docs/specs/README.md'], { bytes: 12036,
    digest: 'sha256:4bce42b59c998b3f8cde706ccba0628fa4e439d923524d3b838a98b8c1b06250' });
  assert.equal(manifest.compatibility.coreRevision, '3a383c2d0c6227eedc9c03927c2dd1910360d5b9');
  assert.equal(current.coreRevision, manifest.compatibility.coreRevision);
  assert.deepEqual(manifest.contracts, { language: 'keir/3', dcm: 'keir-dcm/4', descriptorRecipe: 'keir-record-descriptors/3',
    artifact: 'keir-artifact/4', scenario: 'keir-scenario/4', retainedAuthoring: { language: 'keir/2', dcm: 'keir-dcm/3',
      descriptorRecipe: 'keir-record-descriptors/2', artifact: 'keir-artifact/4', scenario: 'keir-scenario/4' } });
  assert.equal(Object.keys(manifest.files).length, 35);
  assert.deepEqual(Object.keys(manifest.files).filter(path => path.startsWith('schemas/')).sort(), [
    'schemas/artifact-3/artifact.schema.json', 'schemas/artifact-4/artifact.schema.json',
    'schemas/dcm-3/dcm.schema.json', 'schemas/dcm-4/dcm.schema.json',
    'schemas/scenario-3/scenario.schema.json', 'schemas/scenario-4/scenario.schema.json',
    'schemas/source-2/source.schema.json', 'schemas/source-3/source.schema.json',
  ]);
  assert.equal(manifest.files['schemas/scenario-4/scenario.schema.json'].digest, hash(read('keir-verification/scenario-v4.schema.json')));
  assert.equal(manifest.compatibility.packages.nodeRuntime.assets['keir-runtime-node-0.5.0.tgz'], JSON.parse(read('provenance.json')).sha256);
  assert.equal(manifest.compatibility.packages.compiler.assets['keir-compiler-cli-0.5.0.zip'], JSON.parse(read('compiler-provenance.json')).distribution.sha256);
  const f = fixture(); await f.run();
  assert.equal(f.requests[0].instructions.endsWith(guide.toString('utf8')), true);
});

function fixture(steps = [], initial = {}) {
  const context = { ownerId: 'owner', sessionId: 'session', conversationId: 'conversation', runId: 'run',
    budget: { remainingMicros: 1000 }, current: () => true, checkpoint: () => {} };
  const state = createAuthoringState(context);
  let draft = { revisionId: null, draftVersion: 0, suiteDigest: null, ...initial };
  let next = 0;
  const events = [], requests = [];
  const host = {
    readDraft: () => ({ ...draft }),
    discover: () => { events.push('discover'); return { profile: 'keir-read/2', capabilities: ['tasks.get'] }; },
    compile: (bytes, expected) => {
      events.push(['compile', bytes.toString(), expected]);
      if (bytes.toString() === 'bad') return { diagnostics: [{ code: 'SOURCE_INVALID', path: '/source' }] };
      assert.equal(expected, draft.draftVersion);
      draft = { revisionId: 'revision' + ++next, draftVersion: expected + 1, suiteDigest: null };
      return { ...draft };
    },
    proposeScenarios: (revision, cases, expected) => {
      events.push(['scenarios', revision, cases, expected]);
      assert.equal(revision, draft.revisionId); assert.equal(expected, draft.draftVersion);
      draft = { revisionId: 'revision' + ++next, draftVersion: expected + 1, suiteDigest: suite };
      return { ...draft };
    },
    simulate: (revision, expected) => {
      events.push(['simulate', revision, expected]);
      return { ...draft, evidenceId: 'evidence', summary: { statuses: ['PASS'] } };
    },
    readEvidence: () => { events.push('readEvidence'); return { ...draft, evidenceId: 'evidence', eligible: true, summary: { statuses: ['PASS'] } }; },
  };
  const provider = { reserveMicros: 10, maxMicros: 1000, complete: async request => {
    requests.push(request);
    const item = steps.shift();
    const calls = item ? [{ id: 'call' + requests.length, ...item }] : [];
    return { calls, text: calls.length ? '' : 'Stopped honestly.', usage: { inputTokens: 10, outputTokens: 10 },
      continuation: { provider: 'fake', items: [{ calls }] } };
  } };
  const run = (options = {}) => runAuthoringTurn({ host, provider, context, state,
    input: { id: 'input' + (state.version + 1), text: 'Create a read-only rule.', expectedVersion: state.version }, ...options });
  return { context, state, host, provider, requests, events, run, setDraft: value => { draft = value; } };
}

test('real loop compiles, repairs, replaces scenarios, consumes returned IDs and offers only host evidence', async () => {
  const f = fixture([
    call('discover_catalog'), call('compile_draft', { sourceJson: 'bad', expectedDraftVersion: 0 }),
    call('compile_draft', { sourceJson: '{"program":"independent"}', expectedDraftVersion: 0 }),
    call('propose_scenarios', { revisionId: 'revision1', cases: ['{"id":"independent-expectation"}'], expectedDraftVersion: 1 }),
    call('simulate_draft', { revisionId: 'revision2', expectedDraftVersion: 2 }),
    call('offer_review', { summary: 'Review the exact tested cases and untested limits.' }),
  ]);
  const result = await f.run();
  assert.equal(result.status, 'REVIEW_AVAILABLE');
  assert.deepEqual(result.review, { revisionId: 'revision2', draftVersion: 2, suiteDigest: suite,
    evidenceId: 'evidence', eligible: true, summary: { statuses: ['PASS'] } });
  assert.deepEqual(f.events, ['discover', ['compile', 'bad', 0], ['compile', '{"program":"independent"}', 0],
    ['scenarios', 'revision1', ['{"id":"independent-expectation"}'], 1], ['simulate', 'revision2', 2], 'readEvidence']);
  assert.equal(f.state.handles.draftVersion, 2, 'simulation/review never advance version');
  assert.equal(f.context.budget.remainingMicros, 940);
  assert.deepEqual(JSON.parse(f.requests[2].toolResult.output).result.diagnostics, [{ code: 'SOURCE_INVALID', path: '/source' }]);
  assert.deepEqual(AUTHORING_TOOLS.map(tool => tool.name), ['discover_catalog', 'discover_projects', 'ask_clarification', 'compile_draft', 'propose_scenarios', 'simulate_draft', 'offer_review']);
});

test('clarification pauses until real user input and retains counters and pending tool result', async () => {
  const f = fixture([call('ask_clarification', { question: 'What should an open task display?' })]);
  assert.equal((await f.run()).status, 'AWAITING_USER');
  assert.equal(f.requests.length, 1); assert.equal(f.state.counts.clarifications, 1);
  assert.equal((await f.run({ input: { id: 'answer', text: 'PENDING.', expectedVersion: 1 } })).status, 'IDLE');
  assert.equal(f.requests[1].input, 'PENDING.');
  assert.equal(JSON.parse(f.requests[1].toolResult.output).status, 'AWAITING_USER');
  assert.equal(f.state.counts.calls, 2);
  const spent = f.context.budget.remainingMicros;
  assert.equal((await f.run({ input: { id: 'answer', text: 'Replay.', expectedVersion: 2 } })).code, 'DUPLICATE_INPUT');
  assert.equal((await f.run({ input: { id: 'other', text: 'Old tab.', expectedVersion: 0 } })).code, 'STALE_CONVERSATION');
  assert.equal(f.context.budget.remainingMicros, spent);
});

test('forbidden tools, extra authority and fake evidence arguments never reach host mutations', async () => {
  for (const item of [call('approve', { revisionId: 'forged' }),
    call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0, ownerId: 'other' }),
    call('offer_review', { summary: 'Approved!', evidenceId: 'forged' }),
    call('propose_scenarios', { revisionId: 'other', cases: [], expectedDraftVersion: 0 })]) {
    const f = fixture([item]);
    assert.equal((await f.run()).status, 'IDLE');
    assert.deepEqual(f.events, []);
    const rejected = JSON.parse(f.requests[1].toolResult.output);
    assert.equal(rejected.ok, false); assert.equal(rejected.code, 'INVALID_TOOL_ARGUMENTS');
    if (item.name === 'propose_scenarios') {
      assert.deepEqual(rejected.currentDraft, { revisionId: null, draftVersion: 0, suiteDigest: null });
      assert.equal(rejected.remainingAttempts, 2);
      assert.deepEqual(rejected.diagnostics, [{ code: 'SCENARIO_COUNT_INVALID', path: '/cases' }]);
    } else assert.deepEqual(rejected, { ok: false, code: 'INVALID_TOOL_ARGUMENTS' });
  }
});

test('scenario handle feedback permits exact correction without silently rebasing the rejected request', async () => {
  const cases = ['{"id":"client-without-due","expect":"DENY"}', '{"id":"client-with-due","expect":"ALLOW"}'];
  const f = fixture([call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0 }),
    call('propose_scenarios', { revisionId: 'older', cases, expectedDraftVersion: 2 }),
    call('propose_scenarios', { revisionId: 'revision1', cases, expectedDraftVersion: 2 }),
    call('propose_scenarios', { revisionId: 'revision1', cases, expectedDraftVersion: 1 }),
    call('simulate_draft', { revisionId: 'revision2', expectedDraftVersion: 2 }),
    call('offer_review', { summary: 'The independently requested examples passed.' })]);
  assert.equal((await f.run()).status, 'REVIEW_AVAILABLE');
  for (const [index, path, remaining] of [[2, '/revisionId', 2], [3, '/expectedDraftVersion', 1]]) {
    assert.deepEqual(JSON.parse(f.requests[index].toolResult.output), { ok: false, code: 'INVALID_TOOL_ARGUMENTS',
      diagnostics: [{ code: 'DRAFT_HANDLE_MISMATCH', path }],
      currentDraft: { revisionId: 'revision1', draftVersion: 1, suiteDigest: null }, remainingAttempts: remaining });
  }
  assert.deepEqual(f.events.filter(x => Array.isArray(x) && x[0] === 'scenarios'), [['scenarios', 'revision1', cases, 1]]);
  assert.equal(f.events.some(x => /approve|activate/.test(String(x))), false);
});

for (const hostDiagnostics of [false, true]) test(`scenario repair stops after three ${hostDiagnostics ? 'host diagnostics' : 'argument errors'} despite interleaved discovery`, async () => {
  const scenarios = () => call('propose_scenarios', { revisionId: 'revision1', cases: hostDiagnostics ? ['{}'] : [], expectedDraftVersion: 1 });
  const f = fixture([call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0 }),
    scenarios(), call('discover_catalog'), scenarios(), call('discover_catalog'), scenarios(),
    call('offer_review', { summary: 'Must never be reached.' })]);
  if (hostDiagnostics) f.host.proposeScenarios = () => ({ diagnostics: [{ code: 'INVALID_SCENARIO', path: '/cases/0' }] });
  assert.deepEqual(await f.run(), { status: 'BLOCKED', code: 'INVALID_TOOL_ARGUMENTS' });
  assert.equal(f.requests.length, 6);
  assert.equal(f.state.pending && JSON.parse(f.state.pending.output).remainingAttempts, 0);
  assert.deepEqual(f.state.handles, { revisionId: 'revision1', draftVersion: 1, suiteDigest: null });
  assert.equal(f.events.includes('readEvidence'), false);
  assert.equal(f.events.some(x => Array.isArray(x) && x[0] === 'simulate'), false);
  assert.equal(f.state.usage.reservedMicros, 60, 'every dispatched provider request stays charged');
});

test('successful scenario acceptance resets its repair streak for later explicit scenario work', async () => {
  const f = fixture([call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0 }),
    call('propose_scenarios', { revisionId: 'old', cases: ['{}'], expectedDraftVersion: 1 }),
    call('propose_scenarios', { revisionId: 'revision1', cases: ['{}'], expectedDraftVersion: 1 }),
    call('propose_scenarios', { revisionId: 'old', cases: ['{}'], expectedDraftVersion: 1 }),
    call('propose_scenarios', { revisionId: 'revision2', cases: ['{}'], expectedDraftVersion: 2 })]);
  assert.equal((await f.run()).status, 'IDLE');
  assert.equal(JSON.parse(f.requests[4].toolResult.output).remainingAttempts, 2);
  assert.equal(f.state.handles.draftVersion, 3);
});

for (const [cases, diagnostic] of [[[], 'SCENARIO_COUNT_INVALID'], [[{}], 'SCENARIO_TEXT_INVALID'],
  [['x'.repeat(49153)], 'SCENARIO_BYTES_LIMIT']]) test(`scenario ${diagnostic} feedback never dispatches malformed examples`, async () => {
  const f = fixture([call('propose_scenarios', { revisionId: 'compiled', cases, expectedDraftVersion: 1 })],
    { revisionId: 'compiled', draftVersion: 1 });
  assert.equal((await f.run()).status, 'IDLE');
  assert.deepEqual(f.events, []);
  const result = JSON.parse(f.requests[1].toolResult.output);
  assert.equal(result.diagnostics[0].code, diagnostic);
  assert.equal(result.remainingAttempts, 2);
});

test('old source ID after suite replacement is rejected; absent suite cannot simulate', async () => {
  const f = fixture([call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0 }),
    call('propose_scenarios', { revisionId: 'revision1', cases: ['{"id":"case"}'], expectedDraftVersion: 1 }),
    call('simulate_draft', { revisionId: 'revision1', expectedDraftVersion: 1 })]);
  assert.equal((await f.run()).status, 'IDLE');
  assert.equal(f.events.filter(item => item[0] === 'simulate').length, 0);
  const absent = fixture([call('simulate_draft', { revisionId: 'compiled', expectedDraftVersion: 1 })], { revisionId: 'compiled', draftVersion: 1 });
  assert.equal((await absent.run()).status, 'IDLE'); assert.deepEqual(absent.events, []);
});

test('owner/run fence after provider await prevents a late mutation and retains spend', async () => {
  const f = fixture(); let release;
  f.provider.complete = request => { f.requests.push(request); return new Promise(resolve => { release = resolve; }); };
  const running = f.run(); await new Promise(resolve => setImmediate(resolve));
  f.context.current = () => false;
  release({ calls: [{ id: 'late', ...call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0 }) }], text: '',
    continuation: {}, usage: { inputTokens: 1, outputTokens: 1 } });
  assert.deepEqual(await running, { status: 'BLOCKED', code: 'STALE_CONTEXT' });
  assert.deepEqual(f.events, []); assert.equal(f.context.budget.remainingMicros, 990);
});

test('external draft change during provider generation is not silently adopted', async () => {
  const f = fixture([call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0 })]);
  const original = f.provider.complete;
  f.provider.complete = async request => { const result = await original(request); f.setDraft({ revisionId: 'external', draftVersion: 1, suiteDigest: null }); return result; };
  assert.equal((await f.run()).code, 'STALE_DRAFT'); assert.deepEqual(f.events, []);
  const text = fixture(); const complete = text.provider.complete;
  text.provider.complete = async request => { const result = await complete(request); text.setDraft({ revisionId: 'external', draftVersion: 1, suiteDigest: null }); return result; };
  assert.deepEqual(await text.run(), { status: 'BLOCKED', code: 'STALE_DRAFT' });
  assert.equal(text.state.continuation, undefined, 'stale text and native continuation are not adopted');
});

test('unknown host failure is a safe blocker; duplicate IDs and false returned handles stop', async () => {
  const f = fixture([call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0 })]);
  f.host.compile = () => { throw new Error('SECRET raw compiler path'); };
  assert.deepEqual(await f.run(), { status: 'BLOCKED', code: 'TOOL_FAILED' });
  const duplicate = fixture([call('discover_catalog', {}, 'same'), call('discover_catalog', {}, 'same')]);
  assert.equal((await duplicate.run()).code, 'PROVIDER_RESPONSE_INVALID'); assert.equal(duplicate.events.length, 1);
  const bad = fixture([call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0 })]);
  bad.host.compile = () => ({ revisionId: 'forged', draftVersion: 0, suiteDigest: suite });
  assert.equal((await bad.run()).code, 'HOST_RESULT_INVALID');
});

test('productive compilation, scenario replacement and simulation continue beyond eight calls and tools', async () => {
  const steps = [];
  for (let index = 0; index < 9; index++) {
    steps.push(call('compile_draft', { sourceJson: `source ${index}`, expectedDraftVersion: index * 2 }),
      call('propose_scenarios', { revisionId: `revision${index * 2 + 1}`, cases: [`{"id":"case-${index}"}`], expectedDraftVersion: index * 2 + 1 }),
      call('simulate_draft', { revisionId: `revision${index * 2 + 2}`, expectedDraftVersion: index * 2 + 2 }));
  }
  const f = fixture(steps);
  assert.equal((await f.run()).status, 'IDLE');
  assert.deepEqual(f.state.counts, { calls: 28, tools: 27, compiles: 9, simulations: 9, clarifications: 0, inputs: 1 });
  assert.deepEqual(f.state.handles, { revisionId: 'revision18', draftVersion: 18, suiteDigest: suite });
  assert.equal(f.events.filter(event => event[0] === 'scenarios').length, 9);
  assert.equal(f.context.budget.remainingMicros, 720);
  assert.equal(f.state.usage.reservedMicros, 280);
});

test('more than eight user inputs and clarifications remain usable after the old 24-hour age', async () => {
  const f = fixture(Array.from({ length: 12 }, (_, index) => call('ask_clarification', { question: `Business choice ${index}?` })));
  f.state.createdAt -= 3 * 86400000;
  for (let index = 0; index < 12; index++) assert.equal((await f.run()).status, 'AWAITING_USER');
  assert.equal((await f.run()).status, 'IDLE');
  assert.equal(f.state.counts.inputs, 13);
  assert.equal(f.state.counts.clarifications, 12);
  assert.equal(f.state.counts.calls, 13);
  assert.equal(f.state.inputIds.length, 13);
  assert.equal(f.context.budget.remainingMicros, 870);
  assert.equal(f.requests[12].input, 'Create a read-only rule.');
  assert.equal(JSON.parse(f.requests[12].toolResult.output).status, 'AWAITING_USER');
});

test('configured spending still stops before a paid request', async () => {
  const f = fixture(); f.context.budget.remainingMicros = 9;
  assert.equal((await f.run()).code, 'SPEND_LIMIT'); assert.equal(f.requests.length, 0);
  assert.equal(f.context.budget.remainingMicros, 9);
  assert.equal(f.state.usage.reservedMicros, 0);
});

for (const provider of ['openai', 'anthropic']) test(`${provider} native preflight rejects oversized context before calls, holds or dispatch`, async () => {
  const f = fixture(), checkpoints = [];
  const config = readAuthoringConfig({ KEIR_AI_PROVIDER: provider,
    KEIR_AI_MODEL: provider === 'openai' ? 'gpt-5.6-terra' : 'claude-haiku-5-5', KEIR_AI_MAX_USD: '1',
    OPENAI_API_KEY: 'synthetic-test-key', ANTHROPIC_API_KEY: 'synthetic-test-key' });
  let fetches = 0;
  f.provider = createAuthoringProvider(config, { fetchImpl: async () => { fetches++; assert.fail('preflight must prevent fetching'); } });
  f.state.continuation = { provider, items: provider === 'openai'
    ? [{ type: 'reasoning', encrypted_content: 'x'.repeat(131072), summary: [] }]
    : [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x'.repeat(131072), signature: 'native-signature' }] }] };
  const continuation = structuredClone(f.state.continuation);
  f.context.checkpoint = state => checkpoints.push({ ...state.checkpoint });
  assert.deepEqual(await f.run({ provider: f.provider }), { status: 'BLOCKED', code: 'CONTEXT_LIMIT' });
  assert.equal(fetches, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.state.counts.calls, 0);
  assert.equal(f.state.counts.tools, 0);
  assert.equal(f.state.dispatchOrdinal, 0);
  assert.equal(f.state.inFlight, null);
  assert.equal(f.context.budget.remainingMicros, 1000);
  assert.equal(f.state.usage.reservedMicros, 0);
  assert.deepEqual(f.state.continuation, continuation);
  assert.deepEqual(checkpoints.map(record => record.phase), ['ADMIT', 'TERMINAL']);
  assert.deepEqual(f.events, []);
});

test('preflight after a successful tool preserves saved context without another hold or unknown dispatch', async () => {
  const f = fixture([call('discover_catalog')]), checkpoints = [];
  let checked = 0;
  f.provider.preflight = request => {
    assert.deepEqual(request.tools, AUTHORING_TOOLS);
    if (++checked === 2) {
      assert.equal(JSON.parse(request.toolResult.output).result.profile, 'keir-read/2');
      throw new AuthoringError('CONTEXT_LIMIT');
    }
  };
  f.context.checkpoint = state => checkpoints.push({ ...state.checkpoint });
  assert.deepEqual(await f.run(), { status: 'BLOCKED', code: 'CONTEXT_LIMIT' });
  assert.equal(checked, 2);
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.counts.calls, 1);
  assert.equal(f.state.counts.tools, 1);
  assert.equal(f.state.usage.reservedMicros, 10);
  assert.equal(f.context.budget.remainingMicros, 990);
  assert.equal(f.state.dispatchOrdinal, 2);
  assert.equal(f.state.inFlight, null);
  assert.deepEqual(f.events, ['discover']);
  assert.equal(JSON.parse(f.state.pending.output).result.profile, 'keir-read/2');
  assert.deepEqual(checkpoints.filter(record => record.phase === 'RESULT').map(record => record.outcome), ['SUCCESS', 'SUCCESS']);
});

test('concurrent runs share atomic budget and same conversation has no overlapping request', async () => {
  const first = fixture(); const second = fixture(); second.context.conversationId = second.state.conversationId = 'different';
  const budget = { remainingMicros: 10 }; first.context.budget = second.context.budget = budget;
  let release;
  first.provider.complete = () => new Promise(resolve => { release = resolve; });
  const running = first.run(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await first.run()).code, 'AI_BUSY');
  assert.equal((await second.run()).code, 'SPEND_LIMIT'); assert.equal(second.requests.length, 0);
  release({ calls: [], text: 'Stopped.', continuation: { provider: 'fake', items: [] }, usage: { inputTokens: 1, outputTokens: 1 } });
  assert.equal((await running).status, 'IDLE'); assert.equal(budget.remainingMicros, 0);
});

test('cancel stops late provider results; interrupted persisted run never replays', async () => {
  const f = fixture(); const controller = new AbortController(); let release;
  f.provider.complete = () => new Promise(resolve => { release = resolve; });
  const running = f.run({ signal: controller.signal }); await new Promise(resolve => setImmediate(resolve));
  controller.abort(); assert.deepEqual(await running, { status: 'CANCELLED', code: 'CANCELLED' });
  release({ calls: [call('compile_draft')], text: '', continuation: {}, usage: { inputTokens: 1, outputTokens: 1 } });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(f.events, []); assert.equal(f.context.budget.remainingMicros, 990);
  const restarted = fixture(); restarted.state.status = 'RUNNING';
  assert.equal((await restarted.run()).code, 'RUN_INTERRUPTED'); assert.equal(restarted.requests.length, 0);
});

test('live context is revalidated after every kind of host await', async () => {
  const ready = { revisionId: 'ready', draftVersion: 1, suiteDigest: suite };
  for (const [method, item] of [
    ['readDraft', call('discover_catalog')], ['discover', call('discover_catalog')],
    ['compile', call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 1 })],
    ['proposeScenarios', call('propose_scenarios', { revisionId: 'ready', cases: ['{}'], expectedDraftVersion: 1 })],
    ['simulate', call('simulate_draft', { revisionId: 'ready', expectedDraftVersion: 1 })],
    ['readEvidence', call('offer_review', { summary: 'Review.' })],
  ]) {
    const f = fixture([item], ready);
    f.state.evidenceHandle = { ...ready, evidenceId: 'evidence' };
    f.host[method] = async () => { f.context.current = () => false; return { ...ready }; };
    const result = await f.run();
    assert.equal(result.code, 'STALE_CONTEXT', method); assert.equal(result.status, 'BLOCKED', method);
    assert.equal(f.state.handles?.revisionId ?? null, method === 'readDraft' ? null : 'ready');
  }
});

test('productive aggregate work beyond 120 seconds completes with monotonic lifetime telemetry', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const f = fixture([call('discover_catalog'), call('discover_catalog')]), snapshots = [];
  const complete = f.provider.complete;
  f.provider.complete = request => { now += 61000; return complete(request); };
  f.context.checkpoint = state => snapshots.push(state.activeMs);
  assert.equal((await f.run()).status, 'IDLE');
  assert.equal(f.requests.length, 3);
  assert.equal(f.state.activeMs, 183000);
  assert.ok(snapshots.every((value, index) => !index || value >= snapshots[index - 1]));
  assert.equal((await f.run()).status, 'IDLE');
  assert.equal(f.state.activeMs, 244000);
  assert.equal(f.context.budget.remainingMicros, 960);
});

test('external cancellation stops a pending host operation without subsequent paid work', async () => {
  const f = fixture([call('discover_catalog')]), controller = new AbortController();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.host.discover = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const running = f.run({ signal: controller.signal });
  await ready;
  controller.abort();
  assert.deepEqual(await running, { status: 'CANCELLED', code: 'CANCELLED' });
  release({ catalog: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1);
  assert.equal(f.context.budget.remainingMicros, 990);
  assert.equal(f.state.pending, undefined);
});

test('source/case byte limits and malformed Unicode reject before host mutation', async () => {
  const items = [call('compile_draft', { sourceJson: 'x'.repeat(16385), expectedDraftVersion: 0 }),
    call('compile_draft', { sourceJson: '\ud800', expectedDraftVersion: 0 }),
    ...[Array(9).fill('{}'), ['x'.repeat(65537)], ['x'.repeat(49152)], ['\ud800'], [' '], [{}], []].map(cases =>
      call('propose_scenarios', { revisionId: 'compiled', cases, expectedDraftVersion: 1 }))];
  for (const item of items) {
    const f = fixture([item], { revisionId: 'compiled', draftVersion: item.arguments.expectedDraftVersion, suiteDigest: null });
    assert.equal((await f.run()).status, 'IDLE'); assert.deepEqual(f.events, []);
    assert.equal(JSON.parse(f.requests[1].toolResult.output).code, 'INVALID_TOOL_ARGUMENTS');
  }
});

test('case schema is closed and original malformed JSON strings reach native admission unchanged', async () => {
  const schema = AUTHORING_TOOLS.find(tool => tool.name === 'propose_scenarios').parameters;
  assert.deepEqual(schema.required, ['revisionId', 'cases', 'expectedDraftVersion']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.cases, { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 });
  const cases = [' {"id":"first","id":"second"} ', '{"id":"\\ud800"}', 'not JSON'];
  const f = fixture([call('propose_scenarios', { revisionId: 'compiled', cases, expectedDraftVersion: 1 })],
    { revisionId: 'compiled', draftVersion: 1 });
  f.host.proposeScenarios = (revision, originals, expected) => {
    assert.equal(revision, 'compiled'); assert.equal(expected, 1);
    assert.deepEqual(originals, cases); assert.notEqual(originals, cases);
    originals.pop();
    throw new AuthoringError('INVALID_TOOL_ARGUMENTS');
  };
  assert.equal((await f.run()).status, 'IDLE');
  assert.equal(cases.length, 3, 'host receives an independent array of the exact original strings');
  assert.deepEqual(JSON.parse(f.requests[1].toolResult.output), { ok: false, code: 'INVALID_TOOL_ARGUMENTS',
    diagnostics: [{ code: 'INVALID_TOOL_ARGUMENTS', path: '/arguments' }],
    currentDraft: { revisionId: 'compiled', draftVersion: 1, suiteDigest: null }, remainingAttempts: 2 });
});

test('scenario diagnostics preserve current handles, enforce the draft fence and consume the existing budget', async () => {
  const ready = { revisionId: 'compiled', draftVersion: 1, suiteDigest: null };
  for (const stale of [false, true]) {
    const f = fixture([call('propose_scenarios', { revisionId: 'compiled', cases: ['{}'], expectedDraftVersion: 1 })], ready);
    f.host.proposeScenarios = () => {
      if (stale) f.setDraft({ revisionId: 'external', draftVersion: 2, suiteDigest: null });
      return { diagnostics: [{ code: 'INVALID_SCENARIO', path: '/cases/0' }] };
    };
    f.context.budget.remainingMicros = 10;
    const result = await f.run();
    assert.equal(result.code, stale ? 'STALE_DRAFT' : 'SPEND_LIMIT');
    assert.deepEqual(f.state.handles, ready); assert.equal(f.state.counts.tools, 1); assert.equal(f.state.counts.calls, stale ? 1 : 2);
    assert.equal(f.context.budget.remainingMicros, 0); assert.equal(f.requests.length, 1); assert.deepEqual(f.events, []);
    if (!stale) assert.deepEqual(JSON.parse(f.state.pending.output), { ok: false, code: 'INVALID_TOOL_ARGUMENTS',
      diagnostics: [{ code: 'INVALID_SCENARIO', path: '/cases/0' }], currentDraft: ready, remainingAttempts: 2 });
  }
});

test('synchronous admission precedes the first await and each dispatch/result precedes the next effect', async () => {
  const f = fixture([call('discover_catalog')]);
  assert.deepEqual({ ordinal: f.state.dispatchOrdinal, inFlight: f.state.inFlight, checkpoint: f.state.checkpoint,
    lastResult: f.state.lastResult, evidence: f.state.evidenceHandle },
  { ordinal: 0, inFlight: null, checkpoint: null, lastResult: null, evidence: null });
  const order = [], snapshots = [];
  f.context.checkpoint = state => {
    const record = state.checkpoint;
    order.push([record.phase, record.kind, record.ordinal, record.outcome]);
    snapshots.push(structuredClone(state));
    if (record.phase === 'DISPATCH') assert.deepEqual(state.inFlight,
      { ordinal: record.ordinal, kind: record.kind, ...(record.callId && { callId: record.callId }) });
    if (record.phase === 'RESULT') assert.equal(state.inFlight, null);
  };
  const complete = f.provider.complete;
  f.provider.complete = request => { order.push('HTTP'); return complete(request); };
  const discover = f.host.discover;
  f.host.discover = () => { order.push('HOST'); return discover(); };
  const running = f.run();
  assert.deepEqual(order, [['ADMIT', undefined, undefined, undefined]]);
  assert.equal(f.state.version, 1); assert.deepEqual(f.state.inputIds, ['input1']);
  assert.equal(f.state.counts.inputs, 1); assert.equal(f.state.status, 'RUNNING');
  const result = await running;
  assert.deepEqual(order, [
    ['ADMIT', undefined, undefined, undefined], ['DISPATCH', 'provider', 1, undefined], 'HTTP',
    ['RESULT', 'provider', 1, 'SUCCESS'], ['DISPATCH', 'tool', 2, undefined], 'HOST',
    ['RESULT', 'tool', 2, 'SUCCESS'], ['DISPATCH', 'provider', 3, undefined], 'HTTP',
    ['RESULT', 'provider', 3, 'SUCCESS'], ['TERMINAL', undefined, undefined, undefined],
  ]);
  assert.equal(snapshots[1].counts.calls, 1); assert.equal(snapshots[1].usage.reservedMicros, 10);
  assert.equal(snapshots[2].continuation.provider, 'fake');
  assert.equal(JSON.parse(snapshots[4].pending.output).ok, true);
  assert.deepEqual(snapshots.at(-1).lastResult, result); assert.equal(snapshots.at(-1).status, result.status);
  assert.ok(snapshots.every((state, index) => !index || state.activeMs >= snapshots[index - 1].activeMs));
});

test('checkpoint is mandatory and a thenable admission never dispatches or leaks rejection', async () => {
  const missing = fixture(); delete missing.context.checkpoint;
  assert.deepEqual(await missing.run(), { status: 'BLOCKED', code: 'CONFIG_INVALID' });
  assert.equal(missing.state.counts.inputs, 0); assert.equal(missing.requests.length, 0);
  for (const thenable of [() => Promise.reject(new Error('private checkpoint failure')),
    () => ({ then: (_resolve, reject) => reject(new Error('private thenable failure')) })]) {
    const f = fixture();
    f.context.checkpoint = state => state.checkpoint.phase === 'ADMIT' ? thenable() : undefined;
    assert.deepEqual(await f.run(), { status: 'BLOCKED', code: 'TOOL_FAILED' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.requests.length, 0); assert.equal(f.context.budget.remainingMicros, 1000);
  }
});

test('rejected admission preserves its blocker without attempting a terminal checkpoint', async () => {
  const f = fixture(), phases = [];
  f.context.checkpoint = state => { phases.push(state.checkpoint.phase); throw new AuthoringError('CONVERSATION_LIMIT'); };
  assert.deepEqual(await f.run(), { status: 'BLOCKED', code: 'CONVERSATION_LIMIT' });
  assert.deepEqual(phases, ['ADMIT']); assert.equal(f.requests.length, 0);
  assert.equal((await fixture().run()).status, 'IDLE', 'admission refusal releases the in-process scope');
});

test('pre-HTTP checkpoint failure retains unknown holds and refunds only verified rollback', async () => {
  for (const rolledBack of [false, true]) {
    const f = fixture();
    f.context.checkpoint = state => {
      if (state.checkpoint.phase !== 'DISPATCH') return;
      const error = new AuthoringError('SPEND_LIMIT');
      if (rolledBack) error.checkpointRolledBack = true;
      throw error;
    };
    assert.deepEqual(await f.run(), { status: 'BLOCKED', code: 'SPEND_LIMIT' });
    assert.equal(f.requests.length, 0); assert.equal(f.state.counts.calls, 1);
    assert.equal(f.context.budget.remainingMicros, rolledBack ? 1000 : 990);
    assert.equal(f.state.usage.reservedMicros, rolledBack ? 0 : 10);
  }
  const asynchronous = fixture();
  asynchronous.context.checkpoint = state => state.checkpoint.phase === 'DISPATCH'
    ? Promise.reject(new Error('private commit outcome')) : undefined;
  assert.deepEqual(await asynchronous.run(), { status: 'BLOCKED', code: 'TOOL_FAILED' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(asynchronous.requests.length, 0); assert.equal(asynchronous.context.budget.remainingMicros, 990);
});

test('result checkpoint failure prevents tool dispatch and subsequent provider work', async () => {
  for (const kind of ['provider', 'tool']) {
    const f = fixture([call('discover_catalog')]);
    const records = [];
    f.context.checkpoint = state => {
      records.push({ ...state.checkpoint });
      if (state.checkpoint.phase === 'RESULT' && state.checkpoint.kind === kind) throw new Error('private COMMIT outcome');
    };
    assert.deepEqual(await f.run(), { status: 'BLOCKED', code: 'TOOL_FAILED' });
    assert.equal(f.requests.length, 1); assert.equal(f.events.length, kind === 'tool' ? 1 : 0);
    assert.equal(f.state.inFlight.kind, kind);
    assert.equal(records.filter(record => record.phase === 'RESULT' && record.kind === kind).length, 1);
    assert.equal(records.at(-1).phase, 'TERMINAL');
    assert.deepEqual(f.state.lastResult, { status: 'BLOCKED', code: 'TOOL_FAILED' });
  }
  const refused = fixture([call('discover_catalog')]);
  refused.context.checkpoint = state => {
    if (state.checkpoint.phase === 'DISPATCH' && state.checkpoint.kind === 'tool') throw new Error('private dispatch failure');
  };
  assert.deepEqual(await refused.run(), { status: 'BLOCKED', code: 'TOOL_FAILED' });
  assert.deepEqual(refused.events, []); assert.equal(refused.requests.length, 1);
});

test('tool-specific lifetime counters are durable before the callback and include invalid attempts', async () => {
  const ready = { revisionId: 'ready', draftVersion: 1, suiteDigest: suite };
  for (const [item, quota] of [
    [call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 1 }), 'compiles'],
    [call('simulate_draft', { revisionId: 'ready', expectedDraftVersion: 1 }), 'simulations'],
    [call('ask_clarification', { question: 'Question?' }), 'clarifications'],
  ]) {
    const f = fixture([item], ready); let counted;
    f.context.checkpoint = state => {
      if (state.checkpoint.phase === 'DISPATCH' && state.checkpoint.kind === 'tool') counted = state.counts[quota];
    };
    assert.notEqual((await f.run()).status, 'BLOCKED');
    assert.equal(counted, 1, quota);
  }
  const invalid = fixture([call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 0, forbidden: true })]);
  assert.equal((await invalid.run()).status, 'IDLE'); assert.equal(invalid.state.counts.compiles, 1);
  assert.deepEqual(invalid.events, []);
});

test('tool argument rejection is checkpointed before another provider and dispatch errors stay unknown', async () => {
  const invalid = fixture([call('discover_catalog', { injected: true })]); const rejected = [];
  invalid.context.checkpoint = state => { rejected.push(structuredClone(state)); };
  assert.equal((await invalid.run()).status, 'IDLE');
  const rejection = rejected.find(state => state.checkpoint.outcome === 'REJECTED');
  assert.deepEqual(rejection.checkpoint, { phase: 'RESULT', kind: 'tool', ordinal: 2, callId: 'call1', outcome: 'REJECTED' });
  assert.equal(JSON.parse(rejection.pending.output).code, 'INVALID_TOOL_ARGUMENTS');
  assert.deepEqual(invalid.events, []);
  for (const kind of ['provider', 'tool']) {
    const f = fixture([call('discover_catalog')]); const records = [];
    f.context.checkpoint = state => { records.push({ ...state.checkpoint }); };
    if (kind === 'provider') f.provider.complete = () => { throw new Error('private provider failure'); };
    else f.host.discover = () => { throw new Error('private host failure'); };
    assert.deepEqual(await f.run(), { status: 'BLOCKED', code: 'TOOL_FAILED' });
    assert.deepEqual(records.find(record => record.outcome === 'UNKNOWN'),
      { phase: 'RESULT', kind, ordinal: kind === 'provider' ? 1 : 2, ...(kind === 'tool' && { callId: 'call1' }), outcome: 'UNKNOWN' });
    assert.equal(f.state.inFlight, null); assert.equal(f.context.budget.remainingMicros, 990);
  }
});

test('terminal checkpoint failure cannot expose clarification or review success', async () => {
  const ready = { revisionId: 'ready', draftVersion: 1, suiteDigest: suite };
  for (const item of [call('ask_clarification', { question: 'Question?' }), call('offer_review', { summary: 'Review.' })]) {
    const f = fixture([item], ready);
    f.state.evidenceHandle = { ...ready, evidenceId: 'evidence' };
    f.context.checkpoint = state => { if (state.checkpoint.phase === 'TERMINAL') throw new Error('private terminal failure'); };
    assert.deepEqual(await f.run(), { status: 'BLOCKED', code: 'TOOL_FAILED' });
    assert.deepEqual(f.state.lastResult, { status: 'BLOCKED', code: 'TOOL_FAILED' });
    assert.equal(f.requests.length, 1);
  }
});

test('cancellation between checkpoint and execution prevents callbacks and outward success', async () => {
  for (const [phase, kind] of [['DISPATCH', 'provider'], ['DISPATCH', 'tool'], ['RESULT', 'tool']]) {
    const f = fixture([call('ask_clarification', { question: 'Question?' })]); const controller = new AbortController();
    f.context.checkpoint = state => {
      if (state.checkpoint.phase === phase && state.checkpoint.kind === kind) controller.abort();
    };
    assert.deepEqual(await f.run({ signal: controller.signal }), { status: 'CANCELLED', code: 'CANCELLED' });
    assert.equal(f.requests.length, kind === 'provider' ? 0 : 1);
    assert.deepEqual(f.state.lastResult, { status: 'CANCELLED', code: 'CANCELLED' });
  }
});

test('review uses the simulation result proof and rejects a later pointer or changed derived identity', async () => {
  const ready = { revisionId: 'ready', draftVersion: 1, suiteDigest: suite };
  for (const changed of [{ evidenceId: 'later' }, { simulationSuiteIdentity: suite }, { suiteDigest: simulationSuiteIdentity }]) {
    const f = fixture([call('simulate_draft', { revisionId: 'ready', expectedDraftVersion: 1 }), call('offer_review', { summary: 'Review.' })], ready);
    const saved = { ...ready, evidenceId: 'first', simulationSuiteIdentity };
    f.host.simulate = () => ({ ...saved, summary: { statuses: ['PASS'] } });
    f.host.readEvidence = () => ({ ...saved, eligible: true, ...changed });
    let persisted;
    f.context.checkpoint = state => {
      if (state.checkpoint.phase === 'RESULT' && state.checkpoint.ordinal === 2) persisted = structuredClone(state.evidenceHandle);
    };
    const result = await f.run();
    assert.deepEqual(result, { status: 'BLOCKED', code: 'HOST_RESULT_INVALID' });
    assert.deepEqual(persisted, saved); assert.deepEqual(f.state.evidenceHandle, saved);
    assert.equal(JSON.parse(f.requests[1].toolResult.output).result.evidenceId, 'first');
  }
});

test('resumed review uses exact saved evidence and preserves eligibility', async () => {
  const ready = { revisionId: 'ready', draftVersion: 1, suiteDigest: suite };
  for (const eligible of [true, false]) {
    const f = fixture([call('offer_review', { summary: 'The earlier check passed and the change is ready to turn on.' })], ready);
    const summary = { statuses: [eligible ? 'PASS' : 'FAIL'] };
    f.host.readEvidence = () => {
      f.events.push('readEvidence');
      return { ...ready, evidenceId: 'saved', simulationSuiteIdentity, eligible, summary };
    };
    assert.equal(f.state.evidenceHandle, null);
    assert.deepEqual(await f.run(), { status: 'REVIEW_AVAILABLE', message: 'The saved check is available to inspect.',
      review: { ...ready, evidenceId: 'saved', eligible, summary } });
    assert.deepEqual(f.events, ['readEvidence']);
  }
});

test('resumed review with missing saved evidence records a known rejection', async () => {
  const f = fixture([call('offer_review', { summary: 'Review.' })], { revisionId: 'ready', draftVersion: 1, suiteDigest: suite });
  f.host.readEvidence = () => null;
  let rejection;
  f.context.checkpoint = state => {
    if (state.checkpoint.phase === 'RESULT' && state.checkpoint.kind === 'tool') rejection = structuredClone(state);
  };
  assert.deepEqual(await f.run(), { status: 'BLOCKED', code: 'REVIEW_NOT_READY' });
  assert.equal(rejection.checkpoint.outcome, 'REJECTED');
  assert.deepEqual(JSON.parse(rejection.pending.output), { ok: false, code: 'REVIEW_NOT_READY' });
  assert.equal(f.state.inFlight, null);
});

test('resumed review rejects mismatched or malformed saved proof', async () => {
  const ready = { revisionId: 'ready', draftVersion: 1, suiteDigest: suite };
  const saved = { ...ready, evidenceId: 'saved', simulationSuiteIdentity, eligible: true };
  for (const changed of [{ revisionId: 'other' }, { draftVersion: 2 }, { suiteDigest: simulationSuiteIdentity },
    { evidenceId: '' }, { simulationSuiteIdentity: undefined }, { eligible: undefined }]) {
    const f = fixture([call('offer_review', { summary: 'Review.' })], ready);
    f.host.readEvidence = () => ({ ...saved, ...changed });
    assert.deepEqual(await f.run(), { status: 'BLOCKED', code: 'HOST_RESULT_INVALID' });
  }
});

test('resumed review rejects a draft replaced during the saved evidence read', async () => {
  const ready = { revisionId: 'ready', draftVersion: 1, suiteDigest: suite };
  const f = fixture([call('offer_review', { summary: 'Review.' })], ready);
  f.host.readEvidence = async () => {
    await Promise.resolve();
    f.setDraft({ revisionId: 'replacement', draftVersion: 2, suiteDigest: suite });
    return { ...ready, evidenceId: 'saved', simulationSuiteIdentity, eligible: true };
  };
  assert.deepEqual(await f.run(), { status: 'BLOCKED', code: 'STALE_DRAFT' });
  assert.notEqual(JSON.parse(f.state.pending?.output ?? '{}').status, 'REVIEW_AVAILABLE');
});

test('source and suite replacement clear prior exact proof and review before their result checkpoint', async () => {
  const ready = { revisionId: 'ready', draftVersion: 1, suiteDigest: suite };
  for (const item of [call('compile_draft', { sourceJson: '{}', expectedDraftVersion: 1 }),
    call('propose_scenarios', { revisionId: 'ready', cases: ['{}'], expectedDraftVersion: 1 })]) {
    const f = fixture([item], ready);
    f.state.evidenceHandle = { ...ready, evidenceId: 'old' };
    f.state.lastResult = { status: 'REVIEW_AVAILABLE', review: { ...ready, evidenceId: 'old', eligible: true } };
    let resultState;
    f.context.checkpoint = state => {
      if (state.checkpoint.phase === 'RESULT' && state.checkpoint.kind === 'tool') resultState = structuredClone(state);
    };
    assert.equal((await f.run()).status, 'IDLE');
    assert.equal(resultState.evidenceHandle, null); assert.equal(resultState.lastResult, null);
    assert.equal(resultState.handles.draftVersion, 2);
  }
});

test('a changed run identity is never overwritten by an old loop terminal or time update', async () => {
  const f = fixture();
  f.provider.complete = () => {
    f.state.runId = f.context.runId = 'new-run'; f.state.status = 'RUNNING';
    f.state.lastResult = { status: 'IDLE', message: 'New run owns this state.' };
    return { calls: [], text: 'Old result', continuation: {}, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  assert.deepEqual(await f.run(), { status: 'BLOCKED', code: 'STALE_CONTEXT' });
  assert.equal(f.state.status, 'RUNNING');
  assert.deepEqual(f.state.lastResult, { status: 'IDLE', message: 'New run owns this state.' });
});
