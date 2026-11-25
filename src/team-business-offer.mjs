import Ajv from 'ajv';
import { AuthoringError } from './authoring-provider.mjs';
import { digest, json } from './extension-catalog.mjs';
import { teamModel } from './team-runtime.mjs';
import { normalizeTeamAgreement, matchesTeamContext, teamPriorities, teamChildStates, TEAM_AGREEMENT, TEAM_BINDINGS } from './team-qualification.mjs';

const [created, completing] = TEAM_BINDINGS;
const text = { type: 'string' }, absent = { type: 'null' };
const nullable = schema => ({ anyOf: [schema, absent] });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
// The wire schema uses the providers' shared strict subset. Host validation owns upper bounds.
const choices = values => nullable({ type: 'array', minItems: 1, items: { type: 'string', enum: values } });
const binding = (when, expected) => nullable(object({
  source: { ...text, description: 'JSON string containing only steps and return. Daymark supplies the program metadata.' },
  outcomes: { type: 'array', minItems: 1, description: 'At most eight disjoint outcomes.', items: object({ when: object(when), expected: object(expected) }) },
}));
export const teamOfferFields = {
  summary: { ...text, description: 'One line describing the business behavior, including any chosen defaults.' },
  [created]: binding({ priority: choices(teamPriorities) }, { linkedTask: nullable(object({ title: text, assigneeId: text })) }),
  [completing]: binding({ priority: choices(teamPriorities), linkedTask: choices(teamChildStates) },
    { allow: { type: 'boolean' }, message: nullable({ ...text, description: 'Exact explanation when blocked, or null if not specified.' }) }),
};
const validate = new Ajv({ ownProperties: true }).compile(object(teamOfferFields));

function reject(code, path) {
  const error = new AuthoringError('INVALID_TOOL_ARGUMENTS');
  error.diagnostics = [{ code, path }];
  throw error;
}
const line = (value, limit) => value.isWellFormed() && value.trim() && value === value.trim()
  && value.length <= limit && !/\p{Cc}/u.test(value);
const slug = hook => hook === created ? 'creation' : 'completion';
const wants = ({ priority, linkedTask }) => ({ ...(priority && { priority }), ...(linkedTask && { childStatus: linkedTask }) });
const allowed = { decision: 'ALLOW', status: 'completed' };
const emptyEffect = { outcome: 'COMPLETED', children: 0, receipt: 'NONE' };
// Accept older full-source offers, but only these known metadata fields are host-owned.
const sourceFields = ['steps', 'return', 'language', 'name', 'domain', 'entrypoint'];
const hasSourceFields = program => program && typeof program === 'object' && !Array.isArray(program)
  && Object.keys(program).every(key => sourceFields.includes(key))
  && Object.hasOwn(program, 'steps') && Object.hasOwn(program, 'return');

// Catch only visible source-contract violations. Compilation and checked-expression coverage happen after confirmation.
function offerSource(program, hook, outcomes) {
  const path = `/${hook}/source`;
  if (!Array.isArray(program.steps) || program.steps.length > 8
      || program.steps.some(step => !step || typeof step !== 'object' || Array.isArray(step))) reject('SOURCE_STEPS_INVALID', `${path}/steps`);
  const taskReads = new Set(program.steps.filter(step => step.call === 'tasks.get').map(step => step.id));
  const taskIds = new Set(['input.taskId', ...[...taskReads].map(id => `${id}.id`)]);
  const cel = value => typeof value?.cel === 'string' ? value.cel.trim() : null;
  const checkFields = (value, field) => {
    if (!taskReads.size) return;
    JSON.stringify(value, (key, part) => {
      if (key === 'cel' && typeof part === 'string') {
        const expr = part.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
        for (const [, id, name] of expr.matchAll(/\b([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)/g))
          if (taskReads.has(id) && !['id', 'projectId', 'priority'].includes(name)) reject('TASK_FIELD_UNSUPPORTED', field);
      }
      return part;
    });
  };
  for (const [i, step] of program.steps.entries()) {
    const field = `${path}/steps/${i}`;
    checkFields(step, field);
    if (hook === completing && Object.hasOwn(step, 'when')) reject('COMPLETION_STEP_GUARD', `${field}/when`);
    if (Object.hasOwn(step, 'onError')) reject('SOURCE_ERROR_BRANCH_UNSUPPORTED', `${field}/onError`);
    if (step.call === 'tasks.get' && cel(step.args?.taskId) !== 'input.taskId')
      reject('TASK_READ_NOT_ORIGINAL', `${field}/args/taskId`);
    if (step.call === 'tasks.childrenSummary' && (hook !== completing
        || !taskIds.has(cel(step.args?.parentTaskId)) || cel(step.args?.originEventId) !== 'input.creationEventId'))
      reject('LINKED_READ_NOT_EVENT_BOUND', `${field}/args`);
    if (hook === created && step.call === 'tasks.create' && Object.hasOwn(step, 'when')
        && outcomes.every(o => o.expect.children === 1)) reject('CREATION_GUARD_HAS_NO_SKIP', `${field}/when`);
  }
  checkFields(program.return, `${path}/return`);
  const source = json({ language: 'keir/3', name: `daymark-${slug(hook)}`, entrypoint: hook,
    domain: { ...teamModel.domain, fingerprint: digest(json(teamModel)) }, steps: program.steps, return: program.return });
  if (Buffer.byteLength(source) > 65536) reject('SOURCE_INVALID', path);
  return source;
}

// Project saved agreements back to business facts, never expose the native test scripts in an edit.
export function businessProposal(agreement, sources) {
  const unsupported = agreement.claims.some(claim => claim.outcomes.some(({ when }) =>
    Object.keys(when).some(key => key !== 'priority' && !(claim.hook === completing && key === 'childStatus'))));
  if (unsupported) return { summary: agreement.summary, unavailable: true };
  const fragments = {};
  for (const { hook } of agreement.claims) {
    const program = JSON.parse(sources[hook]);
    if (!hasSourceFields(program) || program.entrypoint !== hook) return { summary: agreement.summary, unavailable: true };
    fragments[hook] = json({ steps: program.steps, return: program.return });
  }
  const list = value => value === undefined ? null : Array.isArray(value) ? value : [value];
  return {
    summary: agreement.summary,
    ...Object.fromEntries(TEAM_BINDINGS.map(hook => {
      const claim = agreement.claims.find(c => c.hook === hook);
      return [hook, !claim ? null : { source: fragments[hook], outcomes: claim.outcomes.map(({ when, expect }) => hook === created
        ? { when: { priority: list(when.priority) }, expected: { linkedTask: expect.children ? { title: expect.childTitle, assigneeId: expect.childAssigneeId } : null } }
        : { when: { priority: list(when.priority), linkedTask: list(when.childStatus) },
          expected: { allow: expect.decision === 'ALLOW', message: expect.message || null } }) }];
    })),
  };
}

// Write-independent expectations in, existing saved agreement out. No compiler, tasks, database or observations.
export function expandTeamOffer(input, actor, members) {
  if (Buffer.byteLength(JSON.stringify(input)) > 98304) reject('OFFER_TOO_LARGE', '/arguments');
  if (!validate(input)) {
    const path = validate.errors.reduce((best, error) => error.instancePath.length > best.length ? error.instancePath : best, '');
    reject('OFFER_FIELD_INVALID', path || '/arguments');
  }
  if (!line(input.summary, 1024)) reject('SUMMARY_INVALID', '/summary');
  if (!input[created] && !input[completing]) reject('OFFER_EMPTY', '/arguments');
  const people = new Map(members.map(member => [member.id, member]));
  const author = people.get(actor), peer = members.find(member => member.id !== actor);
  if (author?.role !== 'ADMIN' || !peer) reject('TEAM_MEMBERS_REQUIRED', '/arguments');

  const bindings = {}, claims = [];
  for (const hook of TEAM_BINDINGS) {
    const spec = input[hook], path = `/${hook}`;
    if (!spec) { bindings[hook] = null; continue; }
    if (spec.outcomes.length > 8) reject('TOO_MANY_OUTCOMES', `${path}/outcomes`);
    const { source } = spec;
    if (!source.isWellFormed() || Buffer.byteLength(source) > 65536) reject('SOURCE_INVALID', `${path}/source`);
    let program;
    try { program = JSON.parse(source); } catch { reject('SOURCE_JSON_INVALID', `${path}/source`); }
    if (!hasSourceFields(program)) reject('SOURCE_FIELDS_INVALID', `${path}/source`);
    if (Object.hasOwn(program, 'entrypoint') && program.entrypoint !== hook) reject('SOURCE_ENTRYPOINT_MISMATCH', `${path}/source`);
    const outcomes = spec.outcomes.map(({ when, expected }, i) => {
      const field = `${path}/outcomes/${i}`;
      if (Object.values(when).some(values => values && new Set(values).size !== values.length)) reject('CONDITION_DUPLICATE', `${field}/when`);
      let expect;
      if (hook === created) {
        const task = expected.linkedTask;
        if (task && !line(task.title, 120)) reject('TITLE_INVALID', `${field}/expected/linkedTask/title`);
        if (task && !people.has(task.assigneeId)) reject('ASSIGNEE_NOT_CURRENT', `${field}/expected/linkedTask/assigneeId`);
        expect = task ? { outcome: 'COMPLETED', children: 1, receipt: 'CONFIRMED', childTitle: task.title, childAssigneeId: task.assigneeId } : emptyEffect;
      } else {
        if (expected.message !== null && (expected.allow || !line(expected.message, 256))) reject('BLOCK_MESSAGE_INVALID', `${field}/expected/message`);
        expect = expected.allow ? allowed : { decision: 'DENY', status: 'open', ...(expected.message !== null && { message: expected.message }) };
      }
      return { id: `outcome-${i + 1}`, when: wants(when), expect };
    });
    bindings[hook] = offerSource(program, hook, outcomes);
    claims.push({ id: slug(hook), hook, description: input.summary, outcomes });
  }

  const seen = new Set();
  const choose = (hook, facts) => {
    const claim = claims.find(c => c.hook === hook);
    if (!claim) return null;
    const matching = claim.outcomes.filter(o => matchesTeamContext(o.when, facts));
    if (matching.length !== 1) reject(matching.length ? 'OUTCOMES_OVERLAP' : 'OUTCOME_MISSING', `/${hook}/outcomes`);
    seen.add(matching[0]);
    return matching[0];
  };
  const examples = [];
  const usePriority = claims.some(c => c.outcomes.some(o => o.when.priority));
  const priorities = usePriority ? teamPriorities : ['normal'];
  const by = member => ({ id: member.id === actor ? 'author' : 'teammate', userId: member.id, role: member.role });
  const cover = (hook, outcome) => outcome ? { covers: { claimId: slug(hook), outcomeId: outcome.id } } : {};
  const complete = (outcome, ref = 'work', who = 'author') => ({
    op: 'complete', actor: who, ref, expect: outcome?.expect ?? allowed, ...cover(completing, outcome),
  });
  let writes = 0;
  const decisions = new Set();
  for (const priority of priorities) {
    const createdOutcome = choose(created, { priority }), effect = createdOutcome?.expect ?? { ...emptyEffect, outcome: 'NONE' };
    const child = effect.children === 1;
    const assignee = child ? people.get(effect.childAssigneeId) : null;
    const actors = [by(author), by(assignee && assignee.id !== actor ? assignee : peer)];
    const start = { op: 'create', actor: 'author', ref: 'work', title: 'Example original task', priority, expect: { status: 'open' } };
    const dispatch = { op: 'dispatch', ref: 'work', expect: effect, ...cover(created, createdOutcome) };
    const add = (suffix, name, actions, fault = 'NONE') => examples.push({
      id: `${priority}-${suffix}`, name: usePriority ? `${name} (${priority} priority)` : name,
      actors, initialTasks: [], fault, actions: [start, ...actions],
    });
    const completion = state => {
      const outcome = choose(completing, { priority, childStatus: state });
      if (outcome) decisions.add(outcome.expect.decision);
      return complete(outcome);
    };
    if (!child) {
      add('original', 'No linked task is added', [dispatch, completion('absent')]);
      continue;
    }
    writes++;
    const finishLinked = complete(null, 'work.child', by(assignee).id);
    const beforeDispatch = input[completing] && completion('absent');
    const whileOpen = completion('open');
    const afterLinked = input[completing] && completion('completed');
    if (beforeDispatch?.expect.decision === 'ALLOW')
      add('before-link', 'Complete before a linked task is added', [beforeDispatch]);
    const before = beforeDispatch?.expect.decision === 'DENY' ? [beforeDispatch] : [];
    if (afterLinked && whileOpen.expect.decision === 'ALLOW') {
      add('after-link', 'Complete after the linked task is done', [...before, dispatch, finishLinked, afterLinked]);
      add('linked-open', 'Complete while the linked task is open', [dispatch, whileOpen, finishLinked]);
    } else {
      add('handoff', 'Hand off to the linked task', [...before, dispatch, whileOpen, finishLinked, ...(afterLinked ? [afterLinked] : [])]);
    }
    for (const fault of ['BEFORE_WRITE', 'LOST_REPLY']) {
      const committed = fault === 'LOST_REPLY';
      add(committed ? 'lost-reply' : 'no-write', committed ? 'Find the linked task when the reply is lost' : 'Confirm no linked task was added',
        [{ op: 'dispatch', ref: 'work', expect: { ...(committed ? effect : emptyEffect), outcome: 'UNCERTAIN' } },
          { op: 'reconcile', actor: 'author', ref: 'work', expect: { effect: committed ? 'CONFIRMED' : 'NONE', children: Number(committed) } }], fault);
    }
  }
  for (const claim of claims) for (const [i, outcome] of claim.outcomes.entries())
    if (!seen.has(outcome)) reject('OUTCOME_UNREACHABLE', `/${claim.hook}/outcomes/${i}/when`);
  if (input[created] && !writes) reject('NO_LINKED_TASK_EXPECTED', `/${created}/outcomes`);
  if (input[completing] && decisions.size !== 2) reject('COMPLETION_NEEDS_ALLOW_AND_BLOCK', `/${completing}/outcomes`);
  let agreement;
  try { agreement = normalizeTeamAgreement({ format: TEAM_AGREEMENT, summary: input.summary, claims, examples }); }
  catch (error) {
    if (![400, 413].includes(error.status)) throw error;
    reject('OFFER_EXAMPLES_LIMIT', '/arguments');
  }
  return { bindings, agreement };
}
