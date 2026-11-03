import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import "./Studio.css";

type Revision = { id: string; templateId: string; kind?: "authored" | "prepared"; suiteDigest?: string | null; label: string; pins: object; provenance: "operator" | "customer" };
type History = { id: number; generation: number; operation: string; revisionId: string | null; label?: string | null };
export type State = {
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
  history: History[];
  evidenceHistory: { id: string; revisionId: string }[];
};
export type Collection = { items: State[]; owner: State["owner"]; selection: State["selection"]; catalog: State["catalog"] };
export type StudioTarget = { extensionId: string | null; conversationId?: string | null; recoveryId?: string; history?: boolean };
type HostCatalog = {
  hooks: { id: string; label: string; description: string; effect: string; trigger: string }[];
  model: { dcm: string; digest: string; profile: string; hook: string; consumer: object; compiler: unknown };
};
type Outcome = { classification: string; code?: string; consumption?: { status: "DISPLAYED" | "NOT_DISPLAYED"; code?: string } };
type SavedSource = { revisionId: string; source: string; artifact: string; pins: object; cases: string[]; suiteDigest: string | null };
type Example = { label: string; description: string; source: string; cases: string[]; situations: { id: string; label: string; taskStatus: "OPEN" | "COMPLETED" | null }[] };
type Evidence = { id: string; revisionId: string; kind?: "authored" | "prepared"; identity: object; passed: boolean; reports: {
  id: string; label: string; expected: Outcome; taskStatus?: "OPEN" | "COMPLETED" | null; readFailure?: "TASK_NOT_FOUND" | "ACCESS_DENIED" | "TRANSIENT_FAILURE" | null;
  report: { status: string; native?: Outcome; consumption?: { status: string; code?: string }; mismatches: object[] };
}[] };
type Message = { id: number | string; who: "You" | "Studio"; text: string; evidenceId?: string; exampleCount?: number; context?: string };
type Operation = { id: string; runId: string; version: number };
type Conversation = {
  extensionId: string | null; purpose: "CREATE" | "REVISE" | null;
  id: string; version: number; status: "IDLE" | "RUNNING" | "CANCELLING" | "AWAITING_USER" | "REVIEW_AVAILABLE" | "CANCELLED" | "BLOCKED" | "INTERRUPTED";
  runId: string; operation: Operation; messages: { id: string; role: "user" | "assistant"; text: string; kind: "text" | "clarification" | "review";
    receipt?: { revisionId: string; draftVersion: number; suiteDigest: string; evidenceId: string } }[];
  code: string | null; review: { revisionId: string; draftVersion: number; suiteDigest: string; evidenceId: string; eligible: boolean } | null;
  draft: { revisionId: string | null; draftVersion: number; suiteDigest: string | null }; selection: { revisionId: string | null; generation: number };
};
type Authoring = {
  availability: { available: boolean; code: string | null; provider: "openai" | "anthropic" | null; model: string | null };
  conversations: { extensionId: string | null; purpose: "CREATE" | "REVISE" | null; id: string; version: number; status: Conversation["status"]; runId: string; creationOperationId: string; operationId: string }[];
  current: Conversation | null;
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
      if (entries.length === 8) break;
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
      if (entries.length === 8) break;
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
  if (["AI_NOT_CONFIGURED", "AI_CONFIG_INVALID", "AI_CREDENTIALS_MISSING"].includes(code)) return "AI authoring is not configured.";
  if (code === "SPEND_LIMIT") return "The shared authoring allowance is exhausted. Saved work and review remain available.";
  if (code === "BUDGET_EXHAUSTED") return "This conversation reached its work limit. Your saved proposal and examples are kept. You can start a new conversation to continue; this does not add to the shared allowance.";
  if (code === "PROVIDER_RATE_LIMIT") return "Your AI provider reached a request or account limit. Your discussion and any saved draft are kept. Check provider usage or explicitly try again later. Nothing is retried automatically.";
  if (code === "CONFIG_CHANGED") return "Assistant settings changed. Start a new conversation to continue; your saved customization remains available.";
  if (code === "CONVERSATION_LIMIT") return "The saved conversation limit has been reached. Existing conversations are retained.";
  if (["STALE_CONTEXT", "STALE_DRAFT", "STALE_CONVERSATION", "CHECKPOINT_UNCERTAIN"].includes(code)) return "The request needs saved-state readback before another change. No approval or activation is implied.";
  if (code === "REVIEW_NOT_READY") return "The saved examples do not yet support approval. Inspect their results or discuss the correction.";
  return "AI authoring is unavailable for this request. Check saved state; native tasks and saved work remain available.";
}
type Props = {
  request: <T>(path: string, method?: string, body?: object, signal?: AbortSignal) => Promise<T>;
  changed: (generation: number) => void;
  beforeSelectionChange: () => void;
  back: () => void;
  backLabel: string;
  target: StudioTarget;
  ownerId: string;
  recoveryKey: string;
  targeted: (target: StudioTarget) => void;
  unavailable: () => void;
  task?: { title: string; status: "open" | "completed" };
};
const advice = (code?: string) => ({ PENDING: "Pending", NEEDS_ATTENTION: "Needs attention", DONE: "Done" })[code ?? ""] ?? code;
const knownObservation = (value?: { status: string; code?: string }) => value?.status === "NOT_DISPLAYED"
  || value?.status === "DISPLAYED" && ["DONE", "PENDING", "NEEDS_ATTENTION"].includes(value.code ?? "");
const observedAdvice = (value?: { status: string; code?: string }) => !knownObservation(value) ? "Not observed" : value?.status === "NOT_DISPLAYED" ? "No advice" : advice(value?.code);
const expectedAdvice = (value: Outcome) => knownObservation(value.consumption) ? observedAdvice(value.consumption) : "Expected advice not recorded";
const summarizeExamples = (proof: Evidence | null) => (["OPEN", "COMPLETED"] as const).map(status => {
  const outcomes = Array.from(new Set(proof?.reports.filter(item => item.taskStatus === status).map(item => observedAdvice(item.report.consumption))));
  return outcomes.length ? `${status === "OPEN" ? "unfinished" : "completed"} tasks showed ${outcomes.join(" or ")}` : null;
}).filter(Boolean).join("; ");

const continuationPrefix = "Continue my saved proposal and examples using these earlier messages. If the context is incomplete, ask before changing the examples.\n\n";
function continuationText(previous: Conversation) {
  const encoder = new TextEncoder();
  const messages = previous.messages.map(({ role, text }) => ({ role, text }));
  let truncated = false;
  const render = () => continuationPrefix
    + messages.map(item => `${item.role === "user" ? "You" : "Studio"}: ${item.text}`).join("\n\n")
    + (truncated ? "\n\n[Some earlier conversation was omitted to fit this request.]" : "");
  while (encoder.encode(render()).length > 8192 && messages.length > 1) {
    const lastUser = messages.map(item => item.role).lastIndexOf("user");
    messages.splice(lastUser === 0 ? 1 : 0, 1); truncated = true;
  }
  if (encoder.encode(render()).length > 8192 && messages.length) {
    truncated = true;
    const points = Array.from(messages[0].text);
    let low = 0, high = points.length;
    while (low < high) {
      const count = Math.ceil((low + high) / 2);
      messages[0].text = points.slice(-count).join("");
      if (encoder.encode(render()).length <= 8192) low = count; else high = count - 1;
    }
    messages[0].text = low ? points.slice(-low).join("") : "";
  }
  return render();
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

export default function Studio({ request, changed, beforeSelectionChange, back, backLabel, target, ownerId, recoveryKey, targeted, unavailable, task }: Props) {
  const initialTarget = useRef(target);
  const extensionId = useRef(target.extensionId);
  const historyMode = useRef(target.history === true);
  const [historyView, setHistoryView] = useState(historyMode.current);
  const [entry, setEntry] = useState(target.extensionId || target.conversationId ? "item" : "start");
  const [hostCatalog, setHostCatalog] = useState<HostCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [activeView, setActiveView] = useState(false);
  const [activeSnapshot, setActiveSnapshot] = useState<{ ownerId: string; extensionId: string; revision: NonNullable<State["selection"]["revision"]>; generation: number; evidenceId: string | null } | null>(null);
  const [activeProof, setActiveProof] = useState<Evidence | null>(null);
  const [activeSummaryError, setActiveSummaryError] = useState("");
  const [restart, setRestart] = useState<{ draftVersion: number; revisionId: string; generation: number; activeLabel: string; draftLabel: string } | null>(null);
  const personalStart = useRef(false);
  const exampleOperation = useRef<string | null>(null);
  const [pendingExample, setPendingExample] = useState(() => pendingGuidedRequests(ownerId).find(item => recoveryKey.endsWith(":" + item.entryId)) ?? null);
  const [exampleRetry, setExampleRetry] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupNotice, setSetupNotice] = useState("");
  const setupInvoker = useRef<HTMLElement | null>(null);
  const setupGeneration = useRef(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [state, setState] = useState<State | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [reviewEvidence, setReviewEvidence] = useState<Evidence | null>(null);
  const [reviewChoice, setReviewChoice] = useState<{ revisionId: string; draftVersion: number; evidenceId: string } | null>(null);
  const [exampleId, setExampleId] = useState<string | null>(null);
  const [review, setReview] = useState("");
  const reviewAttempt = useRef("");
  const [reviewSource, setReviewSource] = useState<(SavedSource & { ownerId: string; key: string }) | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [inspection, setInspection] = useState<(SavedSource & { key: string; historical: boolean }) | null>(null);
  const [restore, setRestore] = useState("");
  const [lookup, setLookup] = useState("");
  const [text, setText] = useState("");
  const [authoring, setAuthoring] = useState<Authoring | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [authoringError, setAuthoringError] = useState("");
  const [pendingTurn, setPendingTurn] = useState<Turn | null>(() => pendingRequests(ownerId).find(item => recoveryKey.endsWith(":" + item.entryId))?.turn ?? null);
  const [retryTurn, setRetryTurn] = useState(false);
  const [observationPaused, setObservationPaused] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const observation = useRef({ runId: "", reads: 0 });
  const authoringLifetime = useRef(new AbortController());
  const [width, setWidth] = useState(52);
  const [pane, setPane] = useState<"conversation" | "preview">("conversation");
  const [canvasView, setCanvasView] = useState<"advice" | "results" | "details">("advice");
  const [newMessages, setNewMessages] = useState(false);
  const [history, setHistory] = useState<History[]>([]);
  const [historyNext, setHistoryNext] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [example, setExample] = useState<Example | null>(null);
  const [scripted, setScripted] = useState(false);
  const exampleRevision = useRef<string | null>(null);
  const [completion, setCompletion] = useState(false);
  const focusCompletion = useRef<number | null>(null);
  const room = useRef<HTMLDivElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLElement>(null);
  const canvasScroll = useRef(0);
  const managementReturn = useRef<{ view: typeof canvasView; position: number } | null>(null);
  const readingAnchor = useRef<{ element: HTMLElement; top: number; revision: number } | null>(null);
  const reviewInvoker = useRef<HTMLElement | null>(null);
  const conversationReturn = useRef(0);
  const evidenceReturn = useRef<string | null>(null);
  const reviewed = useRef<{ owner: string; label: string; revisionId: string; evidenceId: string; kind?: string } | null>(null);
  const followConversation = useRef(true);
  const readingRevision = useRef(0);
  const messageId = useRef(0);
  const initialized = useRef(false);
  const focusUse = useRef(false);
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
      if (value && !sessionStorage.getItem(recoveryKey) && pendingRequests(ownerId).length + pendingGuidedRequests(ownerId).length >= 8) {
        setAuthoringError("Check an earlier submitted request in Customizations before sending another request.");
        return false;
      }
      if (value) sessionStorage.setItem(recoveryKey, JSON.stringify(value));
      else sessionStorage.removeItem(recoveryKey);
    } catch { setRecoveryError("This browser could not save recovery information. Keep this page open until the submitted request is confirmed."); }
    setPendingTurn(value);
    return true;
  }
  function turnTarget(): TurnTarget {
    if (!extensionId.current) return { kind: "create" };
    return conversation ? { kind: "resume", extensionId: extensionId.current }
      : { kind: "revise", extensionId: extensionId.current, baseRevisionId: state?.draft?.id
        ?? (state?.selection.revision?.extensionId === extensionId.current ? state.selection.revision.id : null), selectionGeneration: state!.selection.generation };
  }
  const offer = conversation?.review;
  const eligibleOffer = offer?.eligible === true && !!state?.draft && offer.revisionId === state.draft.id
    && offer.draftVersion === state.draftVersion && offer.suiteDigest === state.draft.suiteDigest
    && conversation?.extensionId !== null;
  const chosenEvidence = state?.draft && reviewChoice?.revisionId === state.draft.id && reviewChoice.draftVersion === state.draftVersion
    && (reviewChoice.evidenceId === state.evidence?.id && state.evidence.passed || reviewChoice.evidenceId === state.approvedEvidenceId || eligibleOffer && reviewChoice.evidenceId === offer?.evidenceId) ? reviewChoice.evidenceId : null;
  const decisionEvidenceId = state?.draft ? chosenEvidence ?? (state.approved && state.approvedEvidenceId ? state.approvedEvidenceId
    : eligibleOffer ? offer!.evidenceId : state.evidence?.passed ? state.evidence.id : null) : null;
  const decisionIdentity = state?.draft && decisionEvidenceId ? `${state.owner.id}/${state.extension!.id}/${state.draft.id}/${state.draftVersion}/${decisionEvidenceId}` : "";
  const reviewKey = state?.draft && reviewEvidence ? `${state.owner.id}/${state.draft.id}/${state.draftVersion}/${reviewEvidence.id}` : "";
  const ownActive = state?.selection.revision?.extensionId === state?.extension?.id ? state?.selection.revision : null;
  const currentUse = state?.selection.revision ? state.selection.eligible ? `“${state.selection.revision.extensionName}” is in use.`
    : "The saved setup could not be checked. Its use is unverified." : "No customization is in use.";
  const inspectionRevision = activeView ? ownActive : state?.draft ?? ownActive;
  const inspectionKey = inspectionRevision ? `${state!.owner.id}/${state!.extension!.id}/${inspectionRevision.id}/${inspectionRevision.suiteDigest ?? ""}` : "";
  const currentEvidence = !!state?.draft && evidence?.revisionId === state.draft.id && (evidence?.id === state.evidence?.id || eligibleOffer && evidence?.id === offer?.evidenceId);
  const decisionObservationsKnown = !!reviewEvidence?.reports.length && reviewEvidence.reports.every(item => knownObservation(item.expected.consumption) && knownObservation(item.report.consumption));
  const canReview = trusted && reviewEvidence?.id === decisionEvidenceId && reviewEvidence?.revisionId === state?.draft?.id && reviewEvidence?.passed && decisionObservationsKnown;
  const activeAuthoring = running(conversation);
  const legacyConversation = !!conversation && conversation.extensionId === null;
  const staleConversation = !!conversation && !!state?.extension && (conversation.extensionId !== state.extension.id
    || conversation.draft.draftVersion !== state.draftVersion || conversation.draft.revisionId !== (state.draft?.id ?? null));
  const disabled = !!busy || !trusted || activeAuthoring || !!pendingTurn || !!pendingExample;
  const sendDisabled = disabled || legacyConversation || staleConversation || historyView || activeView;
  const reviewReady = reviewed.current?.kind !== "authored" || !!reviewSource && reviewSource.key === review && reviewSource.ownerId === state?.owner.id && reviewSource.revisionId === state?.draft?.id && reviewSource.suiteDigest === state?.draft?.suiteDigest;
  const reviewedApproved = !!state?.approved && state.approvedEvidenceId === reviewEvidence?.id && review === reviewKey;
  const exampleLabel = (item: Evidence["reports"][number], index: number) => item.taskStatus === "OPEN" ? "Unfinished task" : item.taskStatus === "COMPLETED" ? "Completed task"
    : (item.readFailure ? ({ TASK_NOT_FOUND: "Missing task", ACCESS_DENIED: "Task access denied", TRANSIENT_FAILURE: "Read temporarily unavailable" })[item.readFailure] : undefined) ?? `Example ${index + 1}`;
  const exampleTitle = (item: Evidence["reports"][number], index: number) => item.taskStatus === "OPEN" ? "What an unfinished task would show"
    : item.taskStatus === "COMPLETED" ? "What a completed task would show" : `What happens with ${exampleLabel(item, index).toLowerCase()}`;
  const mainExample = reviewEvidence?.reports.find(item => item.taskStatus === "COMPLETED") ?? reviewEvidence?.reports[0];
  const behaviorSummary = summarizeExamples(reviewEvidence);
  const activeSelectionMatches = !!activeSnapshot && activeSnapshot.ownerId === state?.owner.id && activeSnapshot.extensionId === state.extension?.id
    && activeSnapshot.revision.id === state.selection.revision?.id && activeSnapshot.generation === state.selection.generation
    && activeSnapshot.evidenceId === state.selection.approvedEvidenceId;
  const completed = completion && !!state?.selection.eligible && state.selection.revision?.id === state.draft?.id;

  function openPane(next?: typeof canvasView, invoker = document.activeElement) {
    const reading = ++readingRevision.current;
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
      if (!mounted.current || readingRevision.current !== reading) return;
      document.getElementById(next === "results" ? "studio-results-heading" : "studio-canvas")?.focus({ preventScroll: true });
      if (canvas.current) canvas.current.scrollTop = position;
      canvasScroll.current = position;
    });
  }
  function closeReview() {
    setActiveView(false);
    readingRevision.current++;
    if (canvas.current) canvasScroll.current = canvas.current.scrollTop;
    setReviewOpen(false); setPane("conversation");
    requestAnimationFrame(() => {
      const target = reviewInvoker.current;
      const savedTurn = evidenceReturn.current ? document.getElementById("studio-evidence-link-" + evidenceReturn.current) : null;
      if (chatEnd.current?.parentElement) chatEnd.current.parentElement.scrollTop = conversationReturn.current;
      (target?.isConnected && target.getClientRects().length ? target : savedTurn ?? document.getElementById("studio-manage"))?.focus({ preventScroll: true });
    });
  }
  useEffect(() => {
    if (activeView && activeSnapshot && (!activeSelectionMatches || !state?.selection.eligible)) {
      setActiveProof(null);
      setActiveSummaryError(activeSelectionMatches ? "No verified saved checks are available for this version. Check task advice on a saved task to see what it currently shows."
        : "The version in use changed. Reopen what’s in use to check it again.");
    }
  }, [activeView, activeSnapshot, activeSelectionMatches, state?.selection.eligible]);
  async function showActive() {
    if (locked.current || !trusted || !state?.extension || !ownActive) return;
    const snapshot = { ownerId: state.owner.id, extensionId: state.extension.id, revision: ownActive,
      generation: state.selection.generation, evidenceId: state.selection.approvedEvidenceId };
    setActiveSnapshot(snapshot); setActiveProof(null); setActiveSummaryError(""); setActiveView(true); openPane("advice");
    if (!state.selection.eligible || snapshot.revision.provenance === "operator" || !snapshot.evidenceId) {
      setActiveSummaryError("No verified saved checks are available for this version. Check task advice on a saved task to see what it currently shows.");
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
        || !proof.reports.every(item => item.report.status === "PASS" && knownObservation(item.expected.consumption) && knownObservation(item.report.consumption))
        || !summarizeExamples(proof)) throw new Error("Active examples are unverified");
      if (readingRevision.current === reading) setActiveProof(proof);
      else setActiveSummaryError("The view changed while checking. Reopen what’s in use to check it again.");
    } catch {
      if (mounted.current && serial.current === turn) { setActiveProof(null); setActiveSummaryError("The checked examples for the version in use could not be verified. No behavior summary is available. Reopen what’s in use to try again."); }
    } finally { if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); } }
  }
  function openTools() {
    managementReturn.current ??= { view: canvasView, position: canvasScroll.current };
    openPane("details");
    requestAnimationFrame(() => {
      const details = document.querySelector<HTMLDetailsElement>(".rs-tools");
      if (details) { details.open = true; details.querySelector("summary")?.focus({ preventScroll: true }); }
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
    const anchor = bounds && bounds.height > 0 && Array.from(canvas.current!.querySelectorAll<HTMLElement>(".rs-example")).find(row => {
      const rect = row.getBoundingClientRect(); return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    readingAnchor.current = anchor ? { element: anchor, top: anchor.getBoundingClientRect().top, revision: readingRevision.current } : null;
    setState(next);
    setTrusted(true);
    setRestore("");
    setHistory(next.history);
    setHistoryNext(next.history.length === 20 ? next.history.at(-1)!.id : null);
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
    if (locked.current) return;
    const proofId = evidenceId ?? decisionEvidenceId;
    if (!state?.draft || !trusted || disabled || !proofId) return;
    locked.current = true;
    const turn = ++serial.current;
    setBusy("Checking the saved proposal and examples…"); setReviewError("");
    try {
      const proof = await callbacks.current.request<Evidence>(`${extensionPath()}/evidence/${encodeURIComponent(proofId)}`, "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      if (!proof.passed || !proof.reports.length || !proof.reports.every(item => knownObservation(item.expected.consumption) && knownObservation(item.report.consumption)) || proof.revisionId !== state.draft.id || proof.id !== proofId
        || !(proof.id === state.evidence?.id && state.evidence.passed || eligibleOffer && proof.id === offer?.evidenceId || state.approved && proof.id === state.approvedEvidenceId)) throw new Error("Ineligible evidence");
      const key = `${state.owner.id}/${state.draft.id}/${state.draftVersion}/${proof.id}`;
      setReviewEvidence(proof); setReview(key); setReviewSource(null);
      reviewed.current = { owner: state.owner.name, label: state.draft.label, revisionId: state.draft.id, evidenceId: proof.id, kind: state.draft.kind };
      if (state.draft.kind !== "authored") return;
      const target = { ownerId: state.owner.id, revisionId: state.draft.id, suiteDigest: state.draft.suiteDigest, key };
      const saved = await callbacks.current.request<SavedSource>(`${extensionPath()}/revisions/${encodeURIComponent(target.revisionId)}`);
      if (!mounted.current || serial.current !== turn) return;
      if (saved.revisionId !== target.revisionId || !target.suiteDigest || saved.suiteDigest !== target.suiteDigest || typeof saved.source !== "string" || !saved.source.trim()
        || typeof saved.artifact !== "string" || !saved.artifact.trim() || !saved.pins || typeof saved.pins !== "object"
        || !Array.isArray(saved.cases) || !saved.cases.length || saved.cases.some(item => typeof item !== "string" || !item.trim())) throw new Error("Saved review mismatch");
      setReviewSource({ ...saved, ownerId: target.ownerId, key: target.key });
    } catch {
      if (mounted.current && serial.current === turn) setReviewError("The exact saved change and its examples could not be confirmed. Approval is unavailable. Your current setup has not changed.");
    } finally {
      if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); }
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
        next = { owner: collection.owner, selection: collection.selection, catalog: collection.catalog, extension: null,
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
  async function adoptConversation(next: Conversation, turn: number, creationOperationId?: string) {
    if (!mounted.current || serial.current !== turn) return;
    if (extensionId.current && next.extensionId !== extensionId.current || initialTarget.current.conversationId && !initialTarget.current.extensionId && next.extensionId !== null) throw new Error("Conversation customization mismatch");
    if (next.extensionId && (!running(next) || state?.extension?.id !== next.extensionId)) {
      extensionId.current = next.extensionId;
      const saved = await callbacks.current.request<State>(extensionPath(next.extensionId), "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      apply(saved);
    }
    setConversation(next);
    callbacks.current.targeted({ extensionId: next.extensionId, conversationId: next.id, history: historyMode.current });
    setAuthoring(index => {
      if (!index) return index;
      const previous = index.conversations.find(item => item.id === next.id);
      if (!previous && !creationOperationId) return index;
      const summary = { extensionId: next.extensionId, purpose: next.purpose, id: next.id, version: next.version, status: next.status, runId: next.runId, operationId: next.operation.id, creationOperationId: previous?.creationOperationId ?? creationOperationId! };
      return { ...index, conversations: [summary, ...index.conversations.filter(item => item.id !== next.id)] };
    });
    const incoming: Message[] = next.messages.map(item => ({ id: `ai:${next.id}:${item.id}`, who: item.role === "user" ? "You" : "Studio",
      text: item.role === "user" && item.text.startsWith(continuationPrefix) ? "Continue from saved work." : item.text,
      evidenceId: item.role === "assistant" ? item.receipt?.evidenceId : undefined,
      context: item.role === "user" && item.text.startsWith(continuationPrefix) ? item.text : undefined }));
    setMessages(old => {
      const ids = new Set(old.map(item => item.id));
      const byId = new Map(incoming.map(item => [item.id, item]));
      const merged = [...old.filter(item => typeof item.id !== "string" || item.id.startsWith(`ai:${next.id}:`)).map(item => {
        const updated = byId.get(item.id); return updated && (updated.text !== item.text || updated.who !== item.who || updated.context !== item.context || updated.evidenceId !== item.evidenceId) ? updated : item;
      }), ...incoming.filter(item => !ids.has(item.id))];
      return merged.length === old.length && merged.every((item, index) => item === old[index]) ? old : merged;
    });
    initialized.current = true; setEntry("item");
  }
  async function loadAuthoring(id?: string | null, snapshot = state) {
    if (locked.current) return;
    locked.current = true;
    const turn = ++serial.current;
    setBusy("Checking authoring status…"); setAuthoringError("");
    try {
      const next = await callbacks.current.request<Authoring>(authoringPath(), "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      setAuthoring(next);
      const currentWork = next.current && snapshot && next.current.extensionId === snapshot.extension?.id
        && next.current.draft.draftVersion === snapshot.draftVersion && next.current.draft.revisionId === (snapshot.draft?.id ?? null);
      const selected = id === undefined && extensionId.current ? currentWork ? next.current!.id : null : id;
      if (selected) {
        const current = next.current?.id === selected ? next.current : await callbacks.current.request<Conversation>(`authoring/conversations/${encodeURIComponent(selected)}`, "GET", undefined, authoringLifetime.current.signal);
        if (current?.id !== selected || current.extensionId !== extensionId.current) throw new Error("Unconfirmed conversation");
        if (id === undefined || snapshot && !conversation) setMessages([]);
        await adoptConversation(current!, turn);
      }
      if (mounted.current && serial.current === turn) setObservationPaused(false);
    } catch (failure) {
      if (mounted.current && serial.current === turn && (failure as { status?: number }).status === 404 && id) callbacks.current.unavailable();
      if (mounted.current && serial.current === turn) { setAuthoring(null); setObservationPaused(true); setAuthoringError("AI authoring status could not be checked. Retry status before continuing a conversation. Saved work remains available."); }
    } finally { if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); } }
  }
  function newConversation() {
    if (locked.current || activeAuthoring || pendingTurn || pendingExample || legacyConversation || (authoring?.conversations.length ?? 0) >= 8) return;
    setConversation(null); setScripted(false); setCompletion(false); setReview(""); setEvidence(null); setActiveView(false);
    historyMode.current = false; setHistoryView(false); reviewAttempt.current = "";
    setMessages([{ id: ++messageId.current, who: "Studio", text: "Continue your current saved changes here. What would you like to change or check?" }]); initialized.current = true; setObservationPaused(false); setAuthoringError("");
    callbacks.current.targeted({ extensionId: extensionId.current, conversationId: null });
  }
  function returnToCurrent() {
    if (locked.current || pendingTurn || pendingExample) return;
    historyMode.current = false; setHistoryView(false); setConversation(null); setReview(""); reviewAttempt.current = "";
    setMessages([{ id: ++messageId.current, who: "Studio", text: `These are your current saved changes${state?.draft ? ` (version ${state.draftVersion})` : ""}. What would you like to change or check?` }]);
    initialized.current = true; setEntry("item");
    callbacks.current.targeted({ extensionId: extensionId.current, conversationId: null });
    if (reviewOpen) closeReview();
    void loadAuthoring(undefined, state);
  }
  function continueSaved() {
    if (!conversation || !authoring?.availability.available || disabled || staleConversation || legacyConversation || (authoring.conversations.length >= 8)) return;
    const input = continuationText(conversation);
    newConversation();
    void submitAuthoring({ target: { kind: "revise", extensionId: extensionId.current!, baseRevisionId: state?.draft?.id ?? null, selectionGeneration: state!.selection.generation }, conversationId: null, operationId: crypto.randomUUID(), text: input, expectedVersion: 0, expectedDraftVersion: state!.draftVersion });
  }
  async function recoverTurn(input: Turn, turn: number) {
    const index = await callbacks.current.request<Authoring>(authoringPath(), "GET", undefined, authoringLifetime.current.signal);
    if (!mounted.current || serial.current !== turn) return;
    setAuthoring(index);
    const summary = index.conversations.find(item => input.conversationId ? item.id === input.conversationId : item.creationOperationId === input.operationId);
    if (summary) {
      if (input.target.kind !== "create" && summary.extensionId !== input.target.extensionId) throw new Error("Operation customization mismatch");
      const current = await callbacks.current.request<Conversation>(`authoring/conversations/${encodeURIComponent(summary.id)}`, "GET", undefined, authoringLifetime.current.signal);
      if (current.id !== summary.id) throw new Error("Unconfirmed conversation");
      await adoptConversation(current, turn);
      if (!mounted.current || serial.current !== turn) return;
      if (summary.creationOperationId === input.operationId || current.operation.id === input.operationId) {
        retainTurn(null); setRetryTurn(false); setAuthoringError("");
        setText(value => value === input.text ? "" : value);
        return;
      }
    }
    setRetryTurn(true);
    setAuthoringError("Saved state was checked, but acceptance of this request is unconfirmed. You may explicitly retry the same submitted request; it keeps its operation identity.");
  }
  async function submitAuthoring(input: Turn, recoveryOnly = false) {
    if (locked.current || !trusted && !recoveryOnly) return;
    if (!retainTurn(input)) return;
    locked.current = true;
    const turn = ++serial.current;
    setBusy(recoveryOnly ? "Checking submitted request…" : "Sending description…");
    setAuthoringError(""); setRetryTurn(false);
    try {
      if (recoveryOnly) await recoverTurn(input, turn);
      else {
        try {
          const accepted = await callbacks.current.request<{ operation: Operation; conversation: Conversation }>("authoring/turn", "POST", input, authoringLifetime.current.signal);
          if (!mounted.current || serial.current !== turn) return;
          if (accepted.operation.id !== input.operationId || accepted.operation.version !== input.expectedVersion + 1 || accepted.conversation.version < accepted.operation.version || !accepted.operation.runId || input.conversationId && accepted.conversation.id !== input.conversationId) throw new Error("Unconfirmed authoring receipt");
          await adoptConversation(accepted.conversation, turn, input.conversationId === null ? input.operationId : undefined);
          if (!mounted.current || serial.current !== turn) return;
          retainTurn(null); setText(value => value === input.text ? "" : value); setObservationPaused(false);
        } catch (failure) {
          if (!mounted.current || serial.current !== turn) return;
          if ((failure as { status?: number }).status === 409 && ["STALE_DRAFT", "STALE_CONVERSATION", "STALE_CONTEXT"].includes((failure as { code?: string }).code ?? "") && input.target.kind !== "create") {
            const saved = await callbacks.current.request<State>(extensionPath(input.target.extensionId), "GET", undefined, authoringLifetime.current.signal);
            if (!mounted.current || serial.current !== turn) return;
            apply(saved);
            const index = await callbacks.current.request<Authoring>(authoringPath(), "GET", undefined, authoringLifetime.current.signal);
            if (!mounted.current || serial.current !== turn) return;
            setAuthoring(index);
            if (input.conversationId) {
              const current = index.current?.id === input.conversationId ? index.current : await callbacks.current.request<Conversation>(`authoring/conversations/${encodeURIComponent(input.conversationId)}`, "GET", undefined, authoringLifetime.current.signal);
              await adoptConversation(current, turn);
              if (!mounted.current || serial.current !== turn) return;
            }
            retainTurn(null); setText(value => value || input.text);
            setAuthoringError("This request was rejected because saved work changed. Your text is kept. Inspect the current proposal, then explicitly continue its changes.");
            return;
          }
          if ((failure as { status?: number })?.status === 409 && (failure as { code?: string })?.code === "CONFIG_CHANGED") {
            retainTurn(null); setRetryTurn(false); setAuthoringError(authoringReason("CONFIG_CHANGED"));
            try {
              const index = await callbacks.current.request<Authoring>(authoringPath(), "GET", undefined, authoringLifetime.current.signal);
              if (mounted.current && serial.current === turn) setAuthoring(index);
            } catch {
              if (mounted.current && serial.current === turn) setAuthoringError(authoringReason("CONFIG_CHANGED") + " Current status could not be checked; use Check authoring status.");
            }
            return;
          }
          await recoverTurn(input, turn);
        }
      }
    } catch {
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
    document.getElementById("studio-title")?.focus();
    void refresh().then(async loaded => {
      if (!mounted.current || !loaded) return;
      if (pendingTurn) await submitAuthoring(pendingTurn, true);
      else if (pendingExample) await checkExampleRequest();
      else await loadAuthoring(initialTarget.current.conversationId ?? (initialTarget.current.extensionId ? undefined : null), loaded);
      if (mounted.current && entry === "start") document.getElementById("studio-message")?.focus();
    });
    void readHostCatalog();
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => { mounted.current = false; authoringLifetime.current.abort(); document.removeEventListener("visibilitychange", visibility); ++serial.current; locked.current = false; };
  }, []);
  useEffect(() => {
    if (!conversation || !activeAuthoring || !visible || observationPaused || pendingTurn) return;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, authoringLifetime.current.signal]);
    const id = conversation.id, runId = conversation.runId;
    if (observation.current.runId !== runId) observation.current = { runId, reads: 0 };
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (signal.aborted || !mounted.current) return;
      if (observation.current.reads >= 130) { setObservationPaused(true); setAuthoringError("Automatic observation reached its limit. Check authoring status explicitly; this never starts another generation."); return; }
      if (locked.current) { timer = setTimeout(poll, 1000); return; }
      const turn = serial.current;
      try {
        observation.current.reads++;
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
    if (entry !== "item" || !state || !trusted || initialized.current) return;
    initialized.current = true;
    const selected = state.selection.eligible && state.selection.revision?.id === state.draft?.id;
    const text = state.draft ? state.approved
      ? selected ? "This customization is on. What would you like to change?" : "Your saved changes are approved. Turning them on is a separate decision."
      : "Your saved changes are here. What would you like to change or check?"
      : "What would you like to change about your work?";
    setMessages([{ id: ++messageId.current, who: "Studio", text: `${task ? `From your ${task.status} task “${task.title}”. ` : ""}${text}` }]);
  }, [entry, state, trusted]);
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
    if (log && followConversation.current) log.scrollTop = log.scrollHeight;
    else setNewMessages(true);
  }, [messages, activeAuthoring]);
  useLayoutEffect(() => {
    const log = chatEnd.current?.parentElement;
    if (log && followConversation.current) log.scrollTop = log.scrollHeight;
  }, [conversation?.review?.evidenceId, review, completion, scripted]);
  useEffect(() => {
    if (!decisionIdentity || disabled || legacyConversation || staleConversation || historyView || reviewAttempt.current === decisionIdentity) return;
    reviewAttempt.current = decisionIdentity;
    void openReview(decisionEvidenceId!);
  }, [decisionIdentity, disabled, legacyConversation, staleConversation, historyView]);
  useEffect(() => {
    if (restart) document.getElementById("studio-restart-confirm")?.focus();
  }, [restart]);
  useEffect(() => {
    if (!busy && focusUse.current) { focusUse.current = false; document.getElementById("use-task-advice")?.focus(); }
    if (!busy && focusCompletion.current !== null) {
      if (readingRevision.current === focusCompletion.current) document.getElementById("studio-completion")?.focus();
      focusCompletion.current = null;
    }
  }, [busy]);

  async function mutate(operation: string, body: object, message: string, selection = false) {
    if (locked.current || !trusted || activeAuthoring || pendingTurn || !extensionId.current || legacyConversation) return;
    locked.current = true;
    const turn = ++serial.current;
    const reading = readingRevision.current;
    setBusy(operation === "simulate" ? "Trying the sample tasks…" : "Saving your choice…");
    setError(""); setNotice("");
    try {
      if (selection) callbacks.current.beforeSelectionChange();
      const next = await callbacks.current.request<State>(`${extensionPath()}/${operation}`, "POST", body);
      if (!mounted.current || serial.current !== turn) return;
      const followReading = readingRevision.current === reading;
      if (operation === "approve" && followReading) focusUse.current = true;
      if (operation === "activate" && followReading) { setCompletion(true); focusCompletion.current = reading; setReviewOpen(false); setPane("conversation"); }
      apply(next);
      if (operation === "restart") {
        historyMode.current = false; setHistoryView(false); reviewAttempt.current = "";
        setConversation(null); setMessages([]); initialized.current = false; setEvidence(null); setReview(""); setReviewSource(null); setInspection(null); setActiveView(false);
        callbacks.current.targeted({ extensionId: extensionId.current, conversationId: null });
      }
      say(message);
      setNotice(message);
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
        setExampleId(namedExample ?? proof.reports[0]?.id ?? null); setEvidence(proof); openPane("results", invoker);
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
      if (mounted.current && serial.current === turn) { setHistory(old => [...old, ...next.rows]); setHistoryNext(next.next); }
    } catch {
      if (mounted.current && serial.current === turn) setError("Earlier selections could not be loaded. No customization was changed.");
    } finally {
      if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); }
    }
  }
  async function loadExample() {
    if (locked.current || disabled) return;
    locked.current = true;
    const turn = ++serial.current;
    setBusy("Opening the guided example…"); setError("");
    try {
      const next = await callbacks.current.request<Example>("authoring/example", "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      exampleRevision.current = null;
      if (extensionId.current && (!state?.draft || !await recognizeExample(state, next, turn))) { say("Continue this customization here. To try a separate guided example, choose New customization from the collection; this example will not replace your saved work."); return; }
      if (!mounted.current || serial.current !== turn) return;
      personalStart.current = extensionId.current === null;
      initialized.current = true; setExample(next); setScripted(true); setCompletion(false); setEntry("item");
      say(state?.draft ? "The saved part of this example is here. You can continue checking it; your current setup has not changed."
        : "In this example, open tasks show Needs attention when you check their advice. Should completed tasks still say Done?");
    } catch { if (mounted.current && serial.current === turn) setError("The guided example could not be opened. Your saved work has not changed."); }
    finally { if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); } }
  }
  async function recognizeExample(saved: State, sample: Example, turn: number) {
    if (saved.draft?.kind !== "authored" || saved.draft.label !== sample.label) return false;
    const documents = await callbacks.current.request<SavedSource>(`${extensionPath()}/revisions/${encodeURIComponent(saved.draft.id)}`, "GET", undefined, authoringLifetime.current.signal);
    if (!mounted.current || serial.current !== turn) return false;
    const matches = documents.revisionId === saved.draft.id && documents.source === sample.source
      && documents.suiteDigest === (saved.draft.suiteDigest ?? null) && Array.isArray(documents.cases)
      && (documents.cases.length === 0 && !saved.draft.suiteDigest
        || !!saved.draft.suiteDigest && documents.cases.length === sample.cases.length && documents.cases.every((item, index) => item === sample.cases[index]));
    if (matches) exampleRevision.current = saved.draft.id;
    return matches;
  }
  function clearExampleRequest() {
    setPendingExample(null); setExampleRetry(false);
    try { sessionStorage.removeItem(recoveryKey + ":example"); } catch { /* The exact operation still prevents duplicate creation. */ }
  }
  async function readExampleRequest(operationId: string, personal: boolean, turn: number) {
    const [collection, sample] = await Promise.all([
      callbacks.current.request<Collection>("extensions", "GET", undefined, authoringLifetime.current.signal),
      callbacks.current.request<Example>("authoring/example", "GET", undefined, authoringLifetime.current.signal),
    ]);
    if (!mounted.current || serial.current !== turn) return;
    if (collection.owner.id !== ownerId) throw new Error("Example owner mismatch");
    const item = collection.items.find(saved => saved.extension?.creationOperationId === operationId);
    personalStart.current = personal; exampleOperation.current = operationId; setExample(sample); setScripted(true); setEntry("item"); initialized.current = true;
    if (!item?.extension) {
      if (extensionId.current) throw new Error("Example item unavailable");
      setExampleRetry(true); setTrusted(true);
      setError("Saved state was checked, but acceptance of this example is unconfirmed. You can explicitly retry the same save; its request identity is kept.");
      return;
    }
    if (extensionId.current && extensionId.current !== item.extension.id) throw new Error("Example customization mismatch");
    extensionId.current = item.extension.id;
    const saved = await callbacks.current.request<State>(extensionPath(), "GET", undefined, authoringLifetime.current.signal);
    if (!mounted.current || serial.current !== turn) return;
    apply(saved); callbacks.current.targeted({ extensionId: extensionId.current, conversationId: null }); clearExampleRequest();
    if (await recognizeExample(saved, sample, turn)) {
      say("The saved example was found. You can continue checking it without creating another customization.");
    } else {
      setScripted(false); say("The saved customization was found with later changes. Inspect the current proposal before making another change.");
    }
  }
  async function checkExampleRequest() {
    if (locked.current || !pendingExample) return;
    locked.current = true; const turn = ++serial.current;
    setBusy("Checking the submitted example…"); setError(""); setExampleRetry(false);
    try { await readExampleRequest(pendingExample.operationId, pendingExample.personal, turn); }
    catch { if (mounted.current && serial.current === turn) { setTrusted(false); setError("The submitted example could not be checked. Check its saved status before retrying."); } }
    finally { if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); } }
  }
  async function prepareExample() {
    if (!example || locked.current || !!busy || !trusted || activeAuthoring || pendingTurn || pendingExample && !exampleRetry || !state || state.draft && state.draft.id !== exampleRevision.current) return;
    locked.current = true;
    const turn = ++serial.current;
    setBusy("Checking the examples…"); setError("");
    say(state.draft ? "Continue checking this example." : "Yes, keep Done for completed tasks.", "You");
    say("I'll check an open task, a completed task, and unavailable tasks without changing your tasks. The expected advice is fixed before these checks.");
    try {
      let next = state;
      if (!next.draft) {
        exampleOperation.current ??= crypto.randomUUID();
        const retained = { entryId: recoveryKey.slice(recoveryKey.lastIndexOf(":") + 1), operationId: exampleOperation.current, personal: personalStart.current };
        try {
          if (!sessionStorage.getItem(recoveryKey + ":example") && pendingRequests(ownerId).length + pendingGuidedRequests(ownerId).length >= 8) {
            setError("Check an earlier submitted request in Customizations before saving another example."); return;
          }
          sessionStorage.setItem(recoveryKey + ":example", JSON.stringify(retained));
        } catch { setRecoveryError("This browser could not save recovery information. Keep this page open until the example is confirmed."); }
        setPendingExample(retained); setExampleRetry(false);
        next = await callbacks.current.request<State>("extensions", "POST", { operationId: exampleOperation.current, source: example.source, label: example.label }, authoringLifetime.current.signal);
        if (!mounted.current || serial.current !== turn) return;
        extensionId.current = next.extension!.id;
        callbacks.current.targeted({ extensionId: extensionId.current, conversationId: null });
        exampleRevision.current = next.draft!.id; apply(next);
        clearExampleRequest();
      }
      if (!next.draft!.suiteDigest) {
        next = await callbacks.current.request<State>(`${extensionPath()}/scenarios`, "POST", { revisionId: next.draft!.id, cases: example.cases, draftVersion: next.draftVersion }, authoringLifetime.current.signal);
        if (!mounted.current || serial.current !== turn) return;
        exampleRevision.current = next.draft!.id; apply(next);
      }
      next = await callbacks.current.request<State>(`${extensionPath()}/simulate`, "POST", { revisionId: next.draft!.id, draftVersion: next.draftVersion }, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      apply(next);
      const proof = await callbacks.current.request<Evidence>(`${extensionPath()}/evidence/${encodeURIComponent(next.evidence!.id)}`, "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      if (proof.id !== next.evidence!.id || proof.revisionId !== next.draft!.id) throw new Error("Unconfirmed examples");
      const observed = !!proof.reports.length && proof.reports.every(item => knownObservation(item.expected.consumption) && knownObservation(item.report.consumption));
      say(proof.passed && observed ? "The examples match: open tasks show Needs attention, completed tasks show Done, and unavailable tasks show no advice. This is only a proposal; your current setup is unchanged."
        : observed ? "An example did not match what you wanted. Your current setup is unchanged; this proposal cannot be approved."
          : "Some example results were not observed. Your current setup is unchanged; this proposal cannot be approved.", "Studio", proof.id, proof.reports.length);
    } catch {
      if (!mounted.current || serial.current !== turn) return;
      setTrusted(false);
      say("The example could not finish here. Some preparation may have been saved. I'll check saved state before you decide what to do next.");
      try {
        if (!extensionId.current && exampleOperation.current) {
          await readExampleRequest(exampleOperation.current, personalStart.current, turn);
          return;
        }
        const saved = await callbacks.current.request<State>(extensionPath(), "GET", undefined, authoringLifetime.current.signal);
        if (!mounted.current || serial.current !== turn) return;
        apply(saved); exampleRevision.current = null;
        if (await recognizeExample(saved, example, turn)) say("The saved part of this example is ready. You can explicitly continue checking it without replacing your proposal.");
      }
      catch { if (mounted.current && serial.current === turn) setError("Saved state could not be confirmed. Reload saved state before another change."); }
    } finally { if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); } }
  }
  async function returnToPersonal() {
    if (locked.current || busy || pendingExample) return;
    setScripted(false); setCompletion(false); setReview(""); setEvidence(null); setExample(null); exampleRevision.current = null;
    reviewAttempt.current = "";
    if (reviewOpen) closeReview();
    if (personalStart.current) {
      extensionId.current = null; setConversation(null); setMessages([]); initialized.current = false; setEntry("start");
      callbacks.current.targeted({ extensionId: null, conversationId: null });
      await refresh();
      if (mounted.current) await loadAuthoring(null);
    } else say("Back to your request. Tell me what you would like to change.");
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (locked.current || !text.trim() || sendDisabled || scripted || !authoring?.availability.available) return;
    if (authoring?.availability.available) {
      if (/[\uD800-\uDFFF]/u.test(text) || new TextEncoder().encode(text).length > 8192) { setAuthoringError("Use valid text within the 8 KiB description limit."); return; }
      setCompletion(false);
      void submitAuthoring({ target: turnTarget(), conversationId: conversation?.id ?? null, operationId: crypto.randomUUID(), text,
        expectedVersion: conversation?.version ?? 0, expectedDraftVersion: state!.draftVersion });
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
  return <section className={`read-studio${reviewOpen ? " rs-review-open" : ""}`} aria-label="Customization Studio">
    <div className="sr-only" role="status">{busy || notice}</div>
    <header className="rs-header"><div><p className="rs-breadcrumb">Customizations / Studio</p><h1 id="studio-title" tabIndex={-1}>{state?.extension?.name ?? (target.extensionId ? "Opening customization…" : legacyConversation ? "Earlier conversation" : target.conversationId ? "Opening conversation…" : "New customization")}</h1></div>
      <div className="rs-header-actions">{activeAuthoring && <button className="rs-stop" disabled={!!busy || conversation?.status === "CANCELLING"} onClick={() => void stopAuthoring()}>{conversation?.status === "CANCELLING" ? "Stopping…" : "Stop"}</button>}<button id="studio-manage" disabled={!!restart} onClick={openTools}>History and details</button><button onClick={back} disabled={!!busy || !!restart}>{backLabel}</button></div></header>
    {error && <div role="alert" className="rs-error">{error} <button onClick={() => void refresh(true)} disabled={!!busy}>Retry</button></div>}
    {state && <div className="rs-status-summary" aria-label="Customization status">
      <div><strong>{state.extension ? ownActive ? state.selection.eligible ? "In use" : "Couldn’t check what’s in use"
        : state.approved ? "Approved · Not in use" : state.draft ? "Draft · Not in use" : "In discussion · Not in use" : "New customization · Not saved"}</strong>
        {ownActive && state.draft && !selectedDraft && <span>Saved changes · version {state.draftVersion} · {state.draft.label}{state.approved ? " · Approved" : " · Not in use"}</span>}
        {state.selection.revision && !ownActive && <span>{state.selection.eligible ? "Currently in use" : "Saved selection · Couldn’t check use"}: {state.selection.revision.extensionName}</span>}</div>
    </div>}
    <div className={`rs-room rs-show-${pane}${reviewOpen ? "" : " rs-review-closed"}`} ref={room} style={{ "--rs-chat": Math.max(limits.min, Math.min(limits.max, width)) } as CSSProperties}>
      <section className="rs-chat" aria-labelledby="studio-conversation">
        <h2 id="studio-conversation" className="sr-only" tabIndex={-1}>Conversation</h2>
        <div className="rs-messages" inert={!!restart} tabIndex={0} role="log" aria-label="Studio conversation" aria-live="off" onScroll={event => {
          const log = event.currentTarget; followConversation.current = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
          if (followConversation.current) setNewMessages(false);
        }}>
          {entry === "start" && <article className="rs-message rs-start">
            <strong>Studio</strong><h2>What would you like to change about your work?</h2>
            <p>Tell me what you want to happen. We’ll check what Daymark can support and work through useful examples together.</p>
            {catalogError ? <p role="status">What Daymark supports could not be checked. <button onClick={() => void readHostCatalog()}>Try again</button></p> : hostCatalog && <details><summary>What Daymark supports</summary>{hostCatalog.hooks.map(hook => <p key={hook.id}><strong>{hook.label}</strong> · {hook.description}</p>)}</details>}
          </article>}
          {messages.map(message => <article className={`rs-message ${message.who === "You" ? "rs-yours" : ""}`} key={message.id}>
            <strong>{message.who}</strong><p>{message.text}</p>{message.context && <details><summary>Earlier discussion included</summary><pre aria-label="Included earlier discussion">{message.context}</pre></details>}{message.evidenceId && message.evidenceId !== decisionEvidenceId && <button id={"studio-evidence-link-" + message.evidenceId} disabled={!!busy} className="rs-link"
              onClick={() => void showEvidence(message.evidenceId!)}>Inspect saved examples from this message</button>}
          </article>)}
          {!conversation && !scripted && (!state?.extension || state.draft?.label === "Scripted example: task advice") && <button className="rs-link" disabled={disabled} onClick={() => void loadExample()}>{state?.draft?.label === "Scripted example: task advice" ? "Continue guided example · no AI" : "Try a guided example · no AI"}</button>}
          {scripted && <article className="rs-message rs-scripted" aria-label="Scripted example"><small>Scripted example · no AI. Saved work and checks are kept.</small>
            {example && !state?.draft && !pendingExample && <button className="rs-primary" disabled={disabled} onClick={() => void prepareExample()}>Yes, keep Done for completed tasks</button>}
            {example && state?.draft?.id === exampleRevision.current && !state?.evidence?.passed && <button className="rs-primary" disabled={disabled} onClick={() => void prepareExample()}>Continue checking this example</button>}
            <button disabled={!!busy || !!pendingExample} onClick={() => void returnToPersonal()}>Return to my request</button></article>}
          {legacyConversation && <p role="status">Earlier discussion · read-only. No customization link has been confirmed.</p>}
          {(historyView || staleConversation) && !activeAuthoring && <article className="rs-message rs-decision"><p>Earlier discussion · read-only. These messages and examples cannot change or approve your current saved changes.</p>
            <button disabled={!!busy || !!pendingTurn || !!pendingExample} onClick={returnToCurrent}>Return to current changes</button></article>}
          {conversation?.review && !eligibleOffer && <article className="rs-message"><p>These saved examples do not support approval of the current changes.</p>
            <button className="rs-link" disabled={!!busy || !trusted || !!pendingTurn} onClick={() => void showEvidence(conversation.review!.evidenceId)}>Inspect these saved examples</button></article>}
          {conversation && ["CANCELLED", "BLOCKED", "INTERRUPTED"].includes(conversation.status) && <p role="status">{conversation.status === "BLOCKED" ? authoringReason(conversation.code) || authoringStatus.BLOCKED : `${authoringStatus[conversation.status]} ${authoringReason(conversation.code)}`}</p>}
          {["BUDGET_EXHAUSTED", "PROVIDER_RATE_LIMIT"].includes(conversation?.code ?? "") && !activeAuthoring && !legacyConversation && !staleConversation && <button disabled={disabled || !authoring?.availability.available || (authoring?.conversations.length ?? 0) >= 8} onClick={continueSaved}>{conversation?.code === "PROVIDER_RATE_LIMIT" ? "Try again from saved work" : "Continue from saved proposal"}</button>}
          {state?.extension && ownActive && !historyView && !staleConversation && <article className="rs-message">
            <p>{state.draft?.id !== ownActive.id ? `The version in use is “${ownActive.label}”. Your saved changes${state.draft ? ` (version ${state.draftVersion})` : ""} are separate and are not in use yet.` : "This setup is in use."}</p>
            <button id="studio-view-active" className="rs-link" disabled={!!busy} onClick={() => void showActive()}>View what’s in use</button>
          </article>}

          {authoringError && <p role="alert">{authoringError}</p>}
          {recoveryError && <p role="alert">{recoveryError}</p>}
          {pendingTurn && <article className="rs-message"><strong>Submitted request</strong><p>{pendingTurn.text}</p></article>}
          {pendingExample && <div className="rs-recovery"><button disabled={!!busy} onClick={() => void checkExampleRequest()}>Check submitted example</button>
            {exampleRetry && <button disabled={!!busy || !trusted} onClick={() => void prepareExample()}>Retry submitted example save</button>}</div>}
          {(authoringError || observationPaused || pendingTurn) && <div className="rs-recovery"><button disabled={!!busy} onClick={() => pendingTurn ? void submitAuthoring(pendingTurn, true) : void loadAuthoring(conversation?.id ?? null)}>{!authoring && authoringError ? "Retry status" : "Check authoring status"}</button>
            {pendingTurn && retryTurn && <button disabled={!!busy} onClick={() => void submitAuthoring(pendingTurn)}>Retry submitted request</button>}</div>}
          <div ref={chatEnd} />
        </div>
        {newMessages && <button className="rs-new-messages" onClick={() => { const log = chatEnd.current?.parentElement; if (log) log.scrollTop = log.scrollHeight; followConversation.current = true; setNewMessages(false); }}>New messages ↓</button>}
          {restart && <article id="studio-restart-confirm" tabIndex={-1} className="rs-message rs-decision rs-current-decision" aria-label="Start from version in use">
            <h3>Start changes from this version?</h3><p>You’ll start with the version in use (“{restart.activeLabel}”). Your unfinished changes (version {restart.draftVersion}, “{restart.draftLabel}”) and their discussion will stay in History. Your current setup will keep running.</p>
            <button className="rs-primary" disabled={disabled} onClick={() => void mutate("restart", { draftVersion: restart.draftVersion, revisionId: restart.revisionId, generation: restart.generation }, "New changes start from the version in use. Earlier changes and discussion remain in History. Check and approve this proposal before turning it on.")}>Start from this version</button>
            <button disabled={!!busy} onClick={() => { setRestart(null); document.getElementById("studio-view-active")?.focus(); }}>Cancel</button>
          </article>}
          {!restart && decisionEvidenceId && state?.draft && !selectedDraft && !legacyConversation && !staleConversation && !historyView && <article id="studio-review" tabIndex={-1} className="rs-message rs-decision rs-current-decision" aria-label="Current decision">
            <strong>Studio</strong>
            {review !== reviewKey || reviewEvidence?.id !== decisionEvidenceId || !reviewReady ? <>
              <p>{reviewError || "Checking the saved change and its examples before you decide…"}</p>
              {reviewError && <button disabled={disabled} onClick={() => void openReview(decisionEvidenceId)}>Check saved change again</button>}
            </> : <>
              <h3>{reviewedApproved ? "Approved. Not in use yet." : "Ready for your decision"}</h3>

              <p>{reviewedApproved ? state.selection.revision && state.selection.revision.extensionId !== state.extension!.id
                ? '“' + state.selection.revision.extensionName + '” is still on. Switching turns it off and keeps it saved.'
                : state.selection.revision ? 'Your current version is still on. Turning on these changes replaces it.' : 'Approved. These changes are not in use yet.'
                : 'In the checked examples, ' + (behaviorSummary || 'the saved results matched what you wanted') + '. This changes only your advice.'}</p>
              <div className="rs-decision-actions">
              {reviewedApproved ? <>
                <button id="use-task-advice" className="rs-primary" disabled={disabled || !canReview || !reviewReady || review !== reviewKey}
                  onClick={() => void mutate("activate", { revisionId: state.draft!.id, draftVersion: state.draftVersion, generation: state.selection.generation }, `“${state.extension!.name}” is now in use. Check task advice on a saved task to see it.`, true)}>{state.selection.revision && state.selection.revision.extensionId !== state.extension!.id ? `Switch to ${state.extension!.name}` : "Turn on for my tasks"}</button>
              </> : <>

                <button className="rs-primary" disabled={disabled || !canReview || !reviewReady || review !== reviewKey}
                  onClick={() => void mutate("approve", { revisionId: state.draft!.id, draftVersion: state.draftVersion, evidenceId: reviewEvidence!.id }, "This change is approved. Your current setup has not changed. Turning it on is your separate decision.")}>Approve this change</button>
              </>}
              {mainExample && reviewEvidence && <button className="rs-link" disabled={!!busy} onClick={() => void showEvidence(reviewEvidence.id, mainExample.id)}>Show the {exampleLabel(mainExample, 0).toLowerCase()} example</button>}
              </div>
              <details><summary>Exact saved change and checks</summary>
                <p>Revision: {reviewed.current?.revisionId}</p><p>Evidence: {reviewed.current?.evidenceId}</p>
                {reviewSource && <>
                  <h4>Saved source</h4><pre aria-label="Saved source for approval">{reviewSource.source}</pre>
                  <h4>Compiled artifact</h4><pre aria-label="Compiled artifact for approval">{reviewSource.artifact}</pre>
                  <h4>Exact artifact pins</h4><pre aria-label="Artifact pins for approval">{JSON.stringify(reviewSource.pins, null, 2)}</pre>
                  <section aria-label="Saved expected examples for approval"><h4>Saved independent expected examples</h4>{reviewSource.cases.map((item, index) => <pre key={index} aria-label={`Saved example ${index + 1} for approval`}>{item}</pre>)}</section>
                </>}
              </details>
              {state.approved && state.evidence?.passed && state.evidence.id !== decisionEvidenceId && <button className="rs-link" disabled={disabled}
                onClick={() => setReviewChoice({ revisionId: state.draft!.id, draftVersion: state.draftVersion, evidenceId: state.evidence!.id })}>Review the newer checked examples</button>}
            </>}
          </article>}
          {completion && selectedDraft && <article className="rs-message rs-decision rs-current-decision" aria-label="Advice is on"><h3 id="studio-completion" tabIndex={-1}>On for your tasks</h3><p>Choose Check task advice on a saved task to see the change. Your tasks are unchanged.</p>
            <button className="rs-primary" onClick={back}>{task ? "Return to my task" : "Return to customizations"}</button></article>}
        {!scripted && !completed && !restart && authoring && !authoring.availability.available && ["AI_NOT_CONFIGURED", "AI_CONFIG_INVALID", "AI_CREDENTIALS_MISSING"].includes(authoring.availability.code ?? "") && <div className="rs-setup-notice"><p>Set up the assistant to create or change a customization.</p><button id="assistant-configure" onClick={openSetup}>Configure</button></div>}
        {!scripted && !completed && !restart && authoring && !authoring.availability.available && !["AI_NOT_CONFIGURED", "AI_CONFIG_INVALID", "AI_CREDENTIALS_MISSING"].includes(authoring.availability.code ?? "") && <p className="rs-setup-notice" role="status">{authoringReason(authoring.availability.code)}</p>}
        {!scripted && !completed && !restart && setupNotice && <p className="rs-setup-notice" role="status">{setupNotice}</p>}
        {activeAuthoring && <div className="rs-working" role="status"><span>{conversation?.status === "CANCELLING" ? "Stopping; waiting for accepted work to settle…" : "Working on your request…"}</span></div>}
        <form hidden={scripted || legacyConversation || historyView || staleConversation || !!restart || completed} className="rs-composer" onSubmit={submit}><label className="sr-only" htmlFor="studio-message">Message to Studio</label>
          <textarea id="studio-message" maxLength={8192} rows={2} value={text} onFocus={() => { readingRevision.current++; }} onChange={e => { readingRevision.current++; setText(e.target.value); }} placeholder="Describe what you want or answer a question…"
            onKeyDown={event => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              if (!event.repeat && !sendDisabled && !scripted && authoring?.availability.available && text.trim() && !locked.current) event.currentTarget.form?.requestSubmit();
            }} />
          <button disabled={scripted || !authoring?.availability.available || sendDisabled || !text.trim()}>Send</button></form>
        <p hidden={scripted || completed || !!restart} className="rs-chat-note">{authoring?.availability.available ? "Messages use your configured assistant. Your messages are saved." : "You decide whether to approve and turn on a change."}</p>
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
          {activeView && canvasView === "advice" && activeSnapshot && <article className="rs-sheet" aria-label="Version in use">
            <h3>{activeSelectionMatches ? "Version currently in use" : "Previously viewed version"}</h3><p>“{activeSnapshot.revision.label}”. {state.draft && state.draft.id !== activeSnapshot.revision.id && <>Your saved changes (version {state.draftVersion}) are separate. </>}This view is read-only.</p>
            {activeProof && activeSelectionMatches && state.selection.eligible ? <><p aria-label="Checked behavior in use">In the last checked examples, {summarizeExamples(activeProof)}.</p><p>These are synthetic, limited examples. Other situations remain untested.</p></>
              : <p role="status">{activeSummaryError || "Checking the saved examples for this version…"}</p>}
            <button disabled={disabled} onClick={() => { void inspectSource(activeSelectionMatches ? undefined : activeSnapshot.revision.id); openTools(); }}>Inspect this version’s source</button>
            <button disabled={disabled || !activeSelectionMatches || !state.selection.eligible} onClick={() => { setRestart({ draftVersion: state.draftVersion, revisionId: activeSnapshot.revision.id, generation: activeSnapshot.generation, activeLabel: activeSnapshot.revision.label, draftLabel: state.draft?.label ?? "saved" }); closeReview(); }}>Start changes from this version</button>
            <button onClick={() => { setActiveView(false); closeReview(); }}>Continue saved changes</button>
          </article>}
          {evidence && <article hidden={canvasView !== "results"} className="rs-sheet rs-results" aria-label="Sample results">
            <h3 id="studio-results-heading" tabIndex={-1}>{exampleId ? exampleTitle(evidence.reports.find(item => item.id === exampleId)!, evidence.reports.findIndex(item => item.id === exampleId)) : "Saved checked examples"}</h3>
            <section aria-label="Expected and actual sample results">{evidence.reports.filter(item => !exampleId || item.id === exampleId).map((item, index) => {
              const observed = knownObservation(item.report.consumption), expected = knownObservation(item.expected.consumption);
              return <article className="rs-example" key={item.id} aria-label={`Example: ${exampleLabel(item, index)}`}>
                <div className="rs-example-task"><span className="rs-task-mark" aria-hidden="true">{item.taskStatus === "COMPLETED" ? "✓" : item.taskStatus === "OPEN" ? "○" : "–"}</span><div><small>Sample task{item.taskStatus === "OPEN" ? " · Unfinished" : item.taskStatus === "COMPLETED" ? " · Completed" : ""}</small><h4>{exampleLabel(item, index)}</h4></div></div>
                <dl><div><dt>You wanted</dt><dd>{expectedAdvice(item.expected)}</dd></div><div><dt>In this example</dt><dd>{observedAdvice(item.report.consumption)}</dd></div></dl>
                <p className={observed && expected && item.report.status === "PASS" ? "rs-match" : "rs-mismatch"}>{!observed ? "This result was not observed" : !expected ? "The expected advice was not recorded" : item.report.status === "PASS" ? "Matches what you wanted" : "This example needs a correction"}</p>
                <details><summary>Technical run details</summary><pre>{JSON.stringify({ id: item.id, expected: item.expected, actual: item.report }, null, 2)}</pre></details>
              </article>;
            })}</section>
            <p>{currentEvidence ? "Saved example for the current changes." : evidence.revisionId === state.draft?.id ? "Earlier saved check for these changes." : "Earlier example · this does not approve your current changes."} SYNTHETIC · no live task changes.</p>
            {evidence.reports.length > 1 && <details><summary>Other checked examples</summary>{evidence.reports.filter(item => item.id !== exampleId).map((item, index) => <p key={item.id}><button className="rs-link" onClick={() => {
              readingRevision.current++; setExampleId(item.id); canvasScroll.current = 0; if (canvas.current) canvas.current.scrollTop = 0;
              document.getElementById("studio-results-heading")?.focus({ preventScroll: true });
            }}>{exampleTitle(item, index)}</button></p>)}</details>}
            <details><summary>About these examples</summary><span>SYNTHETIC · Saved sample run · {currentEvidence ? "Current proposal" : evidence.revisionId === state.draft?.id ? "Earlier run for current proposal" : "Earlier proposal"}</span>
              {evidence.id === state.approvedEvidenceId && <p>Approved run</p>}{evidence.id === state.evidence?.id && <p>Latest run</p>}
              <p>These are synthetic sample tasks, not live task changes. Expected results were defined independently of this run. Only the listed cases are exercised; other inputs and situations remain untested.</p></details>
            <details><summary>Saved run identity</summary><p>Evidence: {evidence.id}</p><p>Revision: {evidence.revisionId}</p><pre>{JSON.stringify(evidence.identity, null, 2)}</pre></details>
            <details><summary>Exact saved simulation report · SYNTHETIC</summary><pre aria-label="Saved synthetic simulation report">{JSON.stringify(evidence, null, 2)}</pre></details>

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
            <h3>Saved conversations</h3>
            {authoring && (extensionId.current || legacyConversation) && authoring.conversations.length > 0 && <label>Saved authoring conversation<select aria-label="Saved authoring conversation" value={conversation?.id ?? ""} disabled={!!busy || activeAuthoring || !!pendingTurn || !!pendingExample}
              onChange={event => { if (event.target.value) { historyMode.current = true; setHistoryView(true); setScripted(false); setMessages([]); void loadAuthoring(event.target.value).then(() => { if (mounted.current) closeReview(); }); } }}><option value="" disabled>Choose a saved conversation</option>{authoring.conversations.filter(item => item.extensionId === extensionId.current).map((item, index) => <option key={item.id} value={item.id}>Conversation {index + 1}</option>)}</select></label>}
            {conversation && <><p role="status">{authoringStatus[conversation.status]} {authoringReason(conversation.code)}</p>
              {!activeAuthoring && !legacyConversation && !historyView && !staleConversation && <button disabled={!!busy || !!pendingTurn || !!pendingExample || (authoring?.conversations.length ?? 0) >= 8} onClick={newConversation}>Continue current changes in a new conversation</button>}</>}
            {!authoringError && !observationPaused && !pendingTurn && <button disabled={!!busy} onClick={() => void loadAuthoring(conversation?.id ?? null)}>Check authoring status</button>}
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
              <small>{item.id === state.evidence?.id ? "Current proposal" : "Earlier run"} · revision {item.revisionId}</small>
            </li>)}</ol>
          </details>}
          <details className="rs-sheet rs-secondary" aria-label="Manage saved customization"><summary>Manage saved customization</summary>
            <button disabled={disabled || state.selection.revision?.extensionId !== state.extension?.id} onClick={() => void mutate("disable", { generation: state.selection.generation }, "Your advice is off. Your tasks have not changed.", true)}>Turn off my advice</button>
          <h3>Return to an earlier choice</h3>
            <label htmlFor="studio-restore">Previously in use</label><select id="studio-restore" value={restore} disabled={disabled} onChange={e => setRestore(e.target.value)}>
              <option value="">Choose a saved choice…</option>{state.restoreTargets.map((item, index) => <option key={item.id} value={item.id}>{item.label} · {item.provenance === "operator" ? "operator starting choice" : "customer approved"} · choice {index + 1}</option>)}</select>
            {restoreTarget && <div className="rs-restore-confirm"><p>Restore <strong>{restoreTarget.label}</strong>{restoreTarget.kind === "authored" ? " with its exact reviewed source and examples." : " for your open tasks; completed tasks show Done."} {restoreTarget.provenance === "operator" ? "This was an operator-provided starting choice." : "This choice was approved for you."} No task or earlier action is undone.</p>
              <details><summary>Exact choice to restore</summary><p>Revision: {restoreTarget.id}</p><pre>{JSON.stringify(restoreTarget.pins, null, 2)}</pre></details>
              <button disabled={disabled} onClick={() => void mutate("rollback", { revisionId: restoreTarget.id, generation: state.selection.generation }, `Restored ${restoreTarget.label} for your tasks.`, true)}>Restore {restoreTarget.label} for me</button></div>}
            <details><summary>Selection history and exact identities</summary><p>Current generation: {state.selection.generation}</p>
              <ol>{history.map(item => <li key={item.id}>{item.operation === "draft-superseded" ? "Earlier saved changes" : item.operation} · {item.label ?? ""} · generation {item.generation} · {item.revisionId ?? "Advice off"}</li>)}</ol>
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
      if (reviewOpen) closeReview();
      closeSetup();
    }} />}
  </section>;
}
