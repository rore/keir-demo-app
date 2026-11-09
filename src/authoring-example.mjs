import { taskEffectSyntax, taskEffectScenarioExamples } from './task-effect-simulation.mjs';

export const businessContext = Object.freeze({
  application: 'Daymark',
  purpose: 'Help a person describe, create and revise distinct personal extensions using only this host’s published extension points.',
  supported: 'Use supportedHooks for availability and the discovered DCM for the exact types and fields. TaskBeforeCreate checks the proposed project, priority, normalized tags, hasNotes and hasDueDate before saving; it has no title, notes text or due timestamp. A read-only decision returns ALLOW with an empty message or DENY with a plain correction. ALLOW permits normal native validation to continue and does not prove a save. Whitespace-only native notes have hasNotes false. TaskCreated runs after an eligible future task addition. TaskCompleted runs after a future native task completion. Event rules can use project, exact title, tag, priority and due date conditions as requested. One write can create a task or update the triggering task. Creation can set title, notes, tags, priority and due date. An update can add a tag or set priority or due date and preserves omitted fields. A fixed destination chooses an existing project, while a same-project destination can use source.projectId from tasks.get. Discover exact IDs for fixed project choices, retrieve later pages with discover_projects and clarify ambiguous names. Compare exact titles with case-sensitive equality. A new task can use a fixed title, copy source.title or append a fixed suffix with source.title + " – follow-up". Quote confirmed text as literal data and preserve it exactly. The open-task lookup answers only whether an open task in one project has the exact supplied title. The host binds the actor, triggering task and write key.',
  startingPoints: 'Editable ideas. Check that a client-tagged task has a due date before saving. Require notes for high-priority tasks, or the review tag for tasks in a chosen project. Give a new task high priority if it is in Inbox, tagged client and titled exactly “Quote for spring launch”. When a high-priority task tagged review in Launch is completed, create a review in Reviews due 168 hours after completion. Create a follow-up after a Launch task is completed if no open task with the chosen exact title exists in the chosen project. When a task without a due date is added to Onboarding, set its due date to 168 hours after addition. These are examples. Resolve each real project, title and other choice from the current request.',
  unavailable: 'Clearing a due date, broad search, fuzzy title matching, scheduling, multiple writes and arbitrary app operations are unavailable. An open-task lookup does not guarantee duplicate prevention under concurrent events. Keir 1 rules are read-only. Editing a running Keir 2 rule creates a Keir 3 draft needing fresh approval.',
  checking: 'Try example tasks without changing tasks. Explain that your tasks have not changed. For before-save checks, include matching allow and deny, nonmatching allow and unavailable examples; blocked is distinct from denied. For event rules, include relevant matches, misses, unavailable reads and write failures. For elapsed dates, check exact UTC input and output. Ask what should happen when intent is unclear.',
  decisions: 'The person decides the intended behavior and expectations. Explain actual differences. Human approval and turning on the exact checked change are separate decisions.',
  effects: 'ALLOW and DENY describe a before-save decision; BLOCKED means the check could not establish a valid decision. None proves a native task was saved. Source-authored CREATED, UPDATED and NO_OP labels are event rule results. Host-observed evidence establishes an example effect. A confirmed native receipt establishes a real task change. UNKNOWN may have an effect and must not trigger blind retry. Activation and existing tasks do not emit events. A later human completion of a generated task is another legitimate event and may create another task. Creation itself does not emit completion.',
  currentUse: 'currentUse describes the selected version separately from currentProposal, which is the draft. Only checkedSummary supports describing what the selected version did in its synthetic examples; it does not describe live task observations or untested inputs. Preserve its scope and truncation. If unavailableReason is present, keep the known selected identity, explain that checked behavior is unavailable and never infer behavior from names, source or draft evidence. Another item’s selection is identity only.',
  navigation: 'About this rule is in chat. View simulation, View saved changes and Show example checks open saved review; View latest changes returns from earlier review. New results do not open or replace review automatically or move focus. Hide simulation keeps chat and unsent text; Back to conversation closes inspection. Approve this change records exact approval. Turn on for new tasks, Turn on for tasks added and Turn on for tasks completed require confirmed host state; chat grants neither approval nor activation. View what’s in use shows this item’s selected version outside earlier-discussion or stale views. Continue saved changes returns to draft: read-only navigation. History and details > Inspect saved source and examples shows the viewed version, not a comparison screen; return to draft to inspect its code. Offer source only when asked. View earlier examples opens the exact earlier saved check. View checked examples opens a current check that is not eligible for approval. Never invent Compare versions, View history or a version comparison view. Keep stale, unavailable and uncertain outcomes explicit.',
});

export function authoringExample(host) {
  return {
    label: 'Task customization syntax',
    description: 'FORMAT ONLY. Adapt source and independent examples to the person’s intent and the discovered DCM. Use sample project conditions and literal destinations only when the person chose them. Never compile placeholders or treat these examples as customer consent.',
    source: JSON.stringify(JSON.parse(taskEffectSyntax(host))), cases: taskEffectScenarioExamples(host).map(text => JSON.stringify(JSON.parse(text))), situations: [],
  };
}

// Project immutable synthetic proof, never task records or provider continuation text.
export function evidenceSummary(proof, originals) {
  let truncated = proof.reports.length > 8;
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
  const examples = originals.map(original => JSON.parse(original));
  const cases = proof.reports.slice(0, 8).map(item => {
    const example = examples.find(example => example.id === item.id);
    if (item.report.mismatches.length > 8) truncated = true;
    return {
      id: text(item.id), label: text(item.label), status: text(item.report.status),
      taskStatus: text(item.taskStatus) ?? null, readFailure: text(item.readFailure) ?? null,
      expected: { ...fields(item.expected?.outcome ?? item.expected, ['classification', 'code']), consumption: consumption(example?.expect?.consumption ?? item.expected?.consumption),
        ...(item.report.observed && changes(item.expected)) },
      actual: { native: fields(item.report.native, ['classification', 'code']), consumption: consumption(item.report.consumption),
        ...(item.report.observed && { observed: { effect: text(item.report.observed.effect), ...changes(item.report.observed) } }) },
      ...((item.report.observed || item.report.scenario?.proposal) && { scenario: scenario(item.report.scenario) }),
      mismatches: item.report.mismatches.slice(0, 8).map(item => ({ ...fields(item, ['stage', 'code']),
        ...(Number.isSafeInteger(item.ordinal) && item.ordinal >= 0 ? { ordinal: item.ordinal } : {}) })),
    };
  });
  return { statuses: cases.map(item => item.status), cases, truncated };
}
