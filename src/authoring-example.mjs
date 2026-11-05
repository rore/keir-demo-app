import { taskEffectSyntax, taskEffectScenarioExamples } from './task-effect-simulation.mjs';

export const businessContext = Object.freeze({
  application: 'Daymark',
  purpose: 'Help a person describe, create and revise distinct personal extensions using only this host’s published extension points.',
  supported: 'Use supportedHooks for availability and the discovered DCM for the exact types and fields. TaskCompleted runs after a future native task completion. A project condition decides whether to create a task. A fixed destination chooses a particular existing project, while a same-project destination follows each completed task. For example, the ProjectId at source.projectId from tasks.get can supply the compatible projectId argument of tasks.create. Discover actual IDs for fixed project choices, retrieve later pages with discover_projects and clarify ambiguous names. Compare an exact title with case-sensitive equality. One new task can use a fixed title, copy source.title or append a fixed suffix using a CEL expression such as source.title + " – follow-up". Quote the confirmed suffix as literal data and preserve its Unicode and separator exactly. The host binds the owner for both operations.',
  unavailable: 'Editing tasks, dates, notes, tags, search, scheduling, multiple writes and arbitrary app operations are unavailable. Legacy task advice is retired and read-only. No manual authoring fallback or fixed customer program is offered.',
  checking: 'Try example tasks without changing tasks. Explain that your tasks have not changed. Include unfinished, completed and unavailable tasks; ask what should happen when intent is unclear.',
  decisions: 'The person decides the intended behavior and expectations. Explain actual differences. Human approval and turning on the exact checked change are separate decisions.',
  effects: 'Source-authored CREATED and NO_OP labels are not native proof. Only host-observed evidence establishes a simulated effect; only a confirmed native receipt establishes a real task. UNKNOWN may have an effect and must not trigger blind retry. Activation and already-completed tasks create nothing. A later human completion of a generated task is another legitimate event and may create another task. Creation itself does not emit completion.',
  currentUse: 'currentUse describes the selected version separately from currentProposal, which is the draft. Only checkedSummary supports describing what the selected version did in its synthetic examples; it does not describe live task observations or untested inputs. Preserve its scope and truncation. If unavailableReason is present, keep the known selected identity, explain that checked behavior is unavailable and never infer behavior from names, source or draft evidence. Another item’s selection is identity only.',
  navigation: 'Use actual conditional controls. In Customization Studio, Your saved change appears in the conversation. Review checked examples, View saved changes, and Show example checks when offered lead to the same current saved review in chat. View latest changes opens the current saved review from an earlier one. New results do not open or replace the review automatically or move focus from the person. Hide checked examples closes the inline review while keeping the conversation and unsent text. Back to conversation closes secondary inspection. Approve this change records approval for that exact checked change; the separate Turn on for my tasks or Switch to this customization control changes what is in use only after confirmation. Opening review or agreeing in chat grants neither approval nor activation. Keep unavailable, stale or uncertain outcomes explicit; do not claim a change is in use without confirmed host state. View what’s in use is offered for this item’s selected version outside earlier-discussion or stale views. To compare business behavior, view that selected version, then choose Continue saved changes to return to the existing draft. This is read-only navigation, not creating or restoring changes. History and details and views of earlier examples remain secondary inspection. Keep source inspection secondary, only when the person asks for code. History and details > Inspect saved source and examples inspects the currently viewed version, not a comparison screen; return with Continue saved changes first to inspect draft code. View earlier examples opens the exact earlier saved check; View checked examples opens a current check that is not eligible for approval. Never invent Compare versions, View history or a version comparison view. If checked active behavior is unavailable, explain the limit. Real task outcomes require confirmed native reaction receipts; source labels never prove them.',
});

export function authoringExample(host) {
  return {
    label: 'Task customization syntax',
    description: 'FORMAT ONLY. Adapt source and independent examples to the person’s intent and the discovered DCM. Use sample project conditions and literal destinations only when the person chose them. Never compile placeholders or treat these examples as customer consent.',
    source: taskEffectSyntax(host), cases: taskEffectScenarioExamples(host), situations: [],
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
  const tasks = value => {
    if (!Array.isArray(value)) return null;
    if (value.length > 8) truncated = true;
    return value.slice(0, 8).map(task => fields(task, ['id', 'title', 'projectId', 'projectName', 'status']));
  };
  const examples = originals.map(original => JSON.parse(original));
  const cases = proof.reports.slice(0, 8).map(item => {
    const example = examples.find(example => example.id === item.id);
    if (item.report.mismatches.length > 8) truncated = true;
    return {
      id: text(item.id), label: text(item.label), status: text(item.report.status),
      taskStatus: text(item.taskStatus) ?? null, readFailure: text(item.readFailure) ?? null,
      expected: { ...fields(item.expected?.outcome ?? item.expected, ['classification', 'code']), consumption: fields(example?.expect?.consumption, ['status', 'code']),
        ...(item.report.observed && { createdTasks: tasks(item.expected?.createdTasks) }) },
      actual: { native: fields(item.report.native, ['classification', 'code']), consumption: fields(item.report.consumption, ['status', 'code']),
        ...(item.report.observed && { observed: { effect: text(item.report.observed.effect), createdTasks: tasks(item.report.observed.createdTasks) } }) },
      ...(item.report.observed && { scenario: { task: fields(item.report.scenario?.task, ['id', 'title', 'status', 'projectId', 'projectName']) } }),
      mismatches: item.report.mismatches.slice(0, 8).map(item => ({ ...fields(item, ['stage', 'code']),
        ...(Number.isSafeInteger(item.ordinal) && item.ordinal >= 0 ? { ordinal: item.ordinal } : {}) })),
    };
  });
  return { statuses: cases.map(item => item.status), cases, truncated };
}
