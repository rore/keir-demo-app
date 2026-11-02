import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
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
type Evidence = { id: string; revisionId: string; kind?: "authored" | "prepared"; identity: object; passed: boolean; reports: {
  id: string; label: string; expected: Outcome;
  report: { status: string; native?: Outcome; consumption?: { status: string; code?: string }; mismatches: object[] };
}[] };
type Message = { id: number; who: "You" | "Studio"; text: string; evidenceId?: string; exampleCount?: number };
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

export default function Studio({ request, changed, beforeSelectionChange, back, backLabel, start = false }: Props) {
  const [entry, setEntry] = useState(start ? "start" : "item");
  const [discovery, setDiscovery] = useState(false);
  const [choices, setChoices] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [state, setState] = useState<State | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [review, setReview] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [restore, setRestore] = useState("");
  const [lookup, setLookup] = useState("");
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [sourceLabel, setSourceLabel] = useState("Authored advice");
  const [caseTexts, setCaseTexts] = useState([""]);
  const [diagnostics, setDiagnostics] = useState<unknown[] | null>(null);
  const preparation = useRef<AbortController | null>(null);
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
  const reviewKey = state?.draft && state.evidence ? `${state.draft.id}/${state.draftVersion}/${state.evidence.id}` : "";
  const currentEvidence = !!state?.draft && evidence?.id === state.evidence?.id && evidence?.revisionId === state.draft.id;
  const canReview = trusted && currentEvidence && evidence?.passed && state?.evidence?.passed;
  const disabled = !!busy || !trusted;

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

  function say(text: string, who: Message["who"] = "Studio", evidenceId?: string, exampleCount?: number) {
    const id = ++messageId.current;
    setMessages(old => [...old, { id, who, text, evidenceId, exampleCount }].slice(-40));
  }
  function apply(next: State) {
    setState(next);
    setTrusted(true);
    setRestore("");
    setHistory(next.history);
    setHistoryNext(next.history.length === 20 ? next.history.at(-1)!.id : null);
    callbacks.current.changed(next.selection.generation);
  }
  function openReview() {
    if (!canReview) {
      say("Open the current proposal's sample results first. A complete passing run is needed before you can approve it.");
      return;
    }
    setReview(reviewKey);
    reviewed.current = { owner: state!.owner.name, label: state!.draft!.label, revisionId: state!.draft!.id, evidenceId: evidence!.id, kind: state!.draft!.kind };
    openPane("review");
    setConfirmed(false);
    say("Review the exact proposal and its sample results on the canvas. Only the separate Approve button records your approval; Use is a further decision.");
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
  useEffect(() => {
    mounted.current = true;
    document.getElementById("studio-title")?.focus();
    void refresh();
    return () => { mounted.current = false; preparation.current?.abort(); ++serial.current; locked.current = false; };
  }, []);
  useEffect(() => {
    if (entry !== "item" || !state || !trusted || initialized.current) return;
    initialized.current = true;
    const selected = state.selection.eligible && state.selection.revision?.id === state.draft?.id;
    const text = state.draft ? state.approved
      ? selected ? `${state.draft.label} is already in use. Open saved examples, change its choice or manage this customization.`
        : `Your saved ${state.draft.label} choice is approved. Choose Use this advice for me when you are ready. Your current choice has not changed.`
      : state.draft.kind === "authored" && !state.draft.suiteDigest
        ? `Saved source: ${state.draft.label}. Add independent examples in Developer qualification before running checks. Your current advice has not changed.`
        : `Saved proposal: ${state.draft.label}. Continue with its sample examples or change the choice. Your current advice has not changed.`
      : "When you check an open task, what should it say?";
    setMessages([{ id: ++messageId.current, who: "Studio", text }]);
    setChoices(!state.draft);
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
    if (locked.current || !trusted) return;
    locked.current = true;
    const turn = ++serial.current;
    const reading = readingRevision.current;
    const preparing = operation === "compile" || operation === "scenarios";
    const abort = preparing ? new AbortController() : null;
    preparation.current = abort;
    setBusy(operation === "compile" ? "Compiling source…" : operation === "scenarios" ? "Saving independent examples…" : operation === "simulate" ? "Trying the sample tasks…" : "Saving your choice…");
    setError(""); setNotice(""); setConfirmed(false); setDiagnostics(null);
    try {
      if (selection) callbacks.current.beforeSelectionChange();
      const next = await callbacks.current.request<State>(`extensions/${operation}`, "POST", body, abort?.signal);
      if (!mounted.current || serial.current !== turn) return;
      const followReading = readingRevision.current === reading;
      if (operation === "approve" && followReading) focusUse.current = true;
      apply(next);
      if (operation === "draft" && next.draft) {
        say(next.draft.label, "You");
        say(`An open task would say ${next.draft.label}. A completed task would still say Done.`);
        setChoices(false);
      } else {
        if (preparing) setChoices(false);
        say(message);
      }
      setNotice(message);
      if (operation === "simulate" && next.evidence) {
        const proof = await callbacks.current.request<Evidence>(`extensions/evidence/${encodeURIComponent(next.evidence.id)}`);
        if (mounted.current && serial.current === turn) {
          say(proof.passed ? `The sample run passed. Review ${proof.reports.length} examples when you are ready.`
            : "This sample run did not pass. It cannot be approved or put in use.", "Studio", proof.id, proof.reports.length);
        }
      }
    } catch (failure) {
      if (!mounted.current || serial.current !== turn) return;
      setTrusted(false);
      const conflict = (failure as { status?: number })?.status === 409;
      if (preparing) setDiagnostics((failure as { diagnostics?: unknown[] }).diagnostics ?? null);
      setError(preparing ? `${(failure as Error).name === "AbortError" ? "Preparation was interrupted; it may have reached the server." : (failure as Error).message} Checking saved state before retry.`
        : conflict ? "The saved proposal or selection changed. Checking the server before you try again."
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
      if (preparation.current === abort) preparation.current = null;
      if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); }
    }
  }
  async function loadSource() {
    if (locked.current || !trusted || state?.draft?.kind !== "authored") return;
    locked.current = true; const turn = ++serial.current;
    setBusy("Opening saved source and examples…"); setError("");
    try {
      const saved = await callbacks.current.request<{ source: string; cases: string[] }>(`extensions/revisions/${state.draft.id}`);
      if (mounted.current && serial.current === turn) { setSource(saved.source); setSourceLabel(state.draft.label); setCaseTexts(saved.cases.length ? saved.cases : [""]); }
    } catch { if (mounted.current && serial.current === turn) setError("Saved source is unavailable. The editor buffers and your tasks have not changed."); }
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
    if (!text.trim() || disabled) return;
    say(text.trim(), "You"); setText("");
    if (/\b(review|approve|use|yes|okay|ok|want)\b/i.test(text)) openReview();
    else say("Choose prepared advice, review a saved proposal, or open Developer qualification under Manage to enter read-only source and independent examples. AI authoring and task changes are not available here.");
  }
  const target = state?.restoreTargets.find(item => item.id === restore);
  const selectedDraft = !!state?.selection.eligible && state.selection.revision?.id === state.draft?.id;
  function view(next: "advice" | "results" | "review") { readingRevision.current++; setCanvasView(next); }
  function changeChoice() {
    setChoices(true); followConversation.current = true;
    if (matchMedia("(max-width: 1120px), (max-height: 650px)").matches) closeReview();
    say("When you check an open task, what should it say?");
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".rs-choices button")?.focus({ preventScroll: true }));
  }
  return <section className={`read-studio${reviewOpen ? " rs-review-open" : ""}`} aria-label="Advice Studio">
    <div className="sr-only" role="status">{busy || notice}</div>
    <header className="rs-header"><div><p className="rs-breadcrumb">Customizations{entry === "item" ? " / Task advice" : ""}</p><h1 id="studio-title" tabIndex={-1}>{entry === "start" ? "New customization" : "Task advice"} <span>Studio</span></h1></div>
      <button onClick={back} disabled={!!busy}>{backLabel}</button></header>
    {error && <div role="alert" className="rs-error">{error} <button onClick={() => void refresh(true)} disabled={!!busy}>Retry</button></div>}
    {preparation.current && <div className="rs-preparation">{busy} <button disabled={preparation.current.signal.aborted} onClick={() => {
      preparation.current?.abort(); setNotice("Stopping preparation. Saved state will be checked before retry.");
    }}>Stop preparation</button></div>}
    {entry === "item" && state && <div className="rs-status-summary" aria-label="Customization status">
      <div><strong>{state.selection.revision ? state.selection.eligible ? `In use · ${state.selection.revision.label}` : "Unavailable" : "Off"}</strong>
        {state.draft && !selectedDraft && <span>{state.approved ? "Approved" : "Proposed"} · {state.draft.label}</span>}</div>
      <div className="rs-summary-actions">
        {state.approved && state.draft && !selectedDraft && <button id="use-task-advice" className="rs-primary" disabled={disabled}
          onClick={() => void mutate("activate", { revisionId: state.draft!.id, draftVersion: state.draftVersion, generation: state.selection.generation }, "Your approved advice is now in use. Return to Tasks and check a saved task's advice to see it.", true)}>Use this advice for me</button>}
        <button id="studio-open-review" onClick={() => openPane("advice")}>View proposal</button>
        {state.draft && <><button disabled={disabled} onClick={changeChoice}>Change choice</button>
          <button className={!state.approved && !state.evidence?.passed ? "rs-primary" : undefined} disabled={!trusted || state.draft.kind === "authored" && !state.draft.suiteDigest} aria-disabled={disabled} onClick={() => void mutate("simulate", { revisionId: state.draft!.id, draftVersion: state.draftVersion }, "A new sample run was saved.")}>Try on sample tasks</button></>}
        {state.approvedEvidenceId && <button disabled={!!busy} onClick={() => void showEvidence(state.approvedEvidenceId!)}>Approved run</button>}
        {state.evidence && <button className={!state.approved && state.evidence.passed ? "rs-primary" : undefined} disabled={!!busy} onClick={() => void showEvidence(state.evidence!.id)}>Latest run</button>}
        <button onClick={() => { openPane("advice"); requestAnimationFrame(() => { const details = document.querySelector<HTMLDetailsElement>(".rs-tools"); if (details) { details.open = true; details.querySelector("summary")?.focus(); } }); }}>Manage</button>
      </div>
    </div>}
    <div className={`rs-room rs-show-${pane}${reviewOpen ? "" : " rs-review-closed"}`} ref={room} style={{ "--rs-chat": Math.max(limits.min, Math.min(limits.max, width)) } as CSSProperties}>
      <section className="rs-chat" aria-labelledby="studio-conversation">
        <div className="rs-chat-head"><h2 id="studio-conversation" tabIndex={-1}>Conversation</h2>
          {state && <p>{entry === "item" ? "Advice" : "Customizations"} for {state.owner.name}</p>}
          <p>{entry === "item" ? "Prepared choices across your projects. No tasks are changed." : "Choose an available starting point."}</p></div>
        <div className="rs-messages" tabIndex={0} role="log" aria-label="Studio conversation" aria-live="off" onScroll={event => {
          const log = event.currentTarget; followConversation.current = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
          if (followConversation.current) setNewMessages(false);
        }}>
          {entry === "start" ? <article className="rs-message rs-start">
            <strong>Studio</strong><h2>What would you like Daymark to do differently?</h2>
            <button onClick={() => setDiscovery(true)}>See available starting points</button>
            <button disabled aria-describedby="planned-authoring">Create from a description · To be implemented</button>
            <p id="planned-authoring">Free-form requests cannot yet be turned into a customization. For now, choose an available starting point.</p>
            {discovery && state && <section aria-label="Available starting points"><h3>Task advice</h3><p>Choose the advice you see when you check a task.</p>
              <button disabled={disabled || !state.catalog.length} onClick={() => { setEntry("item"); requestAnimationFrame(() => document.getElementById("studio-title")?.focus()); }}>{state.draft && !state.approved ? "Continue draft" : state.selection.revision || state.approved ? "Open existing setup" : "Set up"}</button>
              {!state.catalog.length && <p>Task advice is unavailable. <button disabled={!!busy} onClick={() => void refresh(true)}>Retry</button></p>}</section>}
            {discovery && !state && <p role="status">{error ? "Available starting points could not be checked. Use Retry above." : "Checking available starting points…"}</p>}
          </article> : <>{messages.map(message => <article className={`rs-message ${message.who === "You" ? "rs-yours" : ""}`} key={message.id}>
            <strong>{message.who}</strong><p>{message.text}</p>{message.evidenceId && <button disabled={!!busy} className="rs-link"
              onClick={() => void showEvidence(message.evidenceId!)}>Review {message.exampleCount} examples</button>}
          </article>)}
          {choices && <div className="rs-choices" aria-label="Prepared advice choices">{state?.catalog.map(item => <button key={item.id} disabled={disabled}
            onClick={() => void mutate("draft", { templateId: item.id, draftVersion: state.draftVersion }, `Proposed: ${item.label} for open tasks. Your In use choice has not changed.`)}>{item.label} for open tasks</button>)}</div>}</>}
          <div ref={chatEnd} />
        </div>
        {newMessages && <button className="rs-new-messages" onClick={() => { const log = chatEnd.current?.parentElement; if (log) log.scrollTop = log.scrollHeight; followConversation.current = true; setNewMessages(false); }}>New messages ↓</button>}
        <form className="rs-composer" onSubmit={submit}><label className="sr-only" htmlFor="studio-message">Message to Studio</label>
          <textarea id="studio-message" disabled={entry === "start"} aria-describedby={entry === "start" ? "planned-authoring" : undefined} maxLength={500} rows={2} value={text} onFocus={() => { readingRevision.current++; }} onChange={e => { readingRevision.current++; setText(e.target.value); }} placeholder={entry === "start" ? "Description authoring is not available yet" : "Ask to review this advice…"} />
          <button disabled={entry === "start" || disabled || !text.trim()}>Send</button></form>
        <p className="rs-chat-note">40 recent messages while Studio is open. Advice and sample results are saved.</p>
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
              <h3>{state.draft?.label ?? "Choose an open-task label"}</h3>
              <p>{state.draft ? state.draft.kind === "authored" ? state.draft.suiteDigest ? "Authored read-only program with independent saved examples. No task is edited." : "Source compiled and saved. Add independent examples in Developer qualification before running checks." : `For your tasks: open → ${state.draft.label}; completed → Done. No task is edited.` : "Choose Pending or Needs attention in the conversation to prepare advice."}</p>
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
            {review !== reviewKey && <p>This earlier review cannot approve the current proposal. Open its latest run to review the current examples.</p>}
            <label className="rs-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={disabled || !canReview || review !== reviewKey} /> I reviewed these sample results and want this advice for my tasks.</label>
            <div className="rs-actions"><button className="rs-primary" disabled={disabled || !canReview || review !== reviewKey || !confirmed || state.approvedEvidenceId === evidence?.id}
              onClick={() => void mutate("approve", { revisionId: state.draft!.id, draftVersion: state.draftVersion, evidenceId: evidence!.id }, "This exact advice is approved. It is not selected until you choose Use.")}>Approve this advice</button></div>
          </article>}
        </>}
        <details className="rs-sheet rs-tools"><summary>Details and recovery</summary>
          {state && <>
          {state.selection.revision && <p>Current choice provenance: {state.selection.revision.provenance === "operator" ? "Operator-provided starting choice" : "Your approved choice"}</p>}
          <details className="rs-developer" aria-label="Developer qualification"><summary>Developer qualification · authored source</summary>
            <p>Manual read-only Keir source for this host. This is a developer qualification tool, not AI generation. Compile first, then independently write and save expected examples. Each step creates a new revision; approval and Use are separate.</p>
            <p>Source: 64 KiB. Examples: 1–8 strict JSON documents, 128 KiB together. Saved authored revisions: 32 per person, including source-only and example-bearing copies; nothing is silently deleted.</p>
            <button disabled={disabled || state.draft?.kind !== "authored"} onClick={() => void loadSource()}>Load saved source and examples</button>
            <small>Loading replaces these editor buffers. Ordinary review navigation keeps them.</small>
            <label htmlFor="authored-label">Program label</label><input id="authored-label" value={sourceLabel} maxLength={80} disabled={disabled} onChange={e => setSourceLabel(e.target.value)} />
            <label htmlFor="authored-source">Keir source (developer)</label><textarea id="authored-source" className="rs-code" spellCheck={false} maxLength={65536} value={source} disabled={disabled} onChange={e => setSource(e.target.value)} />
            <button disabled={disabled || !source.trim() || !sourceLabel.trim()} onClick={() => void mutate("compile", { source, label: sourceLabel, draftVersion: state.draftVersion }, "Source compiled and saved as a new revision without examples. Your In use choice has not changed.")}>Compile source</button>
            {diagnostics && <pre aria-label="Compiler diagnostics">{JSON.stringify(diagnostics, null, 2)}</pre>}
            <h3>Independent expected examples</h3><p>One strict read-simulation JSON document per example. Write expectations before running; actual results are never copied into them.</p>
            {caseTexts.map((value, index) => <div key={index} className="rs-case-editor"><label htmlFor={`authored-case-${index}`}>Example {index + 1} JSON</label>
              <textarea id={`authored-case-${index}`} className="rs-code" spellCheck={false} maxLength={65536} value={value} disabled={disabled} onChange={e => setCaseTexts(old => old.map((text, at) => at === index ? e.target.value : text))} />
              {caseTexts.length > 1 && <button disabled={disabled} onClick={() => setCaseTexts(old => old.filter((_, at) => at !== index))}>Remove example {index + 1}</button>}</div>)}
            <div className="rs-actions"><button disabled={disabled || caseTexts.length >= 8} onClick={() => setCaseTexts(old => [...old, ""])}>Add example</button>
              <button disabled={disabled || state.draft?.kind !== "authored" || caseTexts.some(text => !text.trim())} onClick={() => void mutate("scenarios", { revisionId: state.draft!.id, cases: caseTexts, draftVersion: state.draftVersion }, "Independent examples saved as a new revision. Run them before reviewing or approving this proposal.")}>Save expected examples</button></div>
            {state.draft?.kind === "authored" && <p>{state.draft.suiteDigest ? "Examples saved. Try on sample tasks, then inspect the exact results." : "Saved source is waiting for independent examples."}</p>}
          </details>
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
  </section>;
}
