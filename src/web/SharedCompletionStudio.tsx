import { useEffect, useLayoutEffect, useRef, useState } from "react";
import StudioComposer from "./StudioComposer";
import { AssistantSetup, canConfigureAssistant } from "./Studio";
import TeamCapability, { replyText } from "./TeamCapability";
import { elapsedTime, readableTime } from "./rule-description";
import type { GuardCondition } from "./rule-description";

type CreateFields = { notes: string; tags: string[]; priority: string | null };
type ProjectLabel = { name: string; ref: string };
type ReferenceTask = { id: string; title: string; status: string; priority: string; tags: string[]; dueAt: string | null; project: ProjectLabel };
type ReadCondition = { taskId?: string; referenceProject?: ProjectLabel; lookupProject?: ProjectLabel; negated?: boolean };
type TaskResult = ({ title: string; dueAt: string | null; linked: boolean; assignee: string | null; project?: "SAME_PROJECT"; destination?: ProjectLabel } & Partial<CreateFields>)
  | { sourcePriority: string } | { sourceDueAt: string | null } | { sourceTags: string[] }
  | { sourceAfter: { priority: string; dueAt: string | null; tags: string[] } };
type Decision = { decision: "ALLOW" | "DENY"; message: string };
type CompletionBehavior = {
  conditions: ({ field: string; value: string | null; sourceProject?: ProjectLabel } & ReadCondition)[];
  destination?: ProjectLabel | null;
  title: { kind: string; value?: string; prefix?: string; suffix?: string } | null;
  due: { kind: string; seconds?: number; value?: string } | null;
  linked: boolean; assignee: string | null;
  fields?: CreateFields;
  sourcePriority?: string;
  sourceTag?: string;
  createdUpdate?: boolean;
  completedUpdate?: boolean;
  afterCreate?: boolean;
  sourceDue?: NonNullable<CompletionBehavior["due"]>;
  readsCompletedTask?: boolean;
  examples: { title: string; tags: string[]; occurredAt: string; priority?: string; sourceDueAt?: string | null; openTitles?: string[];
      project?: string; projectRef?: string; openProjects?: (ProjectLabel & { titles: string[] })[]; referenceTasks?: ReferenceTask[]; expected: TaskResult | null }[];
};
type GateCondition = { op: "all" | "any" | "not"; children: GateCondition[] } | { field: string; value: string | boolean | null };
type Behavior = CompletionBehavior | { gate: { when: GateCondition; linked: boolean; message: string; examples: {
  title: string; priority: string; tags: string[]; hasNotes: boolean; hasDueDate: boolean; linkedStatus: string | null; expect: Decision;
}[] } } | { guard: {
   team: boolean; bundle?: boolean; message: string; conditions: ((GuardCondition | { field: "openMatch" | "title" | "status" | "dueAbsent"; value: string }) & ReadCondition & { projectRef?: string })[];
   examples: { project: string; projectRef?: string; tags: string[]; priority: string; hasNotes: boolean; hasDueDate: boolean; openTitles?: string[];
     openProjects?: (ProjectLabel & { titles: string[] })[]; referenceTasks?: ReferenceTask[]; expect: Decision }[];
} } | { stages: Behavior[]; stageHooks?: string[] };
type ConfirmResult = { status: string; passed: boolean | null; eligible: boolean | null };
type Message = { sequence: number; id: string; role: string; text: string; offer?: Behavior | null };
type Page = { messages: Message[]; before: number | null };
type Conversation = Page & { version: number; runId: string; status: string; code?: string | null; offer: (Behavior & { digest: string }) | null;
  canConfirm: boolean; offerStale?: boolean; confirmation: ConfirmResult | null };
type Check = { known: boolean; task: TaskResult | Decision | null };
export type ActiveTeam = { status: "off" | "unavailable" } | { status: "on"; behavior: Behavior | null; label: string | null };
type Review = { scope: "PERSONAL" | "TEAM"; name: string; draftVersion: number; behavior: Behavior | null; checked: Check[] | Check[][] | null;
  approved: boolean; on: boolean; occupied: boolean; occupants: string[]; token: string | null; inUse: string | null; disableToken: string | null; legacyDraft: boolean; activeTeam: ActiveTeam | null };
type Snapshot = { availability: { available: boolean; code?: string | null }; conversation: Conversation | null; review: Review; savedControls?: boolean; canContinue?: boolean };
type Request = <T>(path: string, method?: string, body?: object, signal?: AbortSignal) => Promise<T>;

function ExactTitle({ value, quoted = true }: { value: string; quoted?: boolean }) {
  const display = value.replace(/[⟦\p{Cc}\p{Cf}\p{White_Space}\p{Default_Ignorable_Code_Point}]/gu, char =>
    char === " " ? char : `⟦U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟧`);
  return <span className="exact-title" style={{ whiteSpace: "break-spaces", overflowWrap: "anywhere" }}>
    {quoted ? `“${display}”` : display}
  </span>;
}
type ProjectLabeler = (name: string, ref?: string) => React.ReactNode;
function ruleLabels(value: Exclude<Behavior, { stages: Behavior[] }>) {
  const projects = new Map<string, Map<string, string>>();
  const references = new Map<string, string>();
  const add = (name?: string, ref?: string) => {
    if (name === undefined || !ref) return;
    const key = name.normalize();
    if (!projects.has(key)) projects.set(key, new Map());
    projects.get(key)!.set(ref, name);
  };
  const addProject = (project?: ProjectLabel | null) => add(project?.name, project?.ref);
  if (!("gate" in value)) {
    const rule = "guard" in value ? value.guard : value;
    for (const condition of rule.conditions) if (condition.taskId) references.set(condition.taskId, "");
    for (const example of rule.examples) {
      add(example.project, example.projectRef);
      example.openProjects?.forEach(addProject);
      example.referenceTasks?.forEach(task => {
        addProject(task.project);
        if (!references.get(task.id)) references.set(task.id, task.title);
      });
      if ("expected" in example && example.expected && "destination" in example.expected) addProject(example.expected.destination);
    }
    for (const condition of rule.conditions) {
      addProject(condition.referenceProject);
      addProject(condition.lookupProject);
      if ("sourceProject" in condition) addProject(condition.sourceProject);
      if ("projectRef" in condition && typeof condition.value === "string") add(condition.value, condition.projectRef);
    }
    if ("destination" in value) addProject(value.destination);
  }
  const projectLabel: ProjectLabeler = (name, ref) => {
    const group = [...projects.get(name.normalize())?.keys() ?? []];
    return <><ExactTitle value={name} />{ref && group.length > 1 && <> (project {group.indexOf(ref) + 1})</>}</>;
  };
  const taskLabel = (id: string, title = references.get(id)) => <>
    Reference task {Array.from(references.keys()).indexOf(id) + 1}{title && <>: <ExactTitle value={title} /></>}
  </>;
  const ambiguousProjects = [...projects.values()].filter(group => group.size > 1).flatMap(group => [...group]);
  return { projectLabel, taskLabel, details: <RuleDetails projects={ambiguousProjects} references={[...references]}
    projectLabel={projectLabel} taskLabel={taskLabel} /> };
}
type RuleLabels = ReturnType<typeof ruleLabels>;
function RuleDetails({ projects, references, projectLabel, taskLabel }: { projects: [string, string][]; references: [string, string][];
  projectLabel: ProjectLabeler; taskLabel: (id: string) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (projects.length > 0 || references.length > 0) ? <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Rule details</summary>
    {open && <ul>
      {projects.map(([id, name]) => <li key={id}>{projectLabel(name, id)} · Project ID: <ExactTitle value={id} quoted={false} /></li>)}
      {references.map(([id]) => <li key={id}>{taskLabel(id)} · Task ID: <ExactTitle value={id} quoted={false} /></li>)}
    </ul>}
  </details> : null;
}
function referenceCondition({ field, value, taskId, referenceProject, negated }: ReadCondition & { field: string; value?: string | boolean | number | null }, { projectLabel, taskLabel }: RuleLabels) {
  return <>{taskLabel(taskId!, "")} in {projectLabel(referenceProject!.name, referenceProject!.ref)}:
    {" "}{field === "dueAbsent" ? "Has no due date" : <>{field === "tag" ? negated ? "Does not have exact tag" : "Has exact tag"
      : `${field[0].toUpperCase()}${field.slice(1)} is`} <ExactTitle value={String(value)} /></>}.</>;
}
function readExamples({ referenceTasks, openProjects }: { referenceTasks?: ReferenceTask[]; openProjects?: (ProjectLabel & { titles: string[] })[] }, { projectLabel, taskLabel }: RuleLabels) {
  return <>
    {referenceTasks?.map(task => <p key={task.id}>{taskLabel(task.id, task.title)}
      in {projectLabel(task.project.name, task.project.ref)}: {task.status.toLowerCase()}, {task.priority} priority,
      {" "}{task.dueAt ? `due ${offerTime(task.dueAt)}` : "no due date"}, {task.tags.length ? <>tags {task.tags.map((tag, i) =>
        <span key={tag}>{i > 0 && ", "}<ExactTitle value={tag} /></span>)}</> : "no tags"}.</p>)}
    {openProjects?.map(project => <p key={project.ref}>Other open tasks in {projectLabel(project.name, project.ref)}: {project.titles.length
      ? project.titles.map((title, i) => <span key={title}>{i > 0 && ", "}<ExactTitle value={title} /></span>) : "None"}.</p>)}
  </>;
}
const condition = ({ field, value, lookupProject, sourceProject, taskId, referenceProject, negated }: CompletionBehavior["conditions"][number], source: string, labels: RuleLabels) => {
  const { projectLabel } = labels;
  if (taskId) return referenceCondition({ field, value, taskId, referenceProject, negated }, labels);
  if (sourceProject) return <>Source project: {projectLabel(sourceProject.name, sourceProject.ref)}.</>;
  if (field === "openMatch" || field === "noOpenMatch") return <>{field === "openMatch" ? "An" : "No"} open task titled <ExactTitle value={value!} /> in {lookupProject
    ? projectLabel(lookupProject.name, lookupProject.ref) : `the ${source}’s project`} (exact, case-sensitive title).</>;
  if (field === "title") return <>Exact title: <ExactTitle value={value!} quoted={false} /></>;
  if (field === "tag") return <>Exact tag: <ExactTitle value={value!} /></>;
  const label = { projectId: "Project", priority: "Priority", status: "Status" }[field];
  return label ? `${label}: ${value}` : "The task has no due date.";
};
export function offerTime(value: string) {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime()) || time.getTime() % 60_000 === 0) return readableTime(value);
  return time.toISOString().replace("T", " ").replace(/(?:\.000)?Z$/, " UTC");
}
function CreationFields({ notes, tags, priority, source }: Partial<CreateFields> & { source: string }) {
  return <> {notes ? <>Notes: <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>“{notes.replaceAll("\0", "␀")}”</span>.</> : "No notes."}
    {" "}{tags?.length ? `Tags: ${tags.join(", ")}.` : "No tags."}
    {" "}{priority ? `Priority: ${priority}.` : `Copy the ${source}’s priority.`}</>;
}
const taskResult = (result: TaskResult | Decision | null, example: CompletionBehavior["examples"][number], update: boolean, source: string, projectLabel: ProjectLabeler) => result && !("decision" in result)
  ? "sourceAfter" in result ? <>
    {JSON.stringify(result.sourceAfter.tags) === JSON.stringify(example.tags) && result.sourceAfter.priority === example.priority
      && result.sourceAfter.dueAt === example.sourceDueAt ? "The update leaves the task unchanged. " : ""}
    Saved priority: {result.sourceAfter.priority}. {result.sourceAfter.dueAt ? `Due ${offerTime(result.sourceAfter.dueAt)}.` : "No due date."}
    {result.sourceAfter.tags.length ? <> Saved tags: {result.sourceAfter.tags.map((tag, i) =>
      <span key={tag}>{i > 0 && ", "}<ExactTitle value={tag} /></span>)}.</> : " No tags."}
  </> : "sourceTags" in result ? <>
    {JSON.stringify(result.sourceTags) === JSON.stringify(example.tags) ? "Tags stay unchanged:" : "Saved tags in order:"}
    {" "}{result.sourceTags.map((tag, i) => <span key={tag}>{i > 0 && ", "}<ExactTitle value={tag} /></span>)}.
  </>
  : "sourceDueAt" in result ? result.sourceDueAt === example.sourceDueAt
    ? result.sourceDueAt === null ? "Still no due date." : `Due date stays ${offerTime(result.sourceDueAt)}.`
    : result.sourceDueAt === null ? "Clear the due date. No due date remains." : `Set the due date to ${offerTime(result.sourceDueAt)}.`
  : "sourcePriority" in result ? result.sourcePriority === example.priority
    ? `Priority stays ${result.sourcePriority}.` : `Change priority from ${example.priority} to ${result.sourcePriority}.`
  : <>Create <ExactTitle value={result.title} />{result.destination ? <> in {projectLabel(result.destination.name, result.destination.ref)}</>
    : result.project && " in the same project"}{result.dueAt ? `, due ${offerTime(result.dueAt)}` : ", no due date"}
    {result.linked ? `, linked to the ${source}` : ""}{result.assignee ? `, assigned to ${result.assignee}` : ""}.
    {(result.project || result.destination) && <CreationFields {...result} source={source} />}</>
  : update ? `Do not update the ${source}.` : "Create nothing.";
function Proposal({ value, checked, personal, summary }: { value: Behavior; checked?: Review["checked"]; personal?: boolean; summary?: boolean }) {
  if ("stages" in value) {
    const hooks = value.stageHooks ?? ["TaskBeforeCreate", "TaskCreated", "TaskCompleted"];
    const labels: Record<string, string> = { TaskBeforeCreate: "Before save", TaskCreated: "After save", TaskBeforeComplete: "Before completion", TaskCompleted: "After completion" };
    return <>
    {hooks.length > 1 && <p>These rules turn on together.{personal && " New tasks keep the revision they start with."}</p>}
    {hooks.some(hook => hook === "TaskCreated" || hook === "TaskCompleted") && <p>{personal
      ? "A follow-up does not trigger another rule when it is created. If you later complete it, the standalone completion rule in use then can run."
      : "Tasks created by this rule do not start another workflow."}
      {hooks.includes("TaskBeforeCreate") && " They use this revision’s save check."}</p>}
    {value.stages.map((stage, i) => <section key={hooks[i]} aria-label={labels[hooks[i]]}>
      <Proposal value={stage} checked={checked?.[i] as Check[] | undefined} summary={summary} />
    </section>)}
  </>;
  }
  const labels = ruleLabels(value), { projectLabel } = labels;
  const observed = checked as Check[] | null | undefined;
  if ("gate" in value) {
    const { when, linked, message, examples } = value.gate;
    const linkedLabel: Record<string, string> = { MISSING: "missing", OPEN: "open", COMPLETED: "completed" };
    function condition(c: GateCondition): React.ReactNode {
      if ("op" in c) return c.op === "not" ? <>not ({condition(c.children[0])})</>
        : <>( {c.children.map((part, i) => <span key={i}>{i > 0 && (c.op === "all" ? " and " : " or ")}{condition(part)}</span>)} )</>;
      if (c.field === "linkedStatus") return `the verified linked task is ${linkedLabel[String(c.value)]}`;
      if (c.field === "hasNotes") return "the original has notes";
      if (c.field === "hasDueDate") return "the original has a due date";
      if (c.field === "project" && c.value === null) return "the project is outside this rule’s scope (never matches)";
      const label: Record<string, string> = { title: "the exact title is", priority: "priority is", tag: "the original has exact tag", project: "the project is" };
      return <>{label[c.field]} <ExactTitle value={String(c.value)} /></>;
    }
    const result = (decision: Decision) => decision.decision === "ALLOW" ? "Allow normal completion." : <>Keep the task open. <ExactTitle value={decision.message} /></>;
    return <>
      <p><strong>Before completing the original task</strong></p>
      <p>Keep the task open when {condition(when)}. Show <ExactTitle value={message} />. Otherwise allow normal completion.</p>
      {linked && <p>Only the linked task from this original’s verified after-save receipt counts. If Daymark cannot verify it, the original stays open.</p>}
      {!summary && <details><summary>{checked ? "Checked examples" : "Expected examples · Not checked"}</summary>
        <ol>{examples.map((c, i) => <li key={i}><ExactTitle value={c.title} /> · {c.priority} priority · {c.hasNotes ? "Has notes" : "No notes"} · {c.hasDueDate ? "Has a due date" : "No due date"}
          {c.tags.length > 0 && <p>Tags: {c.tags.map(tag => <ExactTitle key={tag} value={tag} />)}</p>}
          {c.linkedStatus && <p>Verified linked task: {linkedLabel[c.linkedStatus]}.</p>}
          <p>Expected: {result(c.expect)}</p>
          {observed && <p>In the isolated example: {observed[i]?.known ? result(observed[i].task as Decision) : "The decision could not be verified."}</p>}
        </li>)}</ol>
      </details>}
    </>;
  }
  if ("guard" in value) {
    const { team, bundle, message, conditions, examples } = value.guard;
    const decision = (result: TaskResult | Decision | null) => !result || !("decision" in result) ? "The decision could not be verified."
      : result.decision === "ALLOW" ? "Allow normal save checks to continue." : <>Do not save. <ExactTitle value={result.message} /></>;
    return <>
      <p><strong>Before saving a new task</strong></p>
      <p>{bundle ? "Checks new tasks people start and tasks generated by this admitted revision."
        : team ? "Checks new tasks people start in this Team project. It does not check tasks generated by earlier pinned rules."
        : "Checks your new Personal tasks, including tasks created by rules that support before-save checks."}</p>
      <ul aria-label="All conditions must match">{conditions.map((c, i) => <li key={i}>{
         c.taskId ? referenceCondition(c, labels)
           : c.field === "tag" ? <>{c.negated ? "Does not have exact tag" : "Has exact tag"} <ExactTitle value={c.value} />.</>
          : c.field === "projectId" ? <>Project: {projectLabel(c.value, c.projectRef)}.</>
           : c.field === "openMatch" ? <>An open task has the exact title <ExactTitle value={c.value} /> in {c.lookupProject
             ? projectLabel(c.lookupProject.name, c.lookupProject.ref) : "this project"}.</>
          : c.field === "tagCount" ? `More than ${c.value} distinct tags.`
          : c.field === "priority" ? `Priority: ${c.value}.`
          : c.field === "hasNotes" ? c.value ? "Has notes." : "Has no notes."
          : c.value ? "Has a due date." : "Has no due date."
      }</li>)}</ul>
      <p>If all conditions match, do not save. Show <ExactTitle value={message} />.</p>
      <p>If they do not match, normal save checks still apply. If Daymark cannot check the rule, it does not save the task.</p>
      {!summary && <details><summary>{checked ? "Checked examples" : "Expected examples · Not checked"}</summary>
        <ol>{examples.map((c, i) => <li key={i}>
          {projectLabel(c.project, c.projectRef)} · {c.priority} priority · {c.hasNotes ? "Has notes" : "No notes"} · {c.hasDueDate ? "Has a due date" : "No due date"}
          <p>{c.tags.length ? <>Tags: {c.tags.map((tag, j) => <span key={tag}>{j > 0 && ", "}<ExactTitle value={tag} /></span>)}.</> : "No tags."}</p>
          {c.openTitles && <p>Already open in this project: {c.openTitles.length ? c.openTitles.map((title, j) =>
            <span key={title}>{j > 0 && ", "}<ExactTitle value={title} /></span>) : "None"}.</p>}
          {readExamples(c, labels)}
          <p>Expected: {decision(c.expect)}</p>
          {observed && <p>In the isolated example: {decision(observed[i]?.known ? observed[i].task : null)}</p>}
        </li>)}</ol>
      </details>}
      {labels.details}
    </>;
  }
  const { title, due, sourceDue, sourceTag } = value, update = !!(value.sourcePriority || sourceDue || sourceTag);
  const source = value.afterCreate ? "newly saved task" : "completed task";
  const moment = value.afterCreate ? "creation" : "completion";
  const combinedUpdate = value.createdUpdate || value.completedUpdate;
  const showStartingDue = combinedUpdate || sourceDue || value.conditions.some(c => c.field === "dueAbsent");
  const titleText = title?.kind === "literal" ? <ExactTitle value={title.value!} /> : <>
    {title?.prefix && <><ExactTitle value={title.prefix} />{" + "}</>}the {source}’s title
    {title?.suffix && <>{" + "}<ExactTitle value={title.suffix} /></>}
  </>;
  return <>
    <p><strong>{value.afterCreate ? "After a new task is saved" : "After a task is completed"}</strong></p>
    {value.conditions.length > 0 && <ul aria-label="All conditions must match">{value.conditions.map((c, i) => <li key={i}>{condition(c, source, labels)}</li>)}</ul>}
    {combinedUpdate ? <>
      <p>Update the {source} once. Leave its other fields as they are.</p>
      {value.conditions.some(c => c.lookupProject) && <p>The lookup checks for an open title. Only the triggering task can change.</p>}
      <ul>
        {value.sourcePriority && <li>Set priority to {value.sourcePriority}.</li>}
        {sourceTag && <li>Add tag <ExactTitle value={sourceTag} />. Keep existing tags in order and do not add a duplicate.</li>}
        {sourceDue && <li>{sourceDue.kind === "clear" ? "Clear the due date."
          : sourceDue.kind === "eventOffset" ? `Set the due date ${elapsedTime(sourceDue.seconds!)} ${sourceDue.seconds! < 0 ? "before" : "after"} ${moment}.`
          : `Set the due date to ${offerTime(sourceDue.value!)}.`}</li>}
      </ul>
      <p>{value.afterCreate ? "If the task was edited or completed after saving, do not update it."
        : "If the task was edited after completion, do not update it."} {sourceTag && "If the tag cannot be added, make none of these changes."}</p>
      {value.conditions.length > 0 && <p>If the conditions do not match or cannot be checked, do not update the task.</p>}
    </> : update ? <>
      <p>{sourceTag ? <>Add tag <ExactTitle value={sourceTag} /> to the completed task.</>
        : sourceDue?.kind === "clear" ? "Clear the completed task’s due date."
        : sourceDue?.kind === "eventOffset" ? `Set the completed task’s due date ${elapsedTime(sourceDue.seconds!)} ${sourceDue.seconds! < 0 ? "before" : "after"} completion.`
        : sourceDue ? `Set the completed task’s due date to ${offerTime(sourceDue.value!)}.`
        : `Set the completed task’s priority to ${value.sourcePriority}.`} Keep its other fields as they are.</p>
      <p>{sourceTag ? "Keep the existing tags in order. If the tag is already present, leave the list unchanged. If the task already has eight different tags, do not add another."
        : `If the ${sourceDue ? "due date" : "priority"} already matches, leave it unchanged.`} If the task was edited after completion, do not update it.</p>
      {value.conditions.length > 0 && <p>If the conditions do not match or cannot be checked, do not update the task.</p>}
    </> : !title ? <p>{value.readsCompletedTask && `Read the ${source}. If it cannot be read, the rule cannot finish. `}Do not create or change any task.</p> : <>
    <p>Create one task in {value.destination ? projectLabel(value.destination.name, value.destination.ref) : "the same project"} with {titleText} as its title.</p>
    {value.fields && <p><CreationFields {...value.fields} source={source} /></p>}
    <p>{!due ? "No due date." : due.kind === "eventOffset" ? `Due ${elapsedTime(due.seconds!)} ${due.seconds! < 0 ? "before" : "after"} ${moment}.`
      : due.kind === "literal" ? `Due ${offerTime(due.value!)}.` : `Copy the ${source}’s due date.`}
      {" "}{value.linked ? `Link it to the ${source}.` : "Do not link it."}{" "}
      {value.assignee ? `Assign it to ${value.assignee}.` : "Leave it unassigned."}</p>
    {value.conditions.length > 0 && <p>If the conditions do not match, create nothing.</p>}
    {value.conditions.some(c => c.field === "noOpenMatch") && <p>If Daymark cannot verify the lookup, it does not create the task. This is not a uniqueness guarantee.</p>}
    <p>Daymark still checks task permissions and save rules. {value.afterCreate ? "An earlier save" : "An earlier completion"} will not run again.</p>
    </>}
    {!summary && <details><summary>{checked ? "Checked examples" : "Expected examples · Not checked"}</summary>
      <ol>{value.examples.map((example, i) => {
        // The isolated checker seeds omitted due dates at completion time for updates only.
        const startingDue = example.sourceDueAt === undefined ? update ? example.occurredAt : null : example.sourceDueAt;
        return <li key={i}>
          <strong><ExactTitle value={example.title} quoted={false} /></strong> · {example.tags.length ? sourceTag
            ? example.tags.map((tag, i) => <span key={tag}>{i > 0 && ", "}<ExactTitle value={tag} /></span>) : example.tags.join(", ") : "No tags"}
          {example.priority && ` · ${example.priority} priority`}
          {example.project !== undefined && <> · {projectLabel(example.project, example.projectRef)}</>}
          {showStartingDue && ` · ${startingDue === null ? "No due date" : `Due ${startingDue.replace("T", " ").replace(/Z$/, " UTC")}`}`}
          {" · "}{offerTime(example.occurredAt)}
          {example.openTitles && value.afterCreate && <p>The newly saved task also counts as open in this example.</p>}
          {example.openTitles && <p>{value.afterCreate ? "Other open tasks in this project:" : "Already open in this project:"} {example.openTitles.length ? example.openTitles.map((title, i) =>
            <span key={title}>{i > 0 && ", "}<ExactTitle value={title} /></span>) : "None"}.</p>}
          {readExamples(example, labels)}
          {example.openProjects && value.afterCreate && <p>The newly saved task counts as open only in its own project.</p>}
          <p>Expected: {taskResult(example.expected, example, update, source, projectLabel)}</p>
          {observed && <p>In the isolated example: {observed[i]?.known ? taskResult(observed[i].task, example, update, source, projectLabel) : "The effect could not be verified."}</p>}
        </li>;
      })}</ol>
    </details>}
    {labels.details}
  </>;
}
const confirmationText: Record<string, string> = {
  PREPARING: "Saving and checking the confirmed offer…", UNSAVED: "No draft was saved.",
  SAVED_UNCHECKED: "Draft saved. Example checks are unavailable.", CHECK_FAILED: "Draft saved. The examples did not pass.",
  UNKNOWN: "Daymark could not verify whether a draft was saved. Read saved state. Do not confirm again.",
};
const running = (conversation?: Conversation | null) => conversation?.status === "RUNNING" || conversation?.status === "CANCELLING";
const teamScope = "The rule in use applies only to new tasks people add. Existing tasks keep the rule they started with.";
export function TeamActiveRule({ active }: { active: ActiveTeam | null }) {
  const stages = active?.status === "on" && active.behavior ? "stages" in active.behavior ? active.behavior.stages : [active.behavior] : [];
  const creation = stages.find(stage => "title" in stage && stage.title?.kind === "literal");
  const name = creation && "title" in creation ? creation.title?.value
    : stages.some(stage => "gate" in stage) ? "Task completion rule"
      : stages.some(stage => "guard" in stage) ? "Task save rule" : "Task workflow";
  return <section className="customization-empty" aria-label="What’s in use">
    <h2>What’s in use</h2>
    {active?.status === "on" ? <>
      <h3>{active.label ?? name}</h3>
      <p>{teamScope}</p>
      {active.behavior && <Proposal value={active.behavior} summary />}
    </> : <p>{active?.status === "off" ? "No rule is on for new tasks." : "The current rule could not be verified."}</p>}
  </section>;
}

export default function SharedCompletionStudio({ target, request, back, backToTasks, drafts, draftScope, teamControls }: {
  target: string; request: Request; back: () => void; backToTasks: () => void; drafts: Map<string, string | null>; draftScope: string | null;
  teamControls?: { project: { id: string; name: string }; operationScope: string | null; openEarlier: () => void };
}) {
  const path = "shared-studio/" + encodeURIComponent(target);
  const draftKey = draftScope ? `daymark-shared-studio-draft:${draftScope}:${target}` : null;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [text, setText] = useState(() => {
    if (drafts.has(path)) return drafts.get(path) ?? "";
    try { return draftKey ? (sessionStorage.getItem(draftKey) ?? "").slice(0, 8192) : ""; }
    catch { return ""; }
  });
  const [history, setHistory] = useState<Page | null>(null), [error, setError] = useState("");
  const [replyReadback, setReplyReadback] = useState<{ runId: string; checked: boolean } | null>(null);
  const [busy, setBusy] = useState(""), [atEnd, setAtEnd] = useState(true), [uncertain, setUncertain] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false), [stopToken, setStopToken] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), setupInvoker = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null), follow = useRef(true), action = useRef(false);
  const anchor = useRef<{ sequence: string; offset: number } | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const requestRef = useRef(request); requestRef.current = request;
  const lifecycle = useRef<AbortController | null>(null);
  function changeText(value: string) {
    drafts.set(path, value || null);
    try {
      if (draftKey && value) sessionStorage.setItem(draftKey, value);
      else if (draftKey) sessionStorage.removeItem(draftKey);
    } catch { /* The draft remains available in this tab while signed in. */ }
    setText(value);
  }
  const conversation = snapshot?.conversation, review = snapshot?.review;
  const messages = [...(history?.messages ?? []), ...(conversation?.messages ?? [])];
  const unique = [...new Map(messages.map(message => [message.sequence, message])).values()].sort((a, b) => a.sequence - b.sequence);
  const before = history ? history.before : conversation?.before;
  const accept = (next: Snapshot) => {
    const previous = snapshotRef.current;
    const oldRun = previous?.conversation, newRun = next.conversation;
    if (oldRun && (!newRun || oldRun.version > newRun.version
        || oldRun.version === newRun.version && !running(oldRun) && running(newRun) && !oldRun.offer)) return;
    snapshotRef.current = next;
    setSnapshot(next);
    if (next.conversation?.messages.length) setHistory(previous => {
      const page = next.conversation!;
      const newFirst = page.messages[0].sequence;
      // Keep messages already loaded in this visit as the server's latest page moves.
      const older = (oldRun?.messages ?? []).filter(message => message.sequence < newFirst);
      if (!older.length) return previous;
      return { before: previous ? previous.before : oldRun!.before,
        messages: [...(previous?.messages ?? []), ...older] };
    });
    if (next.conversation?.confirmation && !["UNKNOWN", "PREPARING"].includes(next.conversation.confirmation.status)) setUncertain(false);
  };
  async function refresh(signal = lifecycle.current?.signal) {
    const next = await requestRef.current<Snapshot>(path, "GET", undefined, signal);
    if (signal?.aborted) return;
    accept(next);
    if (snapshotRef.current === next) return next;
  }
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    void refresh(controller.signal).catch(() => { if (!controller.signal.aborted) setError("Studio is unavailable for this target."); });
    return () => controller.abort();
  }, [path]);
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  function closeSetup(unconfirmed: boolean) {
    setSetupOpen(false);
    if (unconfirmed) setError("Saving settings could not be confirmed. Check saved settings without sending them again.");
    void refresh().catch(() => {});
    requestAnimationFrame(() => (setupInvoker.current?.isConnected ? setupInvoker.current : heading.current)?.focus({ preventScroll: true }));
  }
  const live = running(conversation);
  const replyFailed = conversation?.status === "BLOCKED" && !!conversation.code &&
    (conversation.code.startsWith("PROVIDER_REPLY_") || ["PROVIDER_RESPONSE_INVALID", "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE"].includes(conversation.code));
  const replyRecovery = replyFailed && !uncertain && !error ? conversation : null;
  const checkedReply = replyRecovery && replyReadback?.runId === replyRecovery.runId ? replyReadback : null;
  async function readSavedState() {
    if (!replyRecovery) {
      setError("");
      await refresh().catch(() => setError("Saved state is unavailable."));
      return;
    }
    const { runId, version, code, messages } = replyRecovery;
    const message = messages.filter(item => item.role === "user").at(-1);
    const signal = lifecycle.current?.signal;
    setReplyReadback(null);
    try {
      const saved = (await refresh(signal))?.conversation;
      if (saved?.runId === runId && saved.version === version && saved.status === "BLOCKED" &&
          saved.code === code && !saved.offer && !saved.offerStale && message &&
          saved.messages.filter(item => item.role === "user").at(-1)?.id === message.id)
        setReplyReadback({ runId, checked: true });
    } catch {
      if (!signal?.aborted) setReplyReadback({ runId, checked: false });
    }
  }
  const [includeTaskNotes, setIncludeTaskNotes] = useState(false);
  useEffect(() => setIncludeTaskNotes(false), [path]);
  useEffect(() => {
    if (!live && busy !== "confirm") return;
    const timer = window.setTimeout(() => { void refresh().catch(() => {}); }, 250);
    return () => window.clearTimeout(timer);
  }, [snapshot, live, busy]);
  useLayoutEffect(() => {
    if (!list.current) return;
    if (anchor.current) {
      const article = list.current.querySelector(`[data-sequence="${anchor.current.sequence}"]`);
      if (article) list.current.scrollTop += article.getBoundingClientRect().top - list.current.getBoundingClientRect().top - anchor.current.offset;
      anchor.current = null;
    } else if (follow.current) list.current.scrollTop = list.current.scrollHeight;
    measure();
  }, [snapshot, history]);
  function measure() {
    const node = list.current;
    if (!node) return;
    follow.current = node.scrollHeight - (node.scrollTop + node.clientHeight) < 24;
    setAtEnd(follow.current);
  }
  async function older() {
    if (!before || !list.current || busy) return;
    setBusy("history");
    try {
      const page = await requestRef.current<Page>(`${path}/history?before=${before}`, "GET", undefined, lifecycle.current?.signal);
      const node = list.current;
      if (!node) return;
      const top = node.getBoundingClientRect().top;
      const article = [...node.querySelectorAll<HTMLElement>("[data-sequence]")].find(element => element.getBoundingClientRect().bottom > top);
      if (article?.dataset.sequence) anchor.current = { sequence: article.dataset.sequence, offset: article.getBoundingClientRect().top - top };
      setHistory(prior => ({ before: page.before, messages: [...page.messages, ...(prior?.messages ?? []), ...(conversation?.messages ?? [])] }));
    } catch { setError("Earlier messages are unavailable."); }
    finally { setBusy(""); }
  }
  async function send(command: string, body: object) {
    if (action.current) return;
    action.current = true; setBusy(command); setError("");
    try {
      const next = await requestRef.current<Snapshot>(path + "/" + command, "POST", body, lifecycle.current?.signal);
      if (!lifecycle.current?.signal.aborted) accept(next);
      if (command === "turn") { changeText(""); setUncertain(false); }
    } catch (failure) {
      if (command === "confirm" && failure instanceof Error && "status" in failure && failure.status === 409) {
        const previous = snapshotRef.current;
        if (previous?.conversation?.offer) {
          snapshotRef.current = { ...previous, conversation: { ...previous.conversation, offer: null, canConfirm: false, offerStale: true } };
          setSnapshot(snapshotRef.current);
        }
        setError("This offer has changed. Nothing was saved by this confirmation.");
        await refresh().catch(() => {});
        return;
      }
      if (command === "confirm") setUncertain(true);
      setError(command === "confirm" ? "The confirmation reply is unavailable. Read saved state; do not confirm again."
        : "The action could not be verified. Read saved state before continuing.");
    } finally { action.current = false; setBusy(""); }
  }
  const stop = async () => {
    if (!conversation) return;
    try {
      accept(await requestRef.current<Snapshot>(path + "/cancel", "POST", { runId: conversation.runId, expectedVersion: conversation.version }, lifecycle.current?.signal));
    } catch { setError("Stop could not be verified. Read saved state."); }
  };
  return <section className="read-studio shared-completion-studio" aria-label="Customization Studio">
    <header className="rs-chat-head">
      <button type="button" className="quiet-button" onClick={back}>Back to Customizations</button>{" "}
      <button type="button" className="quiet-button" onClick={backToTasks}>Back to Tasks</button>
      <h2 ref={heading} tabIndex={-1}>Customization Studio</h2>
      {review && <p>{review.scope === "TEAM" ? "Team" : "Personal"} · {review.name}</p>}
    </header>
    {error && <p role="alert">{error}</p>}
    <div ref={list} className="rs-messages" aria-label="Studio conversation" tabIndex={0} onScroll={measure}>
      {before && <button type="button" disabled={!!busy} onClick={() => void older()}>Load earlier messages</button>}
      {unique.map(message => <article data-sequence={message.sequence} className={`rs-message ${message.role === "user" ? "rs-yours" : "rs-assistant"}`} key={message.id}>
        <strong>{message.role === "user" ? "You" : message.role === "assistant" ? "Daymark assistant" : "Daymark"}</strong>
         {message.role === "assistant" ? replyText(message.text) : <p>{message.text}</p>}
        {message.offer && !(conversation?.offer && message === unique.at(-1)) &&
          <details><summary>Proposal from this turn</summary><Proposal value={message.offer} personal={review?.scope === "PERSONAL"} /></details>}
      </article>)}
      {conversation?.offer && <section className="shared-proposal" aria-label="Current proposal">
         <h3>Proposed behavior</h3>
         {review?.scope === "TEAM" && <p>{teamScope}</p>}
         <Proposal value={conversation.offer} personal={review?.scope === "PERSONAL"} />
        {review?.legacyDraft && <p>Confirm saves this as the current draft. The earlier Team revision stays in saved history. Any active rule stays on.</p>}
        <button type="button" disabled={!conversation.canConfirm || !!busy || uncertain} onClick={() => void send("confirm", {
          runId: conversation.runId, expectedVersion: conversation.version, offerDigest: conversation.offer!.digest,
        })}>Confirm and check</button>
      </section>}
      {conversation?.offerStale && <p role="status">This offer is no longer current. Review the saved state or ask for a new proposal.</p>}
      {conversation?.confirmation && <p role="status">{confirmationText[conversation.confirmation.status]
        ?? (conversation.confirmation.eligible ? "Draft checked. Not turned on by Confirm." : "Examples passed, but the draft is not eligible for approval.")}</p>}
      {review?.behavior && <section className="shared-proposal" aria-label="Saved draft">
         <h3>Saved draft</h3>
         {review.scope === "TEAM" && <p>{teamScope}</p>}
         <Proposal value={review.behavior} checked={review.checked} personal={review.scope === "PERSONAL"} />
        <p>{review.on ? "In use now" : review.approved ? "Approved · Not on yet" : "Not on yet"}</p>
        {review.occupied && <p>A rule already uses one or more of these hooks. {review.scope === "PERSONAL"
          ? <>Turn off {review.occupants.length ? review.occupants.map(name => `“${name}”`).join(", ") : "the current rule"} before turning this one on.</>
          : "This Studio will not replace it automatically."}</p>}
        {review.token && !uncertain && <button type="button" disabled={!!busy || live || !!conversation?.offer} onClick={() => void send(
          review.approved ? "activate" : "approve", { token: review.token },
        )}>{review.approved ? "Turn on" : "Approve this draft"}</button>}
      </section>}
      {review && !review.on && <p>In use now: {review.inUse ?? "No rule for this slot."}</p>}
      {!conversation && review && !review.behavior && <p>Describe what should happen when you save or complete a task.</p>}
       {review?.legacyDraft && !conversation?.offer && <p>Open More to read or continue the earlier Team draft.</p>}
       {teamControls && <details className="shared-studio-tools" onToggle={event => {
         if (event.currentTarget.open) setShowControls(true);
       }}>
         <summary>More</summary>
         {snapshot?.canContinue && <button type="button" className="quiet-button" onClick={teamControls.openEarlier}>Open earlier Team work</button>}
         {showControls && snapshot?.savedControls && <TeamCapability project={teamControls.project} request={request} scopeControl={null}
           back={back} backToTasks={backToTasks} openShared={back} operationScope={teamControls.operationScope} controlsOnly
           onControl={() => { void refresh().catch(() => setError("Saved state is unavailable.")); }} />}
         {snapshot && !snapshot.canContinue && !snapshot.savedControls && <p>No saved Team controls yet.</p>}
       </details>}
    </div>
    {!atEnd && <button type="button" onClick={() => {
      follow.current = true; if (list.current) list.current.scrollTop = list.current.scrollHeight; setAtEnd(true);
    }}>Jump to latest</button>}
    <div className="shared-studio-tools">
      {live && <button type="button" onClick={() => void stop()} disabled={conversation?.status === "CANCELLING"}>Stop</button>}
      {replyRecovery && <p id="studio-reply-recovery" role="status">
        {checkedReply?.checked ? "Checked. This message is saved; no new proposal was received."
          : checkedReply ? "Daymark couldn’t check saved work." : "See what Daymark kept."}{" "}
        Checking won’t send your message again.
      </p>}
      <button type="button" aria-describedby={replyRecovery ? "studio-reply-recovery" : undefined}
        onClick={() => void readSavedState()}>{replyRecovery ? "Check saved work" : "Read saved state"}</button>
    </div>
    {!teamControls && review?.disableToken && <div>
      {stopToken === review.disableToken ? <>
         <p>This turns off the Personal rule without undoing saved work. Unfinished actions on this version will not run.</p>
         <button disabled={!!busy || live} onClick={() => { setStopToken(null); void send("disable", { token: stopToken }); }}>
           Confirm turn off</button>
        <button onClick={() => setStopToken(null)}>Cancel</button>
       </> : <button disabled={!!busy || live} onClick={() => setStopToken(review.disableToken)}>
         Turn off</button>}
    </div>}
    {snapshot && !snapshot.availability.available && <div className="rs-setup-notice">
      <p role="status">{canConfigureAssistant(snapshot.availability) ? "Set up the assistant to create or change a customization." : "The assistant is unavailable. You can still use Tasks and review saved work."}</p>
      {canConfigureAssistant(snapshot.availability) && <button ref={setupInvoker} onClick={() => setSetupOpen(true)}>Configure</button>}
    </div>}
    {review?.scope === "PERSONAL" && snapshot?.availability.available && <label className="shared-studio-tools">
      <input type="checkbox" checked={includeTaskNotes} disabled={!!busy || live}
        onChange={event => setIncludeTaskNotes(event.currentTarget.checked)} /> Allow task-note excerpts for this message
    </label>}
    <StudioComposer text={text} change={changeText} isLocked={() => action.current}
      canSend={!!snapshot?.availability.available && !!text.trim() && !busy && !live}
      submit={event => {
        event.preventDefault();
        if (!snapshot?.availability.available || !review || !text.trim() || live || action.current) return;
        const notes = review.scope === "PERSONAL" && includeTaskNotes;
        setIncludeTaskNotes(false);
        void send("turn", { operationId: crypto.randomUUID(), expectedVersion: conversation?.version ?? 0,
          expectedDraftVersion: review.draftVersion, text, ...(notes && { includeTaskNotes: true }) });
      }} />
    {setupOpen && review && <AssistantSetup team={review.scope === "TEAM"} request={request} close={closeSetup}
      beginSave={() => {}} saved={() => closeSetup(false)} />}
  </section>;
}
