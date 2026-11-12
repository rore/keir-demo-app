import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRule, elapsedTime } from '../src/web/rule-description.ts';

const literal = value => ({ kind: 'literal', value });
const update = (fields, conditions = [], hook = 'TaskCreated') => ({ coverage: 'complete', hook, conditions,
  action: { capability: 'tasks.update', step: 'write', target: 'triggeringTask', fields } });
const projectName = id => ({ inbox: 'Inbox & Co', reviews: 'Reviews' })[id];

test('primary action facts retain explicit empty notes and empty tags', () => {
  const result = describeRule({ coverage: 'complete', hook: 'TaskCompleted', conditions: [],
    action: { capability: 'tasks.create', target: 'newTask', step: 'write', fields: {
      title: literal('Follow up'), projectId: literal('reviews'), notes: literal(''), tags: literal([]),
    } } }, projectName);
  assert.equal(result.complete, true);
  assert.match(result.then, /Empty notes\./);
  assert.match(result.then, /No tags\./);
  assert.match(result.summary, /leave the new task’s notes empty/);
  const omitted = describeRule({ coverage: 'complete', hook: 'TaskCompleted', conditions: [],
    action: { capability: 'tasks.create', target: 'newTask', step: 'write', fields: { title: literal('Follow up') } } }, projectName);
  assert.doesNotMatch(omitted.then, /Empty notes|No tags/);
});

test('elapsed rule wording follows the supplied offset and never invents calendar days', () => {
  const rule = seconds => ({ coverage: 'complete', hook: 'TaskCreated', conditions: [{ field: 'dueAbsent', step: 'read' }],
    action: { capability: 'tasks.update', step: 'write', target: 'triggeringTask', fields: { dueAt: { kind: 'eventOffset', seconds } } } });
  const first = describeRule(rule(604800), () => undefined), revised = describeRule(rule(432000), () => undefined);
  assert.match(first.onlyWhen, /no due date when its details are read/);
  assert.match(first.then, /7 days \(168 elapsed hours\) after the task was added/);
  assert.match(revised.then, /5 days \(120 elapsed hours\)/);
  assert.doesNotMatch(revised.then, /168|seven|working days/);
  assert.match(first.timing, /exact elapsed duration/);
  assert.equal(elapsedTime(3600), '1 elapsed hour');
  assert.equal(elapsedTime(90), '90 elapsed seconds');
});

test('partial conditions and unresolved project names do not become exhaustive descriptions', () => {
  const action = { capability: 'tasks.create', target: 'newTask', step: 'write',
    fields: { title: { kind: 'title', step: 'read', prefix: 'Review ', suffix: ' next' }, projectId: { kind: 'literal', value: 'unresolved-project' } } };
  const partial = describeRule({ coverage: 'partial', hook: 'TaskCompleted', action }, () => undefined);
  assert.equal(partial.complete, false);
  assert.match(partial.onlyWhen, /full conditions could not be described/);
  assert.doesNotMatch(partial.onlyWhen, /Every task/);
  assert.match(partial.then, /Review .*this task’s title.* next/);
  assert.doesNotMatch(partial.then, /unresolved-project/);
  const full = describeRule({ coverage: 'complete', hook: 'TaskCompleted', conditions: [], action }, () => 'Reviews');
  assert.equal(full.complete, true);
  assert.match(full.then, /in “Reviews”/);
  assert.equal(describeRule({ coverage: 'unavailable' }, () => undefined), null);
});

test('the complete due summary states every-project scope, read-time absence, exact offset and preservation', () => {
  const result = describeRule(update({ dueAt: { kind: 'eventOffset', seconds: 604800 } }, [{ field: 'dueAbsent', step: 'read' }]), projectName);
  assert.equal(result.title, 'Give new tasks a due date');
  assert.equal(result.scope, 'Applies in every project, regardless of title, tags, and priority.');
  assert.equal(result.summary, 'When a new task is added in any project, give it a due date exactly 7 days after it was added, but only if it still has no due date when its details are read. A due date already present when the task is read is kept. Leave its title, project, notes, status, priority, and tags unchanged. Turning this on does not update tasks that were added earlier.');
  assert.doesNotMatch(result.summary, /Update this task|working days/);
  assert.match(result.timing, /168 elapsed hours.*including weekends.*local hour may shift when clocks change/);
});

test('every condition is retained in a naturally worded project-scoped priority rule', () => {
  const conditions = [{ field: 'projectId', value: 'inbox', step: 'read' }, { field: 'title', value: 'Quote for spring launch', step: 'read' },
    { field: 'tag', value: 'client', step: 'read' }, { field: 'priority', value: 'normal', step: 'read' }, { field: 'status', value: 'OPEN', step: 'read' }];
  const result = describeRule(update({ priority: literal('high') }, conditions), projectName);
  assert.equal(result.complete, true);
  assert.equal(result.title, 'Give new tasks High priority');
  for (const phrase of ['When a new task is added, set its priority to High', 'it is in “Inbox & Co”', 'it is titled exactly “Quote for spring launch”',
    'it has the tag “client”', 'it has Normal priority', 'it is unfinished', 'due date unchanged']) assert.ok(result.summary.includes(phrase), phrase);
  assert.equal(result.scope, undefined);
  assert.doesNotMatch(result.summary, /any project|inbox|priority.*priority unchanged/);
});

test('before-save wording states the exact denial, trigger and ordinary checks after it', () => {
  const result = describeRule({ coverage: 'complete', hook: 'TaskBeforeCreate', guard: { conditions: [
    { field: 'projectId', value: 'inbox' }, { field: 'priority', value: 'normal' },
  ], message: 'Choose a priority for this task.' } }, projectName);
  assert.equal(result.complete, true);
  assert.equal(result.when, 'Before a new task is saved.');
  assert.match(result.summary, /Before saving a new task, stop saving when the task is in “Inbox & Co” and its priority is Normal/);
  assert.match(result.summary, /Show “Choose a priority for this task\.”/);
  assert.match(result.summary, /Otherwise, this rule lets the app continue its normal permission, validation and save checks/);
  assert.match(result.unchanged, /does not change task details/);
  assert.doesNotMatch(result.summary, /only when .*Normal priority is missing/);
});

test('guard tag and boolean conditions are explicit and missing project names stay partial', () => {
  const guard = conditions => ({ coverage: 'complete', hook: 'TaskBeforeCreate', guard: {
    conditions, message: 'Review this task.',
  } });
  const flags = describeRule(guard([{ field: 'hasNotes', value: false }, { field: 'hasDueDate', value: true },
    { field: 'tag', value: 'blocked', negated: true }]), projectName);
  for (const phrase of ['it has no notes', 'it has a due date', 'it does not have the tag “blocked”'])
    assert.ok(flags.summary.includes(phrase), phrase);
  const partial = describeRule(guard([{ field: 'projectId', value: 'missing' }, { field: 'priority', value: 'normal' }]), projectName);
  assert.equal(partial.complete, false);
  assert.match(partial.summary, /full behavior could not be described/);
  assert.match(partial.summary, /chosen project \(name unavailable\)/);
  assert.match(partial.summary, /priority is Normal/);
});

test('unconditional due writes disclose replacement while omitted fields and existing tags stay intact', () => {
  const overwrite = describeRule(update({ dueAt: { kind: 'eventOffset', seconds: 3600 } }), projectName);
  assert.equal(overwrite.title, 'Set due dates for new tasks');
  assert.match(overwrite.summary, /set its due date to exactly 1 elapsed hour after it was added/);
  assert.doesNotMatch(overwrite.summary, /already present.*kept|only if|no due date/);
  const tag = describeRule(update({ addTag: literal('review') }, [], 'TaskCompleted'), projectName);
  assert.equal(tag.title, 'Tag completed tasks “review”');
  assert.match(tag.summary, /When a task is completed in any project, add the tag “review” to that task/);
  assert.match(tag.summary, /Keep its existing tags too/);
  assert.match(tag.summary, /due date unchanged/);
  assert.match(tag.summary, /does not replay earlier task completions/);
});

test('fixed creation fields, empty notes and lookup conditions describe the new task without changing the trigger', () => {
  const result = describeRule({ coverage: 'complete', hook: 'TaskCompleted', conditions: [
    { field: 'noOpenMatch', projectId: 'reviews', title: 'Review launch', step: 'lookup' },
  ], action: { capability: 'tasks.create', step: 'create', target: 'newTask', fields: {
    projectId: literal('reviews'), title: literal('Review launch'), priority: literal('low'), tags: literal(['review', 'next']), notes: literal(''),
    dueAt: literal('2027-01-01T00:00:00.000Z'),
  } } }, projectName);
  assert.equal(result.complete, true);
  for (const phrase of ['When a task is completed in any project', 'create a new task titled “Review launch” in “Reviews”',
    'set the new task’s priority to Low', 'tags “review” and “next”', 'leave the new task’s notes empty',
    'set the new task’s due date to 2027-01-01 00:00:00.000 UTC', 'only if “Reviews” has no open task titled exactly “Review launch” when checked',
    'The triggering task stays unchanged', 'The new task starts open']) assert.ok(result.summary.includes(phrase), phrase);
  assert.doesNotMatch(result.summary, /no duplicates|prevent.*duplicate/);
});

test('copied fields and composed titles identify the source, exact elapsed origin and native defaults', () => {
  for (const title of [{ kind: 'title', step: 'read', prefix: 'Review ', suffix: ' next' }, { kind: 'taskField', step: 'read', field: 'title' }]) {
    const fields = { title, projectId: { kind: 'taskField', step: 'read', field: 'projectId' },
      priority: { kind: 'taskField', step: 'read', field: 'priority' }, dueAt: { kind: 'eventOffset', seconds: 432000 } };
    const result = describeRule({ coverage: 'complete', hook: 'TaskCompleted', conditions: [{ field: 'status', value: 'COMPLETED', step: 'read' }],
      action: { capability: 'tasks.create', step: 'write', target: 'newTask', fields } }, projectName);
    assert.equal(result.complete, true);
    assert.match(result.summary, /the triggering task’s title.*in the triggering task’s project/);
    assert.match(result.summary, /copy the triggering task’s priority as read/);
    assert.match(result.summary, /give the new task a due date exactly 5 days after the triggering task was completed/);
    assert.match(result.summary, /only if the triggering task is completed/);
    assert.match(result.summary, /new task starts open with no tags and empty notes/);
    assert.doesNotMatch(result.summary, /168|7 days|Normal priority/);
  }
  const copied = describeRule({ coverage: 'complete', hook: 'TaskCreated', conditions: [], action: { capability: 'tasks.create', step: 'write', target: 'newTask',
    fields: { title: literal('Copy'), projectId: literal('reviews'), dueAt: { kind: 'taskField', step: 'read', field: 'dueAt' }, notes: literal('Keep this exact note') } } }, projectName);
  assert.match(copied.summary, /copy the triggering task’s due date as read/);
  assert.match(copied.summary, /notes to “Keep this exact note”/);
  assert.match(copied.summary, /Normal priority and no tags/);
  assert.match(copied.summary, /does not replay earlier task additions/);
});

test('combined changes and copied update values remain concrete without inventing preservation', () => {
  const result = describeRule(update({ priority: { kind: 'taskField', step: 'read', field: 'priority' }, addTag: literal('next'),
    dueAt: { kind: 'taskField', step: 'read', field: 'dueAt' } }), projectName);
  assert.match(result.summary, /priority to the value read from that task/);
  assert.match(result.summary, /due date to the value read from that task/);
  assert.match(result.summary, /add the tag “next”/);
  assert.match(result.summary, /Leave its title, project, notes, and status unchanged/);
  assert.doesNotMatch(result.summary, /priority unchanged|due date unchanged|already present.*kept/);
});

test('partial and unavailable descriptions never promise full scope or preserved fields', () => {
  const partial = describeRule({ ...update({ dueAt: { kind: 'eventOffset', seconds: 90 } }), coverage: 'partial', conditions: undefined }, projectName);
  assert.equal(partial.complete, false);
  assert.equal(partial.scope, undefined);
  assert.equal(partial.unchanged, null);
  assert.match(partial.summary, /^The full behavior could not be described/);
  assert.match(partial.summary, /exactly 90 elapsed seconds/);
  assert.match(partial.summary, /full conditions could not be described/);
  assert.doesNotMatch(partial.summary, /any project|regardless|stay.*unchanged|already present.*kept/);
  const unresolved = describeRule(update({ priority: literal('high') }, [{ field: 'projectId', value: 'private-project-id', step: 'read' }]), projectName);
  assert.equal(unresolved.complete, false);
  assert.match(unresolved.summary, /chosen project \(name unavailable\)/);
  assert.doesNotMatch(unresolved.summary, /private-project-id|in any project/);
  assert.equal(describeRule({ coverage: 'unavailable' }, projectName), null);
});


test('open-match snapshot wording respects the trigger and distinguishes creation from updates', () => {
  const conditions = [{ field: 'noOpenMatch', step: 'match', projectId: 'reviews', title: 'Review' }];
  for (const [hook, wording] of [['TaskCreated','additions'],['TaskCompleted','completions']]) {
    const result = describeRule({ coverage: 'complete', hook, conditions, action: {
      capability: 'tasks.create', target: 'newTask', step: 'write', fields: { projectId: literal('reviews'), title: literal('Review') },
    } }, projectName);
    assert.match(result.scope, new RegExp('simultaneous task ' + wording));
    assert.match(result.scope, /more than one matching task/);
    assert.doesNotMatch(result.scope, /follow-up/);
  }
  const changed = describeRule(update({ priority: literal('high') }, conditions), projectName);
  assert.match(changed.scope, /matching tasks can change after the check/);
  assert.doesNotMatch(changed.scope, /create more than one/);
});
