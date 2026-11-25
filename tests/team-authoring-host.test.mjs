import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthoringState, runAuthoringTurn } from '../src/keir-authoring-agent.mjs';
import { openData, taskService } from '../src/data.mjs';
import { createTeamCapability } from '../src/team-capability.mjs';
import { teamProjectService } from '../src/team-native.mjs';
import { teamAuthoringHost, teamConversationTools, teamConversationHandlers } from '../src/team-authoring-host.mjs';
import { expandTeamOffer } from '../src/team-business-offer.mjs';
import { triageOffer, linkedOffer, linkedSourceLookalike, triageProposal, offerSources, nestedOfferCalls, allowMissingReview } from './fixtures/team-authored.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { teamModel, teamModelBytes } from '../src/team-runtime.mjs';
import { digest, json } from '../src/extension-catalog.mjs';

function project(db) {
  const { id } = taskService(db).createProject('maya', { name: 'Launch', mode: 'TEAM' });
  const projects = teamProjectService(db);
  projects.addMember('maya', id, { userId: 'leo' });
  projects.addMember('maya', id, { userId: 'sam' });
  return id;
}
const hostFor = (db, capability, projectId) => teamAuthoringHost({
  capability, projects: teamProjectService(db), actor: 'maya', projectId, authorize: () => 'maya',
});
const members = [{ id: 'maya', role: 'ADMIN' }, { id: 'leo', role: 'MEMBER' }, { id: 'sam', role: 'MEMBER' }];
const read = (capability, id) => capability.state('maya', id);
const picked = (c, op) => c.events.filter(e => e.action === op);

test('the same structural tool offers conditional triage and a linked handoff without write or native mechanics in model context', async t => {
  const compiler = createCompiler({ modelBytes: teamModelBytes });
  let hostCompiles = 0;
  const db = openData(':memory:'), id = project(db);
  const capability = createTeamCapability(db, { compiler: { compile(...args) { hostCompiles++; return compiler.compile(...args); } } });
  t.after(async () => { await capability.close(); db.close(); });
  const host = hostFor(db, capability, id);
  const triage = triageOffer({ priority: 'low', title: 'Check the intake notes', assigneeId: 'sam' });
  triage.TaskCreated.source = JSON.stringify({ ...JSON.parse(triage.TaskCreated.source), name: 'IntakeCheck' });
  const linked = { ...linkedOffer(), TaskCreated: triage.TaskCreated };
  const gate = JSON.parse(linked.TaskBeforeComplete.source);
  const readTask = JSON.parse(triage.TaskCreated.source).steps[0];
  gate.steps.unshift(readTask);
  gate.steps.at(-1).let.cel = `task.priority != "low" || (${gate.steps.at(-1).let.cel})`;
  linked.TaskBeforeComplete.source = JSON.stringify(gate);
  linked.TaskBeforeComplete.requireFinishedReviewFor = ['low'];
  for (const outcome of linked.TaskBeforeComplete.outcomes) outcome.when.priority = ['low'];
  linked.TaskBeforeComplete.outcomes.push({ when: { priority: ['normal', 'high'], linkedTask: ['absent'] }, expected: { allow: true, message: null } });

  const plain = offerSources(triage, true), wrongPin = offerSources(linked, false);
  const nested = nestedOfferCalls(linked);
  for (const hook of ['TaskCreated', 'TaskBeforeComplete']) {
    const failed = await compiler.compile(Buffer.from(wrongPin[hook].source));
    assert.ok(failed.diagnostics.some(({ code, path }) => code === 'FIELD_UNKNOWN' && path === '/source/domain'));
    const unwrapped = JSON.parse(nested[hook].source);
    unwrapped.name = 'test-program';
    const shape = await compiler.compile(Buffer.from(JSON.stringify(unwrapped)));
    assert.ok(shape.diagnostics.some(({ path }) => path === '/source/steps/0/args'), JSON.stringify(shape.diagnostics));
  }
  for (const [index, offer] of [plain, nestedOfferCalls(wrongPin)].entries()) {
    const context = { ownerId: 'maya', sessionId: 'session', conversationId: 'conversation', runId: `run${index}`,
      budget: { remainingMicros: 100 }, current: () => true, checkpoint: () => {} };
    let count = 0;
    const provider = { reserveMicros: 1, maxMicros: 100, complete: async request => {
      count++;
      const name = count === 1 ? 'resolve_intent' : 'offer_proposal';
      if (count === 2) {
        const catalog = JSON.parse(request.input).currentContext;
        assert.equal(catalog.businessContext.project.id, id);
        assert.deepEqual(catalog.businessContext.members.map(m => m.id).sort(), ['leo', 'maya', 'sam']);
        assert.ok(catalog.model.entrypoints.TaskBeforeComplete);
        const tool = request.tools.find(tool => tool.name === name);
        assert.deepEqual(tool.parameters.required, ['summary', 'TaskCreated', 'TaskBeforeComplete']);
        assert.doesNotMatch(JSON.stringify([catalog, tool]), /BEFORE_WRITE|LOST_REPLY|claimId|caseFields|receipt|reportStatus/);
        assert.deepEqual(catalog.currentProposal, index ? plain : null);
        assert.equal(Object.hasOwn(catalog, 'modelDigest'), false);
      }
      return { calls: [{ id: `call${count}`, name, arguments: count === 1 ? { intent: 'prepare', question: '' } : offer }],
        text: '', usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    const result = await runAuthoringTurn({ provider, host, context, state: createAuthoringState(context), tools: teamConversationTools,
      hostTools: teamConversationHandlers, discoverBeforeReply: true,
      input: { id: 'request', expectedVersion: 0, intent: 'auto', text: 'Set up the requested follow-up.' } });
    assert.equal(result.status, 'AWAITING_USER', result.code);
    assert.equal(count, 2);
    assert.equal(hostCompiles, index, 'Neither offer compiles before the separate human action');
    assert.equal(read(capability, id).draftVersion, index);
    assert.equal(db.prepare('SELECT count(*) AS n FROM team_evidence').get().n, index);
    assert.equal(JSON.parse(result.proposal.bindings.TaskCreated).name, 'daymark-creation');
    if (index) assert.equal(JSON.parse(result.proposal.bindings.TaskBeforeComplete).name, 'daymark-completion');
    for (const hook of ['TaskCreated', 'TaskBeforeComplete']) {
      if (!offer[hook]) { assert.equal(result.proposal.bindings[hook], null); continue; }
      const { steps, return: returns } = JSON.parse((index ? linked : plain)[hook].source);
      const actual = JSON.parse(result.proposal.bindings[hook]);
      assert.deepEqual(actual, {
        language: 'keir/3', name: hook === 'TaskCreated' ? 'daymark-creation' : 'daymark-completion', entrypoint: hook,
        domain: { ...teamModel.domain, fingerprint: digest(json(teamModel)) }, steps, return: returns,
      });
    }
    const saved = await host.save(result.proposal, { draft: host.readDraft() });
    assert.equal(hostCompiles, index ? 3 : 1);
    const proof = await host.simulate(saved.revisionId, saved.draftVersion);
    assert.equal(proof.eligible, true, JSON.stringify(proof.summary.qualification));
    assert.equal(read(capability, id).selected, null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM tasks WHERE project_id=?').get(id).n, 0);
    const { cases } = capability.evidence('maya', id, proof.evidenceId).report;
    assert.equal(cases.length, 5);
    const match = cases.find(c => c.id.startsWith('low-handoff'));
    assert.deepEqual(picked(match, 'dispatch').map(e => [e.observed.childTitle, e.observed.childAssigneeId]), [['Check the intake notes', 'sam']]);
    const rootChecks = picked(match, 'complete').filter(e => e.ref === 'work');
    assert.equal(new Set(rootChecks.map(e => e.native.taskId)).size, 1);
    assert.deepEqual(rootChecks.map(e => [e.before.childStatus, e.observed.decision]),
      index ? [['absent', 'DENY'], ['open', 'DENY'], ['completed', 'ALLOW']] : [['open', 'ALLOW']]);
    assert.ok(picked(match, 'complete').some(e => e.ref === 'work.child' && e.observed.decision === 'ALLOW' && e.binding === null));
    for (const other of ['normal', 'high']) {
      const miss = cases.find(c => c.id === `${other}-original`);
      assert.deepEqual(picked(miss, 'dispatch').map(e => e.observed.children), [0]);
      assert.deepEqual(picked(miss, 'complete').map(e => e.observed.decision), ['ALLOW']);
    }
    for (const [suffix, effect, children] of [['no-write', 'NONE', 0], ['lost-reply', 'CONFIRMED', 1]]) {
      const fault = cases.find(c => c.id === `low-${suffix}`);
      const [attempt] = picked(fault, 'dispatch'), [reconciled] = picked(fault, 'reconcile');
      assert.deepEqual([attempt.native.writeAttempts, attempt.observed.outcome], [1, 'UNCERTAIN']);
      assert.deepEqual([reconciled.observed.effect, reconciled.observed.children, reconciled.native.writeAttempts], [effect, children, 1]);
    }
  }
});

test('business offers reject privacy-safe shape, reachability and scope errors before compiling', () => {
  for (const [code, change] of [
    ['OFFER_FIELD_INVALID', p => { p.TaskCreated.outcomes[0].expected.receipt = 'do not echo'; }],
    ['OFFER_TOO_LARGE', p => { p.summary = 'x'.repeat(98304); }],
    ['SOURCE_INVALID', p => { p.TaskCreated.source = 'x'.repeat(65537); }],
    ['TOO_MANY_OUTCOMES', p => { p.TaskCreated.outcomes = Array(9).fill(p.TaskCreated.outcomes[0]); }],
    ['SOURCE_ENTRYPOINT_MISMATCH', p => { p.TaskCreated.source = p.TaskBeforeComplete.source; }],
    ['SOURCE_FIELDS_INVALID', p => { p.TaskCreated.source = JSON.stringify({ ...JSON.parse(p.TaskCreated.source), extraBehavior: true }); }],
    ['SOURCE_FIELDS_INVALID', p => { const { steps } = JSON.parse(p.TaskCreated.source); p.TaskCreated.source = JSON.stringify({ steps }); }],
    ['ASSIGNEE_NOT_CURRENT', p => { p.TaskCreated.outcomes[0].expected.linkedTask.assigneeId = 'elsewhere'; }],
    ['OUTCOMES_OVERLAP', p => { p.TaskBeforeComplete.outcomes[0].when.linkedTask.push('completed'); }],
    ['OUTCOME_MISSING', p => { p.TaskBeforeComplete.outcomes[0].when.linkedTask = ['open']; }],
    ['OUTCOME_UNREACHABLE', p => { p.TaskBeforeComplete.outcomes.push({
      when: { priority: ['low'], linkedTask: ['completed'] }, expected: { allow: true, message: null },
    }); p.TaskBeforeComplete.outcomes[1].when.priority = ['normal', 'high'];
    p.TaskCreated = triageOffer({ priority: 'normal' }).TaskCreated; p.TaskBeforeComplete.requireFinishedReviewFor = null; }],
  ]) {
    const offer = linkedOffer();
    change(offer);
    assert.throws(() => expandTeamOffer(offer, 'maya', members), error =>
      error.code === 'INVALID_TOOL_ARGUMENTS' && error.diagnostics[0].code === code, code);
  }
  assert.throws(() => expandTeamOffer(linkedOffer(), 'leo', members), { code: 'INVALID_TOOL_ARGUMENTS' });
});

test('call steps reject mixed or malformed forms before Confirm', () => {
  for (const [patch, field] of [
    [step => { delete step.args; }, 'args'],
    [step => { step.args = []; }, 'args'],
    [step => { step.call = { capability: step.call, args: {} }; }, 'call'],
    [step => { step.call = { capability: step.call }; delete step.args; }, 'call'],
    [step => { step.call = { capability: step.call, args: {}, extra: 'private' }; delete step.args; }, 'call'],
    [step => { step.call = 'private'; }, 'call'],
  ]) {
    const offer = linkedOffer(), source = JSON.parse(offer.TaskCreated.source);
    patch(source.steps[0]);
    offer.TaskCreated.source = JSON.stringify(source);
    assert.throws(() => expandTeamOffer(offer, 'maya', members), error => {
      assert.deepEqual(error.diagnostics, [{ code: 'SOURCE_CALL_SHAPE_INVALID', path: `/TaskCreated/source/steps/0/${field}` }]);
      return true;
    });
  }
});

test('a finished-review requirement rejects an absent-review loophole but preserves an explicit exception', async t => {
  const db = openData(':memory:'), capability = createTeamCapability(db), id = project(db);
  t.after(async () => { await capability.close(); db.close(); });
  const host = hostFor(db, capability, id);
  const offer = nestedOfferCalls(allowMissingReview(linkedOffer()));
  assert.throws(() => host.expandOffer(offer), error => {
    assert.deepEqual(error.diagnostics, [{ code: 'FINISHED_REVIEW_REQUIRED', path: '/TaskBeforeComplete/outcomes' }]);
    return true;
  });
  assert.equal(read(capability, id).draft, null);
  offer.TaskBeforeComplete.requireFinishedReviewFor = null;
  const draft = await host.save(host.expandOffer(offer), { draft: host.readDraft() });
  const checked = await host.simulate(draft.revisionId, draft.draftVersion);
  assert.equal(checked.eligible, true, JSON.stringify(checked.summary.qualification));
  const { cases } = capability.evidence('maya', id, checked.evidenceId).report;
  const decisions = Object.fromEntries(cases.filter(c => c.id.includes('before-link') || c.id.includes('handoff'))
    .flatMap(c => picked(c, 'complete').filter(e => e.ref === 'work').map(e => [e.before.childStatus, e.observed.decision])));
  assert.deepEqual(decisions, { absent: 'ALLOW', open: 'DENY', completed: 'ALLOW' });
});

test('offer checks catch the known source shapes without compiling or replacing the business behavior', () => {
  const offer = linkedSourceLookalike();
  const creation = JSON.parse(offer.TaskCreated.source), completion = JSON.parse(offer.TaskBeforeComplete.source);
  const check = (code, path) => assert.throws(() => expandTeamOffer(offer, 'maya', members), error =>
    error.code === 'INVALID_TOOL_ARGUMENTS' && JSON.stringify(error.diagnostics) === JSON.stringify([{ code, path }]));
  check('TASK_FIELD_UNSUPPORTED', '/TaskCreated/source/steps/1');
  creation.steps[1].let = { literal: true };
  offer.TaskCreated.source = JSON.stringify(creation);
  check('CREATION_GUARD_HAS_NO_SKIP', '/TaskCreated/source/steps/2/when');
  delete creation.steps[2].when;
  creation.steps.splice(1, 1);
  offer.TaskCreated.source = JSON.stringify(creation);
  check('COMPLETION_STEP_GUARD', '/TaskBeforeComplete/source/steps/1/when');
  delete completion.steps[1].when;
  const event = completion.steps[0].args.originEventId;
  delete completion.steps[0].args.originEventId;
  offer.TaskBeforeComplete.source = JSON.stringify(completion);
  check('LINKED_READ_NOT_EVENT_BOUND', '/TaskBeforeComplete/source/steps/0/args');
  completion.steps[0].args.originEventId = event;
  offer.TaskBeforeComplete.source = JSON.stringify(completion);
  const { bindings, agreement } = expandTeamOffer(offer, 'maya', members);
  assert.equal(JSON.parse(bindings.TaskCreated).name, 'daymark-creation');
  assert.equal(JSON.parse(bindings.TaskBeforeComplete).name, 'daymark-completion');
  assert.equal(agreement.claims[0].outcomes[0].expect.childTitle, 'Review the deliverable');
  assert.equal(agreement.claims[1].outcomes[0].expect.message, 'Complete its linked review first.');
});
test('wrong source or an unwitnessed guard leaves a saved but unqualified draft', async t => {
  const db = openData(':memory:'), capability = createTeamCapability(db), id = project(db);
  t.after(async () => { await capability.close(); db.close(); });
  const host = hostFor(db, capability, id);
  for (const wrong of [true, false]) {
    const offer = triageOffer(), source = JSON.parse(offer.TaskCreated.source);
    if (wrong) source.steps[2].args.title.literal = 'Wrong title';
    else source.steps.push({ id: 'always', let: { literal: true } },
      { id: 'extraRead', call: 'tasks.get', when: 'always', args: { taskId: { cel: 'input.taskId' } } });
    offer.TaskCreated.source = JSON.stringify(source);
    const draft = await host.save(host.expandOffer(offer), { draft: host.readDraft() });
    const checked = await host.simulate(draft.revisionId, draft.draftVersion);
    assert.equal(checked.eligible, false);
    const state = read(capability, id);
    assert.equal(state.draft.revisionId, draft.revisionId);
    assert.equal(state.selected, null);
    if (wrong) {
      const report = capability.evidence('maya', id, checked.evidenceId).report;
      assert.ok(report.cases.flatMap(c => c.events).flatMap(e => e.mismatches).some(m =>
        m.path.endsWith('/childTitle') && m.expected === 'Prepare priority triage' && m.observed === 'Wrong title'));
    } else {
      assert.equal(capability.evidence('maya', id, checked.evidenceId).passed, true);
      assert.match(checked.summary.qualification.unverified.join(' '), /guard lacks both/);
    }
    await assert.rejects(capability.approve('maya', id, { operationId: randomUUID(), revisionId: draft.revisionId,
      expectedDraftVersion: draft.draftVersion, evidenceId: checked.evidenceId, cases: state.examples }), { status: 409 });
  }
});

test('a completion-only offer checks that task creation has no hook or side effect', async t => {
  const db = openData(':memory:'), capability = createTeamCapability(db), id = project(db);
  t.after(async () => { await capability.close(); db.close(); });
  const host = hostFor(db, capability, id);
  const offer = linkedOffer();
  offer.TaskCreated = null;
  const source = JSON.parse(offer.TaskBeforeComplete.source);
  source.steps = [JSON.parse(triageOffer().TaskCreated.source).steps[0], { id: 'ready', let: { cel: 'task.priority != "high"' } }];
  offer.TaskBeforeComplete = { source: JSON.stringify(source), requireFinishedReviewFor: null, outcomes: [
    { when: { priority: ['high'], linkedTask: null }, expected: { allow: false, message: null } },
    { when: { priority: ['normal', 'low'], linkedTask: null }, expected: { allow: true, message: null } },
  ] };
  const draft = await host.save(host.expandOffer(offer), { draft: host.readDraft() });
  const checked = await host.simulate(draft.revisionId, draft.draftVersion);
  assert.equal(checked.eligible, true, JSON.stringify(checked.summary.qualification));
  const { cases } = capability.evidence('maya', id, checked.evidenceId).report;
  assert.deepEqual(cases.map(c => picked(c, 'dispatch').map(e => [e.native.admissionBefore, e.observed.outcome, e.observed.children])),
    Array.from({ length: 3 }, () => [['NO_HOOK', 'NONE', 0]]));
  assert.deepEqual(cases.map(c => picked(c, 'complete')[0].observed.decision), ['ALLOW', 'ALLOW', 'DENY']);
});

test('a legacy saved agreement reopens with exact evidence and only business facts are projected for edits', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'team-business-legacy-')), path = join(dir, 'store.sqlite');
  let db = openData(path), capability = createTeamCapability(db);
  t.after(async () => { await capability.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const id = project(db), legacy = triageProposal();
  const draft = await capability.proposeAuthored('maya', id, { ...legacy, expectedDraftVersion: 0 });
  const proof = await hostFor(db, capability, id).simulate(draft.draft.revisionId, 1);
  await capability.close(); db.close();
  db = openData(path); capability = createTeamCapability(db);
  const state = read(capability, id);
  assert.equal(state.eligibility.eligible, true);
  assert.equal(state.evidence.id, proof.evidenceId);
  assert.deepEqual(state.draft.agreement, legacy.agreement);
  const context = hostFor(db, capability, id).discover();
  assert.equal(context.currentProposal.TaskCreated.outcomes[0].expected.linkedTask.title, 'Prepare priority triage');
  assert.deepEqual(Object.keys(JSON.parse(context.currentProposal.TaskCreated.source)).sort(), ['return', 'steps']);
  assert.deepEqual(capability.source('maya', id, state.draft.revisionId).sourceBundle.sources, legacy.bindings);
  assert.doesNotMatch(JSON.stringify(context), /BEFORE_WRITE|LOST_REPLY|claimId|receipt|reportStatus/);
});
