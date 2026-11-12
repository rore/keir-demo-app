import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { conditionalFollowUpFixture } from './fixtures/task-conditional-follow-up.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { runTaskEffectSimulation } from '../src/task-effect-simulation.mjs';
import { taskRuleDescription } from '../src/task-rule-description.mjs';
import { openData, taskService } from '../src/data.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createTaskDispatcher } from '../src/task-effects.mjs';
import { admitTaskDraft } from './fixtures/task-authoring.mjs';

const compiler = createCompiler();
test('published compiler and installed runtime preserve independent conditional lookup paths and proof boundaries', async () => {
  const f = conditionalFollowUpFixture();
  const compiled = await compiler.compile(Buffer.from(f.source), { definition: f.host });
  assert.deepEqual(compiled.diagnostics, []);
  assert.equal(JSON.parse(compiled.artifact).compiler, 'keir-compiler-java/0.4.0');
  const proof = await runTaskEffectSimulation({ artifactBytes: compiled.artifact, host: f.host, scenarios: f.cases });
  assert.equal(proof.status, 'PASS', JSON.stringify(proof));
  assert.deepEqual(proof.reports.map(r => r.report.native.classification), ['COMPLETED','COMPLETED','COMPLETED','COMPLETED','FAILED','FAILED']);
  assert.deepEqual(proof.reports.map(r => r.report.calls.map(c => c.capability)), [
    ['tasks.get','tasks.openMatch','tasks.create'], ['tasks.get','tasks.openMatch'], ['tasks.get'], ['tasks.get'], ['tasks.get','tasks.openMatch'], ['tasks.get']]);
  assert.equal(taskRuleDescription(JSON.parse(compiled.artifact), f.host).coverage, 'complete');
  for (const expression of ['eligible && !match.matches', '!match.matches', 'has(match.matches) ? !match.matches : false', 'true ? !match.matches : false']) {
    const source = JSON.parse(f.source); source.steps[4].let.cel = expression;
    const result = await compiler.compile(Buffer.from(JSON.stringify(source)), { definition: f.host });
    assert.equal(result.artifact, null, expression); assert.equal(result.diagnostics[0].code,'DATAFLOW_UNAVAILABLE',expression);
  }
  const alias = JSON.parse(f.source);
  alias.steps.splice(3,0,{id:'sameEligibility',let:{cel:'eligible'}});
  alias.steps[5].let.cel='sameEligibility ? !match.matches : false';
  const wrongAlias=await compiler.compile(Buffer.from(JSON.stringify(alias)),{definition:f.host});
  assert.equal(wrongAlias.diagnostics[0].code,'DATAFLOW_UNAVAILABLE');
  alias.steps[4].when='sameEligibility';
  const exactAlias=await compiler.compile(Buffer.from(JSON.stringify(alias)),{definition:f.host});
  assert.deepEqual(exactAlias.diagnostics,[]);
  assert.equal(taskRuleDescription(JSON.parse(exactAlias.artifact),f.host).coverage,'complete');
  for (const mutate of [a=>{a.steps[3].when='shouldCreate';},a=>{a.steps[3].onError={};},a=>{a.steps[2].when='projectId';}]) {
    const artifact=JSON.parse(compiled.artifact); mutate(artifact);
    assert.notEqual(taskRuleDescription(artifact,f.host).coverage,'complete');
  }
  // Valid language expressions outside the bounded business recognizer remain incomplete.
  const unsupported = JSON.parse(f.source); unsupported.steps[4].let.cel='eligible ? !match.matches : true';
  const result = await compiler.compile(Buffer.from(JSON.stringify(unsupported)), { definition: f.host });
  assert.deepEqual(result.diagnostics,[]);
  assert.notEqual(taskRuleDescription(JSON.parse(result.artifact),f.host).coverage,'complete');
});

test('native conditional follow-up uses the approved artifact, then skips found and ineligible tasks without AI', async t => {
  const db=openData(':memory:');t.after(()=>db.close());const tasks=taskService(db),owner='maya',project=tasks.listProjects(owner)[0];
  const other=tasks.createProject(owner,{name:'Other project'}),f=conditionalFollowUpFixture({projectId:project.id,otherProjectId:other.id});
  const lifecycle=createLifecycle(db,{compiler});const dispatcher=createTaskDispatcher({db,lifecycle});t.after(()=>dispatcher.close());
  const {extensionId}=admitTaskDraft(db,lifecycle,{owner});let state=await lifecycle.compile(owner,{extensionId,hookId:'TaskCompleted',draftVersion:0,source:f.source},()=>{});
  const input=()=>({extensionId,revisionId:state.draft.id,draftVersion:state.draftVersion});
  state=await lifecycle.proposeScenarios(owner,{...input(),cases:f.cases},()=>{});state=await lifecycle.simulate(owner,input(),()=>{});
  assert.equal(state.evidence.passed,true);const evidenceId=state.evidence.id;
  state=lifecycle.approve(owner,{...input(),evidenceId},()=>{});assert.equal(state.selection.revision,null);
  state=lifecycle.activate(owner,{...input(),evidenceId,generation:state.selection.generation},()=>{});
  const artifact=lifecycle.source(owner,state.draft.id,extensionId).pins.artifactDigest;
  const complete=async(title,priority,projectId=project.id)=>{const task=await tasks.createTask(owner,{projectId,title,priority},{operationId:randomUUID()});tasks.completeTask(owner,task.id);await dispatcher.wake();return {task,...dispatcher.status(owner,task.id)};};
  const first=await complete('Send collection preview','high');assert.equal(first.receipt.effect,'CONFIRMED');
  assert.equal(tasks.getTask(owner,first.receipt.value.id).title,'Follow up');
  const event=db.prepare("SELECT pins FROM task_events WHERE source_task_id=? AND hook_id='TaskCompleted'").get(first.task.id);
  assert.equal(JSON.parse(event.pins).artifactDigest,artifact);
  const found=await complete('Send collection notes','high');assert.equal(found.receipt,null);assert.equal(found.outcome.result.status,'NO_OP');
  // Finish the Normal-priority follow-up: it no longer counts as an open match.
  tasks.completeTask(owner,first.receipt.value.id); await dispatcher.wake();
  for(const [priority,projectId] of [['normal',project.id],['high',other.id]]) {
    const skipped=await complete('Unrelated work',priority,projectId);assert.equal(skipped.receipt,null);
    assert.ok(skipped.outcome.trace.some(e=>e.event==='STEP_SKIPPED'&&e.step==='match'));
    assert.deepEqual(skipped.outcome.trace.filter(e=>e.event==='CALL_DISPATCHED').map(e=>e.capability),['tasks.get']);
  }
  const later=await complete('Send final collection notes','high');
  assert.equal(later.receipt.effect,'CONFIRMED');
  assert.notEqual(later.receipt.value.id,first.receipt.value.id);
  assert.equal(tasks.getTask(owner,later.receipt.value.id).status,'open');
});
