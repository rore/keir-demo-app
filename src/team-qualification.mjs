import { fromBinary } from '@bufbuild/protobuf';
import { CheckedExprSchema } from '@bufbuild/cel-spec/cel/expr/checked_pb.js';
import { AppError } from './data.mjs';
import { digest, json } from './extension-catalog.mjs';
import { normalizeTeamCases } from './team-simulation.mjs';

export const TEAM_QUALIFICATION = 'daymark-team-claims/1';
export const TEAM_AGREEMENT = 'daymark-team-agreement/1';
export const TEAM_BINDINGS = Object.freeze(['TaskCreated', 'TaskBeforeComplete']);
export const teamPriorities = Object.freeze(['low', 'normal', 'high']);
export const teamChildStates = Object.freeze(['absent', 'open', 'completed']);
const domains = { priority: teamPriorities, status: ['open', 'completed'], childStatus: teamChildStates };
const word = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.isWellFormed() && value.trim() && value.length <= max && !/\p{Cc}/u.test(value);
const invalid = (path = '/agreement') => Object.assign(new AppError(400, 'Use the bounded agreed Team claims and native examples.'), { fieldPath: path });
const object = (value, allowed, required = allowed, path) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))
      || required.some(k => !Object.hasOwn(value, k))) throw invalid(path);
};

export function normalizeTeamAgreement(input) {
  object(input, ['format', 'summary', 'claims', 'examples']);
  if (input.format !== TEAM_AGREEMENT) throw invalid('/agreement/format');
  if (!line(input.summary, 2048)) throw invalid('/agreement/summary');
  if (!Array.isArray(input.claims) || input.claims.length < 1 || input.claims.length > 2) throw invalid('/agreement/claims');
  const ids = new Set(), hooks = new Set();
  for (const [i, claim] of input.claims.entries()) {
    const path = `/agreement/claims/${i}`;
    object(claim, ['id', 'hook', 'description', 'outcomes'], undefined, path);
    if (!word(claim.id) || ids.has(claim.id) || !TEAM_BINDINGS.includes(claim.hook) || hooks.has(claim.hook)
        || !line(claim.description, 1024) || !Array.isArray(claim.outcomes) || !claim.outcomes.length || claim.outcomes.length > 8) throw invalid(path);
    ids.add(claim.id); hooks.add(claim.hook);
    const outcomes = new Set();
    for (const [j, outcome] of claim.outcomes.entries()) {
      const field = `${path}/outcomes/${j}`;
      object(outcome, ['id', 'when', 'expect'], undefined, field);
      if (!word(outcome.id) || outcomes.has(outcome.id)) throw invalid(`${field}/id`);
      outcomes.add(outcome.id);
      object(outcome.when, Object.keys(domains), [], `${field}/when`);
      for (const [key, value] of Object.entries(outcome.when)) {
        const values = Array.isArray(value) ? value : [value];
        if (!values.length || new Set(values).size !== values.length || values.some(v => !domains[key].includes(v))) throw invalid(`${field}/when`);
      }
      const expected = outcome.expect;
      if (claim.hook === 'TaskCreated') {
        object(expected, ['outcome', 'children', 'receipt', 'childTitle', 'childAssigneeId', 'reportStatus'], ['outcome', 'children', 'receipt'], `${field}/expect`);
        if (expected.outcome !== 'COMPLETED' || ![0, 1].includes(expected.children)
            || expected.receipt !== (expected.children ? 'CONFIRMED' : 'NONE')
            || expected.children && (!line(expected.childTitle, 120) || !/^[A-Za-z0-9-]{1,128}$/.test(expected.childAssigneeId ?? ''))
            || !expected.children && (Object.hasOwn(expected, 'childTitle') || Object.hasOwn(expected, 'childAssigneeId'))
            || Object.hasOwn(expected, 'reportStatus') && !line(expected.reportStatus, 256)) throw invalid(`${field}/expect`);
      } else {
        object(expected, ['decision', 'status', 'message'], ['decision', 'status'], `${field}/expect`);
        if (!['DENY', 'ALLOW'].includes(expected.decision) || expected.status !== (expected.decision === 'ALLOW' ? 'completed' : 'open')
            || Object.hasOwn(expected, 'message') && (typeof expected.message !== 'string' || expected.message.length > 256 || /\p{Cc}/u.test(expected.message))) throw invalid(`${field}/expect`);
      }
    }
  }
  const examples = normalizeTeamCases(input.examples, { authored: true });
  for (const [i, c] of examples.entries()) for (const [j, action] of c.actions.entries()) if (action.covers) {
    const claim = input.claims.find(v => v.id === action.covers.claimId);
    if (!claim || claim.hook !== (action.op === 'dispatch' ? 'TaskCreated' : 'TaskBeforeComplete')
        || !claim.outcomes.some(v => v.id === action.covers.outcomeId)) throw invalid(`/agreement/examples/${i}/actions/${j}/covers`);
  }
  const normalized = json({ ...input, examples });
  if (Buffer.byteLength(normalized) > 32768) throw new AppError(413, 'The agreed Team behavior exceeds 32 KiB.');
  return JSON.parse(normalized);
}

export function teamAgreementUsers(agreement) {
  return [...new Set([...agreement.examples.flatMap(c => c.actors.map(a => a.userId)),
    ...agreement.claims.flatMap(c => c.outcomes.map(o => o.expect.childAssigneeId).filter(Boolean))])];
}

// Inspect coverage needs in checked bytes. Do not infer expected results from source or a run.
function coverageNeeds(artifact) {
  const dependencies = new Set(), guards = [], calls = [], unsupported = [];
  const steps = new Map((artifact.steps ?? []).map(s => [s.id, s]));
  if (!Array.isArray(artifact.steps) || artifact.steps.length > 64) return { unsupported: ['Unbounded checked steps.'] };
  for (const step of artifact.steps) {
    if (!['CALL', 'BIND'].includes(step.op) || Object.hasOwn(step, 'onError')) unsupported.push('The checked control flow is not covered by this qualification policy.');
    if (Object.hasOwn(step, 'when')) guards.push(step.id);
    if (step.op === 'CALL') {
      calls.push(step);
      if (!['tasks.get', 'tasks.childrenSummary', 'tasks.create'].includes(step.capability) || step.version !== '1')
        unsupported.push('A checked operation is outside the native Team catalog.');
    }
  }
  let bytes = 0, nodes = 0;
  const checked = new Map();
  const field = (expr, name, key) => expr?.exprKind?.case === 'selectExpr' && !expr.exprKind.value.testOnly
    && expr.exprKind.value.field === key && expr.exprKind.value.operand?.exprKind?.case === 'identExpr'
    && expr.exprKind.value.operand.exprKind.value.name === name;
  const currentTask = expr => field(expr, 'input', 'taskId')
    || [...steps.values()].some(s => s.capability === 'tasks.get' && field(expr, s.id, 'id')
      && field(checked.get(s.args?.taskId?.expr), 'input', 'taskId'));
  const visit = (expr, depth = 0) => {
    if (++nodes > 8192 || depth > 32) throw 0;
    const kind = expr?.exprKind;
    if (kind?.case === 'constExpr' || kind?.case === 'identExpr') return;
    if (kind?.case === 'selectExpr') {
      const selected = kind.value, operand = selected.operand?.exprKind, root = operand?.case === 'identExpr' ? operand.value.name : null;
      const capability = steps.get(root)?.capability;
      if (capability === 'tasks.get') {
        if (['priority', 'status'].includes(selected.field)) dependencies.add(selected.field);
        else if (!['id', 'projectId'].includes(selected.field)) unsupported.push('A task-field dependency has no finite native coverage contract.');
      } else if (capability === 'tasks.childrenSummary') {
        if (['exists', 'anyIncomplete'].includes(selected.field)) dependencies.add('childStatus');
        else unsupported.push('An unknown child-summary dependency is unverified.');
      } else if (root !== 'input' || !['taskId', 'creationEventId'].includes(selected.field))
        unsupported.push('An expression dependency is not observable by this native example policy.');
      visit(selected.operand, depth + 1); return;
    }
    if (kind?.case === 'callExpr') {
      if (!['_==_', '_!=_', '_&&_', '_||_', '!_', '_?_:_'].includes(kind.value.function))
        unsupported.push('An expression operation has no coverage rule in this policy.');
      if (kind.value.target) visit(kind.value.target, depth + 1);
      for (const arg of kind.value.args) visit(arg, depth + 1);
      return;
    }
    unsupported.push('An expression construct cannot be qualified.');
  };
  try {
    for (const [id, value] of Object.entries(artifact.expressions ?? {})) {
      if (typeof value.checked !== 'string' || value.checked.length > 22000 || (bytes += value.checked.length) > 256000) throw 0;
      const expr = fromBinary(CheckedExprSchema, Buffer.from(value.checked, 'base64')).expr;
      checked.set(id, expr);
      visit(expr);
    }
    for (const step of calls) {
      if (step.capability === 'tasks.get' && !field(checked.get(step.args?.taskId?.expr), 'input', 'taskId')
          || step.capability === 'tasks.childrenSummary' && (!currentTask(checked.get(step.args?.parentTaskId?.expr))
            || !field(checked.get(step.args?.originEventId?.expr), 'input', 'creationEventId')))
        unsupported.push('A native read is not bound to the observed task and its exact creation event.');
    }
  } catch { unsupported.push('The checked expression dependencies could not be inspected.'); }
  return { dependencies, guards, calls, unsupported };
}

export const matchesTeamContext = (when, facts) => facts && Object.entries(when).every(([key, values]) => (Array.isArray(values) ? values : [values]).includes(facts[key]));
const sameExpected = (expected, observed) => Object.entries(expected).every(([key, value]) => observed?.[key] === value);
export function qualifyAuthoredTeam({ agreement, cases, report, manifest, artifacts, projectId }) {
  const unverified = [], agreementDigest = digest(json(agreement));
  const reject = message => unverified.push(message);
  if (json(cases) !== json(agreement.examples)) reject('The checked examples differ from the agreed expectations. Fresh agreement and a new revision are required.');
  if (!report || !Array.isArray(report.cases) || report.cases.length !== cases.length) reject('The native report is incomplete.');
  const points = [];
  for (const [i, c] of cases.entries()) {
    const result = report?.cases?.[i];
    if (!result || result.passed !== true || result.id !== c.id || result.name !== c.name
        || !Array.isArray(result.events) || result.events.length !== c.actions.length) {
      reject('A native example does not match its saved action sequence.'); continue;
    }
    for (const [j, action] of c.actions.entries()) {
      const event = result.events[j];
      const binding = action.op === 'dispatch' ? 'TaskCreated'
        : action.op === 'complete' && !/\.(?:child|review)$/.test(action.ref) ? 'TaskBeforeComplete' : null;
       if (event?.action !== action.op || event.ref !== action.ref || json(event.expected) !== json(action.expect)
          || !sameExpected(action.expect, event.observed) || !Array.isArray(event.mismatches) || event.mismatches.length
          || !event.native?.taskId || !Number.isInteger(event.native.writeAttempts) || event.native.writeAttempts < 0 || event.native.writeAttempts > 1
           || event.binding !== binding || json(event.covers) !== json(action.covers ?? null)
           || action.op === 'dispatch' && (event.runtime?.hook !== 'TaskCreated'
             || (manifest.TaskCreated === null
               ? event.native.admissionBefore !== 'NO_HOOK' || event.runtime.outcome !== null || event.observed.outcome !== 'NONE'
                 || event.observed.children !== 0 || event.observed.receipt !== 'NONE' || event.native.writeAttempts !== 0
               : event.runtime.outcome?.classification !== event.observed.outcome || event.native.admissionBefore !== 'PENDING'))) {
        reject('A native action does not establish its independent expected result.'); continue;
      }
      if (action.op === 'dispatch' && event.observed.receipt === 'CONFIRMED') {
        try {
          const receipt = event.native.receipt, payload = JSON.parse(receipt.payload);
          if (receipt.effect !== 'CONFIRMED' || receipt.eventId !== event.native.eventId || receipt.result?.effect !== 'CONFIRMED'
              || !receipt.result.value?.id || receipt.result.value.id !== event.native.childId
              || payload.parentTaskId !== event.native.taskId || payload.projectId !== projectId
              || payload.title.trim() !== event.observed.childTitle || payload.assigneeId !== event.observed.childAssigneeId) throw 0;
        } catch { reject('A material child effect lacks exact native receipt and payload evidence.'); }
      }
      points.push({ c, action, event });
    }
  }
  const creation = agreement.claims.find(c => c.hook === 'TaskCreated');
  const alwaysNoChild = priorities => creation?.outcomes.every(o => Object.keys(o.when).every(key => key === 'priority'))
    && priorities.every(priority => {
      const options = creation.outcomes.filter(o => matchesTeamContext(o.when, { priority }));
      return options.length === 1 && options[0].expect.children === 0;
    });
  for (const hook of TEAM_BINDINGS) {
    const claim = agreement.claims.find(c => c.hook === hook);
    if (manifest[hook] === null) {
      if (claim) reject('An agreed binding is explicitly absent.');
      if (hook === 'TaskBeforeComplete' && !points.some(p => p.c.fault === 'NONE' && p.event.binding === hook
          && p.event.observed.decision === 'ALLOW' && p.event.observed.status === 'completed'
          && (manifest.TaskCreated === null || p.event.before?.childStatus === 'open')))
        reject('The intentionally absent completion binding has no native no-hold witness.');
      continue;
    }
    if (!claim) { reject('A present binding has no agreed behavior claim.'); continue; }
    let needs;
    try { needs = coverageNeeds(JSON.parse(artifacts[manifest[hook]])); }
    catch { reject('The exact required artifact is unavailable.'); continue; }
    for (const reason of needs.unsupported) reject(reason);
    if (!needs.dependencies) continue;
    const normal = points.filter(p => p.event.binding === hook && p.c.fault === 'NONE');
    const covered = [];
    for (const point of normal) {
      const cover = point.action.covers, outcome = claim.outcomes.find(o => o.id === cover?.outcomeId);
       if (cover?.claimId !== claim.id || !outcome || !matchesTeamContext(outcome.when, point.event.before)
          || !sameExpected(outcome.expect, point.event.observed)) {
        reject('A normal hook observation is not tied to its agreed context and decisive outcome.'); continue;
      }
      covered.push(point);
    }
    for (const outcome of claim.outcomes) if (!covered.some(p => p.action.covers.outcomeId === outcome.id)) reject('An agreed alternative has no native witness.');
    const fields = [...new Set([...needs.dependencies, ...claim.outcomes.flatMap(o => Object.keys(o.when))])].sort();
    if ([...needs.dependencies].some(k => !claim.outcomes.some(o => Object.hasOwn(o.when, k))))
      reject('A checked dependency is missing from the agreed contexts.');
    const contexts = fields.reduce((rows, key) => rows.flatMap(row => domains[key].map(value => ({ ...row, [key]: value }))), [{}]);
    for (const context of contexts) {
      // Only a verified creation for this root can make its linked task open or completed.
      // Exclude impossible combinations only when the creation claim decides by priority alone.
      if (hook === 'TaskBeforeComplete' && ['open', 'completed'].includes(context.childStatus)
          && alwaysNoChild(context.priority ? [context.priority] : teamPriorities)) continue;
      const outcomes = claim.outcomes.filter(o => matchesTeamContext(o.when, context));
      if (outcomes.length !== 1 || !covered.some(p => p.action.covers.outcomeId === outcomes[0].id
           && matchesTeamContext(context, p.event.before))) reject('Finite matching and nonmatching contexts are incomplete or ambiguous.');
    }
    if (hook === 'TaskCreated') {
      for (const call of needs.calls) if (!covered.some(p => p.event.runtime?.outcome?.trace?.some(t => t.event === 'CALL_SUCCEEDED' && t.step === call.id)))
        reject('A checked operation has no successful native execution witness.');
      for (const step of needs.guards) for (const taken of [false, true])
        if (!covered.some(p => p.event.runtime?.outcome?.trace?.some(t => t.event === 'GUARD_EVALUATED' && t.step === step && t.taken === taken)))
          reject('A checked event guard lacks both taken and skipped observations.');
      if (!needs.calls.some(c => c.capability === 'tasks.create') || !covered.some(p => p.event.observed.receipt === 'CONFIRMED'))
        reject('The event binding has no verified material task effect.');
      for (const fault of ['BEFORE_WRITE', 'LOST_REPLY']) if (!points.some(p => p.c.fault === fault && p.event.binding === hook
          && p.event.native.writeAttempts === 1 && p.event.observed.children === (fault === 'LOST_REPLY' ? 1 : 0)
          && p.event.observed.receipt === (fault === 'LOST_REPLY' ? 'CONFIRMED' : 'NONE')
          && p.event.observed.outcome !== 'COMPLETED')) reject('A native write-loss boundary is not checked.');
    } else {
      if (needs.guards.length) reject('Internal completion-step guards have no exposed native trace and remain unverified.');
      for (const decision of ['DENY', 'ALLOW']) if (!covered.some(p => p.event.observed.decision === decision))
        reject('The completion binding lacks a real allowed and rule-denied outcome.');
      if (needs.dependencies.has('childStatus') && !covered.some(p => p.event.observed.decision === 'DENY'
          && covered.some(q => q.c.id === p.c.id && q.action.ref === p.action.ref && q.event.observed.decision === 'ALLOW'
            && p.c.actions.indexOf(p.action) < q.c.actions.indexOf(q.action))))
        reject('The linked dependency has no denied-then-allowed witness for the same task.');
    }
  }
  return { policy: TEAM_QUALIFICATION, agreementDigest, eligible: unverified.length === 0, unverified: [...new Set(unverified)] };
}
