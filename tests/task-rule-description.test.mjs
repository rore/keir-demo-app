import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { CheckedExprSchema } from '@bufbuild/cel-spec/cel/expr/checked_pb.js';
import { createCompiler } from '../src/compiler.mjs';
import { loadHost } from '../src/extension-catalog.mjs';
import { taskRuleDescription } from '../src/task-rule-description.mjs';
import { taskWorkflowSource } from './fixtures/task-workflow-source.mjs';

const compiler = createCompiler({ javaExecutable: process.env.KEIR_JAVA_BIN });
const captured = JSON.parse(readFileSync(new URL('./fixtures/task-follow-up-summary.json', import.meta.url)));
const oldArtifact = JSON.parse(captured.artifact);
const host = loadHost('TaskCompleted');
const literal = value => ({ kind: 'literal', value });
const source = (workflow, selected = host) => JSON.parse(taskWorkflowSource(selected, workflow));
async function compile(value, selected = host) {
  const result = await compiler.compile(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), { definition: selected });
  assert.deepEqual(result.diagnostics, []);
  return JSON.parse(Buffer.from(result.artifact).toString());
}
async function describe(value, selected = host) { return taskRuleDescription(await compile(value, selected), selected); }

test('all four workflow sources expose their conditions, targets and native field values', async () => {
  const createdHost = loadHost('TaskCreated');
  const intake = await describe(source('intake', createdHost), createdHost);
  assert.deepEqual(intake, { coverage: 'complete', hook: 'TaskCreated', conditions: [
    { field: 'projectId', value: 'project1', step: 'source' },
    { field: 'title', value: 'Quote for spring launch', step: 'source' },
    { field: 'tag', value: 'client', step: 'source' },
  ], action: { capability: 'tasks.update', target: 'triggeringTask', step: 'changed', fields: { priority: literal('high') } } });
  const review = await describe(source('review'));
  assert.equal(review.coverage, 'complete');
  assert.deepEqual(review.conditions, [{ field: 'projectId', value: 'project1', step: 'source' },
    { field: 'priority', value: 'high', step: 'source' }, { field: 'tag', value: 'review', step: 'source' }]);
  assert.deepEqual(review.action, { capability: 'tasks.create', target: 'newTask', step: 'changed', fields: {
    projectId: literal('project2'), title: literal('Review'), tags: literal(['review', 'next']), dueAt: { kind: 'eventOffset', seconds: 604800 },
  } });
  const followUp = await describe(source('follow-up'));
  assert.equal(followUp.coverage, 'complete');
  assert.deepEqual(followUp.conditions, [{ field: 'noOpenMatch', projectId: 'project2', title: 'Follow-up', step: 'source' }]);
  const onboarding = await describe(source('onboarding', createdHost), createdHost);
  assert.equal(onboarding.coverage, 'complete');
  assert.deepEqual(onboarding.conditions, [{ field: 'projectId', value: 'project1', step: 'source' }, { field: 'dueAbsent', step: 'source' }]);
  assert.deepEqual(onboarding.action.fields, { dueAt: { kind: 'eventOffset', seconds: 604800 } });
});

test('unconditional prior aliases, renamed steps, copied fields and literal values remain faithful', async () => {
  const program = source('review');
  program.steps[0].id = 'chosenProject';
  program.steps[1].id = 'taskRead';
  program.steps[2].let.cel = 'taskRead.projectId == chosenProject && taskRead.priority == "high" && "review" in taskRead.tags';
  program.steps.splice(3, 0, { id: 'allowed', let: { cel: 'eligible' } }, { id: 'sameProject', let: { cel: 'taskRead.projectId' } },
    { id: 'newTitle', let: { cel: '"Review: " + taskRead.title + "!"' } });
  const write = program.steps.at(-1);
  write.id = 'makeReview'; write.when = 'allowed';
  write.args.projectId = { cel: 'sameProject' }; write.args.title = { cel: 'newTitle' };
  write.args.notes = { literal: 'Keep the context' };
  write.args.priority = { literal: 'low' };
  const result = await describe(program);
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.action.fields.projectId, { kind: 'taskField', step: 'taskRead', field: 'projectId' });
  assert.deepEqual(result.action.fields.title, { kind: 'title', step: 'taskRead', prefix: 'Review: ', suffix: '!' });
  assert.deepEqual(result.action.fields.notes, literal('Keep the context'));
  assert.deepEqual(result.action.fields.priority, literal('low'));
  assert.equal(result.action.step, 'makeReview');
  const update = source('onboarding');
  update.steps.at(-1).args = { priority: { literal: 'normal' }, addTag: { literal: ' Review ' } };
  assert.deepEqual((await describe(update)).action.fields, { priority: literal('normal'), addTag: literal('review') });
});

test('elapsed offsets come from checked duration values, including a year boundary', async () => {
  for (const seconds of [90, 3600, 172800]) {
    const program = source('onboarding');
    program.steps.at(-1).args.dueAt.cel = `input.occurredAt + duration("${seconds}s")`;
    const result = await describe(program);
    assert.equal(result.coverage, 'complete');
    assert.deepEqual(result.action.fields.dueAt, { kind: 'eventOffset', seconds });
  }
  const result = await describe(source('onboarding'));
  assert.equal(new Date(Date.parse('2026-12-28T23:59:00.417Z') + result.action.fields.dueAt.seconds * 1000).toISOString(), '2027-01-04T23:59:00.417Z');
});

test('unconditional is explicit while unsupported conditions never become unconditional', async () => {
  const program = source('follow-up');
  program.steps = [program.steps.at(-1)];
  delete program.steps[0].when;
  program.return.record.status = { cel: '"CREATED"' };
  const unconditional = await describe(program);
  assert.equal(unconditional.coverage, 'complete');
  assert.deepEqual(unconditional.conditions, []);
  for (const expression of ['source.projectId == projectId || !has(source.dueAt)', 'source.priority != "high"']) {
    const conditional = source('onboarding');
    conditional.steps[2].let.cel = expression;
    const result = await describe(conditional);
    assert.equal(result.coverage, 'partial');
    assert.equal(Object.hasOwn(result, 'conditions'), false);
  }
});

test('format, hook, model, compiler and environment must match the trusted definition', async () => {
  const artifact = await compile(source('review'));
  for (const change of [
    item => { item.format = 'keir-artifact/1'; }, item => { item.entrypoint = 'TaskCreated'; },
    item => { item.modelRef.digest = 'sha256:' + '0'.repeat(64); }, item => { item.compiler = 'other/1'; },
    item => { item.environment.celNode = 'unknown'; }, item => { delete item.sourceDigest; },
  ]) {
    const changed = structuredClone(artifact); change(changed);
    assert.equal(taskRuleDescription(changed, host).coverage, 'unavailable');
  }
  assert.equal(taskRuleDescription(oldArtifact, host).coverage, 'unavailable');
  const wrongDefinition = { ...host, dcmBytes: Buffer.from('{}') };
  assert.equal(taskRuleDescription(artifact, wrongDefinition).coverage, 'unavailable');
  const guardHost = loadHost('TaskBeforeCreate');
  const unknownGuard = { ...artifact, entrypoint: 'TaskBeforeCreate' };
  assert.equal(taskRuleDescription(unknownGuard, guardHost).coverage, 'unavailable');
});

test('unknown steps, handlers, guards, returns and field values cannot produce complete coverage', async () => {
  const artifact = await compile(source('onboarding'));
  for (const change of [
    item => { item.steps.push({ id: 'extra', op: 'MYSTERY' }); },
    item => { item.steps.push({ id: 'unused', op: 'BIND', resultType: 'Boolean', value: { literal: true, type: 'Boolean' } }); },
    item => { item.steps[1].onError = { TASK_NOT_FOUND: { literal: {} } }; },
    item => { item.steps[3].onError = {}; }, item => { item.onError = {}; },
    item => { item.steps[1].when = 'eligible'; }, item => { item.steps[3].when = 'missing'; },
    item => { item.steps[3].args.mystery = { literal: 'x', type: 'String' }; },
    item => { item.steps[3].args.dueAt.type = 'ProjectId'; },
    item => { item.steps[1].args.taskId.type = 'ProjectId'; },
    item => { delete item.steps[3].args.dueAt; },
    item => { item.steps[0].value.expr = 'missing'; delete item.steps[0].value.literal; },
    item => { item.return.fields.status = { literal: 'NO_OP', type: 'WorkflowStatus' }; },
    item => { item.steps[3].args = {}; }, item => { item.steps[3].version = '99'; },
    item => { item.expressions.e1.checked = 'not checked protobuf'; },
    item => { item.expressions.e1.checked = 'A'.repeat(22_004); },
    item => { item.steps[2].when = 'eligible'; },
    item => { item.steps[1].id = item.steps[0].id; },
  ]) {
    const changed = structuredClone(artifact); change(changed);
    assert.notEqual(taskRuleDescription(changed, host).coverage, 'complete', change.toString());
  }
  for (const item of [undefined, null, {}, { ...artifact, steps: null }, { ...artifact, steps: Array.from({ length: 65 }, () => artifact.steps[0]) }])
    assert.equal(taskRuleDescription(item, host).coverage, 'unavailable');
  const multiple = structuredClone(artifact); multiple.steps.push({ ...multiple.steps.at(-1), id: 'secondWrite' });
  assert.equal(taskRuleDescription(multiple, host).coverage, 'unavailable');
  const unusedRead = structuredClone(artifact); unusedRead.steps.splice(2, 0, { ...unusedRead.steps[1], id: 'unusedRead' });
  assert.equal(taskRuleDescription(unusedRead, host).coverage, 'partial');
});

test('deep alias chains exceed bounded recognition without claiming completeness', async () => {
  const artifact = await compile(source('onboarding'));
  for (let index = 0; index < 18; index++) {
    const checked = fromBinary(CheckedExprSchema, Buffer.from(artifact.expressions.e0.checked, 'base64'));
    checked.expr = checked.expr.exprKind.value.operand;
    checked.expr.exprKind.value.name = index ? `alias${index - 1}` : 'eligible';
    artifact.expressions[`alias${index}`] = { checked: Buffer.from(toBinary(CheckedExprSchema, checked)).toString('base64'), resultType: 'Boolean' };
    artifact.steps.splice(3 + index, 0, { id: `alias${index}`, op: 'BIND', resultType: 'Boolean', value: { expr: `alias${index}`, type: 'Boolean' } });
  }
  artifact.steps.at(-1).when = 'alias17';
  const result = taskRuleDescription(artifact, host);
  assert.equal(result.coverage, 'partial');
  assert.equal(Object.hasOwn(result, 'conditions'), false);
});

test('fractional checked durations never claim an exact rounded offset', async () => {
  const artifact = await compile(source('onboarding'));
  const due = artifact.steps.at(-1).args.dueAt.expr;
  const checked = fromBinary(CheckedExprSchema, Buffer.from(artifact.expressions[due].checked, 'base64'));
  const duration = checked.expr.exprKind.value.args[1].exprKind.value.args[0];
  for (const seconds of ['0.1s', '604800.000000001s', '9007199254740993s']) {
    duration.exprKind.value.constantKind.value = seconds;
    artifact.expressions[due].checked = Buffer.from(toBinary(CheckedExprSchema, checked)).toString('base64');
    const result = taskRuleDescription(artifact, host);
    assert.equal(result.coverage, 'partial');
    assert.equal(Object.hasOwn(result.action.fields, 'dueAt'), false);
  }
});
