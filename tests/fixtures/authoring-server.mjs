import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireDataLock, openData } from '../../src/data.mjs';
import { createApp } from '../../src/app.mjs';
import { createCompiler } from '../../src/compiler.mjs';
import { loadHost } from '../../src/extension-catalog.mjs';
import { readAuthoringConfig } from '../../src/authoring-config.mjs';
import { simulationCases } from '../../src/extension-lifecycle.mjs';

const question = 'Should OPEN tasks show PENDING and COMPLETED tasks show DONE?';
const offerText = 'Review the new source and five independent scenarios. Other inputs are untested. Approval and Use remain your choice.';
const mismatchText = 'The completed example wanted Done but showed Pending. This did not pass. Keep the original expectations and explicitly ask to correct the source here.';

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

function scriptedTransport(provider, source, cases, requests, semanticMismatch) {
  return async (url, init) => {
    assert.equal(url, provider === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://api.anthropic.com/v1/messages');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body), history = nativeHistory(provider, body);
    assert.equal(body.tools.some(tool => /approve|activate|select/.test(tool.name)), false);
    assert.equal(history.reasoning.length, history.calls.length, 'Native reasoning must survive continuation.');
    for (const output of history.outputs) assert.ok(history.calls.some(call => call.id === output.id), 'Tool results retain their native call IDs.');
    const previous = history.calls.at(-1);
    const output = history.outputs.findLast(item => item.id === previous?.id)?.value;
    let name, args;
    if (!previous) { name = 'discover_catalog'; args = {}; }
    else if (previous.name === 'discover_catalog' && semanticMismatch) {
      const discovered = output.result;
      const wrongSource = source.replace('completed ? "DONE" : "PENDING"', 'completed ? "PENDING" : "PENDING"');
      const repairing = discovered.currentProposal?.source === wrongSource;
      if (repairing) {
        assert.deepEqual(discovered.currentProposal.cases, cases, 'Repair keeps the original independent scenarios.');
        assert.ok(discovered.conversationContext.messages.some(message => message.role === 'assistant' && message.text === mismatchText),
          'The same discussion retains the failed review before an explicit correction.');
        assert.equal(discovered.conversationContext.messages.at(-1).role, 'user');
        assert.match(discovered.conversationContext.messages.at(-1).text, /correct/i);
        assert.match(JSON.stringify(history.users.at(-1).content), /correct/i, 'Only an explicit correction starts the repair.');
      }
      name = 'compile_draft'; args = { sourceJson: repairing ? source : wrongSource, expectedDraftVersion: discovered.currentDraft.draftVersion };
    }
    else if (previous.name === 'discover_catalog') {
      const discovered = output.result, messages = discovered.conversationContext.messages;
      const asked = messages.findLastIndex(message => message.role === 'assistant' && message.text === question);
      if (asked < 0) { name = 'ask_clarification'; args = { question }; }
      else {
        assert.equal(history.users.length, 1, 'An explicit turn uses a fresh native chain.');
        assert.ok(asked < messages.length - 1, 'The saved question precedes the explicit answer.');
        assert.equal(messages.at(-1).role, 'user');
        assert.match(messages.at(-1).text, /^(?:Confirmed: OPEN means PENDING and COMPLETED means DONE\.|Yes, keep the independent examples and show me Done for completed tasks\.)/,
          'Only the latest explicit human answer authorizes the fixture to compile.');
        const input = history.users[0].content;
        assert.equal(provider === 'openai' ? input : input.find(part => part.type === 'text').text, messages.at(-1).text);
        name = 'compile_draft'; args = { sourceJson: '{', expectedDraftVersion: discovered.currentDraft.draftVersion };
      }
    } else if (previous.name === 'compile_draft' && output.result.diagnostics) {
      assert.equal(output.result.diagnostics[0].code, 'SYNTAX_INVALID', 'The real compiler must reject the malformed candidate.');
      name = 'compile_draft'; args = { sourceJson: source, expectedDraftVersion: previous.arguments.expectedDraftVersion };
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
        const completed = output.result.summary.cases.find(item => item.id === 'synthetic-completed');
        assert.equal(completed.expected.code, 'DONE');
        const wrong = history.calls.findLast(item => item.name === 'compile_draft').arguments.sourceJson !== source;
        assert.equal(completed.actual.consumption.code, wrong ? 'PENDING' : 'DONE');
        assert.equal(completed.status, wrong ? 'MISMATCH' : 'PASS');
        assert.equal(completed.mismatches.length > 0, wrong);
        name = 'offer_review'; args = { summary: wrong ? mismatchText : offerText };
      } else { name = 'offer_review'; args = { summary: offerText }; }
    } else throw new Error('The synthetic fixture supports one review journey per explicit turn.');
    const id = 'synthetic-call-' + (history.calls.length + 1);
    requests.push(Object.freeze({ callId: id, name }));
    const raw = provider === 'openai'
      ? { status: 'completed', output: [{ type: 'reasoning', id: 'reason-' + id, encrypted_content: 'synthetic-private-reasoning', summary: [] },
        { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }], usage: { input_tokens: 10, output_tokens: 5 } }
      : { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'synthetic-private-reasoning', signature: 'synthetic-signature' },
        { type: 'tool_use', id, name, input: args }], usage: { input_tokens: 10, output_tokens: 5 } };
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
export async function startAuthoringFixture({ provider = 'openai', port, unconfigured = false, semanticMismatch = false, staticRoot = process.env.KEIR_TEST_STATIC_ROOT ?? fileURLToPath(new URL('../../dist/', import.meta.url)) } = {}) {
  assert.ok(['openai', 'anthropic'].includes(provider), 'Choose a supported synthetic protocol.');
  port ??= await unusedLoopbackPort();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Choose a loopback port between 1 and 65535.');
  const source = (await readFile(new URL('../../extensions/task-read/maya.yaml', import.meta.url), 'utf8'))
    .replace('name: maya-task-advice', 'name: synthetic-offline-task-advice');
  // Expectations are fixed independently of compiler/simulator observations.
  const cases = ['OPEN', 'COMPLETED'].map(status => {
    const code = status === 'OPEN' ? 'PENDING' : 'DONE';
    const call = { step: 'source', capability: 'tasks.get', version: '1', args: { taskId: 'synthetic-task' } };
    return '\n' + JSON.stringify({ format: 'keir-read-simulation/1', id: 'synthetic-' + status.toLowerCase(), input: { taskId: 'synthetic-task' },
      stubs: [{ ...call, response: { kind: 'SUCCESS', value: { id: 'synthetic-task', status } } }],
      expect: { calls: [call], outcome: { classification: 'COMPLETED', result: { classification: code } }, consumption: { status: 'DISPLAYED', code } } }, null, 2) + '\n';
  });
  cases.push(...simulationCases('pending').filter(item => ['missing', 'business-denied', 'transient'].includes(item.id)).map(item => item.bytes.toString('utf8')));
  const metadata = Object.freeze({ synthetic: true, offline: true, compatibility: 'unqualified', provider, question, offerText, mismatchText, source,
    wrongSource: source.replace('completed ? "DONE" : "PENDING"', 'completed ? "PENDING" : "PENDING"'), cases: Object.freeze(cases) });
  assert.notEqual(metadata.wrongSource, source, 'The semantic mismatch variant must change compiled behavior.');
  const config = readAuthoringConfig(unconfigured ? {} : { KEIR_AI_PROVIDER: provider, KEIR_AI_MODEL: provider === 'openai' ? 'gpt-5.6-terra' : 'claude-haiku-5-5',
    // Ten offline OpenAI reservations total 3.19488 USD across the mismatch and explicit same-discussion repair.
    KEIR_AI_MAX_USD: semanticMismatch ? '3.2' : '3', OPENAI_API_KEY: 'synthetic-offline-key', ANTHROPIC_API_KEY: 'synthetic-offline-key' });
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
    const compiler = createCompiler({ modelBytes: loadHost().dcmBytes, javaExecutable: process.env.KEIR_JAVA_BIN });
    app = await createApp({ db, origin, staticRoot: resolve(staticRoot), compiler,
      authoringSettingsFile: join(directory, 'ai-authoring.json'), authoring: { config, fetchImpl: scriptedTransport(provider, source, cases, requests, semanticMismatch) } });
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
