import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { openData, taskService, transaction } from '../src/data.mjs';
import { createLifecycle, sharedStudioCreationHash } from '../src/extension-lifecycle.mjs';
import { sharedCompletionDefinition } from '../src/extension-catalog.mjs';
import { createSharedCompletion } from '../src/shared-completion.mjs';
import { createTeamCapability } from '../src/team-capability.mjs';
import { teamProjectService } from '../src/team-native.mjs';
import { createTeamRuntime } from '../src/team-runtime.mjs';
import { CREATED_UPDATE_CHECK, sharedHost } from '../src/shared-completion-contract.mjs';
import { COMPOSED_MANIFEST } from '../src/shared-task-bundle.mjs';
import { beforeCreateOffer } from './fixtures/shared-before-create.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';
import { compileTaskCustomization } from './fixtures/task-customization.mjs';
import { completedUpdateRequest, composedOffer, createdUpdateOffer, createdUpdateRequest, exactCreateOffer, exactCreateRequest, exactLookupUpdateOffer,
  exactLookupUpdateRequest, exactReadOffer, exactReadRequest, ownedLookupUpdateOffer, ownedLookupUpdateRequest,
  ownedProjectOffer, sourceUpdateOffer, studioOffer, teamGateOffer } from './fixtures/shared-task-bundle.mjs';

const permit = () => {};
const lease = { sessionId: 'review-session', current: () => true };
const cel = value => ({ cel: value });
const occurredAt = '2026-03-07T16:00:00.417Z';
const discussion = 'What can this rule do on completion?';
const request = 'Offer a follow-up for work tagged for audit.';
const authoringConfig = { status: 'ready', provider: 'openai', model: 'fixture', reserveMicros: 10, maxMicros: 100 };

test('Personal Studio context is bounded, read-only and needs message consent through both strict providers', async t => {
  const actor = 'maya', db = openData(':memory:'), compiler = createCompiler(), tasks = taskService(db);
  const lifecycle = createLifecycle(db, { compiler });
  const capability = createTeamCapability(db, { compiler });
  t.after(async () => { await capability.close(); db.close(); });
  const project = (owner, name, mode = 'PERSONAL') => tasks.createProject(owner, { name, mode }).id;
  const owned = project(actor, 'Personal work'), foreign = project('leo', 'Foreign project'), team = project(actor, 'Team project', 'TEAM');
  const secret = 'Private witness text ' + '😀'.repeat(260);
  const task = await tasks.createTask(actor, { projectId: owned, title: 'Relevant task', notes: secret, tags: ['work'] }, { operationId: randomUUID() });
  const other = (owner, name) => admitTaskDraft(db, lifecycle, { owner, name }).extensionId;
  const legacy = other(actor, 'Earlier saved rule'), shared = other(actor, 'Shared saved rule'), foreignItem = other('leo', 'Foreign rule');
  const earlier = await compileTaskCustomization({ title: 'Earlier exact behavior' });
  const compiled = await lifecycle.compile(actor, { extensionId: legacy, hookId: 'TaskCompleted', source: earlier.source, draftVersion: 0 }, permit);
  const prepared = await lifecycle.proposeScenarios(actor, { extensionId: legacy, revisionId: compiled.revisionId,
    draftVersion: compiled.draftVersion, cases: earlier.cases }, permit);
  const legacyDraft = await lifecycle.simulate(actor, { extensionId: legacy, revisionId: prepared.revisionId, draftVersion: prepared.draftVersion }, permit);
  const definition = sharedHost('PERSONAL', CREATED_UPDATE_CHECK);
  const offer = createdUpdateOffer(owned, { ...JSON.parse(definition.dcmBytes), fingerprint: definition.pins.modelDigest });
  const confirm = (draftVersion, revisionId) => lifecycle.confirmTaskBundle(actor, { extensionId: shared, draftVersion, revisionId,
    selections: { TaskCreated: lifecycle.bundleSelection(actor).TaskCreated }, offer, format: COMPOSED_MANIFEST }, permit);
  const selected = await confirm(0, null);
  lifecycle.approve(actor, { extensionId: shared, ...selected }, permit);
  lifecycle.activateTaskBundle(actor, { extensionId: shared, ...selected, generations: { TaskCreated: 0 } }, permit);
  const newest = await confirm(selected.draftVersion, selected.revisionId);
  const unavailable = reason => ({ available: false, unavailableReason: reason });
  const search = (projectId, query, includeNotes) => ({ projectId, query, tag: '', after: '', includeNotes });
  const rows = () => ['tasks', 'extensions', 'extension_revisions', 'extension_evidence', 'extension_approvals', 'extension_selections']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  for (const provider of ['openai', 'anthropic']) {
    const openai = provider === 'openai', ajv = new Ajv(), config = readAuthoringConfig({ KEIR_AI_PROVIDER: provider, KEIR_AI_MAX_USD: '20',
      KEIR_AI_MODEL: openai ? 'gpt-5.6-terra' : 'claude-haiku-5-5', OPENAI_API_KEY: 'offline', ANTHROPIC_API_KEY: 'offline' });
    const id = randomUUID(), operationId = randomUUID(), target = `PERSONAL:${id}`;
    transaction(db, () => lifecycle.admit(actor, { extensionId: id, operationId, hash: sharedStudioCreationHash(operationId), name: 'Opened target' }, permit));
    const before = rows();
    let queue, cursor, failure, responseCount = 0, optedIn;
    const service = createAuthoringService({ db, lifecycle, teamCapability: capability, config, sharedCompletionCompiler: compiler,
      async fetchImpl(_url, { body }) {
        try {
          const wire = JSON.parse(body), last = (wire.input ?? wire.messages).at(-1);
          const part = openai ? last : last.content[0];
          if (cursor === 0) {
            const input = JSON.parse(openai ? last.content : part.text);
            assert.deepEqual(input.hostContext.target, { scope: 'PERSONAL', name: 'Opened target' });
            assert.equal(input.currentContext.taskNoteExcerptsEnabledForThisMessage, optedIn ? true : undefined);
            assert.doesNotMatch(JSON.stringify(input), /Earlier saved rule|Shared saved rule|Private witness text|Foreign rule/);
          } else {
            const { ok, result } = JSON.parse(part.output ?? part.content);
            assert.equal(ok, true);
            queue[cursor - 1][2](result);
            assert.doesNotMatch(JSON.stringify(result), /"(trace|artifact|source|providerKey|nativeContinuation)":/);
          }
          const call = queue[cursor++], usage = { input_tokens: 30, output_tokens: 4 };
          responseCount++;
          if (!call) return Response.json(openai ? { status: 'completed', output: [{ type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: 'Read saved context. No changes made.' }] }], usage }
            : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Read saved context. No changes made.' }], usage });
          const [name, args] = call;
          const tool = wire.tools.find(tool => tool.name === name);
          assert.equal(tool.strict, true);
          assert.equal(ajv.compile(tool.parameters ?? tool.input_schema)(args), true);
          const callId = `context-${responseCount}`;
          return Response.json(openai
            ? { status: 'completed', output: [{ type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) }], usage }
            : { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: callId, name, input: args }], usage });
        } catch (cause) { failure = cause; throw cause; }
      } });
    try {
      const api = service.sharedCompletion;
      const inspect = (extensionId, verify) => ['inspect_customization', { extensionId }, verify];
      const find = (projectId, query, notes, verify) => ['search_tasks', search(projectId, query, notes), verify];
      const withheld = reason => result => assert.deepEqual(result, unavailable(reason));
      const run = async (expectedVersion, calls, includeTaskNotes) => {
        queue = calls; cursor = 0; optedIn = includeTaskNotes === true;
        const input = { operationId: randomUUID(), expectedVersion, expectedDraftVersion: 0, text: 'Read relevant context.',
          ...(includeTaskNotes !== undefined && { includeTaskNotes }) };
        await api.turn(actor, target, input, lease);
        const { conversation } = await api.wait(actor, target, lease);
        if (failure) throw failure;
        assert.equal(cursor, calls.length + 1);
        assert.equal(conversation.status, 'IDLE', JSON.stringify(conversation));
        assert.equal(conversation.offer, null);
        return input;
      };
      await run(0, [
        ['discover_customizations', { before: '' }, result => {
          const ids = result.items.map(item => item.extensionId);
          assert.ok(ids.includes(legacy) && ids.includes(shared));
          assert.ok(!ids.includes(id) && !ids.includes(foreignItem));
        }],
        inspect(legacy, result => {
          assert.equal(result.draft.revisionId, legacyDraft.revisionId);
          assert.equal(result.draft.behavior.action.fields.title.value, 'Earlier exact behavior');
          assert.equal(result.draft.check.passed, true);
        }),
        inspect(shared, result => {
          assert.equal(result.draft.revisionId, newest.revisionId);
          assert.deepEqual(result.draft.behavior.stageHooks, ['TaskCreated']);
          assert.equal(result.draft.check.passed, true);
          assert.deepEqual(result.draft.check.summary.TaskCreated.map(example => example.branch), ['UPDATED', 'UNCHANGED', 'SKIPPED']);
          assert.equal(result.draft.approval.approved, false);
          assert.equal(result.currentUse.selected.revisionId, selected.revisionId);
          assert.equal(result.currentUse.check.evidenceId, selected.evidenceId);
        }),
        inspect(foreignItem, withheld('CUSTOMIZATION_UNAVAILABLE')),
        inspect(team, withheld('CUSTOMIZATION_UNAVAILABLE')),
      ]);
      await run(1, [
        find(owned, 'Relevant', 'no', result => {
          assert.equal(result.items[0].id, task.id);
          assert.equal(result.items[0].hasNotes, true);
          assert.equal(Object.hasOwn(result.items[0], 'notesExcerpt'), false);
        }),
        find(owned, 'Private witness', 'no', result => assert.deepEqual(result.items, [])),
        find(owned, 'Relevant', 'yes', withheld('TASK_NOTES_NOT_ENABLED')),
      ]);
      const consent = await run(2, [
        find(owned, 'Private witness', 'yes', result => {
          assert.equal(result.items[0].notesExcerpt, Array.from(secret).slice(0, 256).join(''));
          assert.equal(result.items[0].notesTruncated, true);
        }),
        find(foreign, '', 'yes', withheld('TASKS_UNAVAILABLE')),
        find(team, '', 'yes', withheld('TASKS_UNAVAILABLE')),
      ], true);
      const priorCalls = responseCount;
      await api.turn(actor, target, consent, lease);
      await assert.rejects(api.turn(actor, target, { ...consent, includeTaskNotes: false }, lease), { status: 409 });
      await assert.rejects(api.turn(actor, `TEAM:${team}`, consent, lease), { status: 400 });
      assert.equal(responseCount, priorCalls);
      await run(3, [find(owned, 'Relevant', 'yes', withheld('TASK_NOTES_NOT_ENABLED'))]);
      assert.deepEqual(rows(), before);
    } finally { await service.close(); }
  }
});

function setup(t, scope) {
  const db = openData(':memory:'), actual = createCompiler(), team = scope === 'TEAM';
  let compiled = 0, called = 0, mode = 'normal', loseReply = false, service, providerFailure, beforeCompilerReply, compilerResult;
  const compiler = { async compile(...args) {
    compiled++;
    const result = compilerResult = await actual.compile(...args);
    return beforeCompilerReply?.(result) ?? result;
  } };
  const lifecycle = createLifecycle(db, { compiler }), capability = createTeamCapability(db, { compiler });
  const shared = createSharedCompletion({ db, lifecycle, teamCapability: capability });
  const runtime = createTeamRuntime({ db, sharedCompletion: shared });
  const tasks = taskService(db, { team: runtime, sharedCompletion: shared });
  const projectId = tasks.createProject('maya', { name: 'Synthetic audit', mode: scope }).id;
   const extensionId = randomUUID(), operationId = randomUUID();
   transaction(db, () => lifecycle.admit('maya', { extensionId, operationId, hash: sharedStudioCreationHash(operationId), name: 'Audit' }, permit));
  const target = `${scope}:${team ? projectId : extensionId}`;
  if (team) teamProjectService(db).addMember('maya', projectId, { userId: 'leo' });
  const make = () => service = createAuthoringService({ db, lifecycle, teamCapability: capability, sharedCompletionCompiler: compiler,
    config: authoringConfig, checkpointFault({ phase }) { if (phase === 'SHARED_CONFIRM' && loseReply) throw new Error('Synthetic lost Confirm reply'); },
    providerFactory: () => ({ reserveMicros: 10, maxMicros: 100, async complete(input) {
      try {
      called++;
       const repair = input.toolResult && JSON.parse(input.toolResult.output);
       if (repair) assert.deepEqual(repair.diagnostics, [{ code: mode === 'invalid' ? 'BINDING_DID_NOT_COMPILE' : 'UNSUPPORTED_DESCRIPTION',
         path: '/bindings/TaskCompleted' }]);
       const message = repair ? JSON.parse(input.continuation) : JSON.parse(input.input);
       const { model } = message.currentContext;
      assert.equal(message.hostContext.target.scope, scope);
      assert.deepEqual(Object.keys(model.entrypoints), ['TaskCompleted']);
       assert.deepEqual(Object.keys(model.capabilities).sort(), ['tasks.create', 'tasks.get', 'tasks.openMatch', 'tasks.update']);
      assert.equal(Object.hasOwn(model.capabilities['tasks.create'].parameters, 'assigneeId'), team);
       assert.deepEqual(input.tools.map(tool => tool.name), repair ? ['offer_proposal'] : ['ask_clarification',
          ...(!team ? ['discover_projects', 'find_personal_tasks', 'discover_customizations', 'inspect_customization', 'search_tasks'] : []), 'offer_proposal']);
       const reply = { text: 'I can create a follow-up after completion.', usage: { inputTokens: 4, outputTokens: 4 }, estimatedMicros: 2,
         continuation: input.input };
      if (message.currentUserMessage === discussion) return { ...reply, calls: [], continuation: 'not-for-a-later-turn' };
      assert.deepEqual(message.transcript.messages.map(row => row.role), ['user', 'assistant']);
      assert.equal(message.transcript.messages[0].text, discussion);
      const source = { language: 'keir/3', name: 'audit-follow-up', domain: { ...model.domain, fingerprint: model.fingerprint },
        entrypoint: 'TaskCompleted', steps: [
          { id: 'task', call: 'tasks.get', args: { taskId: cel('input.taskId') } },
          { id: 'applies', let: cel('"for audit" in task.tags') },
          { id: 'followup', call: 'tasks.create', when: 'applies', args: {
            projectId: cel('task.projectId'), title: cel('task.title + " audit"'),
            dueAt: cel('input.occurredAt + duration("604800s")'),
            ...(team && { parentTaskId: cel('input.taskId'), assigneeId: { literal: 'leo', type: 'UserId' } }),
          } },
        ], return: { record: { status: cel('applies ? "CREATED" : "NO_OP"') } } };
      if (mode === 'invalid') source.name = 'Compiler rejects this';
      if (mode === 'unrepresentable') source.steps[1].let.cel += ' || task.title == "Different branch"';
      if (mode === 'private-assignee') source.steps[2].args.assigneeId.literal = 'sam';
      if (['no-effect', 'extra-read', 'read-expression'].includes(mode)) {
        source.steps.splice(1);
        source.return.record.status = { literal: 'NO_OP' };
        if (mode === 'extra-read') source.steps.push(
          { id: 'extra', let: cel('task.title == "Unseen task"') },
          { id: 'other', call: 'tasks.get', when: 'extra', args: { taskId: { literal: 'not-present', type: 'TaskId' } } }
        );
        if (mode === 'read-expression') source.steps.push({ id: 'dynamic', let: cel('task.title + " copy"') });
      }
      const cases = [
        { id: 'match', title: 'Ledger', tags: ['for audit'], occurredAt, priority: 'normal', openTitles: [],
          expect: { title: mode === 'failed' ? 'Wrong' : 'Ledger audit', dueAt: '2026-03-14T16:00:00.417Z',
            linked: team, assigneeId: team ? 'leo' : null, project: 'SAME_PROJECT', notes: '', tags: [], priority: 'normal' } },
        { id: 'miss', title: 'Ledger', tags: ['for audits'], occurredAt, priority: 'normal', openTitles: [], expect: null },
      ];
      if (mode === 'ineligible') cases.shift();
      if (['no-effect', 'extra-read', 'read-expression'].includes(mode)) cases.shift();
        return { ...reply, calls: [{ id: repair ? 'repair' : 'offer', name: 'offer_proposal', arguments: studioOffer(composedOffer({
         bindings: { TaskBeforeComplete: null, TaskBeforeCreate: null, TaskCreated: null, TaskCompleted: JSON.stringify(source) }, cases,
        }, projectId)) }] };
      } catch (error) { providerFailure = error; throw error; }
    } }),
  });
  make();
  t.after(async () => { await service.close(); await runtime.close(); await capability.close(); db.close(); });
  async function offer(setMode = 'normal') {
    mode = setMode;
    const agent = service.sharedCompletion;
    for (const [expectedVersion, text] of [discussion, request].entries()) {
      await agent.turn('maya', target, { operationId: randomUUID(), expectedVersion, expectedDraftVersion: 0, text }, lease);
      await agent.wait('maya', target, lease);
    }
    const conversation = agent.read('maya', target, lease).conversation;
    if (providerFailure) throw providerFailure;
     const rejected = ['invalid', 'unrepresentable', 'extra-read', 'read-expression'].includes(mode);
     assert.equal(conversation.status, rejected ? 'BLOCKED' : 'AWAITING_USER', JSON.stringify({ conversation,
       dispatches: db.prepare('SELECT kind,outcome FROM authoring_dispatches WHERE run_id=? ORDER BY ordinal').all(conversation.runId) }));
     if (rejected) assert.equal(conversation.code, 'SHARED_OFFER_INVALID');
    return { runId: conversation.runId, expectedVersion: conversation.version, offerDigest: conversation.offer?.digest };
  }
  return { db, lifecycle, capability, runtime, tasks, shared, projectId, extensionId, target, offer,
    service: () => service, counters: () => ({ compiled, called }), loseReply: () => { loseReply = true; },
    beforeCompilerReply: fn => { beforeCompilerReply = fn; }, compilerResult: () => compilerResult,
    restart: async () => { await service.close(); make(); },
    create: (actor, title) => tasks.createTask(actor, { title, projectId, tags: ['for audit'] }, { operationId: randomUUID() }),
    event: task => db.prepare('SELECT * FROM shared_completion_events WHERE source_id=?').get(task.id),
  };
}

test('Shared Studio repairs malformed programs once through both strict providers without inventing a hook', async t => {
  const db = openData(':memory:'), actual = createCompiler();
  let compiles = 0;
  const compiler = { async compile(...args) { compiles++; return actual.compile(...args); } };
  const lifecycle = createLifecycle(db, { compiler }), capability = createTeamCapability(db, { compiler });
  t.after(async () => { await capability.close(); db.close(); });
  for (const provider of ['openai', 'anthropic']) {
    const openai = provider === 'openai';
    const projectId = taskService(db).createProject('maya', { name: 'Gauge checks', mode: 'TEAM' }).id;
    teamProjectService(db).addMember('maya', projectId, { userId: 'leo' });
    const config = readAuthoringConfig({ KEIR_AI_PROVIDER: provider, KEIR_AI_MAX_USD: '10',
      KEIR_AI_MODEL: openai ? 'gpt-5.6-terra' : 'claude-haiku-5-5', OPENAI_API_KEY: 'offline', ANTHROPIC_API_KEY: 'offline' });
    let valid, exact, invalid, calls = 0, failure, repeat, missingWitness;
    const service = createAuthoringService({ db, lifecycle, teamCapability: capability, sharedCompletionCompiler: compiler, config,
      async fetchImpl(_url, { body }) {
        try {
          const wire = JSON.parse(body), user = (wire.input ?? wire.messages).at(-1);
          const tool = wire.tools.find(item => item.name === 'offer_proposal');
          const validate = new Ajv().compile(tool.parameters ?? tool.input_schema);
          const repair = calls++ % 2 === 1;
          if (!repair) {
            const { currentContext: ctx } = JSON.parse(openai ? user.content : user.content[0].text);
            valid = teamGateOffer(projectId, { TaskBeforeCreate: ctx.beforeCreateModel, TaskBeforeComplete: ctx.beforeCompleteModel,
              TaskCreated: ctx.createdModel, TaskCompleted: ctx.model }, true);
            for (const hook of ['TaskCreated', 'TaskBeforeComplete'])
              valid.bindings[hook] = valid.bindings[hook].replaceAll('\\"receipt\\"', '\\"gauge reading\\"');
            for (const examples of [valid.cases.TaskCreated, valid.cases.TaskBeforeComplete]) for (const example of examples) {
              example.tags = example.tags.map(tag => tag === 'receipt' ? 'gauge reading' : tag === 'receipts' ? 'gauge readings' : tag);
              if (example.title === 'Check receipt') example.title = 'Calibrate shelf gauge';
            }
            const created = JSON.parse(valid.bindings.TaskCreated);
            const fields = created.steps.at(-1).args;
            fields.title.literal = 'Calibrate shelf gauge';
            fields.dueAt.cel = 'input.occurredAt + duration("10800s")';
            valid.bindings.TaskCreated = JSON.stringify(created);
            Object.assign(valid.cases.TaskCreated[0].expect, { title: fields.title.literal,
              dueAt: new Date(Date.parse(valid.cases.TaskCreated[0].occurredAt) + 10_800_000).toISOString() });
            exact = valid;
            valid = studioOffer(exact);
            invalid = structuredClone(valid);
            // A previously accepted schema shape and the second capture's nested call mistake.
            if (missingWitness) invalid.cases.TaskBeforeComplete.pop();
            else if (repeat) invalid.bindings.TaskBeforeComplete = 'beforeCompleteModel';
            else invalid.bindings.TaskCreated.steps[0].call = { capability: 'tasks.get', arguments: {} };
          } else {
            assert.deepEqual(wire.tools.map(item => item.name), ['offer_proposal']);
            const result = JSON.parse(openai ? user.output : user.content[0].content);
            assert.deepEqual({ ...result, next: undefined }, {
              ok: false, saved: false, code: 'INVALID_TOOL_ARGUMENTS', remainingAttempts: 1, next: undefined,
              diagnostics: missingWitness ? [{ code: 'TAG_WITNESSES_REQUIRED', path: '/cases/TaskBeforeComplete' }]
                : [{ code: 'INVALID_OFFER_SHAPE', path: repeat ? '/bindings/TaskBeforeComplete' : '/bindings/TaskCreated/steps/0' }],
            });
          }
          const args = repair && !repeat ? valid : invalid;
          assert.equal(tool.strict, true);
          assert.equal(validate(args), missingWitness || args === valid, JSON.stringify(validate.errors));
          if (args === valid) {
            const withId = structuredClone(valid);
            withId.cases.TaskBeforeComplete.forEach(example => { example.id = 'same-task'; });
            assert.equal(validate(withId), false);
          }
          const name = tool.name, id = `offer-${calls}`;
          return Response.json({ usage: { input_tokens: 20, output_tokens: 4 }, ...(openai
            ? { status: 'completed', output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }] }
            : { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: args }] }) });
        } catch (error) { failure = error; throw error; }
      }, });
    try {
      const api = service.sharedCompletion, target = `TEAM:${projectId}`, before = compiles;
      const send = async expectedVersion => {
        await api.turn('maya', target, { operationId: randomUUID(), expectedVersion, expectedDraftVersion: 0,
          text: 'When a task tagged exactly gauge reading is saved, create Calibrate shelf gauge for Leo due three elapsed hours later. Keep the original open until its own check is complete.' }, lease);
        const { conversation } = await api.wait('maya', target, lease);
        if (failure) throw failure;
        return conversation;
      };
      const offer = await send(0);
      assert.equal(offer.canConfirm, true);
      assert.deepEqual(offer.offer.stageHooks, ['TaskCreated', 'TaskBeforeComplete']);
      assert.match(JSON.stringify(offer.offer), /Calibrate shelf gauge/);
      assert.equal(calls, 2);
      assert.equal(compiles, before + 2, 'Only the corrected offer reaches the compiler.');
      const offerRow = db.prepare('SELECT view FROM authoring_conversations WHERE run_id=?').get(offer.runId);
      const lowered = JSON.parse(offerRow.view).proposal.offer;
      for (const hook of offer.offer.stageHooks) {
        assert.deepEqual(JSON.parse(lowered.bindings[hook]), JSON.parse(exact.bindings[hook]));
        assert.deepEqual(lowered.cases[hook], exact.cases[hook].map(({ id, ...example }, index) => ({ ...example, id: `example-${index + 1}` })));
      }
      repeat = true;
      const rejected = await send(1);
      assert.equal(calls, 4);
      assert.equal(compiles, before + 2);
      assert.equal(rejected.status, 'BLOCKED');
      assert.equal(rejected.code, 'SHARED_OFFER_INVALID');
      assert.equal(rejected.offer, null);
      assert.equal(rejected.canConfirm, false);
      assert.doesNotMatch(JSON.stringify(rejected), /INVALID_OFFER_SHAPE|beforeCompleteModel/);
      const saved = db.prepare('SELECT state,view FROM authoring_conversations WHERE run_id=?').get(rejected.runId);
      assert.doesNotMatch(JSON.stringify(saved), /beforeCompleteModel|completionUpdateModel/);
      assert.equal(db.prepare('SELECT revision_id FROM team_drafts WHERE project_id=?').get(projectId).revision_id, null);
      repeat = false;
      missingWitness = true;
      const corrected = await send(2);
      const result = await api.confirm('maya', target, {
        runId: corrected.runId, expectedVersion: corrected.version, offerDigest: corrected.offer.digest,
      }, lease);
      assert.equal(result.conversation.confirmation?.eligible, true);
      assert.equal(calls, 6, 'Confirm does not make another provider call.');
      assert.equal(db.prepare('SELECT revision_id FROM team_selections WHERE project_id=?').get(projectId).revision_id, null);
    } finally { await service.close(); }
  }
});

test('Team decisions, source updates and Personal owned-project offers fit both strict provider schemas', async t => {
  const db = openData(':memory:'), compiler = createCompiler();
  const lifecycle = createLifecycle(db, { compiler }), capability = createTeamCapability(db, { compiler });
  t.after(async () => { await capability.close(); db.close(); });
  for (const provider of ['openai', 'anthropic']) {
    const openai = provider === 'openai', ajv = new Ajv({ allErrors: true });
    const tasks = taskService(db);
    const projectId = tasks.createProject('maya', { name: 'Synthetic intake', mode: 'TEAM' }).id;
    teamProjectService(db).addMember('maya', projectId, { userId: 'leo' });
    const make = owner => tasks.createProject(owner, { name: 'Accounts' }).id;
    const source = make('maya'), destination = make('maya'), foreign = make('leo');
    const { id: referenceId, title: referenceTitle } = await tasks.createTask('maya', { projectId: destination,
      title: 'Exact reference', notes: 'Not sent to the assistant.' }, { operationId: randomUUID() });
    const extensionId = randomUUID(), operationId = randomUUID();
    transaction(db, () => lifecycle.admit('maya', { extensionId, operationId, hash: sharedStudioCreationHash(operationId), name: 'Route' }, permit));
    const config = readAuthoringConfig({ KEIR_AI_PROVIDER: provider, KEIR_AI_MAX_USD: '10',
      KEIR_AI_MODEL: openai ? 'gpt-5.6-terra' : 'claude-haiku-5-5', OPENAI_API_KEY: 'offline', ANTHROPIC_API_KEY: 'offline' });
    let wireFailure, calls = 0;
    const service = createAuthoringService({ db, lifecycle, teamCapability: capability, sharedCompletionCompiler: compiler, config,
      async fetchImpl(_url, { body }) {
        try {
          const wire = JSON.parse(body), tool = wire.tools.find(tool => tool.name === 'offer_proposal');
          const user = (wire.input ?? wire.messages).at(-1);
          const { currentContext: ctx, currentUserMessage } = JSON.parse(openai ? user.content : user.content[0].text);
          const owned = currentUserMessage.startsWith('Owned ');
          const ownedHook = ['TaskCreated', 'TaskCompleted'].find(hook => currentUserMessage.startsWith(ownedLookupUpdateRequest(hook)));
          const exactHook = ['TaskCreated', 'TaskCompleted', 'TaskBeforeCreate'].find(hook => currentUserMessage === exactReadRequest(hook));
          const createHook = ['TaskCreated', 'TaskCompleted'].find(hook => currentUserMessage === exactCreateRequest(hook));
          const lookupUpdateHook = ['TaskCreated', 'TaskCompleted'].find(hook => currentUserMessage === exactLookupUpdateRequest(hook));
          const completedUpdate = [completedUpdateRequest(), `Personal: ${completedUpdateRequest()}`].includes(currentUserMessage);
          const personalScope = owned || ownedHook || exactHook || createHook || lookupUpdateHook || currentUserMessage.startsWith('Personal: ');
          assert.equal(wire.tools.some(tool => tool.name === 'discover_projects'), !!personalScope);
          assert.equal(wire.tools.some(tool => tool.name === 'find_personal_tasks'), !!personalScope);
          const wrongLookup = currentUserMessage === 'Owned foreign lookup', wrongDestination = currentUserMessage === 'Owned Team destination';
          const updateLookup = currentUserMessage.endsWith('Foreign lookup.') ? foreign
            : currentUserMessage.endsWith('Team lookup.') ? projectId : destination;
          const reference = { id: referenceId, title: referenceTitle, projectId: destination };
           const args = studioOffer(lookupUpdateHook ? exactLookupUpdateOffer(source, destination, ctx.exactTaskLookupUpdateModels[lookupUpdateHook], lookupUpdateHook, reference)
            : createHook ? exactCreateOffer(ctx.exactTaskCreateModels[createHook], createHook, source, destination, reference, destination)
            : exactHook ? exactReadOffer(source, reference,
            exactHook === 'TaskBeforeCreate' ? ctx.ownedBeforeCreateModel : ctx.exactTaskUpdateModels[exactHook], exactHook, destination)
            : ownedHook ? ownedLookupUpdateOffer(source, updateLookup, ctx.ownedProjectUpdateModels[ownedHook], ownedHook)
            : owned ? ownedProjectOffer(ctx.ownedProjectModels.TaskCompleted, 'TaskCompleted', source,
            wrongDestination ? projectId : destination, wrongLookup ? foreign : destination)
            : currentUserMessage === 'Before save'
             ? composedOffer(beforeCreateOffer(ctx.beforeCreateModel, projectId), projectId)
             : currentUserMessage === createdUpdateRequest ? createdUpdateOffer(projectId, ctx.createdModel)
             : completedUpdate ? sourceUpdateOffer(personalScope ? source : projectId, ctx.completionUpdateModel, 'TaskCompleted')
            : teamGateOffer(projectId, { TaskBeforeCreate: ctx.beforeCreateModel, TaskBeforeComplete: ctx.beforeCompleteModel,
               TaskCreated: ctx.createdModel, TaskCompleted: ctx.model }, currentUserMessage === 'Linked gate'));
          assert.equal(tool.strict, true);
          const validate = ajv.compile(tool.parameters ?? tool.input_schema);
          assert.equal(validate(args), true, `${provider}: ${ajv.errorsText(validate.errors)}`);
          const hook = lookupUpdateHook ?? createHook ?? exactHook ?? ownedHook ?? (owned || completedUpdate ? 'TaskCompleted' : currentUserMessage === 'Before save' ? 'TaskBeforeCreate'
            : currentUserMessage === createdUpdateRequest ? 'TaskCreated' : 'TaskBeforeComplete');
          const wrong = structuredClone(args);
          if (owned) {
            assert.ok(ctx.beforeCreateProjects.some(p => p.id === destination));
            assert.ok(ctx.beforeCreateProjects.every(p => p.id !== foreign && p.id !== projectId));
            delete wrong.cases[hook][0].expect.project;
          } else if (!personalScope) {
            assert.equal(ctx.ownedProjectModels, undefined);
            assert.equal(ctx.ownedProjectUpdateModels, undefined);
            assert.equal(ctx.ownedBeforeCreateModel, undefined);
            assert.equal(ctx.exactTaskUpdateModels, undefined);
            assert.equal(ctx.exactTaskCreateModels, undefined);
            assert.equal(ctx.exactTaskLookupUpdateModels, undefined);
          }
          if (exactHook || createHook || lookupUpdateHook) delete wrong.cases[hook][0].referenceTasks[0].dueAt;
           else if (hook === 'TaskCreated' || completedUpdate || ownedHook) delete wrong.cases[hook][0].expect.sourceAfter.dueAt;
          else if (hook === 'TaskBeforeCreate') delete wrong.cases[hook][0].openTitles;
          else if (!owned) wrong.cases[hook][0].openTitles = [];
          assert.equal(validate(wrong), false, `${provider}: invalid ${hook} example`);
          calls++;
          const name = tool.name, id = `offer-${calls}`;
          return Response.json({ usage: { input_tokens: 20, output_tokens: 4 }, ...(openai
            ? { status: 'completed', output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }] }
            : { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: args }] }) });
        } catch (error) { wireFailure = error; throw error; }
      } });
    try {
      const api = service.sharedCompletion, target = `TEAM:${projectId}`;
      for (const [expectedVersion, [text, hooks]] of [
        ['Field gate', ['TaskBeforeComplete']],
        ['Linked gate', ['TaskCreated', 'TaskBeforeComplete']],
        ['Before save', ['TaskBeforeCreate']],
         [createdUpdateRequest, ['TaskCreated']],
         [completedUpdateRequest(), ['TaskCompleted']],
      ].entries()) {
        await api.turn('maya', target, { operationId: randomUUID(), expectedVersion, expectedDraftVersion: 0, text }, lease);
        const { conversation } = await api.wait('maya', target, lease);
        if (wireFailure) throw wireFailure;
        assert.equal(conversation.canConfirm, true, JSON.stringify(conversation.messages.at(-1)));
         assert.deepEqual(conversation.offer.stageHooks, hooks);
         if (text === completedUpdateRequest()) assert.equal(conversation.offer.stages[0].completedUpdate, true);
      }
      const personal = `PERSONAL:${extensionId}`;
      for (const [expectedVersion, text] of ['Owned create', 'Owned foreign lookup', 'Owned Team destination', `Personal: ${completedUpdateRequest()}`,
        ownedLookupUpdateRequest('TaskCreated'), ownedLookupUpdateRequest('TaskCompleted'),
        `${ownedLookupUpdateRequest('TaskCreated')} Foreign lookup.`, `${ownedLookupUpdateRequest('TaskCompleted')} Team lookup.`].entries()) {
        await api.turn('maya', personal, { operationId: randomUUID(), expectedVersion, expectedDraftVersion: 0, text }, lease);
        const { conversation } = await api.wait('maya', personal, lease);
        if (wireFailure) throw wireFailure;
        assert.equal(conversation.canConfirm, expectedVersion === 0 || expectedVersion >= 3 && expectedVersion <= 5, JSON.stringify(conversation.messages.at(-1)));
        if (expectedVersion === 0) {
          assert.deepEqual(conversation.offer.stageHooks, ['TaskCompleted']);
          assert.deepEqual(conversation.offer.stages[0].destination, { name: 'Accounts', ref: destination });
        } else if (expectedVersion === 3) {
           assert.deepEqual(conversation.offer.stageHooks, ['TaskCompleted']);
          assert.equal(conversation.offer.stages[0].completedUpdate, true);
        } else if (expectedVersion === 4 || expectedVersion === 5) {
          assert.deepEqual(conversation.offer.stageHooks, [expectedVersion === 4 ? 'TaskCreated' : 'TaskCompleted']);
          assert.deepEqual(conversation.offer.stages[0].conditions.find(c => c.field === 'openMatch').lookupProject,
            { name: 'Accounts', ref: destination });
         } else {
          assert.equal(conversation.offer, null);
          assert.doesNotMatch(JSON.stringify(conversation), new RegExp(`${foreign}|${projectId}`));
        }
      }
      for (const [request, hook] of [[exactReadRequest, 'TaskCreated'], [exactReadRequest, 'TaskCompleted'], [exactReadRequest, 'TaskBeforeCreate'],
        [exactCreateRequest, 'TaskCreated'], [exactCreateRequest, 'TaskCompleted'],
        [exactLookupUpdateRequest, 'TaskCreated'], [exactLookupUpdateRequest, 'TaskCompleted']]) {
        const exactId = randomUUID(), operationId = randomUUID(), target = `PERSONAL:${exactId}`;
        transaction(db, () => lifecycle.admit('maya', { extensionId: exactId, operationId, hash: sharedStudioCreationHash(operationId), name: 'Exact' }, permit));
        await api.turn('maya', target, { operationId: randomUUID(), expectedVersion: 0, expectedDraftVersion: 0, text: request(hook) }, lease);
        const { conversation } = await api.wait('maya', target, lease);
        if (wireFailure) throw wireFailure;
        assert.equal(conversation.canConfirm, true, JSON.stringify(conversation.messages.at(-1)));
        const stage = conversation.offer.stages[0];
        assert.deepEqual(conversation.offer.stageHooks, [hook]);
        assert.equal((stage.guard ?? stage).conditions.find(c => c.taskId)?.taskId, referenceId);
        if (request === exactCreateRequest) assert.equal(stage.destination.ref, destination);
        if (request === exactLookupUpdateRequest) {
          assert.equal(stage.conditions.find(c => c.field === 'noOpenMatch').lookupProject.ref, destination);
          assert.equal(stage.sourcePriority, 'high');
          assert.equal(stage.title, null);
        }
      }
      assert.equal(calls, 20);
      assert.equal(capability.state('maya', projectId).draftVersion, 0);
    } finally { await service.close(); }
  }
});

test('Personal Studio pages owned projects before resolving a duplicate name through both strict wrappers', async t => {
  const db = openData(':memory:'), compiler = createCompiler();
  const lifecycle = createLifecycle(db, { compiler }), tasks = taskService(db), actor = 'maya';
  t.after(() => db.close());
  const make = (owner, name, createdAt, mode = 'PERSONAL') => {
    const { id } = tasks.createProject(owner, { name, mode });
    db.prepare('UPDATE projects SET created_at=? WHERE id=?').run(createdAt, id);
    return id;
  };
  const source = make(actor, 'Source', '2070-01-03T00:00:00.000Z');
  const first = make(actor, 'Accounts', '2070-01-02T00:00:00.000Z');
  for (let i = 0; i < 18; i++) make(actor, `Filler ${i}`, '2070-01-01T00:00:00.000Z');
  const destination = make(actor, 'Accounts', '2069-12-31T00:00:00.000Z');
  const foreign = make('leo', 'Accounts', '2070-01-04T00:00:00.000Z');
  const team = make(actor, 'Accounts', '2070-01-04T00:00:00.000Z', 'TEAM');
  const question = 'Two Personal projects are named Accounts. Which one should receive the follow-up?';
  const reference = await tasks.createTask(actor, { projectId: destination, title: 'Travel receipt', notes: 'Private witness text' },
    { operationId: randomUUID() });
  for (const provider of ['openai', 'anthropic']) {
    const openai = provider === 'openai', ajv = new Ajv();
    const extensionId = randomUUID(), operationId = randomUUID(), target = `PERSONAL:${extensionId}`;
    transaction(db, () => lifecycle.admit(actor, { extensionId, operationId, hash: sharedStudioCreationHash(operationId), name: 'Route' }, permit));
    const config = readAuthoringConfig({ KEIR_AI_PROVIDER: provider, KEIR_AI_MAX_USD: '10',
      KEIR_AI_MODEL: openai ? 'gpt-5.6-terra' : 'claude-haiku-5-5', OPENAI_API_KEY: 'offline', ANTHROPIC_API_KEY: 'offline' });
    let wireFailure, context, requestText, calls = 0, taskPages = 0;
    const service = createAuthoringService({ db, lifecycle, sharedCompletionCompiler: compiler, config,
      async fetchImpl(_url, { body }) {
        try {
          const wire = JSON.parse(body), last = (wire.input ?? wire.messages).at(-1);
          const part = openai ? last : last.content[0];
          let name, args;
          if (part.type === 'function_call_output' || part.type === 'tool_result') {
            const { ok, result } = JSON.parse(part.output ?? part.content);
            assert.equal(ok, true);
            if (requestText === 'Find the exact receipt.') {
              taskPages++;
              if (taskPages === 1) {
                assert.equal(result.available, true);
                assert.deepEqual(result.items.map(task => task.id), [reference.id]);
                assert.doesNotMatch(JSON.stringify(result), /Private witness text|notesExcerpt/);
              } else {
                assert.deepEqual(result, { available: false, unavailableReason: 'TASKS_UNAVAILABLE' });
              }
              name = taskPages === 3 ? 'ask_clarification' : 'find_personal_tasks';
              args = taskPages === 3 ? { question: 'Which authorized task should I use?' }
                : { projectId: taskPages === 1 ? foreign : team, query: '', after: '' };
            } else {
            assert.equal(result.next, null);
            const projects = [...context.beforeCreateProjects, ...result.projects];
            assert.deepEqual(projects.filter(p => p.name === 'Accounts').map(p => p.id), [first, destination]);
            assert.ok(projects.every(p => p.id !== foreign && p.id !== team));
            if (requestText === 'Send the follow-up to Accounts.') {
              name = 'ask_clarification';
              args = { question };
            } else {
              name = 'offer_proposal';
              const chosen = projects.find(p => p.id === requestText);
              assert.equal(chosen.id, destination);
               args = studioOffer(ownedProjectOffer(context.ownedProjectModels.TaskCompleted, 'TaskCompleted', source, chosen.id));
            }
            }
          } else {
            const input = JSON.parse(openai ? last.content : part.text);
            context = input.currentContext;
            requestText = input.currentUserMessage;
            assert.equal(context.beforeCreateProjects.length, 20);
            assert.ok(context.beforeCreateProjects.some(p => p.id === first));
            assert.ok(context.beforeCreateProjects.every(p => ![destination, foreign, team].includes(p.id)));
            assert.equal(typeof context.beforeCreateProjectsNext, 'string');
            assert.match(wire.instructions ?? wire.system, /A partial list cannot show that a name is missing or unique/);
            name = requestText === 'Find the exact receipt.' ? 'find_personal_tasks' : 'discover_projects';
            args = name === 'discover_projects' ? { before: context.beforeCreateProjectsNext }
              : { projectId: destination, query: 'Travel receipt', after: '' };
          }
          const tool = wire.tools.find(tool => tool.name === name);
          assert.equal(tool.strict, true);
          const validate = ajv.compile(tool.parameters ?? tool.input_schema);
          assert.equal(validate(args), true, ajv.errorsText(validate.errors));
          const id = `call-${++calls}`;
          return Response.json({ usage: { input_tokens: 20, output_tokens: 4 }, ...(openai
            ? { status: 'completed', output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }] }
            : { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: args }] }) });
        } catch (error) { wireFailure = error; throw error; }
      } });
    try {
      const api = service.sharedCompletion;
      for (const [expectedVersion, text] of ['Send the follow-up to Accounts.', destination, 'Find the exact receipt.'].entries()) {
        await api.turn(actor, target, { operationId: randomUUID(), expectedVersion, expectedDraftVersion: 0, text }, lease);
        const { conversation } = await api.wait(actor, target, lease);
        if (wireFailure) throw wireFailure;
        assert.equal(conversation.canConfirm, expectedVersion === 1);
        if (expectedVersion === 0) assert.equal(conversation.messages.at(-1).text, question);
        else if (expectedVersion === 1) assert.deepEqual(conversation.offer.stages[0].destination, { name: 'Accounts', ref: destination });
      }
      assert.equal(calls, 8);
      assert.equal(taskPages, 3);
      assert.equal(lifecycle.state(actor, extensionId).draftVersion, 0);
    } finally { await service.close(); }
  }
});

test('preflight withholds invalid source and does not expose unauthorized teammate identities', async t => {
  const invalid = setup(t, 'PERSONAL'), restricted = setup(t, 'TEAM');
  for (const [f, mode] of [[invalid, 'invalid'], [restricted, 'private-assignee']]) {
    const input = await f.offer(mode);
    const conversation = f.service().sharedCompletion.read('maya', f.target, lease).conversation;
    assert.equal(input.offerDigest, undefined);
    assert.equal(conversation.canConfirm, false);
    assert.doesNotMatch(JSON.stringify(conversation), /"sam"|Sam|Compiler rejects this|TaskCompleted/);
    assert.equal(f.db.prepare('SELECT (SELECT count(*) FROM extension_revisions)+(SELECT count(*) FROM team_revisions) n').get().n, 0);
    assert.equal(f.counters().compiled, mode === 'invalid' ? 2 : 1);
  }
});

test('read-only completion is described as no task change and checks without claiming creation', async t => {
  const f = setup(t, 'PERSONAL'), input = await f.offer('no-effect'), agent = f.service().sharedCompletion;
   const offer = agent.read('maya', f.target, lease).conversation.offer.stages[0];
  assert.equal(offer.title, null);
  assert.equal(offer.readsCompletedTask, true);
  const result = (await agent.confirm('maya', f.target, input, lease)).conversation.confirmation;
  assert.equal(result.status, 'CHECKED');
  assert.equal(result.eligible, true);
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope} NO_OP cannot conceal a guarded read or an unaccounted expression`, async t => {
  for (const mode of ['extra-read', 'read-expression']) {
    const f = setup(t, scope), input = await f.offer(mode), agent = f.service().sharedCompletion;
    const conversation = agent.read('maya', f.target, lease).conversation;
    assert.equal(conversation.offer, null);
    assert.equal(conversation.canConfirm, false);
    assert.equal(conversation.code, 'SHARED_OFFER_INVALID');
    await assert.rejects(agent.confirm('maya', f.target, { ...input, offerDigest: 'sha256:' + '0'.repeat(64) }, lease), { status: 409 });
    assert.equal(f.counters().compiled, 2);
    assert.ok(f.compilerResult().artifact, JSON.stringify(f.compilerResult().diagnostics));
  }
});

test('Confirm does not save if the compiler reply changes the artifact after the offer was reviewed', async t => {
  const f = setup(t, 'TEAM'), input = await f.offer(), agent = f.service().sharedCompletion;
  const row = f.db.prepare("SELECT view FROM authoring_conversations WHERE json_extract(state,'$.targetKey')=?").get(f.target);
  const source = JSON.parse(row.view).proposal.offer.bindings.TaskCompleted.replace('audit-follow-up', 'different-name');
  const wrong = await createCompiler().compile(Buffer.from(source), { definition: sharedCompletionDefinition('TEAM') });
  assert.ok(wrong.artifact);
  f.beforeCompilerReply(() => wrong);
  const result = (await agent.confirm('maya', f.target, input, lease)).conversation.confirmation;
  assert.equal(result.status, 'UNSAVED');
  assert.equal(f.capability.state('maya', f.projectId).draftVersion, 0);
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope} discussion → exact offer → Confirm → separate activation → native effect`, async t => {
  const f = setup(t, scope), team = scope === 'TEAM', actor = team ? 'leo' : 'maya';
  const { db, lifecycle, capability, tasks, shared, projectId, extensionId, target } = f;
  const count = table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  const selection = () => team ? capability.state('maya', projectId).selection : lifecycle.state('maya', extensionId).selection;
  const before = selection(), siblings = db.prepare("SELECT * FROM extension_selections WHERE hook_id!='TaskCompleted'").all();
  const input = await f.offer();
  const service = f.service(), api = service.sharedCompletion, conversation = api.read('maya', target, lease).conversation;
  assert.equal(conversation.offer.target, target);
  assert.equal(conversation.confirmation, null);
  assert.deepEqual(conversation.messages.map(row => row.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(count(team ? 'team_revisions' : 'extension_revisions'), 0);
  assert.deepEqual(f.counters(), { compiled: 1, called: 2 });
  assert.deepEqual(service.allowance(), { estimatedMicros: 4, heldMicros: 0 });
  await assert.rejects(api.confirm('maya', target, { ...input, expectedVersion: 1 }, lease), { status: 409 });
  await assert.rejects(api.confirm('maya', target, { ...input, offerDigest: 'sha256:' + '0'.repeat(64) }, lease), { status: 409 });
  await assert.rejects(api.confirm('maya', target, input, { ...lease, sessionId: 'other-session' }), { status: 409 });
  await assert.rejects(api.confirm('maya', `${team ? 'PERSONAL' : 'TEAM'}:${team ? extensionId : projectId}`, input, lease), { status: team ? 409 : 404 });
  await assert.rejects(api.confirm('leo', target, input, lease), { status: team ? 403 : 404 });
  f.loseReply();
  await assert.rejects(api.confirm('maya', target, input, lease), /lost Confirm reply/);
  await f.restart();
  const current = f.service().sharedCompletion, record = current.read('maya', target, lease).conversation;
  const result = record.confirmation;
  assert.deepEqual(Object.keys(result).sort(), ['draftVersion', 'eligible', 'evidenceId', 'passed', 'revisionId', 'status']);
  assert.equal(result.status, 'CHECKED');
  assert.equal(result.passed, true);
  assert.equal(result.eligible, true);
  assert.equal(result.draftVersion, 1);
  assert.equal(record.offer, null);
  assert.deepEqual((await current.confirm('maya', target, input, lease)).conversation, record);
  assert.deepEqual(record.messages.at(-1).receipt, { offerDigest: input.offerDigest, ...result });
  assert.deepEqual(f.counters(), { compiled: 2, called: 2 });
  assert.equal(count(team ? 'team_revisions' : 'extension_revisions'), 1);
  assert.deepEqual(selection(), before);
  assert.deepEqual(f.service().allowance(), { estimatedMicros: 4, heldMicros: 0 });
  const pre = await f.create(actor, 'Not on yet');
  await tasks.completeTask(actor, pre.id);
  assert.equal(f.event(pre), undefined);
   const { revisionId, draftVersion } = result;
   await current.decide('maya', target, lease, 'approve', current.review('maya', target, lease).token);
   assert.deepEqual(selection(), before);
   await current.decide('maya', target, lease, 'activate', current.review('maya', target, lease).token);
  const source = await f.create(actor, 'Month-end');
  await tasks.completeTask(actor, source.id);
  assert.equal(await shared.run(f.event(source).id), true);
  const receipt = shared.status(actor, source.id).receipt;
  assert.equal(receipt.effect, 'CONFIRMED');
  const task = tasks.getTask(actor, receipt.value.id);
  assert.equal(task.title, 'Month-end audit');
  assert.equal(task.parentTaskId ?? null, team ? source.id : null);
  assert.deepEqual(db.prepare("SELECT * FROM extension_selections WHERE hook_id!='TaskCompleted'").all(), siblings);
  await current.turn('maya', target, { operationId: randomUUID(), expectedVersion: record.version,
    expectedDraftVersion: draftVersion, text: discussion }, lease);
  const history = (await current.wait('maya', target, lease)).conversation;
  assert.equal(history.confirmation, null);
  assert.deepEqual(history.messages.find(row => row.id === `${input.runId}-confirm`).receipt, { offerDigest: input.offerDigest, ...result });
  assert.deepEqual(f.counters(), { compiled: 2, called: 3 });
});

for (const [scope, mode, expected] of [['PERSONAL', 'failed', 'CHECK_FAILED'], ['TEAM', 'normal', 'SAVED_UNCHECKED'],
  ['PERSONAL', 'unsaved', 'UNSAVED'], ['TEAM', 'ineligible', 'CHECKED']]) test(`${scope} Confirm reports ${expected} without retry`, async t => {
  const f = setup(t, scope), input = await f.offer(mode);
  if (mode === 'unsaved') f.beforeCompilerReply(() => { throw new Error('Synthetic compile failure'); });
  if (expected === 'SAVED_UNCHECKED') f.db.exec(`CREATE TEMP TRIGGER unavailable_check BEFORE INSERT ON team_evidence
    BEGIN SELECT RAISE(ABORT,'Synthetic check storage unavailable'); END`);
  const get = () => f.service().sharedCompletion;
  const result = (await get().confirm('maya', f.target, input, lease)).conversation.confirmation;
  assert.equal(result.status, expected);
  assert.equal(result.passed, mode === 'ineligible' ? true : mode === 'failed' ? false : null);
  assert.equal(result.eligible, ['ineligible', 'failed'].includes(mode) ? false : null);
  assert.equal(Boolean(result.revisionId), mode !== 'unsaved');
  assert.equal(Boolean(result.evidenceId), ['ineligible', 'failed'].includes(mode));
  await f.restart();
  assert.deepEqual((await get().confirm('maya', f.target, input, lease)).conversation.confirmation, result);
  assert.deepEqual(f.counters(), { called: 2, compiled: 2 });
});

test('Confirm fences generation before dispatch and rechecks current actor authority after compilation', async t => {
  const f = setup(t, 'TEAM'), input = await f.offer(), agent = f.service().sharedCompletion;
  const bump = generation => f.db.prepare('UPDATE team_selections SET generation=? WHERE project_id=?').run(generation, f.projectId);
  bump(1);
  await assert.rejects(agent.confirm('maya', f.target, input, lease), { status: 409 });
  assert.equal(f.counters().compiled, 1);
  // Restore the isolated fixture so the same offer can demonstrate the in-flight lease fence.
  bump(0);
  let current = true;
  const activeLease = { ...lease, current: () => current };
  f.beforeCompilerReply(() => { current = false; });
  await assert.rejects(agent.confirm('maya', f.target, input, activeLease), { code: 'STALE_CONTEXT' });
  const result = agent.read('maya', f.target, lease).conversation.confirmation;
  assert.equal(result.status, 'UNSAVED');
  assert.equal(f.capability.state('maya', f.projectId).draftVersion, 0);
  assert.deepEqual((await agent.confirm('maya', f.target, input, lease)).conversation.confirmation, result);
  assert.equal(f.counters().compiled, 2);
});

test('unavailable terminal write reports UNKNOWN until restart reads the exact journal, never retries', async t => {
  const f = setup(t, 'PERSONAL'), input = await f.offer('unsaved');
  f.beforeCompilerReply(() => { throw new Error('Synthetic compile failure'); });
  f.db.exec(`CREATE TEMP TRIGGER lose_completion_terminal BEFORE UPDATE OF status ON authoring_conversations
    WHEN NEW.status='BLOCKED' BEGIN SELECT RAISE(ABORT,'Synthetic terminal write unavailable'); END`);
  const current = () => f.service().sharedCompletion;
  await assert.rejects(current().confirm('maya', f.target, input, lease), /terminal write unavailable/);
  const read = current().read('maya', f.target, lease).conversation.confirmation;
  assert.equal(read.status, 'UNKNOWN');
  assert.deepEqual((await current().confirm('maya', f.target, input, lease)).conversation.confirmation, read);
  f.db.exec('DROP TRIGGER lose_completion_terminal');
  await f.restart();
  assert.equal(current().read('maya', f.target, lease).conversation.confirmation.status, 'UNSAVED');
  assert.deepEqual(f.counters(), { compiled: 2, called: 2 });
});

for (const scope of ['PERSONAL', 'TEAM']) {
  test(`${scope}: exact tag is described, but the same examples cannot stand in for an OR branch`, async t => {
    const valid = setup(t, scope), invalid = setup(t, scope);
    const exact = await valid.offer(), blocked = await invalid.offer('unrepresentable');
    const api = invalid.service().sharedCompletion;
    const read = api.read('maya', invalid.target, lease).conversation;
    assert.ok(exact.offerDigest);
    assert.equal(blocked.offerDigest, undefined);
    assert.equal(read.canConfirm, false);
     assert.equal(read.code, 'SHARED_OFFER_INVALID');
    await assert.rejects(api.confirm('maya', invalid.target, { ...blocked, offerDigest: exact.offerDigest }, lease), { status: 409 });
    assert.equal(invalid.db.prepare(`SELECT count(*) n FROM ${scope === 'TEAM' ? 'team_revisions' : 'extension_revisions'}`).get().n, 0);
  });
}
