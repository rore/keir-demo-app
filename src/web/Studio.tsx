import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import "./Studio.css";

type Revision = { id: string; templateId: string; kind?: "authored" | "prepared"; suiteDigest?: string | null; label: string; pins: object; provenance: "operator" | "customer" };
type History = { id: number; generation: number; operation: string; revisionId: string | null; label?: string | null };
export type State = {
  retired?: boolean;
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
export type Collection = { items: Pick<State, "extension" | "draftVersion" | "draft" | "approved" | "requestExcerpt" | "retired">[]; owner: State["owner"]; selection: State["selection"]; catalog: State["catalog"]; executionAvailability?: State["executionAvailability"]; next: string | null };
export type StudioTarget = { extensionId: string | null; conversationId?: string | null; recoveryId?: string; history?: boolean };
type HostCatalog = {
  hooks: { id: string; label: string; description: string; effect: string; trigger: string }[];
  model: { dcm: string; digest: string; profile: string; hook: string; consumer: object; compiler: unknown };
};
type Outcome = { classification: string; code?: string; error?: { code: string }; consumption?: { status: "DISPLAYED" | "NOT_DISPLAYED"; code?: string } };
type TaskPreview = { id?: string; title: string; status?: "OPEN" | "COMPLETED"; projectId?: string; projectName?: string };
type EffectObservation = { effect: "CONFIRMED" | "NONE" | "UNKNOWN" | "NOT_OBSERVED"; createdTasks: TaskPreview[] | null };
type SavedSource = { revisionId: string; source: string; artifact: string; pins: object; cases: string[]; suiteDigest: string | null };
type Evidence = { id: string; revisionId: string; kind?: "authored" | "prepared"; identity: object; passed: boolean; reports: {
  id: string; label: string; expected: { createdTasks?: TaskPreview[] | null; [key: string]: unknown }; taskStatus?: "OPEN" | "COMPLETED" | null; readFailure?: "TASK_NOT_FOUND" | "ACCESS_DENIED" | "TRANSIENT_FAILURE" | null;
  report: { status: string; scenario?: { task: TaskPreview }; observed?: EffectObservation; native?: Outcome; calls?: { capability: string }[]; consumption?: { status: string; code?: string }; mismatches: object[] };
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
export function pendingGuidedRequests(ownerId: string) {
  const entries: { entryId: string; operationId: string; personal: boolean }[] = [];
  const prefix = "daymark-studio-work:" + ownerId + ":";
  try {
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index)!;
      if (!key.startsWith(prefix) || !key.endsWith(":example")) continue;
      const entryId = key.slice(prefix.length, -8);
      if (!/^[0-9a-f-]{36}$/i.test(entryId)) continue;
      let value;
      try { value = JSON.parse(sessionStorage.getItem(key)!); } catch { continue; }
      if (!value || !/^[0-9a-f-]{36}$/i.test(value.operationId) || typeof value.personal !== "boolean") continue;
      entries.push({ entryId, operationId: value.operationId, personal: value.personal });
    }
  } catch { /* Tab storage can be unavailable. */ }
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
  AWAITING_USER: "Your answer is needed before authoring can continue.", REVIEW_AVAILABLE: "Your saved proposal is ready to inspect. Approval and Use are your separate decisions.",
  CANCELLED: "Authoring stopped. Saved work remains available.", BLOCKED: "Authoring could not continue. Saved work remains available.",
  INTERRUPTED: "Authoring was interrupted. Check saved state before explicitly continuing.",
};
function authoringReason(code: string | null | undefined) {
  if (!code) return "";
  if (code === "LEGACY_CUSTOMIZATION_RETIRED") return "This earlier customization is retired. Its saved work is read-only; start a new customization for task creation.";
  if (["AI_NOT_CONFIGURED", "AI_CONFIG_INVALID", "AI_CREDENTIALS_MISSING"].includes(code)) return "AI authoring is not configured.";
  if (code === "SPEND_LIMIT") return "The shared authoring allowance is exhausted. Saved work and review remain available.";
  if (["BUDGET_EXHAUSTED", "EXPIRED"].includes(code)) return "An earlier authoring policy stopped this saved run. Your discussion, proposal and examples are kept. You can explicitly continue here under the current settings and shared allowance.";
  if (code === "PROVIDER_RATE_LIMIT") return "Your AI provider reached a request or account limit. Your discussion and any saved draft are kept. Check provider usage or explicitly try again later. Nothing is retried automatically.";
  if (code === "CONTEXT_LIMIT") return "This run reached the assistant’s request size boundary. Progress is saved. Explicitly continue here to use the current saved proposal and recent discussion; nothing is sent automatically.";
  if (code === "CONFIG_CHANGED") return "Assistant settings changed. Your message is kept. Send it again when you’re ready.";
  if (code === "CONVERSATION_LIMIT") return "An earlier authoring policy stopped this request. Your saved conversations remain available.";
  if (["STALE_CONTEXT", "STALE_DRAFT", "STALE_CONVERSATION", "CHECKPOINT_UNCERTAIN"].includes(code)) return "The request needs saved-state readback before another change. No approval or activation is implied.";
  if (code === "REVIEW_NOT_READY") return "The saved examples do not yet support approval. Inspect their results or discuss the correction.";
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
  recoveryKey: string;
  targeted: (target: StudioTarget) => void;
  unavailable: () => void;
  task?: { title: string; status: "open" | "completed" };
};
const knownTask = (task?: TaskPreview) => !!task && typeof task.title === "string" && !!task.title.trim() && typeof task.projectId === "string" && !!task.projectId;
const knownScenarioTask = (task?: TaskPreview) => !!task && typeof task.id === "string" && !!task.id && typeof task.title === "string" && !!task.title.trim();
const knownTasks = (tasks?: TaskPreview[] | null) => Array.isArray(tasks) && tasks.every(knownTask);
const knownObservation = (value?: EffectObservation) => !!value && knownTasks(value.createdTasks)
  && (value.effect === "CONFIRMED" && !!value.createdTasks!.length || value.effect === "NONE" && value.createdTasks!.length === 0);
const taskNames = (tasks: TaskPreview[]) => tasks.map(task => `“${task.title}” in ${task.projectName ? `“${task.projectName}”` : "the chosen project"}`).join(", ");
const observedTasks = (value?: EffectObservation) => !knownObservation(value) ? value?.effect === "UNKNOWN" ? "A task may have been created; this check did not confirm it." : "No task-creation result was observed."
  : value!.createdTasks!.length ? `Created ${taskNames(value!.createdTasks!)}.` : "No task was created.";
const expectedTasks = (value: Evidence["reports"][number]["expected"]) => value.createdTasks === null ? "An uncertain result: a task may or may not be created." : !knownTasks(value.createdTasks) ? "The expected task result was not recorded."
  : value.createdTasks!.length ? `Create ${taskNames(value.createdTasks!)}.` : "Create no task.";
const checkedUncertainty = (item: Evidence["reports"][number]) => item.expected.createdTasks === null && item.report.observed?.effect === "UNKNOWN" && item.report.observed.createdTasks === null;
const checkedObservation = (item: Evidence["reports"][number]) => knownScenarioTask(item.report.scenario?.task) && (knownTasks(item.expected.createdTasks) && knownObservation(item.report.observed) || checkedUncertainty(item));
const summarizeExamples = (proof: Evidence | null) => [...new Set(proof?.reports.filter(checkedObservation).map(item => observedTasks(item.report.observed).replace(/\.$/, "")) ?? [])].join("; ");

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
    if (!/^\d+(?:\.\d{1,6})?$/.test(maxUsd) || !Number.isSafeInteger(micros) || micros <= 0) return reject("allowance", "Enter a positive USD allowance with up to six decimal places.");
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
        : code === "SPEND_LIMIT" ? "Settings were not saved. The total allowance must cover previous reservations. Re-enter the key before explicitly saving a larger total allowance."
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
          <p>Current settings: {setup.configuration.provider ? setup.configuration.provider + " / " + setup.configuration.model + " · " + setup.configuration.maxUsd + " USD total" : "Not configured"}. Saving a key does not establish that it works.</p>
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
          <p id="assistant-allowance-help">This is the total lifetime allowance, not added credit. Each service request reserves allowance, including interrupted or cancelled work. Previous reservations are retained; requests stop when the allowance runs out.</p>
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

function CustomizationName({ ownerId, itemId, name, disabled, request, saved }: {
  ownerId: string; itemId: string; name: string; disabled: boolean; request: Props["request"]; saved: (value: State) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [expectedName, setExpectedName] = useState(name);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null), button = useRef<HTMLButtonElement>(null);
  const untitled = name === "Untitled customization";
  const nameAction = untitled ? "Name this customization" : "Rename";
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
    }}>{untitled ? <><span className="rs-full-label">{nameAction}</span><span className="rs-short-label">Add name</span></> : nameAction}</button>
    {editing && <form className="rs-rename-form" aria-label="Rename customization" onSubmit={event => void submit(event)} onKeyDown={event => {
      if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) { event.preventDefault(); return; }
      if (composing.current || event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); close(); }
    }}>
      <label htmlFor="studio-customization-name">Name</label><input ref={input} id="studio-customization-name" value={value} maxLength={160} disabled={saving} onChange={event => setValue(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} aria-describedby={error ? "studio-name-error" : undefined} />
      <button disabled={saving || disabled}>Save</button><button type="button" disabled={saving} onClick={close}>Cancel</button>
      {error && <p id="studio-name-error" role="alert">{error}</p>}
    </form>}
  </>;
}

export default function Studio({ request, changed, beforeSelectionChange, back, backToTasks, createNew, backLabel, target, ownerId, recoveryKey, targeted, unavailable, task }: Props) {
  const initialTarget = useRef(target);
  const extensionId = useRef(target.extensionId);
  const requestedConversation = useRef<string | null>(null);
  const historyMode = useRef(target.history === true || !!(target.extensionId && target.conversationId));
  const [historyView, setHistoryView] = useState(historyMode.current);
  const [entry, setEntry] = useState(target.extensionId || target.conversationId ? "item" : "start");
  const [hostCatalog, setHostCatalog] = useState<HostCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [activeView, setActiveView] = useState(false);
  const [activeSnapshot, setActiveSnapshot] = useState<{ ownerId: string; extensionId: string; revision: NonNullable<State["selection"]["revision"]>; generation: number; evidenceId: string | null } | null>(null);
  const [activeProof, setActiveProof] = useState<Evidence | null>(null);
  const [activeSummaryError, setActiveSummaryError] = useState("");
  const [restart, setRestart] = useState<{ draftVersion: number; revisionId: string; generation: number; activeLabel: string; draftLabel: string } | null>(null);
  const [pendingExample, setPendingExample] = useState(() => pendingGuidedRequests(ownerId).find(item => recoveryKey.endsWith(":" + item.entryId)) ?? null);
  const [recoveryError, setRecoveryError] = useState("");
  const [deleted, setDeleted] = useState(false);
  const deletedTitle = useRef<HTMLHeadingElement>(null);
  const deletedRef = useRef(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupNotice, setSetupNotice] = useState("");
  const setupInvoker = useRef<HTMLElement | null>(null);
  const setupGeneration = useRef(0);
  const [reviewOpen, setReviewOpen] = useState(false);
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
  const [reviewError, setReviewError] = useState("");
  const [inspection, setInspection] = useState<(SavedSource & { key: string; historical: boolean }) | null>(null);
  const [restore, setRestore] = useState("");
  const [lookup, setLookup] = useState("");
  const [text, setText] = useState("");
  const [authoring, setAuthoring] = useState<Authoring | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [authoringError, setAuthoringError] = useState("");
  const [contextContinuation, setContextContinuation] = useState<{ conversationId: string; expectedVersion: number } | null>(null);
  const [pendingTurn, setPendingTurn] = useState<Turn | null>(() => pendingRequests(ownerId).find(item => recoveryKey.endsWith(":" + item.entryId))?.turn ?? null);
  const [retryTurn, setRetryTurn] = useState(false);
  const [observationPaused, setObservationPaused] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const authoringLifetime = useRef(new AbortController());
  const [width, setWidth] = useState(52);
  const [pane, setPane] = useState<"conversation" | "preview">("conversation");
  const [canvasView, setCanvasView] = useState<"active" | "results" | "details" | "review">("active");
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
  const chatEnd = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLElement>(null);
  const canvasScroll = useRef(0);
  const managementReturn = useRef<{ view: typeof canvasView; position: number } | null>(null);
  const readingAnchor = useRef<{ element: HTMLElement; top: number; revision: number } | null>(null);
  const reviewInvoker = useRef<HTMLElement | null>(null);
  const conversationReturn = useRef(0);
  const evidenceReturn = useRef<string | null>(null);
  const followConversation = useRef(true);
  const readingRevision = useRef(0);
  const messageId = useRef(0);
  const initialized = useRef(false);
  const focusUse = useRef<{ view: number; focus: number; target: string } | null>(null);
  const [limits, setLimits] = useState({ min: 30, max: 70 });
  const mounted = useRef(false);
  const locked = useRef(false);
  const serial = useRef(0);
  const callbacks = useRef({ request, changed, beforeSelectionChange, targeted, unavailable });
  callbacks.current = { request, changed, beforeSelectionChange, targeted, unavailable };
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
  function deletedOutcome(failure: unknown, kind: "turn" | "example", operationId: string) {
    const problem = failure as { status?: number; code?: string };
    if (problem?.status !== 410 || problem.code !== "CUSTOMIZATION_DELETED") return false;
    const key = recoveryKey + (kind === "example" ? ":example" : "");
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (saved?.operationId === operationId) sessionStorage.removeItem(key);
    } catch { setRecoveryError("This browser could not clear the matching recovery entry. Returning to it will check the same saved outcome."); }
    if (kind === "turn") setPendingTurn(old => old?.operationId === operationId ? null : old);
    else setPendingExample(old => old?.operationId === operationId ? null : old);
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
  const executionUnavailable = state?.executionAvailability?.available === false;
  const offer = conversation?.review;
  const eligibleOffer = !historyView && !conversation?.retired && offer?.eligible === true && !!state?.draft && offer.revisionId === state.draft.id
    && offer.draftVersion === state.draftVersion && offer.suiteDigest === state.draft.suiteDigest
    && conversation?.extensionId !== null;
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
  const decisionObservationsKnown = !!reviewEvidence?.reports.length && reviewEvidence.reports.every(checkedObservation);
  const viewedEvidenceEligible = !!savedReview && (state?.approved && state.approvedEvidenceId === savedReview.evidenceId
    || state?.evidence?.id === savedReview.evidenceId && state.evidence.passed
    || eligibleOffer && offer?.evidenceId === savedReview.evidenceId);
  const viewedCurrent = !retired && !!savedReview && trusted && state?.owner.id === savedReview.owner.id && state.extension?.id === savedReview.extension.id
    && state.draft?.id === savedReview.revision.id && state.draftVersion === savedReview.draftVersion
    && (state.draft.suiteDigest ?? null) === savedReview.suiteDigest && state.selection.generation === savedReview.selection.generation && viewedEvidenceEligible;
  const canReview = viewedCurrent && !reviewLoading && reviewEvidence?.id === savedReview?.evidenceId
    && reviewEvidence?.revisionId === savedReview?.revision.id && reviewEvidence?.passed && decisionObservationsKnown;
  const activeAuthoring = running(conversation);
  const legacyConversation = !!conversation && conversation.extensionId === null;
  const staleConversation = !!conversation && !!state?.extension && (conversation.extensionId !== state.extension.id
    || conversation.draft.draftVersion !== state.draftVersion || conversation.draft.revisionId !== (state.draft?.id ?? null)
    || conversation.draft.suiteDigest !== (state.draft?.suiteDigest ?? null));
  const contextRecovery = (conversation?.status === "BLOCKED" && conversation.code === "CONTEXT_LIMIT"
    || !!contextContinuation && contextContinuation.conversationId === conversation?.id)
    && !legacyConversation && !staleConversation && !historyView;
  const earlierMessagesFailed = messagePageError?.scope === messageHistory.current?.scope && messagePageError?.before === messagesBefore;
  const disabled = !!busy || !trusted || activeAuthoring || !!pendingTurn || !!pendingExample;
  const sendDisabled = retired || disabled || legacyConversation || historyView || activeView;
  const reviewReady = !!savedReview && (savedReview.revision.kind !== "authored" || !!reviewSource && reviewSource.key === review
    && reviewSource.ownerId === savedReview.owner.id && reviewSource.revisionId === savedReview.revision.id && reviewSource.suiteDigest === savedReview.suiteDigest);
  const reviewedApproved = viewedCurrent && !!state?.approved && state.approvedEvidenceId === savedReview?.evidenceId && review === reviewKey;
  const reviewAllowed = !retired && !!decisionEvidenceId && !!state?.draft && !disabled && !legacyConversation && !staleConversation && !historyView
    && !contextRecovery && !restart;
  const newerEvidenceId = state?.evidence?.passed && state.evidence.id !== savedReview?.evidenceId ? state.evidence.id : null;
  const latestReviewAvailable = !!savedReview && (!viewedCurrent || !!newerEvidenceId);
  const viewedInUse = !!savedReview && trusted && state?.owner.id === savedReview.owner.id && state.extension?.id === savedReview.extension.id
    && state.selection.eligible && state.selection.revision?.id === savedReview.revision.id
    && state.selection.approvedEvidenceId === savedReview.evidenceId;
  const reviewActionDisabled = disabled || !canReview || !reviewReady || review !== reviewKey || !reviewAllowed;
  const exampleLabel = (item: Evidence["reports"][number], index: number) => {
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
  const mainExample = reviewEvidence?.reports.find(item => item.expected.createdTasks?.length) ?? reviewEvidence?.reports[0];
  const behaviorSummary = summarizeExamples(reviewEvidence);
  const activeSelectionMatches = !!activeSnapshot && activeSnapshot.ownerId === state?.owner.id && activeSnapshot.extensionId === state.extension?.id
    && activeSnapshot.revision.id === state.selection.revision?.id && activeSnapshot.generation === state.selection.generation
    && activeSnapshot.evidenceId === state.selection.approvedEvidenceId;
  const checkedDraftSummary = canReview && reviewReady && review === reviewKey ? behaviorSummary : "";
  const checkedActiveSummary = activeProof && activeSelectionMatches && state?.selection.eligible ? summarizeExamples(activeProof) : "";

  function checkedExample(item: Evidence["reports"][number], index: number) {
    const source = item.report.scenario?.task, observed = knownObservation(item.report.observed), expected = knownTasks(item.expected.createdTasks);
    const readFailure = observed && item.report.observed?.effect === "NONE" && Array.isArray(item.report.calls)
      && item.report.calls.at(-1)?.capability === "tasks.get" ? item.report.native?.error?.code : undefined;
    const readExplanation = readFailure === "TASK_NOT_FOUND" ? " The source task could not be found."
      : readFailure === "ACCESS_DENIED" ? " The source task could not be checked because access was denied."
      : readFailure === "ADAPTER_TRANSIENT" ? " The source task was temporarily unavailable." : "";
    return <article className="rs-example" key={item.id} aria-label={"Example: " + exampleLabel(item, index)}>
      {knownScenarioTask(source) ? <div className="rs-example-task"><span className="rs-task-mark" aria-hidden="true">{source!.status === "COMPLETED" ? "✓" : "○"}</span><div><small>Example task · {source!.projectName ?? (source!.projectId ? "Example project" : "Project not observed")}</small><h4>{source!.title}</h4><p>{source!.status === "COMPLETED" ? "Completed" : source!.status === "OPEN" ? "Unfinished" : "Status not recorded"}</p></div></div>
        : <p>Earlier saved example · the task situation was not recorded in this format.</p>}
      <dl><div><dt>You wanted</dt><dd>{expectedTasks(item.expected)}</dd></div><div><dt>In this example</dt><dd>{observedTasks(item.report.observed)}{readExplanation}</dd></div></dl>
      {observed && item.report.observed?.effect === "CONFIRMED" && item.report.observed.createdTasks?.map((task, taskIndex) => <div className="rs-created-example" key={taskIndex}><small>Example created task</small><strong>{task.title}</strong><p>{task.projectName ?? "Example project"}</p></div>)}
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
    const selected = canvasView === "review" ? savedReview?.selection : state?.selection;
    if (!comparison && !selected?.revision) return <p className="rs-no-current-proof">No customization is currently in use.</p>;
    const sameSelection = !!state && comparison && comparison.selection.revision?.id === state.selection.revision?.id && comparison.selection.generation === state.selection.generation
      && comparison.selection.approvedEvidenceId === state.selection.approvedEvidenceId && state.selection.eligible;
    const matching = comparison?.proof.reports.find(item => JSON.stringify(item.report.scenario?.task) === JSON.stringify(proposed.report.scenario?.task));
    return <section aria-label="Checked behavior currently in use"><h4>{comparison && !sameSelection ? "Earlier version viewed in use" : "Currently in use"}</h4>
      {comparison ? matching ? checkedExample(matching, comparison.proof.reports.indexOf(matching)) : <><p>No saved check covers this same task situation.</p><details><summary>Last checked examples for this version</summary>{comparison.proof.reports.map(checkedExample)}</details></>
        : <p role="status">{comparisonError}</p>}
      {comparison && !sameSelection && <p>What’s in use changed. These are the original saved examples; reopen to check the current selection.</p>}
    </section>;
  }

  function openPane(next?: typeof canvasView, invoker = document.activeElement) {
    const intent = ++viewIntent.current, focus = ++focusIntent.current;
    currentPane.current = { open: true, view: next ?? canvasView };
    if (next && next !== "review") setReviewLoading(false);
    ++readingRevision.current;
    if (next && managementReturn.current?.view === next) canvasScroll.current = managementReturn.current.position;
    else if (next && next !== canvasView) canvasScroll.current = 0;
    if (next) managementReturn.current = null;
    const position = canvasScroll.current;
    if (!reviewOpen || invoker instanceof HTMLElement && invoker.closest(".rs-chat")) {
      reviewInvoker.current = invoker instanceof HTMLElement ? invoker : null;
      conversationReturn.current = chatEnd.current?.parentElement?.scrollTop ?? 0;
      followConversation.current = false;
    }
    if (next) setCanvasView(next);
    setReviewOpen(true); setPane("preview");
    requestAnimationFrame(() => {
      if (!mounted.current || viewIntent.current !== intent || focusIntent.current !== focus) return;
      if (next !== "details") room.current?.querySelector<HTMLElement>(next === "review" ? "#studio-review-heading" : next === "results" ? "#studio-results-heading" : "#studio-canvas")?.focus({ preventScroll: true });
      if (canvas.current) canvas.current.scrollTop = position;
      canvasScroll.current = position;
    });
    return intent;
  }
  function closeReview() {
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
      if (chatEnd.current?.parentElement) chatEnd.current.parentElement.scrollTop = conversationReturn.current;
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
    const intent = openPane("details"), focus = focusIntent.current;
    requestAnimationFrame(() => {
      if (!mounted.current || viewIntent.current !== intent || !currentPane.current.open || currentPane.current.view !== "details") return;
      const details = room.current?.querySelector<HTMLDetailsElement>(".rs-tools");
      if (details) { details.open = true; if (focusIntent.current === focus) details.querySelector("summary")?.focus({ preventScroll: true }); }
    });
  }

  function say(text: string, who: Message["who"] = "Studio", evidenceId?: string, exampleCount?: number) {
    const id = ++messageId.current;
    setMessages(old => {
      const next = [...old, { id, who, text, evidenceId, exampleCount }];
      const recentManual = new Set(next.filter(item => typeof item.id === "number").slice(-40).map(item => item.id));
      return next.filter(item => typeof item.id === "string" || recentManual.has(item.id));
    });
  }
  function apply(next: State) {
    if (next.owner.id !== ownerId || next.extension?.id !== extensionId.current && !(next.extension === null && extensionId.current === null)) throw new Error("Customization identity mismatch");
    setRestart(null);
    const bounds = canvas.current?.getBoundingClientRect();
    const visible = bounds && bounds.height > 0 ? Array.from(canvas.current!.querySelectorAll<HTMLElement>(".rs-example")).filter(row => {
      const rect = row.getBoundingClientRect(); return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
    }) : [];
    const anchor = visible.find(row => row.closest("details[open]")) ?? visible[0];
    readingAnchor.current = anchor ? { element: anchor, top: anchor.getBoundingClientRect().top, revision: readingRevision.current } : null;
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
    if (anchor && anchor.revision === readingRevision.current && anchor.element.isConnected && canvas.current) {
      // Saved-state labels may change above the row being inspected after an awaited response.
      canvas.current.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
      canvasScroll.current = canvas.current.scrollTop;
    }
  }, [state]);
  async function openReview(evidenceId?: string) {
    const proofId = evidenceId ?? decisionEvidenceId;
    if (!state?.draft || !state.extension || !reviewAllowed || !proofId) return;
    const snapshot: SavedReview = structuredClone({ owner: state.owner, extension: state.extension, revision: state.draft,
      draftVersion: state.draftVersion, evidenceId: proofId, suiteDigest: state.draft.suiteDigest ?? null, selection: state.selection });
    const key = `${snapshot.owner.id}/${snapshot.extension.id}/${snapshot.revision.id}/${snapshot.draftVersion}/${proofId}`;
    const same = review === key && reviewReady && savedReview?.suiteDigest === snapshot.suiteDigest
      && savedReview.selection.generation === snapshot.selection.generation;
    const load = ++reviewLoad.current;
    setSavedReview(snapshot);
    if (!same) { setReviewEvidence(null); setReviewSource(null); setReview(""); canvasScroll.current = 0; }
    setReviewError(""); setReviewLoading(true);
    setActiveView(false);
    const intent = openPane("review");
    const position = canvasScroll.current, reading = readingRevision.current;
    const current = () => mounted.current && !authoringLifetime.current.signal.aborted && reviewLoad.current === load
      && viewIntent.current === intent && currentPane.current.open && currentPane.current.view === "review"
      && extensionId.current === snapshot.extension.id && ownerId === snapshot.owner.id;
    try {
      const proof = await callbacks.current.request<Evidence>(`${extensionPath(snapshot.extension.id)}/evidence/${encodeURIComponent(proofId)}`, "GET", undefined, authoringLifetime.current.signal);
      if (!current()) return;
      if (!proof.passed || !proof.reports.length || !proof.reports.every(checkedObservation) || proof.revisionId !== snapshot.revision.id || proof.id !== proofId
        || !(proof.id === state.evidence?.id && state.evidence.passed || eligibleOffer && proof.id === offer?.evidenceId || state.approved && proof.id === state.approvedEvidenceId)) throw new Error("Ineligible evidence");
      setReviewEvidence(proof); setReview(key); if (!same) setReviewSource(null);
      await compareCurrent(snapshot.selection, intent);
      if (!current()) return;
      if (snapshot.revision.kind !== "authored") return;
      const saved = await callbacks.current.request<SavedSource>(`${extensionPath(snapshot.extension.id)}/revisions/${encodeURIComponent(snapshot.revision.id)}`, "GET", undefined, authoringLifetime.current.signal);
      if (!current()) return;
      if (saved.revisionId !== snapshot.revision.id || !snapshot.suiteDigest || saved.suiteDigest !== snapshot.suiteDigest || typeof saved.source !== "string" || !saved.source.trim()
        || typeof saved.artifact !== "string" || !saved.artifact.trim() || !saved.pins || typeof saved.pins !== "object"
        || !Array.isArray(saved.cases) || !saved.cases.length || saved.cases.some(item => typeof item !== "string" || !item.trim())) throw new Error("Saved review mismatch");
      setReviewSource({ ...saved, ownerId: snapshot.owner.id, key });
    } catch {
      if (current()) { setReview(""); setReviewError("The exact saved change and its examples could not be confirmed. Approval is unavailable. Your current setup has not changed."); }
    } finally {
      if (current()) {
        setReviewLoading(false);
        // Rechecking the same proof can change layout while its saved examples reload.
        if (same) requestAnimationFrame(() => {
          if (!current() || readingRevision.current !== reading || !canvas.current) return;
          canvas.current.scrollTop = position; canvasScroll.current = canvas.current.scrollTop;
        });
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
    if (locked.current || pendingTurn || pendingExample) return;
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
    if (!conversation || retired || !authoring?.availability.available || disabled || staleConversation || legacyConversation) return;
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
      setText(value => value === input.text ? "" : value);
      return;
    } catch (failure) {
      if (!mounted.current || serial.current !== turn) return;
      if (recoveredResponse) throw failure;
      if (deletedOutcome(failure, "turn", input.operationId)) return;
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
          retainTurn(null); setText(value => value === input.text ? "" : value); setObservationPaused(false);
        } catch (failure) {
          if (!mounted.current || serial.current !== turn) return;
          if (!acceptedResponse && deletedOutcome(failure, "turn", input.operationId)) return;
          const problem = failure as { status?: number; code?: string };
          if (!acceptedResponse && problem.code === "LEGACY_CUSTOMIZATION_RETIRED") {
            setRetiredOperation(true); setRetryTurn(false); setAuthoringError(authoringReason(problem.code)); return;
          }
          if (!acceptedResponse && problem.status === 409 && input.target.kind !== "create"
              && ["STALE_DRAFT", "STALE_CONVERSATION", "STALE_CONTEXT", "CONFIG_CHANGED"].includes(problem.code ?? "")) {
            const notice = problem.code === "CONFIG_CHANGED" ? authoringReason(problem.code)
              : "This request was rejected because saved work changed. Your text is kept. Check the current proposal before sending again.";
            retainTurn(null); setRetryTurn(false); setText(value => value || input.text);
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
      if (mounted.current && serial.current === turn && deletedOutcome(failure, "turn", input.operationId)) return;
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
      else if (pendingExample) await checkExampleRequest();
      if (!mounted.current || deletedRef.current) return;
      const loaded = await refresh();
      if (!mounted.current || !loaded) return;
      if (pendingTurn && extensionId.current && messageHistory.current?.scope !== "item:" + extensionId.current) await loadAuthoring(undefined, loaded);
      else if (!pendingTurn && !pendingExample) await loadAuthoring(initialTarget.current.conversationId, loaded);
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
      ? selected ? "This customization is on. What would you like to change?" : "Your saved changes are approved. Turning them on is a separate decision."
      : "Your saved changes are here. What would you like to change or check?"
      : "What would you like to change about your work?";
    setMessages([{ id: ++messageId.current, who: "Studio", text: `${task ? `From your ${task.status} task “${task.title}”. ` : ""}${text}` }]);
  }, [entry, state, trusted, authoring]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const available = (room.current?.clientWidth ?? 900) - 14;
      const min = Math.max(30, Math.ceil(300 / available * 100));
      const max = Math.min(70, Math.floor((available - 340) / available * 100));
      if (min <= max) setLimits({ min, max });
      const log = chatEnd.current?.parentElement;
      if (log && followConversation.current) log.scrollTop = log.scrollHeight;
    });
    if (room.current) observer.observe(room.current);
    if (chatEnd.current?.parentElement) observer.observe(chatEnd.current.parentElement);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const log = chatEnd.current?.parentElement;
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
    const log = chatEnd.current?.parentElement;
    if (log && followConversation.current) log.scrollTop = log.scrollHeight;
  }, [conversation?.review?.evidenceId, review]);
  useEffect(() => {
    if (restart) document.getElementById("studio-restart-confirm")?.focus();
  }, [restart]);
  useLayoutEffect(() => {
    if (deleted) deletedTitle.current?.focus();
  }, [deleted]);
  useEffect(() => {
    if (!busy && focusUse.current) {
      const intent = focusUse.current; focusUse.current = null;
      if (mounted.current && viewIntent.current === intent.view && focusIntent.current === intent.focus) {
        if (intent.target === "studio-customization-status")
          document.getElementById(intent.target)?.focus({ preventScroll: true });
        else if (currentPane.current.open && currentPane.current.view === "review")
          room.current?.querySelector<HTMLElement>("#" + intent.target)?.focus({ preventScroll: true });
      }
    }
  }, [busy]);

  async function mutate(operation: string, body: object, message: string, selection = false) {
    if (locked.current || !trusted || activeAuthoring || pendingTurn || !extensionId.current || legacyConversation || retired && operation !== "disable") return;
    if (executionUnavailable && ["activate", "rollback"].includes(operation)) return;
    locked.current = true;
    const turn = ++serial.current;
    const reading = readingRevision.current;
    const view = viewIntent.current, focus = focusIntent.current;
    setBusy(operation === "simulate" ? "Trying the sample tasks…" : "Saving your choice…");
    setError(""); setNotice("");
    try {
      if (selection) callbacks.current.beforeSelectionChange();
      const next = await callbacks.current.request<State>(`${extensionPath()}/${operation}`, "POST", body);
      if (!mounted.current || serial.current !== turn) return;
      const followReading = readingRevision.current === reading;
      if ((operation === "approve" || operation === "activate") && followReading && viewIntent.current === view && focusIntent.current === focus)
        focusUse.current = { view, focus, target: operation === "approve" ? "use-customization" : "studio-use-confirmed" };
      if (operation === "disable" && viewIntent.current === view && focusIntent.current === focus)
        focusUse.current = { view, focus, target: "studio-customization-status" };
      apply(next);
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
      const conflict = (failure as { status?: number })?.status === 409;
      setError(conflict ? "The saved proposal or selection changed. Checking the server before you try again."
        : "The request did not finish here. It may have reached the server. Checking saved state before you try again.");
      try {
        const next = await callbacks.current.request<State>(extensionPath());
        if (mounted.current && serial.current === turn) {
          apply(next);
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
    setBusy("Inspecting saved source and examples…"); setError(""); setInspection(null);
    try {
      const next = await callbacks.current.request<SavedSource>(`${extensionPath()}/revisions/${encodeURIComponent(revision)}`, "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      if (next.revisionId !== revision || suite !== undefined && next.suiteDigest !== suite || typeof next.source !== "string" || !next.source.trim()
        || typeof next.artifact !== "string" || !next.artifact.trim() || !next.pins || typeof next.pins !== "object"
        || !Array.isArray(next.cases) || next.cases.some(item => typeof item !== "string" || !item.trim())) throw new Error("Saved inspection mismatch");
      setInspection({ ...next, key: identity, historical });
      if (historical) requestAnimationFrame(() => { if (mounted.current && serial.current === turn) document.getElementById("studio-inspected-history")?.focus(); });
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
      const log = chatEnd.current?.parentElement;
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
  function clearExampleRequest() {
    setPendingExample(null);
    try { sessionStorage.removeItem(recoveryKey + ":example"); } catch { /* The exact operation still prevents duplicate creation. */ }
  }
  async function readExampleRequest(operationId: string, turn: number) {
    const saved = await callbacks.current.request<State>("extensions/creation/" + encodeURIComponent(operationId), "GET", undefined, authoringLifetime.current.signal).catch(failure => {
      if ((failure as { status?: number }).status === 404) return null; throw failure;
    });
    if (!mounted.current || serial.current !== turn) return;
    setRetiredOperation(true);
    if (!saved?.extension) { setError("This earlier submitted example has no confirmed saved customization. It is retired and will not be saved again."); return; }
    if (saved.owner.id !== ownerId || saved.extension.creationOperationId !== operationId || extensionId.current && extensionId.current !== saved.extension.id) throw new Error("Example recovery mismatch");
    extensionId.current = saved.extension.id; apply(saved); callbacks.current.targeted({ extensionId: extensionId.current, conversationId: null }); clearExampleRequest();
    say("The earlier saved example was found. Its history is retained; it cannot be resumed as a task-creating customization.");
  }
  async function checkExampleRequest() {
    if (locked.current || !pendingExample) return;
    locked.current = true; const turn = ++serial.current;
    setBusy("Checking the submitted example…"); setError("");
    try { await readExampleRequest(pendingExample.operationId, turn); }
    catch (failure) { if (mounted.current && serial.current === turn && !deletedOutcome(failure, "example", pendingExample.operationId)) { setTrusted(false); setError("The submitted example could not be checked. Check its saved status before retrying."); } }
    finally { if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); } }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (locked.current || !text.trim() || sendDisabled || !authoring?.availability.available) return;
    if (authoring?.availability.available) {
      if (/[\uD800-\uDFFF]/u.test(text) || new TextEncoder().encode(text).length > 8192) { setAuthoringError("Use valid text within the 8 KiB description limit."); return; }
      const target = turnTarget(), resumed = target.kind === "resume" ? conversation : null;
      void submitAuthoring({ target, conversationId: resumed?.id ?? null, operationId: crypto.randomUUID(), text,
        expectedVersion: resumed?.version ?? 0, expectedDraftVersion: state!.draftVersion });
      return;
    }
  }
  const restoreTarget = state?.restoreTargets.find(item => item.id === restore);
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
  return <section className={`read-studio${reviewOpen ? " rs-review-open" : ""}`} aria-label="Customization Studio">
    <div className="sr-only" role="status">{busy || notice}</div>
    <header className="rs-header"><div><p className="rs-breadcrumb">Customizations / Studio</p><div className="rs-title"><h1 id="studio-title" tabIndex={-1} title={state?.extension?.name}>{state?.extension?.name ?? (target.extensionId ? "Opening customization…" : legacyConversation ? "Earlier conversation" : target.conversationId ? "Opening conversation…" : "New customization")}</h1>
      {state?.extension && <CustomizationName key={state.owner.id + "/" + state.extension.id} ownerId={state.owner.id} itemId={state.extension.id} name={state.extension.name} disabled={disabled || !!restart} request={request} saved={next => {
        if (!mounted.current || next.owner.id !== ownerId || next.extension?.id !== extensionId.current) return;
        setState(old => old?.extension?.id === next.extension!.id ? { ...old, extension: { ...old.extension, name: next.extension!.name },
          selection: { ...old.selection, revision: old.selection.revision?.extensionId === next.extension!.id ? { ...old.selection.revision, extensionName: next.extension!.name } : old.selection.revision } } : old);
      }} />}</div></div>
      <div className="rs-header-actions">{activeAuthoring && <button className="rs-stop" disabled={!!busy || conversation?.status === "CANCELLING"} onClick={() => void stopAuthoring()}>{conversation?.status === "CANCELLING" ? "Stopping…" : "Stop"}</button>}<button id="studio-manage" aria-label="History and details" disabled={!!restart} onClick={openTools}><span className="rs-full-label">History and details</span><span className="rs-short-label" aria-hidden="true">Details</span></button><button className="rs-back" aria-label={backLabel} onClick={back} disabled={!!busy || !!restart}><span className="rs-full-label">{backLabel}</span><span className="rs-short-label" aria-hidden="true">Back</span></button></div></header>
    {error && <div role="alert" className="rs-error">{error} <button onClick={() => void refresh(true)} disabled={!!busy}>Retry</button></div>}
    {executionUnavailable && <p role="status" className="rs-setup-notice">{state?.executionAvailability?.message || "Task customizations cannot run in this installation yet. Your tasks still work."}</p>}
    {state && <div className="rs-status-summary" aria-label="Customization status">
      <div><strong id="studio-customization-status" tabIndex={-1}>{state.extension ? ownActive ? state.selection.eligible ? "In use" : "Couldn’t check what’s in use"
        : state.approved ? "Approved · Not in use" : state.draft ? "Draft · Not in use" : "In discussion · Not in use" : "New customization · Not saved"}</strong>
        {ownActive && state.draft && !selectedDraft && <span>Saved changes{state.approved ? " · Approved" : " · Not in use"}</span>}
        {state.selection.revision && !ownActive && <span>{state.selection.eligible ? "Another customization is in use" : "Couldn’t check the saved selection"}</span>}</div>
      <div className="rs-summary-actions">
        {decisionEvidenceId && <button id="studio-view-saved" disabled={!reviewAllowed} onClick={() => void openReview(latestReviewAvailable && reviewOpen ? newerEvidenceId ?? decisionEvidenceId : decisionEvidenceId)}>{latestReviewAvailable && reviewOpen ? "View latest changes" : "View saved changes"}</button>}
        {ownActive && state.selection.eligible && <button onClick={backToTasks}>Back to tasks</button>}
        {ownActive && <button aria-label="Turn off this customization" disabled={disabled || !!restart} onClick={() => void mutate("disable", { generation: state.selection.generation }, "This customization is off. Earlier tasks and receipts are kept.", true)}>
          <span className="rs-full-label">Turn off this customization</span><span className="rs-short-label" aria-hidden="true">Turn off</span></button>}
      </div>
    </div>}
    <div className={`rs-room rs-show-${pane}${reviewOpen ? "" : " rs-review-closed"}`} ref={room} style={{ "--rs-chat": Math.max(limits.min, Math.min(limits.max, width)) } as CSSProperties}>
      <section className="rs-chat" aria-labelledby="studio-conversation">
        <h2 id="studio-conversation" className="sr-only" tabIndex={-1}>Conversation</h2>
        <div className="rs-messages" inert={!!restart} tabIndex={0} role="log" aria-label="Studio conversation" aria-live="off" onScroll={event => {
          const log = event.currentTarget; followConversation.current = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
          if (followConversation.current) setNewMessages(false);
        }}>
          {messagesBefore && <div aria-label="Earlier messages">
            {earlierMessagesFailed && <p role="status">Couldn’t load earlier messages.</p>}
            <button id="studio-earlier-messages" disabled={!!busy} onClick={() => void earlierMessages()}>{earlierMessagesFailed ? "Retry earlier messages" : "Load earlier messages"}</button>
          </div>}
          {entry === "start" && <article className="rs-message rs-start">
            <strong>Studio</strong><h2>What would you like to change about your work?</h2>
            <p>Tell me what you want to happen. We’ll check what Daymark can support and work through useful examples together.</p>
            {catalogError ? <p role="status">What Daymark supports could not be checked. <button onClick={() => void readHostCatalog()}>Try again</button></p> : hostCatalog && <details><summary>What Daymark supports</summary>{hostCatalog.hooks.map(hook => <p key={hook.id}><strong>{hook.label}</strong> · {hook.description}</p>)}</details>}
          </article>}
          {messages.map(message => {
            const currentReceipt = !retired && !historyView && (!message.conversationId || message.conversationId === conversation?.id)
              && message.evidenceId === decisionEvidenceId;
            return <article className={`rs-message ${message.who === "You" ? "rs-yours" : ""}`} data-conversation-message={!!message.conversationId || undefined} key={message.id}>
              <strong>{message.who}</strong><p>{message.text}</p>{message.context && <details><summary>Earlier discussion included</summary><pre aria-label="Included earlier discussion">{message.context}</pre></details>}
              {message.evidenceId && (currentReceipt
                ? <button className="rs-link" disabled={!reviewAllowed} onClick={() => void openReview()}>View saved changes</button>
                : <button data-evidence-link={message.evidenceId} disabled={!!busy} className="rs-link" onClick={() => void showEvidence(message.evidenceId!)}>{message.evidenceId === latestCurrentEvidenceId ? "View checked examples" : "View earlier examples"}</button>)}
            </article>;
          })}
          {retired && <article className="rs-message rs-decision" aria-label="Retired customization"><h3>This earlier customization is retired</h3><p>Its source, examples, discussion and history remain available. It cannot run or be resumed as a task-creating customization. A new customization needs its own checks and approval.</p><button className="rs-primary" disabled={!!busy} onClick={createNew}>Start a new customization</button></article>}
          {legacyConversation && <p role="status">Earlier discussion · read-only. No customization link has been confirmed.</p>}
          {historyView && !activeAuthoring && <article className="rs-message rs-decision"><p>Earlier discussion · read-only. These messages and examples cannot change or approve your current saved changes.</p>
            <button disabled={!!busy || !!pendingTurn || !!pendingExample} onClick={returnToCurrent}>Return to current changes</button></article>}
          {conversation?.review && !eligibleOffer && <article className="rs-message"><p>These saved examples do not support approval of the current changes.</p>
            <button className="rs-link" disabled={!!busy || !trusted || !!pendingTurn} onClick={() => void showEvidence(conversation.review!.evidenceId)}>{conversation.review.evidenceId === latestCurrentEvidenceId ? "View checked examples" : "View earlier examples"}</button></article>}
          {conversation && !contextRecovery && ["CANCELLED", "BLOCKED", "INTERRUPTED"].includes(conversation.status) && <p role="status">{conversation.status === "BLOCKED" ? authoringReason(conversation.code) || authoringStatus.BLOCKED : `${authoringStatus[conversation.status]} ${authoringReason(conversation.code)}`}</p>}
          {["BUDGET_EXHAUSTED", "PROVIDER_RATE_LIMIT", "EXPIRED"].includes(conversation?.code ?? "") && !activeAuthoring && !legacyConversation && !staleConversation && !historyView && !retired && <button disabled={disabled || !authoring?.availability.available} onClick={continueSaved}>{conversation?.code === "PROVIDER_RATE_LIMIT" ? "Try again from saved work" : "Continue here from saved work"}</button>}
          {state?.extension && ownActive && !historyView && !staleConversation && <article className="rs-message">
            <p>{state.draft && state.draft.id !== ownActive.id ? "Your current setup is still on. Your saved changes are not in use yet." : "This setup is in use."}</p>
            {state.draft && state.draft.id !== ownActive.id && checkedDraftSummary && <p>Checked examples for your saved changes: {checkedDraftSummary}.</p>}
            {state.draft && state.draft.id !== ownActive.id && checkedActiveSummary && <p>Checked examples for your current setup: {checkedActiveSummary}.</p>}
            <button id="studio-view-active" className="rs-link" disabled={!!busy} onClick={() => void showActive()}>View what’s in use</button>
          </article>}

          {authoringError && <p role="alert">{authoringError}</p>}
          {recoveryError && <p role="alert">{recoveryError}</p>}
          {pendingTurn && <article className="rs-message"><strong>Submitted request</strong><p>{pendingTurn.text}</p></article>}
          {pendingExample && <div className="rs-recovery"><button disabled={!!busy} onClick={() => void checkExampleRequest()}>Check submitted example</button>
</div>}
          {(authoringError || observationPaused || pendingTurn) && <div className="rs-recovery"><button disabled={!!busy} onClick={() => pendingTurn ? void submitAuthoring(pendingTurn, true) : void loadAuthoring()}>{!authoring && authoringError ? "Retry status" : "Check authoring status"}</button>
            {pendingTurn && retryTurn && !retired && <button disabled={!!busy} onClick={() => void submitAuthoring(pendingTurn)}>Retry submitted request</button>}</div>}
          <div ref={chatEnd} />
        </div>
        {newMessages && <button className="rs-new-messages" onClick={() => { const log = chatEnd.current?.parentElement; if (log) log.scrollTop = log.scrollHeight; followConversation.current = true; setNewMessages(false); }}>New messages ↓</button>}
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
        <form hidden={retired || legacyConversation || historyView || !!restart} className="rs-composer" onSubmit={submit}><label className="sr-only" htmlFor="studio-message">Message to Studio</label>
          <textarea id="studio-message" maxLength={8192} rows={2} value={text} onFocus={() => { readingRevision.current++; }} onChange={e => { readingRevision.current++; setText(e.target.value); }} placeholder="Describe what you want or answer a question…"
            onKeyDown={event => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              if (!event.repeat && !sendDisabled && authoring?.availability.available && text.trim() && !locked.current) event.currentTarget.form?.requestSubmit();
            }} />
          <button disabled={!authoring?.availability.available || sendDisabled || !text.trim()}>Send</button></form>
        <p hidden={retired || !!restart} className="rs-chat-note">{authoring?.availability.available ? "Messages use your configured assistant. Your messages are saved." : "You decide whether to approve and turn on a change."}</p>
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
          {canvasView === "review" && savedReview && <article id="studio-review" className="rs-sheet rs-review" aria-label="Current decision">
            <h3 id="studio-review-heading" tabIndex={-1}>Your saved changes</h3>
            <p className="rs-review-status">{viewedInUse ? "In use" : reviewLoading ? "Checking the saved change and its examples…"
              : !viewedCurrent ? "Earlier saved changes · read-only" : reviewedApproved ? executionUnavailable ? "Approved · Saved" : "Ready to turn on" : "Ready for your review"}</p>
            {reviewError && <div role="alert"><p>{reviewError}</p>{viewedCurrent && <button disabled={!reviewAllowed} onClick={() => void openReview(savedReview.evidenceId)}>Check saved change again</button>}</div>}
            {!viewedCurrent && !viewedInUse && !reviewLoading && <p>Saved work or its use changed. You can keep reading these examples. Open the latest changes before making a decision.</p>}
            {reviewEvidence && <>
              <p>Checked examples: {reviewEvidence.reports.length}. These were example tasks; your real tasks have not changed.</p>
              {(viewedInUse || savedReview.selection.revision) && <p>{viewedInUse ? `“${savedReview.extension.name}” is now in use. New matching task completions can use this change. Turning it on does not complete or replay earlier tasks.`
                : savedReview.selection.eligible ? `Currently in use: “${savedReview.selection.revision!.extensionName}”.`
                  : "The saved selection could not be checked. Its use is unverified."}</p>}
              {mainExample && <div className="rs-proof-comparison">{currentProofExample(mainExample)}<section aria-label="Checked proposed behavior"><h4>Proposed · {exampleTitle(mainExample, 0)}</h4>{checkedExample(mainExample, 0)}</section></div>}
              {reviewEvidence.reports.length > 1 && <details><summary>Other checked examples ({reviewEvidence.reports.length - 1})</summary>
                {reviewEvidence.reports.filter(item => item.id !== mainExample?.id).map((item, index) => checkedExample(item, index))}
              </details>}
              {reviewedApproved && !viewedInUse && !executionUnavailable && <p>Turn on “{savedReview.extension.name}”{savedReview.selection.revision
                ? savedReview.selection.revision.extensionId !== savedReview.extension.id
                  ? ` instead of “${savedReview.selection.revision.extensionName}”. Switching turns it off and keeps it saved.`
                  : ". This replaces the version currently in use." : " for your tasks."}</p>}
              {viewedInUse ? <p id="studio-use-confirmed" tabIndex={-1} role="status">This change is on. You can keep asking questions or describe your next change.</p>
                : reviewReady && review === reviewKey && <div className="rs-decision-actions">{reviewedApproved
                  ? <button id="use-customization" className="rs-primary" disabled={reviewActionDisabled || executionUnavailable} onClick={() => {
                    if (reviewActionDisabled || executionUnavailable) return;
                    void mutate("activate", { revisionId: savedReview.revision.id, draftVersion: savedReview.draftVersion, generation: savedReview.selection.generation },
                      `“${savedReview.extension.name}” is now in use. Your tasks have not changed.`, true);
                  }}>{savedReview.selection.revision && savedReview.selection.revision.extensionId !== savedReview.extension.id ? "Switch to this customization" : "Turn on for my tasks"}</button>
                  : <button className="rs-primary" disabled={reviewActionDisabled} onClick={() => {
                    if (reviewActionDisabled) return;
                    void mutate("approve", { revisionId: savedReview.revision.id, draftVersion: savedReview.draftVersion, evidenceId: savedReview.evidenceId },
                      "This change is approved and ready to turn on. Your current setup has not changed.");
                  }}>Approve this change</button>}
                </div>}
              <details><summary>Exact saved change and checks</summary>
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
            </>}
          </article>}
          {activeView && canvasView === "active" && activeSnapshot && <article className="rs-sheet" aria-label="Version in use">
            <h3>{activeSelectionMatches ? "Version currently in use" : "Previously viewed version"}</h3><p>{state.draft && state.draft.id !== activeSnapshot.revision.id && <>Your saved changes are separate. </>}This view is read-only.</p>
            {activeProof && activeSelectionMatches && state.selection.eligible ? <><p aria-label="Checked behavior in use">Checked examples in use: {activeProof.reports.length}. {summarizeExamples(activeProof)}.</p><p>These were example tasks; your real tasks have not changed. Other situations remain untested.</p></>
              : <p role="status">{activeSummaryError || "Checking the saved examples for this version…"}</p>}
            <button disabled={retired || disabled || !activeSelectionMatches || !state.selection.eligible} onClick={() => { setRestart({ draftVersion: state.draftVersion, revisionId: activeSnapshot.revision.id, generation: activeSnapshot.generation, activeLabel: checkedActiveSummary || "current setup; no verified checked description is available", draftLabel: checkedDraftSummary || `saved version ${state.draftVersion}; no verified checked description is available` }); closeReview(); }}>Start changes from this version</button>
            <button onClick={() => { setActiveView(false); closeReview(); }}>Continue saved changes</button>
            <button className="rs-link" disabled={disabled} onClick={() => { void inspectSource(activeSelectionMatches ? undefined : activeSnapshot.revision.id); openTools(); }}>Inspect this version’s source</button>
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
        <details hidden={canvasView !== "details"} className="rs-sheet rs-tools"><summary>History, details and recovery</summary>
          {history.some(item => item.operation === "draft-superseded") && <section aria-label="Earlier saved changes"><h3>Earlier saved changes</h3><p>{currentUse}</p>
            {history.filter(item => item.operation === "draft-superseded" && item.revisionId).map(item => <p key={item.id}>{item.label ?? "Saved draft"} · {item.revisionId === state?.selection.revision?.id ? "Saved selection" : "Not in use"} · read-only <button disabled={disabled} onClick={() => void inspectSource(item.revisionId!)}>Inspect earlier saved changes</button></p>)}
          </section>}
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
          {authoring?.availability.provider && <section aria-label="Assistant connection details"><h3>Assistant connection</h3><p>Provider: {authoring.availability.provider}</p><p>Model: {authoring.availability.model}</p><button onClick={openSetup}>Configure</button></section>}
          {state && <>
          {state.selection.revision && <p>Current choice provenance: {state.selection.revision.provenance === "operator" ? "Operator-provided starting choice" : "Your approved choice"}</p>}
          {(inspectionRevision || inspection?.historical) && <section aria-label="Saved program">
            {inspectionRevision && <button disabled={disabled} onClick={() => void inspectSource()}>Inspect saved source and examples</button>}
            {inspection && (inspection.historical || inspection.key === inspectionKey) && <>
              {inspection.historical && <h3 id="studio-inspected-history" tabIndex={-1}>Earlier saved changes · read-only</h3>}
              {inspection.historical && <p>{inspection.revisionId === state.selection.revision?.id ? "This is the saved selection." : "These earlier changes are not in use."} {currentUse} Opening this history does not change what runs.</p>}
              <p>Exact saved revision: {inspection.revisionId}. {inspection.historical ? "These earlier changes stay in History. They cannot approve, activate or replace your current changes." : "Inspection is read-only."}</p>
              <h3>Saved source</h3><pre aria-label="Saved source for inspection">{inspection.source}</pre>
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
          <details className="rs-sheet rs-secondary"><summary>All saved versions</summary>
            <p>Saved versions are read-only. Only eligible previously used choices can be restored below.</p>
            <ol>{revisions.map(item => <li key={item.id}>{item.label} · {item.id} · read-only <button disabled={!!busy} onClick={() => void inspectSource(item.id)}>Inspect saved version</button></li>)}</ol>
            {revisionsNext !== null && <button disabled={!!busy} onClick={() => void earlierSaved("revisions")}>{revisionsNext === undefined ? "Load saved versions" : "Load earlier saved versions"}</button>}
          </details>
          <details className="rs-sheet rs-secondary" aria-label="Manage saved customization"><summary>Manage saved customization</summary>
          {!retired && <>
          <h3>Return to an earlier choice</h3>
            <label htmlFor="studio-restore">Previously in use</label><select id="studio-restore" value={restore} disabled={disabled} onChange={e => setRestore(e.target.value)}>
              <option value="">Choose a saved choice…</option>{state.restoreTargets.map((item, index) => <option key={item.id} value={item.id}>{item.label} · {item.provenance === "operator" ? "operator starting choice" : "customer approved"} · choice {index + 1}</option>)}</select>
            {state.restoreTargetsNext && <button disabled={!!busy} onClick={() => void earlierSaved("restore-targets")}>Load earlier restore choices</button>}
            {restoreTarget && <div className="rs-restore-confirm"><p>Restore <strong>{restoreTarget.label}</strong>{restoreTarget.kind === "authored" ? " with its exact reviewed source and examples." : " with its saved checked behavior."} {restoreTarget.provenance === "operator" ? "This was an operator-provided starting choice." : "This choice was approved for you."} No task or earlier action is undone.</p>
              <details><summary>Exact choice to restore</summary><p>Revision: {restoreTarget.id}</p><pre>{JSON.stringify(restoreTarget.pins, null, 2)}</pre></details>
              <button disabled={disabled || executionUnavailable} onClick={() => void mutate("rollback", { revisionId: restoreTarget.id, generation: state.selection.generation }, `Restored ${restoreTarget.label} for your tasks.`, true)}>Restore {restoreTarget.label} for me</button></div>}
          </>}
            <details><summary>Selection history and exact identities</summary><p>Current generation: {state.selection.generation}</p>
              <ol>{history.map(item => <li key={item.id}>{item.operation === "draft-superseded" ? "Earlier saved changes" : item.operation} · {item.label ?? ""} · generation {item.generation} · {item.revisionId ?? "Off"}</li>)}</ol>
              {historyNext !== null && <button disabled={!!busy} onClick={() => void earlierHistory()}>Load earlier selections</button>}
              <h4>Saved selection identity</h4><pre>{JSON.stringify(state.selection.revision?.pins ?? {}, null, 2)}</pre>
              <h4>Proposed identity</h4><pre>{JSON.stringify(state.draft?.pins ?? {}, null, 2)}</pre>
            </details>
          </details>
        </>}
        <details className="rs-lookup"><summary>Open a saved sample run by ID</summary><form onSubmit={event => { event.preventDefault(); void showEvidence(lookup); }}>
          <label htmlFor="studio-evidence">Evidence ID for this person</label><input id="studio-evidence" maxLength={160} value={lookup} onChange={e => setLookup(e.target.value)} />
          <button disabled={!!busy || !lookup.trim()}>Open saved sample run</button></form></details>
        <button className="rs-reload" onClick={() => void refresh(true)} disabled={!!busy}>Reload saved state</button>
        </details>
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
