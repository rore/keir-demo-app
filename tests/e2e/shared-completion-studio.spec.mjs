import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../../src/app.mjs';
import { createCompiler } from '../../src/compiler.mjs';
import { readAuthoringConfig } from '../../src/authoring-config.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { openData, taskService } from '../../src/data.mjs';
import { teamProjectService } from '../../src/team-native.mjs';
import { installTeamRevision } from '../../src/team-runtime.mjs';
import { seedTaskEffectBinding } from '../fixtures/task-effect-schema.mjs';
import { admitTaskDraft, seedEarlierTeamDiscussion } from '../fixtures/task-authoring.mjs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { handoffArgs, handoffExpected } from '../fixtures/shared-creation.mjs';
import { beforeCreateOffer, correction, guardRequest } from '../fixtures/shared-before-create.mjs';
import { authoredTaskBundle, bundleRequest, completedUpdateRequest, composedOffer, createdUpdateOffer, createdUpdateRequest, exactCreateOffer, exactCreateRequest,
  exactLookupUpdateOffer, exactLookupUpdateRequest, exactReadOffer, exactReadRequest, fieldGateRequest, linkedGateRequest,
  ownedLookupUpdateOffer, ownedLookupUpdateRequest, ownedProjectOffer, ownedProjectRequest, ownedProjectTitle, ownedUpdateTitle,
  sourceUpdateOffer, studioOffer, teamGateOffer } from '../fixtures/shared-task-bundle.mjs';

const occurredAt = '2026-03-07T16:00:00.417Z';
const cel = value => ({ cel: value });
const handoffRequest = team => 'After completion, create a high priority handoff in the same project with notes and two tags.'
  + (team ? ' Link it to the completed task and assign it to Leo.' : '');
const lookupRequest = 'Create a Dispatch audit unless “Dispatch  audit” is already open here.';
const lookupTitle = 'Dispatch  audit', createdTitle = 'Dispatch audit';
const nearTitles = [createdTitle, 'A\u0000B', 'A⟦U+0000⟧B'];
const priorityRequest = 'When I complete a task tagged urgent, set its priority to high and change nothing else.';
const sourceDueInstant = '2026-03-08T10:30:09.417Z';
const sourceDueRequest = clear => `When a low-priority Return samples task is completed, ${clear ? 'clear its due date' : `set its due date to ${sourceDueInstant}`}.`;
const tagGuard = ['samples\u200B', 'samples⟦u+200b⟧'];
const tagInput = [...tagGuard, 'intake'];
const addTagRequest = `When a low-priority task tagged ${tagGuard.join(' and ')} is completed with no due date, add café.`;
const exactProjectGuard = 'Require intake notes for undated normal tasks in the first Café project only.';
const cafeNames = ['Caf\u00e9', 'Cafe\u0301'];
const afterSaveOnly = 'After saving a receipt, add a check. Leave completion alone.';
const guardAndCompletion = 'Require notes before saving and archive receipt tasks after completion. Do nothing just after saving.';
const negatedTagRequest = 'Before saving, block the task if the exact reference does not have the ready tag.';
const contextRequest = 'Check context from my exact reference.';
async function fixture({ lost = false, loseWrite = false, dueMismatch = false, intake = false, providerOff = false, db = openData(':memory:') } = {}) {
  const team = taskService(db).createProject('maya', { name: 'Fulfillment Team', mode: 'TEAM' });
  const intakeProjects = intake ? [...cafeNames, cafeNames[0]].map((name, i) =>
    taskService(db).createProject(i < 2 ? 'maya' : 'leo', { name, mode: 'PERSONAL' }).id) : [];
  const exactReference = intake && await taskService(db).createTask('maya', { projectId: intakeProjects[1], title: 'Exact reference' },
    { operationId: randomUUID() });
  teamProjectService(db).addMember('maya', team.id, { userId: 'leo' });
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const compiler = createCompiler(), requests = [];
  let compilations = 0, writes = 0, hold, awaiting;
  const app = await createApp({ db, origin, sharedCompletionWriteReply(receipt) {
    writes++;
    if (typeof loseWrite === 'function' ? loseWrite(receipt) : loseWrite) throw new Error('Synthetic lost native write reply');
    return receipt;
  }, compiler: {
    async compile(...args) {
      compilations++;
      if (hold) {
        const release = hold; hold = null;
        awaiting = true;
        await release;
      }
      return compiler.compile(...args);
    },
  }, authoring: {
    config: providerOff ? readAuthoringConfig({}) : { status: 'ready', provider: 'openai', model: 'fixture', reserveMicros: 10, maxMicros: 1000 },
    checkpointFault({ phase }) { if (lost && phase === 'SHARED_CONFIRM') throw new Error('Synthetic lost response'); },
     providerFactory: () => ({ reserveMicros: 10, maxMicros: 1000, async complete(input) {
       const usage = { inputTokens: 20, outputTokens: 4 };
       if (input.toolResult?.id === 'note-context') {
         const { result } = JSON.parse(input.toolResult.output);
         return { text: result.items?.[0]?.notesExcerpt ? 'One permitted note excerpt was read.' : 'No note excerpts were read.', usage, calls: [] };
       }
       const user = JSON.parse(input.input);
       const { model, beforeCreateModel, beforeCreateProjects, createdModel, beforeCompleteModel, priorOffer, currentRule } = user.currentContext;
       const teamScope = user.hostContext.target.scope === 'TEAM';
       const projectId = beforeCreateProjects[0].id;
      requests.push(user);
      assert.equal(input.continuation, undefined);
      assert.equal(input.toolResult, undefined);
       if (user.currentUserMessage === contextRequest)
         return { text: '', usage, calls: [{ id: 'note-context', name: 'search_tasks',
           arguments: { projectId: exactReference.projectId, query: exactReference.title, tag: '', after: '', includeNotes: 'yes' } }] };
       const edited = user.currentUserMessage === 'Use the same behavior, but title the new task Queue check.';
      const handoff = user.currentUserMessage === handoffRequest(teamScope);
      const lookup = user.currentUserMessage === lookupRequest;
      const update = user.currentUserMessage === priorityRequest;
      const clearDue = user.currentUserMessage === sourceDueRequest(true);
      const changeDue = clearDue || user.currentUserMessage === sourceDueRequest(false);
      const addTag = user.currentUserMessage === addTagRequest;
      const offer = addTag || changeDue || update || lookup || handoff || edited || user.currentUserMessage === 'Propose a follow-up.';
        const text = { text: `Reply to ${user.currentUserMessage}`, usage: { inputTokens: 20, outputTokens: 4 }, estimatedMicros: 2 };
        const propose = offer => ({ ...text, calls: [{ id: 'offer', name: 'offer_proposal', arguments: studioOffer(offer) }] });
       const lookupUpdateHook = ['TaskCreated', 'TaskCompleted'].find(hook => user.currentUserMessage === exactLookupUpdateRequest(hook));
       if (lookupUpdateHook) {
         const { id, title, projectId } = exactReference;
          return propose(exactLookupUpdateOffer(intakeProjects[0], intakeProjects[1],
            user.currentContext.exactTaskLookupUpdateModels[lookupUpdateHook], lookupUpdateHook, { id, title, projectId }));
       }
       const createHook = ['TaskCreated', 'TaskCompleted'].find(hook => user.currentUserMessage === exactCreateRequest(hook));
       if (createHook) {
         const { id, title, projectId } = exactReference;
          return propose(exactCreateOffer(
            user.currentContext.exactTaskCreateModels[createHook], createHook, intakeProjects[0], projectId, { id, title, projectId }, intakeProjects[0]));
       }
       if (user.currentUserMessage === negatedTagRequest) {
         const { id, title, projectId } = exactReference;
         const offer = exactReadOffer(intakeProjects[0], { id, title, projectId }, user.currentContext.ownedBeforeCreateModel, 'TaskBeforeCreate');
         const rule = JSON.parse(offer.bindings.TaskBeforeCreate);
         rule.steps.at(-1).let.cel = '!("ready" in reference.tags)';
         offer.bindings.TaskBeforeCreate = JSON.stringify(rule);
         const [missing, present] = offer.cases.TaskBeforeCreate;
         present.referenceTasks[0].priority = missing.referenceTasks[0].priority;
         present.referenceTasks[0].tags = ['ready'];
          return propose(offer);
       }
       const exactHook = ['TaskCreated', 'TaskCompleted', 'TaskBeforeCreate'].find(hook => user.currentUserMessage === exactReadRequest(hook));
       if (exactHook) {
         const { id, title, projectId } = exactReference;
         const ctx = user.currentContext;
          return propose(exactReadOffer(intakeProjects[0], { id, title, projectId },
            exactHook === 'TaskBeforeCreate' ? ctx.ownedBeforeCreateModel : ctx.exactTaskUpdateModels[exactHook], exactHook, projectId));
       }
       const ownedUpdateHook = ['TaskCreated', 'TaskCompleted'].find(hook => user.currentUserMessage === ownedLookupUpdateRequest(hook));
       if (ownedUpdateHook)
          return propose(ownedLookupUpdateOffer(intakeProjects[0], intakeProjects[1], user.currentContext.ownedProjectUpdateModels[ownedUpdateHook], ownedUpdateHook));
       if (user.currentUserMessage === ownedProjectRequest)
          return propose(ownedProjectOffer(user.currentContext.ownedProjectModels.TaskCompleted, 'TaskCompleted', intakeProjects[0], intakeProjects[1]));
       if (user.currentUserMessage === createdUpdateRequest)
          return propose(createdUpdateOffer(projectId, createdModel));
       const completionDue = teamScope ? sourceDueInstant : null;
       if (user.currentUserMessage === completedUpdateRequest(completionDue))
          return propose(sourceUpdateOffer(projectId, user.currentContext.completionUpdateModel, 'TaskCompleted', completionDue));
       if ([fieldGateRequest, linkedGateRequest].includes(user.currentUserMessage))
          return propose(teamGateOffer(projectId,
            { TaskBeforeCreate: beforeCreateModel, TaskCreated: createdModel, TaskCompleted: model, TaskBeforeComplete: beforeCompleteModel },
            user.currentUserMessage === linkedGateRequest));
       if ([afterSaveOnly, guardAndCompletion].includes(user.currentUserMessage)) {
         const offer = authoredTaskBundle(projectId, { TaskBeforeCreate: beforeCreateModel, TaskCreated: createdModel, TaskCompleted: model });
         if (user.currentUserMessage === afterSaveOnly) {
           offer.bindings.TaskBeforeCreate = offer.bindings.TaskCompleted = null;
         } else offer.bindings.TaskCreated = null;
          return propose(composedOffer(offer, projectId));
       }
       if (user.currentUserMessage === bundleRequest) {
         const offer = authoredTaskBundle(beforeCreateProjects[0].id,
           { TaskBeforeCreate: beforeCreateModel, TaskCreated: createdModel, TaskCompleted: model });
         const created = JSON.parse(offer.bindings.TaskCreated);
         const args = created.steps.at(-1).args;
         Object.assign(args, { title: cel('source.title + " check"'), dueAt: cel('input.occurredAt + duration("90s")'),
           priority: cel('source.priority'), tagsText: { literal: 'receipt-check, handoff-ready' },
           ...(teamScope && { parentTaskId: cel('input.taskId'), assigneeId: { literal: 'leo', type: 'UserId' } }) });
         created.steps.splice(1, 0, { id: 'lookup', call: 'tasks.openMatch',
           args: { projectId: cel('source.projectId'), title: { literal: 'Already checked' } } });
         created.steps[2].let.cel += ' && !lookup.matches';
         offer.bindings.TaskCreated = JSON.stringify(created);
         const hit = offer.cases.TaskCreated[0];
         hit.priority = 'high';
         Object.assign(hit.expect, { title: 'File the receipt check', dueAt: '2026-05-10T12:01:30.417Z', priority: 'high',
           tags: ['receipt-check', 'handoff-ready'], linked: teamScope, assigneeId: teamScope ? 'leo' : null });
         offer.cases.TaskCreated[1] = { ...hit, id: 'already-open', openTitles: ['Already checked'], expect: null };
         const completed = JSON.parse(offer.bindings.TaskCompleted);
         completed.steps.at(-1).args.dueAt = cel('input.occurredAt + duration("120s")');
         offer.bindings.TaskCompleted = JSON.stringify(completed);
         offer.cases.TaskCompleted[0].expect.dueAt = '2026-05-10T12:02:00.417Z';
          return propose(composedOffer(offer, projectId));
       }
        if (user.currentUserMessage === guardRequest) return propose(composedOffer(beforeCreateOffer(beforeCreateModel, projectId), projectId));
       if (user.currentUserMessage === exactProjectGuard) {
         const [first, second] = intakeProjects;
         const args = beforeCreateOffer(beforeCreateModel, first);
         const source = JSON.parse(args.bindings.TaskBeforeCreate);
         source.steps[0].let.cel += ' && input.projectId == chosenProject';
         source.steps.unshift({ id: 'chosenProject', let: { literal: first, type: 'ProjectId' } });
         args.bindings.TaskBeforeCreate = JSON.stringify(source);
         Object.assign(args.cases[1], { projectId: second, hasNotes: false });
          return propose(composedOffer(args, projectId));
       }
      if (!offer) return { ...text, calls: [], continuation: 'only-for-this-turn' };
      if (edited) {
         assert.equal(priorOffer.stages[0].conditions[0].value, teamScope ? 'Dispatch' : 'Archive');
         if (currentRule) assert.equal(currentRule.stages[0].title.value, 'Initial check');
      }
      const existingTitle = teamScope ? 'Dispatch' : 'Archive';
      const tags = teamScope ? ['ready'] : ['review'];
      const title = edited ? 'Queue check' : 'Initial check';
      const steps = [
        { id: 'source', call: 'tasks.get', args: { taskId: cel('input.taskId') } },
        { id: 'matches', let: cel(`source.title == "${existingTitle}" && "${tags[0]}" in source.tags`) },
        { id: 'followup', call: 'tasks.create', when: 'matches', args: { projectId: cel('source.projectId'), title: { literal: title },
          dueAt: cel(`input.occurredAt + duration("${teamScope ? 172800 : 3600}s")`),
          ...(teamScope && { parentTaskId: cel('input.taskId'), assigneeId: { literal: 'leo', type: 'UserId' } }),
        } },
      ];
      const source = { language: 'keir/3', name: 'completion-queue', domain: { ...model.domain, fingerprint: model.fingerprint },
        entrypoint: 'TaskCompleted', steps, return: { record: { status: cel('matches ? "CREATED" : "NO_OP"') } } };
      const placement = { linked: teamScope, assigneeId: teamScope ? 'leo' : null };
      if (handoff) {
        const { args } = steps[2];
        Object.assign(args, handoffArgs);
        delete args.dueAt;
        steps.splice(1, 2, { id: 'followup', call: 'tasks.create', args });
        source.return.record.status = { literal: 'CREATED' };
      }
      if (lookup) {
        steps.splice(1, 2,
          { id: 'lookup', call: 'tasks.openMatch', args: { projectId: cel('source.projectId'), title: { literal: lookupTitle } } },
          { id: 'matches', let: cel('!lookup.matches') },
          { id: 'followup', call: 'tasks.create', when: 'matches',
            args: { projectId: cel('source.projectId'), title: { literal: createdTitle } } });
      }
      if (update || changeDue || addTag) {
        steps.splice(1, 2,
          { id: 'matches', let: cel(addTag ? `source.priority == "low" && ${tagGuard.map(tag => `${JSON.stringify(tag)} in source.tags`).join(' && ')} && !has(source.dueAt)`
            : changeDue ? 'source.title == "Return samples" && source.priority == "low"' : '"urgent" in source.tags') },
          { id: 'updated', call: 'tasks.update', when: 'matches', args: addTag ? { addTag: { literal: ' CAFE\u0301 ' } } : changeDue
            ? clearDue ? { clearDue: { literal: true } } : { dueAt: cel(`timestamp("${sourceDueInstant}")`) }
            : { priority: { literal: 'high' } } });
        source.return.record.status = cel('matches ? "UPDATED" : "NO_OP"');
      }
      const oldDue = clearDue ? sourceDueInstant : null, newDue = clearDue ? null : sourceDueInstant;
        return propose(composedOffer({
        bindings: { TaskBeforeComplete: null, TaskBeforeCreate: null, TaskCreated: null, TaskCompleted: JSON.stringify(source) },
        cases: addTag ? [
          { id: 'change', title: 'Archive sample', tags: tagInput, occurredAt, priority: 'low', openTitles: [], sourceDueAt: null,
            expect: { sourceTags: [...tagInput, 'café'] } },
          { id: 'dated', title: 'Archive sample', tags: tagInput, occurredAt, priority: 'low', openTitles: [], sourceDueAt: sourceDueInstant, expect: null },
          { id: 'omitted', title: 'Archive sample', tags: tagInput, occurredAt, priority: 'low', openTitles: [], expect: null },
          { id: 'equal', title: 'Archive sample', tags: ['café', ...tagGuard], occurredAt, priority: 'low', openTitles: [], sourceDueAt: null,
            expect: { sourceTags: ['café', ...tagGuard] } },
        ] : changeDue ? [
          { id: 'change', title: 'Return samples', tags: [], occurredAt, priority: 'low', openTitles: [], sourceDueAt: oldDue, expect: { sourceDueAt: newDue } },
          { id: 'equal', title: 'Return samples', tags: [], occurredAt, priority: 'low', openTitles: [], sourceDueAt: newDue, expect: { sourceDueAt: newDue } },
          { id: 'skip', title: 'Return samples', tags: [], occurredAt, priority: 'high', openTitles: [], sourceDueAt: oldDue, expect: null },
        ] : update ? [
          { id: 'change', title: 'Send summary', tags: ['urgent'], occurredAt, priority: 'normal', openTitles: [], expect: { sourcePriority: 'high' } },
          { id: 'equal', title: 'Send summary', tags: ['urgent'], occurredAt, priority: 'high', openTitles: [], expect: { sourcePriority: 'high' } },
          { id: 'skip', title: 'Send summary', tags: [], occurredAt, priority: 'normal', openTitles: [], expect: null },
        ] : lookup ? [
          { id: 'miss', title: 'Finish  dispatch\u200B', tags: [], occurredAt, priority: 'normal', openTitles: nearTitles,
            expect: { title: createdTitle, project: 'SAME_PROJECT', notes: '', tags: [], priority: 'normal', dueAt: null, linked: false, assigneeId: null } },
          { id: 'hit', title: 'Finish  dispatch\u200B', tags: [], occurredAt, priority: 'normal', openTitles: [...nearTitles, lookupTitle], expect: null },
        ] : handoff ? [{ id: 'handoff', title: 'Pack samples', tags: [], occurredAt, priority: 'normal', openTitles: [],
          expect: { ...handoffExpected, ...placement } }]
          : [{ id: 'matching', title: existingTitle, tags, occurredAt, priority: 'normal', openTitles: [], expect: { title, ...placement, project: 'SAME_PROJECT',
            notes: '', tags: [], priority: 'normal',
            dueAt: teamScope ? '2026-03-09T16:00:00.417Z' : `2026-03-07T17:00:00.${dueMismatch ? '418' : '417'}Z` } },
        { id: 'near-miss', title: existingTitle, tags: tags.map(tag => tag + 's'), occurredAt, priority: 'normal', openTitles: [], expect: null }],
        }, projectId));
    } }),
  } });
  await app.listen({ host: '127.0.0.1', port });
  return { db, app, origin, team, intakeProjects, requests, compilations: () => compilations, writes: () => writes, awaiting: () => awaiting,
    hold: () => { let resolve; hold = new Promise(done => { resolve = done; }); return resolve; } };
}

async function signIn(request, host, userId) {
  const session = await (await request.get(host.origin + '/api/session')).json();
  const login = await request.post(host.origin + '/api/session', { data: { userId },
    headers: { origin: host.origin, 'x-session-context': session.contextToken } });
  expect(login.ok()).toBe(true);
  return { origin: host.origin, 'x-session-context': (await login.json()).contextToken };
}

async function enter(page, host, scope) {
  await page.goto(host.origin);
  await page.getByRole('button', { name: /Continue as Maya/ }).click();
  await page.getByRole('button', { name: 'Customizations', exact: true }).click();
  const project = scope === 'TEAM' ? host.team.id : taskService(host.db).listProjects('maya').find(item => item.mode === 'PERSONAL').id;
  await page.getByLabel('Personal or Team project').selectOption(project);
  await page.getByRole('button', { name: 'New customization', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Customization Studio' })).toBeVisible();
  await expect(page.getByText(scope === 'TEAM' ? 'Team · Fulfillment Team' : 'Personal · Untitled customization')).toBeVisible();
}
async function send(page, text) {
  const box = page.getByRole('textbox', { name: 'Message to Daymark assistant' });
  await box.fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(box).toHaveValue('');
}

for (const { scope, width, code, failureText } of [
  { scope: 'PERSONAL', width: 390, code: 'PROVIDER_REPLY_BODY_INTERRUPTED', failureText: 'Daymark couldn’t read the assistant’s full reply.' },
  { scope: 'TEAM', width: 1440, code: 'PROVIDER_REPLY_FORMAT', failureText: 'Daymark couldn’t use the assistant’s answer.' },
]) test(`${scope} reads saved Studio history after an unusable provider reply`, async ({ page }) => {
  let transportCalls = 0, posts = 0;
  const privateMarker = 'synthetic-private-wire-marker';
  const headers = { 'content-type': 'application/json' };
  const earlierReply = 'Earlier saved assistant reply.';
  const host = await startAuthoringFixture({ authoringOverride: {
    async fetchImpl() {
      if (++transportCalls === 1) return Response.json({ status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: earlierReply }] }],
        usage: { input_tokens: 20, output_tokens: 10 } });
      if (scope === 'TEAM') return new Response(privateMarker, { headers });
      let started = false;
      return new Response(new ReadableStream({
        pull(controller) {
          if (started) controller.error(new Error(privateMarker));
          else { started = true; controller.enqueue(new TextEncoder().encode('{"output":')); }
        },
      }), { headers });
    },
  } });
  try {
    if (scope === 'TEAM') host.team = taskService(host.db).createProject('maya', { name: 'Fulfillment Team', mode: scope });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && /^\/api\/shared-studio\/[^/]+\/(?:turn|confirm)$/.test(path)) posts++;
    });
    await enter(page, host, scope);
    await send(page, 'Earlier discussion.');
    await expect(page.getByText(earlierReply, { exact: true })).toBeVisible();
    const held = () => host.db.prepare('SELECT reserved_micros FROM authoring_budget WHERE id=1').get().reserved_micros;
    const before = held(), text = 'Keep this message when a reply cannot be read.';
    await send(page, text);
    const read = page.getByRole('button', { name: 'Check saved work', exact: true });
    const checked = page.getByRole('status').filter({ hasText: 'Checked. This message is saved; no new proposal was received.' });
    await expect(read).toHaveAccessibleDescription('See what Daymark kept. Checking won’t send your message again.');
    await expect(page.getByText(`${failureText} Your saved work is still here. Check it before sending another message.`, { exact: true })).toBeVisible();
    await expect(checked).toHaveCount(0);
    const refreshed = page.waitForResponse(response => response.request().method() === 'GET' &&
      new URL(response.url()).pathname.startsWith('/api/shared-studio/'));
    await read.click();
    const saved = await (await refreshed).json();
    expect(saved.conversation).toMatchObject({ status: 'BLOCKED', code, offer: null });
    expect(saved.review.draftVersion).toBe(0);
    await expect(checked).toBeVisible();
    await expect(read).toHaveAccessibleDescription('Checked. This message is saved; no new proposal was received. Checking won’t send your message again.');
    await page.reload();
    await expect(read).toHaveAccessibleDescription(/won’t send your message again/);
    await expect(checked).toHaveCount(0);
    await expect(page.getByText(earlierReply, { exact: true })).toBeVisible();
    await expect(page.getByText(text, { exact: true })).toHaveCount(1);
    await expect(page.locator('body')).not.toContainText(privateMarker);
    await expect(page.getByRole('button', { name: 'Confirm and check', exact: true })).toHaveCount(0);
    const dispatches = host.db.prepare('SELECT ordinal,kind,outcome,reserved_micros,estimated_micros FROM authoring_dispatches WHERE run_id=?')
      .all(saved.conversation.runId);
    expect(dispatches).toEqual([{ ordinal: 1, kind: 'provider', outcome: 'UNKNOWN', reserved_micros: 387072, estimated_micros: null }]);
    expect(held() - before).toBe(387072);
    expect(posts).toBe(2);
    expect(transportCalls).toBe(2);
  } finally { await page.close(); await host.close(); }
});

for (const width of [1440, 390]) test(`single new-authoring route and earlier saved access at ${width}px`, async ({ page, request, browser }) => {
  const host = await fixture();
   const legacyLabel = 'Open earlier Team work';
  const memberPage = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    await page.setViewportSize({ width, height: 900 });
    const member = await signIn(request, host, 'leo');
    const oldTeam = `${host.origin}/api/projects/${host.team.id}/authoring`;
    expect((await request.get(oldTeam, { headers: member })).status()).toBe(403);
    const admin = await signIn(request, host, 'maya');
    const turn = { operationId: randomUUID(), expectedVersion: 0, expectedDraftVersion: 0, text: 'Start earlier authoring.' };
    expect((await request.post(`${host.origin}/api/authoring/turn`, { headers: admin,
      data: { ...turn, target: { kind: 'create' }, conversationId: null } })).status()).toBe(409);
    expect((await request.post(`${oldTeam}/turn`, { headers: admin, data: turn })).status()).toBe(409);
    expect((await request.post(`${host.origin}/api/projects/${host.team.id}/capability/proposals`,
      { headers: admin, data: { expectedDraftVersion: 0, reviewerId: 'leo', title: 'Legacy draft', intent: '' } })).status()).toBe(409);
    expect(host.db.prepare('SELECT count(*) n FROM authoring_conversations').get().n).toBe(0);
    expect(host.requests).toHaveLength(0);

    await page.goto(host.origin + '/#new=1');
    await page.getByRole('button', { name: /Continue as Maya/ }).click();
    await expect(page.getByText('Personal · Untitled customization', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#customization=/);
    const opened = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization');
    expect((await request.post(`${host.origin}/api/extensions/${opened}/compile`, { headers: admin,
      data: { hookId: 'TaskCompleted', source: '{}', draftVersion: 0 } })).status()).toBe(409);
    const legacyLink = `${host.origin}/#teamProject=${host.team.id}&studio=legacy`;
    await page.goto(legacyLink);
    await expect(page.getByText('There is no earlier draft or discussion to continue.', { exact: false })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message to Daymark assistant' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to Customizations' }).click();
    await expect(page.getByRole('button', { name: 'New customization', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: legacyLabel })).toHaveCount(0);
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    await expect(page.getByText('Team · Fulfillment Team', { exact: true })).toBeVisible();

    seedEarlierTeamDiscussion(host.db, host.team.id);
    await page.getByRole('button', { name: 'Back to Customizations' }).click();
    await expect(page.getByRole('button', { name: legacyLabel })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open Studio' }).click();
    await page.getByText('More', { exact: true }).click();
    await page.getByRole('button', { name: legacyLabel }).click();
    await expect(page.getByText('Earlier Team discussion', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message to Daymark assistant' })).toBeVisible();
    const personal = admitTaskDraft(host.db, createLifecycle(host.db), { name: 'Earlier Personal discussion' });
    await page.goto(`${host.origin}/#customization=${personal.extensionId}`);
    await expect(page.getByRole('heading', { name: 'Earlier Personal discussion', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message to Daymark assistant' })).toBeVisible();
    await memberPage.goto(`${host.origin}/#teamProject=${host.team.id}`);
    await memberPage.getByRole('button', { name: /Continue as Leo/ }).click();
    await expect(memberPage.getByText(/Only project admins can open Studio/)).toBeVisible();
    await expect(memberPage.getByRole('button', { name: /^(New customization|Open Studio)$/ })).toHaveCount(0);
    await expect(memberPage.getByRole('button', { name: legacyLabel })).toHaveCount(0);
    await memberPage.goto(legacyLink);
    await expect(memberPage.getByRole('alert')).toBeVisible();
    await expect(memberPage.getByRole('textbox', { name: 'Message to Daymark assistant' })).toHaveCount(0);
    await expect(memberPage.getByText('Earlier Team discussion', { exact: true })).toHaveCount(0);
  } finally { await memberPage.close(); await host.app.close(); host.db.close(); }
});

test('Personal Studio grants note excerpts only for the submitted message', async ({ page }) => {
  const host = await fixture({ intake: true });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const tasks = taskService(host.db), project = host.intakeProjects[1];
    const reference = tasks.listTasks('maya', project).find(task => task.title === 'Exact reference');
    tasks.editTask('maya', reference.id, { title: reference.title, notes: 'Notes shared only on opt-in.' });
    await enter(page, host, 'PERSONAL');
    const consent = page.getByRole('checkbox', { name: 'Allow task-note excerpts for this message' });
    await expect(consent).not.toBeChecked();
    await send(page, contextRequest);
    await expect(page.getByText('No note excerpts were read.', { exact: true })).toHaveCount(1);
    await consent.check();
    await send(page, contextRequest);
    await expect(page.getByText('One permitted note excerpt was read.', { exact: true })).toBeVisible();
    await expect(consent).not.toBeChecked();
    await send(page, contextRequest);
    await expect(page.getByText('No note excerpts were read.', { exact: true })).toHaveCount(2);
    await expect(page.getByText('Personal · Untitled customization', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Saved draft' })).toHaveCount(0);
    expect(host.compilations()).toBe(0);
  } finally { await host.app.close(); host.db.close(); }
});

test('Personal owned-project rule shows distinct project labels and reads the exact receipt after restart', async ({ page }, info) => {
  const dir = mkdtempSync(info.outputPath('owned-project-')), path = join(dir, 'app.sqlite');
  let db = openData(path), app;
  try {
    const host = await fixture({ db, intake: true, loseWrite: true });
    app = host.app;
    const [source, destination, foreign] = host.intakeProjects;
    const tasks = taskService(db);
    tasks.renameProject('maya', destination, { name: cafeNames[0] });
    await enter(page, host, 'PERSONAL');
    await send(page, ownedProjectRequest);
    const proposal = page.getByRole('region', { name: 'Current proposal' });
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await expect(proposal.getByText(/If you later complete it, the standalone completion rule in use then can run/)).toBeVisible();
    await expect(proposal.getByText(`Create one task in “${cafeNames[0]}” (project 2)`, { exact: false })).toBeVisible();
    await expect(proposal.getByText(`No open task titled “${ownedProjectTitle}” in “${cafeNames[0]}” (project 2)`, { exact: false })).toBeVisible();
    await expect(proposal).not.toContainText(destination);
    await expect(proposal).not.toContainText(foreign);
    await proposal.getByRole('button', { name: 'Confirm and check' }).click();
    await saved.getByText('Checked examples').click();
    await expect(saved.getByText(/In the isolated example: Create.*\(project 2\)/)).toBeVisible();
    await expect(saved.getByText('In the isolated example: Create nothing.')).toBeVisible();
    await expect(saved.getByText(`Other open tasks in “${cafeNames[0]}” (project 1): “${ownedProjectTitle}”.`)).toHaveCount(2);
    await expect(saved).not.toContainText(source);
    tasks.renameProject('maya', destination, { name: 'Accounts archive' });
    await page.getByRole('button', { name: 'Read saved state', exact: true }).click();
    await expect(saved.getByText('Create one task in “Accounts archive”', { exact: false })).toBeVisible();
    await saved.getByRole('button', { name: 'Approve this draft' }).click();
    await expect(saved.getByText('Approved · Not on yet')).toBeVisible();
    await saved.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(saved.getByText('In use now', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('owned-project.png') });
    const { contextToken } = await (await page.request.get(`${host.origin}/api/session`)).json();
    const headers = { origin: host.origin, 'x-session-context': contextToken };
    const create = (title, tags = []) => page.request.post(`${host.origin}/api/tasks`,
      { headers: { ...headers, 'x-task-create-id': randomUUID() }, data: { projectId: source, title, tags } });
    expect((await create(ownedProjectTitle)).status()).toBe(201);
    const root = await (await create('September ledger', ['invoices'])).json(), rootPath = `/api/tasks/${root.id}`;
    expect((await page.request.post(`${host.origin}${rootPath}/complete`, { headers, data: {} })).status()).toBe(200);
    const read = async () => (await page.request.get(`${host.origin}${rootPath}/reaction`, { headers })).json();
    await expect.poll(async () => (await read()).outcome?.classification).toBe('UNCERTAIN');
    const original = await read(), child = original.receipt.value.id;
    expect(original).toMatchObject({ receipt: { effect: 'CONFIRMED' }, destinationProjectId: destination, linked: false });
    expect(await (await page.request.get(`${host.origin}/api/tasks/${child}`, { headers })).json())
      .toMatchObject({ id: child, title: ownedProjectTitle, projectId: destination });
    expect(host.writes()).toBe(1);
    const events = () => db.prepare('SELECT hook_id,item_id,revision_id,selection_generation FROM task_events WHERE source_task_id=?').all(child);
    expect(events()).toEqual([]);
    await send(page, priorityRequest);
    await proposal.getByRole('button', { name: 'Confirm and check' }).click();
    await saved.getByRole('button', { name: 'Approve this draft' }).click();
    await saved.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(saved.getByText('In use now', { exact: true })).toBeVisible();
    const selected = db.prepare(`SELECT s.revision_id,s.generation,l.extension_id FROM extension_selections s
      JOIN extension_revision_links l ON l.revision_id=s.revision_id AND l.owner_id=s.owner_id
      WHERE s.owner_id='maya' AND s.hook_id='TaskCompleted'`).get();
    expect(selected.revision_id).not.toBe(original.revisionId);
    const childPath = `/api/tasks/${child}`;
    expect((await page.request.patch(`${host.origin}${childPath}`, { headers, data: { tags: ['urgent'] } })).status()).toBe(200);
    const completeChild = () => page.request.post(`${host.origin}${childPath}/complete`, { headers, data: {} });
    expect((await completeChild()).status()).toBe(200);
    const readChild = async () => (await page.request.get(`${host.origin}${childPath}/reaction`, { headers })).json();
    await expect.poll(async () => (await readChild()).state).toBe('FINISHED');
    const childResult = await readChild();
    expect(childResult).toMatchObject({ revisionId: selected.revision_id, receipt: { effect: 'CONFIRMED', value: { id: child } },
      observation: { updated: { id: child, after: { priority: 'high' } } } });
    expect(childResult.originalKey).not.toBe(original.originalKey);
    expect((await completeChild()).status()).toBe(200);
    expect(events()).toEqual([{ hook_id: 'TaskCompleted', item_id: selected.extension_id,
      revision_id: selected.revision_id, selection_generation: selected.generation }]);
    expect(await read()).toEqual(original);
    expect(host.writes()).toBe(2);
    await app.close(); app = null; db.close(); db = null;
    db = openData(path);
    let replayed = 0;
    app = await createApp({ db, origin: host.origin, sharedCompletionWriteReply(value) { replayed++; return value; } });
    const originHeaders = { origin: host.origin, host: new URL(host.origin).host };
    const anonymous = (await app.inject({ url: '/api/session', headers: originHeaders })).json();
    const login = await app.inject({ method: 'POST', url: '/api/session', headers: { ...originHeaders, 'x-session-context': anonymous.contextToken }, payload: { userId: 'maya' } });
    expect(login.statusCode).toBe(200);
    const authorized = { ...originHeaders, 'x-session-context': login.json().contextToken,
      cookie: login.cookies.map(({ name, value }) => `${name}=${value}`).join('; ') };
    const repeated = await app.inject({ method: 'POST', url: `${childPath}/complete`, headers: authorized, payload: {} });
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(events()).toEqual([{ hook_id: 'TaskCompleted', item_id: selected.extension_id,
      revision_id: selected.revision_id, selection_generation: selected.generation }]);
    const observed = await app.inject({ method: 'POST', url: `${rootPath}/reaction/reconcile`, headers: authorized, payload: {} });
    expect(observed.statusCode, observed.body).toBe(200);
    expect(observed.json()).toMatchObject({ ...original, reconciliation: { receipt: original.receipt, destinationProjectId: destination } });
    const childObserved = await app.inject({ method: 'POST', url: `${childPath}/reaction/reconcile`, headers: authorized, payload: {} });
    expect(childObserved.statusCode, childObserved.body).toBe(200);
    expect(childObserved.json()).toMatchObject({ ...childResult, reconciliation: { receipt: childResult.receipt, observation: childResult.observation } });
    expect(replayed).toBe(0);
  } finally { await app?.close(); db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const [hook, stage] of [['TaskBeforeCreate', 'Before save'], ['TaskCreated', 'After save'], ['TaskCompleted', 'After completion']])
test(`Personal Studio shows the exact task evidence for ${hook}`, async ({ page }) => {
  const host = await fixture({ intake: true });
  try {
    await enter(page, host, 'PERSONAL');
    await send(page, exactReadRequest(hook));
    const proposal = page.getByRole('region', { name: 'Current proposal' });
    const section = proposal.getByRole('region', { name: stage });
    const reference = host.db.prepare("SELECT id FROM tasks WHERE title='Exact reference'").get().id;
    await expect(section.getByText(/Reference task 1 .*Priority is/)).toBeVisible();
    await expect(section).not.toContainText(reference);
    await section.getByText('Rule details', { exact: true }).click();
    await expect(section.getByText(reference, { exact: true })).toBeVisible();
    await proposal.getByRole('button', { name: 'Confirm and check' }).click();
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await saved.getByText('Checked examples').click();
    await expect(saved.getByText(/Reference task 2: “Exact reference”/).first()).toBeVisible();
    await expect(saved).not.toContainText('same-title-other-task');
    await expect(saved.getByText(hook === 'TaskBeforeCreate' ? /In the isolated example: Do not save/ : /In the isolated example: Saved priority: high/)).toBeVisible();
    await expect(saved.getByRole('button', { name: 'Approve this draft' })).toBeEnabled();
  } finally { await host.app.close(); host.db.close(); }
});

for (const [hook, stage] of [['TaskCreated', 'After save'], ['TaskCompleted', 'After completion']])
test(`Personal Studio checks one ${hook} create with an exact reference and lookup`, async ({ page }) => {
  const host = await fixture({ intake: true });
  try {
    await enter(page, host, 'PERSONAL');
    await send(page, exactCreateRequest(hook));
    const proposal = page.getByRole('region', { name: 'Current proposal' });
    const section = proposal.getByRole('region', { name: stage });
    const [lookup, destination] = host.intakeProjects;
    await expect(section.getByText(/Reference task 1 .*Priority is/)).toBeVisible();
    await expect(section.getByRole('list', { name: 'All conditions must match' })).toContainText('“Café” (project 1)');
    await expect(section.getByText(/Create one task in/)).toContainText('“Café” (project 2)');
    await expect(section).not.toContainText(lookup);
    await expect(section).not.toContainText(destination);
    await section.getByText('Rule details', { exact: true }).click();
    await expect(section.getByText(lookup, { exact: true })).toBeVisible();
    await expect(section.getByText(destination, { exact: true })).toBeVisible();
    await proposal.getByRole('button', { name: 'Confirm and check' }).click();
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await saved.getByText('Checked examples').click();
    await expect(saved.getByText(/Reference task 2: “Exact reference”/).first()).toBeVisible();
    await expect(saved.getByText(/In the isolated example:.*Ledger packet/)).toBeVisible();
    await expect(saved.getByRole('button', { name: 'Approve this draft' })).toBeEnabled();
  } finally { await host.app.close(); host.db.close(); }
});

test('Personal Studio preserves a negated reference tag in the proposal and saved review', async ({ page }) => {
  const host = await fixture({ intake: true });
  try {
    await enter(page, host, 'PERSONAL');
    await send(page, negatedTagRequest);
    const proposal = page.getByRole('region', { name: 'Current proposal' });
    await expect(proposal.getByText(/Does not have exact tag “ready”/)).toBeVisible();
    await proposal.getByRole('button', { name: 'Confirm and check' }).click();
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await expect(saved.getByText(/Does not have exact tag “ready”/)).toBeVisible();
    await saved.getByText('Checked examples').click();
    const deny = saved.getByRole('listitem').filter({ hasText: 'In the isolated example: Do not save.' });
    const allow = saved.getByRole('listitem').filter({ hasText: 'In the isolated example: Allow normal save checks to continue.' });
    const reference = page.getByText(/Reference task 1: “Exact reference”/);
    await expect(deny.locator(reference)).toContainText('no tags');
    await expect(allow.locator(reference)).toContainText('tags “ready”');
    await expect(saved.getByRole('button', { name: 'Approve this draft' })).toBeEnabled();
  } finally { await host.app.close(); host.db.close(); }
});

for (const hook of ['TaskCreated', 'TaskCompleted']) for (const exact of [false, true])
test(`Personal Studio checks an owned lookup${exact ? ' and exact reference' : ''} before one ${hook} source update`, async ({ page }) => {
  const host = await fixture({ intake: true });
  try {
    await enter(page, host, 'PERSONAL');
    await send(page, exact ? exactLookupUpdateRequest(hook) : ownedLookupUpdateRequest(hook));
    const proposal = page.getByRole('region', { name: 'Current proposal' });
    const section = proposal.getByRole('region', { name: hook === 'TaskCreated' ? 'After save' : 'After completion' });
    const lookupCondition = section.getByRole('list', { name: 'All conditions must match' });
    await expect(lookupCondition).toContainText(`${exact ? 'No' : 'An'} open task titled “Dispatch” in “${cafeNames[1]}” (project 2)`);
    for (const id of host.intakeProjects) await expect(section).not.toContainText(id);
    if (exact) await expect(section.getByText(/Reference task 1 .*Priority is/)).toBeVisible();
    await expect(section.getByText('The lookup checks for an open title. Only the triggering task can change.')).toBeVisible();
    await expect(section.getByText('Set priority to high.')).toBeVisible();
    await expect(section.getByText('Clear the due date.')).toBeVisible();
    await expect(section.getByText('Add tag “ready”.')).toBeVisible();
    await proposal.getByRole('button', { name: 'Confirm and check' }).click();
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await saved.getByText('Checked examples').click();
    await expect(saved.getByText(/Other open tasks in.*\(project 1\)/).first()).toContainText(ownedUpdateTitle);
    const lookupExamples = saved.getByText(/Other open tasks in.*\(project 2\)/);
    await expect(lookupExamples.first()).toContainText(`“${exact ? ownedUpdateTitle.toLowerCase() : ownedUpdateTitle}”`);
    if (exact) await expect(lookupExamples.filter({ hasText: /“Dispatch”/ }).first()).toBeVisible();
    await expect(saved.getByText(/In the isolated example: Saved priority: high.*No due date.*Saved tags/)).toBeVisible();
    await expect(saved.getByText(/In the isolated example: Do not update/)).toHaveCount(exact ? 3 : 2);
    await expect(saved.getByRole('button', { name: 'Approve this draft' })).toBeEnabled();
  } finally { await host.app.close(); host.db.close(); }
});

for (const scope of ['PERSONAL', 'TEAM']) for (const created of [true, false])
test(`${scope}: after-${created ? 'save' : 'completion'} source update in Studio and original HTTP receipt after restart`, async ({ page }, info) => {
  const team = scope === 'TEAM', dir = mkdtempSync(info.outputPath('source-update-')), path = join(dir, 'app.sqlite');
  const dueAt = team && !created ? sourceDueInstant : null;
  const trigger = created ? '?trigger=TaskCreated' : '';
  const source = created ? 'newly saved task' : 'completed task';
  let db = openData(path), app;
  try {
    const host = await fixture({ db, loseWrite: true });
    app = host.app;
    await page.setViewportSize(team ? { width: 390, height: 844 } : { width: 1440, height: 960 });
    await enter(page, host, scope);
    await send(page, created ? createdUpdateRequest : completedUpdateRequest(dueAt));
    const proposal = page.getByRole('region', { name: 'Current proposal' });
    const stage = proposal.getByRole('region', { name: created ? 'After save' : 'After completion' });
    for (const text of [`Update the ${source} once.`, 'Set priority to high.', 'Add tag “ready”.',
      dueAt ? 'Set the due date to' : 'Clear the due date.'])
      await expect(stage.getByText(text)).toBeVisible();
    await expect(stage.getByText(created ? /edited or completed after saving/ : /edited after completion/)).toBeVisible();
    await proposal.getByRole('button', { name: 'Confirm and check' }).click();
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await saved.getByText('Checked examples').click();
    await expect(saved.getByText(new RegExp(`In the isolated example: Saved priority: high.*${dueAt ? 'Due ' : 'No due date'}.*Saved tags`))).toBeVisible();
    await expect(saved.getByText(/In the isolated example: The update leaves the task unchanged/)).toBeVisible();
    await expect(saved.getByText(`In the isolated example: Do not update the ${source}.`)).toBeVisible();
    await saved.getByRole('button', { name: 'Approve this draft' }).click();
    await expect(saved.getByText('Approved · Not on yet')).toBeVisible();
    await saved.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(saved.getByText('In use now', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('source-update.png') });
    const projectId = host.requests.at(-1).currentContext.beforeCreateProjects[0].id;
    const { contextToken } = await (await page.request.get(`${host.origin}/api/session`)).json();
    const headers = { origin: host.origin, 'x-session-context': contextToken };
    const make = async (title, tags = ['intake']) => {
      const made = await page.request.post(`${host.origin}/api/tasks`, { headers: { ...headers, 'x-task-create-id': randomUUID() },
        data: { projectId, title, notes: 'Keep\0these notes', tags, priority: 'low', dueAt: '2026-12-07T07:01:02.000Z' } });
      expect(made.status(), await made.text()).toBe(201);
      return made.json();
    };
    const taskPath = task => `${host.origin}/api/tasks/${task.id}`;
    const read = async task => (await page.request.get(`${taskPath(task)}/reaction${trigger}`, { headers })).json();
    const taskState = async task => (await page.request.get(taskPath(task), { headers })).json();
    const complete = async task => {
      const reply = await page.request.post(`${taskPath(task)}/complete`, { headers, data: {} });
      expect(reply.ok(), await reply.text()).toBe(true);
      await expect.poll(async () => (await read(task)).state).toBe('FINISHED');
    };
    if (!created) {
      const sameTime = await make('Edited and restored');
      host.db.exec(`CREATE TEMP TRIGGER edit_after_completion_claim AFTER UPDATE OF state ON shared_completion_events
        WHEN NEW.state='STARTED'
        BEGIN
          UPDATE tasks SET priority='normal' WHERE id=NEW.source_id;
          UPDATE tasks SET priority='low' WHERE id=NEW.source_id;
        END`);
      await complete(sameTime);
      host.db.exec('DROP TRIGGER edit_after_completion_claim');
      expect(await read(sameTime)).toMatchObject({ receipt: null, outcome: { classification: 'BUSINESS_REJECTION' } });
      const afterEdit = await taskState(sameTime);
      expect(afterEdit).toMatchObject({ priority: sameTime.priority, dueAt: sameTime.dueAt, tags: sameTime.tags });
      expect(afterEdit.updatedAt).toBe(afterEdit.completedAt);
      const full = await make('No room for another tag', ['intake', 'a', 'b', 'c', 'd', 'e', 'f', 'g']);
      await complete(full);
      expect(await read(full)).toMatchObject({ receipt: null, outcome: { classification: 'BUSINESS_REJECTION' } });
      expect(await taskState(full)).toMatchObject({ priority: full.priority, dueAt: full.dueAt, tags: full.tags });
    }
    const root = await make('Reimburse travel'), rootPath = `/api/tasks/${root.id}`;
    if (!created) await complete(root);
    await expect.poll(async () => (await read(root)).outcome?.classification).toBe('UNCERTAIN');
    const original = await read(root);
    expect(original).toMatchObject({ capability: 'tasks.update', receipt: { kind: 'SUCCESS', effect: 'CONFIRMED', value: { id: root.id } },
      linked: false, observation: { updated: { before: { priority: 'low', dueAt: root.dueAt, tags: ['intake'] },
        after: { priority: 'high', dueAt, tags: ['intake', 'ready'] } } } });
    expect(await taskState(root)).toMatchObject({ projectId, title: root.title, notes: root.notes,
      status: created ? 'open' : 'completed', priority: 'high', dueAt, tags: ['intake', 'ready'] });
    if (team) {
      await page.goto(`${host.origin}/#teamProject=${projectId}`);
      await page.reload();
      await expect(page.getByLabel('Personal or Team project')).toHaveValue(projectId);
    } else await page.goto(host.origin);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: /^Reimburse travel / }).click();
    const result = page.getByRole('region', { name: created ? 'Task creation customization outcome' : 'Customization outcome', exact: true });
    await expect(result.getByText('This task was updated.')).toBeVisible();
    await expect(result.getByRole('alert')).toHaveCount(0);
    expect(host.writes()).toBe(1);
    await app.close(); app = null; db.close(); db = null;
    db = openData(path);
    let replayed = 0;
    app = await createApp({ db, origin: host.origin, sharedCompletionWriteReply(value) { replayed++; return value; } });
    const originHeaders = { origin: host.origin, host: new URL(host.origin).host };
    const anonymous = (await app.inject({ url: '/api/session', headers: originHeaders })).json();
    const login = await app.inject({ method: 'POST', url: '/api/session', headers: { ...originHeaders, 'x-session-context': anonymous.contextToken }, payload: { userId: 'maya' } });
    expect(login.statusCode).toBe(200);
    const authorized = { ...originHeaders, 'x-session-context': login.json().contextToken,
      cookie: login.cookies.map(({ name, value }) => `${name}=${value}`).join('; ') };
    const reply = await app.inject({ method: 'POST', url: `${rootPath}/reaction/reconcile${trigger}`, headers: authorized, payload: {} });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(reply.json()).toMatchObject({ ...original, reconciliation: { receipt: original.receipt, observation: original.observation } });
    expect(replayed).toBe(0);
  } finally { await app?.close(); db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const linked of [false, true]) test(`Team shared completion gate: ${linked ? 'linked task' : 'task fields only'}`, async ({ page }, info) => {
  const host = await fixture({ loseWrite: linked });
  try {
    await page.setViewportSize({ width: linked ? 390 : 1440, height: 900 });
    await enter(page, host, 'TEAM');
    await send(page, linked ? linkedGateRequest : fieldGateRequest);
    const proposal = page.getByRole('region', { name: 'Current proposal' });
    const saved = page.getByRole('region', { name: 'Saved draft' });
    const gate = panel => panel.getByRole('region', { name: 'Before completion' });
    const scope = 'The rule in use applies only to new tasks people add. Existing tasks keep the rule they started with.';
    await expect(proposal.getByText(scope)).toBeVisible();
    await expect(gate(proposal).getByText('Before completing the original task')).toBeVisible();
    await expect(proposal.getByRole('region', { name: 'After save' })).toHaveCount(linked ? 1 : 0);
    await expect(proposal.getByRole('region', { name: 'After completion' })).toHaveCount(0);
    await proposal.getByRole('button', { name: 'Confirm and check' }).click();
    await expect(saved.getByText(scope)).toBeVisible();
    await gate(saved).getByText('Checked examples', { exact: true }).click();
    await expect(gate(saved).getByText('In the isolated example: Allow normal completion.')).toHaveCount(linked ? 2 : 1);
    await expect(gate(saved).getByText(/In the isolated example: Keep the task open/)).toHaveCount(linked ? 2 : 1);
    if (linked) for (const status of ['missing', 'open', 'completed'])
      await expect(gate(saved).getByText(`Verified linked task: ${status}.`)).toHaveCount(status === 'missing' ? 2 : 1);
    await saved.getByRole('button', { name: 'Approve this draft' }).click();
    await expect(saved.getByText('Approved · Not on yet')).toBeVisible();
    await saved.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(saved.getByText('In use now', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('shared-team-gate.png') });
    const { contextToken } = await (await page.request.get(host.origin + '/api/session')).json();
    const headers = { origin: host.origin, 'x-session-context': contextToken };
    const made = await page.request.post(host.origin + '/api/tasks', { headers: { ...headers, 'x-task-create-id': randomUUID() },
      data: { projectId: host.team.id, title: 'File receipt', priority: 'high', tags: ['receipt'] } });
    expect(made.status()).toBe(201);
    const root = await made.json(), url = `${host.origin}/api/tasks/${root.id}`;
    const controls = `${host.origin}/api/projects/${host.team.id}/capability`;
    const { selection } = await (await page.request.get(controls, { headers })).json();
    if (linked) {
      await send(page, fieldGateRequest);
      await proposal.getByRole('button', { name: 'Confirm and check' }).click();
      await expect(saved).toContainText('Add notes before completing this task.');
    }
    await page.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
    const active = page.getByRole('region', { name: 'What’s in use' });
    await expect(active.getByRole('heading', { name: linked ? 'Check receipt' : 'Task completion rule' })).toBeVisible();
    if (linked) await expect(active).not.toContainText('Add notes before completing this task.');
    await page.getByRole('button', { name: 'Open Studio' }).click();
    await page.getByText('More', { exact: true }).click();
    await page.getByRole('button', { name: 'Turn off for new tasks', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm stop for new tasks' }).click();
    await expect(page.getByText('In use now: No rule for this slot.')).toBeVisible();
    expect((await page.request.post(`${controls}/deactivations`, { headers, data: {
      operationId: randomUUID(), targetRevisionId: selection.revisionId, expectedSelectionRevisionId: selection.revisionId,
      expectedSelectionGeneration: selection.generation,
    } })).status()).toBe(409);
    const later = await (await page.request.post(`${host.origin}/api/tasks`, { headers: { ...headers, 'x-task-create-id': randomUUID() },
      data: { projectId: host.team.id, title: 'After stop', priority: 'high', tags: ['receipt'] } })).json();
    expect((await page.request.post(`${host.origin}/api/tasks/${later.id}/complete`, { headers, data: {} })).ok()).toBe(true);
    let child;
    const read = async () => (await page.request.get(`${url}/reaction?trigger=TaskCreated`, { headers })).json();
    if (linked) {
      await expect.poll(async () => (await read()).outcome?.classification).toBe('UNCERTAIN');
      const saved = await (await page.request.post(`${url}/reaction/reconcile?trigger=TaskCreated`, { headers, data: {} })).json();
      child = saved.receipt.value.id;
      expect(saved.reconciliation.receipt).toEqual(saved.receipt);
    } else expect((await read()).state).toBe('NO_BINDING');
    await page.goto(`${host.origin}/#teamProject=${host.team.id}`);
    await page.reload();
    await expect(page.getByLabel('Personal or Team project')).toHaveValue(host.team.id);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: 'File receipt', exact: true }).click();
    const detail = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Task details', exact: true }) });
    await detail.getByRole('button', { name: 'Complete task', exact: true }).click();
    await expect(detail.getByRole('region', { name: 'Last completion attempt' })).toContainText(linked
      ? 'Finish the linked check before completing this task.' : 'Add notes before completing this task.');
    if (linked) {
      await expect(detail.getByText(/“Check receipt” · Assigned to Leo · Open/)).toBeVisible();
      await expect(detail.getByRole('button', { name: 'Open task: Check receipt' })).toBeVisible();
      expect((await page.request.post(`${host.origin}/api/tasks/${child}/complete`, { headers, data: {} })).ok()).toBe(true);
    } else expect((await page.request.patch(url, { headers, data: { title: 'File receipt', notes: 'Filed.' } })).ok()).toBe(true);
    expect((await page.request.post(`${url}/complete`, { headers, data: {} })).ok()).toBe(true);
    expect((await (await page.request.get(url, { headers })).json()).status).toBe('completed');
  } finally { await host.app.close(); host.db.close(); }
});

for (const scope of ['PERSONAL', 'TEAM']) for (const [request, stages, trigger, title] of [
  [afterSaveOnly, ['After save'], 'TaskCreated', 'Check receipt'],
  [guardAndCompletion, ['Before save', 'After completion'], 'TaskCompleted', 'Archive receipt'],
]) test(`${scope}: present hooks Studio renders exactly ${stages.join(' and ')}`, async ({ page }, info) => {
  const host = await fixture();
  try {
    await page.setViewportSize({ width: scope === 'TEAM' ? 390 : 1440, height: 900 });
    await enter(page, host, scope);
    await send(page, request);
    const proposal = page.getByRole('region', { name: 'Current proposal' });
    const verifyStages = async panel => {
      for (const stage of ['Before save', 'After save', 'After completion'])
        await expect(panel.getByRole('region', { name: stage, exact: true })).toHaveCount(stages.includes(stage) ? 1 : 0);
    };
    await verifyStages(proposal);
    await proposal.getByRole('button', { name: 'Confirm and check' }).click();
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await verifyStages(saved);
    const effect = saved.getByRole('region', { name: stages.at(-1) });
    await effect.getByText('Checked examples', { exact: true }).click();
    await expect(effect.getByText(new RegExp(`In the isolated example: .*${title}`))).toBeVisible();
    await saved.getByRole('button', { name: 'Approve this draft' }).click();
    await expect(saved.getByText('Approved · Not on yet')).toBeVisible();
    await saved.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(saved.getByText('In use now', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('present-hooks.png') });
    const { contextToken } = await (await page.request.get(host.origin + '/api/session')).json();
    const headers = { origin: host.origin, 'x-session-context': contextToken };
    const projectId = host.requests.at(-1).currentContext.beforeCreateProjects[0].id;
    const create = notes => page.request.post(host.origin + '/api/tasks', { headers: { ...headers, 'x-task-create-id': randomUUID() },
      data: { projectId, title: 'File a receipt', tags: ['receipt'], notes } });
    if (trigger === 'TaskCompleted') expect((await create('')).status()).toBe(422);
    const reply = await create(trigger === 'TaskCreated' ? '' : 'Filed.');
    expect(reply.status(), await reply.text()).toBe(201);
    const { id } = await reply.json(), url = `${host.origin}/api/tasks/${id}`;
    const read = async hook => (await page.request.get(`${url}/reaction?trigger=${hook}`, { headers })).json();
    if (trigger === 'TaskCompleted') expect((await read('TaskCreated')).state).toBe('NO_BINDING');
    else await expect.poll(async () => (await read(trigger)).receipt?.effect).toBe('CONFIRMED');
    expect((await page.request.post(`${url}/complete`, { headers, data: {} })).ok()).toBe(true);
    await expect.poll(async () => (await read(trigger)).receipt?.effect).toBe('CONFIRMED');
    const { receipt } = await read(trigger);
    expect((await (await page.request.get(`${host.origin}/api/tasks/${receipt.value.id}`, { headers })).json()).title).toBe(title);
    expect((await read(trigger === 'TaskCreated' ? 'TaskCompleted' : 'TaskCreated')).state).toBe('NO_BINDING');
  } finally { await host.app.close(); host.db.close(); }
});

test('Personal Studio names the active item and refuses same-hook replacement until it is turned off', async ({ page }, info) => {
  const host = await fixture();
  try {
    await enter(page, host, 'PERSONAL');
    const saved = page.getByRole('region', { name: 'Saved draft' });
    const back = page.getByRole('button', { name: 'Back to Customizations', exact: true });
    const turnOn = saved.getByRole('button', { name: 'Turn on', exact: true });
    async function prepare(name) {
      await send(page, guardAndCompletion);
      await page.getByRole('region', { name: 'Current proposal' }).getByRole('button', { name: 'Confirm and check' }).click();
      await saved.getByRole('button', { name: 'Approve this draft' }).click();
      await expect(saved.getByText('Approved · Not on yet')).toBeVisible();
      const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization');
      createLifecycle(host.db).rename('maya', { extensionId: id, expectedName: 'Untitled customization', name }, () => {});
      return id;
    }
    async function open(name, id) {
      await page.getByRole('article', { name, exact: true }).locator(`#edit-${id}`).click();
      await expect(page.getByText(`Personal · ${name}`, { exact: true })).toBeVisible();
    }
    const a = await prepare('Receipt intake'), bName = 'Receipt archive';
    await turnOn.click();
    await expect(saved.getByText('In use now', { exact: true })).toBeVisible();
    await back.click();
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    const b = await prepare(bName);
    await expect(saved.getByText(/Turn off “Receipt intake” before turning this one on/)).toBeVisible();
    await expect(turnOn).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('personal-occupied.png') });
    await back.click();
    await open('Receipt intake', a);
    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm turn off', exact: true }).click();
    await expect(saved.getByText('In use now', { exact: true })).toHaveCount(0);
    await back.click();
    await open(bName, b);
    await turnOn.click();
    await expect(saved.getByText('In use now', { exact: true })).toBeVisible();
  } finally { await host.app.close(); host.db.close(); }
});

for (const scope of ['PERSONAL', 'TEAM']) for (const width of [1440, 390]) test(`${scope}: joined lifecycle Studio and exact HTTP readback after restart at ${width}px`, async ({ page }, info) => {
  const dir = mkdtempSync(info.outputPath('bundle-')), path = join(dir, 'app.sqlite');
  let db = openData(path), app;
  try {
    const host = await fixture({ db, loseWrite: true });
    app = host.app;
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    await enter(page, host, scope);
    await expect(page.getByText('Describe what should happen when you save or complete a task.')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message to Daymark assistant' })).toHaveCount(1);
    const first = 'What kinds of rules can this project use?';
    await send(page, first);
    await expect(page.getByText(`Reply to ${first}`, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(`Reply to ${first}`, { exact: true })).toBeVisible();
    await send(page, bundleRequest);
    const proposed = page.getByRole('region', { name: 'Current proposal' });
    for (const [stage, text] of [['Before save', 'Before saving a new task'], ['After save', 'After a new task is saved'],
      ['After completion', 'After a task is completed']]) await expect(proposed.getByRole('region', { name: stage }).getByText(text)).toBeVisible();
    const triggerText = async panel => {
      const created = panel.getByRole('region', { name: 'After save' });
      for (const text of [/newly saved task’s title/, /Copy the newly saved task’s priority/,
        /“Already checked” in the newly saved task’s project/, /90 elapsed seconds after creation/])
        await expect(created.getByText(text)).toBeVisible();
      if (scope === 'TEAM') await expect(created.getByText(/Link it to the newly saved task/)).toBeVisible();
      await expect(created).not.toContainText(/completed task|after completion/i);
      await expect(panel.getByRole('region', { name: 'After completion' }).getByText(/2 elapsed minutes after completion/)).toBeVisible();
    };
    await triggerText(proposed);
    const transcript = page.getByLabel('Studio conversation').locator('article > p');
    await expect(transcript).toHaveText([first, `Reply to ${first}`, bundleRequest,
      'Review the proposed behavior and expected examples. Confirm saves and checks it without turning it on.']);
    await proposed.getByRole('button', { name: 'Confirm and check' }).click();
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await triggerText(saved);
    for (const [stage, expected] of [['Before save', correction], ['After save', 'File the receipt check.*12:01:30.417 UTC'], ['After completion', 'Archive receipt.*12:02:00.417 UTC']]) {
      const panel = saved.getByRole('region', { name: stage });
      await panel.getByText('Checked examples', { exact: true }).click();
      await expect(panel.getByText(new RegExp(`In the isolated example: .*${expected}`))).toBeVisible();
    }
    if (scope === 'TEAM') await expect(saved.getByText(/In the isolated example:.*linked to the newly saved task/)).toBeVisible();
    await page.screenshot({ path: info.outputPath('joined-lifecycle.png') });
    await saved.getByRole('button', { name: 'Approve this draft' }).click();
    await expect(saved.getByText('Approved · Not on yet')).toBeVisible();
    await saved.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(saved.getByText('In use now', { exact: true })).toBeVisible();
    const session = await (await page.request.get(`${host.origin}/api/session`)).json();
    const headers = { origin: host.origin, 'x-session-context': session.contextToken };
    const projectId = host.requests.at(-1).currentContext.beforeCreateProjects[0].id;
    const make = (notes, priority = 'normal') => page.request.post(`${host.origin}/api/tasks`, {
      headers: { ...headers, 'x-task-create-id': randomUUID() },
      data: { title: 'File the receipt', projectId, tags: ['receipt'], notes, priority },
    });
    expect((await make(' ')).status()).toBe(422);
    const made = await make('Recorded.', 'high');
    expect(made.status(), await made.text()).toBe(201);
    const root = await made.json();
    const reaction = (hook, reconcile = false) => `/api/tasks/${root.id}/reaction${reconcile ? '/reconcile' : ''}?trigger=${hook}`;
    const read = async hook => (await page.request.get(host.origin + reaction(hook), { headers })).json();
    await expect.poll(async () => (await read('TaskCreated')).outcome?.classification).toBe('UNCERTAIN');
    const completed = await page.request.post(`${host.origin}/api/tasks/${root.id}/complete`, { headers, data: {} });
    expect(completed.ok()).toBe(true);
    const { completedAt } = await completed.json();
    await expect.poll(async () => (await read('TaskCompleted')).outcome?.classification).toBe('UNCERTAIN');
    const original = await Promise.all(['TaskCreated', 'TaskCompleted'].map(read));
    expect(original[0].revisionId).toBe(original[1].revisionId);
    expect(original[0].originalKey).not.toBe(original[1].originalKey);
    expect(original[0].receipt.value.id).not.toBe(original[1].receipt.value.id);
    const resultTask = async i => (await page.request.get(`${host.origin}/api/tasks/${original[i].receipt.value.id}`, { headers })).json();
    expect(await resultTask(0)).toMatchObject({ title: 'File the receipt check', priority: 'high', tags: ['receipt-check', 'handoff-ready'],
      dueAt: new Date(Date.parse(root.createdAt) + 90_000).toISOString(), ...(scope === 'TEAM' && { parentTaskId: root.id, assigneeId: 'leo' }) });
    expect(await resultTask(1)).toMatchObject({ title: 'Archive receipt', dueAt: new Date(Date.parse(completedAt) + 120_000).toISOString() });
    expect(host.writes()).toBe(2);
    if (width === 390) {
      if (scope === 'TEAM') {
         await page.getByText('More', { exact: true }).click();
         await expect(page.getByRole('region', { name: 'Saved Team history and controls' })).toBeVisible();
         await expect(page.getByText('A Shared Studio rule is on for new tasks.', { exact: false })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Turn off for new tasks', exact: true })).toBeVisible();
         await expect(page.getByRole('textbox', { name: 'Message to Daymark assistant' })).toHaveCount(1);
         await expect(page.getByRole('button', { name: 'Open earlier Team work' })).toHaveCount(0);
        await page.getByText('Advanced: emergency revocation', { exact: true }).click();
        await expect(page.getByLabel('Version to revoke')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Check examples', exact: true })).toHaveCount(0);
      } else {
        await page.getByRole('button', { name: 'Turn off', exact: true }).click();
        await page.getByRole('button', { name: 'Confirm turn off', exact: true }).click();
        await expect(saved.getByText('In use now', { exact: true })).toHaveCount(0);
        expect(host.db.prepare("SELECT revision_id FROM extension_selections WHERE owner_id='maya' ORDER BY hook_id").all().map(row => row.revision_id))
          .toEqual([null, null, null]);
      }
    }
    await app.close(); app = null; db.close(); db = null;

    db = openData(path);
    let replayed = 0;
    app = await createApp({ db, origin: host.origin, sharedCompletionWriteReply(result) { replayed++; return result; } });
    const originHeaders = { origin: host.origin, host: new URL(host.origin).host };
    const anonymous = (await app.inject({ url: '/api/session', headers: originHeaders })).json();
    const login = await app.inject({ method: 'POST', url: '/api/session', headers: { ...originHeaders, 'x-session-context': anonymous.contextToken }, payload: { userId: 'maya' } });
    expect(login.statusCode).toBe(200);
    const authorized = { ...originHeaders, 'x-session-context': login.json().contextToken,
      cookie: login.cookies.map(({ name, value }) => `${name}=${value}`).join('; ') };
    for (const [i, hook] of ['TaskCreated', 'TaskCompleted'].entries()) {
      const reply = await app.inject({ method: 'POST', url: reaction(hook, true), headers: authorized, payload: {} });
      expect(reply.statusCode, reply.body).toBe(200);
      expect(reply.json()).toMatchObject({ originalKey: original[i].originalKey, outcome: original[i].outcome,
        receipt: original[i].receipt, reconciliation: { receipt: original[i].receipt } });
    }
    expect(replayed).toBe(0);
  } finally { await app?.close(); db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Personal before-create keeps fixed project identity across equivalent names and rename', async ({ page }, info) => {
  const host = await fixture({ intake: true });
  const plain = await createApp({ db: host.db, origin: host.origin, compiler: createCompiler() });
  const [first, second, inaccessible] = host.intakeProjects;
  try {
    const storedName = id => host.db.prepare('SELECT CAST(name AS BLOB) name FROM projects WHERE id=?').get(id).name;
    for (const [i, id] of [first, second].entries()) expect(Buffer.from(storedName(id))).toEqual(Buffer.from(cafeNames[i]));
    const authority = { host: new URL(host.origin).host, origin: host.origin };
    const session = await plain.inject({ url: '/api/session', headers: authority });
    expect(session.statusCode).toBe(200);
    const login = await plain.inject({ method: 'POST', url: '/api/session', payload: { userId: 'maya' },
      headers: { ...authority, 'x-session-context': session.json().contextToken } });
    expect(login.statusCode).toBe(200);
    const headers = { ...authority, 'x-session-context': login.json().contextToken,
      cookie: login.cookies.map(({ name, value }) => `${name}=${value}`).join('; ') };
    const create = (projectId, id, title) => plain.inject({ method: 'POST', url: '/api/tasks',
      payload: { projectId, title, tags: ['intake'] }, headers: { ...headers, 'x-task-create-id': id } });
    expect((await create(first, randomUUID(), 'Ordinary default save')).statusCode).toBe(201);

    await enter(page, host, 'PERSONAL');
    await send(page, exactProjectGuard);
    const checkLabels = async (panel, checked = false, names = cafeNames) => {
       const labels = names.map((name, i) => `“${name}”${names[0].normalize() === names[1].normalize() ? ` (project ${i + 1})` : ''}`);
      await expect(panel.getByText(`Project: ${labels[0]}.`, { exact: true })).toBeVisible();
      const examples = panel.locator('details').filter({ hasText: checked ? 'Checked examples' : 'Expected examples · Not checked' });
      if (await examples.getAttribute('open') === null) await examples.locator('summary').click();
      const rows = examples.getByRole('listitem');
      for (const [index, outcome] of [`Do not save. “${correction}”`, 'Allow normal save checks to continue.'].entries()) {
        const row = rows.nth(index);
        await expect(row).toContainText(`${labels[index]} · normal priority · No notes · No due date`);
        await expect(row.getByText('Tags: “intake”.')).toBeVisible();
        await expect(row.getByText(`Expected: ${outcome}`, { exact: true })).toBeVisible();
        if (checked) await expect(row.getByText(`In the isolated example: ${outcome}`, { exact: true })).toBeVisible();
      }
       for (const id of [first, second, inaccessible]) await expect(panel).not.toContainText(id);
    };
    const proposal = page.getByRole('region', { name: 'Current proposal' });
    await checkLabels(proposal);
    await proposal.getByRole('button', { name: 'Confirm and check' }).click();
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await checkLabels(saved, true);
    await page.screenshot({ path: info.outputPath('fixed-project-identity.png') });
    const readProof = () => host.db.prepare('SELECT id,revision_id,suite_identity,payload FROM extension_evidence').all();
    const proof = readProof();
    expect(proof).toHaveLength(1);
    const renamed = 'Cafe\u0301 Intake';
    const rename = await plain.inject({ method: 'PATCH', url: `/api/projects/${first}`, headers, payload: { name: renamed } });
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toMatchObject({ id: first, name: renamed });
    expect(Buffer.from(storedName(first))).toEqual(Buffer.from(renamed));
    await page.getByRole('button', { name: 'Read saved state', exact: true }).click();
    await checkLabels(saved, true, [renamed, cafeNames[1]]);
    expect(readProof()).toEqual(proof);
    await saved.getByRole('button', { name: 'Approve this draft' }).click();
    await saved.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(saved.getByRole('button', { name: 'Turn on', exact: true })).toHaveCount(0);

    const selected = host.db.prepare(`SELECT s.revision_id, l.extension_id FROM extension_selections s JOIN extension_revision_links l
      ON l.owner_id=s.owner_id AND l.revision_id=s.revision_id WHERE s.owner_id='maya' AND s.hook_id='TaskBeforeCreate'`).get();
    const exact = createLifecycle(host.db).source('maya', selected.revision_id, selected.extension_id).ruleDescription;
    expect(exact).toMatchObject({ coverage: 'complete', guard: { conditions: expect.arrayContaining([{ field: 'projectId', value: first }]) } });
    const count = () => ['tasks', 'task_events'].map(table => host.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
    const before = count();
    const operationId = randomUUID(), blocked = await create(first, operationId, 'Blocked in the chosen project');
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ operationId, state: 'NOT_CREATED', code: 'RULE_DENIED' });
    expect((await plain.inject({ url: `/api/task-create-operations/${operationId}`, headers })).json()).toEqual(blocked.json());
    expect(count()).toEqual(before);
    expect((await create(second, randomUUID(), 'Allowed in the other project')).statusCode).toBe(201);
  } finally { await plain.close(); await host.app.close(); host.db.close(); }
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: before-create decision in Studio and native Tasks`, async ({ page }, info) => {
  const host = await fixture();
  const team = scope === 'TEAM';
  try {
    await page.setViewportSize(team ? { width: 390, height: 844 } : { width: 1440, height: 960 });
    await enter(page, host, scope);
    await send(page, guardRequest);
    const card = page.getByRole('region', { name: 'Current proposal' });
    await expect(card.getByText('Before saving a new task')).toBeVisible();
    if (team) await expect(card.getByText(/does not check tasks generated by earlier pinned rules/)).toBeVisible();
    await expect(card.getByText(`If all conditions match, do not save. Show “${correction}”.`)).toBeVisible();
    await card.getByText('Expected examples · Not checked').click();
    await expect(card.getByText(`Expected: Do not save. “${correction}”`)).toBeVisible();
    await expect(card.getByText('Expected: Allow normal save checks to continue.')).toBeVisible();
    await card.getByRole('button', { name: 'Confirm and check' }).click();
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await saved.getByText('Checked examples').click();
    await expect(saved.getByText(`In the isolated example: Do not save. “${correction}”`)).toBeVisible();
    await expect(saved.getByText('In the isolated example: Allow normal save checks to continue.')).toBeVisible();
    await page.screenshot({ path: info.outputPath('before-create-proof.png') });
    const session = await (await page.request.get(host.origin + '/api/session')).json();
    const projectId = team ? host.team.id : host.requests.at(-1).currentContext.beforeCreateProjects[0].id;
    const api = (path, method, data, operation = randomUUID()) => page.request.fetch(host.origin + '/api/' + path, { method, data,
      headers: { origin: host.origin, 'x-session-context': session.contextToken, 'x-task-create-id': operation } });
    const fields = { projectId, title: 'Keep my draft', tags: [' Intake '], notes: ' ' };
    expect((await api('tasks', 'POST', { ...fields, title: 'Before approval' })).ok()).toBe(true);
    await saved.getByRole('button', { name: 'Approve this draft' }).click();
    expect((await api('tasks', 'POST', { ...fields, title: 'Before turn on' })).ok()).toBe(true);
    await saved.getByRole('button', { name: 'Turn on', exact: true }).click();
    const op = randomUUID(), refused = await api('tasks', 'POST', fields, op);
    expect(refused.status()).toBe(422);
    expect(await refused.json()).toMatchObject({ code: 'RULE_DENIED', message: correction });
    expect(await (await api(`task-create-operations/${op}`, 'GET')).json()).toMatchObject({ state: 'NOT_CREATED', code: 'RULE_DENIED' });
    await page.getByRole('button', { name: 'Back to tasks', exact: false }).click();
    const input = page.getByRole('textbox', { name: 'New task title' });
    await input.fill(fields.title);
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New task', exact: true });
    const add = dialog.getByRole('button', { name: 'Add task', exact: true });
    const tags = dialog.getByLabel('Tags', { exact: true }), notes = dialog.getByLabel('Notes (optional)', { exact: true });
    await tags.fill(' Intake ');
    await notes.fill(' ');
    await add.click();
    await expect(dialog.getByText(correction)).toBeVisible();
    await expect(dialog.getByLabel('Task title', { exact: true })).toHaveValue(fields.title);
    await expect(tags).toHaveValue(' Intake ');
    await expect(notes).toHaveValue(' ');
    await notes.fill('Intake done.');
    await add.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(fields.title, { exact: true })).toBeVisible();
  } finally { await host.app.close(); host.db.close(); }
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: normalized source tag in Studio and HTTP readback`, async ({ page }, info) => {
  const host = await fixture({ loseWrite: true });
  try {
    await page.setViewportSize(scope === 'TEAM' ? { width: 390, height: 844 } : { width: 1440, height: 960 });
    await enter(page, host, scope);
    await send(page, addTagRequest);
    const card = page.getByRole('region', { name: 'Current proposal' });
    await expect(card.getByText('Add tag “café” to the completed task. Keep its other fields as they are.')).toBeVisible();
    const shownTags = ['“samples⟦U+200B⟧”', '“samples⟦U+27E6⟧u+200b⟧”'];
    async function checkExamples(panel, checked = false) {
      const guards = panel.getByRole('list', { name: 'All conditions must match' });
      for (const tag of shownTags) await expect(guards.getByText(`Exact tag: ${tag}`, { exact: true })).toBeVisible();
      await expect(guards.getByText('The task has no due date.')).toBeVisible();
      const examples = panel.locator('details').filter({ hasText: checked ? 'Checked examples' : 'Expected examples · Not checked' });
      await examples.locator('summary').click();
      const rows = examples.getByRole('listitem');
      const skip = 'Do not update the completed task.';
      for (const [i, [due, outcome]] of [
        ['No due date', `Saved tags in order: ${shownTags.join(', ')}, “intake”, “café”.`],
        ['Due 2026-03-08 10:30:09.417 UTC', skip],
        ['Due 2026-03-07 16:00:00.417 UTC', skip],
        ['No due date', `Tags stay unchanged: “café”, ${shownTags.join(', ')}.`],
      ].entries()) {
        const row = rows.nth(i);
        await expect(row).toContainText(` · ${due} · `);
        await expect(row.getByText(`Expected: ${outcome}`, { exact: true })).toBeVisible();
        if (checked) await expect(row.getByText(`In the isolated example: ${outcome}`, { exact: true })).toBeVisible();
      }
    }
    await checkExamples(card);
    await card.getByRole('button', { name: 'Confirm and check' }).click();
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await checkExamples(saved, true);
    await page.screenshot({ path: info.outputPath('source-tag-proof.png') });
    await saved.getByRole('button', { name: 'Approve this draft' }).click();
    await saved.getByRole('button', { name: 'Turn on', exact: true }).click();
    const session = await (await page.request.get(host.origin + '/api/session')).json();
    const api = async (path, method = 'GET', data) => {
      const response = await page.request.fetch(host.origin + '/api/' + path, { method, data,
        headers: { origin: host.origin, 'x-session-context': session.contextToken, 'x-task-create-id': randomUUID() } });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const projectId = scope === 'TEAM' ? host.team.id : taskService(host.db).listProjects('maya').find(p => p.mode === 'PERSONAL').id;
    const fields = { projectId, title: 'Archive sample', notes: 'Keep\0this', priority: 'low', dueAt: null };
    const task = await api('tasks', 'POST', { ...fields, tags: tagInput });
    const target = `tasks/${task.id}`, reaction = `${target}/reaction`;
    await api(`${target}/complete`, 'POST', {});
    await expect.poll(async () => (await api(reaction)).outcome?.classification).toBe('UNCERTAIN');
    const uncertain = await api(reaction);
    expect(uncertain.receipt.value.id).toBe(task.id);
    expect(uncertain.observation.updated).toMatchObject({ before: { tags: tagInput }, after: { tags: [...tagInput, 'café'] } });
    expect(await api(target)).toMatchObject({ ...fields, tags: [...tagInput, 'café'] });
    await api(target, 'PATCH', { tags: ['human'] });
    const reconciled = await api(`${reaction}/reconcile`, 'POST', {});
    expect(reconciled.originalKey).toBe(uncertain.originalKey);
    expect(reconciled.outcome).toEqual(uncertain.outcome);
    expect(reconciled.reconciliation.receipt).toEqual(uncertain.receipt);
    expect(reconciled.reconciliation.observation).toEqual(uncertain.observation);
    await api(`${target}/complete`, 'POST', {});
    expect(host.writes()).toBe(1);
    expect(await api(target)).toMatchObject({ ...fields, tags: ['human'] });
  } finally { await host.app.close(); host.db.close(); }
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: exact source due date in Studio and HTTP readback`, async ({ page }, info) => {
  const clear = scope === 'TEAM', from = clear ? sourceDueInstant : null, to = clear ? null : sourceDueInstant;
  const host = await fixture({ loseWrite: true });
  try {
    await page.setViewportSize(clear ? { width: 390, height: 844 } : { width: 1440, height: 960 });
    await enter(page, host, scope);
    await send(page, sourceDueRequest(clear));
    const card = page.getByRole('region', { name: 'Current proposal' });
    const promised = clear ? 'Clear the completed task’s due date.' : 'Set the completed task’s due date to 2026-03-08 10:30:09.417 UTC.';
    await expect(card.getByText(promised + ' Keep its other fields as they are.')).toBeVisible();
    await card.getByRole('button', { name: 'Confirm and check' }).click();
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await saved.getByText('Checked examples').click();
    const observed = clear ? ['Clear the due date. No due date remains.', 'Still no due date.']
      : ['Set the due date to 2026-03-08 10:30:09.417 UTC.', 'Due date stays 2026-03-08 10:30:09.417 UTC.'];
    for (const outcome of [...observed, 'Do not update the completed task.'])
      await expect(saved.getByText(`In the isolated example: ${outcome}`, { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('source-due-proof.png') });
    await saved.getByRole('button', { name: 'Approve this draft' }).click();
    await saved.getByRole('button', { name: 'Turn on', exact: true }).click();
    const session = await (await page.request.get(host.origin + '/api/session')).json();
    const api = async (path, method = 'GET', data) => {
      const response = await page.request.fetch(host.origin + '/api/' + path, { method, data,
        headers: { origin: host.origin, 'x-session-context': session.contextToken, 'x-task-create-id': randomUUID() } });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const projectId = clear ? host.team.id : taskService(host.db).listProjects('maya').find(p => p.mode === 'PERSONAL').id;
    const fields = { projectId, title: 'Return samples', priority: 'low', tags: ['samples'], notes: 'Keep\0these notes' };
    const task = await api('tasks', 'POST', { ...fields, dueAt: from });
    const target = `tasks/${task.id}`, reaction = `${target}/reaction`;
    await api(`${target}/complete`, 'POST', {});
    await expect.poll(async () => (await api(reaction)).outcome?.classification).toBe('UNCERTAIN');
    const uncertain = await api(reaction);
    expect(uncertain.receipt.value.id).toBe(task.id);
    expect(uncertain.observation.updated).toMatchObject({ before: { dueAt: from }, after: { dueAt: to } });
    expect(await api(target)).toMatchObject({ ...fields, dueAt: to });
    await api(target, 'PATCH', { dueAt: occurredAt });
    const observedLater = await api(`${reaction}/reconcile`, 'POST', {});
    expect(observedLater.originalKey).toBe(uncertain.originalKey);
    expect(observedLater.outcome).toEqual(uncertain.outcome);
    expect(observedLater.reconciliation.receipt).toEqual(uncertain.receipt);
    expect(observedLater.reconciliation.observation).toEqual(uncertain.observation);
    await api(`${target}/complete`, 'POST', {});
    expect(host.writes()).toBe(1);
    expect(await api(target)).toMatchObject({ ...fields, dueAt: occurredAt });
  } finally { await host.app.close(); host.db.close(); }
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: source priority examples and HTTP receipt readback`, async ({ page }, info) => {
  let lose = false;
  const host = await fixture({ loseWrite: () => lose });
  try {
    await page.setViewportSize(scope === 'TEAM' ? { width: 390, height: 844 } : { width: 1440, height: 960 });
    await enter(page, host, scope);
    await send(page, priorityRequest);
    const card = page.getByRole('region', { name: 'Current proposal' });
    await expect(card.getByText('Set the completed task’s priority to high. Keep its other fields as they are.')).toBeVisible();
    await card.getByRole('button', { name: 'Confirm and check' }).click();
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await saved.getByText('Checked examples').click();
    for (const result of ['Change priority from normal to high.', 'Priority stays high.', 'Do not update the completed task.'])
      await expect(saved.getByText(`In the isolated example: ${result}`, { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('source-priority-proof.png') });
    await saved.getByRole('button', { name: 'Approve this draft' }).click();
    await saved.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(saved.getByText('In use now')).toBeVisible();
    const session = await (await page.request.get(host.origin + '/api/session')).json();
    const api = async (path, method = 'GET', data) => {
      const response = await page.request.fetch(host.origin + '/api/' + path, { method, data,
        headers: { origin: host.origin, 'x-session-context': session.contextToken, 'x-task-create-id': randomUUID() } });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const projectId = scope === 'TEAM' ? host.team.id : taskService(host.db).listProjects('maya').find(p => p.mode === 'PERSONAL').id;
    const create = priority => api('tasks', 'POST', { projectId, title: 'Send summary', notes: 'Keep\0this', tags: ['urgent'], priority, dueAt: occurredAt });
    const settle = async task => {
      await api(`tasks/${task.id}/complete`, 'POST', {});
      await expect.poll(async () => (await api(`tasks/${task.id}/reaction`)).state).toBe('FINISHED');
      return api(`tasks/${task.id}/reaction`);
    };
    const normal = await create('normal'), written = await settle(normal);
    expect(written.outcome.classification, JSON.stringify(written)).toBe('COMPLETED');
    expect(written.observation.updated).toMatchObject({ id: normal.id, before: { priority: 'normal' }, after: { priority: 'high' } });
    const equal = await settle(await create('high'));
    expect(equal.observation.updated.before).toEqual(equal.observation.updated.after);
    host.db.exec(`CREATE TEMP TRIGGER test_missing_priority_fence AFTER INSERT ON shared_priority_fences
      BEGIN DELETE FROM shared_priority_fences WHERE source_id=NEW.source_id; END`);
    const rejected = await settle(await create('normal'));
    expect(rejected.outcome.classification).toBe('BUSINESS_REJECTION');
    expect(rejected.receipt).toBeNull();
    host.db.exec('DROP TRIGGER test_missing_priority_fence');
    lose = true;
    const task = await create('normal'), uncertain = await settle(task);
    expect(uncertain.outcome.classification).toBe('UNCERTAIN');
    expect(uncertain.receipt.value.id).toBe(task.id);
    const target = `tasks/${task.id}`;
    expect(await api(target)).toMatchObject({ priority: 'high', notes: 'Keep\0this', tags: ['urgent'], dueAt: occurredAt, projectId });
    await api(target, 'PATCH', { priority: 'low' });
    const before = host.writes();
    const observation = await api(`${target}/reaction/reconcile`, 'POST', {});
    expect(observation.originalKey).toBe(uncertain.originalKey);
    expect(observation.outcome).toEqual(uncertain.outcome);
    expect(observation.reconciliation.receipt).toEqual(uncertain.receipt);
    expect(observation.reconciliation.observation).toEqual(uncertain.observation);
    await api(`${target}/complete`, 'POST', {});
    expect(host.writes()).toBe(before);
    expect((await api(target)).priority).toBe('low');
  } finally { await host.app.close(); host.db.close(); }
});

test('same-project exact lookup is readable and checks both outcomes', async ({ page }, info) => {
  const host = await fixture();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await enter(page, host, 'TEAM');
    await send(page, lookupRequest);
    const card = page.getByRole('region', { name: 'Current proposal' });
    await expect(card.getByText('No open task titled “Dispatch audit” in the completed task’s project (exact, case-sensitive title).')).toBeVisible();
    await expect(card.getByText(/not a uniqueness guarantee/)).toBeVisible();
    const distinctTitles = async region => {
      const open = region.getByText(/^Already open in this project:/).last();
      await expect(open.getByText('“A⟦U+0000⟧B”', { exact: true })).toBeVisible();
      await expect(open.getByText('“A⟦U+27E6⟧U+0000⟧B”', { exact: true })).toBeVisible();
      return open;
    };
    await card.getByText('Expected examples · Not checked').click();
    await distinctTitles(card);
    await card.getByRole('button', { name: 'Confirm and check' }).click();
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await expect(saved.getByRole('button', { name: 'Approve this draft' })).toBeEnabled();
    await saved.getByText('Checked examples').click();
    const open = await distinctTitles(saved);
    await expect(saved.getByText('Finish dispatch⟦U+200B⟧', { exact: true }).first()).toBeVisible();
    await expect(saved.getByText('In the isolated example: Create nothing.', { exact: true })).toBeVisible();
    await expect(saved.getByText(/In the isolated example: Create “Dispatch audit” in the same project/)).toBeVisible();
    const gapWidths = await open.locator('.exact-title').evaluateAll(nodes => nodes
      .filter(node => /Dispatch +audit/u.test(node.textContent))
      .map(node => {
        const range = document.createRange(), gap = / +/u.exec(node.textContent);
        range.setStart(node.firstChild, gap.index);
        range.setEnd(node.firstChild, gap.index + gap[0].length);
        return range.getBoundingClientRect().width;
      }));
    expect(gapWidths).toHaveLength(2);
    expect(gapWidths[0]).toBeGreaterThan(0);
    expect(gapWidths[1] / gapWidths[0]).toBeCloseTo(2, 1);
    await expect(saved.locator('li .exact-title').first()).toHaveCSS('white-space', 'break-spaces');
    await expect(saved).not.toContainText(/tasks\.openMatch|sha256:/);
    await page.screenshot({ path: info.outputPath('lookup-proof.png') });
  } finally { await host.app.close(); host.db.close(); }
});

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: complete creation fields read plainly in the proposal and proof`, async ({ page }, info) => {
  const host = await fixture();
  try {
    await page.setViewportSize(scope === 'TEAM' ? { width: 390, height: 844 } : { width: 1440, height: 960 });
    await enter(page, host, scope);
    await send(page, handoffRequest(scope === 'TEAM'));
    const card = page.getByRole('region', { name: 'Current proposal' });
    await expect(card.getByText(/Create one task in the same project/)).toBeVisible();
    const readable = /Notes:\s*“Check the café queue\.\s+Use the north desk\.”\.\s*Tags: needs review, handoff\.\s*Priority: high\./;
    await expect(card.getByRole('paragraph').filter({ hasText: readable })).toBeVisible();
    await card.getByText('Expected examples · Not checked').click();
    await expect(card.getByText(/Expected:\s*Create “Handoff: Pack samples” in the same project, no due date/)).toContainText(readable);
    await card.getByRole('button', { name: 'Confirm and check' }).click();
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await saved.getByText('Checked examples').click();
    const observed = saved.getByText(/In the isolated example:\s*Create “Handoff: Pack samples” in the same project, no due date/);
    await expect(observed).toContainText(readable);
    if (scope === 'TEAM') await expect(observed).toContainText('linked to the completed task, assigned to Leo');
    await expect(saved.getByRole('button', { name: 'Approve this draft' })).toBeEnabled();
    await expect(saved).not.toContainText(/SAME_PROJECT|tagsText|TaskCompleted|sha256:/);
    expect(await saved.evaluate(node => node.scrollWidth <= node.clientWidth + 2)).toBe(true);
    await page.screenshot({ path: info.outputPath('creation-proof.png') });
  } finally { await host.app.close(); host.db.close(); }
});

for (const scope of ['PERSONAL', 'TEAM']) for (const width of [1440, 390]) {
  test(`${scope} at ${width}: shared Studio exact offer, separate activation and native effect`, async ({ browser }, testInfo) => {
    const lost = scope === 'PERSONAL' && width === 1440;
    const host = await fixture({ lost, loseWrite: true });
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 960 }, hasTouch: width === 390 });
    const page = await context.newPage();
    try {
      await enter(page, host, scope);
      await send(page, 'Discuss possibilities.');
      await expect(page.getByText('Reply to Discuss possibilities.')).toBeVisible();
      expect(host.compilations()).toBe(0);
      await send(page, 'Propose a follow-up.');
      const card = page.getByRole('region', { name: 'Current proposal' });
      await expect(card.getByText('After a task is completed')).toBeVisible();
      await expect(card.getByText(scope === 'TEAM' ? 'Exact title: Dispatch' : 'Exact title: Archive')).toBeVisible();
      await expect(card.getByText(scope === 'TEAM' ? /Assign it to Leo/ : /Leave it unassigned/)).toBeVisible();
      await card.getByText('Expected examples · Not checked').click();
      await expect(card.getByText('Expected: Create nothing.')).toBeVisible();
      expect(host.compilations()).toBe(1);
      expect(host.db.prepare('SELECT (SELECT count(*) FROM extension_revisions)+(SELECT count(*) FROM team_revisions) AS n').get().n).toBe(0);
      await expect(card).not.toContainText(/keir\/3|TaskCompleted|sha256:/);
      if (width === 390) expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 2)).toBe(true);
      await card.getByRole('button', { name: 'Confirm and check' }).click();
      if (lost) {
        await expect(page.getByRole('alert')).toContainText('confirmation reply is unavailable');
        await page.getByRole('button', { name: 'Read saved state' }).click();
      }
      const saved = page.getByRole('region', { name: 'Saved draft' });
      await expect(saved.getByText('Checked examples')).toBeVisible();
      expect(host.compilations()).toBe(2);
      await expect(saved.getByRole('button', { name: 'Turn on', exact: true })).toHaveCount(0);
      await saved.getByRole('button', { name: 'Approve this draft' }).click();
      await expect(saved.getByText('Approved · Not on yet')).toBeVisible();
      await saved.getByRole('button', { name: 'Turn on', exact: true }).click();
      await expect(saved.getByText('In use now')).toBeVisible();

      const api = async (path, body, create = false) => {
        const info = await (await page.request.get(host.origin + '/api/session')).json();
        const response = await page.request.fetch(host.origin + '/api/' + path, { method: body ? 'POST' : 'GET', data: body,
          headers: { 'x-session-context': info.contextToken, origin: host.origin, ...(create && { 'x-task-create-id': randomUUID() }) } });
        expect(response.ok(), await response.text()).toBe(true);
        return response.json();
      };
      const projectId = scope === 'TEAM' ? host.team.id : taskService(host.db).listProjects('maya').find(p => p.mode === 'PERSONAL').id;
      const source = await api('tasks', { projectId, title: scope === 'TEAM' ? 'Dispatch' : 'Archive',
        tags: scope === 'TEAM' ? ['ready'] : ['review'] }, true);
      await api(`tasks/${source.id}/complete`, {});
      const reaction = `tasks/${source.id}/reaction`;
      await expect.poll(async () => (await api(reaction)).outcome?.classification).toBe('UNCERTAIN');
      const before = await api(reaction), count = () => host.db.prepare('SELECT count(*) n FROM tasks').get().n;
      const taskCount = count(), checked = await api(reaction + '/reconcile', {});
      expect(checked.reconciliation.receipt).toEqual(before.receipt);
      expect(checked.outcome).toEqual(before.outcome);
      expect(checked.originalKey).toBe(before.originalKey);
      expect(checked.receipt.effect).toBe('CONFIRMED');
      expect(checked.linked).toBe(scope === 'TEAM');
      const result = await api('tasks/' + checked.receipt.value.id);
      expect(result.title).toBe('Initial check');
      expect(result.parentTaskId ?? null).toBe(scope === 'TEAM' ? source.id : null);
      expect(result.assigneeId ?? null).toBe(scope === 'TEAM' ? 'leo' : null);
      expect(Date.parse(result.dueAt) - Date.parse(host.db.prepare('SELECT completed_at FROM tasks WHERE id=?').get(source.id).completed_at))
        .toBe((scope === 'TEAM' ? 172800 : 3600) * 1000);
      expect((await api(reaction + '?trigger=TaskCreated')).receipt).toBeNull();
      await api(`tasks/${source.id}/complete`, {});
      expect((await api(reaction + '/reconcile', {})).receipt).toEqual(before.receipt);
      expect(host.writes()).toBe(1);
      expect(count()).toBe(taskCount);
      if (width === 1440) {
        const outsider = await browser.newContext();
        try {
          const headers = await signIn(outsider.request, host, 'sam');
          expect((await outsider.request.get(host.origin + '/api/' + reaction, { headers })).status()).toBe(404);
          expect((await outsider.request.post(host.origin + '/api/' + reaction + '/reconcile', { headers, data: {} })).status()).toBe(404);
        } finally { await outsider.close(); }
      }
      await page.screenshot({ path: testInfo.outputPath('activated.png'), fullPage: true });
    } finally { await context.close(); await host.app.close(); host.db.close(); }
  });
}

for (const scope of ['PERSONAL', 'TEAM']) test(`${scope}: stop a shared Confirm and read the same outcome without replay`, async ({ page }) => {
  const host = await fixture();
  let release;
  try {
    await enter(page, host, scope);
    await send(page, 'Propose a follow-up.');
    const confirm = page.getByRole('button', { name: 'Confirm and check' });
    await expect(confirm).toBeVisible();
    release = host.hold();
    await confirm.click();
    await expect.poll(host.awaiting).toBe(true);
    const stop = page.getByRole('button', { name: 'Stop', exact: true });
    await stop.click();
    await expect(stop).toBeDisabled();
    release();
    await expect(page.getByRole('status').filter({ hasText: 'No draft was saved.' })).toBeVisible();
    await page.getByRole('button', { name: 'Read saved state' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'No draft was saved.' })).toBeVisible();
    await expect(confirm).toHaveCount(0);
    expect(host.compilations()).toBe(2);
    expect(host.db.prepare('SELECT (SELECT count(*) FROM extension_revisions)+(SELECT count(*) FROM team_revisions) AS n').get().n).toBe(0);
  } finally { release?.(); await host.app.close(); host.db.close(); }
});

test('older messages keep their anchor and typed offer facts support a scoped edit', async ({ page }) => {
  const host = await fixture();
  try {
    await enter(page, host, 'TEAM');
    await send(page, 'Propose a follow-up.');
    await expect(page.getByRole('button', { name: 'Confirm and check' })).toBeVisible();
    const old = JSON.parse(host.db.prepare("SELECT view FROM authoring_conversations WHERE json_extract(state,'$.targetKey')=?").get('TEAM:' + host.team.id).view).proposal;
    const seen = await (await page.request.get(host.origin + '/api/session')).json();
    const path = `${host.origin}/api/shared-studio/${encodeURIComponent('TEAM:' + host.team.id)}`;
    const headers = { 'x-session-context': seen.contextToken, origin: host.origin };
    const first = (await (await page.request.get(path, { headers })).json()).conversation;
    expect(first.offer.digest).toMatch(/^sha256:/);
    expect(old.offer.bindings.TaskCompleted).toContain('Initial check');
    for (let i = 1; i <= 11; i++) {
      await send(page, `Discussion ${i}`);
      await expect(page.getByText(`Reply to Discussion ${i}`, { exact: true })).toBeAttached();
    }
    await page.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
    await page.getByRole('button', { name: /^(Open Studio|New customization)$/ }).click();
    const view = page.getByLabel('Studio conversation');
    await expect(view).toBeVisible();
    await view.evaluate(node => { node.scrollTop = 0; });
    const initial = view.locator('article').first();
    const sequence = await initial.getAttribute('data-sequence');
    const offset = () => view.locator(`[data-sequence="${sequence}"]`).evaluate(node => node.getBoundingClientRect().top - node.parentElement.getBoundingClientRect().top);
    const earlier = await offset();
    await page.getByRole('button', { name: 'Load earlier messages' }).click();
    await expect(view.getByText('Propose a follow-up.', { exact: true })).toBeAttached();
    expect(Math.abs((await offset()) - earlier)).toBeLessThan(4);
    await expect(view.getByText('Proposal from this turn')).toBeAttached();
    await expect(view.getByRole('button', { name: 'Confirm and check' })).toHaveCount(0);
    expect((await page.request.post(path + '/confirm', { headers, data: {
      runId: first.runId, expectedVersion: first.version, offerDigest: first.offer.digest,
    } })).status()).toBe(409);
    await send(page, 'Use the same behavior, but title the new task Queue check.');
    await expect(view.getByRole('region', { name: 'Current proposal' }).getByText('Create one task in the same project with “Queue check” as its title.')).toBeAttached();
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    await page.getByRole('button', { name: 'Jump to latest' }).click();
    await expect(view.getByRole('region', { name: 'Current proposal' })).toBeInViewport();
    expect(host.requests.at(-1).currentContext.priorOffer.stages[0].title.value).toBe('Initial check');
    expect(host.db.prepare('SELECT count(*) n FROM team_revisions').get().n).toBe(0);
  } finally { await host.app.close(); host.db.close(); }
});

test('default Studio enforces current Team admin and scope', async ({ request }) => {
  const host = await fixture();
  try {
    const target = host.origin + '/api/shared-studio/TEAM:' + host.team.id;
    expect((await request.get(target)).status()).toBe(401);
    const headers = await signIn(request, host, 'leo');
    expect((await request.get(target, { headers })).status()).toBe(403);
    expect((await request.get(host.origin + '/api/shared-studio/PERSONAL:' + host.team.id, { headers })).status()).toBe(404);
    const admin = await signIn(request, host, 'maya');
    expect((await request.get(target, { headers: admin })).status()).toBe(200);
  } finally { await host.app.close(); host.db.close(); }
});

test('ordinary HTTP completion with the provider off keeps legacy pins and readers', async ({ request, page }) => {
  const host = await fixture({ providerOff: true });
  try {
      await enter(page, host, 'PERSONAL');
      await expect(page.getByRole('button', { name: 'Configure', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
       await expect(page.getByText('Earlier Personal rule options', { exact: true })).toHaveCount(0);
       const earlier = admitTaskDraft(host.db, createLifecycle(host.db), { name: 'Earlier Personal draft' });
       await page.goto(`${host.origin}/#customization=${earlier.extensionId}`);
       await expect(page.getByRole('heading', { name: 'Earlier Personal draft', exact: true })).toBeVisible();
      const headers = await signIn(request, host, 'maya');
      const personalId = taskService(host.db).listProjects('maya').find(item => item.mode === 'PERSONAL').id;
      const legacy = seedTaskEffectBinding(host.db);
      host.db.prepare("UPDATE extension_selections SET revision_id=?,binding_pins=?,generation=1 WHERE owner_id='maya' AND hook_id='TaskCompleted'")
        .run(legacy.revisionId, JSON.stringify(legacy.pins));
      installTeamRevision(host.db, 'maya', host.team.id, 'legacy-policy', { TaskCreated: null, TaskBeforeComplete: null });
      teamProjectService(host.db).setSelection('maya', host.team.id, 'legacy-policy');
      for (const projectId of [personalId, host.team.id]) {
        const created = await request.post(host.origin + '/api/tasks', { headers: { ...headers, 'x-task-create-id': randomUUID() },
          data: { projectId, title: 'Ordinary task' } });
        expect(created.status(), await created.text()).toBe(201);
        const task = await created.json(), path = `${host.origin}/api/tasks/${task.id}`;
        const completed = await request.post(path + '/complete', { headers, data: {} });
        expect(completed.ok(), await completed.text()).toBe(true);
        expect((await completed.json()).status).toBe('completed');
        if (projectId === personalId) {
          const saved = await (await request.get(path + '/reaction', { headers })).json();
          expect(saved.workflow).toBe(true);
          expect(saved.linked).toBeUndefined();
          const checked = await request.post(path + '/reaction/reconcile', { headers, data: {} });
          expect(checked.ok(), await checked.text()).toBe(true);
          expect((await checked.json()).reconciliation.observedAt).toBeTruthy();
        } else {
          expect((await (await request.get(path + '/reaction', { headers })).json()).state).toBe('NO_BINDING');
          const checked = await request.post(path + '/reaction/reconcile?trigger=TaskCreated', { headers, data: {} });
          expect(checked.ok(), await checked.text()).toBe(true);
          expect((await checked.json()).revisionId).toBe('legacy-policy');
        }
      }
      expect(host.db.prepare('SELECT count(*) n FROM shared_completion_events').get().n).toBe(0);
      expect(host.requests).toHaveLength(0);
  } finally { await host.app.close(); host.db.close(); }
});

test('a stale Confirm is a known rejection; due evidence preserves fractional differences', async ({ page }) => {
  const host = await fixture({ dueMismatch: true });
  try {
    await enter(page, host, 'PERSONAL');
    await send(page, 'Propose a follow-up.');
    const card = page.getByRole('region', { name: 'Current proposal' });
    await expect(card).toBeVisible();
    const target = host.db.prepare(`SELECT json_extract(state,'$.targetKey') target FROM authoring_conversations
      WHERE json_extract(state,'$.targetKey') IS NOT NULL`).get().target;
    const headers = { 'x-session-context': (await (await page.request.get(host.origin + '/api/session')).json()).contextToken };
    host.db.prepare("UPDATE extension_selections SET generation=generation+1 WHERE owner_id='maya' AND hook_id='TaskCompleted'").run();
    const stale = await (await page.request.get(host.origin + '/api/shared-studio/' + encodeURIComponent(target), { headers })).json();
    expect(stale.conversation).toMatchObject({ offer: null, canConfirm: false, offerStale: true });
    await card.getByRole('button', { name: 'Confirm and check' }).click();
    await expect(page.getByRole('alert')).toHaveText('This offer has changed. Nothing was saved by this confirmation.');
    await expect(card).toHaveCount(0);
    expect(host.compilations()).toBe(1);
    await send(page, 'Propose a follow-up.');
    await card.getByText('Expected examples · Not checked').click();
    await expect(card.getByText(/Expected: .*17:00:00\.418 UTC/)).toBeVisible();
    await card.getByRole('button', { name: 'Confirm and check' }).click();
    const saved = page.getByRole('region', { name: 'Saved draft' });
    await saved.getByText('Checked examples').click();
    await expect(saved.getByText(/Expected: .*17:00:00\.418 UTC/)).toBeVisible();
    await expect(saved.getByText(/In the isolated example: .*17:00:00\.417 UTC/)).toBeVisible();
    await expect(saved.getByRole('button', { name: 'Approve this draft' })).toHaveCount(0);
  } finally { await host.app.close(); host.db.close(); }
});
