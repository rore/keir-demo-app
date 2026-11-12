export type RuleCondition = ({ field: "projectId" | "title" | "tag" | "priority" | "dueAbsent" | "status"; value?: string }
  | { field: "noOpenMatch"; projectId: string; title: string }) & { step: string };
export type RuleValue = { kind: "literal"; value: unknown } | { kind: "taskField"; step: string; field: string }
  | { kind: "eventOffset"; seconds: number } | { kind: "title"; step: string; prefix?: string; suffix?: string };
export type GuardCondition = { field: "projectId" | "priority" | "tag"; value: string; negated?: boolean }
  | { field: "hasNotes" | "hasDueDate"; value: boolean };
export type RuleDescription = { coverage: "complete" | "partial" | "unavailable"; hook?: string; conditions?: RuleCondition[];
  guard?: { conditions: GuardCondition[]; message: string };
  action?: { capability: "tasks.create" | "tasks.update"; step: string; target: "newTask" | "triggeringTask"; fields: Record<string, RuleValue> }; reason?: string };

const priority = (value: string) => value[0]?.toUpperCase() + value.slice(1).toLowerCase();
export const readableTime = (value: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
  ? value.replace("T", " ").replace("Z", " UTC") : value;
export function elapsedTime(seconds: number) {
  const amount = Math.abs(seconds);
  if (amount && amount % 86400 === 0) return `${amount / 86400} ${amount === 86400 ? "day" : "days"} (${amount / 3600} elapsed hours)`;
  if (amount && amount % 3600 === 0) return `${amount / 3600} elapsed ${amount === 3600 ? "hour" : "hours"}`;
  if (amount && amount % 60 === 0) return `${amount / 60} elapsed ${amount === 60 ? "minute" : "minutes"}`;
  return `${amount} elapsed ${amount === 1 ? "second" : "seconds"}`;
}

// Format host-derived facts; this layer never parses or evaluates a rule.
export function describeRule(description: RuleDescription | null | undefined, projectName: (id: string) => string | undefined) {
  if (!description || description.coverage === "unavailable") return null;
  if (description.hook === "TaskBeforeCreate" && description.guard) {
    const guard = description.guard;
    let complete = description.coverage === "complete";
    const conditions = guard.conditions.map(condition => {
      if (condition.field === "projectId") {
        const project = projectName(condition.value);
        if (!project) complete = false;
        return project ? `the task is in “${project}”` : "the task is in the chosen project (name unavailable)";
      }
      if (condition.field === "priority") return `its priority is ${priority(condition.value)}`;
      if (condition.field === "tag") return `it ${condition.negated ? "does not have" : "has"} the tag “${condition.value}”`;
      if (condition.field === "hasNotes") return `it has ${condition.value ? "notes" : "no notes"}`;
      return `it has ${condition.value ? "a due date" : "no due date"}`;
    });
    const conditionText = new Intl.ListFormat("en").format(conditions);
    const statement = `Before saving a new task, stop saving when ${conditionText}. Show “${guard.message}”. Otherwise, this rule lets the app continue its normal permission, validation and save checks.`;
    const unchanged = "This check does not change task details. Existing tasks stay unchanged.";
    return { complete, title: "Check new tasks before saving", when: "Before a new task is saved.",
      summary: `${complete ? "" : "The full behavior could not be described. Known details: "}${statement} ${unchanged}`,
      scope: undefined, onlyWhen: `Saving is stopped only when ${conditionText}.`,
      then: `Show “${guard.message}”. Otherwise, this rule allows the normal save checks to continue.`,
      timing: null, unchanged };
  }
  const { action, conditions, hook } = description;
  const event = hook === "TaskCreated" ? "the task was added" : hook === "TaskCompleted" ? "the task was completed" : "the event";
  let complete = description.coverage === "complete" && conditions !== undefined && !!action
    && ["TaskCreated", "TaskCompleted"].includes(hook ?? "");
  const conditionText = (condition: RuleCondition): string => {
    if (condition.field === "dueAbsent") return "this task has no due date when its details are read";
    if (condition.field === "noOpenMatch") {
      const project = projectName(condition.projectId);
      if (!project) { complete = false; return "the chosen project has no matching open task (project name unavailable)"; }
      return `“${project}” has no open task titled exactly “${condition.title}”`;
    }
    if (condition.field === "projectId") {
      const project = condition.value && projectName(condition.value);
      if (!project) { complete = false; return "the task is in the chosen project (name unavailable)"; }
      return `this task is in “${project}”`;
    }
    if (condition.field === "title") return `this task is titled exactly “${condition.value}”`;
    if (condition.field === "tag") return `this task has the tag “${condition.value}”`;
    if (condition.field === "priority") return `this task has ${priority(condition.value ?? "")} priority`;
    if (condition.value === "COMPLETED" || condition.value === "OPEN") return `this task is ${condition.value === "COMPLETED" ? "completed" : "unfinished"}`;
    complete = false;
    return "the task’s status condition could not be described";
  };
  const knownConditions = conditions?.map(conditionText);
  const onlyWhen = knownConditions === undefined ? "The full conditions could not be described."
    : knownConditions.length ? `${knownConditions.length > 1 ? "All of these apply: " : ""}${new Intl.ListFormat("en").format(knownConditions)}.`
      : "Every task for this trigger; there are no additional rule conditions.";
  const fields = action?.fields ?? {};
  const literal = (field: string) => fields[field]?.kind === "literal" ? fields[field].value : undefined;
  const textValue = (field: string) => typeof literal(field) === "string" ? literal(field) as string : undefined;
  const parts: string[] = [];
  if (action?.capability === "tasks.update") parts.push("Update this task.");
  if (action?.capability === "tasks.create") {
    const title = fields.title;
    const named = textValue("title");
    parts.push(named !== undefined ? `Create a task titled “${named}”` : title?.kind === "title"
      ? `Create a task with ${title.prefix ? `“${title.prefix}” followed by ` : ""}this task’s title${title.suffix ? ` followed by “${title.suffix}”` : ""}`
      : title?.kind === "taskField" ? "Create a task with this task’s title" : "Create a task");
    const destination = fields.projectId;
    if (destination?.kind === "taskField") parts[0] += " in this task’s project.";
    else if (textValue("projectId")) {
      const project = projectName(textValue("projectId")!);
      if (!project) complete = false;
      parts[0] += project ? ` in “${project}”.` : " in the chosen project (name unavailable).";
    } else parts[0] += ".";
  }
  if (textValue("priority")) parts.push(`Priority ${priority(textValue("priority")!)}.`);
  else if (fields.priority?.kind === "taskField") parts.push(action?.capability === "tasks.create" ? "Copy this task’s priority." : "Keep this task’s priority.");
  if (textValue("addTag")) parts.push(`Add tag “${textValue("addTag")}”.`);
  if (Array.isArray(literal("tags"))) parts.push((literal("tags") as string[]).length ? `Tags ${(literal("tags") as string[]).join(", ")}.` : "No tags.");
  if (textValue("notes") !== undefined) parts.push(textValue("notes") ? `Notes “${textValue("notes")}”.` : "Empty notes.");
  const due = fields.dueAt;
  if (due?.kind === "eventOffset") parts.push(`Due ${elapsedTime(due.seconds)} ${due.seconds < 0 ? "before" : "after"} ${event}.`);
  else if (textValue("dueAt")) parts.push(`Due ${readableTime(textValue("dueAt")!)}.`);
  else if (due?.kind === "taskField") parts.push(action?.capability === "tasks.create" ? "Copy this task’s due date." : "Keep this task’s due date.");
  const create = action?.capability === "tasks.create", task = create ? "the new task" : "it";
  const list = (values: string[]) => new Intl.ListFormat("en").format(values);
  const dueAbsent = conditions?.some(condition => condition.field === "dueAbsent") === true;
  const actions: string[] = [];
  if (create) actions.push(parts[0].replace(/^Create a task/, "create a new task").replaceAll("this task’s", "the triggering task’s").replace(/\.$/, ""));
  if (textValue("priority") !== undefined) actions.push(`set ${create ? "the new task’s" : "its"} priority to ${priority(textValue("priority")!)}`);
  else if (fields.priority?.kind === "taskField") actions.push(create ? "copy the triggering task’s priority as read" : "set its priority to the value read from that task");
  if (textValue("addTag") !== undefined) actions.push(`add the tag “${textValue("addTag")}” to ${create ? task : "that task"}`);
  if (Array.isArray(literal("tags"))) actions.push((literal("tags") as string[]).length
    ? `give ${task} the tags ${list((literal("tags") as string[]).map(tag => `“${tag}”`))}` : `give ${task} no tags`);
  if (textValue("notes") !== undefined) actions.push(textValue("notes") ? `set ${create ? "the new task’s" : "its"} notes to “${textValue("notes")}”` : `leave ${create ? "the new task’s" : "its"} notes empty`);
  if (due?.kind === "eventOffset") {
    const amount = Math.abs(due.seconds), days = amount / 86400;
    const duration = amount && amount % 86400 === 0 ? `${days} ${days === 1 ? "day" : "days"}` : elapsedTime(due.seconds);
    actions.push(`${create || dueAbsent ? `give ${task} a due date` : "set its due date to"} exactly ${duration} ${due.seconds < 0 ? "before" : "after"} ${create ? event.replace("the task", "the triggering task") : hook === "TaskCreated" ? "it was added" : hook === "TaskCompleted" ? "it was completed" : event}`);
  } else if (textValue("dueAt") !== undefined) actions.push(`set ${create ? "the new task’s" : "its"} due date to ${readableTime(textValue("dueAt")!)}`);
  else if (due?.kind === "taskField") actions.push(create ? "copy the triggering task’s due date as read" : "set its due date to the value read from that task");
  if (!actions.length) complete = false;
  const everyProject = complete && !conditions!.some(condition => condition.field === "projectId");
  const unrestricted = ["title", "tag", "priority"].filter(field => !conditions?.some(condition => condition.field === field));
  const scope = everyProject ? `Applies in every project${unrestricted.length ? `, regardless of ${list(unrestricted.map(field => field === "tag" ? "tags" : field))}` : ""}.` : undefined;
  const trigger = hook === "TaskCreated" ? "When a new task is added" : hook === "TaskCompleted" ? "When a task is completed" : "When the saved trigger runs";
  const summaryConditions = conditions?.map(condition => condition.field === "dueAbsent"
    ? `${create ? "the triggering task" : "it"} still has no due date when its details are read`
    : conditionText(condition).replace(/^this task /, create ? "the triggering task " : "it ") + (condition.field === "noOpenMatch" ? " when checked" : ""));
  const statement = `${trigger}${everyProject ? " in any project" : ""}, ${actions.length ? list(actions) : "the action could not be described"}${summaryConditions?.length ? `, but only if ${list(summaryConditions)}` : ""}.`;
  const noReplay = hook === "TaskCreated" ? create ? "Turning this on does not replay earlier task additions." : "Turning this on does not update tasks that were added earlier."
    : "Turning this on does not replay earlier task completions.";
  const preserved = ["title", "project", "notes", "status", ...(!fields.priority ? ["priority"] : []), ...(!fields.addTag ? ["tags"] : []), ...(!due ? ["due date"] : [])];
  const defaults = [...(!fields.priority ? ["Normal priority"] : []), ...(!fields.tags ? ["no tags"] : []), ...(!Object.hasOwn(fields, "notes") ? ["empty notes"] : []), ...(!due ? ["no due date"] : [])];
  const unchanged = !complete ? null : create
    ? `The triggering task stays unchanged. The new task starts open${defaults.length ? ` with ${list(defaults)}` : ""}. ${noReplay}`
    : `${due && dueAbsent ? "A due date already present when the task is read is kept. " : ""}Leave its ${list(preserved)} unchanged.${fields.addTag ? " Keep its existing tags too." : ""} ${noReplay}`;
  const summary = complete ? `${statement} ${unchanged}`
    : `The full behavior could not be described. Known details: ${statement} ${conditions === undefined ? "The full conditions could not be described." : "Other conditions or effects may apply."}`;
  const subject = hook === "TaskCreated" ? "new tasks" : "completed tasks";
  const changed = [due && "due dates", fields.priority && (textValue("priority") ? `${priority(textValue("priority")!)} priority` : "priority"), fields.addTag && `the “${textValue("addTag")}” tag`].filter(Boolean) as string[];
  const title = create ? textValue("title") !== undefined ? `Create “${textValue("title")}” tasks` : `Create tasks from ${subject}`
    : changed.length > 1 ? `Set ${list(changed)} for ${subject}`
      : due ? dueAbsent ? `Give ${subject} a due date` : `Set due dates for ${subject}`
        : fields.priority ? textValue("priority") ? `Give ${subject} ${priority(textValue("priority")!)} priority` : `Copy priority for ${subject}`
          : fields.addTag ? `Tag ${subject} “${textValue("addTag")}”` : "Discuss task behavior";
  return { complete, title, when: hook === "TaskCreated" ? "A task is added." : hook === "TaskCompleted" ? "A task is completed." : "The saved trigger runs.",
    summary, scope: conditions?.some(condition => condition.field === "noOpenMatch")
      ? [scope, action?.capability === "tasks.create"
        ? `The open-task check is a snapshot; simultaneous task ${hook === "TaskCreated" ? "additions" : "completions"} can still create more than one matching task.`
        : "The open-task check is a snapshot; matching tasks can change after the check."].filter(Boolean).join(" ") : scope,
    onlyWhen, then: parts.length ? parts.join(" ") : "The action could not be fully described.",
    timing: due?.kind === "eventOffset" ? `${elapsedTime(due.seconds)} is an exact elapsed duration, including weekends. The local hour may shift when clocks change.` : null,
    unchanged };
}
