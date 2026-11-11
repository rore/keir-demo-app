import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { describeRule, type RuleCondition, type RuleDescription } from "./rule-description";
import "./Studio.css";

type Revision = { id: string; templateId: string; kind?: "authored" | "prepared"; suiteDigest?: string | null; label: string; ruleDescription?: RuleDescription; pins: { artifactDigest?: string; rawSourceDigest?: string; compiledSourceDigest?: string; modelRef?: { format?: string } }; provenance: "operator" | "customer" };
type History = { id: number; generation: number; operation: string; revisionId: string | null; label?: string | null };
export type State = {
  retired?: boolean;
  legacySelection?: { generation: number; revision: Revision; eligible: false };
  executionAvailability?: { available: boolean; message: string | null };
  requestExcerpt?: string;
  owner: { id: string; name: string };
  extension: { id: string; name: string; hookId: string | null; creationOperationId?: string; creationRevisionId?: string | null } | null;
  catalog: { id: string; label: string; openCode: string }[];
  draftVersion: number;
  draft: Revision | null;
  evidence: { id: string; revisionId: string; passed: boolean } | null;
  approved: boolean;
  approvedEvidenceId: string | null;
  selection: { generation: number; revision: (Revision & { extensionId: string; extensionName: string }) | null; eligible: boolean; approvedEvidenceId: string | null };
  restoreTargets: Revision[];
  restoreTargetsNext?: string | null;
  evidenceHistoryNext?: string | null;
  historyNext?: number | null;
  history: History[];
  evidenceHistory: { id: string; revisionId: string }[];
};
export type Collection = { items: Pick<State, "extension" | "draftVersion" | "draft" | "approved" | "requestExcerpt" | "retired">[]; owner: State["owner"]; selection: State["selection"]; selections?: Partial<Record<string, State["selection"]>>; catalog: State["catalog"]; executionAvailability?: State["executionAvailability"]; next: string | null };
export type StudioTarget = { extensionId: string | null; conversationId?: string | null; recoveryId?: string; history?: boolean };
type HostCatalog = {
  hooks: { id: string; label: string; description: string; effect: string; trigger: string }[];
  model: { dcm: string; digest: string; hook: string; consumer: object; compiler: unknown };
};
const taskTrigger = (hookId: string | null | undefined) => hookId === "TaskBeforeCreate" ? "new tasks" : hookId === "TaskCreated" ? "tasks added" : hookId === "TaskCompleted" ? "tasks completed" : null;
export const taskTriggerGroup = (hookId: string | null | undefined) => hookId === "TaskBeforeCreate" ? "Checks before adding"
  : hookId === "TaskCreated" ? "Actions after adding" : hookId === "TaskCompleted" ? "Actions after completing" : null;
const workflowStarters = [
  { label: "Check new tasks", hook: "TaskBeforeCreate", capabilities: [],
    text: "Before adding a new task tagged client, require a due date." },
  { label: "Prioritize new requests", hook: "TaskCreated", capabilities: ["tasks.get", "tasks.update"],
    text: "When a new task in Inbox is tagged client and its title is exactly ‘Quote for spring launch’, give it high priority." },
  { label: "Arrange a review", hook: "TaskCompleted", capabilities: ["tasks.get", "tasks.create"],
    text: "When a high-priority task tagged review is completed in Launch, create a review task in Reviews due 7 days after completion." },
  { label: "Avoid another follow-up", hook: "TaskCompleted", capabilities: ["tasks.get", "tasks.create", "tasks.openMatch"],
    text: "When a task in Launch is completed, create a follow-up in Reviews only if one is not already open." },
  { label: "Add missing due dates", hook: "TaskCreated", capabilities: ["tasks.get", "tasks.update"],
    text: "When a task is added to Onboarding without a due date, give it a due date 7 days after it was added." },
];
function hostFeatures(catalog: HostCatalog | null) {
  try {
    const model = JSON.parse(catalog?.model.dcm ?? "{}");
    return { capabilities: Object.keys(model.capabilities ?? {}), taskFields: Object.keys(model.types?.Task?.fields ?? {}) };
  } catch { return { capabilities: [], taskFields: [] }; }
}
type Outcome = { classification: string; code?: string; error?: { code: string }; trace?: { event: string; step?: string; capability?: string; taken?: boolean }[]; consumption?: { status: "DISPLAYED" | "NOT_DISPLAYED"; code?: string } };
type TaskFields = { notes?: string; tags?: string[]; priority?: string; dueAt?: string | null };
type TaskPreview = TaskFields & { id?: string; title: string; status?: "OPEN" | "COMPLETED"; projectId?: string; projectName?: string };
type TaskUpdate = { id: string; addTag?: string; priority?: string; dueAt?: string };
type EffectObservation = { effect: "CONFIRMED" | "NONE" | "UNKNOWN" | "NOT_OBSERVED"; createdTasks: TaskPreview[] | null; updatedTasks?: TaskUpdate[] | null };
type CreateProposal = { projectId: string; priority: "low" | "normal" | "high"; tags: string[]; hasNotes: boolean; hasDueDate: boolean };
type GuardConsumption = { status: "ALLOWED" | "DENIED"; result: { decision: "ALLOW" | "DENY"; message: string } } | { status: "BLOCKED" };
type SavedSource = { extensionId?: string; revisionId: string; source: string; artifact: string; pins: Revision["pins"]; cases: string[]; suiteDigest: string | null; ruleDescription?: RuleDescription };
type CaseSummary = { id?: string; verification: "matched" | "mismatched" | "unchecked"; availability: "available" | "unavailable" | "unknown";
  simulatedFailure?: "invalid-host-context";
  outcome: "changed" | "unchanged" | "handled-problem" | "uncertain" | "unchecked" | "mismatch" };
type SimulationSummary = { cases: CaseSummary[]; totalCases: number; returnedCases: number; truncated: boolean;
  counts: { verification: Record<CaseSummary["verification"], number>; outcome: Record<CaseSummary["outcome"], number> } };
type Evidence = { id: string; revisionId: string; kind?: "authored" | "prepared"; identity: object; passed: boolean; summary?: SimulationSummary | null; reports: {
  id: string; label: string; expected: { createdTasks?: TaskPreview[] | null; updatedTasks?: TaskUpdate[] | null; [key: string]: unknown }; taskStatus?: "OPEN" | "COMPLETED" | null; readFailure?: "TASK_NOT_FOUND" | "ACCESS_DENIED" | "TRANSIENT_FAILURE" | null;
  report: { status: string; scenario?: { task?: TaskPreview; proposal?: CreateProposal; occurredAt?: string; hookId?: string; openMatches?: { projectId: string; title: string; matches: boolean }[] }; observed?: EffectObservation; native?: Outcome; calls?: { step?: string; capability: string; args?: { projectId?: string; title?: string; taskId?: string } }[]; consumption?: { status: string; code?: string; result?: { decision: string; message: string } }; mismatches: { stage?: string; code?: string }[] };
}[] };
type SavedReview = { owner: State["owner"]; extension: NonNullable<State["extension"]>; revision: Revision;
  draftVersion: number; evidenceId: string; suiteDigest: string | null; selection: State["selection"] };
type Message = { id: number | string; who: "You" | "Studio"; text: string; conversationId?: string; evidenceId?: string; exampleCount?: number; context?: string };
type Operation = { id: string; runId: string; version: number };
type Conversation = {
  retired?: boolean;
  extensionId: string | null; purpose: "CREATE" | "REVISE" | null;
  id: string; version: number; status: "IDLE" | "RUNNING" | "CANCELLING" | "AWAITING_USER" | "REVIEW_AVAILABLE" | "CANCELLED" | "BLOCKED" | "INTERRUPTED";
  runId: string; operation: Operation; messages: { id: string; role: "user" | "assistant"; text: string; kind: "text" | "clarification" | "review";
    receipt?: { revisionId: string; draftVersion: number; suiteDigest: string; evidenceId: string } }[];
  messagesBefore?: string | null;
  code: string | null; review: { revisionId: string; draftVersion: number; suiteDigest: string; evidenceId: string; eligible: boolean } | null;
  draft: { revisionId: string | null; draftVersion: number; suiteDigest: string | null }; selection: { revisionId: string | null; generation: number };
};
type Transcript = { messages: (Conversation["messages"][number] & { conversationId: string })[]; next: string | null };
const sameReviewRevision = (state: State, saved: SavedReview) => !state.retired && state.owner.id === saved.owner.id
  && state.extension?.id === saved.extension.id && state.draft?.id === saved.revision.id && state.draftVersion === saved.draftVersion
  && (state.draft.suiteDigest ?? null) === saved.suiteDigest;
const sameReviewDraft = (state: State, saved: SavedReview) => sameReviewRevision(state, saved) && state.selection.generation === saved.selection.generation;
const savedProofEligible = (state: State, id: string) => state.approved && state.approvedEvidenceId === id
  || state.evidence?.id === id && state.evidence.revisionId === state.draft?.id && state.evidence.passed;
const matchingOffer = (conversation: Conversation | null | undefined, state: State) => !!conversation?.review?.eligible
  && !conversation.retired && !!state.extension && conversation.extensionId === state.extension.id && !!state.draft
  && conversation.review.revisionId === state.draft.id && conversation.review.draftVersion === state.draftVersion
  && conversation.review.suiteDigest === state.draft.suiteDigest;
type Authoring = {
  availability: { available: boolean; code: string | null; provider: "openai" | "anthropic" | null; model: string | null };
  current: Conversation | null;
  transcript?: Transcript;
};
type TurnTarget = { kind: "create" } | { kind: "revise"; extensionId: string; baseRevisionId: string | null; selectionGeneration: number } | { kind: "resume"; extensionId: string };
type Turn = { target: TurnTarget; conversationId: string | null; operationId: string; text: string; expectedVersion: number; expectedDraftVersion: number };
export function pendingRequests(ownerId: string) {
  const entries: { entryId: string; turn: Turn }[] = [];
  const prefix = "daymark-studio-work:" + ownerId + ":";
  try {
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index)!;
      if (!key.startsWith(prefix)) continue;
      const entryId = key.slice(prefix.length);
      if (!/^[0-9a-f-]{36}$/i.test(entryId)) continue;
      let turn: Turn;
      try { turn = JSON.parse(sessionStorage.getItem(key)!); } catch { continue; }
      if (!turn || !/^[0-9a-f-]{36}$/i.test(turn.operationId) || typeof turn.text !== "string" || !turn.text.trim()
        || new TextEncoder().encode(turn.text).length > 8192 || !Number.isSafeInteger(turn.expectedVersion) || turn.expectedVersion < 0
        || !Number.isSafeInteger(turn.expectedDraftVersion) || turn.expectedDraftVersion < 0
        || !(turn.conversationId === null || typeof turn.conversationId === "string") || !turn.target) continue;
      const target = turn.target;
      if (target.kind === "create" ? turn.conversationId !== null : !["revise", "resume"].includes(target.kind)
        || typeof target.extensionId !== "string" || !target.extensionId || target.kind === "resume" && !turn.conversationId
        || target.kind === "revise" && (turn.conversationId !== null || !(target.baseRevisionId === null || typeof target.baseRevisionId === "string")
          || !Number.isSafeInteger(target.selectionGeneration) || target.selectionGeneration < 0)) continue;
      entries.push({ entryId, turn });
    }
  } catch { /* The caller can keep an in-memory request when tab storage is unavailable. */ }
  return entries;
}
type Setup = {
  configuration: { status: string; code: string | null; source: "local" | "environment" | "none"; provider: string | null; model: string | null; maxUsd: string | null };
  choices: { provider: string; model: string }[];
  availability: Authoring["availability"];
};
const running = (value: Conversation | null) => value?.status === "RUNNING" || value?.status === "CANCELLING";
const authoringStatus = {
  IDLE: "Ready for a description.", RUNNING: "Preparing your customization…", CANCELLING: "Stopping authoring; waiting for work to settle…",
  AWAITING_USER: "Your answer is needed before authoring can continue.", REVIEW_AVAILABLE: "Your proposal is ready to inspect. Approval and turning it on are separate decisions.",
  CANCELLED: "Authoring stopped. Saved work remains available.", BLOCKED: "Authoring could not continue. Saved work remains available.",
  INTERRUPTED: "Authoring was interrupted. Check saved state before explicitly continuing.",
};
function authoringReason(code: string | null | undefined) {
  if (!code) return "";
  if (code === "LEGACY_CUSTOMIZATION_RETIRED") return "This earlier customization is retired. Its saved work is read-only. You can start a new customization.";
  if (["AI_NOT_CONFIGURED", "AI_CONFIG_INVALID", "AI_CREDENTIALS_MISSING"].includes(code)) return "AI authoring is not configured.";
  if (code === "SPEND_LIMIT") return "The shared authoring allowance is exhausted. Saved work and review remain available.";
  if (["BUDGET_EXHAUSTED", "EXPIRED"].includes(code)) return "An earlier authoring policy stopped this saved run. Your discussion, proposal and examples are kept. You can explicitly continue here under the current settings and shared allowance.";
  if (code === "PROVIDER_RATE_LIMIT") return "Your AI provider reached a request or account limit. Your discussion and any saved draft are kept. Check provider usage or explicitly try again later. Nothing is retried automatically.";
  if (code === "CONTEXT_LIMIT") return "This run reached the assistant’s request size boundary. Progress is saved. Explicitly continue here to use the current saved proposal and recent discussion; nothing is sent automatically.";
  if (code === "CONFIG_CHANGED") return "Assistant settings changed. Your message is kept. Send it again when you’re ready.";
  if (code === "CONVERSATION_LIMIT") return "An earlier authoring policy stopped this request. Your saved conversations remain available.";
  if (["STALE_CONTEXT", "STALE_DRAFT", "STALE_CONVERSATION", "CHECKPOINT_UNCERTAIN"].includes(code)) return "The request needs saved-state readback before another change. No approval or activation is implied.";
  if (code === "REVIEW_NOT_READY") return "The exact saved review could not be confirmed. Ask Studio to check the current changes, or keep discussing the draft.";
  return "AI authoring is unavailable for this request. Check saved state; native tasks and saved work remain available.";
}
type Props = {
  request: <T>(path: string, method?: string, body?: object, signal?: AbortSignal) => Promise<T>;
  changed: (generation: number) => void;
  beforeSelectionChange: () => void;
  back: () => void;
  backToTasks: () => void;
  createNew: () => void;
  backLabel: string;
  target: StudioTarget;
  ownerId: string;
  draftScope: string | null;
  drafts: Map<string, string | null>;
  recoveryKey: string;
  projects: readonly { id: string; name: string }[];
  targeted: (target: StudioTarget) => void;
  unavailable: () => void;
  task?: { title: string; status: "open" | "completed" };
};
const knownTask = (task?: TaskPreview) => !!task && typeof task.title === "string" && !!task.title.trim() && typeof task.projectId === "string" && !!task.projectId;
const knownScenarioTask = (task?: TaskPreview) => !!task && typeof task.id === "string" && !!task.id && typeof task.title === "string" && !!task.title.trim();
const knownTasks = (tasks?: TaskPreview[] | null) => Array.isArray(tasks) && tasks.every(knownTask);
type Condition = RuleCondition;
export async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return "sha256:" + Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function savedRuleDescription(saved: SavedSource, pins: Revision["pins"]): Promise<RuleDescription | null> {
  if (JSON.stringify(saved.pins) !== JSON.stringify(pins) || !pins.artifactDigest || !pins.rawSourceDigest
    || typeof saved.artifact !== "string" || typeof saved.source !== "string"
    || await sha256(saved.artifact) !== pins.artifactDigest || await sha256(saved.source) !== pins.rawSourceDigest) return null;
  return saved.ruleDescription ?? null;
}
const mismatchReason = {
  STUB: "The rule and the saved example didn’t match.",
  OUTCOME: "The rule's result differed from the saved expectation.",
  CALLS: "The operations called differed from the saved expectation.",
  CONSUMPTION: "The reported outcome differed from the saved expectation.",
  SETUP: "This example could not run with the saved inputs.",
} as const;
const knownObservation = (value?: EffectObservation) => !!value && knownTasks(value.createdTasks)
  && (value.effect === "CONFIRMED" && !!value.createdTasks!.length || value.effect === "NONE" && value.createdTasks!.length === 0);
type ProjectLabel = string | ((task: TaskPreview) => string);
const taskNames = (tasks: TaskPreview[], project?: ProjectLabel) => tasks.map(task => `“${task.title}” in ${(typeof project === "function" ? project(task) : project) ?? (task.projectName ? `“${task.projectName}”` : "the chosen project")}`).join(", ");
const observedTasks = (value?: EffectObservation, project?: ProjectLabel) => !knownObservation(value) ? value?.effect === "UNKNOWN" ? "A task may have been created; this check did not confirm it." : "No task-creation result was observed."
  : value!.createdTasks!.length ? `Created ${taskNames(value!.createdTasks!, project)}.` : "No task was created.";
const expectedTasks = (value: Evidence["reports"][number]["expected"], project?: ProjectLabel) => value.createdTasks === null ? "An uncertain result: a task may or may not be created." : !knownTasks(value.createdTasks) ? "The expected task result was not recorded."
  : value.createdTasks!.length ? `Create ${taskNames(value.createdTasks!, project)}.` : "Create no task.";
const checkedUncertainty = (item: Evidence["reports"][number]) => item.expected.createdTasks === null && item.report.observed?.effect === "UNKNOWN" && item.report.observed.createdTasks === null;
type CheckedCase = Evidence["reports"][number];
const guardCase = (item: CheckedCase) => item.report.scenario?.hookId === "TaskBeforeCreate" || item.report.scenario?.proposal !== undefined;
function knownProposal(proposal?: CreateProposal) {
  return !!proposal && Object.keys(proposal).sort().join(",") === "hasDueDate,hasNotes,priority,projectId,tags"
    && typeof proposal.projectId === "string" && !!proposal.projectId && ["low", "normal", "high"].includes(proposal.priority)
    && Array.isArray(proposal.tags) && proposal.tags.length <= 8 && proposal.tags.every(tag => typeof tag === "string" && !!tag && tag.length <= 32)
    && typeof proposal.hasNotes === "boolean" && typeof proposal.hasDueDate === "boolean";
}
function guardConsumption(value: unknown): GuardConsumption | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as GuardConsumption;
  const keys = Object.keys(result).sort().join(",");
  if (result.status === "BLOCKED" && keys === "status") return result;
  if ((result.status === "ALLOWED" || result.status === "DENIED") && keys === "result,status"
    && result.result && Object.keys(result.result).sort().join(",") === "decision,message"
    && result.result.decision === (result.status === "ALLOWED" ? "ALLOW" : "DENY")
    && typeof result.result.message === "string" && new TextEncoder().encode(result.result.message).byteLength <= 256) return result;
  return null;
}
function matchingGuardConsumption(item: CheckedCase) {
  const expected = guardConsumption(item.expected.consumption), observed = guardConsumption(item.report.consumption);
  return !!expected && !!observed && expected.status === observed.status && (expected.status === "BLOCKED"
    || observed.status !== "BLOCKED" && expected.result.decision === observed.result.decision && expected.result.message === observed.result.message);
}
const guardResultLabel = (result: GuardConsumption | null) => result?.status === "ALLOWED" ? "Allowed by this rule" : result?.status === "DENIED" ? "Blocked" : "Could not check";
const workflowCase = (item: CheckedCase) => item.report.observed?.updatedTasks !== undefined || item.expected.updatedTasks !== undefined;
const knownUpdates = (updates?: TaskUpdate[] | null) => Array.isArray(updates) && updates.every(update =>
  !!update && typeof update.id === "string" && !!update.id && [update.priority, update.dueAt, update.addTag].some(field => typeof field === "string" && !!field));
function checkedObservation(item: CheckedCase) {
  if (guardCase(item)) return knownProposal(item.report.scenario?.proposal) && matchingGuardConsumption(item)
    && item.report.observed?.effect === "NONE" && item.report.observed.createdTasks?.length === 0 && item.report.observed.updatedTasks?.length === 0;
  if (!knownScenarioTask(item.report.scenario?.task)) return false;
  const observed = item.report.observed, expected = item.expected;
  if (!workflowCase(item)) return knownTasks(expected.createdTasks) && knownObservation(observed) || checkedUncertainty(item);
  if (!(expected.createdTasks === null && expected.updatedTasks === null || knownTasks(expected.createdTasks) && knownUpdates(expected.updatedTasks))) return false;
  if (observed?.effect === "UNKNOWN" || observed?.effect === "NOT_OBSERVED") return observed.createdTasks === null && observed.updatedTasks === null;
  if (!observed || !["CONFIRMED", "NONE"].includes(observed.effect) || !knownTasks(observed.createdTasks) || !knownUpdates(observed.updatedTasks)) return false;
  return observed.createdTasks!.length + observed.updatedTasks!.length === (observed.effect === "CONFIRMED" ? 1 : 0);
}
const summarizeExamples = (proof: Evidence | null) => [...new Set(proof?.reports.filter(checkedObservation).map(item => {
  if (guardCase(item)) return guardResultLabel(guardConsumption(item.report.consumption));
  const observed = item.report.observed;
  if (!workflowCase(item)) return observedTasks(observed).replace(/\.$/, "");
  if (observed?.effect === "NONE") return "No change";
  if (observed?.effect === "UNKNOWN") return "Change not confirmed";
  if (observed?.effect !== "CONFIRMED") return "Could not check";
  if (observed.createdTasks?.length) return `Created ${taskNames(observed.createdTasks)}`;
  return observed.updatedTasks?.map(update => confirmedUpdate(update, item.report.scenario?.task).replace(/\.$/, "")).join(". ") || "Could not check";
}) ?? [])].join("; ");
const priorityLabel = (value: string) => value[0]?.toUpperCase() + value.slice(1).toLowerCase();
const utc = (value: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) ? value.replace("T", " ").replace("Z", " UTC") : value;
function taskDetails(task: TaskFields) {
  return [task.priority && `Priority ${priorityLabel(task.priority)}`, task.dueAt && `Due ${utc(task.dueAt)}`,
    task.tags?.length && `Tags ${task.tags.join(", ")}`, task.notes !== undefined && `Notes “${task.notes}”`].filter(Boolean).join(" · ");
}
function expectedUpdate(update: TaskUpdate) {
  const fields = [update.priority && `Priority ${priorityLabel(update.priority)}`, update.dueAt && `Due date ${utc(update.dueAt)}`,
    update.addTag && `Add tag “${update.addTag}”`].filter(Boolean).join(" · ");
  return `Update this task.${fields ? ` ${fields}.` : ""}`;
}
function confirmedUpdate(update: TaskUpdate, before?: TaskPreview) {
  if (before?.id !== update.id || !before.status) return "Update confirmed.";
  const changes = [];
  let unknown = false;
  if (update.priority !== undefined) {
    if (!before.priority) unknown = true;
    else if (before.priority !== update.priority) changes.push(`Priority ${priorityLabel(before.priority)} → ${priorityLabel(update.priority)}`);
  }
  if (update.dueAt !== undefined && before.dueAt !== update.dueAt) changes.push(`Due date ${before.dueAt ? utc(before.dueAt) : "No due date"} → ${utc(update.dueAt)}`);
  if (update.addTag !== undefined) {
    if (!Array.isArray(before.tags)) unknown = true;
    else if (!before.tags.includes(update.addTag)) changes.push(`Added tag “${update.addTag}”`);
  }
  return changes.length ? `Updated this task. ${changes.join(" · ")}.` : unknown ? "Update confirmed." : "Update confirmed. The task fields stayed the same.";
}

const continuationPrefix = "Continue my saved proposal and examples using these earlier messages. If the context is incomplete, ask before changing the examples.\n\n";
function conversationMessage(id: string, item: Conversation["messages"][number]): Message {
  return { id: `ai:${id}:${item.id}`, conversationId: id, who: item.role === "user" ? "You" : "Studio",
    text: item.role === "user" && item.text.startsWith(continuationPrefix) ? "Continue from saved work." : item.text,
    evidenceId: item.role === "assistant" ? item.receipt?.evidenceId : undefined,
    context: item.role === "user" && item.text.startsWith(continuationPrefix) ? item.text : undefined };
}

function AssistantSetup({ request, close, saved, beginSave }: { request: Props["request"]; close: (uncertain: boolean) => void; saved: (value: Setup) => void; beginSave: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const key = useRef<HTMLInputElement>(null);
  const lifetime = useRef(new AbortController());
  const alive = useRef(true);
  const saving = useRef(false);
  const uncertain = useRef(false);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [maxUsd, setMaxUsd] = useState("");
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [reading, setReading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const callbacks = useRef({ request, close, saved, beginSave });
  callbacks.current = { request, close, saved, beginSave };
  async function read(initial = false) {
    setReading(true); setReadFailed(false);
    try {
      const next = await callbacks.current.request<Setup>("authoring/setup", "GET", undefined, lifetime.current.signal);
      if (!alive.current) return;
      setSetup(next);
      if (initial) {
        const choice = next.choices.find(item => item.provider === next.configuration.provider && item.model === next.configuration.model) ?? next.choices[0];
        setProvider(choice?.provider ?? ""); setModel(choice?.model ?? ""); setMaxUsd(next.configuration.maxUsd ?? "");
      }
    } catch { if (alive.current) setReadFailed(true); }
    finally { if (alive.current) setReading(false); }
  }
  useEffect(() => {
    dialog.current?.showModal(); void read(true);
    return () => { alive.current = false; if (key.current) key.current.value = ""; lifetime.current.abort(); };
  }, []);
  function reject(field: string, message: string) {
    setInvalid(field); setError(message);
    dialog.current?.querySelector<HTMLElement>("#assistant-" + field)?.focus();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || !setup || reading || readFailed) return;
    setError(""); setInvalid("");
    if (!setup.choices.some(item => item.provider === provider && item.model === model)) return reject("provider", "Choose a supported service and model.");
    if (!key.current?.value || key.current.value.length > 4096 || /[^\x21-\x7e]/.test(key.current.value)) return reject("key", "Enter an API key of 1–4096 printable characters, without spaces.");
    const [whole, fraction = ""] = maxUsd.split(".");
    const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
    if (maxUsd !== "" && (!/^\d+(?:\.\d{1,6})?$/.test(maxUsd) || !Number.isSafeInteger(micros) || micros <= 0)) {
      return reject("allowance", "Enter a positive USD allowance with up to six decimal places, or leave it blank.");
    }
    saving.current = true; setWaiting(true);
    callbacks.current.beginSave();
    const apiKey = key.current.value;
    key.current.value = "";
    try {
      const next = await callbacks.current.request<Setup>("authoring/setup", "POST", { provider, model, apiKey, maxUsd }, lifetime.current.signal);
      if (alive.current) callbacks.current.saved(next);
    } catch (failure) {
      if (!alive.current) return;
      const status = (failure as { status?: number })?.status;
      const code = (failure as { code?: string })?.code;
      uncertain.current ||= ![400, 401, 403, 409, 413, 415, 503].includes(status ?? 0);
      setError(status === 409 ? code === "AI_BUSY" ? "Settings were not saved. Authoring is still running or stopping. Wait for it to settle, then re-enter the key before explicitly saving again."
        : code === "SPEND_LIMIT" ? "Settings were not saved. Re-enter the key and choose an allowance that covers previous reservations, or leave it blank."
        : "Settings were not saved. Wait for running authoring to settle and check that the total allowance covers prior reservations. Re-enter the key before explicitly saving again."
        : status === 401 || status === 403 ? "The session or host check rejected these settings. Existing settings remain unchanged."
        : status === 400 || status === 413 || status === 415 ? "These settings were rejected. Check the supported service, model and allowance, then re-enter the key."
        : status === 503 ? "Settings could not be saved. Existing settings remain unchanged. Re-enter the key before explicitly trying again."
        : "Saving could not be confirmed. Checking current settings without resubmitting. A matching status cannot confirm whether the key was replaced. Re-enter the key only if you choose to save again.");
      await read();
      if (status === 400) dialog.current?.querySelector<HTMLElement>("#assistant-provider")?.focus();
    } finally { saving.current = false; if (alive.current) setWaiting(false); }
  }
  return <dialog ref={dialog} className="detail rs-setup" aria-labelledby="assistant-setup-title"
    onCancel={event => { event.preventDefault(); callbacks.current.close(saving.current || uncertain.current); }}>
    <form noValidate onSubmit={submit}>
      <div className="rs-setup-fields">
        <h2 id="assistant-setup-title">Set up the assistant</h2>
        <p>These settings are shared by all three people in this demo. Each person keeps their own customizations.</p>
        <p>The AI service receives your messages, a description of what the app can do, your draft customization, sample cases and filtered results. Sending a message may cost money.</p>
        {reading && <p role="status">Checking current settings…</p>}
        {readFailed && <p role="alert">Assistant settings could not be checked. <button type="button" disabled={waiting || reading} onClick={() => void read(!setup)}>Retry status</button></p>}
        {error && <p className="error" role="alert">{error}</p>}
        {setup && <>
          <p>Current settings: {setup.configuration.provider ? setup.configuration.provider + " / " + setup.configuration.model + " · "
            + (setup.configuration.maxUsd === null ? "No Daymark spending cap" : setup.configuration.maxUsd + " USD total") : "Not configured"}. Saving a key does not establish that it works.</p>
          <label htmlFor="assistant-provider">Service</label>
          <select id="assistant-provider" value={provider} disabled={waiting} aria-invalid={invalid === "provider"} onChange={event => {
            setProvider(event.target.value); setModel(setup.choices.find(item => item.provider === event.target.value)?.model ?? ""); if (key.current) key.current.value = "";
          }}>{Array.from(new Set(setup.choices.map(item => item.provider))).map(item => <option key={item} value={item}>{item}</option>)}</select>
          <label htmlFor="assistant-model">Model</label>
          <select id="assistant-model" value={model} disabled={waiting} onChange={event => setModel(event.target.value)}>{setup.choices.filter(item => item.provider === provider).map(item => <option key={item.model} value={item.model}>{item.model}</option>)}</select>
          <label htmlFor="assistant-key">API key</label>
          <input ref={key} id="assistant-key" type="password" autoComplete="off" maxLength={4096} disabled={waiting} aria-invalid={invalid === "key"} aria-describedby="assistant-key-help" />
          <p id="assistant-key-help">The key is saved privately on the demo server. Enter it for every save; the saved secret is never returned to this form.</p>
          <label htmlFor="assistant-allowance">Shared allowance (USD)</label>
          <input id="assistant-allowance" inputMode="decimal" value={maxUsd} disabled={waiting} aria-invalid={invalid === "allowance"} onChange={event => setMaxUsd(event.target.value)} aria-describedby="assistant-allowance-help" />
          <p id="assistant-allowance-help">Optional. Leave blank to allow provider charges without a Daymark spending cap. If set, this is the total allowance across the demo. It includes estimated costs from earlier requests.</p>
          <p>Replacing settings requires a new conversation for future requests. Saved customizations, sample results and approval remain available.</p>
        </>}
      </div>
      <div className="rs-setup-actions"><p>Saving these settings won’t contact the service or use any allowance.</p>
        <div><button className="primary rs-primary" disabled={!setup || waiting || reading || readFailed}>{waiting ? "Saving settings…" : "Save settings"}</button>
          <button type="button" onClick={() => callbacks.current.close(saving.current || uncertain.current)}>Cancel</button></div>
      </div>
    </form>
  </dialog>;
}

function CustomizationName({ ownerId, itemId, name, suggestion, disabled, request, saved }: {
  ownerId: string; itemId: string; name: string; suggestion?: string; disabled: boolean; request: Props["request"]; saved: (value: State) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [expectedName, setExpectedName] = useState(name);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null), button = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false), pending = useRef(false), mounted = useRef(false), composing = useRef(false);
  const lifetime = useRef(new AbortController());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; lifetime.current.abort(); }; }, []);
  useLayoutEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select(); }
    else if (restoreFocus.current) { restoreFocus.current = false; button.current?.focus({ preventScroll: true }); }
  }, [editing]);
  function close() { if (!pending.current) { composing.current = false; restoreFocus.current = true; setEditing(false); } }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || disabled || composing.current) return;
    const trimmed = value.trim();
    if (!trimmed || Array.from(trimmed).length > 80) { setError("Use a name of 1–80 characters."); input.current?.focus(); return; }
    pending.current = true; setSaving(true); setError("");
    const path = "extensions/" + encodeURIComponent(itemId);
    const accept = (next: State) => {
      if (!mounted.current || next.owner.id !== ownerId || next.extension?.id !== itemId) return false;
      saved(next); return true;
    };
    try {
      const next = await request<State>(path + "/rename", "POST", { name: trimmed, expectedName }, lifetime.current.signal);
      if (accept(next)) { restoreFocus.current = true; setEditing(false); }
    } catch (failure) {
      if (!mounted.current) return;
      if ((failure as { status?: number }).status === 409) {
        let currentName: string | undefined;
        try {
          const next = await request<State>(path, "GET", undefined, lifetime.current.signal);
          if (accept(next)) { setExpectedName(next.extension!.name); currentName = next.extension!.name; }
        } catch { /* Keep the original comparison until current metadata can be read. */ }
        if (mounted.current) setError(currentName !== undefined ? `The saved name is now “${currentName}”. Your text is kept; check this name before saving again.`
          : "The saved name changed and could not be checked. Your text is kept. Cancel and reopen the name form to check it before saving again.");
      } else setError("The name could not be saved. Your text is kept; try again when ready.");
    } finally { pending.current = false; if (mounted.current) setSaving(false); }
  }
  return <>
    <button ref={button} className="rs-rename rs-link" hidden={editing} disabled={disabled} onClick={() => {
      setValue(name); setExpectedName(name); setError(""); setEditing(true);
    }}>Rename</button>
    {editing && <form className="rs-rename-form" aria-label="Rename customization" onSubmit={event => void submit(event)} onKeyDown={event => {
      if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) { event.preventDefault(); return; }
      if (composing.current || event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); close(); }
    }}>
      <label htmlFor="studio-customization-name">Name</label><input ref={input} id="studio-customization-name" value={value} maxLength={160} disabled={saving} onChange={event => setValue(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} aria-describedby={error ? "studio-name-error" : undefined} />
      <button disabled={saving || disabled}>Save</button><button type="button" disabled={saving} onClick={close}>Cancel</button>
      {suggestion && suggestion !== name && <p className="rs-name-suggestion">Suggested: “{suggestion}” <button type="button" disabled={saving || disabled} onClick={() => {
        setValue(suggestion); setError(""); input.current?.focus();
      }}>Use suggested name</button><span>Only Save changes the saved name.</span></p>}
      {error && <p id="studio-name-error" role="alert">{error}</p>}
    </form>}
  </>;
}

export default function Studio({ request, changed, beforeSelectionChange, back, backToTasks, createNew, backLabel, target, ownerId, draftScope, drafts, recoveryKey, projects, targeted, unavailable, task }: Props) {
  const initialTarget = useRef(target);
  const extensionId = useRef(target.extensionId);
  const requestedConversation = useRef<string | null>(null);
  const historyMode = useRef(target.history === true || !!(target.extensionId && target.conversationId));
  const [historyView, setHistoryView] = useState(historyMode.current);
  const [entry, setEntry] = useState(target.extensionId || target.conversationId ? "item" : "start");
  const [hostCatalog, setHostCatalog] = useState<HostCatalog | null>(null);
  const [starterNotice, setStarterNotice] = useState("");
  const [catalogError, setCatalogError] = useState(false);
  const [activeView, setActiveView] = useState(false);
  const [activeSnapshot, setActiveSnapshot] = useState<{ ownerId: string; extensionId: string; revision: NonNullable<State["selection"]["revision"]>; generation: number; evidenceId: string | null } | null>(null);
  const [activeProof, setActiveProof] = useState<Evidence | null>(null);
  const [activeSummaryError, setActiveSummaryError] = useState("");
  const [restart, setRestart] = useState<{ draftVersion: number; revisionId: string; generation: number; activeLabel: string; draftLabel: string } | null>(null);
  const [recoveryError, setRecoveryError] = useState("");
  const [deleted, setDeleted] = useState(false);
  const deletedTitle = useRef<HTMLHeadingElement>(null);
  const deletedRef = useRef(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupNotice, setSetupNotice] = useState("");
  const setupInvoker = useRef<HTMLElement | null>(null);
  const setupGeneration = useRef(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [inlineOpen, setInlineOpen] = useState(false);
  const [state, setState] = useState<State | null>(null);
  const [retiredOperation, setRetiredOperation] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [comparison, setComparison] = useState<{ selection: State["selection"]; proof: Evidence } | null>(null);
  const [comparisonError, setComparisonError] = useState("");
  const [reviewEvidence, setReviewEvidence] = useState<Evidence | null>(null);
  const [savedReview, setSavedReview] = useState<SavedReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const reviewLoad = useRef(0);
  const [exampleId, setExampleId] = useState<string | null>(null);
  const [review, setReview] = useState("");
  const [reviewSource, setReviewSource] = useState<(SavedSource & { ownerId: string; key: string }) | null>(null);
  const [ruleAction, setRuleAction] = useState<{ key: string; description: RuleDescription | null } | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [inspection, setInspection] = useState<(SavedSource & { key: string; historical: boolean }) | null>(null);
  const [restore, setRestore] = useState("");
  const [lookup, setLookup] = useState("");
  const draftKey = "daymark-studio-draft:" + JSON.stringify([ownerId, draftScope, target.extensionId ? ["item", target.extensionId] : ["entry", recoveryKey]]);
  function readDraft(key: string) {
    if (drafts.has(key)) return drafts.get(key) ?? null;
    if (!draftScope) return null;
    try { const value = sessionStorage.getItem(key); return value !== null && value.length <= 8192 ? value : null; }
    catch { return null; }
  }
  const [restoredDraft] = useState(() => readDraft(draftKey));
  const [text, setText] = useState(restoredDraft ?? "");
  const draftValue = useRef(restoredDraft);
  const currentText = useRef(text);
  currentText.current = text;
  const draftEdits = useRef(0);
  const submittedDraft = useRef<{ operationId: string; edit: number } | null>(null);
  const draftBinding = useRef({ key: draftKey, ownerId, draftScope, item: target.extensionId });
  const [draftStorageUnavailable, setDraftStorageUnavailable] = useState(false);
  const [authoring, setAuthoring] = useState<Authoring | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [authoringError, setAuthoringError] = useState("");
  const [contextContinuation, setContextContinuation] = useState<{ conversationId: string; expectedVersion: number } | null>(null);
  const [pendingTurn, setPendingTurn] = useState<Turn | null>(() => pendingRequests(ownerId).find(item => recoveryKey.endsWith(":" + item.entryId))?.turn ?? null);
  const restoredSubmission = useRef(pendingTurn && restoredDraft === null ? pendingTurn.operationId : null);
  const [retryTurn, setRetryTurn] = useState(false);
  const [observationPaused, setObservationPaused] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const authoringLifetime = useRef(new AbortController());
  const [width, setWidth] = useState(52);
  const [pane, setPane] = useState<"conversation" | "preview">("conversation");
  const [canvasView, setCanvasView] = useState<"active" | "results" | "details">("active");
  const viewIntent = useRef(0), focusIntent = useRef(0);
  const currentPane = useRef<{ open: boolean; view: typeof canvasView }>({ open: false, view: "active" });
  const [newMessages, setNewMessages] = useState(false);
  const [history, setHistory] = useState<History[]>([]);
  const [historyNext, setHistoryNext] = useState<number | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [revisionsNext, setRevisionsNext] = useState<string | null | undefined>(undefined);
  const [messagesBefore, setMessagesBefore] = useState<string | null>(null);
  const [messagePageError, setMessagePageError] = useState<{ scope: string; before: string } | null>(null);
  const messageHistory = useRef<{ scope: string; anchor: string | number | null; snapshotBefore: string | null; ids: Set<string | number> } | null>(null);
  const prependedMessages = useRef<{ height: number; top: number; focus: HTMLElement | null; anchor: { element: HTMLElement; top: number } | null } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const room = useRef<HTMLDivElement>(null);
  const studioPage = useRef<HTMLElement>(null);
  const chatLog = useRef<HTMLDivElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLElement>(null);
  const developerTools = useRef<HTMLDetailsElement>(null);
  const canvasScroll = useRef(0);
  const managementReturn = useRef<{ view: typeof canvasView; position: number } | null>(null);
  const readingAnchor = useRef<{ scroller: HTMLElement; element: HTMLElement; top: number; revision: number } | null>(null);
  const inlineInvoker = useRef<HTMLElement | null>(null);
  const reviewInvoker = useRef<HTMLElement | null>(null);
  const conversationReturn = useRef(0);
  const evidenceReturn = useRef<string | null>(null);
  const followConversation = useRef(true);
  const readingRevision = useRef(0);
  const messageId = useRef(0);
  const initialized = useRef(false);
  const focusUse = useRef<{ view: number; focus: number; reading: number; target: string } | null>(null);
  const [limits, setLimits] = useState({ min: 30, max: 70 });
  const mounted = useRef(false);
  const locked = useRef(false);
  const serial = useRef(0);
  const stateEpoch = useRef(0);
  const callbacks = useRef({ request, changed, beforeSelectionChange, targeted, unavailable });
  callbacks.current = { request, changed, beforeSelectionChange, targeted, unavailable };
  function keepDraft(key: string, value: string | null) {
    drafts.set(key, value);
    try {
      if (!draftScope) throw new Error("Draft session unavailable");
      if (value !== null) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
      setDraftStorageUnavailable(false);
      return true;
    } catch { setDraftStorageUnavailable(true); return false; }
  }
  function editText(value: string) {
    draftEdits.current++;
    draftValue.current = value;
    currentText.current = value;
    setText(value);
    keepDraft(draftBinding.current.key, value);
  }
  function settleDraft(input: Turn, rejected = false) {
    if (!mounted.current) return;
    const submitted = submittedDraft.current;
    const unchanged = submitted?.operationId === input.operationId && submitted.edit === draftEdits.current;
    const recoverable = restoredSubmission.current === input.operationId && draftEdits.current === 0 && !currentText.current;
    if (submitted?.operationId === input.operationId) submittedDraft.current = null;
    if (restoredSubmission.current === input.operationId) restoredSubmission.current = null;
    if (!unchanged && !(rejected && recoverable)) return;
    const value = rejected ? input.text : "";
    draftValue.current = rejected ? input.text : null;
    currentText.current = value;
    setText(value);
    keepDraft(draftBinding.current.key, draftValue.current);
  }
  const draftText = draftValue.current ?? "";
  useLayoutEffect(() => {
    const previous = draftBinding.current;
    if (previous.key !== draftKey) {
      const binding = previous.ownerId === ownerId && previous.draftScope === draftScope && previous.item === null && !!target.extensionId;
      const value = binding ? draftValue.current ?? readDraft(draftKey) : readDraft(draftKey);
      draftBinding.current = { key: draftKey, ownerId, draftScope, item: target.extensionId };
      draftValue.current = value;
      if (!binding) { submittedDraft.current = null; restoredSubmission.current = null; }
      if (keepDraft(draftKey, value) && binding) {
        drafts.delete(previous.key);
        try { sessionStorage.removeItem(previous.key); } catch { setDraftStorageUnavailable(true); }
      }
      if ((value ?? "") !== text) { draftEdits.current++; currentText.current = value ?? ""; setText(value ?? ""); }
      return;
    }
    keepDraft(draftKey, draftValue.current);
  }, [draftKey, text]);
  function extensionPath(id = extensionId.current) {
    if (!id) throw new Error("Choose an exact customization first");
    return "extensions/" + encodeURIComponent(id);
  }
  function authoringPath() { return extensionId.current ? "authoring?extensionId=" + encodeURIComponent(extensionId.current) : "authoring"; }
  async function readHostCatalog() {
    try {
      const next = await callbacks.current.request<HostCatalog>("extensions/catalog", "GET", undefined, authoringLifetime.current.signal);
      if (!Array.isArray(next.hooks) || typeof next.model?.dcm !== "string" || !next.model.dcm.trim() || typeof next.model.digest !== "string") throw new Error("Published host model unavailable");
      if (mounted.current) { setHostCatalog(next); setCatalogError(false); }
    } catch { if (mounted.current) setCatalogError(true); }
  }
  function retainTurn(value: Turn | null) {
    try {
      if (value) sessionStorage.setItem(recoveryKey, JSON.stringify(value));
      else sessionStorage.removeItem(recoveryKey);
    } catch { setRecoveryError("This browser could not save recovery information. Keep this page open until the submitted request is confirmed."); }
    setPendingTurn(value);
  }
  function deletedOutcome(failure: unknown, operationId: string) {
    const problem = failure as { status?: number; code?: string };
    if (problem?.status !== 410 || problem.code !== "CUSTOMIZATION_DELETED") return false;
    const key = recoveryKey;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (saved?.operationId === operationId) sessionStorage.removeItem(key);
    } catch { setRecoveryError("This browser could not clear the matching recovery entry. Returning to it will check the same saved outcome."); }
    setPendingTurn(old => old?.operationId === operationId ? null : old);
    deletedRef.current = true; setDeleted(true); setTrusted(false); setRetryTurn(false);
    setAuthoringError(""); setError(""); setConversation(null); setMessages([]); setState(null);
    return true;
  }
  function turnTarget(): TurnTarget {
    if (!extensionId.current) return { kind: "create" };
    return conversation && !staleConversation && !historyView && !conversation.retired ? { kind: "resume", extensionId: extensionId.current }
      : { kind: "revise", extensionId: extensionId.current, baseRevisionId: state?.draft?.id
        ?? (state?.selection.revision?.extensionId === extensionId.current ? state.selection.revision.id : null), selectionGeneration: state!.selection.generation };
  }
  const retired = state?.retired === true || conversation?.retired === true && !conversation.extensionId || retiredOperation;
  const workflowHost = !catalogError && ["TaskCreated", "TaskCompleted"].every(id => hostCatalog?.hooks.some(hook => hook.id === id));
  const workflowRevision = state?.draft ?? state?.selection.revision;
  const beforeCreate = state?.extension?.hookId === "TaskBeforeCreate";
  const trigger = !retired && (workflowHost || ["keir-dcm/2", "keir-dcm/3"].includes(workflowRevision?.pins.modelRef?.format ?? "") || beforeCreate || state?.extension?.hookId === "TaskCreated")
    ? taskTrigger(state?.extension?.hookId) : null;
  const { capabilities, taskFields } = hostFeatures(workflowHost ? hostCatalog : null);
  const conditions = Object.entries({ projectId: "project", title: "exact title", tags: "tags", priority: "priority", dueAt: "due date" })
    .filter(([field]) => capabilities.includes("tasks.get") && taskFields.includes(field)).map(([, label]) => label);
  if (capabilities.includes("tasks.openMatch")) conditions.push("whether a matching open task exists");
  const availableStarters = workflowStarters.filter(starter => hostCatalog?.hooks.some(hook => hook.id === starter.hook)
    && starter.capabilities.every(capability => capabilities.includes(capability)));
  const executionUnavailable = state?.executionAvailability?.available === false;
  const offer = conversation?.review;
  const eligibleOffer = !historyView && !!state && matchingOffer(conversation, state);
  const decisionEvidenceId = state?.draft ? (state.approved && state.approvedEvidenceId ? state.approvedEvidenceId
    : eligibleOffer ? offer!.evidenceId : state.evidence?.passed ? state.evidence.id : null) : null;
  const reviewKey = savedReview ? `${savedReview.owner.id}/${savedReview.extension.id}/${savedReview.revision.id}/${savedReview.draftVersion}/${savedReview.evidenceId}` : "";
  const ownActive = state?.selection.revision?.extensionId === state?.extension?.id ? state?.selection.revision : null;
  const currentUse = state?.selection.revision ? state.selection.eligible ? `“${state.selection.revision.extensionName}” is in use.`
    : "The saved setup could not be checked. Its use is unverified." : "No customization is in use.";
  const inspectionRevision = activeView ? ownActive : state?.draft ?? ownActive;
  const inspectionKey = inspectionRevision ? `${state!.owner.id}/${state!.extension!.id}/${inspectionRevision.id}/${inspectionRevision.suiteDigest ?? ""}` : "";
  const currentRevisionEvidence = !retired && !!state?.draft && evidence?.revisionId === state.draft.id;
  const latestCurrentEvidenceId = !retired && state?.draft && state.evidence?.revisionId === state.draft.id ? state.evidence.id : null;
  const currentEvidence = currentRevisionEvidence && (evidence?.id === latestCurrentEvidenceId || eligibleOffer && evidence?.id === offer?.evidenceId);
  const decisionObservationsKnown = !!reviewEvidence?.reports.length && reviewEvidence.reports.every(item => item.report.status === "PASS" && checkedObservation(item));
  const viewedEvidenceEligible = !!savedReview && !!state && (savedProofEligible(state, savedReview.evidenceId)
    || eligibleOffer && offer?.evidenceId === savedReview.evidenceId);
  const viewedDraft = !!state && !!savedReview && trusted && sameReviewDraft(state, savedReview);
  const viewedCurrent = !retired && viewedDraft && viewedEvidenceEligible;
  const canReview = viewedCurrent && !reviewLoading && reviewEvidence?.id === savedReview?.evidenceId
    && reviewEvidence?.revisionId === savedReview?.revision.id && reviewEvidence?.passed && decisionObservationsKnown;
  const activeAuthoring = running(conversation);
  const staleConversation = !!conversation && !!state?.extension && (conversation.extensionId !== state.extension.id
    || conversation.draft.draftVersion !== state.draftVersion || conversation.draft.revisionId !== (state.draft?.id ?? null)
    || conversation.draft.suiteDigest !== (state.draft?.suiteDigest ?? null));
  const contextRecovery = (conversation?.status === "BLOCKED" && conversation.code === "CONTEXT_LIMIT"
    || !!contextContinuation && contextContinuation.conversationId === conversation?.id)
    && !staleConversation && !historyView;
  const earlierMessagesFailed = messagePageError?.scope === messageHistory.current?.scope && messagePageError?.before === messagesBefore;
  const disabled = !!busy || !trusted || activeAuthoring || !!pendingTurn;
  const sendDisabled = retired || disabled || historyView || activeView;
  const reviewReady = !!savedReview && (savedReview.revision.kind !== "authored" || !!reviewSource && reviewSource.key === review
    && reviewSource.ownerId === savedReview.owner.id && reviewSource.revisionId === savedReview.revision.id && reviewSource.suiteDigest === savedReview.suiteDigest);
  const reviewedApproved = viewedCurrent && !!state?.approved && state.approvedEvidenceId === savedReview?.evidenceId && review === reviewKey;
  const reviewAllowed = !retired && !!decisionEvidenceId && !!state?.draft && !disabled && !staleConversation && !historyView
    && !contextRecovery && !restart;
  const showSavedBehavior = !retired && !!state?.draft && !historyView && !restart;
  const inlineAvailable = showSavedBehavior && !staleConversation && !contextRecovery;
  const failedEvidenceId = state?.evidence && !state.evidence.passed && state.evidence.revisionId === state.draft?.id ? state.evidence.id : null;
  const viewingCurrentFailure = viewedDraft && !!failedEvidenceId && savedReview?.evidenceId === failedEvidenceId;
  const newerEvidenceId = state?.evidence?.passed && state.evidence.id !== savedReview?.evidenceId ? state.evidence.id : null;
  const latestReviewAvailable = !!savedReview && (!viewedCurrent || !!newerEvidenceId);
  const viewedInUse = !!savedReview && trusted && state?.owner.id === savedReview.owner.id && state.extension?.id === savedReview.extension.id
    && state.selection.eligible && state.selection.revision?.id === savedReview.revision.id
    && state.selection.approvedEvidenceId === savedReview.evidenceId;
  const reviewActionDisabled = disabled || !inlineOpen || reviewOpen || !canReview || !reviewReady || review !== reviewKey || !reviewAllowed;
  const exampleLabel = (item: Evidence["reports"][number], index: number) => {
    if (guardCase(item)) return typeof item.label === "string" && item.label.trim() && item.label.trim() !== item.id ? item.label : "New task example " + (index + 1);
    const task = item.report.scenario?.task;
    if (!knownScenarioTask(task)) return "Earlier saved example " + (index + 1);
    if (task!.title !== "Example task") return task!.title;
    if (task!.status === "COMPLETED" || task!.status === "OPEN")
      return (task!.status === "COMPLETED" ? "Completed task" : "Unfinished task") + (task!.projectName ? ` in “${task!.projectName}”` : "");
    const code = item.report.native?.error?.code;
    return code === "TASK_NOT_FOUND" ? "Missing task" : code === "ACCESS_DENIED" ? "Task access unavailable"
      : code === "ADAPTER_TRANSIENT" ? "Task temporarily unavailable" : "Task details unavailable";
  };
  const exampleTitle = (item: Evidence["reports"][number], index: number) => "Saved example: " + exampleLabel(item, index);
  const mainExample = reviewEvidence?.reports.find(item => reviewEvidence.summary?.cases.some(row => row.id === item.id
    && row.verification === "matched" && row.outcome === "changed")) ?? reviewEvidence?.reports[0];
  const summaryItem = showSavedBehavior && trusted && state?.draft?.kind === "authored" ? state.extension?.id : undefined;
  const summaryRevision = summaryItem ? state?.draft?.id : undefined;
  const summarySuite = state?.draft?.suiteDigest ?? null;
  const summaryDigest = state?.draft?.pins.artifactDigest;
  const summarySourceDigest = state?.draft?.pins.rawSourceDigest;
  const summaryPins = state?.draft?.pins;
  const summaryKey = summaryItem && summaryRevision && summaryDigest
    ? JSON.stringify([ownerId, summaryItem, summaryRevision, summarySuite, summaryPins]) : "";
  const summaryPending = !!summaryKey && ruleAction?.key !== summaryKey;
  const summarized = ruleAction?.key === summaryKey ? ruleAction.description : null;
  const workflowSummary = summarized && summarized.hook === state?.extension?.hookId && summarized.action
    ? { ...summarized.action, conditions: summarized.conditions } : null;
  const displayedRule = describeRule(summarized, id => projects.find(project => project.id === id)?.name);
  const behaviorSummary = summarizeExamples(reviewEvidence);
  const activeSelectionMatches = !!activeSnapshot && activeSnapshot.ownerId === state?.owner.id && activeSnapshot.extensionId === state.extension?.id
    && activeSnapshot.revision.id === state.selection.revision?.id && activeSnapshot.generation === state.selection.generation
    && activeSnapshot.evidenceId === state.selection.approvedEvidenceId;
  const checkedDraftSummary = canReview && reviewReady && review === reviewKey ? behaviorSummary : "";
  const checkedActiveSummary = activeProof && activeSelectionMatches && state?.selection.eligible ? summarizeExamples(activeProof) : "";

  function projectName(projectId?: string) { return projects.find(project => project.id === projectId)?.name; }
  const fullWorkflowSummary = displayedRule?.complete === true;
  function checkedGuardExample(item: CheckedCase, index: number, facts?: CaseSummary) {
    const proposal = item.report.scenario?.proposal;
    const expected = guardConsumption(item.expected.consumption), observed = guardConsumption(item.report.consumption);
    const matches = facts?.verification === "matched" && item.report.status === "PASS" && checkedObservation(item);
    const unavailable = !observed || observed.status === "BLOCKED";
    const simulatedFailure = matches && observed?.status === "BLOCKED" && facts?.simulatedFailure === "invalid-host-context";
    const label = simulatedFailure ? "Safety check: required check unavailable" : exampleLabel(item, index);
    function outcome(result: GuardConsumption | null) {
      return <><p>{guardResultLabel(result)}</p>{result?.status === "DENIED"
        ? <p>{result.result.message.trim() ? result.result.message : "This sample task does not meet the rule."}</p>
        : <p>{result?.status === "ALLOWED" ? "The app may continue its normal permission, validation and save checks."
          : result?.status === "BLOCKED" ? simulatedFailure
            ? "The rule did not run. The app stopped saving instead of bypassing the required check. No example task was added."
            : "The app could not get a valid decision from the required check, so saving was stopped. This does not show whether the task meets the rule."
            : "The saved result could not be verified. This example does not establish whether normal save checks could continue."}</p>}</>;
    }
    return <article className="rs-example rs-workflow-case rs-guard-case" key={item.id} aria-label={`Example: ${label}`}>
      <h4>{label}</h4>
      <dl>
        <div><dt>Situation</dt><dd>{simulatedFailure && <p>This example deliberately makes the app unable to verify that the check is authorized to run.</p>}{knownProposal(proposal) ? <>
          <p>New task in {projectName(proposal!.projectId) ? `“${projectName(proposal!.projectId)}”` : "the chosen project"}.</p>
          <p>{priorityLabel(proposal!.priority)} priority · {proposal!.tags.length ? `Tags ${proposal!.tags.join(", ")}` : "No tags"}
            {` · ${proposal!.hasNotes ? "Notes present" : "No notes"} · ${proposal!.hasDueDate ? "Due date present" : "No due date"}`}</p>
        </> : "The proposed task details could not be checked."}</dd></div>
        <div><dt>Expected</dt><dd>{matches ? <details><summary>Expected behavior</summary>{outcome(expected)}</details> : outcome(expected)}</dd></div>
        <div><dt>What happened</dt><dd>{outcome(observed)}</dd></div>
        <div><dt>Result</dt><dd><p className={matches ? "rs-match" : "rs-mismatch"}>{matches ? unavailable ? "Saving stopped as expected" : "Matches" : "Needs another check"}</p></dd></div>
      </dl>
    </article>;
  }
  function checkedWorkflowExample(item: CheckedCase, index: number, compact: boolean, facts?: CaseSummary) {
    const { scenario, observed, calls, native } = item.report;
    const task = scenario?.task;
    const successfulCalls = native?.trace?.filter(event => event.event === "CALL_SUCCEEDED") ?? [];
    const successfulLookups = new Set(successfulCalls.filter(event => event.capability === "tasks.openMatch").map(event => event.step));
    let matchIndex = 0;
    const openChecks = calls?.filter(call => call.capability === "tasks.openMatch").map(call => {
      const saved = call.step && successfulLookups.has(call.step) ? scenario?.openMatches?.[matchIndex++] : undefined;
      const matches = saved && saved.title === call.args?.title && saved.projectId === call.args?.projectId ? saved.matches : undefined;
      return { step: call.step, title: call.args?.title, projectId: call.args?.projectId, project: projectName(call.args?.projectId), matches };
    }) ?? [];
    const readUnavailable = observed?.effect === "NONE" && !!native?.error && ["tasks.get", "tasks.openMatch"].includes(calls?.at(-1)?.capability ?? "");
    const readMessage = native?.error?.code === "TASK_NOT_FOUND" ? "The task could not be found."
      : native?.error?.code === "ACCESS_DENIED" ? "The task could not be checked because access was denied."
      : native?.error?.code === "ADAPTER_TRANSIENT" ? "The task was temporarily unavailable." : "Could not check the triggering task.";
    const openUnavailable = openChecks.some(check => check.matches === undefined);
    const unknown = observed?.effect === "UNKNOWN";
    const failed = ["FAIL", "MISMATCH"].includes(item.report.status);
    const passed = item.report.status === "PASS";
    const expected = item.expected;
    const currentRule = compact && reviewEvidence?.revisionId === summaryRevision ? workflowSummary : null;
    const uncertainWrite = unknown && currentRule?.capability === "tasks.update" && currentRule.step
      && calls?.at(-1)?.capability === currentRule.capability && calls?.at(-1)?.step === currentRule.step;
    const uncertainFields = uncertainWrite ? Object.keys(currentRule.fields).filter(field => field !== "taskId") : [];
    const uncertainField = uncertainFields.length === 1 ? ({ priority: "priority", dueAt: "due date", addTag: "tags" } as Record<string, string>)[uncertainFields[0]] : undefined;
    const uncertainMessage = uncertainField ? `We could not confirm whether the ${uncertainField} changed.`
      : "We could not confirm whether the change happened.";
    const guardSkippedWrite = currentRule && native?.classification === "COMPLETED" && observed?.effect === "NONE"
      && native.trace?.some(event => event.event === "GUARD_EVALUATED" && event.step === currentRule.step && event.taken === false);
    const taskRead = calls?.find(call => call.capability === "tasks.get" && call.args?.taskId === task?.id
      && successfulCalls.some(event => event.capability === call.capability && event.step === call.step));
    const blockingLookup = guardSkippedWrite ? openChecks.find(check => check.matches === true && currentRule.conditions?.some(fact =>
      fact.field === "noOpenMatch" && fact.step === check.step && fact.projectId === check.projectId && fact.title === check.title)) : undefined;
    let noChangeReason;
    if (guardSkippedWrite && taskRead?.step && task?.status) {
      const taskFacts = currentRule.conditions?.filter(fact => fact.step === taskRead.step) ?? [];
      for (const fact of taskFacts) {
        if (fact.field === "dueAbsent" && task.dueAt) { noChangeReason = "This task already has a due date."; break; }
        if (fact.field === "status" && fact.value === "COMPLETED" && task.status !== "COMPLETED") { noChangeReason = "This task isn’t completed."; break; }
        if (fact.field === "title" && fact.value && task.title !== fact.value) { noChangeReason = `This task’s title isn’t exactly “${fact.value}”.`; break; }
        if (fact.field === "priority" && fact.value && task.priority && task.priority !== fact.value) { noChangeReason = `The rule requires ${priorityLabel(fact.value)} priority.`; break; }
        if (fact.field === "tag" && fact.value && Array.isArray(task.tags) && !task.tags.includes(fact.value)) { noChangeReason = `This task doesn’t have the tag “${fact.value}”.`; break; }
        const requiredProject = fact.field === "projectId" && task.projectId && task.projectId !== fact.value && projectName(fact.value);
        if (requiredProject) { noChangeReason = `This task isn’t in “${requiredProject}”.`; break; }
      }
    }
    const expectedCreate = expected.createdTasks?.[0], observedCreate = observed?.createdTasks?.[0];
    const createdProject = (task: TaskPreview | undefined) => task?.projectName || projectName(task?.projectId);
    const differentProject = !!expectedCreate?.projectId && !!observedCreate?.projectId && expectedCreate.projectId !== observedCreate.projectId;
    const sameName = differentProject && createdProject(expectedCreate) === createdProject(observedCreate);
    function effects(value: Pick<CheckedCase["expected"], "createdTasks" | "updatedTasks">, actual: boolean) {
      const created = value.createdTasks, updated = value.updatedTasks;
      if (created === null && updated === null) return actual ? uncertainMessage : "The change may or may not happen.";
      if (!Array.isArray(created) || !Array.isArray(updated)) return "Task changes were not recorded.";
      if (!created.length && !updated.length) return "No change.";
      return [...created.map(result => {
        const project = createdProject(result), role = actual ? "different" : "expected";
        const destination = sameName ? project ? `“${project}” (the ${role} example project)` : `the ${role} example project`
          : project ? `“${project}”` : "an unnamed project";
        const details = taskDetails(result);
        return `${actual ? "Created" : "Create"} “${result.title}” in ${destination}.${details ? ` ${details}.` : ""}`;
      }), ...updated.map(result => actual ? confirmedUpdate(result, task) : expectedUpdate(result))].join(" ");
    }
    const title = knownScenarioTask(task) ? `“${task!.title}”` : exampleLabel(item, index);
    const project = task?.projectName || projectName(task?.projectId);
    const taskReadUnavailable = readUnavailable && calls?.at(-1)?.capability === "tasks.get";
    const absentDueRule = currentRule?.conditions?.some(fact => fact.field === "dueAbsent" && fact.step === taskRead?.step);
    const addedTask = scenario?.hookId === "TaskCreated" || currentRule && summarized?.hook === "TaskCreated";
    const anotherProject = addedTask && currentRule?.conditions !== undefined && !currentRule.conditions.some(fact => fact.field === "projectId")
      && task?.projectId && mainExample?.report.scenario?.task?.projectId && task.projectId !== mainExample.report.scenario.task.projectId;
    const situation = taskReadUnavailable ? native?.error?.code === "ADAPTER_TRANSIENT" ? "Task details temporarily unavailable" : readMessage
      : absentDueRule && task?.dueAt ? "Task already has a due date"
      : anotherProject ? "New task in another project"
      : absentDueRule && addedTask && !task?.dueAt ? "New task without a due date"
      : noChangeReason ? noChangeReason.replace(/\.$/, "")
      : taskRead ? `${addedTask ? "New task" : task?.status === "COMPLETED" ? "Task completed" : "Task is still unfinished"}${project ? ` in ${project}` : ""}`
      : exampleLabel(item, index);
    const unavailable = readUnavailable || openUnavailable || observed?.effect === "NOT_OBSERVED" || !observed;
    const dueInOutput = [expected.createdTasks, expected.updatedTasks, observed?.createdTasks, observed?.updatedTasks]
      .some(tasks => tasks?.some(entry => !!entry.dueAt));
    const changedFields = Object.keys(observed?.updatedTasks?.[0] ?? {}).filter(field => field !== "id");
    const result = facts ? ({ changed: observed?.createdTasks?.length ? "Task created as intended"
      : changedFields.length === 1 ? ({ dueAt: task?.dueAt ? "Due date changed as intended" : "Due date added as intended", priority: "Priority changed as intended", addTag: "Tag added as intended" } as Record<string, string>)[changedFields[0]] ?? "Changed as intended" : "Changed as intended",
      unchanged: absentDueRule && task?.dueAt ? "Existing date kept" : "Left unchanged as intended",
      "handled-problem": readUnavailable ? "No change when task details were unavailable—as intended" : "Problem handled as intended", uncertain: "Change not confirmed",
      unchecked: "We could not finish checking", mismatch: "Different from what we wanted" }[facts.outcome]) : "Example summary unavailable";
    const matched = facts?.verification === "matched";
    const body = <>
      <dl>
        <div><dt>Situation</dt><dd>{title}{project && ` in “${project}”`}{task?.status && ` · ${task.status === "COMPLETED" ? "Completed" : "Unfinished"}`}
          {dueInOutput && scenario?.occurredAt && ` · Event ${utc(scenario.occurredAt)}`}{task && taskDetails(task) && ` · ${taskDetails(task)}`}</dd></div>
        <div><dt>What we wanted</dt><dd>{effects(expected, false)}</dd></div>
        <div><dt>What happened</dt><dd>
          {openChecks.map((check, index) => <p key={index}>Open-task check{check.title ? ` for the exact title “${check.title}”` : ""} {check.project ? `in “${check.project}”` : "in the chosen project"}. {check === blockingLookup ? `${currentRule?.capability === "tasks.create" ? "No task was created" : "No change"} because an open task matched.` : check.matches === true ? "A matching open task was found." : check.matches === false ? "No matching open task was found." : "Could not check for a matching open task."}</p>)}
          {taskReadUnavailable && <p>{readMessage}</p>}
          {!blockingLookup && <p>{observed?.effect === "NOT_OBSERVED" || !observed ? "The simulation did not establish a write outcome."
            : observed.effect === "NONE" && native?.error && ["tasks.create", "tasks.update"].includes(calls?.at(-1)?.capability ?? "") ? "No change. The write could not be applied."
            : noChangeReason ? `No change. ${noChangeReason}` : effects(observed, true)}</p>}
          {differentProject && <p>The created task used a different project than expected.</p>}
        </dd></div>
        {!compact && <div><dt>Result</dt><dd>
          <p className={facts?.verification === "mismatched" ? "rs-mismatch" : matched && !unknown ? "rs-match" : undefined}>{result}</p>
          {facts?.verification === "mismatched" && <p className="rs-mismatch">The observed result did not match what was wanted.</p>}
          {matched && readUnavailable && <p>The example deliberately made the read unavailable. The check finished and matched the expected no-change result.</p>}
        </dd></div>}
      </dl>
      {compact && matched && readUnavailable && <p>This problem was deliberately simulated. The task stayed unchanged, as intended.</p>}
      {unknown && <p>The task may have changed. Check before trying again.</p>}
      {compact && failed && viewingCurrentFailure && <button type="button" className="rs-link" disabled={sendDisabled || !authoring?.availability.available}
        onClick={() => document.getElementById("studio-message")?.focus()}>Describe a correction</button>}
    </>;
    return <article className="rs-example rs-workflow-case" key={item.id} aria-label={"Example: " + situation}>
      {compact ? <details className="rs-case-disclosure" open={facts?.verification === "mismatched" || facts?.outcome === "uncertain" || undefined}>
        <summary><span>{situation}</span><span className={facts?.verification === "mismatched" ? "rs-mismatch" : matched && !unknown ? "rs-match" : ""}>{result}</span></summary>
        {body}
      </details> : body}
    </article>;
  }

  function beforeAfter(proof: Evidence) {
    const item = proof.reports.find(item => proof.summary?.cases.some(row => row.id === item.id && row.verification === "matched" && row.outcome === "changed"));
    const before = item?.report.scenario?.task, observed = item?.report.observed;
    if (!item || !before || !knownScenarioTask(before) || observed?.effect !== "CONFIRMED") return null;
    const created = observed.createdTasks?.[0];
    const update = observed.updatedTasks?.find(update => update.id === before.id);
    const after = created ?? (update ? { ...before, ...update,
      ...(update.addTag && Array.isArray(before.tags) && { tags: [...new Set([...before.tags, update.addTag])] }) } : null);
    if (!after) return null;
    const date = (value: string) => Number.isFinite(Date.parse(value))
      ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " UTC" : value;
    const recorded = (task: TaskPreview, key: keyof TaskPreview) => Object.hasOwn(task, key) && task[key] !== undefined;
    const fields: { key: keyof TaskPreview; label: string; value: (task: TaskPreview) => string }[] = [
      { key: "dueAt", label: "Due date", value: task => task.dueAt ? date(task.dueAt) : "None" },
      { key: "priority", label: "Priority", value: task => priorityLabel(task.priority!) },
      { key: "tags", label: "Tags", value: task => task.tags?.join(", ") || "None" },
      { key: "notes", label: "Notes", value: task => task.notes || "Empty" },
      { key: "status", label: "Status", value: task => task.status === "COMPLETED" ? "Completed" : "Unfinished" },
    ];
    // Creation records describe a different task, not changes to the triggering task.
    // For an update, compare only fields established by the recorded write.
    const changed = fields.filter(field => created ? recorded(created, field.key)
      : (Object.hasOwn(update!, field.key) || field.key === "tags" && update!.addTag && Array.isArray(before.tags))
        && (!recorded(before, field.key) || JSON.stringify(before[field.key]) !== JSON.stringify(after[field.key])));
    const partialTags = !created && update?.addTag && !Array.isArray(before.tags);
    const event = item.report.scenario?.hookId ?? (proof.revisionId === summaryRevision ? summarized?.hook : undefined);
    return <section className="rs-before-after" aria-label={created ? "Triggering task and created example" : "Example task before and after"}>
      <div className="rs-task-pair">{([before, after] as TaskPreview[]).map((task, index) => <article key={index} className={index ? "rs-task-after" : ""}>
        <p className="rs-kicker">{index ? created ? "Created example task" : "After this change" : created ? "Triggering example task" : "Before this change"}</p>
        <h4>{task.title}</h4><p className="muted">{task.projectName || projectName(task.projectId) || "Example project (name unavailable)"}</p>
        {(!created || index === 1) && changed.map(field => <p className="rs-changed-field" key={field.key}>{field.label}: <strong>{recorded(task, field.key) ? field.value(task) : "Starting value not recorded"}</strong></p>)}
        {index === 1 && partialTags && <p className="rs-changed-field">Added tag: <strong>{update!.addTag}</strong><br />Starting tags were not recorded; the complete resulting tag list is unknown.</p>}
        {index === 1 && created && <p className="muted">Only the values recorded in this example are shown. Other task details were not checked here.</p>}
        {index === 1 && update && !created && <p className="muted">Other task details stayed the same.</p>}
        {!index && item.report.scenario?.occurredAt && <p className="muted">{event === "TaskCreated" ? "Added" : event === "TaskCompleted" ? "Completed" : "Event"}: {date(item.report.scenario.occurredAt)}</p>}
        <details><summary>All example task details</summary><p>{taskDetails(task) || "No additional task details were recorded."}</p></details>
      </article>)}</div>
    </section>;
  }

  function simulationLimits(proof: Evidence) {
    const matched = proof.reports.filter(item => proof.summary?.cases.some(row => row.id === item.id && row.verification === "matched"));
    const codes = new Set(matched.map(item => item.report.native?.error?.code));
    const uncovered = [!codes.has("TASK_NOT_FOUND") && "a missing task", !codes.has("ACCESS_DENIED") && "denied access",
      !matched.some(item => item.report.observed?.effect === "NONE" && item.report.native?.error && ["tasks.create", "tasks.update"].includes(item.report.calls?.at(-1)?.capability ?? "")) && "a rejected change",
      !matched.some(item => item.report.observed?.effect === "UNKNOWN") && "a change whose result cannot be confirmed"].filter(Boolean) as string[];
    return <p className="rs-coverage"><strong>Not covered by this simulation</strong><br />{uncovered.length
      ? `These examples do not cover ${new Intl.ListFormat("en").format(uncovered)}.` : "Only the situations listed here were simulated. Other inputs and problems may behave differently."}
      {displayedRule?.timing && " They do not show whether this fixed elapsed duration fits your needs around clock changes."}</p>;
  }
  function exampleOverview(proof: Evidence) {
    const summary = proof.summary;
    if (!summary) return <p>The example summary could not be confirmed. Exact results remain available in the details.</p>;
    const counts = summary.counts.outcome;
    const parts = [counts.changed && `${counts.changed} changed a task as intended`, counts.unchanged && `${counts.unchanged} left it unchanged as intended`,
      counts["handled-problem"] && `${counts["handled-problem"]} handled a simulated problem as intended`,
      counts.mismatch && `${counts.mismatch} differed from what was wanted`, counts.uncertain && `${counts.uncertain} left a change unconfirmed`,
      counts.unchecked && `${counts.unchecked} could not be checked`].filter(Boolean) as string[];
    return <p className="rs-example-overview">{beforeCreate ? `${summary.counts.verification.matched} example decisions matched their expectations. ${summarizeExamples(proof)}.`
      : `Of the ${summary.returnedCases} examples shown, ${new Intl.ListFormat("en").format(parts)}.`}
      {summary.truncated && ` This summary is limited; ${summary.totalCases} examples were recorded. Inspect the full results for the rest.`}</p>;
  }
  function checkedExample(item: Evidence["reports"][number], index: number, compact = false, proof: Evidence | null = evidence) {
    const facts = proof?.reports.includes(item) ? proof.summary?.cases.find(row => row.id === item.id) : undefined;
    if (guardCase(item)) return checkedGuardExample(item, index, facts);
    if (workflowCase(item)) return checkedWorkflowExample(item, index, compact, facts);
    const source = item.report.scenario?.task, observed = knownObservation(item.report.observed), expected = knownTasks(item.expected.createdTasks);
    const readFailure = observed && item.report.observed?.effect === "NONE" && Array.isArray(item.report.calls)
      && item.report.calls.at(-1)?.capability === "tasks.get" ? item.report.native?.error?.code : undefined;
    const readExplanation = readFailure === "TASK_NOT_FOUND" ? " The task could not be found."
      : readFailure === "ACCESS_DENIED" ? " The task could not be checked because access was denied."
      : readFailure === "ADAPTER_TRANSIENT" ? " The task was temporarily unavailable." : "";
    const wanted = item.expected.createdTasks?.[0], actual = item.report.observed?.createdTasks?.[0];
    const differentProject = expected && observed && item.report.observed?.effect === "CONFIRMED"
      && item.expected.createdTasks?.length === 1 && item.report.observed.createdTasks?.length === 1
      && !!wanted?.projectId && !!actual?.projectId && wanted.projectId !== actual.projectId;
    function projectLabel(task: TaskPreview | undefined, label: string) {
      if (!differentProject) return undefined;
      if (!task?.projectName || task.projectName === "Example project") return `the ${label} example project`;
      return wanted?.projectName === actual?.projectName ? `“${task.projectName}” (the ${label} project)` : undefined;
    }
    const wantedProject = projectLabel(wanted, "expected"), actualProject = projectLabel(actual, "different");
    if (compact) {
      const failed = item.report.status === "FAIL" || item.report.status === "MISMATCH";
      const uncertain = item.report.observed?.effect === "UNKNOWN";
      const matchesUncertainty = !failed && item.report.status === "PASS" && checkedUncertainty(item);
      const matches = !failed && item.report.status === "PASS" && checkedObservation(item);
      const situation = source?.status === "COMPLETED" ? `Task completed${source.projectName ? ` in ${source.projectName}` : ""}`
        : source?.status === "OPEN" ? "Task is still unfinished" : readExplanation.trim() || "Task situation wasn’t recorded";
      const outcomes = [...(expected ? item.expected.createdTasks! : []), ...(observed ? item.report.observed!.createdTasks! : [])];
      const outcomeProject = (task: TaskPreview) => {
        const name = task.projectName && task.projectName !== "Example project" ? `“${task.projectName}”` : "";
        const shared = [...new Set(outcomes.filter(other => (other.projectName || "Example project") === (task.projectName || "Example project")).map(other => other.projectId))];
        const label = shared.length > 1 ? `sample project ${shared.indexOf(task.projectId) + 1}` : "the sample project";
        return name ? shared.length > 1 ? `${name} (${label})` : name : `${label} (name unavailable)`;
      };
      const stage = item.report.mismatches?.find(mismatch => Object.hasOwn(mismatchReason, mismatch.stage ?? ""))?.stage;
      const reason = stage ? mismatchReason[stage as keyof typeof mismatchReason] : undefined;
      return <article className="rs-example rs-compact-case" key={item.id} aria-label={"Example: " + situation}
        data-result={failed ? "mismatch" : uncertain ? "unknown" : matches ? "match" : "unavailable"}>
        <div className="rs-compact-situation"><strong>{situation}</strong>
          {source?.status && knownScenarioTask(source) && <small>Sample task: “{source.title}”{source.projectName && source.status !== "COMPLETED" && ` · ${source.projectName}`}</small>}
        </div>
        <span className="rs-example-result">{failed ? stage === "STUB" && !observed && !uncertain ? "Could not check this example" : "Needs correction"
          : matchesUncertainty ? "Matches the expected uncertainty. Task creation is not confirmed."
          : matches ? "Matches" : uncertain ? "Unknown" : "Result unavailable"}</span>
        <dl><div><dt>What happened</dt><dd>{failed && !observed && !uncertain ? "This check couldn’t verify whether a task was created."
          : observedTasks(item.report.observed, actualProject ?? outcomeProject)}{differentProject && " The created task used a different project than expected."}</dd></div>
          {(failed || matchesUncertainty) && <div><dt>Expected</dt><dd>{expectedTasks(item.expected, wantedProject ?? outcomeProject)}</dd></div>}
          {failed && <div><dt>This example needs a correction</dt><dd>{reason ?? "The saved check did not pass."}</dd></div>}
        </dl>
        {failed && viewingCurrentFailure && <button type="button" className="rs-link rs-case-correction" disabled={sendDisabled || !authoring?.availability.available}
          onClick={() => document.getElementById("studio-message")?.focus()}>Describe a correction</button>}
      </article>;
    }
    return <article className="rs-example" key={item.id} aria-label={"Example: " + exampleLabel(item, index)}>
      {knownScenarioTask(source) ? <div className="rs-example-task"><span className="rs-task-mark" aria-hidden="true">{source!.status === "COMPLETED" ? "✓" : "○"}</span><div><small>Example task · {source!.projectName ?? (source!.projectId ? "Example project" : "Project not observed")}</small><h4>{source!.title}</h4><p>{source!.status === "COMPLETED" ? "Completed" : source!.status === "OPEN" ? "Unfinished" : "Status not recorded"}</p></div></div>
        : <p>Earlier saved example · the task situation was not recorded in this format.</p>}
      <dl><div><dt>You wanted</dt><dd>{expectedTasks(item.expected, wantedProject)}</dd></div><div><dt>What happened in the example</dt><dd>{observedTasks(item.report.observed, actualProject)}{readExplanation} {differentProject && <strong>The created task used a different project than expected.</strong>}</dd></div></dl>
      {observed && item.report.observed?.effect === "CONFIRMED" && item.report.observed.createdTasks?.map((task, taskIndex) => <div className="rs-created-example" key={taskIndex}><small>Example created task</small><strong>{task.title}</strong><p>{actualProject ?? task.projectName ?? "Example project"}</p></div>)}
      <p className={observed && expected && item.report.status === "PASS" ? "rs-match" : "rs-mismatch"}>{checkedUncertainty(item) && item.report.status === "PASS" ? "Matches the expected uncertainty. Task creation is not confirmed." : !observed ? "Task creation was not confirmed in this example" : !expected ? "The expected result was not recorded" : item.report.status === "PASS" ? "Matches what you wanted" : "This example needs a correction"}</p>
    </article>;
  }
  async function compareCurrent(selection: State["selection"], intent: number) {
    setComparison(null); setComparisonError("Checking the saved examples for what’s in use…");
    const selected = selection.revision, id = extensionId.current;
    const current = () => mounted.current && !authoringLifetime.current.signal.aborted && viewIntent.current === intent && currentPane.current.open && extensionId.current === id;
    if (!selected || !selection.eligible || !selection.approvedEvidenceId || !id) {
      setComparisonError(selected ? "No verified task examples are available for what’s in use." : "No customization is currently in use."); return;
    }
    try {
      const proof = await callbacks.current.request<Evidence>(`${extensionPath(selected.extensionId)}/evidence/${encodeURIComponent(selection.approvedEvidenceId)}`, "GET", undefined, authoringLifetime.current.signal);
      if (!current()) return;
      const latest = await callbacks.current.request<State>(extensionPath(id), "GET", undefined, authoringLifetime.current.signal);
      if (!current()) return;
      if (latest.owner.id !== ownerId || latest.extension?.id !== id) throw new Error("Comparison owner mismatch");
      if (latest.selection.revision?.id !== selected.id || latest.selection.generation !== selection.generation || latest.selection.approvedEvidenceId !== selection.approvedEvidenceId || !latest.selection.eligible) {
        apply(latest); setComparisonError("What’s in use changed while checking. Reopen the examples to compare it again."); return;
      }
      if (proof.id !== selection.approvedEvidenceId || proof.revisionId !== selected.id || !proof.passed || !proof.reports.length
        || !proof.reports.every(item => item.report.status === "PASS" && checkedObservation(item))) throw new Error("Unverified comparison");
      setComparison({ selection: structuredClone(selection), proof }); setComparisonError("");
    } catch { if (current()) setComparisonError("The saved task examples for what’s in use could not be verified. No current behavior is inferred."); }
  }
  function currentProofExample(proposed: Evidence["reports"][number]) {
    const selected = state?.selection;
    if (!comparison && !selected?.revision) return <p className="rs-no-current-proof">No customization is currently in use.</p>;
    const sameSelection = !!state && comparison && comparison.selection.revision?.id === state.selection.revision?.id && comparison.selection.generation === state.selection.generation
      && comparison.selection.approvedEvidenceId === state.selection.approvedEvidenceId && state.selection.eligible;
    const matching = comparison?.proof.reports.find(item => JSON.stringify(item.report.scenario?.task) === JSON.stringify(proposed.report.scenario?.task));
    return <section aria-label="Checked behavior currently in use"><h4>{comparison && !sameSelection ? "Earlier version viewed in use" : "Currently in use"}</h4>
      {comparison ? matching ? checkedExample(matching, comparison.proof.reports.indexOf(matching), false, comparison.proof) : <><p>No saved check covers this same task situation.</p><details><summary>Last checked examples for this version</summary>{comparison.proof.reports.map((item, index) => checkedExample(item, index, false, comparison.proof))}</details></>
        : <p role="status">{comparisonError}</p>}
      {comparison && !sameSelection && <p>What’s in use changed. These are the original saved examples; reopen to check the current selection.</p>}
    </section>;
  }

  function openPane(next?: typeof canvasView, invoker = document.activeElement) {
    developerTools.current?.removeAttribute("open");
    const intent = ++viewIntent.current, focus = ++focusIntent.current;
    currentPane.current = { open: true, view: next ?? canvasView };
    if (next) setReviewLoading(false);
    ++readingRevision.current;
    if (next && managementReturn.current?.view === next) canvasScroll.current = managementReturn.current.position;
    else if (next && next !== canvasView) canvasScroll.current = 0;
    if (next) managementReturn.current = null;
    const position = canvasScroll.current;
    if (!reviewOpen || invoker instanceof HTMLElement && invoker.closest(".rs-chat")) {
      reviewInvoker.current = invoker instanceof HTMLElement ? invoker : null;
      conversationReturn.current = conversationScroller()?.scrollTop ?? 0;
      followConversation.current = false;
    }
    if (next) setCanvasView(next);
    setReviewOpen(true); setPane("preview");
    requestAnimationFrame(() => {
      if (!mounted.current || viewIntent.current !== intent || focusIntent.current !== focus) return;
      if (next !== "details") room.current?.querySelector<HTMLElement>(next === "results" ? "#studio-results-heading" : "#studio-canvas")?.focus({ preventScroll: true });
      if (canvas.current) canvas.current.scrollTop = position;
      canvasScroll.current = position;
    });
    return intent;
  }
  function closeReview() {
    developerTools.current?.removeAttribute("open");
    const intent = ++viewIntent.current, focus = ++focusIntent.current;
    currentPane.current = { ...currentPane.current, open: false };
    ++reviewLoad.current; setReviewLoading(false);
    setActiveView(false);
    readingRevision.current++;
    if (canvas.current) canvasScroll.current = canvas.current.scrollTop;
    setReviewOpen(false); setPane("conversation");
    requestAnimationFrame(() => {
      if (!mounted.current || viewIntent.current !== intent || focusIntent.current !== focus) return;
      const target = reviewInvoker.current;
      const savedTurn = evidenceReturn.current ? room.current?.querySelector<HTMLElement>(`[data-evidence-link="${CSS.escape(evidenceReturn.current)}"]`) : null;
      const log = conversationScroller(); if (log) log.scrollTop = conversationReturn.current;
      (target?.isConnected && target.closest(".read-studio") === room.current?.closest(".read-studio") && target.getClientRects().length
        ? target : savedTurn ?? room.current?.querySelector<HTMLElement>("#studio-message"))?.focus({ preventScroll: true });
    });
  }
  useEffect(() => {
    if (activeView && activeSnapshot && (!activeSelectionMatches || !state?.selection.eligible)) {
      setActiveProof(null);
      setActiveSummaryError(activeSelectionMatches ? "No verified task examples are available for this version. Inspect its saved source and checks."
        : "The version in use changed. Reopen what’s in use to check it again.");
    }
  }, [activeView, activeSnapshot, activeSelectionMatches, state?.selection.eligible]);
  async function showActive() {
    if (locked.current || !trusted || !state?.extension || !ownActive) return;
    const snapshot = { ownerId: state.owner.id, extensionId: state.extension.id, revision: ownActive,
      generation: state.selection.generation, evidenceId: state.selection.approvedEvidenceId };
    setActiveSnapshot(snapshot); setActiveProof(null); setActiveSummaryError(""); setActiveView(true); openPane("active");
    if (!state.selection.eligible || snapshot.revision.provenance === "operator" || !snapshot.evidenceId) {
      setActiveSummaryError("No verified task examples are available for this version. Inspect its saved source and checks.");
      return;
    }
    locked.current = true; const turn = ++serial.current, reading = readingRevision.current;
    setBusy("Checking the version in use…");
    try {
      const proof = await callbacks.current.request<Evidence>(`${extensionPath(snapshot.extensionId)}/evidence/${encodeURIComponent(snapshot.evidenceId)}`, "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      const latest = await callbacks.current.request<State>(extensionPath(snapshot.extensionId), "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      apply(latest);
      if (latest.owner.id !== snapshot.ownerId || latest.extension?.id !== snapshot.extensionId || latest.selection.revision?.id !== snapshot.revision.id
        || latest.selection.generation !== snapshot.generation || latest.selection.approvedEvidenceId !== snapshot.evidenceId) {
        setActiveSummaryError("The version in use changed. Reopen what’s in use to check it again.");
        return;
      }
      if (!latest.selection.eligible || proof.id !== snapshot.evidenceId || proof.revisionId !== snapshot.revision.id || !proof.passed || !proof.reports.length
        || !proof.reports.every(item => item.report.status === "PASS" && checkedObservation(item))
        || !summarizeExamples(proof)) throw new Error("Active examples are unverified");
      if (readingRevision.current === reading) setActiveProof(proof);
      else setActiveSummaryError("The view changed while checking. Reopen what’s in use to check it again.");
    } catch {
      if (mounted.current && serial.current === turn) { setActiveProof(null); setActiveSummaryError("The checked examples for the version in use could not be verified. No behavior summary is available. Reopen what’s in use to try again."); }
    } finally { if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); } }
  }
  function openTools() {
    managementReturn.current ??= { view: canvasView, position: canvasScroll.current };
    const navigation = { intent: openPane("details"), focus: focusIntent.current };
    requestAnimationFrame(() => {
      if (!mounted.current || viewIntent.current !== navigation.intent || !currentPane.current.open || currentPane.current.view !== "details") return;
      if (focusIntent.current === navigation.focus) {
        room.current?.querySelector<HTMLElement>("#studio-more-heading")?.focus();
        navigation.focus = focusIntent.current;
      }
    });
    return navigation;
  }
  useEffect(() => {
    developerTools.current?.removeAttribute("open");
    setInspection(null);
  }, [ownerId, target.extensionId]);

  function say(text: string, who: Message["who"] = "Studio", evidenceId?: string, exampleCount?: number) {
    const id = ++messageId.current;
    setMessages(old => {
      const next = [...old, { id, who, text, evidenceId, exampleCount }];
      const recentManual = new Set(next.filter(item => typeof item.id === "number").slice(-40).map(item => item.id));
      return next.filter(item => typeof item.id === "string" || recentManual.has(item.id));
    });
  }
  function pageScroller() {
    return studioPage.current && getComputedStyle(studioPage.current).overflowY === "auto" ? studioPage.current : null;
  }
  function conversationScroller() { return pageScroller() ?? chatLog.current; }
  function trackConversation(log: HTMLElement) {
    followConversation.current = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
    if (followConversation.current) setNewMessages(false);
  }
  function preserveReviewReading() {
    const scroller = pageScroller() ?? (currentPane.current.open ? canvas.current : chatLog.current);
    const bounds = scroller?.getBoundingClientRect();
    readingAnchor.current = null;
    if (!scroller || !bounds || bounds.height <= 0) return;
    const visible = Array.from(scroller.querySelectorAll<HTMLElement>(".rs-example"))
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom);
    visible.sort((first, second) => Math.abs(first.rect.top - bounds.top) - Math.abs(second.rect.top - bounds.top));
    const closest = visible[0];
    const proposed = visible.find(row => row.rect.top === closest?.rect.top && row.element.closest('[aria-label="Saved proposed example"]'));
    const anchor = visible.find(row => row.element.closest("details[open]")) ?? proposed ?? closest;
    if (anchor) readingAnchor.current = { scroller, element: anchor.element, top: anchor.rect.top, revision: readingRevision.current };
  }
  function apply(next: State) {
    if (next.owner.id !== ownerId || next.extension?.id !== extensionId.current && !(next.extension === null && extensionId.current === null)) throw new Error("Customization identity mismatch");
    stateEpoch.current++;
    setRestart(null);
    preserveReviewReading();
    setState(next);
    setTrusted(true);
    setRestore("");
    setHistory(next.history);
    setHistoryNext(next.historyNext ?? null);
    callbacks.current.changed(next.selection.generation);
  }
  useLayoutEffect(() => {
    const anchor = readingAnchor.current;
    readingAnchor.current = null;
    if (anchor && anchor.revision === readingRevision.current && anchor.element.isConnected && anchor.scroller.isConnected) {
      // Saved-state labels may change above the row being inspected after an awaited response.
      anchor.scroller.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
      if (anchor.scroller === canvas.current) canvasScroll.current = anchor.scroller.scrollTop;
    }
  }, [state, ruleAction]);
  useEffect(() => {
    if (!summaryKey || !summaryItem || !summaryRevision || !summaryDigest) return;
    const load = new AbortController();
    const current = () => !load.signal.aborted && mounted.current && extensionId.current === summaryItem;
    void callbacks.current.request<SavedSource>(`${extensionPath(summaryItem)}/revisions/${encodeURIComponent(summaryRevision)}`, "GET", undefined, load.signal)
      .then(async saved => {
        if (!current() || saved.extensionId !== summaryItem || saved.revisionId !== summaryRevision || saved.suiteDigest !== summarySuite) return null;
        return summaryPins ? savedRuleDescription(saved, summaryPins) : null;
      }).catch(() => null).then(description => {
        if (!current()) return;
        preserveReviewReading();
        setRuleAction({ key: summaryKey, description });
      });
    return () => load.abort();
  }, [summaryKey, summaryItem, summaryRevision, summarySuite, summaryDigest, summarySourceDigest]);
  function syncScrollInset() {
    const page = studioPage.current;
    if (!page) return;
    const inset = [...page.querySelectorAll<HTMLElement>(":scope > .rs-header, :scope > .rs-status-summary")]
      .filter(node => getComputedStyle(node).position === "sticky").reduce((height, node) => height + node.offsetHeight, 12);
    page.style.setProperty("--rs-anchor", `${inset}px`);
  }
  function focusInline(id: string) {
    const intent = ++focusIntent.current, reading = ++readingRevision.current;
    followConversation.current = false;
    requestAnimationFrame(() => {
      if (!mounted.current || focusIntent.current !== intent || readingRevision.current !== reading || currentPane.current.open) return;
      syncScrollInset();
      const heading = chatLog.current?.querySelector<HTMLElement>("#" + id);
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: "start" });
    });
    return reading;
  }
  function hideInline() {
    ++reviewLoad.current; ++viewIntent.current; ++readingRevision.current;
    setInlineOpen(false); setReviewLoading(false);
    const focus = ++focusIntent.current;
    requestAnimationFrame(() => {
      if (!mounted.current || focusIntent.current !== focus || currentPane.current.open) return;
      const invoker = inlineInvoker.current;
      (invoker?.isConnected && invoker.getClientRects().length ? invoker : document.getElementById("studio-saved-change"))?.focus();
    });
  }
  async function readReviewState(snapshot: SavedReview, current: () => boolean, failed = false, activating = false) {
    const latest = await callbacks.current.request<State>(extensionPath(snapshot.extension.id), "GET", undefined, authoringLifetime.current.signal);
    if (!current()) return null;
    let eligible = failed ? latest.evidence?.id === snapshot.evidenceId && latest.evidence.revisionId === snapshot.revision.id && !latest.evidence.passed
      : savedProofEligible(latest, snapshot.evidenceId);
    if (!eligible && !failed && !activating && sameReviewDraft(latest, snapshot) && conversation?.id) {
      const index = await callbacks.current.request<Authoring>(`authoring?extensionId=${encodeURIComponent(snapshot.extension.id)}`, "GET", undefined, authoringLifetime.current.signal);
      if (!current()) return null;
      eligible = index.current?.id === conversation.id && matchingOffer(index.current, latest) && index.current?.review?.evidenceId === snapshot.evidenceId;
    }
    return { latest, currentProof: eligible && sameReviewDraft(latest, snapshot)
      && (!activating || latest.approved && latest.approvedEvidenceId === snapshot.evidenceId && latest.executionAvailability?.available !== false) };
  }
  async function openReview(evidenceId?: string, destination: "studio-saved-change" | "studio-review-heading" = "studio-review-heading") {
    const proofId = evidenceId ?? decisionEvidenceId ?? failedEvidenceId;
    const failed = !!proofId && proofId === failedEvidenceId;
    if (!state?.draft || !state.extension || !inlineAvailable || disabled || locked.current || !proofId
        || !failed && (!reviewAllowed || !(savedProofEligible(state, proofId) || eligibleOffer && offer?.evidenceId === proofId))) return;
    const snapshot: SavedReview = structuredClone({ owner: state.owner, extension: state.extension, revision: state.draft,
      draftVersion: state.draftVersion, evidenceId: proofId, suiteDigest: state.draft.suiteDigest ?? null, selection: state.selection });
    const key = `${snapshot.owner.id}/${snapshot.extension.id}/${snapshot.revision.id}/${snapshot.draftVersion}/${proofId}`;
    const same = !!savedReview && reviewKey === key && savedReview.suiteDigest === snapshot.suiteDigest;
    const load = ++reviewLoad.current;
    const intent = ++viewIntent.current, epoch = stateEpoch.current, requestSerial = serial.current;
    const invoker = document.activeElement;
    if (invoker instanceof HTMLElement && !invoker.closest("#studio-review")) inlineInvoker.current = invoker;
    setSavedReview(snapshot);
    if (!same) { setReviewEvidence(null); setReviewSource(null); }
    setReview("");
    setReviewError(""); setReviewLoading(true);
    if (currentPane.current.open) {
      developerTools.current?.removeAttribute("open");
      currentPane.current = { ...currentPane.current, open: false };
      setReviewOpen(false); setPane("conversation");
    }
    setActiveView(false);
    setInlineOpen(true);
    const reading = focusInline(destination);
    const current = () => mounted.current && !authoringLifetime.current.signal.aborted && reviewLoad.current === load
      && viewIntent.current === intent && !currentPane.current.open && serial.current === requestSerial && stateEpoch.current === epoch
      && extensionId.current === snapshot.extension.id && ownerId === snapshot.owner.id;
    try {
      const proof = await callbacks.current.request<Evidence>(`${extensionPath(snapshot.extension.id)}/evidence/${encodeURIComponent(proofId)}`, "GET", undefined, authoringLifetime.current.signal);
      if (!current()) return;
      if (proof.revisionId !== snapshot.revision.id || proof.id !== proofId || !Array.isArray(proof.reports) || !proof.reports.length
        || !proof.reports.every(item => typeof item?.id === "string" && item.expected && item.report)) throw new Error("Saved proof mismatch");
      setReviewEvidence(proof);
      const actionable = !failed && proof.passed && proof.reports.every(item => item.report.status === "PASS" && checkedObservation(item));
      let saved: SavedSource | null = null;
      if (actionable && snapshot.revision.kind === "authored") {
        saved = await callbacks.current.request<SavedSource>(`${extensionPath(snapshot.extension.id)}/revisions/${encodeURIComponent(snapshot.revision.id)}`, "GET", undefined, authoringLifetime.current.signal);
        if (!current()) return;
        if (saved.revisionId !== snapshot.revision.id || !snapshot.suiteDigest || saved.suiteDigest !== snapshot.suiteDigest || typeof saved.source !== "string" || !saved.source.trim()
          || typeof saved.artifact !== "string" || !saved.artifact.trim() || !saved.pins || typeof saved.pins !== "object"
          || !Array.isArray(saved.cases) || !saved.cases.length || saved.cases.some(item => typeof item !== "string" || !item.trim())) throw new Error("Saved review mismatch");
      }
      const result = await readReviewState(snapshot, current, failed);
      if (!result || !current()) return;
      apply(result.latest);
      if (saved) setReviewSource({ ...saved, ownerId: snapshot.owner.id, key });
      if (!result.currentProof) {
        setReviewError("The saved change or its evidence changed. These examples remain available to read. Open the latest changes before making a decision.");
      } else if (!failed && !actionable) {
        setReviewError("The exact saved change and its examples could not be confirmed. Approval is unavailable. Your current setup has not changed.");
      } else if (actionable) setReview(key);
    } catch {
      if (current()) { setReview(""); setReviewError("The exact saved change and its examples could not be confirmed. Approval is unavailable. Your current setup has not changed."); }
    } finally {
      if (mounted.current && reviewLoad.current === load && viewIntent.current === intent) {
        setReviewLoading(false);
        // Loading can briefly put the heading at the end of the scroll area.
        // Retain this destination as results grow, unless the person moved on.
        if (readingRevision.current === reading && document.activeElement?.id === destination) focusInline(destination);
      }
    }
  }
  async function refresh(announce = false) {
    if (locked.current) return;
    locked.current = true;
    const turn = ++serial.current;
    setBusy("Checking saved customizations…"); setError("");
    try {
      let next: State;
      if (extensionId.current) next = await callbacks.current.request<State>(extensionPath());
      else {
        const collection = await callbacks.current.request<Collection>("extensions");
        next = { owner: collection.owner, selection: collection.selection, catalog: collection.catalog, executionAvailability: collection.executionAvailability, extension: null,
          draftVersion: 0, draft: null, evidence: null, approved: false, approvedEvidenceId: null, restoreTargets: [], history: [], evidenceHistory: [] };
      }
      if (mounted.current && serial.current === turn) { apply(next); setNotice(announce ? "Saved state checked." : ""); return next; }
    } catch (failure) {
      if (mounted.current && serial.current === turn) {
        if ((failure as { status?: number }).status === 404 && extensionId.current) callbacks.current.unavailable();
        setTrusted(false); setError("Saved customization could not be checked. Reload saved state before making another change.");
      }
    } finally {
      if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); }
    }
  }
  function mergeMessages(incoming: Message[], scope: string, before?: string | null) {
    const page = messageHistory.current;
    if (before !== undefined && (page?.scope !== scope || before && (incoming.length
      ? !incoming.some(item => page.ids.has(item.id)) : before !== page.snapshotBefore))) {
      messageHistory.current = { scope, anchor: incoming[0]?.id ?? null,
        snapshotBefore: before, ids: new Set([...(page?.scope === scope ? page.ids : []), ...incoming.map(item => item.id)]) };
      setMessagesBefore(before);
      setMessagePageError(null);
    } else if (page?.scope === scope) {
      if (before !== undefined) page.snapshotBefore = before;
      incoming.forEach(item => page.ids.add(item.id));
    }
    setMessages(old => {
      const merged = scope.startsWith("item:") ? [...old] : old.filter(item => typeof item.id !== "string" || item.id.startsWith(scope + ":"));
      let position = merged.length;
      for (let index = incoming.length - 1; index >= 0; index--) {
        const item = incoming[index];
        const existing = merged.findIndex(message => message.id === item.id);
        if (existing < 0) merged.splice(position, 0, item);
        else {
          const previous = merged[existing];
          if (item.text !== previous.text || item.who !== previous.who || item.context !== previous.context || item.evidenceId !== previous.evidenceId)
            merged[existing] = item;
          position = existing;
        }
      }
      return merged.length === old.length && merged.every((item, index) => item === old[index]) ? old : merged;
    });
  }
  function loadTranscript(itemId: string, transcript: Transcript) {
    const incoming = transcript.messages.map(item => conversationMessage(item.conversationId, item));
    mergeMessages(incoming, "item:" + itemId, transcript.next);
    if (incoming.length) initialized.current = true;
  }
  async function adoptConversation(next: Conversation, turn: number, newItem = false, transcriptLoaded = false) {
    if (!mounted.current || serial.current !== turn) return;
    if (extensionId.current && next.extensionId !== extensionId.current || initialTarget.current.conversationId && !initialTarget.current.extensionId && next.extensionId !== null) throw new Error("Conversation customization mismatch");
    if (next.extensionId && (!running(next) || state?.extension?.id !== next.extensionId)) {
      extensionId.current = next.extensionId;
      const saved = await callbacks.current.request<State>(extensionPath(next.extensionId), "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      apply(saved);
    }
    setContextContinuation(old => old && (old.conversationId !== next.id || next.version > old.expectedVersion && !running(next)) ? null : old);
    if (!transcriptLoaded) {
      const itemScope = "item:" + next.extensionId;
      const incoming = next.messages.map(message => conversationMessage(next.id, message));
      const page = messageHistory.current;
      const item = !!next.extensionId && !historyMode.current && (page?.scope === itemScope || newItem);
      if (item && next.messagesBefore && incoming.length && !incoming.some(message => page?.ids.has(message.id))) {
        const transcript = await callbacks.current.request<Transcript>(`authoring/transcript?extensionId=${encodeURIComponent(next.extensionId!)}`, "GET", undefined, authoringLifetime.current.signal);
        if (!mounted.current || serial.current !== turn || extensionId.current !== next.extensionId) return;
        loadTranscript(next.extensionId!, transcript);
      } else {
        mergeMessages(incoming, item ? itemScope : "ai:" + next.id,
          item ? page?.scope === itemScope ? undefined : null : next.messagesBefore ?? null);
      }
    }
    setConversation(next);
    callbacks.current.targeted({ extensionId: next.extensionId, conversationId: !next.extensionId || historyMode.current ? next.id : null, history: historyMode.current });
    initialized.current = true; setEntry("item");
  }
  async function adoptAuthoring(next: Authoring, turn: number, snapshot = state, id?: string | null) {
    if (!mounted.current || serial.current !== turn) return;
    setAuthoring(next);
    const itemId = extensionId.current;
    const currentWork = next.current && itemId && next.current.extensionId === itemId && (running(next.current) || snapshot
      && next.current.draft.draftVersion === snapshot.draftVersion && next.current.draft.revisionId === (snapshot.draft?.id ?? null)
      && next.current.draft.suiteDigest === (snapshot.draft?.suiteDigest ?? null));
    const historical = !!itemId && !!id && id !== next.current?.id;
    historyMode.current = historical;
    setHistoryView(historical);
    if (itemId && !historical && next.transcript) loadTranscript(itemId, next.transcript);
    const selected = id ?? (currentWork ? next.current!.id : null);
    if (selected) {
      const current = next.current?.id === selected ? next.current : await callbacks.current.request<Conversation>(`authoring/conversations/${encodeURIComponent(selected)}`, "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      if (current?.id !== selected || current.extensionId !== extensionId.current) throw new Error("Unconfirmed conversation");
      await adoptConversation(current, turn, false, !!itemId && !historical && !!next.transcript);
      if (mounted.current && serial.current === turn) requestedConversation.current = historical || !itemId ? selected : null;
    } else if (itemId) {
      requestedConversation.current = null;
      setConversation(null);
      callbacks.current.targeted({ extensionId: itemId, conversationId: null });
    }
  }
  async function loadAuthoring(id = requestedConversation.current, snapshot = state) {
    if (locked.current) return;
    requestedConversation.current = id;
    locked.current = true;
    const turn = ++serial.current;
    setBusy("Checking authoring status…"); setAuthoringError("");
    try {
      const next = await callbacks.current.request<Authoring>(authoringPath(), "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      await adoptAuthoring(next, turn, snapshot, id);
      if (mounted.current && serial.current === turn) setObservationPaused(false);
    } catch (failure) {
      if (mounted.current && serial.current === turn && (failure as { status?: number }).status === 404 && id) callbacks.current.unavailable();
      if (mounted.current && serial.current === turn) { setAuthoring(null); setObservationPaused(true); setAuthoringError("AI authoring status could not be checked. Retry status before continuing a conversation. Saved work remains available."); }
    } finally { if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); } }
  }
  function returnToCurrent() {
    if (locked.current || pendingTurn) return;
    requestedConversation.current = null;
    historyMode.current = false; setHistoryView(false); setConversation(null); setReview("");
    messageHistory.current = null; setMessagesBefore(null);
    setContextContinuation(null);
    setMessages([]);
    initialized.current = false; setEntry("item");
    callbacks.current.targeted({ extensionId: extensionId.current, conversationId: null });
    if (reviewOpen) closeReview();
    void loadAuthoring(undefined, state);
  }
  function continueSaved() {
    if (!conversation || retired || !authoring?.availability.available || disabled || staleConversation) return;
    const operationId = crypto.randomUUID();
    if (contextRecovery) setContextContinuation({ conversationId: conversation.id, expectedVersion: conversation.version });
    void submitAuthoring({ target: { kind: "resume", extensionId: extensionId.current! }, conversationId: conversation.id,
      operationId, text: "Continue from saved work. Ask before changing any independent examples.",
      expectedVersion: conversation.version, expectedDraftVersion: state!.draftVersion });
  }
  async function recoverTurn(input: Turn, turn: number) {
    let recoveredResponse = false;
    try {
      const recovered = await callbacks.current.request<{ operation: Operation; conversation: Conversation }>("authoring/recover", "POST", input, authoringLifetime.current.signal);
      recoveredResponse = true;
      if (!mounted.current || serial.current !== turn) return;
      if (recovered.operation.id !== input.operationId || recovered.operation.version !== input.expectedVersion + 1
        || !recovered.operation.runId || recovered.conversation.version < recovered.operation.version
        || input.conversationId && recovered.conversation.id !== input.conversationId
        || input.target.kind !== "create" && recovered.conversation.extensionId !== input.target.extensionId) throw new Error("Operation customization mismatch");
      const itemId = recovered.conversation.extensionId;
      if (extensionId.current && itemId !== extensionId.current) throw new Error("Operation customization mismatch");
      const index = await callbacks.current.request<Authoring>(itemId ? `authoring?extensionId=${encodeURIComponent(itemId)}` : authoringPath(), "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      if (itemId && index.transcript) {
        extensionId.current = itemId;
        const saved = await callbacks.current.request<State>(extensionPath(itemId), "GET", undefined, authoringLifetime.current.signal);
        if (!mounted.current || serial.current !== turn) return;
        apply(saved);
        await adoptAuthoring(index, turn, saved);
      } else {
        setAuthoring(index);
        await adoptConversation(recovered.conversation, turn, input.target.kind === "create");
      }
      if (!mounted.current || serial.current !== turn) return;
      retainTurn(null); setRetryTurn(false); setAuthoringError("");
      settleDraft(input);
      return;
    } catch (failure) {
      if (!mounted.current || serial.current !== turn) return;
      if (recoveredResponse) throw failure;
      if (deletedOutcome(failure, input.operationId)) return;
      if ((failure as { code?: string }).code === "LEGACY_CUSTOMIZATION_RETIRED") { setRetiredOperation(true); setRetryTurn(false); setAuthoringError(authoringReason("LEGACY_CUSTOMIZATION_RETIRED")); return; }
      if ((failure as { status?: number }).status !== 404) throw failure;
    }
    if (!mounted.current || serial.current !== turn) return;
    setRetryTurn(true);
    setAuthoringError("Saved state was checked, but acceptance of this request is unconfirmed. You may explicitly retry the same submitted request; it keeps its operation identity.");
  }
  async function submitAuthoring(input: Turn, recoveryOnly = false) {
    if (locked.current || !trusted && !recoveryOnly || retired && !recoveryOnly) return;
    retainTurn(input);
    locked.current = true;
    const turn = ++serial.current;
    setBusy(recoveryOnly ? "Checking submitted request…" : "Sending description…");
    setAuthoringError(""); setRetryTurn(false);
    try {
      if (recoveryOnly) await recoverTurn(input, turn);
      else {
        let acceptedResponse = false;
        try {
          const accepted = await callbacks.current.request<{ operation: Operation; conversation: Conversation }>("authoring/turn", "POST", input, authoringLifetime.current.signal);
          acceptedResponse = true;
          if (!mounted.current || serial.current !== turn) return;
          if (accepted.operation.id !== input.operationId || accepted.operation.version !== input.expectedVersion + 1 || accepted.conversation.version < accepted.operation.version || !accepted.operation.runId || input.conversationId && accepted.conversation.id !== input.conversationId) throw new Error("Unconfirmed authoring receipt");
          await adoptConversation(accepted.conversation, turn, input.target.kind === "create");
          if (!mounted.current || serial.current !== turn) return;
          retainTurn(null); settleDraft(input); setObservationPaused(false);
        } catch (failure) {
          if (!mounted.current || serial.current !== turn) return;
          if (!acceptedResponse && deletedOutcome(failure, input.operationId)) return;
          const problem = failure as { status?: number; code?: string };
          if (!acceptedResponse && problem.code === "LEGACY_CUSTOMIZATION_RETIRED") {
            setRetiredOperation(true); setRetryTurn(false); setAuthoringError(authoringReason(problem.code)); return;
          }
          if (!acceptedResponse && problem.status === 503 && problem.code === "AUTHORING_GUIDE_UNAVAILABLE") {
            retainTurn(null); settleDraft(input, true);
            setAuthoringError(authoringReason(problem.code));
            setAuthoring(current => current && { ...current, availability: { ...current.availability, available: false, code: "AUTHORING_GUIDE_UNAVAILABLE" } });
            void callbacks.current.request<Authoring>(authoringPath(), "GET", undefined, authoringLifetime.current.signal).then(refreshed => {
              if (mounted.current && serial.current === turn) setAuthoring(current => current && { ...current, availability: refreshed.availability });
            }, () => {});
            return;
          }
          if (!acceptedResponse && problem.status === 409 && input.target.kind !== "create"
              && ["STALE_DRAFT", "STALE_CONVERSATION", "STALE_CONTEXT", "CONFIG_CHANGED"].includes(problem.code ?? "")) {
            const notice = problem.code === "CONFIG_CHANGED" ? authoringReason(problem.code)
              : "This request was rejected because saved work changed. Your text is kept. Check the current proposal before sending again.";
            retainTurn(null); setRetryTurn(false); settleDraft(input, true);
            try {
              const saved = await callbacks.current.request<State>(extensionPath(input.target.extensionId), "GET", undefined, authoringLifetime.current.signal);
              if (!mounted.current || serial.current !== turn) return;
              apply(saved);
              const index = await callbacks.current.request<Authoring>(authoringPath(), "GET", undefined, authoringLifetime.current.signal);
              await adoptAuthoring(index, turn, saved);
              if (mounted.current && serial.current === turn) setAuthoringError(notice);
            } catch {
              if (mounted.current && serial.current === turn) {
                setAuthoring(null);
                setAuthoringError("Saved status could not be checked. Your message is kept. Check authoring status before sending again.");
              }
            }
            return;
          }
          await recoverTurn(input, turn);
        }
      }
    } catch (failure) {
      if (mounted.current && serial.current === turn && deletedOutcome(failure, input.operationId)) return;
      if (mounted.current && serial.current === turn) setAuthoringError("The submitted request's outcome could not be checked. Check authoring status before retrying; nothing will be sent automatically.");
    } finally { if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); } }
  }
  async function stopAuthoring() {
    if (locked.current || !conversation || !activeAuthoring) return;
    locked.current = true;
    const turn = ++serial.current;
    setBusy("Requesting authoring stop…"); setAuthoringError("");
    try {
      const next = await callbacks.current.request<Conversation>(`authoring/conversations/${encodeURIComponent(conversation.id)}/cancel`, "POST", { runId: conversation.runId, expectedVersion: conversation.version }, authoringLifetime.current.signal);
      if (next.id !== conversation.id || next.runId !== conversation.runId) throw new Error("Unconfirmed stop");
      await adoptConversation(next, turn); if (mounted.current && serial.current === turn) setObservationPaused(false);
    } catch {
      if (mounted.current && serial.current === turn) { setObservationPaused(true); setAuthoringError("Stopping could not be confirmed. Check authoring status; the accepted run may still be settling."); }
    } finally { if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); } }
  }
  useEffect(() => {
    mounted.current = true;
    const movedFocus = () => { focusIntent.current++; };
    document.addEventListener("focusin", movedFocus);
    document.addEventListener("pointerdown", movedFocus);
    document.addEventListener("keydown", movedFocus);
    document.getElementById("studio-title")?.focus();
    void (async () => {
      if (pendingTurn) await submitAuthoring(pendingTurn, true);
      if (!mounted.current || deletedRef.current) return;
      const loaded = await refresh();
      if (!mounted.current || !loaded) return;
      if (pendingTurn && extensionId.current && messageHistory.current?.scope !== "item:" + extensionId.current) await loadAuthoring(undefined, loaded);
      else if (!pendingTurn) await loadAuthoring(initialTarget.current.conversationId, loaded);
      if (mounted.current && entry === "start") document.getElementById("studio-message")?.focus();
    })();
    void readHostCatalog();
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => { mounted.current = false; authoringLifetime.current.abort(); document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("focusin", movedFocus); document.removeEventListener("pointerdown", movedFocus); document.removeEventListener("keydown", movedFocus);
      ++serial.current; ++viewIntent.current; ++reviewLoad.current; ++focusIntent.current; locked.current = false; };
  }, []);
  useEffect(() => {
    if (!conversation || !activeAuthoring || !visible || observationPaused || pendingTurn) return;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, authoringLifetime.current.signal]);
    const id = conversation.id, runId = conversation.runId;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (signal.aborted || !mounted.current) return;
      if (locked.current) { timer = setTimeout(poll, 1000); return; }
      const turn = serial.current;
      try {
        const next = await callbacks.current.request<Conversation>(`authoring/conversations/${encodeURIComponent(id)}`, "GET", undefined, signal);
        if (signal.aborted || !mounted.current || serial.current !== turn) { if (!signal.aborted) timer = setTimeout(poll, 1000); return; }
        if (next.id !== id || next.runId !== runId) { setObservationPaused(true); setAuthoringError("The saved run changed. Check authoring status before continuing."); return; }
        await adoptConversation(next, turn);
        if (!signal.aborted && running(next)) timer = setTimeout(poll, 1000);
      } catch {
        if (!signal.aborted && mounted.current && serial.current === turn) { setObservationPaused(true); setAuthoringError("Authoring progress could not be checked. Use Check authoring status for read-only recovery."); }
      }
    }
    timer = setTimeout(poll, 1000);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [conversation?.id, conversation?.runId, conversation?.status, visible, observationPaused, !!pendingTurn]);
  useEffect(() => {
    if (entry !== "item" || !state || !trusted || extensionId.current && !authoring || initialized.current) return;
    initialized.current = true;
    const selected = state.selection.eligible && state.selection.revision?.id === state.draft?.id;
    const text = state.draft ? state.approved
      ? selected ? "This customization is on. What would you like to change?" : "Your proposal is approved. Turning it on is a separate decision."
      : "Your proposal is here. What would you like to change or check?"
      : "What would you like to change about your work?";
    setMessages([{ id: ++messageId.current, who: "Studio", text: `${task ? `From your ${task.status} task “${task.title}”. ` : ""}${text}` }]);
  }, [entry, state, trusted, authoring]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      syncScrollInset();
      const available = (room.current?.clientWidth ?? 900) - 14;
      const min = Math.max(30, Math.ceil(300 / available * 100));
      const max = Math.min(70, Math.floor((available - 340) / available * 100));
      if (min <= max) setLimits({ min, max });
      const log = conversationScroller();
      if (log && followConversation.current) log.scrollTop = log.scrollHeight;
    });
    if (room.current) observer.observe(room.current);
    if (chatEnd.current?.parentElement) observer.observe(chatEnd.current.parentElement);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const log = conversationScroller();
    const previous = prependedMessages.current;
    if (log && previous) {
      prependedMessages.current = null;
      if (previous.anchor?.element.isConnected) log.scrollTop += previous.anchor.element.getBoundingClientRect().top - previous.anchor.top;
      else log.scrollTop = previous.top + log.scrollHeight - previous.height;
      (previous.focus?.isConnected ? previous.focus : log).focus({ preventScroll: true });
      return;
    }
    if (log && followConversation.current) log.scrollTop = log.scrollHeight;
    else setNewMessages(true);
  }, [messages, activeAuthoring, messagePageError]);
  useLayoutEffect(() => {
    const log = conversationScroller();
    if (log && followConversation.current) log.scrollTop = log.scrollHeight;
  }, [conversation?.review?.evidenceId]);
  useEffect(() => {
    if (restart) document.getElementById("studio-restart-confirm")?.focus();
  }, [restart]);
  useEffect(() => {
    const previous = document.title;
    document.title = "Customization Studio | Daymark";
    return () => { document.title = previous; };
  }, []);
  useLayoutEffect(() => {
    if (deleted) deletedTitle.current?.focus();
  }, [deleted]);
  useEffect(() => {
    if (!busy && focusUse.current) {
      const intent = focusUse.current; focusUse.current = null;
      if (mounted.current && viewIntent.current === intent.view && focusIntent.current === intent.focus && readingRevision.current === intent.reading) {
        if (intent.target === "studio-customization-status")
          document.getElementById(intent.target)?.focus({ preventScroll: true });
        else if (inlineOpen && !currentPane.current.open)
          room.current?.querySelector<HTMLElement>("#" + intent.target)?.focus({ preventScroll: true });
      }
    }
  }, [busy]);

  async function mutate(operation: string, body: object, message: string, selection = false) {
    if (locked.current || !trusted || activeAuthoring || pendingTurn || !extensionId.current || retired && operation !== "disable") return;
    if (executionUnavailable && ["activate", "rollback"].includes(operation)) return;
    locked.current = true;
    const turn = ++serial.current;
    const reading = readingRevision.current;
    const view = viewIntent.current, focus = focusIntent.current;
    const decision = operation === "approve" || operation === "activate";
    let dispatched = false;
    setBusy(operation === "simulate" ? "Checking examples…" : "Saving your choice…");
    setError(""); setNotice("");
    try {
      if (decision) {
        if (!savedReview || reviewActionDisabled) return;
        const epoch = stateEpoch.current;
        const current = () => mounted.current && serial.current === turn && viewIntent.current === view
          && stateEpoch.current === epoch && !currentPane.current.open && extensionId.current === savedReview.extension.id;
        const result = await readReviewState(savedReview, current, false, operation === "activate");
        if (!result || !current()) return;
        if (!result.currentProof) {
          apply(result.latest); setReview("");
          setReviewError("The saved change or its approval changed. Reopen the current checked examples before making a decision.");
          return;
        }
      }
      if (selection) callbacks.current.beforeSelectionChange();
      dispatched = true;
      const next = await callbacks.current.request<State>(`${extensionPath()}/${operation}`, "POST", body);
      if (!mounted.current || serial.current !== turn) return;
      const followReading = readingRevision.current === reading;
      if ((operation === "approve" || operation === "activate") && followReading && viewIntent.current === view && focusIntent.current === focus)
        focusUse.current = { view, focus, reading, target: operation === "approve" ? "use-customization" : "studio-use-confirmed" };
      if (operation === "disable" && followReading && viewIntent.current === view && focusIntent.current === focus)
        focusUse.current = { view, focus, reading, target: "studio-customization-status" };
      apply(next);
      if (operation === "activate" && savedReview && (next.selection.revision?.id !== savedReview.revision.id
          || next.selection.approvedEvidenceId !== savedReview.evidenceId || !next.selection.eligible)) {
        setReview(""); setReviewError("The version in use could not be confirmed from these examples. Reopen the saved changes.");
        return;
      }
      if (operation === "restart") {
        historyMode.current = false; setHistoryView(false);
        setConversation(null); setContextContinuation(null); setEvidence(null); setReview(""); setReviewSource(null); setInspection(null); setActiveView(false);
        callbacks.current.targeted({ extensionId: extensionId.current, conversationId: null });
      }
      const resultMessage = operation === "approve" && next.executionAvailability?.available === false
        ? `This change is approved and saved. ${next.executionAvailability.message || "Task customizations cannot run in this installation yet. Your tasks still work."} Your current setup has not changed.` : message;
      say(resultMessage);
      setNotice(resultMessage);
      if (operation === "simulate" && next.evidence) {
        const proof = await callbacks.current.request<Evidence>(`${extensionPath()}/evidence/${encodeURIComponent(next.evidence.id)}`);
        if (mounted.current && serial.current === turn) {
          say(proof.passed ? `The sample run passed. Review ${proof.reports.length} ${proof.reports.length === 1 ? "example" : "examples"} when you are ready.`
            : "This sample run did not pass. It cannot be approved or put in use.", "Studio", proof.id, proof.reports.length);
        }
      }
    } catch (failure) {
      if (!mounted.current || serial.current !== turn) return;
      setTrusted(false);
      if (decision) setReview("");
      const conflict = (failure as { status?: number })?.status === 409;
      setError(!dispatched ? "The saved change could not be confirmed before sending a decision."
        : conflict ? "The saved proposal or selection changed. Checking the server before you try again."
        : "The request did not finish here. It may have reached the server. Checking saved state before you try again.");
      try {
        const next = await callbacks.current.request<State>(extensionPath());
        if (mounted.current && serial.current === turn) {
          apply(next);
          if (operation === "activate" && conflict && next.approvedEvidenceId !== savedReview?.evidenceId)
            setReviewError("The approved examples changed. Reopen the current checked examples before turning this on.");
          setNotice("Saved state reloaded. Check the proposal, approval and In use choice before making another request.");
        }
      } catch {
        if (mounted.current && serial.current === turn) setError("The request's outcome could not be checked. Reload saved state before retrying any change.");
      }
    } finally {
      if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); }
    }
  }
  async function inspectSource(earlierRevisionId?: string) {
    if (locked.current || disabled || !inspectionRevision && !earlierRevisionId) return;
    locked.current = true; const turn = ++serial.current;
    const historical = !!earlierRevisionId;
    const revision = earlierRevisionId ?? inspectionRevision!.id;
    const identity = historical ? `${ownerId}/${extensionId.current}/history/${revision}` : inspectionKey;
    const suite = historical ? undefined : inspectionRevision!.suiteDigest ?? null;
    const itemId = extensionId.current, navigation = openTools(), reading = readingRevision.current;
    setBusy("Inspecting saved source and examples…"); setError(""); setInspection(null);
    try {
      const next = await callbacks.current.request<SavedSource>(`${extensionPath()}/revisions/${encodeURIComponent(revision)}`, "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn || extensionId.current !== itemId || viewIntent.current !== navigation.intent
        || !currentPane.current.open || currentPane.current.view !== "details") return;
      if (next.revisionId !== revision || suite !== undefined && next.suiteDigest !== suite || typeof next.source !== "string" || !next.source.trim()
        || typeof next.artifact !== "string" || !next.artifact.trim() || !next.pins || typeof next.pins !== "object"
        || !Array.isArray(next.cases) || next.cases.some(item => typeof item !== "string" || !item.trim())) throw new Error("Saved inspection mismatch");
      setInspection({ ...next, key: identity, historical });
      requestAnimationFrame(() => {
        if (!mounted.current || serial.current !== turn || viewIntent.current !== navigation.intent || !currentPane.current.open || currentPane.current.view !== "details"
          || readingRevision.current !== reading || focusIntent.current !== navigation.focus) return;
        if (developerTools.current) developerTools.current.open = true;
        document.getElementById(historical ? "studio-inspected-history" : "studio-inspected-source")?.focus();
      });
    } catch { if (mounted.current && serial.current === turn) setError("Exact saved source and examples could not be checked. No proposal or approval was changed."); }
    finally { if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); } }
  }
  async function showEvidence(id: string, namedExample?: string) {
    if (locked.current || !id.trim()) return;
    locked.current = true;
    const turn = ++serial.current;
    const reading = ++readingRevision.current;
    const invoker = document.activeElement;
    setBusy("Opening saved sample results…"); setError("");
    try {
      const proof = await callbacks.current.request<Evidence>(`${extensionPath()}/evidence/${encodeURIComponent(id.trim())}`);
      if (mounted.current && serial.current === turn && readingRevision.current === reading) {
        if (proof.id !== id.trim() || namedExample && !proof.reports.some(item => item.id === namedExample)) throw new Error("Saved example mismatch");
        if (evidence?.id !== proof.id) { canvasScroll.current = 0; managementReturn.current = null; }
        evidenceReturn.current = proof.id;
        setExampleId(namedExample ?? proof.reports[0]?.id ?? null); setEvidence(proof); const intent = openPane("results", invoker); if (state) void compareCurrent(state.selection, intent);
      }
    } catch {
      if (mounted.current && serial.current === turn) setError("Those saved sample results are unavailable for this person. No customization was changed.");
    } finally {
      if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); }
    }
  }
  async function earlierHistory() {
    if (locked.current || historyNext === null) return;
    locked.current = true;
    const turn = ++serial.current;
    setBusy("Opening earlier selections…"); setError("");
    try {
      const next = await callbacks.current.request<{ rows: History[]; next: number | null }>(`${extensionPath()}/history?before=${historyNext}`);
      if (mounted.current && serial.current === turn) { setHistory(old => [...old, ...next.rows.filter(row => !old.some(item => item.id === row.id))]); setHistoryNext(next.next); }
    } catch {
      if (mounted.current && serial.current === turn) setError("Earlier selections could not be loaded. No customization was changed.");
    } finally {
      if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); }
    }
  }
  async function earlierMessages() {
    const page = messageHistory.current;
    if (locked.current || !messagesBefore || !page) return;
    const itemId = extensionId.current;
    const item = !!itemId && page.scope === "item:" + itemId;
    if (!item && (!conversation || page.scope !== "ai:" + conversation.id)) return;
    locked.current = true;
    const turn = ++serial.current, before = messagesBefore, anchor = page.anchor;
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    function preserveReading() {
      const log = conversationScroller();
      const focus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : invoker;
      if (log) {
        const bounds = log.getBoundingClientRect();
        const visible = Array.from(log.querySelectorAll<HTMLElement>("[data-conversation-message]")).find(element => {
          const rect = element.getBoundingClientRect(); return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
        });
        prependedMessages.current = { height: log.scrollHeight, top: log.scrollTop, focus,
          anchor: visible ? { element: visible, top: visible.getBoundingClientRect().top } : null };
      }
    }
    setBusy("Opening earlier messages…"); setNotice("");
    try {
      const cursor = encodeURIComponent(before);
      const next = item
        ? await callbacks.current.request<Transcript>(`authoring/transcript?extensionId=${encodeURIComponent(itemId)}&before=${cursor}`, "GET", undefined, authoringLifetime.current.signal)
        : await callbacks.current.request<{ messages: Conversation["messages"]; next: string | null }>(
          `authoring/conversations/${encodeURIComponent(conversation!.id)}/messages?before=${cursor}`, "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn || messageHistory.current !== page || extensionId.current !== itemId) return;
      preserveReading();
      followConversation.current = false;
      const incoming = item ? (next as Transcript).messages.map(message => conversationMessage(message.conversationId, message))
        : next.messages.map(message => conversationMessage(conversation!.id, message));
      const ids = new Set(incoming.map(item => item.id));
      setMessages(old => {
        const position = anchor === null ? old.length : Math.max(0, old.findIndex(item => item.id === anchor));
        return [...old.slice(0, position).filter(item => !ids.has(item.id)), ...incoming,
          ...old.slice(position).filter(item => !ids.has(item.id))];
      });
      page.anchor = incoming[0]?.id ?? anchor;
      incoming.forEach(item => page.ids.add(item.id));
      setMessagesBefore(next.next); setMessagePageError(null); setNotice("Earlier messages loaded.");
    } catch {
      if (mounted.current && serial.current === turn) { preserveReading(); setMessagePageError({ scope: page.scope, before }); }
    } finally { if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); } }
  }
  async function earlierSaved(kind: "evidence" | "revisions" | "restore-targets") {
    if (locked.current || !state?.extension) return;
    const cursor = kind === "evidence" ? state.evidenceHistoryNext : kind === "restore-targets" ? state.restoreTargetsNext : revisionsNext;
    if (cursor === null || kind !== "revisions" && !cursor) return;
    locked.current = true;
    const turn = ++serial.current;
    setBusy("Opening saved history…"); setError("");
    try {
      const path = `${extensionPath()}/${kind}${cursor ? "?before=" + encodeURIComponent(cursor) : ""}`;
      if (kind === "revisions") {
        const next = await callbacks.current.request<{ rows: Revision[]; next: string | null }>(path, "GET", undefined, authoringLifetime.current.signal);
        if (mounted.current && serial.current === turn) {
          setRevisions(old => [...old, ...next.rows.filter(item => !old.some(row => row.id === item.id))]); setRevisionsNext(next.next);
        }
      } else if (kind === "evidence") {
        const next = await callbacks.current.request<{ rows: State["evidenceHistory"]; next: string | null }>(path, "GET", undefined, authoringLifetime.current.signal);
        if (mounted.current && serial.current === turn) setState(old => old ? { ...old,
          evidenceHistory: [...old.evidenceHistory, ...next.rows.filter(item => !old.evidenceHistory.some(row => row.id === item.id))], evidenceHistoryNext: next.next } : old);
      } else {
        const next = await callbacks.current.request<{ rows: Revision[]; next: string | null }>(path, "GET", undefined, authoringLifetime.current.signal);
        if (mounted.current && serial.current === turn) setState(old => old ? { ...old,
          restoreTargets: [...old.restoreTargets, ...next.rows.filter(item => !old.restoreTargets.some(row => row.id === item.id))], restoreTargetsNext: next.next } : old);
      }
    } catch {
      if (mounted.current && serial.current === turn) setError("Saved history could not be loaded. No customization was changed.");
    } finally { if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); } }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (locked.current || !trusted || retired || !text.trim() || sendDisabled || !authoring?.availability.available) return;
    if (authoring?.availability.available) {
      if (/[\uD800-\uDFFF]/u.test(text) || new TextEncoder().encode(text).length > 8192) { setAuthoringError("Use valid text within the 8 KiB description limit."); return; }
      const target = turnTarget(), resumed = target.kind === "resume" ? conversation : null;
      const input = { target, conversationId: resumed?.id ?? null, operationId: crypto.randomUUID(), text,
        expectedVersion: resumed?.version ?? 0, expectedDraftVersion: state!.draftVersion };
      submittedDraft.current = { operationId: input.operationId, edit: draftEdits.current };
      draftValue.current = null;
      keepDraft(draftBinding.current.key, null);
      void submitAuthoring(input);
      return;
    }
  }
  function chooseStarter(request: string) {
    setStarterNotice(text.length ? "Clear your draft before choosing another starting point." : "");
    if (!text.length) editText(request);
    document.getElementById("studio-message")?.focus({ preventScroll: true });
  }
  const restoreTarget = state?.restoreTargets.find(item => item.id === restore);
  const earlierVersions = history.filter(item => item.operation === "draft-superseded" && item.revisionId);
  const selectedDraft = !!state?.selection.eligible && state.selection.revision?.id === state.draft?.id;
  function openSetup() {
    ++setupGeneration.current;
    setupInvoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSetupOpen(true);
  }
  function closeSetup(uncertain = false) {
    const generation = ++setupGeneration.current;
    setSetupOpen(false);
    if (uncertain) {
      setSetupNotice("Saving could not be confirmed. Checking current settings without resubmitting; no message will be sent.");
      void callbacks.current.request<Setup>("authoring/setup", "GET", undefined, authoringLifetime.current.signal).then(next => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAuthoring(old => old ? { ...old, availability: next.availability } : old);
        setSetupNotice("Current settings checked. The interrupted save's key replacement cannot be confirmed. Open Configure to explicitly save again if needed.");
      }).catch(() => { if (mounted.current && setupGeneration.current === generation) setSetupNotice("Settings could not be checked. Open Configure to retry status before saving again."); });
    }
    requestAnimationFrame(() => {
      const invoker = setupInvoker.current;
      (invoker?.isConnected && invoker.getClientRects().length ? invoker : document.getElementById("assistant-configure") ?? document.getElementById("studio-message"))?.focus({ preventScroll: true });
    });
  }
  if (deleted) return <section className="read-studio" aria-label="Customization Studio"><header className="rs-header"><h1 id="studio-deleted-title" ref={deletedTitle} tabIndex={-1}>Customization deleted</h1></header>
    <p role="status">This submitted request belongs to a deleted customization. It cannot be continued. Nothing was retried or created.</p>
    {recoveryError && <p role="alert">{recoveryError}</p>}
    <button className="quiet-button" onClick={() => callbacks.current.unavailable()}>Back to Customizations</button></section>;
  return <section className={`read-studio${reviewOpen ? " rs-review-open" : ""}${inlineOpen ? " rs-inline-open" : ""}`} aria-label="Customization Studio" ref={studioPage}
    onWheelCapture={() => { readingRevision.current++; }} onPointerDownCapture={() => { readingRevision.current++; }} onKeyDownCapture={() => { readingRevision.current++; }} onScroll={event => {
    if (event.target !== event.currentTarget) return;
    if (currentPane.current.open) canvasScroll.current = event.currentTarget.scrollTop;
    else trackConversation(event.currentTarget);
  }}>
    <div className="sr-only" role="status">{busy || notice}</div>
    <header className="rs-header"><div><p className="rs-breadcrumb">Customization Studio</p><h1 className="rs-goal">{displayedRule?.complete ? displayedRule.title : "Discuss a customization"}</h1><div className="rs-title"><span className="rs-identity-label">Saved name</span><h2 id="studio-title" tabIndex={-1} title={state?.extension?.name}>{state?.extension?.name ?? (target.extensionId ? "Opening customization…" : target.conversationId ? "Opening conversation…" : "New customization")}</h2>
      {state?.extension && <CustomizationName key={state.owner.id + "/" + state.extension.id} ownerId={state.owner.id} itemId={state.extension.id} name={state.extension.name} suggestion={displayedRule?.complete ? Array.from(displayedRule.title).slice(0, 80).join("") : undefined} disabled={disabled || !!restart} request={request} saved={next => {
        if (!mounted.current || next.owner.id !== ownerId || next.extension?.id !== extensionId.current) return;
        setState(old => old?.extension?.id === next.extension!.id ? { ...old, extension: { ...old.extension, name: next.extension!.name },
          selection: { ...old.selection, revision: old.selection.revision?.extensionId === next.extension!.id ? { ...old.selection.revision, extensionName: next.extension!.name } : old.selection.revision } } : old);
      }} />}</div></div>
      <div className="rs-header-actions">{activeAuthoring && <button className="rs-stop" disabled={!!busy || conversation?.status === "CANCELLING"} onClick={() => void stopAuthoring()}>{conversation?.status === "CANCELLING" ? "Stopping…" : "Stop"}</button>}<button className="rs-back" aria-label={backLabel} onClick={back} disabled={!!busy || !!restart}><span className="rs-full-label">{backLabel}</span><span className="rs-short-label" aria-hidden="true">Back</span></button></div></header>
    {error && <div role="alert" className="rs-error">{error} <button onClick={() => void refresh(true)} disabled={!!busy}>Retry</button></div>}
    {executionUnavailable && <p role="status" className="rs-setup-notice">{state?.executionAvailability?.message || "Task customizations cannot run in this installation yet. Your tasks still work."}</p>}
    {state && <div className="rs-status-summary" aria-label="Customization status">
      <div><strong id="studio-customization-status" tabIndex={-1}>{state.extension ? ownActive ? state.selection.eligible
        ? state.draft && !selectedDraft ? "Earlier version in use" : beforeCreate ? "On for new tasks" : "On for my tasks" : "Couldn’t check what’s in use"
        : state.approved ? "Approved · Not on yet" : state.draft ? "Proposed change · Not on" : "In discussion · Not in use" : "New customization · In discussion"}</strong>
        {ownActive && state.draft && !selectedDraft && <span>{!state.evidence ? "Proposed change · Examples pending" : state.approved ? "Proposed change · Approved · Not on yet" : "Proposed change · Not on"}</span>}
        {trigger ? <span>{beforeCreate ? "Checks before adding · " : `For ${trigger} · `}{!trusted || state.selection.revision && !state.selection.eligible ? "Couldn’t check which rule is on"
          : state.selection.revision ? `Currently on: ${state.selection.revision.extensionName}` : `No rule is on for ${trigger}`}</span>
          : !workflowHost && state.selection.revision && !ownActive && <span>{state.selection.eligible ? "Another customization is in use" : "Couldn’t check the saved selection"}</span>}</div>
      <div className="rs-summary-actions">
        <button id="studio-manage" aria-label="More" disabled={!!restart} onClick={openTools}>More</button>
        {decisionEvidenceId && <button id="studio-view-saved" aria-label={latestReviewAvailable && inlineOpen ? "See current proposal" : "See proposed change"}
          disabled={!reviewAllowed} onClick={() => void openReview(latestReviewAvailable && inlineOpen ? newerEvidenceId ?? decisionEvidenceId : decisionEvidenceId, "studio-saved-change")}>
          <span className="rs-full-label">{latestReviewAvailable && inlineOpen ? "See current proposal" : "See proposed change"}</span>
          <span className="rs-short-label" aria-hidden="true">{latestReviewAvailable && inlineOpen ? "Latest" : "Summary"}</span></button>}
        {inlineAvailable && !decisionEvidenceId && <button onClick={() => {
          if (currentPane.current.open) closeReview();
          focusInline("studio-saved-change");
        }}>Return to saved change</button>}
        {ownActive && state.selection.eligible && <button aria-label="Back to tasks" onClick={backToTasks}>
          <span className="rs-full-label">Back to tasks</span><span className="rs-short-label" aria-hidden="true">Tasks</span></button>}
        {ownActive && <button aria-label="Turn off this customization" disabled={disabled || !!restart} onClick={() => void mutate("disable", { generation: state.selection.generation }, "This customization is off. Earlier tasks and receipts are kept.", true)}>
          <span className="rs-full-label">Turn off this customization</span><span className="rs-short-label" aria-hidden="true">Turn off</span></button>}
      </div>
    </div>}
    <div className={`rs-room rs-show-${pane}${reviewOpen ? "" : " rs-review-closed"}`} ref={room} style={{ "--rs-chat": Math.max(limits.min, Math.min(limits.max, width)) } as CSSProperties}>
      <section className="rs-chat" aria-labelledby="studio-conversation">
        <h2 id="studio-conversation" className="sr-only" tabIndex={-1}>Conversation</h2>
        <div ref={chatLog} className="rs-messages" inert={!!restart} tabIndex={0} role="log" aria-label="Studio conversation" aria-live="off"
          onWheel={() => { readingRevision.current++; }} onKeyDown={() => { readingRevision.current++; }} onPointerDown={() => { readingRevision.current++; }}
          onScroll={event => {
          trackConversation(event.currentTarget);
        }}>
          {messagesBefore && <div aria-label="Earlier messages">
            {earlierMessagesFailed && <p role="status">Couldn’t load earlier messages.</p>}
            <button id="studio-earlier-messages" disabled={!!busy} onClick={() => void earlierMessages()}>{earlierMessagesFailed ? "Retry earlier messages" : "Load earlier messages"}</button>
          </div>}
          {entry === "start" && <article className="rs-message rs-start">
            <strong>Daymark assistant</strong><h2>{workflowHost ? "What would you like Daymark to do for you?" : "What would you like to change about your work?"}</h2>
            {availableStarters.length > 0 ? <><p>Choose a starting point, then make it yours.</p><div className="rs-starters">{availableStarters.map(starter =>
              <button key={starter.label} type="button" onClick={() => chooseStarter(starter.text)}>{starter.label}</button>)}</div><p role="status">{starterNotice}</p></>
              : <p>Tell me what you want to happen. We’ll check what Daymark can support and work through useful examples together.</p>}
            {catalogError ? <p role="status">What Daymark supports could not be checked. <button onClick={() => void readHostCatalog()}>Try again</button></p> : hostCatalog && <details><summary>{workflowHost ? "What can I ask for?" : "What Daymark supports"}</summary>{hostCatalog.hooks.map(hook => <p key={hook.id}><strong>{taskTriggerGroup(hook.id) ?? hook.label}</strong> · {hook.description}</p>)}
              {workflowHost && <><p>{[capabilities.includes("tasks.create") && "Create a task.", capabilities.includes("tasks.update") && "Update the task that triggered the rule."].filter(Boolean).join(" ")} Each rule uses one trigger.</p>
                {conditions.length > 0 && <p>Narrow a rule by {new Intl.ListFormat("en", { type: "disjunction" }).format(conditions)}.</p>}</>}</details>}
          </article>}
          {messages.map(message => {
            const currentReceipt = !retired && !historyView && (!message.conversationId || message.conversationId === conversation?.id)
              && message.evidenceId === decisionEvidenceId;
            const latestExplanation = message.who === "Studio" && !message.evidenceId && !!message.conversationId
              && message.conversationId === conversation?.id && messages.at(-1)?.id === message.id && reviewAllowed;
            return <article className={`rs-message ${message.who === "You" ? "rs-yours" : "rs-assistant"}`} data-conversation-message={!!message.conversationId || undefined} key={message.id}>
              <strong>{message.who === "Studio" ? "Daymark assistant" : message.who}</strong><p>{message.text}</p>{message.context && <details><summary>Earlier discussion included</summary><pre aria-label="Included earlier discussion">{message.context}</pre></details>}
              {message.evidenceId && (currentReceipt
                ? <button className="rs-link" disabled={!reviewAllowed} onClick={() => void openReview(undefined, "studio-saved-change")}>See proposed change</button>
                : <button data-evidence-link={message.evidenceId} disabled={!!busy} className="rs-link" onClick={() => void (inlineAvailable && message.evidenceId === failedEvidenceId
                  ? openReview(message.evidenceId) : showEvidence(message.evidenceId!))}>{message.evidenceId === latestCurrentEvidenceId ? "View checked examples" : "View earlier examples"}</button>)}
              {latestExplanation && <button className="rs-link" onClick={() => void openReview()}>Show example checks</button>}
            </article>;
          })}
          {retired && <article className="rs-message rs-decision" aria-label="Retired customization"><h3>This earlier customization is retired</h3>{state?.legacySelection && <p>Previously selected · unavailable to run</p>}<p>Its source, examples, discussion and history remain available to read. A new customization needs its own checks and approval.</p><button className="rs-primary" disabled={!!busy} onClick={createNew}>Start a new customization</button></article>}
          {historyView && !activeAuthoring && <article className="rs-message rs-decision"><p>Earlier discussion · read-only. These messages and examples cannot change or approve your current proposal.</p>
            <button disabled={!!busy || !!pendingTurn} onClick={returnToCurrent}>Return to current changes</button></article>}
          {conversation?.review && !eligibleOffer && <article className="rs-message"><p>These saved examples do not support approval of the current changes.</p>
            <button className="rs-link" disabled={!!busy || !trusted || !!pendingTurn} onClick={() => void (inlineAvailable && conversation.review!.evidenceId === failedEvidenceId
              ? openReview(conversation.review!.evidenceId) : showEvidence(conversation.review!.evidenceId))}>{conversation.review.evidenceId === latestCurrentEvidenceId ? "View checked examples" : "View earlier examples"}</button></article>}
          {conversation && !contextRecovery && ["CANCELLED", "BLOCKED", "INTERRUPTED"].includes(conversation.status) && <p role="status">{conversation.status === "BLOCKED" ? authoringReason(conversation.code) || authoringStatus.BLOCKED : `${authoringStatus[conversation.status]} ${authoringReason(conversation.code)}`}</p>}
          {["BUDGET_EXHAUSTED", "PROVIDER_RATE_LIMIT", "EXPIRED"].includes(conversation?.code ?? "") && !activeAuthoring && !staleConversation && !historyView && !retired && <button disabled={disabled || !authoring?.availability.available} onClick={continueSaved}>{conversation?.code === "PROVIDER_RATE_LIMIT" ? "Try again from saved work" : "Continue here from saved work"}</button>}
          {state?.extension && ownActive && !historyView && !staleConversation && <article className="rs-message">
            <p>{!trusted || !state.selection.eligible ? "Daymark couldn’t check which version is in use."
              : state.draft && state.draft.id !== ownActive.id ? "Your current setup is still on. Your proposed change is not on yet." : "This setup is in use."}</p>
            {state.draft && state.draft.id !== ownActive.id && checkedDraftSummary && <p>Examples for your proposal: {checkedDraftSummary}.</p>}
            {state.draft && state.draft.id !== ownActive.id && checkedActiveSummary && <p>Checked examples for your current setup: {checkedActiveSummary}.</p>}
            <button id="studio-view-active" className="rs-link" disabled={!!busy} onClick={() => void showActive()}>View what’s in use</button>
          </article>}

          {authoringError && <p role="alert">{authoringError}</p>}
          {recoveryError && <p role="alert">{recoveryError}</p>}
          {pendingTurn && <article className="rs-message"><strong>Submitted request</strong><p>{pendingTurn.text}</p></article>}
          {(authoringError || observationPaused || pendingTurn) && <div className="rs-recovery"><button disabled={!!busy} onClick={() => pendingTurn ? void submitAuthoring(pendingTurn, true) : void loadAuthoring()}>{!authoring && authoringError ? "Retry status" : "Check authoring status"}</button>
            {pendingTurn && retryTurn && !retired && <button disabled={!!busy} onClick={() => void submitAuthoring(pendingTurn)}>Retry submitted request</button>}</div>}
          <div className="rs-decision-brief">
          {showSavedBehavior && state?.draft && <article className="rs-sheet rs-inline-behavior" aria-label="About this rule">
            <p className="rs-kicker">{selectedDraft ? "What is on now" : state.approved ? "Approved · Not on yet" : "Proposed change · Not on"}</p>
            <h3 id="studio-saved-change" tabIndex={-1}>Summary</h3>
            {displayedRule?.scope && <p>{displayedRule.scope}</p>}
            {trigger && <dl className="rs-rule-facts">
              <div><dt>When</dt><dd>{displayedRule?.when ?? (beforeCreate ? "Before a new task is saved." : trigger === "tasks added" ? "A task is added." : "A task is completed.")}</dd></div>
              <div><dt>{beforeCreate ? "Stops saving when" : "Only when"}</dt><dd>{displayedRule?.onlyWhen ?? "The saved conditions can’t be summarized here."}</dd></div>
              <div><dt>{beforeCreate ? "Message" : "Then"}</dt><dd>{displayedRule?.then ?? (beforeCreate ? "See the example tasks and exact rule for its requirements." : "The saved action can’t be summarized here.")}</dd></div>
            </dl>}
            {displayedRule?.unchanged && <p className="rs-preserved">{displayedRule.unchanged}</p>}
            {displayedRule && !displayedRule.complete && <p className="muted">The full behavior could not be described. Check the examples and exact rule before deciding.</p>}
            {beforeCreate && <p>This rule can stop a new task from being added. Your rules for tasks added or completed run afterward.</p>}
            {displayedRule && <details className="rs-rule-details"><summary>Rule details</summary><p className="rs-rule-summary">{displayedRule.summary}</p></details>}
            {displayedRule?.timing && <p className="rs-timing">{displayedRule.timing}</p>}
            {summaryPending ? <p className="muted" role="status">Reading the saved rule…</p> : !fullWorkflowSummary && <p className="muted">A full summary of this rule is unavailable. {state.evidence
              ? "See which situations were checked and what happened in the simulation."
              : "Sample checks show what happens in the cases you try."}</p>}
            <div className="rs-summary-controls">
            {!sendDisabled && authoring?.availability.available && <button className="rs-link" onClick={() => document.getElementById("studio-message")?.focus()}>{trigger ? "Ask for a change" : "Ask about this rule"}</button>}
            {!state.evidence && !decisionEvidenceId && <p>This revision has no checked examples yet.</p>}
            {inlineAvailable && ((decisionEvidenceId || failedEvidenceId) ? <button className="rs-primary" disabled={disabled} onClick={() => void openReview()}>View simulation</button>
              : state.draft.suiteDigest || state.draft.kind === "prepared"
                ? <button className="rs-primary" disabled={disabled} onClick={() => void mutate("simulate", { revisionId: state.draft!.id, draftVersion: state.draftVersion }, "Example check saved.")}>
                  {ownActive && !selectedDraft ? "Check this revised change" : "Check examples"}</button>
                : <button disabled={sendDisabled || !authoring?.availability.available} onClick={() => document.getElementById("studio-message")?.focus()}>Discuss example checks</button>)}
            </div>
          </article>}
          {savedReview && state && <article id="studio-review" hidden={!inlineOpen} className="rs-sheet rs-review rs-inline-review" aria-label="Current decision">
            <h3 id="studio-review-heading" tabIndex={-1}>Simulation</h3>
            <p className="rs-review-status">{viewedInUse ? beforeCreate ? "On for new tasks" : "On for my tasks" : reviewLoading ? "Checking saved results…"
              : !viewedDraft || !inlineAvailable ? trigger ? "Earlier simulation · read-only" : "Earlier versions · read-only" : reviewError ? "Saved results unavailable for a decision" : viewingCurrentFailure ? "Check needs a correction"
              : !viewedCurrent || review !== reviewKey ? "Saved examples · read-only" : reviewedApproved ? "Approved · Not on yet" : "Results ready"}</p>
            {reviewError && <div role="alert"><p>{reviewError}</p>{(viewedCurrent || viewingCurrentFailure) && <button disabled={disabled} onClick={() => void openReview(savedReview.evidenceId)}>Check saved results again</button>}</div>}
            {!viewedCurrent && !viewingCurrentFailure && !viewedInUse && !reviewLoading && <p>Saved work or its use changed. These examples are read-only. Open the latest changes before making a decision.</p>}
            {beforeCreate && reviewEvidence && reviewEvidence.revisionId !== state.draft?.id && <p>This rule has changed since these examples were checked.</p>}
            {reviewEvidence && <>
              {inlineAvailable && viewedCurrent && reviewReady && review === reviewKey && !viewedInUse && canReview && <div className="rs-review-next">
                <p>{reviewedApproved ? "Approved. Turn it on separately when you are ready." : "Review the examples, then decide whether to approve. Approval does not turn it on."}</p>
                <button className="rs-link" onClick={() => {
                  const step = document.getElementById("studio-decision-step");
                  step?.focus({ preventScroll: true }); step?.scrollIntoView({ block: "center" });
                }}>{reviewedApproved ? "Go to turn on" : "Go to approval"}</button>
              </div>}
              <p className="muted">Example tasks; your tasks are unchanged.</p>
              {(viewedInUse || state.selection.revision && state.selection.generation === savedReview.selection.generation) && <p>{viewedInUse ? beforeCreate ? `“${savedReview.extension.name}” checks new tasks before saving. Actions after adding or completing keep their current selections.` : trigger ? `“${savedReview.extension.name}” is on for ${trigger}. This applies to future matching events.` : `“${savedReview.extension.name}” is now in use. New matching task completions can use this change. Turning it on does not complete or replay earlier tasks.`
                : trusted && state.selection.eligible ? state.selection.revision!.extensionId !== savedReview.extension.id
                  ? `Another customization is in use: “${state.selection.revision!.extensionName}”.`
                  : state.selection.revision!.id === savedReview.revision.id
                    ? "This version is in use from a different checked run."
                    : `A different version of “${savedReview.extension.name}” is in use.`
                  : "The saved selection could not be checked. Its use is unverified."}</p>}
              {beforeAfter(reviewEvidence)}
              {exampleOverview(reviewEvidence)}
              <section className="rs-inline-cases" aria-label="Checked proposed behavior" key={reviewEvidence.id}>
                {reviewEvidence.reports.map((item, index) => checkedExample(item, index, true, reviewEvidence))}
              </section>
              {simulationLimits(reviewEvidence)}
              {mainExample && savedReview.selection.revision && <button className="rs-link" disabled={!!busy} onClick={() => void showEvidence(savedReview.evidenceId)}>Inspect examples and what’s in use</button>}
              {viewingCurrentFailure && <div className="rs-decision-actions"><p>Discuss the correction, then check the examples again.</p><button className="rs-primary" disabled={sendDisabled || !authoring?.availability.available}
                onClick={() => document.getElementById("studio-message")?.focus()}>Ask for a correction</button></div>}
              {reviewedApproved && !viewedInUse && !executionUnavailable && <p>Turn on “{savedReview.extension.name}”{trigger ? ` for ${trigger}. ` : ""}{savedReview.selection.revision
                ? savedReview.selection.revision.extensionId !== savedReview.extension.id
                  ? trigger ? `This replaces “${savedReview.selection.revision.extensionName}” for this trigger.` : ` instead of “${savedReview.selection.revision.extensionName}”. Switching turns it off and keeps it saved.`
                  : trigger ? "This replaces the version currently in use." : ". This replaces the version currently in use." : trigger ? "" : " for your tasks."}</p>}
              {beforeCreate && reviewedApproved && !viewedInUse && !executionUnavailable && <p>This runs before saving a new task. Actions after adding or completing keep their current selections.</p>}
              {viewedInUse ? <p id="studio-use-confirmed" tabIndex={-1} role="status">This change is on. You can keep asking questions or describe your next change.</p>
                : inlineAvailable && viewedCurrent && reviewReady && review === reviewKey && <div id="studio-decision-step" tabIndex={-1} className="rs-decision-actions">{reviewedApproved
                  ? <button id="use-customization" className="rs-primary" disabled={reviewActionDisabled || executionUnavailable} onClick={() => {
                    if (reviewActionDisabled || executionUnavailable) return;
                    void mutate("activate", { revisionId: savedReview.revision.id, draftVersion: savedReview.draftVersion, generation: savedReview.selection.generation, evidenceId: savedReview.evidenceId },
                      `“${savedReview.extension.name}” is now in use. Your tasks have not changed.`, true);
                  }}>{trigger ? `Turn on for ${trigger}` : savedReview.selection.revision && savedReview.selection.revision.extensionId !== savedReview.extension.id ? "Switch to this customization" : "Turn on for my tasks"}</button>
                  : <><h4>Is this the change you want?</h4><p>Approval records your agreement to this proposal. It does not turn it on.</p><button className="rs-primary" disabled={reviewActionDisabled} onClick={() => {
                    if (reviewActionDisabled) return;
                    void mutate("approve", { revisionId: savedReview.revision.id, draftVersion: savedReview.draftVersion, evidenceId: savedReview.evidenceId },
                      "This change is approved and ready to turn on. Your current setup has not changed.");
                  }}>Approve this change</button></>}
                </div>}
              <details><summary>Technical details for this version</summary>
                <p>Revision: {savedReview.revision.id}</p><p>Evidence: {savedReview.evidenceId}</p>
                <pre aria-label="Exact checked examples">{JSON.stringify(reviewEvidence, null, 2)}</pre>
                {reviewSource && <>
                  <h4>Saved source</h4><pre aria-label="Saved source for approval">{reviewSource.source}</pre>
                  <h4>Compiled artifact</h4><pre aria-label="Compiled artifact for approval">{reviewSource.artifact}</pre>
                  <h4>Exact artifact pins</h4><pre aria-label="Artifact pins for approval">{JSON.stringify(reviewSource.pins, null, 2)}</pre>
                  <section aria-label="Saved expected examples for approval"><h4>Saved independent expected examples</h4>{reviewSource.cases.map((item, index) => <pre key={index} aria-label={`Saved example ${index + 1} for approval`}>{item}</pre>)}</section>
                </>}
              </details>
              {state.approved && newerEvidenceId && <button className="rs-link" disabled={!reviewAllowed} onClick={() => void openReview(newerEvidenceId)}>Review the newer checked examples</button>}
              {state.approved && failedEvidenceId && failedEvidenceId !== savedReview.evidenceId && <button className="rs-link" disabled={disabled} onClick={() => void openReview(failedEvidenceId)}>Inspect latest failed check</button>}
            </>}
            <button className="rs-link" onClick={hideInline}>Hide simulation</button>
          </article>}
          </div>
          <div ref={chatEnd} />
        </div>
        {newMessages && <button className="rs-new-messages" onClick={() => { const log = conversationScroller(); if (log) log.scrollTop = log.scrollHeight; followConversation.current = true; setNewMessages(false); }}>New messages ↓</button>}
          {contextRecovery && !retired && <article className="rs-message rs-decision rs-current-decision" aria-label="Continue saved work">
            <p role="status">{contextContinuation && activeAuthoring ? "Continuing from saved work. Waiting for accepted work to settle." : authoringReason("CONTEXT_LIMIT")}</p>
            <button className="rs-primary" disabled={disabled || !authoring?.availability.available} onClick={continueSaved}>Continue here from saved work</button>
          </article>}
          {restart && <article id="studio-restart-confirm" tabIndex={-1} className="rs-message rs-decision rs-current-decision" aria-label="Start from version in use">
            <div className="rs-restart-body">
            <h3>Start changes from this version?</h3><p>Version in use: {restart.activeLabel}. Saved changes: {restart.draftLabel}. You’ll start from the version in use. Your unfinished changes and their discussion will stay in History. Your current setup will keep running.</p>
            <details><summary>Saved version details</summary><p>Active revision: {restart.revisionId}</p><p>Saved draft version: {restart.draftVersion}</p><p>Selection generation: {restart.generation}</p></details>
            </div><div className="rs-restart-actions">
            <button className="rs-primary" disabled={disabled} onClick={() => void mutate("restart", { draftVersion: restart.draftVersion, revisionId: restart.revisionId, generation: restart.generation }, "New changes start from the version in use. Earlier changes and discussion remain in History. Check and approve this proposal before turning it on.")}>Start from this version</button>
            <button disabled={!!busy} onClick={() => { setRestart(null); document.getElementById("studio-view-active")?.focus(); }}>Cancel</button>
            </div>
          </article>}
        {!retired && !restart && authoring && !authoring.availability.available && ["AI_NOT_CONFIGURED", "AI_CONFIG_INVALID", "AI_CREDENTIALS_MISSING"].includes(authoring.availability.code ?? "") && <div className="rs-setup-notice"><p>Set up the assistant to create or change a customization.</p><button id="assistant-configure" onClick={openSetup}>Configure</button></div>}
        {!restart && authoring && !authoring.availability.available && !["AI_NOT_CONFIGURED", "AI_CONFIG_INVALID", "AI_CREDENTIALS_MISSING"].includes(authoring.availability.code ?? "") && <p className="rs-setup-notice" role="status">{authoringReason(authoring.availability.code)}</p>}
        {!restart && setupNotice && <p className="rs-setup-notice" role="status">{setupNotice}</p>}
        {activeAuthoring && <div className="rs-working" role="status"><span>{conversation?.status === "CANCELLING" ? "Stopping; waiting for accepted work to settle…" : "Working on your request…"}</span></div>}
        <form hidden={retired || historyView || !!restart} className="rs-composer" onSubmit={submit}><label className="sr-only" htmlFor="studio-message">Message to Daymark assistant</label>
          <textarea id="studio-message" maxLength={8192} rows={2} value={text} onFocus={() => { readingRevision.current++; }} onChange={e => { readingRevision.current++; editText(e.target.value); setStarterNotice(""); }} placeholder="Ask or describe a change…"
            onKeyDown={event => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              if (!event.repeat && !sendDisabled && authoring?.availability.available && text.trim() && !locked.current) event.currentTarget.form?.requestSubmit();
            }} />
          <button disabled={!authoring?.availability.available || sendDisabled || !text.trim()}>Send</button></form>
        {!retired && !restart && draftStorageUnavailable && draftText && <p className="rs-setup-notice" role="status">This browser could not keep this draft for reload. Your text is kept in this tab while you stay signed in.</p>}
        <p hidden={retired || !!restart} className="rs-chat-note">{authoring?.availability.available ? "Ask about this proposal or describe a change." : "You decide whether to approve and turn on a change."}</p>
      </section>
      <div hidden={!reviewOpen} className="rs-divider" role="separator" tabIndex={0} aria-label="Resize conversation and proposal" aria-orientation="vertical"
        aria-valuemin={limits.min} aria-valuemax={limits.max} aria-valuenow={width}
        onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault(); readingRevision.current++; setWidth(old => event.key === "Home" ? limits.min : event.key === "End" ? limits.max : Math.max(limits.min, Math.min(limits.max, old + (event.key === "ArrowLeft" ? -2 : 2))));
        } }}
        onPointerDown={event => { readingRevision.current++; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && room.current) {
          const bounds = room.current.getBoundingClientRect(); setWidth(Math.round(Math.max(limits.min, Math.min(limits.max, (event.clientX - bounds.left) / (bounds.width - 14) * 100))));
        } }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />
      <section hidden={!reviewOpen} className="rs-preview" aria-label="Customization preview">
        <button className="rs-close-review" onClick={closeReview}>Back to conversation</button>

      <section id="studio-canvas" ref={canvas} tabIndex={0} className="rs-canvas" aria-label="Customization and sample results"
        onWheel={() => { readingRevision.current++; }} onKeyDown={() => { readingRevision.current++; }} onPointerDown={() => { readingRevision.current++; }}
        onScroll={event => { if (reviewOpen) canvasScroll.current = event.currentTarget.scrollTop; }}>
        {state && <>
          {activeView && canvasView === "active" && activeSnapshot && <article className="rs-sheet" aria-label="Version in use">
            <h3>{activeSelectionMatches ? "Version currently in use" : "Previously viewed version"}</h3><p>{state.draft && state.draft.id !== activeSnapshot.revision.id && <>Your saved changes are separate. </>}This view is read-only.</p>
            {activeProof && activeSelectionMatches && state.selection.eligible ? <><p aria-label="Checked behavior in use">Checked examples in use: {activeProof.reports.length}. {summarizeExamples(activeProof)}.</p><p>These were example tasks; your real tasks have not changed. Other situations remain untested.</p></>
              : <p role="status">{activeSummaryError || "Checking the saved examples for this version…"}</p>}
            <button disabled={retired || disabled || !activeSelectionMatches || !state.selection.eligible} onClick={() => { setRestart({ draftVersion: state.draftVersion, revisionId: activeSnapshot.revision.id, generation: activeSnapshot.generation, activeLabel: checkedActiveSummary || "current setup; no verified checked description is available", draftLabel: checkedDraftSummary || `saved version ${state.draftVersion}; no verified checked description is available` }); closeReview(); }}>Start changes from this version</button>
            <button onClick={() => { setActiveView(false); closeReview(); }}>Return to proposal</button>
            <button className="rs-link" disabled={disabled} onClick={() => void inspectSource(activeSelectionMatches ? undefined : activeSnapshot.revision.id)}>Inspect this version’s source</button>
            <details><summary>Saved version details</summary><p>Label: {activeSnapshot.revision.label}</p><p>Revision: {activeSnapshot.revision.id}</p><p>Saved draft version: {state.draftVersion}</p></details>
          </article>}
          {evidence && <article hidden={canvasView !== "results"} className="rs-sheet rs-results" aria-label="Sample results">
            <h3 id="studio-results-heading" tabIndex={-1}>{!currentEvidence ? "Earlier examples" : exampleId ? exampleTitle(evidence.reports.find(item => item.id === exampleId)!, evidence.reports.findIndex(item => item.id === exampleId)) : "Saved checked examples"}</h3>
            <section aria-label="Expected and actual sample results">{evidence.reports.filter(item => !exampleId || item.id === exampleId).map((item, index) => <div className="rs-proof-comparison" key={item.id}>{currentProofExample(item)}<section aria-label="Saved proposed example"><h4>{currentEvidence ? "Saved example being inspected" : exampleTitle(item, index)}</h4>{checkedExample(item, index)}</section></div>)}</section>
            <p>{currentEvidence ? "Saved example for the current changes." : currentRevisionEvidence ? "Earlier saved check for these changes." : "Earlier example · this does not approve your current changes."} These were example tasks; your real tasks have not changed.</p>
            {evidence.reports.length > 1 && <details><summary>Other checked examples</summary>{evidence.reports.filter(item => item.id !== exampleId).map((item, index) => <p key={item.id}><button className="rs-link" onClick={() => {
              readingRevision.current++; setExampleId(item.id); canvasScroll.current = 0; if (canvas.current) canvas.current.scrollTop = 0;
              document.getElementById("studio-results-heading")?.focus({ preventScroll: true });
            }}>{exampleTitle(item, index)}</button></p>)}</details>}
            <details className="rs-example-details"><summary>Details</summary>
            <h4>Technical run details</h4>{evidence.reports.filter(item => !exampleId || item.id === exampleId).map(item => <pre key={item.id}>{JSON.stringify({ id: item.id, expected: item.expected, actual: item.report }, null, 2)}</pre>)}
            <h4>About these examples</h4><span>Saved sample run · {currentEvidence ? "Current proposal" : currentRevisionEvidence ? "Earlier run for current proposal" : "Earlier proposal"}</span>
              {currentRevisionEvidence && state.approved && evidence.id === state.approvedEvidenceId && <p>Approved run</p>}{currentRevisionEvidence && evidence.id === state.evidence?.id && <p>Latest run</p>}
              <p>These are made-up example tasks. Your tasks were not changed. Expected results were defined independently of this run. Only the listed cases are exercised; other inputs and situations remain untested.</p>
            <h4>Saved run identity</h4><p>Evidence: {evidence.id}</p><p>Revision: {evidence.revisionId}</p><pre>{JSON.stringify(evidence.identity, null, 2)}</pre>
            <h4>Exact saved simulation report</h4><pre aria-label="Saved synthetic simulation report">{JSON.stringify(evidence, null, 2)}</pre></details>

          </article>}

        </>}
        <section hidden={canvasView !== "details"} className="rs-sheet rs-tools" aria-label="Versions and settings">
          <h3 id="studio-more-heading" tabIndex={-1}>Versions and settings</h3>
          <section aria-label="What’s in use"><h3>What’s in use</h3><p>{currentUse}</p></section>
          <section aria-label="Earlier versions"><h3>Earlier versions</h3>
            {earlierVersions.map(item => <p key={item.id}>{item.label ?? "Saved draft"} · {item.revisionId === state?.selection.revision?.id
              ? state.selection.eligible ? "In use" : "Use could not be checked" : "Not in use"} · Read-only <button disabled={disabled} onClick={() => void inspectSource(item.revisionId!)}>View technical details</button></p>)}
            {!earlierVersions.length && <p>{historyNext !== null ? "No earlier versions are shown on this page." : "No earlier versions yet."}</p>}
            {historyNext !== null && <button disabled={!!busy} onClick={() => void earlierHistory()}>Load earlier versions</button>}
          </section>
          {state && !retired && <section aria-label="Restore an earlier version"><h3>Restore an earlier version</h3>
            <p>Restoring changes which version is used from now on. It does not undo tasks or earlier actions.</p>
            <label htmlFor="studio-restore">Previously in use</label><select id="studio-restore" value={restore} disabled={disabled} onChange={e => setRestore(e.target.value)}>
              <option value="">Choose an earlier version…</option>{state.restoreTargets.map((item, index) => <option key={item.id} value={item.id}>{item.label} · option {index + 1}</option>)}</select>
            {state.restoreTargetsNext && <button disabled={!!busy} onClick={() => void earlierSaved("restore-targets")}>Load earlier restore choices</button>}
            {restoreTarget && <div className="rs-restore-confirm"><p>Restore <strong>{restoreTarget.label}</strong> for future use? No task or earlier action is undone.</p>
              <button disabled={disabled || executionUnavailable} onClick={() => void mutate("rollback", { revisionId: restoreTarget.id, generation: state.selection.generation }, `Restored ${restoreTarget.label} for your tasks.`, true)}>Restore {restoreTarget.label} for me</button></div>}
          </section>}
          <details className="rs-developer-tools" ref={developerTools}><summary>Developer tools</summary>
          <p>Technical information for setup and troubleshooting.</p>
          <details><summary>Published host model and supported hooks</summary>
            {catalogError && <p role="status">The published host model could not be checked. <button onClick={() => void readHostCatalog()}>Try again</button></p>}
            {hostCatalog && <>
              <p>This is Daymark’s published host contract. A saved revision’s exact pins appear with its source; the current model does not certify historical compatibility.</p>
              <pre aria-label="Published host hooks">{JSON.stringify(hostCatalog.hooks, null, 2)}</pre>
              <pre aria-label="Published host model identity">{JSON.stringify({ ...hostCatalog.model, dcm: undefined }, null, 2)}</pre>
              <pre aria-label="Published host DCM">{hostCatalog.model.dcm}</pre>
            </>}
          </details>
          <section className="rs-authoring" aria-label="AI authoring">
            <h3>Authoring status</h3>
            {conversation && <p role="status">{authoringStatus[conversation.status]} {authoringReason(conversation.code)}</p>}
            {!authoringError && !observationPaused && !pendingTurn && <button disabled={!!busy} onClick={() => void loadAuthoring()}>Check authoring status</button>}
          </section>
          <section aria-label="Assistant setup"><h3>Assistant setup</h3><button onClick={openSetup}>Configure</button></section>
          {state && <>
          {state.selection.revision && <p>Current choice provenance: {state.selection.revision.provenance === "operator" ? "Operator-provided starting choice" : "Your approved choice"}</p>}
          {(inspectionRevision || inspection?.historical) && <section aria-label="Saved program">
            {inspectionRevision && <button disabled={disabled} onClick={() => void inspectSource()}>Inspect saved source and examples</button>}
            {inspection && (inspection.historical || inspection.key === inspectionKey) && <>
              {inspection.historical && <h3 id="studio-inspected-history" tabIndex={-1}>Earlier versions · read-only</h3>}
              {inspection.historical && <p>{inspection.revisionId === state.selection.revision?.id ? "This is the saved selection." : "These earlier changes are not in use."} {currentUse} Opening this history does not change what runs.</p>}
              <p>Exact saved revision: {inspection.revisionId}. {inspection.historical ? "These earlier changes stay in History. They cannot approve, activate or replace your current changes." : "Inspection is read-only."}</p>
              <h3 id="studio-inspected-source" tabIndex={-1}>Saved source</h3><pre aria-label="Saved source for inspection">{inspection.source}</pre>
              <h3>Exact compiled artifact</h3><pre aria-label="Compiled artifact for inspection">{inspection.artifact}</pre>
              <h3>Exact artifact pins</h3><pre aria-label="Artifact pins for inspection">{JSON.stringify(inspection.pins, null, 2)}</pre>
              <h3>Saved independent examples</h3>
              {inspection.cases.length ? inspection.cases.map((item, index) => <pre key={index} aria-label={`Saved example ${index + 1} for inspection`}>{item}</pre>) : <p>Independent examples have not been saved for this source.</p>}
              <p>Inspection is read-only. Approval still requires eligible sample results and a separate decision.</p>
            </>}
          </section>}
          {!!state.evidenceHistory.length && <details className="rs-sheet rs-secondary"><summary>Saved sample runs</summary>
            <p>Open a server-held run to inspect its original results. Earlier runs do not approve a new proposal.</p>
            <ol>{state.evidenceHistory.map((item, index) => <li key={item.id}>
              <button disabled={!!busy} onClick={() => void showEvidence(item.id)}>Open saved sample run {index + 1}</button>
              <small>{!retired && item.revisionId === state.draft?.id && item.id === state.evidence?.id ? "Current proposal" : "Earlier run"} · revision {item.revisionId}</small>
            </li>)}</ol>
            {state.evidenceHistoryNext && <button disabled={!!busy} onClick={() => void earlierSaved("evidence")}>Load earlier sample runs</button>}
          </details>}
          <details className="rs-sheet rs-secondary"><summary>All versions</summary>
            <p>Saved versions are read-only. Eligible previously used versions can be restored above.</p>
            <ol>{revisions.map(item => <li key={item.id}>{item.label} · {item.id} · read-only <button disabled={!!busy} onClick={() => void inspectSource(item.id)}>Inspect saved version</button></li>)}</ol>
            {revisionsNext !== null && <button disabled={!!busy} onClick={() => void earlierSaved("revisions")}>{revisionsNext === undefined ? "Load saved versions" : "Load earlier saved versions"}</button>}
          </details>
            {restoreTarget && <details><summary>Exact choice to restore</summary><p>Revision: {restoreTarget.id}</p><p>Provenance: {restoreTarget.provenance}</p><pre>{JSON.stringify(restoreTarget.pins, null, 2)}</pre></details>}
            <details><summary>Selection history and exact identities</summary><p>Current generation: {state.selection.generation}</p>
              <ol>{history.map(item => <li key={item.id}>{item.operation === "draft-superseded" ? "Earlier versions" : item.operation} · {item.label ?? ""} · generation {item.generation} · {item.revisionId ?? "Off"}</li>)}</ol>
              {historyNext !== null && <button disabled={!!busy} onClick={() => void earlierHistory()}>Load earlier selections</button>}
              <h4>Saved selection identity</h4><pre>{JSON.stringify(state.selection.revision?.pins ?? {}, null, 2)}</pre>
              <h4>Proposed identity</h4><pre>{JSON.stringify(state.draft?.pins ?? {}, null, 2)}</pre>
            </details>
        </>}
        <details className="rs-lookup"><summary>Open a saved sample run by ID</summary><form onSubmit={event => { event.preventDefault(); void showEvidence(lookup); }}>
          <label htmlFor="studio-evidence">Evidence ID for this person</label><input id="studio-evidence" maxLength={160} value={lookup} onChange={e => setLookup(e.target.value)} />
          <button disabled={!!busy || !lookup.trim()}>Open saved sample run</button></form></details>
        <button className="rs-reload" onClick={() => void refresh(true)} disabled={!!busy}>Reload saved state</button>
          </details>
        </section>
      </section>
      </section>
    </div>
    {setupOpen && <AssistantSetup request={request} close={closeSetup} beginSave={() => { ++setupGeneration.current; }} saved={next => {
      setAuthoring(old => old ? { ...old, availability: next.availability } : old);
      setSetupNotice("Settings saved. Send a message when you’re ready.");
      if (extensionId.current && !historyMode.current) void loadAuthoring();
      if (reviewOpen) closeReview();
      closeSetup();
    }} />}
  </section>;
}
