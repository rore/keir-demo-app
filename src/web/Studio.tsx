import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import "./Studio.css";

type Revision = { id: string; templateId: string; kind?: "authored" | "prepared"; suiteDigest?: string | null; label: string; pins: object; provenance: "operator" | "customer" };
type History = { id: number; generation: number; operation: string; revisionId: string | null };
export type State = {
  owner: { id: string; name: string };
  catalog: { id: string; label: string; openCode: string }[];
  draftVersion: number;
  draft: Revision | null;
  evidence: { id: string; revisionId: string; passed: boolean } | null;
  approved: boolean;
  approvedEvidenceId: string | null;
  selection: { generation: number; revision: Revision | null; eligible: boolean };
  restoreTargets: Revision[];
  history: History[];
  evidenceHistory: { id: string; revisionId: string }[];
};
type Outcome = { classification: string; code?: string };
type SavedSource = { revisionId: string; source: string; cases: string[]; suiteDigest: string | null };
type Evidence = { id: string; revisionId: string; kind?: "authored" | "prepared"; identity: object; passed: boolean; reports: {
  id: string; label: string; expected: Outcome;
  report: { status: string; native?: Outcome; consumption?: { status: string; code?: string }; mismatches: object[] };
}[] };
type Message = { id: number | string; who: "You" | "Studio"; text: string; evidenceId?: string; exampleCount?: number };
type Operation = { id: string; runId: string; version: number };
type Conversation = {
  id: string; version: number; status: "IDLE" | "RUNNING" | "CANCELLING" | "AWAITING_USER" | "REVIEW_AVAILABLE" | "CANCELLED" | "BLOCKED" | "INTERRUPTED";
  runId: string; operation: Operation; messages: { id: string; role: "user" | "assistant"; text: string; kind: "text" | "clarification" | "review" }[];
  code: string | null; review: { revisionId: string; draftVersion: number; suiteDigest: string; evidenceId: string; eligible: boolean } | null;
  draft: { revisionId: string | null; draftVersion: number; suiteDigest: string | null }; selection: { revisionId: string | null; generation: number };
};
type Authoring = {
  availability: { available: boolean; code: string | null; provider: "openai" | "anthropic" | null; model: string | null };
  conversations: { id: string; version: number; status: Conversation["status"]; runId: string; creationOperationId: string; operationId: string }[];
  current: Conversation | null;
};
type Turn = { conversationId: string | null; operationId: string; text: string; expectedVersion: number; expectedDraftVersion: number };
type Setup = {
  configuration: { status: string; code: string | null; source: "local" | "environment" | "none"; provider: string | null; model: string | null; maxUsd: string | null };
  choices: { provider: string; model: string }[];
  availability: Authoring["availability"];
};
const running = (value: Conversation | null) => value?.status === "RUNNING" || value?.status === "CANCELLING";
const authoringStatus = {
  IDLE: "Ready for a description.", RUNNING: "Preparing task advice…", CANCELLING: "Stopping authoring; waiting for work to settle…",
  AWAITING_USER: "Your answer is needed before authoring can continue.", REVIEW_AVAILABLE: "Saved advice is ready to inspect. Approval and Use are your separate decisions.",
  CANCELLED: "Authoring stopped. Saved work remains available.", BLOCKED: "Authoring could not continue. Saved work remains available.",
  INTERRUPTED: "Authoring was interrupted. Check saved state before explicitly continuing.",
};
function authoringReason(code: string | null | undefined) {
  if (!code) return "";
  if (["AI_NOT_CONFIGURED", "AI_CONFIG_INVALID", "AI_CREDENTIALS_MISSING"].includes(code)) return "AI authoring is not configured.";
  if (["SPEND_LIMIT", "BUDGET_EXHAUSTED"].includes(code)) return "The shared authoring allowance is exhausted. Saved advice and review remain available.";
  if (code === "CONFIG_CHANGED") return "Assistant settings changed. Start a new conversation to continue; your saved customization remains available.";
  if (code === "CONVERSATION_LIMIT") return "The saved conversation limit has been reached. Existing conversations are retained.";
  if (["STALE_CONTEXT", "STALE_DRAFT", "STALE_CONVERSATION", "CHECKPOINT_UNCERTAIN"].includes(code)) return "The request needs saved-state readback before another change. No approval or activation is implied.";
  if (code === "REVIEW_NOT_READY") return "The saved examples do not yet support approval. Inspect their results or discuss the correction.";
  return "AI authoring is unavailable for this request. Check saved state; native tasks and saved advice remain available.";
}
type Props = {
  request: <T>(path: string, method?: string, body?: object, signal?: AbortSignal) => Promise<T>;
  changed: (generation: number) => void;
  beforeSelectionChange: () => void;
  back: () => void;
  backLabel: string;
  start?: boolean;
};
const advice = (code?: string) => ({ PENDING: "Pending", NEEDS_ATTENTION: "Needs attention", DONE: "Done" })[code ?? ""] ?? code;
const expectedAdvice = (value: Outcome) => value.classification === "COMPLETED" ? advice(value.code) : "No advice";

function AssistantSetup({ request, close, saved }: { request: Props["request"]; close: (uncertain: boolean) => void; saved: (value: Setup) => void }) {
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
  const callbacks = useRef({ request, close, saved });
  callbacks.current = { request, close, saved };
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
    const apiKey = key.current.value;
    key.current.value = "";
    try {
      const next = await callbacks.current.request<Setup>("authoring/setup", "POST", { provider, model, apiKey, maxUsd }, lifetime.current.signal);
      if (alive.current) callbacks.current.saved(next);
    } catch (failure) {
      if (!alive.current) return;
      const status = (failure as { status?: number })?.status;
      uncertain.current ||= ![400, 401, 403, 409, 413, 415, 503].includes(status ?? 0);
      setError(status === 409 ? "Settings were not saved. Wait for running authoring to settle and check that the total allowance covers prior reservations. Re-enter the key before explicitly saving again."
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
        <p>The service receives your authoring messages, public host contract, draft source, synthetic examples and sanitized tool results. It may charge for explicit chat requests.</p>
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
        <div><button className="primary" disabled={!setup || waiting || reading || readFailed}>{waiting ? "Saving settings…" : "Save settings"}</button>
          <button type="button" onClick={() => callbacks.current.close(saving.current || uncertain.current)}>Cancel</button></div>
      </div>
    </form>
  </dialog>;
}

export default function Studio({ request, changed, beforeSelectionChange, back, backLabel, start = false }: Props) {
  const [entry, setEntry] = useState(start ? "start" : "item");
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupNotice, setSetupNotice] = useState("");
  const setupInvoker = useRef<HTMLElement | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [state, setState] = useState<State | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [review, setReview] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [reviewSource, setReviewSource] = useState<(SavedSource & { ownerId: string; key: string }) | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [inspection, setInspection] = useState<(SavedSource & { key: string }) | null>(null);
  const [restore, setRestore] = useState("");
  const [lookup, setLookup] = useState("");
  const [text, setText] = useState("");
  const [authoring, setAuthoring] = useState<Authoring | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [authoringError, setAuthoringError] = useState("");
  const [pendingTurn, setPendingTurn] = useState<Turn | null>(null);
  const [retryTurn, setRetryTurn] = useState(false);
  const [observationPaused, setObservationPaused] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const observation = useRef({ runId: "", reads: 0 });
  const authoringLifetime = useRef(new AbortController());
  const [width, setWidth] = useState(52);
  const [pane, setPane] = useState<"conversation" | "preview">("conversation");
  const [canvasView, setCanvasView] = useState<"advice" | "results" | "review">("advice");
  const [newMessages, setNewMessages] = useState(false);
  const [history, setHistory] = useState<History[]>([]);
  const [historyNext, setHistoryNext] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const room = useRef<HTMLDivElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLElement>(null);
  const canvasScroll = useRef(0);
  const readingAnchor = useRef<{ element: HTMLElement; top: number; revision: number } | null>(null);
  const reviewInvoker = useRef<HTMLElement | null>(null);
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
  const callbacks = useRef({ request, changed, beforeSelectionChange });
  callbacks.current = { request, changed, beforeSelectionChange };
  const offer = conversation?.review;
  const offeredEvidence = offer?.eligible === true && !!state?.draft && offer.revisionId === state.draft.id
    && offer.draftVersion === state.draftVersion && offer.suiteDigest === state.draft.suiteDigest
    && offer.evidenceId === evidence?.id && offer.revisionId === evidence?.revisionId;
  const reviewKey = state?.draft && evidence ? `${state.owner.id}/${state.draft.id}/${state.draftVersion}/${evidence.id}` : "";
  const inspectionKey = state?.draft ? `${state.owner.id}/${state.draft.id}/${state.draftVersion}/${state.draft.suiteDigest ?? ""}` : "";
  const currentEvidence = !!state?.draft && evidence?.revisionId === state.draft.id && (evidence?.id === state.evidence?.id || offeredEvidence);
  const canReview = trusted && currentEvidence && evidence?.passed && (offeredEvidence || state?.evidence?.passed);
  const activeAuthoring = running(conversation);
  const disabled = !!busy || !trusted || activeAuthoring || !!pendingTurn;
  const reviewReady = reviewed.current?.kind !== "authored" || !!reviewSource && reviewSource.key === review && reviewSource.ownerId === state?.owner.id && reviewSource.revisionId === state?.draft?.id && reviewSource.suiteDigest === state?.draft?.suiteDigest;

  function openPane(next?: "advice" | "results" | "review", invoker = document.activeElement) {
    const reading = ++readingRevision.current;
    if (next && next !== canvasView) canvasScroll.current = 0;
    const position = canvasScroll.current;
    if (!reviewOpen) reviewInvoker.current = invoker instanceof HTMLElement ? invoker : null;
    if (next) setCanvasView(next);
    setReviewOpen(true); setPane("preview");
    requestAnimationFrame(() => {
      if (!mounted.current || readingRevision.current !== reading) return;
      document.getElementById(next === "review" ? "studio-review" : next === "results" ? "studio-results-heading" : "studio-canvas")?.focus({ preventScroll: true });
      if (canvas.current) canvas.current.scrollTop = position;
      canvasScroll.current = position;
    });
  }
  function closeReview() {
    readingRevision.current++;
    if (canvas.current) canvasScroll.current = canvas.current.scrollTop;
    setReviewOpen(false); setPane("conversation");
    requestAnimationFrame(() => {
      const target = reviewInvoker.current;
      (target?.isConnected && target.getClientRects().length ? target : document.getElementById("studio-open-review"))?.focus({ preventScroll: true });
    });
  }
  function openTools() {
    openPane("advice");
    requestAnimationFrame(() => {
      const details = document.querySelector<HTMLDetailsElement>(".rs-tools");
      if (details) { details.open = true; details.querySelector("summary")?.focus(); }
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
    const bounds = canvas.current?.getBoundingClientRect();
    const anchor = bounds && bounds.height > 0 && Array.from(canvas.current!.querySelectorAll<HTMLElement>("tbody tr")).find(row => {
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
  async function openReview() {
    if (locked.current) return;
    if (!canReview) {
      say("Open the current proposal's sample results first. A complete passing run is needed before you can approve it.");
      return;
    }
    setReview(reviewKey);
    reviewed.current = { owner: state!.owner.name, label: state!.draft!.label, revisionId: state!.draft!.id, evidenceId: evidence!.id, kind: state!.draft!.kind };
    openPane("review");
    setConfirmed(false); setReviewSource(null); setReviewError("");
    say("Review the exact proposal and its sample results on the canvas. Only the separate Approve button records your approval; Use is a further decision.");
    if (state!.draft!.kind !== "authored") return;
    const target = { ownerId: state!.owner.id, revisionId: state!.draft!.id, suiteDigest: state!.draft!.suiteDigest, key: reviewKey };
    locked.current = true;
    const turn = ++serial.current;
    setBusy("Opening exact saved source and examples…");
    try {
      const saved = await callbacks.current.request<SavedSource>(`extensions/revisions/${encodeURIComponent(target.revisionId)}`);
      if (!mounted.current || serial.current !== turn) return;
      if (saved.revisionId !== target.revisionId || !target.suiteDigest || saved.suiteDigest !== target.suiteDigest || typeof saved.source !== "string" || !saved.source.trim() || !Array.isArray(saved.cases) || !saved.cases.length || saved.cases.some(item => typeof item !== "string" || !item.trim())) throw new Error("Saved review mismatch");
      setReviewSource({ ...saved, ownerId: target.ownerId, key: target.key });
    } catch {
      if (mounted.current && serial.current === turn) setReviewError("Exact saved source and examples could not be checked. Approval is unavailable. Your conversation draft has not changed.");
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
      const next = await callbacks.current.request<State>("extensions");
      if (mounted.current && serial.current === turn) { apply(next); setNotice(announce ? "Saved state checked." : ""); }
    } catch {
      if (mounted.current && serial.current === turn) { setTrusted(false); setError("Saved advice could not be checked. Reload saved state before making another change."); }
    } finally {
      if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); }
    }
  }
  async function adoptConversation(next: Conversation, turn: number, creationOperationId?: string) {
    if (!mounted.current || serial.current !== turn) return;
    if (!running(next)) {
      const saved = await callbacks.current.request<State>("extensions", "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      apply(saved);
    }
    setConversation(next);
    setAuthoring(index => {
      if (!index) return index;
      const previous = index.conversations.find(item => item.id === next.id);
      if (!previous && !creationOperationId) return index;
      const summary = { id: next.id, version: next.version, status: next.status, runId: next.runId, operationId: next.operation.id, creationOperationId: previous?.creationOperationId ?? creationOperationId! };
      return { ...index, conversations: [summary, ...index.conversations.filter(item => item.id !== next.id)] };
    });
    const incoming: Message[] = next.messages.map(item => ({ id: `ai:${next.id}:${item.id}`, who: item.role === "user" ? "You" : "Studio", text: item.text }));
    setMessages(old => {
      const ids = new Set(old.map(item => item.id));
      const byId = new Map(incoming.map(item => [item.id, item]));
      const merged = [...old.filter(item => typeof item.id !== "string" || item.id.startsWith(`ai:${next.id}:`)).map(item => {
        const updated = byId.get(item.id); return updated && (updated.text !== item.text || updated.who !== item.who) ? updated : item;
      }), ...incoming.filter(item => !ids.has(item.id))];
      return merged.length === old.length && merged.every((item, index) => item === old[index]) ? old : merged;
    });
    initialized.current = true; setEntry("item");
  }
  async function loadAuthoring(id?: string | null) {
    if (locked.current) return;
    locked.current = true;
    const turn = ++serial.current;
    setBusy("Checking authoring status…"); setAuthoringError("");
    try {
      const next = await callbacks.current.request<Authoring>("authoring", "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      setAuthoring(next);
      const selected = id === undefined ? next.current?.id : id;
      if (selected) {
        const current = next.current?.id === selected ? next.current : await callbacks.current.request<Conversation>(`authoring/conversations/${encodeURIComponent(selected)}`, "GET", undefined, authoringLifetime.current.signal);
        if (current?.id !== selected) throw new Error("Unconfirmed conversation");
        await adoptConversation(current!, turn);
      }
      if (mounted.current && serial.current === turn) setObservationPaused(false);
    } catch {
      if (mounted.current && serial.current === turn) { setAuthoring(null); setObservationPaused(true); setAuthoringError("AI authoring status could not be checked. Retry status before continuing a conversation. Saved advice remains available."); }
    } finally { if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); } }
  }
  async function recoverTurn(input: Turn, turn: number) {
    const index = await callbacks.current.request<Authoring>("authoring", "GET", undefined, authoringLifetime.current.signal);
    if (!mounted.current || serial.current !== turn) return;
    setAuthoring(index);
    const summary = index.conversations.find(item => input.conversationId ? item.id === input.conversationId : item.creationOperationId === input.operationId);
    if (summary) {
      const current = await callbacks.current.request<Conversation>(`authoring/conversations/${encodeURIComponent(summary.id)}`, "GET", undefined, authoringLifetime.current.signal);
      if (current.id !== summary.id) throw new Error("Unconfirmed conversation");
      await adoptConversation(current, turn);
      if (!mounted.current || serial.current !== turn) return;
      if (summary.creationOperationId === input.operationId || current.operation.id === input.operationId) {
        setPendingTurn(null); setRetryTurn(false); setAuthoringError("");
        setText(value => value === input.text ? "" : value);
        return;
      }
    }
    setRetryTurn(true);
    setAuthoringError("Saved state was checked, but acceptance of this request is unconfirmed. You may explicitly retry the same submitted request; it keeps its operation identity.");
  }
  async function submitAuthoring(input: Turn, recoveryOnly = false) {
    if (locked.current || !trusted) return;
    locked.current = true;
    const turn = ++serial.current;
    setBusy(recoveryOnly ? "Checking submitted request…" : "Sending description…");
    setAuthoringError(""); setRetryTurn(false); setPendingTurn(input);
    try {
      if (recoveryOnly) await recoverTurn(input, turn);
      else {
        try {
          const accepted = await callbacks.current.request<{ operation: Operation; conversation: Conversation }>("authoring/turn", "POST", input, authoringLifetime.current.signal);
          if (!mounted.current || serial.current !== turn) return;
          if (accepted.operation.id !== input.operationId || accepted.operation.version !== input.expectedVersion + 1 || accepted.conversation.version < accepted.operation.version || !accepted.operation.runId || input.conversationId && accepted.conversation.id !== input.conversationId) throw new Error("Unconfirmed authoring receipt");
          await adoptConversation(accepted.conversation, turn, input.conversationId === null ? input.operationId : undefined);
          if (!mounted.current || serial.current !== turn) return;
          setPendingTurn(null); setText(value => value === input.text ? "" : value); setObservationPaused(false);
        } catch {
          if (!mounted.current || serial.current !== turn) return;
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
    void refresh().then(() => { if (mounted.current) void loadAuthoring(); });
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
      ? selected ? `${state.draft.label} is already in use. Open saved examples, discuss a change or manage this customization.`
        : `Your saved ${state.draft.label} choice is approved. Choose Use this advice for me when you are ready. Your current choice has not changed.`
      : state.draft.kind === "authored" && !state.draft.suiteDigest
        ? `Saved source: ${state.draft.label}. Continue in the conversation to prepare independent examples. Your current advice has not changed.`
        : `Saved proposal: ${state.draft.label}. Continue with its sample examples or discuss a change. Your current advice has not changed.`
      : "When you check an open task, what should it say?";
    setMessages([{ id: ++messageId.current, who: "Studio", text }]);
  }, [entry, state, trusted]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const available = (room.current?.clientWidth ?? 900) - 14;
      const min = Math.max(30, Math.ceil(300 / available * 100));
      const max = Math.min(70, Math.floor((available - 340) / available * 100));
      if (min <= max) setLimits({ min, max });
    });
    if (room.current) observer.observe(room.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const log = chatEnd.current?.parentElement;
    if (log && followConversation.current) log.scrollTop = log.scrollHeight;
    else setNewMessages(true);
  }, [messages]);
  useEffect(() => { if (review && reviewOpen) document.getElementById("studio-review")?.focus(); }, [review, reviewOpen]);
  useEffect(() => {
    if (!busy && focusUse.current) { focusUse.current = false; document.getElementById("use-task-advice")?.focus(); }
  }, [busy]);

  async function mutate(operation: string, body: object, message: string, selection = false) {
    if (locked.current || !trusted || activeAuthoring || pendingTurn) return;
    locked.current = true;
    const turn = ++serial.current;
    const reading = readingRevision.current;
    setBusy(operation === "simulate" ? "Trying the sample tasks…" : "Saving your choice…");
    setError(""); setNotice(""); setConfirmed(false);
    try {
      if (selection) callbacks.current.beforeSelectionChange();
      const next = await callbacks.current.request<State>(`extensions/${operation}`, "POST", body);
      if (!mounted.current || serial.current !== turn) return;
      const followReading = readingRevision.current === reading;
      if (operation === "approve" && followReading) focusUse.current = true;
      apply(next);
      say(message);
      setNotice(message);
      if (operation === "simulate" && next.evidence) {
        const proof = await callbacks.current.request<Evidence>(`extensions/evidence/${encodeURIComponent(next.evidence.id)}`);
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
        const next = await callbacks.current.request<State>("extensions");
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
  async function inspectSource() {
    if (locked.current || disabled || state?.draft?.kind !== "authored") return;
    locked.current = true; const turn = ++serial.current;
    const identity = inspectionKey, revision = state.draft.id, suite = state.draft.suiteDigest ?? null;
    setBusy("Inspecting saved source and examples…"); setError(""); setInspection(null);
    try {
      const next = await callbacks.current.request<SavedSource>(`extensions/revisions/${encodeURIComponent(revision)}`, "GET", undefined, authoringLifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      if (next.revisionId !== revision || next.suiteDigest !== suite || typeof next.source !== "string" || !next.source.trim() || !Array.isArray(next.cases) || next.cases.some(item => typeof item !== "string" || !item.trim())) throw new Error("Saved inspection mismatch");
      setInspection({ ...next, key: identity });
    } catch { if (mounted.current && serial.current === turn) setError("Exact saved source and examples could not be checked. No proposal or approval was changed."); }
    finally { if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); } }
  }
  async function showEvidence(id: string) {
    if (locked.current || !id.trim()) return;
    locked.current = true;
    const turn = ++serial.current;
    const reading = ++readingRevision.current;
    const invoker = document.activeElement;
    setBusy("Opening saved sample results…"); setError(""); setReview(""); setConfirmed(false);
    try {
      const proof = await callbacks.current.request<Evidence>(`extensions/evidence/${encodeURIComponent(id.trim())}`);
      if (mounted.current && serial.current === turn && readingRevision.current === reading) {
        if (evidence?.id !== proof.id) canvasScroll.current = 0;
        setEvidence(proof); openPane("results", invoker);
      }
    } catch {
      if (mounted.current && serial.current === turn) setError("Those saved sample results are unavailable for this person. No advice was changed.");
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
      const next = await callbacks.current.request<{ rows: History[]; next: number | null }>(`extensions/history?before=${historyNext}`);
      if (mounted.current && serial.current === turn) { setHistory(old => [...old, ...next.rows]); setHistoryNext(next.next); }
    } catch {
      if (mounted.current && serial.current === turn) setError("Earlier selections could not be loaded. No advice was changed.");
    } finally {
      if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || disabled || !authoring?.availability.available) return;
    if (authoring?.availability.available) {
      if (/[\uD800-\uDFFF]/u.test(text) || new TextEncoder().encode(text).length > 8192) { setAuthoringError("Use valid text within the 8 KiB description limit."); return; }
      void submitAuthoring({ conversationId: conversation?.id ?? null, operationId: crypto.randomUUID(), text,
        expectedVersion: conversation?.version ?? 0, expectedDraftVersion: state!.draftVersion });
      return;
    }
  }
  const target = state?.restoreTargets.find(item => item.id === restore);
  const selectedDraft = !!state?.selection.eligible && state.selection.revision?.id === state.draft?.id;
  function view(next: "advice" | "results" | "review") { readingRevision.current++; setCanvasView(next); }
  function openSetup() {
    setupInvoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSetupOpen(true);
  }
  function closeSetup(uncertain = false) {
    setSetupOpen(false);
    void loadAuthoring(conversation?.id ?? null);
    if (uncertain) {
      setSetupNotice("Saving could not be confirmed. Checking current settings without resubmitting; no message will be sent.");
      void callbacks.current.request<Setup>("authoring/setup", "GET", undefined, authoringLifetime.current.signal).then(next => {
        if (!mounted.current) return;
        setAuthoring(old => old ? { ...old, availability: next.availability } : old);
        setSetupNotice("Current settings checked. The interrupted save's key replacement cannot be confirmed. Open Configure to explicitly save again if needed.");
      }).catch(() => { if (mounted.current) setSetupNotice("Settings could not be checked. Open Configure to retry status before saving again."); });
    }
    requestAnimationFrame(() => {
      const invoker = setupInvoker.current;
      (invoker?.isConnected && invoker.getClientRects().length ? invoker : document.getElementById("assistant-configure") ?? document.getElementById("studio-message"))?.focus({ preventScroll: true });
    });
  }
  return <section className={`read-studio${reviewOpen ? " rs-review-open" : ""}`} aria-label="Advice Studio">
    <div className="sr-only" role="status">{busy || notice}</div>
    <header className="rs-header"><div><p className="rs-breadcrumb">Customizations{entry === "item" ? " / Task advice" : ""}</p><h1 id="studio-title" tabIndex={-1}>{entry === "start" ? "New customization" : "Task advice"} <span>Studio</span></h1></div>
      <button onClick={back} disabled={!!busy}>{backLabel}</button></header>
    {error && <div role="alert" className="rs-error">{error} <button onClick={() => void refresh(true)} disabled={!!busy}>Retry</button></div>}
    {entry === "item" && state && <div className="rs-status-summary" aria-label="Customization status">
      <div><strong>{state.selection.revision ? state.selection.eligible ? `In use · ${state.selection.revision.label}` : "Unavailable" : "Off"}</strong>
        {state.draft && !selectedDraft && <span>{state.approved ? "Approved" : "Proposed"} · {state.draft.label}</span>}</div>
      <div className="rs-summary-actions">
        {state.approved && state.draft && !selectedDraft && <button id="use-task-advice" className="rs-primary" disabled={disabled}
          onClick={() => void mutate("activate", { revisionId: state.draft!.id, draftVersion: state.draftVersion, generation: state.selection.generation }, "Your approved advice is now in use. Return to Tasks and check a saved task's advice to see it.", true)}>Use this advice for me</button>}
        <button id="studio-open-review" onClick={() => openPane("advice")}>View proposal</button>
        {state.draft && <button className={!state.approved && !state.evidence?.passed ? "rs-primary" : undefined} disabled={!trusted || state.draft.kind === "authored" && !state.draft.suiteDigest} aria-disabled={disabled} onClick={() => void mutate("simulate", { revisionId: state.draft!.id, draftVersion: state.draftVersion }, "A new sample run was saved.")}>Try on sample tasks</button>}
        {state.approvedEvidenceId && <button disabled={!!busy} onClick={() => void showEvidence(state.approvedEvidenceId!)}>Approved run</button>}
        {state.evidence && <button className={!state.approved && state.evidence.passed ? "rs-primary" : undefined} disabled={!!busy} onClick={() => void showEvidence(state.evidence!.id)}>Latest run</button>}
        <button onClick={openTools}>Manage</button>
      </div>
    </div>}
    <div className={`rs-room rs-show-${pane}${reviewOpen ? "" : " rs-review-closed"}`} ref={room} style={{ "--rs-chat": Math.max(limits.min, Math.min(limits.max, width)) } as CSSProperties}>
      <section className="rs-chat" aria-labelledby="studio-conversation">
        <div className="rs-chat-head"><h2 id="studio-conversation" tabIndex={-1}>Conversation</h2>
          {state && <p>{entry === "item" ? "Advice" : "Customizations"} for {state.owner.name}</p>}
          <p>Describe read-only task advice. Review and Use remain separate decisions. No tasks are changed.</p></div>
        <section className="rs-authoring" aria-label="AI authoring">
          <div className="rs-authoring-heading">
          <p>{authoring ? authoring.availability.available ? "Assistant configured" : authoringReason(authoring.availability.code) || "AI authoring is unavailable." : authoringError ? "Assistant status could not be checked." : "Checking assistant setup…"}</p>
          {activeAuthoring && <button className="rs-stop" disabled={!!busy || conversation?.status === "CANCELLING"} onClick={() => void stopAuthoring()}>{conversation?.status === "CANCELLING" ? "Stopping authoring…" : "Stop authoring"}</button>}
          {conversation?.review && <button disabled={!!busy || !trusted || !!pendingTurn} onClick={() => void showEvidence(conversation.review!.evidenceId)}>Open offered sample results</button>}
          {authoring?.availability.available && <button disabled={!!busy} onClick={openTools}>Details</button>}
          </div>
          <div className="rs-authoring-body">
          {authoring && authoring.conversations.length > 0 && <label>Saved authoring conversation<select aria-label="Saved authoring conversation" value={conversation?.id ?? ""} disabled={!!busy || activeAuthoring || !!pendingTurn}
            onChange={event => { if (event.target.value) void loadAuthoring(event.target.value); }}><option value="" disabled>Choose a saved conversation</option>{authoring.conversations.map((item, index) => <option key={item.id} value={item.id}>Conversation {index + 1} · {item.status.toLowerCase().replaceAll("_", " ")}</option>)}</select></label>}
          {conversation && <><p role="status">{authoringStatus[conversation.status]} {authoringReason(conversation.code)}</p>
            {!activeAuthoring && <button disabled={!!busy || !!pendingTurn || (authoring?.conversations.length ?? 0) >= 8} onClick={() => {
              setConversation(null); setMessages(old => old.filter(item => typeof item.id !== "string")); setObservationPaused(false); setAuthoringError("");
            }}>New conversation</button>}</>}
          {authoringError && <p role="alert">{authoringError}</p>}
          <button disabled={!!busy} onClick={() => pendingTurn ? void submitAuthoring(pendingTurn, true) : void loadAuthoring(conversation?.id ?? null)}>{!authoring && authoringError ? "Retry status" : "Check authoring status"}</button>
          {pendingTurn && retryTurn && <button disabled={!!busy} onClick={() => void submitAuthoring(pendingTurn)}>Retry submitted request</button>}
          </div>
        </section>
        <div className="rs-messages" tabIndex={0} role="log" aria-label="Studio conversation" aria-live="off" onScroll={event => {
          const log = event.currentTarget; followConversation.current = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
          if (followConversation.current) setNewMessages(false);
        }}>
          {entry === "start" ? <article className="rs-message rs-start">
            <strong>Studio</strong><h2>What would you like Daymark to do differently?</h2>
            <p>Describe a read-only task-advice rule in the conversation. The assistant can help prepare a proposal and examples; approval and Use are your decisions.</p>
          </article> : <>{messages.map(message => <article className={`rs-message ${message.who === "You" ? "rs-yours" : ""}`} key={message.id}>
            <strong>{message.who}</strong><p>{message.text}</p>{message.evidenceId && <button disabled={!!busy} className="rs-link"
              onClick={() => void showEvidence(message.evidenceId!)}>Review {message.exampleCount} {message.exampleCount === 1 ? "example" : "examples"}</button>}
          </article>)}
          </>}
          <div ref={chatEnd} />
        </div>
        {newMessages && <button className="rs-new-messages" onClick={() => { const log = chatEnd.current?.parentElement; if (log) log.scrollTop = log.scrollHeight; followConversation.current = true; setNewMessages(false); }}>New messages ↓</button>}
        {authoring && !authoring.availability.available && ["AI_NOT_CONFIGURED", "AI_CONFIG_INVALID", "AI_CREDENTIALS_MISSING"].includes(authoring.availability.code ?? "") && <div className="rs-setup-notice"><p>Set up the assistant to create or change a customization.</p><button id="assistant-configure" onClick={openSetup}>Configure</button></div>}
        {setupNotice && <p className="rs-setup-notice" role="status">{setupNotice}</p>}
        <form className="rs-composer" onSubmit={submit}><label className="sr-only" htmlFor="studio-message">Message to Studio</label>
          <textarea id="studio-message" maxLength={8192} rows={2} value={text} onFocus={() => { readingRevision.current++; }} onChange={e => { readingRevision.current++; setText(e.target.value); }} placeholder="Describe task advice or answer a question…" />
          <button disabled={!authoring?.availability.available || disabled || !text.trim()}>Send</button></form>
        <p className="rs-chat-note">Submitted conversations are saved. Navigating away stops observation; Check authoring status reads saved progress without generating.</p>
      </section>
      <div hidden={!reviewOpen} className="rs-divider" role="separator" tabIndex={0} aria-label="Resize conversation and advice" aria-orientation="vertical"
        aria-valuemin={limits.min} aria-valuemax={limits.max} aria-valuenow={width}
        onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault(); readingRevision.current++; setWidth(old => event.key === "Home" ? limits.min : event.key === "End" ? limits.max : Math.max(limits.min, Math.min(limits.max, old + (event.key === "ArrowLeft" ? -2 : 2))));
        } }}
        onPointerDown={event => { readingRevision.current++; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && room.current) {
          const bounds = room.current.getBoundingClientRect(); setWidth(Math.round(Math.max(limits.min, Math.min(limits.max, (event.clientX - bounds.left) / (bounds.width - 14) * 100))));
        } }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />
      <section hidden={!reviewOpen} className="rs-preview" aria-label="Advice preview">
        <button className="rs-close-review" onClick={closeReview}>Back to conversation</button>
        <nav className="rs-canvas-tabs" aria-label="Advice views"><button aria-pressed={canvasView === "advice"} onClick={() => view("advice")}>Advice</button><button aria-pressed={canvasView === "results"} disabled={!evidence} onClick={() => view("results")}>Sample results</button>
          {review && <button aria-pressed={canvasView === "review"} onClick={() => view("review")}>Review</button>}</nav>
      <section id="studio-canvas" ref={canvas} tabIndex={0} className="rs-canvas" aria-label="Advice and sample results"
        onWheel={() => { readingRevision.current++; }} onKeyDown={() => { readingRevision.current++; }} onPointerDown={() => { readingRevision.current++; }}
        onScroll={event => { if (reviewOpen) canvasScroll.current = event.currentTarget.scrollTop; }}>
        {state && <>
          <div className="rs-comparison rs-sheet" hidden={canvasView !== "advice"}>
            <article aria-label="Current advice">
              <span className="rs-kicker">Current advice</span><span className="state-badge">{state.selection.revision ? state.selection.eligible ? "In use" : "Unavailable" : "Off"}</span>
              <h3>{state.selection.revision ? state.selection.eligible ? state.selection.revision.label : "Advice is unavailable" : "Advice is off"}</h3>
              <p>{state.selection.revision ? state.selection.eligible ? state.selection.revision.kind === "authored" ? "This read-only program is in use. Its saved examples describe the exercised behavior; other tasks remain untested." : `Open tasks: ${state.selection.revision.label}. Completed tasks: Done.`
                : `Your saved ${state.selection.revision.label} choice could not be validated. Task advice is not displayed. Your tasks still work as usual.`
                : "Task advice is not selected. Your tasks still work as usual."}</p>
            </article>
            <article hidden={selectedDraft} className="rs-proposed" aria-label="Proposed advice"><span className="rs-kicker">Proposed</span>
              <h3>{state.draft?.label ?? "No proposal yet"}</h3>
              <p>{state.draft ? state.draft.kind === "authored" ? state.draft.suiteDigest ? "Authored read-only program with independent saved examples. No task is edited." : "Source compiled and saved. Continue in the conversation to prepare independent examples before running checks." : `For your tasks: open → ${state.draft.label}; completed → Done. No task is edited.` : "Describe the advice you want in the conversation to prepare a proposal."}</p>
              {state.draft && <><p>{selectedDraft ? "This approved choice is in use." : state.approved ? "Approved. Use is a separate decision." : "This proposal is not approved."}</p>
                <div className="rs-actions">
                  {state.evidence && <button className={!currentEvidence && !state.approved ? "rs-primary" : undefined} disabled={!!busy} onClick={() => void showEvidence(state.evidence!.id)}>Open current sample results</button>}
                  {state.evidence && <button className={canReview && !state.approved ? "rs-primary" : undefined} disabled={disabled || !canReview} onClick={openReview}>Review this advice</button>}</div></>}
            </article>
          </div>
          {evidence && <article hidden={canvasView !== "results"} className="rs-sheet rs-results" aria-label="Sample results">
            <span className="rs-kicker">Saved sample run · {currentEvidence ? "Current proposal" : evidence.revisionId === state.draft?.id ? "Earlier run for current proposal" : "Earlier proposal"}</span>
            <h3 id="studio-results-heading" tabIndex={-1}>{evidence.passed ? "Sample run passed" : "Sample run did not pass"}</h3>
            {evidence.id === state.approvedEvidenceId && <p>Approved run</p>}
            {evidence.id === state.evidence?.id && <p>Latest run</p>}
            <p>These are synthetic sample tasks, not live task changes. Expected results were defined independently of this run. Only the listed cases are exercised; other inputs and situations remain untested.</p>
            <div className="rs-table-wrap"><table><caption>Expected and actual sample results</caption><thead><tr><th>Sample task</th><th>Expected</th><th>Actual</th></tr></thead>
              <tbody>{evidence.reports.map(item => <tr key={item.id}><th scope="row">{item.label}{evidence.kind !== "authored" && item.id === "completed" && item.expected.code === "DONE" && <small>The proposed change applies only to open tasks.</small>}</th><td>{expectedAdvice(item.expected)}</td>
                <td><strong>{item.report.status === "PASS" ? "Matches" : "Check needs review"}</strong><br />
                  {item.report.consumption?.status === "DISPLAYED" ? advice(item.report.consumption.code) : "No advice"}
                  <details><summary>Technical run details</summary><pre>{JSON.stringify({ expected: item.expected, actual: item.report }, null, 2)}</pre></details></td></tr>)}</tbody></table></div>
            <details><summary>Saved run identity</summary><p>Evidence: {evidence.id}</p><p>Revision: {evidence.revisionId}</p><pre>{JSON.stringify(evidence.identity, null, 2)}</pre></details>
            <div className="rs-actions"><button className={canReview ? "rs-primary" : undefined} disabled={disabled || !canReview} onClick={openReview}>Review this advice</button><button onClick={() => view("advice")}>Return to current proposal</button></div>
          </article>}
          {review && reviewed.current && <article hidden={canvasView !== "review"} id="studio-review" tabIndex={-1} className="rs-sheet rs-review" aria-label="Review exact advice">
            <span className="rs-kicker">For {reviewed.current.owner} only</span><h3>Review: {reviewed.current.label}{reviewed.current.kind !== "authored" && " for open tasks"}</h3>
            <p>{reviewed.current.kind === "authored" ? "Review this exact source and its independent expected examples. The run checks only those examples; unlisted behavior remains untested. This program cannot edit tasks." : "Completed tasks show Done. Missing, denied or unavailable reads show no advice. The sample run checks these situations; it does not certify every live task or change any task."}</p>
            <details><summary>Exact proposal and reviewed evidence</summary><p>Revision: {reviewed.current.revisionId}</p><p>Evidence: {reviewed.current.evidenceId}</p></details>
            {reviewed.current.kind === "authored" && <>
              <p>These read-only saved documents belong to the exact revision above. Approval applies only to these saved documents and sample results.</p>
              {reviewReady && reviewSource && <>
                <h4>Saved source</h4><pre aria-label="Saved source for approval">{reviewSource.source}</pre>
                <section aria-label="Saved expected examples for approval"><h4>Saved independent expected examples</h4>{reviewSource.cases.map((item, index) => <pre key={index} aria-label={`Saved example ${index + 1} for approval`}>{item}</pre>)}</section>
              </>}
              {reviewError && <><p role="alert">{reviewError}</p><button disabled={disabled || !canReview || review !== reviewKey} onClick={() => void openReview()}>Reload exact saved source</button></>}
            </>}
            {review !== reviewKey && <p>This earlier review cannot approve the current proposal. Open its latest run to review the current examples.</p>}
            <label className="rs-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={disabled || !canReview || review !== reviewKey || !reviewReady} /> I reviewed these sample results and want this advice for my tasks.</label>
            <div className="rs-actions"><button className="rs-primary" disabled={disabled || !canReview || review !== reviewKey || !reviewReady || !confirmed || state.approvedEvidenceId === evidence?.id}
              onClick={() => void mutate("approve", { revisionId: state.draft!.id, draftVersion: state.draftVersion, evidenceId: evidence!.id }, "This exact advice is approved. It is not selected until you choose Use.")}>Approve this advice</button></div>
          </article>}
        </>}
        <details className="rs-sheet rs-tools"><summary>Details and recovery</summary>
          {authoring?.availability.provider && <section aria-label="Assistant connection details"><h3>Assistant connection</h3><p>Provider: {authoring.availability.provider}</p><p>Model: {authoring.availability.model}</p><button onClick={openSetup}>Configure</button></section>}
          {state && <>
          {state.selection.revision && <p>Current choice provenance: {state.selection.revision.provenance === "operator" ? "Operator-provided starting choice" : "Your approved choice"}</p>}
          {state.draft?.kind === "authored" && <section aria-label="Saved authored program">
            <button disabled={disabled} onClick={() => void inspectSource()}>Inspect saved source and examples</button>
            {inspection?.key === inspectionKey && <>
              <h3>Saved source</h3><pre aria-label="Saved source for inspection">{inspection.source}</pre>
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
          <details className="rs-sheet rs-secondary" aria-label="Manage saved advice"><summary>Manage saved advice</summary>
            <button disabled={disabled || !state.selection.revision} onClick={() => void mutate("disable", { generation: state.selection.generation }, "Your advice is off. Your tasks have not changed.", true)}>Turn off my advice</button>
          <h3>Return to an earlier choice</h3>
            <label htmlFor="studio-restore">Previously in use</label><select id="studio-restore" value={restore} disabled={disabled} onChange={e => setRestore(e.target.value)}>
              <option value="">Choose a saved choice…</option>{state.restoreTargets.map((item, index) => <option key={item.id} value={item.id}>{item.label} · {item.provenance === "operator" ? "operator starting choice" : "customer approved"} · choice {index + 1}</option>)}</select>
            {target && <div className="rs-restore-confirm"><p>Restore <strong>{target.label}</strong>{target.kind === "authored" ? " with its exact reviewed source and examples." : " for your open tasks; completed tasks show Done."} {target.provenance === "operator" ? "This was an operator-provided starting choice." : "This choice was approved for you."} No task or earlier action is undone.</p>
              <details><summary>Exact choice to restore</summary><p>Revision: {target.id}</p><pre>{JSON.stringify(target.pins, null, 2)}</pre></details>
              <button disabled={disabled} onClick={() => void mutate("rollback", { revisionId: target.id, generation: state.selection.generation }, `Restored ${target.label} for your tasks.`, true)}>Restore {target.label} for me</button></div>}
            <details><summary>Selection history and exact identities</summary><p>Current generation: {state.selection.generation}</p>
              <ol>{history.map(item => <li key={item.id}>{item.operation} · generation {item.generation} · {item.revisionId ?? "Advice off"}</li>)}</ol>
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
    {setupOpen && <AssistantSetup request={request} close={closeSetup} saved={next => {
      setAuthoring(old => old ? { ...old, availability: next.availability } : old);
      setSetupNotice("Settings saved. Send a message when you’re ready.");
      if (reviewOpen) closeReview();
      closeSetup();
    }} />}
  </section>;
}
