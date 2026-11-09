import { taskEffectSyntax, taskEffectScenarioExamples, taskEffectObservationMatches, taskEffectExpected } from './task-effect-simulation.mjs';
import { decodeKeirScenario } from './keir-scenario.mjs';

export const businessContext = Object.freeze({
  application: 'Daymark',
  purpose: 'Help a person describe, create and revise distinct personal extensions using only this host’s published extension points.',
  supported: "Resolve availability from supportedHooks and exact types and fields from the DCM. TaskBeforeCreate sees proposed project, priority, normalized tags, hasNotes and hasDueDate, without title, notes text or due timestamp. Return ALLOW with an empty message or DENY with a plain correction. ALLOW only continues native validation; it does not prove a save. Whitespace-only notes have hasNotes false. TaskCreated runs after eligible future additions; TaskCompleted after future native completions. Event conditions can use project, exact title, tag, priority or due date. One write creates a task or updates the triggering task. Creation can set title, notes, tags, priority and due date; updates can add a tag or set priority or due date, preserving omitted fields. Resolve fixed project IDs with paged discover_projects and clarify ambiguous names. Same-project destinations use source.projectId from tasks.get. Exact title matching is case-sensitive. A title can be fixed, copy source.title or append a fixed suffix with source.title + \" – follow-up\". Preserve confirmed text exactly as literal data. The open-task lookup checks only an open task with one exact title in one project. The host binds the actor, triggering task and write key.",
  startingPoints: 'Editable ideas. Check that a client-tagged task has a due date before saving. Require notes for high-priority tasks, or the review tag for tasks in a chosen project. Give a new task high priority if it is in Inbox, tagged client and titled exactly “Quote for spring launch”. When a high-priority task tagged review in Launch is completed, create a review in Reviews due 168 hours after completion. Create a follow-up after a Launch task is completed if no open task with the chosen exact title exists in the chosen project. When a task without a due date is added to Onboarding, set its due date to 168 hours after addition. These are examples. Resolve each real project, title and other choice from the current request.',
  unavailable: 'Clearing a due date, broad search, fuzzy title matching, scheduling, multiple writes and arbitrary app operations are unavailable. An open-task lookup does not guarantee duplicate prevention under concurrent events. Keir 1 rules are read-only. Editing a running Keir 2 rule creates a Keir 3 draft needing fresh approval.',
  checking: 'Try example tasks without changing tasks. Explain that your tasks have not changed. For before-save checks, include matching allow and deny, nonmatching allow and unavailable examples; blocked is distinct from denied. For event rules, include relevant matches, misses, unavailable reads and write failures. For elapsed dates, check exact UTC input and output. Ask what should happen when intent is unclear.',
  decisions: 'The person decides the intended behavior and expectations. Explain actual differences. Human approval and turning on the exact checked change are separate decisions.',
  effects: 'ALLOW and DENY describe a before-save decision; BLOCKED means the check could not establish a valid decision. None proves a native task was saved. Source-authored CREATED, UPDATED and NO_OP labels are event rule results. Host-observed evidence establishes an example effect. A confirmed native receipt establishes a real task change. UNKNOWN may have an effect and must not trigger blind retry. Activation and existing tasks do not emit events. A later human completion of a generated task is another legitimate event and may create another task. Creation itself does not emit completion.',
  currentUse: "currentUse is the selected version, separate from currentProposal. Describe its synthetic examples only from checkedSummary, preserving scope and truncation. It does not prove live effects or untested behavior. With unavailableReason, retain selected identity and say checked behavior is unavailable; never infer it from names, source or draft evidence. Another item’s selection gives identity only.",
  navigation: 'About this rule is in chat. View simulation, See proposed change and Show example checks open saved review; See current proposal returns from earlier review. New results do not open or replace review automatically or move focus. Hide simulation keeps chat and unsent text; Back to conversation closes inspection. Approve this change records exact approval. Turn on for new tasks, Turn on for tasks added and Turn on for tasks completed require confirmed host state; chat grants neither approval nor activation. View what’s in use shows this item’s selected version outside earlier-discussion or stale views. Return to proposal returns to draft: read-only navigation. More > Inspect saved source and examples shows the viewed version, not a comparison screen; return to draft to inspect its code. Offer source only when asked. View earlier examples opens the exact earlier saved check. View checked examples opens a current check that is not eligible for approval. Never invent Compare versions, View history or a version comparison view. Keep stale, unavailable and uncertain outcomes explicit.',
});

export function authoringExample(host) {
  return {
    label: 'Task customization syntax',
    description: 'FORMAT ONLY. Adapt source and independent examples to the person’s intent and the discovered DCM. Use sample project conditions and literal destinations only when the person chose them. Never compile placeholders or treat these examples as customer consent.',
    source: JSON.stringify(JSON.parse(taskEffectSyntax(host))), cases: taskEffectScenarioExamples(host).map(text => JSON.stringify(JSON.parse(text))), situations: [],
  };
}

// Project immutable synthetic proof, never task records or provider continuation text.
export function evidenceSummary(proof, originals, { presentation = true } = {}) {
  const reports = Array.isArray(proof?.reports) ? proof.reports : [];
  let truncated = reports.length > 8;
  const text = value => {
    if (typeof value !== 'string') return undefined;
    const points = Array.from(value); if (points.length > 128) truncated = true;
    return points.slice(0, 128).join('');
  };
  const fields = (value, names) => Object.fromEntries(names.filter(name => typeof value?.[name] === 'string').map(name => [name, text(value[name])]));
  const bounded = (value, project) => {
    if (!Array.isArray(value)) return null;
    if (value.length > 8) truncated = true;
    return value.slice(0, 8).map(project);
  };
  const task = (value, extra = []) => ({
    ...fields(value, ['id', 'title', 'projectId', 'projectName', 'status', 'priority', 'dueAt', ...extra]),
    ...(Array.isArray(value?.tags) && { tags: bounded(value.tags, text) }),
  });
  const changes = value => ({
    createdTasks: bounded(value?.createdTasks, value => task(value, ['notes'])),
    ...(Object.hasOwn(value ?? {}, 'updatedTasks') && { updatedTasks: bounded(value.updatedTasks, value => task(value, ['addTag'])) }),
  });
  const consumption = value => ({ ...fields(value, ['status', 'code']),
    ...(['ALLOWED', 'DENIED'].includes(value?.status) && value.result && { result: fields(value.result, ['decision', 'message']) }),
  });
  const scenario = value => {
    if (value?.proposal) return { proposal: {
      ...fields(value.proposal, ['projectId', 'priority']),
      ...(Array.isArray(value.proposal.tags) && { tags: bounded(value.proposal.tags, text) }),
      ...Object.fromEntries(['hasNotes', 'hasDueDate'].filter(name => typeof value.proposal[name] === 'boolean')
        .map(name => [name, value.proposal[name]])),
    } };
    const openMatches = bounded(value?.openMatches, match => ({
      ...fields(match, ['projectId', 'title']),
      ...(typeof match?.matches === 'boolean' && { matches: match.matches }),
    }));
    return {
      ...fields(value, ['occurredAt']),
      task: task(value?.task),
      ...(openMatches && { openMatches }),
    };
  };
  const examples = (Array.isArray(originals) ? originals : []).map(original => {
    try { return decodeKeirScenario(Buffer.from(original)); } catch { return null; }
  });
  const same = (left, right) => left === right || !!left && !!right && typeof left === 'object' && typeof right === 'object'
    && Array.isArray(left) === Array.isArray(right) && Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
  const withoutProjectName = value => { const { projectName, ...facts } = value ?? {}; return facts; };
  const cases = reports.slice(0, 8).map(value => {
    const item = value ?? {}, report = item.report ?? {};
    const matches = examples.filter(example => typeof item.id === 'string' && item.id.length && example?.id === item.id);
    const example = matches.length === 1 ? matches[0] : null;
    const mismatches = Array.isArray(report.mismatches) ? report.mismatches : [];
    let independentExpected;
    try { if (example) independentExpected = taskEffectExpected(example); }
    catch { /* Unusable original expectations cannot verify a report. */ }
    const recordedExpected = item.expected && { ...item.expected, ...(Array.isArray(item.expected.createdTasks)
      && { createdTasks: item.expected.createdTasks.map(withoutProjectName) }) };
    const expectedMatches = !!independentExpected && same(independentExpected, recordedExpected);
    const associated = expectedMatches && reports.filter(row => row?.id === item.id).length === 1;
    const expected = expectedMatches ? item.expected : independentExpected ?? item.expected;
    const native = report.native, effect = report.observed?.effect, decision = report.consumption?.status;
    const guard = !!report.scenario?.proposal && (decision === 'BLOCKED'
      || native?.classification === 'COMPLETED' && (decision === 'ALLOWED' && report.consumption.result?.decision === 'ALLOW'
        || decision === 'DENIED' && report.consumption.result?.decision === 'DENY'));
    const observed = report.observed;
    const knownChanges = Array.isArray(observed?.createdTasks) && (observed.updatedTasks === undefined || Array.isArray(observed.updatedTasks));
    const observedCount = knownChanges ? observed.createdTasks.length + (observed.updatedTasks?.length ?? 0) : 0;
    const observedEffect = effect === 'CONFIRMED' && knownChanges && observedCount > 0
      || effect === 'NONE' && knownChanges && observedCount === 0
      || effect === 'UNKNOWN' && observed?.createdTasks === null && (observed.updatedTasks === undefined || observed.updatedTasks === null);
    const usable = associated && ['PASS', 'FAIL'].includes(report.status) && Array.isArray(report.mismatches)
      && mismatches.every(row => typeof row?.stage === 'string' && typeof row.code === 'string' && row.stage !== 'SETUP')
      && ['COMPLETED', 'FAILED', 'BUSINESS_REJECTION', 'LIMIT_EXCEEDED', 'UNCERTAIN'].includes(native?.classification)
      && (guard || report.consumption?.status === 'REPORTED') && (guard ? effect === undefined || effect === 'NONE' && observedEffect : observedEffect);
    // Owned project names decorate display reports; all recorded simulation facts remain strict.
    const observationReport = { ...report,
      observed: observed && { ...observed, createdTasks: Array.isArray(observed.createdTasks)
        ? observed.createdTasks.map(withoutProjectName) : observed.createdTasks },
      scenario: report.scenario?.task ? { ...report.scenario, task: withoutProjectName(report.scenario.task) } : report.scenario };
    const actualMatches = ['outcome', 'consumption', 'calls'].every(key => same(example?.expect?.[key],
      key === 'outcome' ? native : report[key])) && taskEffectObservationMatches(example, observationReport);
    const verification = !usable ? 'unchecked' : report.status === 'PASS' && !mismatches.length && actualMatches ? 'matched' : 'mismatched';
    const availability = native?.classification === 'UNCERTAIN' ? 'unknown'
      : decision === 'BLOCKED' || typeof native?.error?.code === 'string' ? 'unavailable'
        : native?.classification === 'COMPLETED' ? 'available' : 'unknown';
    const outcome = effect === 'UNKNOWN' ? 'uncertain' : verification === 'unchecked' ? 'unchecked'
      : verification === 'mismatched' ? 'mismatch' : decision === 'BLOCKED' ? 'handled-problem'
        : effect === 'CONFIRMED' ? 'changed' : native.classification === 'COMPLETED' ? 'unchanged' : 'handled-problem';
    if (mismatches.length > 8) truncated = true;
    return {
      id: text(item.id), ...((presentation || item.label !== item.id) && { label: text(item.label) }),
      status: text(report.status), ...((presentation || verification !== 'matched') && { verification }),
      ...(presentation && { availability, outcome }),
      ...((presentation || typeof item.taskStatus === 'string') && { taskStatus: text(item.taskStatus) ?? null }),
      ...((presentation || typeof item.readFailure === 'string') && { readFailure: text(item.readFailure) ?? null }),
      expected: { ...fields(expected?.outcome ?? expected, ['classification', 'code']), consumption: consumption(expected?.consumption),
        ...(observed && changes(expected)) },
      actual: { native: { ...fields(native, ['classification', 'code']),
        ...(typeof native?.error?.code === 'string' && { error: fields(native.error, ['code']) }) }, consumption: consumption(report.consumption),
        ...(observed && { observed: { effect: text(effect), ...changes(observed) } }) },
      ...((observed || report.scenario?.proposal) && { scenario: scenario(report.scenario) }),
      mismatches: mismatches.slice(0, 8).map(item => ({ ...fields(item, ['stage', 'code']),
        ...(Number.isSafeInteger(item?.ordinal) && item.ordinal >= 0 ? { ordinal: item.ordinal } : {}) })),
    };
  });
  const counts = { verification: { matched: 0, mismatched: 0, unchecked: 0 },
    outcome: { changed: 0, unchanged: 0, 'handled-problem': 0, uncertain: 0, unchecked: 0, mismatch: 0 } };
  if (presentation) for (const item of cases) { counts.verification[item.verification]++; counts.outcome[item.outcome]++; }
  const totalCases = Math.max(examples.length, reports.length);
  return { ...(presentation && { statuses: cases.map(item => item.status) }), cases, totalCases, returnedCases: cases.length, ...(presentation && { counts }),
    truncated: truncated || totalCases > cases.length };
}
