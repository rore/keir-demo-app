import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openData, taskService } from '../src/data.mjs';
import { teamProjectService } from '../src/team-native.mjs';
import { createTeamRuntime } from '../src/team-runtime.mjs';
import { createTeamCapability } from '../src/team-capability.mjs';
import { triageProposal, linkedProposal } from './fixtures/team-authored.mjs';
import { normalizeTeamAgreement } from '../src/team-qualification.mjs';
import { json } from '../src/extension-catalog.mjs';

function setup(t, options, seams) {
  const db = openData(':memory:'), api = createTeamCapability(db, options, seams);
  const project = taskService(db).createProject('maya', { name: 'Authored Team', mode: 'TEAM' });
  teamProjectService(db).addMember('maya', project.id, { userId: 'leo' });
  t.after(async () => { await api.close(); db.close(); });
  return { db, api, project };
}
async function check(f, proposal, expectedDraftVersion = 0) {
  const prepared = await f.api.proposeAuthored('maya', f.project.id, { expectedDraftVersion, ...proposal });
  const input = { expectedDraftVersion: prepared.draftVersion, revisionId: prepared.draft.revisionId, cases: prepared.examples };
  const checked = await f.api.simulate('maya', f.project.id, input);
  const proof = f.api.evidence('maya', f.project.id, checked.evidenceId);
  return { prepared, checked, proof, input: { ...input, evidenceId: checked.evidenceId, operationId: randomUUID() } };
}
async function select(f, checked) {
  const approved = await f.api.approve('maya', f.project.id, checked.input);
  return f.api.activate('maya', f.project.id, { ...checked.input, operationId: randomUUID(), approvalId: approved.receipt.id,
    expectedSelectionGeneration: f.api.state('maya', f.project.id).selection.generation });
}

test('one authored path qualifies conditional triage with explicit absent completion, then linked review with an actual native gate', async t => {
  const f = setup(t), runtime = createTeamRuntime({ db: f.db }), tasks = taskService(f.db, { team: runtime });
  try {
    const triage = await check(f, triageProposal());
    assert.equal(triage.proof.passed, true);
    assert.deepEqual(triage.proof.report.qualification.unverified, []);
    assert.equal(triage.prepared.draft.manifest.TaskBeforeComplete, null);
    assert.equal(f.api.source('maya', f.project.id, triage.input.revisionId).sourceBundle.hooks.TaskBeforeComplete.present, false);
    assert.equal(f.api.state('maya', f.project.id).selection.generation, 0);
    await select(f, triage);
    const high = await tasks.createTask('maya', { projectId: f.project.id, title: 'Urgent issue', priority: 'high' }, { operationId: randomUUID() });
    const normal = await tasks.createTask('maya', { projectId: f.project.id, title: 'Normal issue', priority: 'normal' }, { operationId: randomUUID() });
    await runtime.wake();
    assert.equal(tasks.listTasks('maya', f.project.id).find(t => t.parentTaskId === high.id).title, 'Prepare priority triage');
    assert.equal(tasks.listTasks('maya', f.project.id).some(t => t.parentTaskId === normal.id), false);
    const pinned = f.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(high.id);
    assert.equal((await tasks.completeTask('maya', high.id)).status, 'completed', 'No completion hook means no invented hold');
    const oldWaiting = await tasks.createTask('maya', { projectId: f.project.id, title: 'Old pending triage', priority: 'high' }, { operationId: randomUUID() });
    const linked = await check(f, linkedProposal(), 1);
    assert.equal(linked.proof.passed, true);
    assert.deepEqual(linked.proof.report.qualification.unverified, []);
    assert.equal(f.api.state('maya', f.project.id).selection.revisionId, triage.input.revisionId);
    await select(f, linked);
    assert.deepEqual(f.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(high.id), pinned);
    const deliverable = await tasks.createTask('maya', { projectId: f.project.id, title: 'New deliverable' }, { operationId: randomUUID() });
    await runtime.wake();
    assert.equal(tasks.listTasks('maya', f.project.id).find(t => t.parentTaskId === oldWaiting.id).title, 'Prepare priority triage');
    assert.equal((await tasks.completeTask('maya', oldWaiting.id)).status, 'completed', 'An old pin keeps its absent gate after replacement');
    await assert.rejects(tasks.completeTask('maya', deliverable.id), { status: 422 });
    const child = tasks.listTasks('maya', f.project.id).find(t => t.parentTaskId === deliverable.id);
    assert.equal(child.title, 'Review the deliverable');
    await tasks.completeTask('leo', child.id);
    assert.equal((await tasks.completeTask('maya', deliverable.id)).status, 'completed');
  } finally { await runtime.close(); }
});

test('claims and binding decisions are closed, independently fixed and cannot be replaced by matching case names or caller pass flags', async t => {
  const f = setup(t);
  const contract = f.api.contract('maya', f.project.id);
  contract.facts.priority.pop(); contract.hooks.pop();
  assert.deepEqual(f.api.contract('maya', f.project.id).facts.priority, ['low', 'normal', 'high']);
  assert.deepEqual(f.api.contract('maya', f.project.id).hooks, ['TaskCreated', 'TaskBeforeComplete']);
  const proposal = triageProposal();
  for (const change of [
    p => { delete p.bindings.TaskBeforeComplete; },
    p => { p.bindings.TaskCreated = null; },
    p => { p.bindings.TaskCompleted = p.bindings.TaskCreated; },
    p => { p.agreement.claims[0].outcomes[0].expect.passed = true; },
    p => { p.agreement.examples[0].passed = true; },
  ]) {
    const broken = structuredClone(proposal); change(broken);
    await assert.rejects(f.api.proposeAuthored('maya', f.project.id, { expectedDraftVersion: 0, ...broken }));
    assert.equal(f.api.state('maya', f.project.id).draftVersion, 0);
  }
  const checked = await check(f, proposal);
  const cases = structuredClone(checked.input.cases); cases[0].actions[1].expect.childTitle = 'Whatever the program did';
  const changed = await f.api.simulate('maya', f.project.id, { expectedDraftVersion: 1, revisionId: checked.input.revisionId, cases });
  assert.equal(f.api.evidence('maya', f.project.id, changed.evidenceId).passed, false);
  await assert.rejects(f.api.approve('maya', f.project.id, checked.input), { status: 409 });
});

test('a passing subset cannot waive guard/dependency alternatives or native failure coverage', async t => {
  for (const remove of ['low', 'misses', 'losses', 'absent-gate']) await t.test(remove, async t => {
    const f = setup(t), proposal = triageProposal();
    proposal.agreement.examples = proposal.agreement.examples.filter(c => remove === 'low' ? c.id !== 'low'
      : remove === 'misses' ? !['low', 'normal'].includes(c.id) : c.fault === 'NONE');
    if (remove === 'absent-gate') {
      proposal.agreement.examples = triageProposal().agreement.examples;
      for (const c of proposal.agreement.examples) c.actions = c.actions.filter(a => a.op !== 'complete');
    }
    const checked = await check(f, proposal);
    assert.equal(checked.proof.passed, true);
    assert.equal(checked.proof.report.qualification.eligible, false);
    await assert.rejects(f.api.approve('maya', f.project.id, checked.input), { status: 409 });
  });
});

test('an example labeled with another outcome cannot qualify an overlapping context', async t => {
  const f = setup(t), proposal = triageProposal(), outcomes = proposal.agreement.claims[0].outcomes;
  // The broad miss is witnessed at low; the narrower miss supplies the only normal witness.
  outcomes.push({ ...outcomes[1], id: 'normal-miss', when: { priority: 'normal' } });
  proposal.agreement.examples.find(c => c.id === 'normal').actions[1].covers.outcomeId = 'normal-miss';
  const checked = await check(f, proposal);
  assert.equal(checked.proof.passed, true);
  assert.equal(checked.proof.report.qualification.eligible, false);
  assert.match(checked.proof.report.qualification.unverified.join(' '), /contexts are incomplete or ambiguous/);
  await assert.rejects(f.api.approve('maya', f.project.id, checked.input), { status: 409 });
});

test('actual effect payload and early rule denial cannot be weakened to authorization BLOCKED', async t => {
  const f = setup(t), proposal = linkedProposal();
  const program = JSON.parse(proposal.bindings.TaskCreated);
  program.steps[1].args.title.literal = 'Wrong actual child';
  proposal.bindings.TaskCreated = JSON.stringify(program);
  const checked = await check(f, proposal);
  assert.equal(checked.proof.passed, false);
  await assert.rejects(f.api.approve('maya', f.project.id, checked.input), { status: 409 });
  const wrong = linkedProposal();
  wrong.agreement.claims[1].outcomes[0].expect.decision = 'BLOCKED';
  assert.throws(() => normalizeTeamAgreement(wrong.agreement), { status: 400 });
});

test('current membership and exact producer/absent binding identities are fenced during authored compilation and approval', async t => {
  const f = setup(t), proposal = triageProposal(), checked = await check(f, proposal);
  await assert.rejects(f.api.proposeAuthored('leo', f.project.id, { expectedDraftVersion: 1, ...proposal }), { status: 403 });
  f.db.prepare("DELETE FROM project_members WHERE project_id=? AND user_id='leo'").run(f.project.id);
  await assert.rejects(f.api.approve('maya', f.project.id, checked.input), { status: 409 });
  assert.equal(f.api.state('maya', f.project.id).selection.generation, 0);
});

test('matching examples do not certify opaque expression operations or unrelated read targets', async t => {
  for (const change of ['expression', 'read-target']) await t.test(change, async t => {
    const f = setup(t), proposal = triageProposal(), source = JSON.parse(proposal.bindings.TaskCreated);
    if (change === 'expression') source.steps[2].args.title = { cel: '"Prepare " + "priority triage"' };
    else source.steps[0].args.taskId = { literal: 'unrelated-task', type: 'TaskId' };
    proposal.bindings.TaskCreated = json(source);
    const checked = await check(f, proposal);
    if (change === 'expression') assert.equal(checked.proof.passed, true);
    assert.equal(checked.proof.report.qualification.eligible, false);
    assert.match(checked.proof.report.qualification.unverified.join(' '), change === 'expression' ? /expression operation/ : /read is not bound/);
    await assert.rejects(f.api.approve('maya', f.project.id, checked.input), { status: 409 });
  });
});

test('saved authored source, artifact and policy damage fails before simulation and approval', async t => {
  for (const change of ['missing-artifact', 'malformed-artifact', 'absent-pin', 'policy', 'agreement']) await t.test(change, async t => {
    const f = setup(t), checked = await check(f, triageProposal());
    const row = f.db.prepare('SELECT * FROM team_revisions WHERE revision_id=?').get(checked.input.revisionId);
    const sources = JSON.parse(row.source_bundle), artifacts = JSON.parse(row.artifacts);
    if (change === 'missing-artifact') delete artifacts[JSON.parse(row.manifest).TaskCreated];
    if (change === 'malformed-artifact') artifacts[JSON.parse(row.manifest).TaskCreated] = '{';
    if (change === 'absent-pin') delete sources.hooks.TaskBeforeComplete;
    if (change === 'policy') sources.parameters.qualificationPolicy = 'unverified/0';
    if (change === 'agreement') sources.parameters.agreement.claims[0].outcomes[0].expect.childTitle = 'Changed after the run';
    f.db.exec('DROP TRIGGER team_revision_immutable; DROP TRIGGER team_source_immutable');
    f.db.prepare('UPDATE team_revisions SET source_bundle=?,artifacts=? WHERE revision_id=?')
      .run(json(sources), json(artifacts), checked.input.revisionId);
    const count = f.db.prepare('SELECT count(*) AS n FROM team_evidence').get().n;
    await assert.rejects(f.api.simulate('maya', f.project.id, { expectedDraftVersion: 1, revisionId: checked.input.revisionId, cases: checked.input.cases }));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM team_evidence').get().n, count);
    await assert.rejects(f.api.approve('maya', f.project.id, checked.input));
    assert.equal(f.api.state('maya', f.project.id).selection.generation, 0);
  });
});

test('even another passing authored check makes old evidence stale without changing selection', async t => {
  const f = setup(t), checked = await check(f, triageProposal());
  const newer = await f.api.simulate('maya', f.project.id, { expectedDraftVersion: 1, revisionId: checked.input.revisionId, cases: checked.input.cases });
  assert.equal(newer.eligibility.eligible, true);
  await assert.rejects(f.api.approve('maya', f.project.id, checked.input), { status: 409 });
  const approval = await f.api.approve('maya', f.project.id, { ...checked.input, evidenceId: newer.evidenceId });
  assert.equal(approval.current.generation, 0);
  const report = f.api.evidence('maya', f.project.id, newer.evidenceId);
  report.report.qualification.policy = 'caller-approved/1';
  const forgedId = randomUUID();
  f.db.prepare(`INSERT INTO team_evidence SELECT ?,project_id,revision_id,executable_identity,case_digest,harness,cases,?,1,created_at
    FROM team_evidence WHERE id=?`).run(forgedId, json(report.report), newer.evidenceId);
  await assert.rejects(f.api.approve('maya', f.project.id, { ...checked.input, operationId: randomUUID(), evidenceId: forgedId }), { status: 409 });
});

test('a replayed dispatch cannot relabel earlier execution as coverage of a new task context', async t => {
  const f = setup(t), proposal = triageProposal(), source = JSON.parse(proposal.bindings.TaskCreated);
  source.steps.push({ id: 'checkedStatus', let: { cel: 'task.status == "COMPLETED"' } });
  proposal.bindings.TaskCreated = json(source);
  for (const outcome of proposal.agreement.claims[0].outcomes) outcome.when.status = ['open', 'completed'];
  for (const c of proposal.agreement.examples.filter(c => c.fault === 'NONE')) c.actions.push(structuredClone(c.actions[1]));
  const checked = await check(f, proposal);
  assert.equal(checked.proof.passed, true, 'Saved execution outcomes still match');
  assert.equal(checked.proof.report.qualification.eligible, false, 'But no new execution occurred in the completed context');
  await assert.rejects(f.api.approve('maya', f.project.id, checked.input), { status: 409 });
});
