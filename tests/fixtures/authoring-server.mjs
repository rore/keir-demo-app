import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireDataLock, openData, taskService } from '../../src/data.mjs';
import { createApp } from '../../src/app.mjs';
import { createCompiler } from '../../src/compiler.mjs';
import { loadHost, TASK_HOOK } from '../../src/extension-catalog.mjs';
import { readAuthoringConfig } from '../../src/authoring-config.mjs';
import { taskCustomizationFixture } from './task-customization.mjs';
import { taskWorkflowCases, taskWorkflowSource } from './task-workflow-source.mjs';

const mismatchText = 'The other-project example tried to create a task when none was expected. Its outcome could not be confirmed. This did not pass. Keep the original expectations and explicitly ask to correct this change here.';

function nativeHistory(provider, body) {
  if (provider === 'openai') return {
    calls: body.input.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, name: item.name, arguments: JSON.parse(item.arguments) })),
    outputs: body.input.filter(item => item.type === 'function_call_output').map(item => ({ id: item.call_id, value: JSON.parse(item.output) })),
    users: body.input.filter(item => item.role === 'user'),
    reasoning: body.input.filter(item => item.type === 'reasoning'),
  };
  const blocks = body.messages.flatMap(item => Array.isArray(item.content) ? item.content : []);
  return {
    calls: blocks.filter(item => item.type === 'tool_use').map(item => ({ id: item.id, name: item.name, arguments: item.input })),
    outputs: blocks.filter(item => item.type === 'tool_result').map(item => ({ id: item.tool_use_id, value: JSON.parse(item.content) })),
    users: body.messages.filter(item => item.role === 'user' && item.content.some(part => part.type === 'text')),
    reasoning: blocks.filter(item => item.type === 'thinking'),
  };
}

function scriptedTransport(provider, metadata, requests, semanticMismatch, resumeRequest) {
  const { question, offerText } = metadata;
  return async (url, init) => {
    assert.equal(url, provider === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://api.anthropic.com/v1/messages');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body), history = nativeHistory(provider, body);
    assert.equal(body.tools.some(tool => /approve|activate|select/.test(tool.name)), false);
    assert.equal(history.reasoning.length, history.calls.length, 'Native reasoning must survive continuation.');
    for (const output of history.outputs) assert.ok(history.calls.some(call => call.id === output.id), 'Tool results retain their native call IDs.');
    const previous = history.calls.at(-1);
    const output = history.outputs.findLast(item => item.id === previous?.id)?.value;
    const discovery = history.outputs.findLast(item => history.calls.some(call => call.id === item.id && call.name === 'discover_catalog'))?.value?.result;
    const projects = discovery?.projects?.projects;
    const project = projects?.find(project => project.id === metadata.projectId);
    if (projects) assert.ok(project, 'The requested customer project must be discovered; never substitute the first project.');
    const editing = metadata.missingDue && discovery?.conversationContext.messages.at(-1)?.text === metadata.editRequest;
    const journey = metadata.missingDue ? { ...metadata, ...(editing && { source: metadata.editedSource, cases: metadata.editedCases }) }
      : project ? taskCustomizationFixture({ projectId: project.id, title: metadata.title,
      otherProjectId: metadata.otherProjectId }) : metadata;
    const { source, cases, wrongSource, projectId } = journey.metadata ?? journey;
    let name, args, text;
    if (!previous) { name = 'discover_catalog'; args = {}; }
    else if (previous.name === 'discover_catalog' && semanticMismatch) {
      const discovered = output.result;
      assert.ok(discovered.projects.projects.some(project => project.id === projectId), 'The test source uses an actually discovered owner-scoped project.');
      const repairing = discovered.currentProposal?.source === wrongSource;
      if (repairing) {
        assert.deepEqual(discovered.currentProposal.cases, cases, 'Repair keeps the original independent scenarios.');
        assert.ok(discovered.conversationContext.messages.some(message => message.role === 'assistant' && message.text === mismatchText),
          'The same discussion retains the failed review before an explicit correction.');
        assert.equal(discovered.conversationContext.messages.at(-1).role, 'user');
        assert.match(discovered.conversationContext.messages.at(-1).text, /correct/i);
        assert.match(JSON.stringify(history.users.at(-1).content), /correct/i, 'Only an explicit correction starts the repair.');
      }
      name = 'compile_draft'; args = { hookId: TASK_HOOK, sourceJson: repairing ? source : wrongSource, expectedDraftVersion: discovered.currentDraft.draftVersion };
    }
    else if (previous.name === 'discover_catalog') {
      const discovered = output.result, messages = discovered.conversationContext.messages;
      assert.ok(discovered.projects.projects.some(project => project.id === projectId));
      const asked = messages.findLastIndex(message => message.role === 'assistant' && message.text === question);
      if (asked < 0) { name = 'ask_clarification'; args = { question }; }
      else {
        assert.equal(history.users.length, 1, 'An explicit turn uses a fresh native chain.');
        assert.ok(asked < messages.length - 1, 'The saved question precedes the explicit answer.');
        assert.equal(messages.at(-1).role, 'user');
        const input = history.users[0].content;
        const providerText = provider === 'openai' ? input : input.find(part => part.type === 'text').text;
        const currentText = messages.at(-1).text;
        assert.equal(providerText === currentText ? providerText : JSON.parse(providerText).currentUserMessage, currentText);
        if (/^(?:confirmed|yes)\b/i.test(messages.at(-1).text)) {
          name = 'compile_draft'; args = { hookId: metadata.hookId ?? TASK_HOOK, sourceJson: metadata.missingDue ? source : '{', expectedDraftVersion: discovered.currentDraft.draftVersion };
        } else if (resumeRequest && currentText === resumeRequest) {
          assert.equal(discovered.currentProposal.source, source);
          assert.deepEqual(discovered.currentProposal.cases, cases);
          assert.ok(messages.some(message => message.role === 'assistant' && message.text === offerText));
          assert.equal(messages.at(-2).text, metadata.explanation);
          name = 'offer_review'; args = { summary: metadata.resumedOffer };
        } else text = metadata.explanation;
      }
    } else if (previous.name === 'compile_draft' && output.result.diagnostics) {
      assert.equal(output.result.diagnostics[0].code, 'SYNTAX_INVALID', 'The real compiler must reject the malformed candidate.');
      name = 'compile_draft'; args = { hookId: TASK_HOOK, sourceJson: source, expectedDraftVersion: previous.arguments.expectedDraftVersion };
    } else if (previous.name === 'compile_draft') {
      assert.equal(output.result.suiteDigest, null);
      name = 'propose_scenarios'; args = { revisionId: output.result.revisionId, cases, expectedDraftVersion: output.result.draftVersion };
    } else if (previous.name === 'propose_scenarios') {
      assert.notEqual(output.result.revisionId, previous.arguments.revisionId, 'Scenarios must create a new revision.');
      name = 'simulate_draft'; args = { revisionId: output.result.revisionId, expectedDraftVersion: output.result.draftVersion };
    } else if (previous.name === 'simulate_draft') {
      assert.equal(output.result.revisionId, previous.arguments.revisionId);
      assert.equal(output.result.draftVersion, previous.arguments.expectedDraftVersion);
      assert.ok(output.result.evidenceId);
      if (semanticMismatch) {
        const nonmatch = output.result.summary.cases.find(item => item.id === 'other-project');
        assert.deepEqual(nonmatch.expected.createdTasks, []);
        const wrong = history.calls.findLast(item => item.name === 'compile_draft').arguments.sourceJson !== source;
        assert.equal(nonmatch.actual.observed.effect, wrong ? 'NOT_OBSERVED' : 'NONE');
        assert.equal(nonmatch.status, wrong ? 'FAIL' : 'PASS');
        assert.equal(nonmatch.mismatches.length > 0, wrong);
        name = 'offer_review'; args = { summary: wrong ? mismatchText : offerText };
      } else { name = 'offer_review'; args = { summary: editing ? metadata.editedOfferText : offerText }; }
    } else throw new Error('The synthetic fixture supports one review journey per explicit turn.');
    const id = 'synthetic-call-' + (history.calls.length + 1);
    requests.push(Object.freeze({ callId: id, name: name ?? 'text' }));
    const raw = provider === 'openai'
      ? { status: 'completed', output: name ? [{ type: 'reasoning', id: 'reason-' + id, encrypted_content: 'synthetic-private-reasoning', summary: [] },
        { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }]
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 5 } }
      : { stop_reason: name ? 'tool_use' : 'end_turn', content: name ? [{ type: 'thinking', thinking: 'synthetic-private-reasoning', signature: 'synthetic-signature' },
        { type: 'tool_use', id, name, input: args }] : [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } };
    return new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } });
  };
}

async function unusedLoopbackPort() {
  const reservation = createServer();
  await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); });
  const port = reservation.address().port;
  await new Promise((done, reject) => reservation.close(error => error ? reject(error) : done()));
  return port;
}

// Synthetic offline transport only; app, compiler, lifecycle and simulator are real.
export async function startAuthoringFixture({ provider = 'openai', port, unconfigured = false, semanticMismatch = false, missingDue = false, resumeRequest, projectName, title = 'Review completed work', staticRoot = process.env.KEIR_TEST_STATIC_ROOT ?? fileURLToPath(new URL('../../dist/', import.meta.url)) } = {}) {
  assert.ok(['openai', 'anthropic'].includes(provider), 'Choose a supported synthetic protocol.');
  port ??= await unusedLoopbackPort();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Choose a loopback port between 1 and 65535.');
  const config = readAuthoringConfig(unconfigured ? {} : { KEIR_AI_PROVIDER: provider, KEIR_AI_MODEL: provider === 'openai' ? 'gpt-5.6-terra' : 'claude-haiku-5-5',
    // Ten offline OpenAI reservations total 3.19488 USD across the mismatch and explicit same-discussion repair.
    KEIR_AI_MAX_USD: missingDue ? '6' : semanticMismatch ? '3.2' : '3', OPENAI_API_KEY: 'synthetic-offline-key', ANTHROPIC_API_KEY: 'synthetic-offline-key' });
  assert.equal(config.status, unconfigured ? 'unavailable' : 'ready');
  const prefix = join(resolve(tmpdir()), 'keir-authoring-offline-');
  const directory = await mkdtemp(prefix), origin = `http://127.0.0.1:${port}`, requests = [];
  let app, db, release, closing;
  function close() {
    return closing ??= (async () => {
      try { await app?.close(); }
      finally {
        try { db?.close(); }
        finally {
          release?.();
          assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
          assert.ok(resolve(directory).startsWith(prefix), 'Only this fixture temporary directory may be removed.');
          await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
        }
      }
    })();
  }
  try {
    release = acquireDataLock(directory);
    db = openData(join(directory, 'app.sqlite'));
    const native = taskService(db), project = projectName ? native.createProject('maya', { name: projectName }) : native.listProjects('maya')[0];
    const other = native.createProject('maya', { name: 'Other project' });
    const host = missingDue ? loadHost('TaskCreated') : null;
    const options = { projectId: project.id, destinationProjectId: other.id, occurredAt: '2026-12-31T16:00:00.417Z' };
    const source = missingDue ? taskWorkflowSource(host, 'missing-due', options).toString() : null;
    const cases = missingDue ? taskWorkflowCases(host, 'missing-due', options) : null;
    const task = missingDue ? { cases, metadata: { synthetic: true, offline: true, missingDue, hookId: 'TaskCreated', projectId: project.id, otherProjectId: other.id, title,
      source, cases, editedSource: taskWorkflowSource(host, 'missing-due', { ...options, elapsedSeconds: 432000 }).toString(),
      editedCases: taskWorkflowCases(host, 'missing-due', { ...options, elapsedSeconds: 432000 }),
      editRequest: 'Confirmed: change the delay to 120 hours after addition, for tasks without a due date in every project.',
      editedOfferText: 'I checked the revised delay of 120 hours. The earlier version is still on. Your tasks have not changed.' } }
      : taskCustomizationFixture({ projectId: project.id, otherProjectId: other.id, title });
    const question = missingDue ? 'Should every new task without a due date get one 168 hours after addition, in every project?'
      : `Should completing a task in ${project.name} create ${task.metadata.title}, while other projects create nothing?`;
    const offerText = missingDue ? 'I checked four examples: two missing dates, an existing date and an unavailable task read. Your tasks have not changed.'
      : `I checked ${task.cases.length} example tasks. A completed task in ${project.name} creates ${task.metadata.title}; other projects create nothing. Your tasks have not changed. Review the saved changes when you are ready.`;
    const metadata = Object.freeze({ ...task.metadata, provider, question, offerText, mismatchText, projectName: project.name,
      otherProjectName: other.name, cases: Object.freeze(task.cases),
      explanation: resumeRequest ? 'The matching example created the follow-up task. The example from another project produced no task.' :
        'Your saved changes are kept. Review them when you are ready, or continue discussing the request.',
      resumedOffer: 'The earlier check passed and the change is ready to turn on.' });
    if (!missingDue) assert.notEqual(metadata.wrongSource, metadata.source, 'The semantic mismatch variant must change compiled behavior.');
    const compiler = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN });
    app = await createApp({ db, origin, staticRoot: resolve(staticRoot), compiler,
      authoringSettingsFile: join(directory, 'ai-authoring.json'), authoring: { config, fetchImpl: scriptedTransport(provider, metadata, requests, semanticMismatch, resumeRequest) } });
    await app.listen({ host: '127.0.0.1', port });
    return { app, db, origin, directory, metadata, requests, close };
  } catch (error) { await close(); throw error; }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const fixture = await startAuthoringFixture({ provider: process.argv[2] ?? 'openai' });
    console.log(`Synthetic OFFLINE authoring review fixture: ${fixture.origin}\nScripted transport; no real AI calls or provider compatibility qualification.`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      fixture.close().then(() => process.exit(0)).catch(() => { console.error('Synthetic fixture cleanup failed.'); process.exit(1); });
    });
  } catch { console.error('Synthetic offline authoring fixture could not start.'); process.exitCode = 1; }
}
