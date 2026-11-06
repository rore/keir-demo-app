import { taskEffectSyntax, taskEffectScenarioExamples } from './task-effect-simulation.mjs';

export const businessContext = Object.freeze({
  application: 'Daymark',
  purpose: 'Help a person describe, create and revise distinct personal extensions using only this host’s published extension points.',
  supported: 'Use supportedHooks for availability and the discovered DCM for the exact types and fields. TaskCreated runs after an eligible future task addition. TaskCompleted runs after a future native task completion. Use project, exact title, tag, priority and due date conditions as requested. One write can create a task or update the triggering task. Creation can set title, notes, tags, priority and due date. An update can add a tag or set priority or due date and preserves omitted fields. A fixed destination chooses an existing project, while a same-project destination can use source.projectId from tasks.get. Discover exact IDs for fixed project choices, retrieve later pages with discover_projects and clarify ambiguous names. Compare exact titles with case-sensitive equality. A new task can use a fixed title, copy source.title or append a fixed suffix with source.title + " – follow-up". Quote confirmed text as literal data and preserve it exactly. The open-task lookup answers only whether an open task in one project has the exact supplied title. The host binds the actor, triggering task and write key.',
  startingPoints: 'Four editable ideas. Give a new task high priority if it is in Inbox, tagged client and titled exactly “Quote for spring launch”. When a high-priority task tagged review in Launch is completed, create a review in Reviews due 168 hours after completion. Create a follow-up after a Launch task is completed if no open task with the chosen exact title exists in the chosen project. When a task without a due date is added to Onboarding, set its due date to 168 hours after addition. These are examples. Resolve each real project, title and other choice from the current request.',
  unavailable: 'Clearing a due date, broad search, fuzzy title matching, scheduling, multiple writes and arbitrary app operations are unavailable. An open-task lookup does not guarantee duplicate prevention under concurrent events. Earlier customizations are read-only and their saved discussion and examples remain available.',
  checking: 'Try example tasks without changing tasks. Explain that your tasks have not changed. Include relevant matches, misses, unavailable reads and write failures. For elapsed dates, check exact UTC input and output. Ask what should happen when intent is unclear.',
  decisions: 'The person decides the intended behavior and expectations. Explain actual differences. Human approval and turning on the exact checked change are separate decisions.',
  effects: 'Source-authored CREATED, UPDATED and NO_OP labels are rule results. Host-observed evidence establishes an example effect. A confirmed native receipt establishes a real task change. UNKNOWN may have an effect and must not trigger blind retry. Activation and existing tasks do not emit events. A later human completion of a generated task is another legitimate event and may create another task. Creation itself does not emit completion.',
  currentUse: 'currentUse describes the selected version separately from currentProposal, which is the draft. Only checkedSummary supports describing what the selected version did in its synthetic examples; it does not describe live task observations or untested inputs. Preserve its scope and truncation. If unavailableReason is present, keep the known selected identity, explain that checked behavior is unavailable and never infer behavior from names, source or draft evidence. Another item’s selection is identity only.',
  navigation: 'Use actual conditional controls. In Customization Studio, About this rule appears in the conversation. View simulation, View saved changes, and Show example checks when offered lead to the same current saved review in chat. View latest changes opens the current saved review from an earlier one. New results do not open or replace the review automatically or move focus from the person. Hide simulation closes the inline review while keeping the conversation and unsent text. Back to conversation closes secondary inspection. Approve this change records approval for that exact checked change; the separate Turn on for tasks added or Turn on for tasks completed control changes what is in use only after confirmation. Opening review or agreeing in chat grants neither approval nor activation. Keep unavailable, stale or uncertain outcomes explicit; do not claim a change is in use without confirmed host state. View what’s in use is offered for this item’s selected version outside earlier-discussion or stale views. To compare business behavior, view that selected version, then choose Continue saved changes to return to the existing draft. This is read-only navigation, not creating or restoring changes. History and details and views of earlier examples remain secondary inspection. Keep source inspection secondary, only when the person asks for code. History and details > Inspect saved source and examples inspects the currently viewed version, not a comparison screen; return with Continue saved changes first to inspect draft code. View earlier examples opens the exact earlier saved check; View checked examples opens a current check that is not eligible for approval. Never invent Compare versions, View history or a version comparison view. If checked active behavior is unavailable, explain the limit. Real task outcomes require confirmed native reaction receipts; source labels never prove them.',
});

export function authoringExample(host) {
  return {
    label: 'Task customization syntax',
    description: 'FORMAT ONLY. Adapt source and independent examples to the person’s intent and the discovered DCM. Use sample project conditions and literal destinations only when the person chose them. Never compile placeholders or treat these examples as customer consent.',
    source: taskEffectSyntax(host), cases: taskEffectScenarioExamples(host).map(text => JSON.stringify(JSON.parse(text))), situations: [],
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
  const scenario = value => {
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
      expected: { ...fields(item.expected?.outcome ?? item.expected, ['classification', 'code']), consumption: fields(example?.expect?.consumption, ['status', 'code']),
        ...(item.report.observed && changes(item.expected)) },
      actual: { native: fields(item.report.native, ['classification', 'code']), consumption: fields(item.report.consumption, ['status', 'code']),
        ...(item.report.observed && { observed: { effect: text(item.report.observed.effect), ...changes(item.report.observed) } }) },
      ...(item.report.observed && { scenario: scenario(item.report.scenario) }),
      mismatches: item.report.mismatches.slice(0, 8).map(item => ({ ...fields(item, ['stage', 'code']),
        ...(Number.isSafeInteger(item.ordinal) && item.ordinal >= 0 ? { ordinal: item.ordinal } : {}) })),
    };
  });
  return { statuses: cases.map(item => item.status), cases, truncated };
}
