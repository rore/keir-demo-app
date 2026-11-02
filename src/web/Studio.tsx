import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import "./Studio.css";

type Revision = { id: string; templateId: string; label: string; pins: object; provenance: "operator" | "customer" };
type History = { id: number; generation: number; operation: string; revisionId: string | null };
export type State = {
  owner: { id: string; name: string };
  catalog: { id: string; label: string; openCode: string }[];
  draftVersion: number;
  draft: Revision | null;
  evidence: { id: string; revisionId: string; passed: boolean } | null;
  approved: boolean;
  selection: { generation: number; revision: Revision | null; eligible: boolean };
  restoreTargets: Revision[];
  history: History[];
  evidenceHistory: { id: string; revisionId: string }[];
};
type Outcome = { classification: string; code?: string };
type Evidence = { id: string; revisionId: string; identity: object; passed: boolean; reports: {
  id: string; label: string; expected: Outcome;
  report: { status: string; native?: Outcome; consumption?: { status: string; code?: string }; mismatches: object[] };
}[] };
type Message = { id: number; who: "You" | "Studio"; text: string; evidenceId?: string };
type Props = {
  request: <T>(path: string, method?: string, body?: object) => Promise<T>;
  changed: (generation: number) => void;
  beforeSelectionChange: () => void;
  back: () => void;
  backLabel: string;
};
const advice = (code?: string) => ({ PENDING: "Pending", NEEDS_ATTENTION: "Needs attention", DONE: "Done" })[code ?? ""] ?? code;
const expectedAdvice = (value: Outcome) => value.classification === "COMPLETED" ? advice(value.code) : "No advice";

export default function Studio({ request, changed, beforeSelectionChange, back, backLabel }: Props) {
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
  const [width, setWidth] = useState(52);
  const [pane, setPane] = useState<"conversation" | "preview">("conversation");
  const [canvasView, setCanvasView] = useState<"advice" | "results" | "review">("advice");
  const [newMessages, setNewMessages] = useState(false);
  const [history, setHistory] = useState<History[]>([]);
  const [historyNext, setHistoryNext] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([{ id: 0, who: "Studio", text:
    "How should an open task appear when you check its advice? Choose a prepared reply below." }]);
  const room = useRef<HTMLDivElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const followConversation = useRef(true);
  const readingRevision = useRef(0);
  const messageId = useRef(0);
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

  function say(text: string, who: Message["who"] = "Studio", evidenceId?: string) {
    const id = ++messageId.current;
    setMessages(old => [...old, { id, who, text, evidenceId }].slice(-40));
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
    setCanvasView("review"); setPane("preview");
    setConfirmed(false);
    say("Review the exact proposal and its sample results on the canvas. Only the separate Approve button records your approval; Use is a further decision.");
  }
  async function refresh(announce = false) {
    if (locked.current) return;
    locked.current = true;
    const turn = ++serial.current;
    setBusy("Checking saved advice…"); setError("");
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
    return () => { mounted.current = false; ++serial.current; locked.current = false; };
  }, []);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const available = (room.current?.clientWidth ?? 900) - 14;
      const min = Math.max(30, Math.ceil(300 / available * 100));
      const max = Math.min(70, Math.floor((available - 340) / available * 100));
      if (min <= max) { setLimits({ min, max }); setWidth(old => Math.max(min, Math.min(max, old))); }
    });
    if (room.current) observer.observe(room.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const log = chatEnd.current?.parentElement;
    if (log && followConversation.current) log.scrollTop = log.scrollHeight;
    else setNewMessages(true);
  }, [messages]);
  useEffect(() => { if (review) document.getElementById("studio-review")?.focus(); }, [review]);
  useEffect(() => {
    if (!busy && focusUse.current) { focusUse.current = false; document.getElementById("use-task-advice")?.focus(); }
  }, [busy]);

  async function mutate(operation: string, body: object, message: string, selection = false) {
    if (locked.current || !trusted) return;
    locked.current = true;
    const turn = ++serial.current;
    const reading = readingRevision.current;
    setBusy(operation === "simulate" ? "Trying the sample tasks…" : "Saving your choice…");
    setError(""); setNotice(""); setReview(""); setConfirmed(false);
    try {
      if (selection) callbacks.current.beforeSelectionChange();
      const next = await callbacks.current.request<State>(`extensions/${operation}`, "POST", body);
      if (!mounted.current || serial.current !== turn) return;
      const followReading = readingRevision.current === reading;
      if (operation === "approve" && followReading) focusUse.current = true;
      apply(next); say(message); setNotice(message);
      if (operation !== "simulate" && followReading) setCanvasView("advice");
      if (operation === "simulate" && next.evidence) {
        const proof = await callbacks.current.request<Evidence>(`extensions/evidence/${encodeURIComponent(next.evidence.id)}`);
        if (mounted.current && serial.current === turn) {
          if (readingRevision.current === reading) { setEvidence(proof); setCanvasView("results"); }
          say(proof.passed ? "The sample run passed. Compare what was expected with what happened before reviewing this advice."
            : "This sample run did not pass. It cannot be approved or put in use.", "Studio", proof.id);
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
  async function showEvidence(id: string) {
    if (locked.current || !id.trim()) return;
    locked.current = true;
    const turn = ++serial.current;
    setBusy("Opening saved sample results…"); setError(""); setReview(""); setConfirmed(false);
    try {
      const proof = await callbacks.current.request<Evidence>(`extensions/evidence/${encodeURIComponent(id.trim())}`);
      if (mounted.current && serial.current === turn) { setEvidence(proof); setCanvasView("results"); setPane("preview"); }
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
    else say("This manual Studio supports the two prepared advice choices below. Choose one, try it on sample tasks, or open saved results. New rules, task changes and AI authoring are not available here.");
  }
  const target = state?.restoreTargets.find(item => item.id === restore);
  const selectedDraft = !!state?.selection.eligible && state.selection.revision?.id === state.draft?.id;
  function view(next: "advice" | "results" | "review") { readingRevision.current++; setCanvasView(next); }
  function showPane(next: "conversation" | "preview") { setPane(next); requestAnimationFrame(() => document.getElementById(next === "conversation" ? "studio-conversation" : "studio-canvas")?.focus({ preventScroll: true })); }
  return <section className="read-studio" aria-label="Advice Studio">
    <div className="sr-only" role="status">{busy || notice}</div>
    <header className="rs-header"><div><p className="rs-breadcrumb">Customizations / Task advice</p><h1 id="studio-title" tabIndex={-1}>Task advice <span>Studio</span></h1></div>
      <button onClick={back} disabled={!!busy}>{backLabel}</button></header>
    {error && <div role="alert" className="rs-error">{error} <button onClick={() => void refresh(true)} disabled={!!busy}>Retry</button></div>}
    <div className="rs-pane-tabs" aria-label="Studio views"><button aria-pressed={pane === "conversation"} onClick={() => showPane("conversation")}>Conversation</button><button aria-pressed={pane === "preview"} onClick={() => showPane("preview")}>Preview</button></div>
    <div className={`rs-room rs-show-${pane}`} ref={room} style={{ "--rs-chat": width } as CSSProperties}>
      <section className="rs-chat" aria-labelledby="studio-conversation">
        <div className="rs-chat-head"><h2 id="studio-conversation" tabIndex={-1}>Conversation</h2>
          {state && <p>Advice for {state.owner.name}</p>}
          <p>Prepared choices across your projects. No tasks are changed.</p></div>
        <div className="rs-messages" tabIndex={0} role="log" aria-label="Studio conversation" aria-live="off" onScroll={event => {
          const log = event.currentTarget; followConversation.current = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
          if (followConversation.current) setNewMessages(false);
        }}>
          {messages.map(message => <article className={`rs-message ${message.who === "You" ? "rs-yours" : ""}`} key={message.id}>
            <strong>{message.who}</strong><p>{message.text}</p>{message.evidenceId && <button disabled={!!busy} className="rs-link"
              onClick={() => void showEvidence(message.evidenceId!)}>Reopen these sample results</button>}
          </article>)}<div ref={chatEnd} />
        </div>
        {newMessages && <button className="rs-new-messages" onClick={() => { const log = chatEnd.current?.parentElement; if (log) log.scrollTop = log.scrollHeight; followConversation.current = true; setNewMessages(false); }}>New messages ↓</button>}
        <div className="rs-choices" aria-label="Prepared advice choices">{state?.catalog.map(item => <button key={item.id} disabled={disabled}
          onClick={() => void mutate("draft", { templateId: item.id, draftVersion: state.draftVersion }, `Proposed: ${item.label} for open tasks. Your In use choice has not changed.`)}>
          {item.label} for open tasks</button>)}</div>
        <form className="rs-composer" onSubmit={submit}><label className="sr-only" htmlFor="studio-message">Message to Studio</label>
          <textarea id="studio-message" maxLength={500} rows={2} value={text} onChange={e => setText(e.target.value)} placeholder="Ask to review this advice…" />
          <button disabled={disabled || !text.trim()}>Send</button></form>
        <p className="rs-chat-note">40 recent messages while Studio is open. Advice and sample results are saved.</p>
      </section>
      <div className="rs-divider" role="separator" tabIndex={0} aria-label="Resize conversation and advice" aria-orientation="vertical"
        aria-valuemin={limits.min} aria-valuemax={limits.max} aria-valuenow={width}
        onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault(); setWidth(old => event.key === "Home" ? limits.min : event.key === "End" ? limits.max : Math.max(limits.min, Math.min(limits.max, old + (event.key === "ArrowLeft" ? -2 : 2))));
        } }}
        onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && room.current) {
          const bounds = room.current.getBoundingClientRect(); setWidth(Math.round(Math.max(limits.min, Math.min(limits.max, (event.clientX - bounds.left) / (bounds.width - 14) * 100))));
        } }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />
      <section className="rs-preview" aria-label="Advice preview">
        <nav className="rs-canvas-tabs" aria-label="Advice views"><button aria-pressed={canvasView === "advice"} onClick={() => view("advice")}>Advice</button><button aria-pressed={canvasView === "results"} disabled={!evidence} onClick={() => view("results")}>Sample results</button>
          {review && review === reviewKey && canReview && <button aria-pressed={canvasView === "review"} onClick={() => view("review")}>Review</button>}</nav>
      <section id="studio-canvas" tabIndex={0} className="rs-canvas" aria-label="Advice and sample results" onScroll={() => { readingRevision.current++; }}>
        {busy && <p className="rs-callout">{busy}</p>}
        {notice && <p className="rs-callout">{notice}</p>}
        {state && <>
          {state.approved && state.draft && !selectedDraft && <article className="rs-sheet rs-approved" aria-label="Approved advice"><div><h3>Approved: {state.draft.label}</h3>
            <p>Ready for your decision to use it.</p></div><button id="use-task-advice" className="rs-primary" disabled={disabled}
              onClick={() => void mutate("activate", { revisionId: state.draft!.id, draftVersion: state.draftVersion, generation: state.selection.generation }, "Your approved advice is now in use. Return to Tasks and check a saved task's advice to see it.", true)}>Use this advice for me</button></article>}
          <div className="rs-comparison rs-sheet" hidden={canvasView !== "advice"}>
            <article aria-label="Current advice">
              <span className="rs-kicker">Current advice</span><span className="state-badge">{state.selection.revision ? state.selection.eligible ? "In use" : "Unavailable" : "Off"}</span>
              <h3>{state.selection.revision ? state.selection.eligible ? state.selection.revision.label : "Advice is unavailable" : "Advice is off"}</h3>
              <p>{state.selection.revision ? state.selection.eligible ? `Open tasks: ${state.selection.revision.label}. Completed tasks: Done.`
                : `Your saved ${state.selection.revision.label} choice could not be validated. Task advice is not displayed. Your tasks still work as usual.`
                : "Task advice is not selected. Your tasks still work as usual."}</p>
            </article>
            <article hidden={selectedDraft} className="rs-proposed" aria-label="Proposed advice"><span className="rs-kicker">Proposed</span>
              <h3>{state.draft?.label ?? "Choose an open-task label"}</h3>
              <p>{state.draft ? `For your tasks: open → ${state.draft.label}; completed → Done. No task is edited.` : "Choose Pending or Needs attention in the conversation to prepare advice."}</p>
              {state.draft && <><p>{selectedDraft ? "This approved choice is in use." : state.approved ? "Approved. Use is a separate decision." : "This proposal is not approved."}</p>
                <div className="rs-actions"><button className={!state.evidence?.passed ? "rs-primary" : undefined} disabled={disabled} onClick={() => void mutate("simulate", { revisionId: state.draft!.id, draftVersion: state.draftVersion }, "A new sample run was saved.")}>Try on sample tasks</button>
                  {state.evidence && <button className={!currentEvidence && !state.approved ? "rs-primary" : undefined} disabled={!!busy} onClick={() => void showEvidence(state.evidence!.id)}>Open current sample results</button>}
                  {state.evidence && <button className={canReview && !state.approved ? "rs-primary" : undefined} disabled={disabled || !canReview} onClick={openReview}>Review this advice</button>}</div></>}
            </article>
          </div>
          {evidence && <article hidden={canvasView !== "results"} className="rs-sheet rs-results" aria-label="Sample results">
            <span className="rs-kicker">Saved sample run · {currentEvidence ? "Current proposal" : "Earlier proposal"}</span>
            <h3>{evidence.passed ? "Sample run passed" : "Sample run did not pass"}</h3>
            <p>These are synthetic sample tasks, not live task changes. Expected results were defined independently of this run.</p>
            <div className="rs-table-wrap"><table><caption>Expected and actual sample results</caption><thead><tr><th>Sample task</th><th>Expected</th><th>Actual</th></tr></thead>
              <tbody>{evidence.reports.map(item => <tr key={item.id}><th scope="row">{item.label}</th><td>{expectedAdvice(item.expected)}</td>
                <td><strong>{item.report.status === "PASS" ? "Matches" : "Check needs review"}</strong><br />
                  {item.report.consumption?.status === "DISPLAYED" ? advice(item.report.consumption.code) : "No advice"}
                  <details><summary>Technical run details</summary><pre>{JSON.stringify({ expected: item.expected, actual: item.report }, null, 2)}</pre></details></td></tr>)}</tbody></table></div>
            <details><summary>Saved run identity</summary><p>Evidence: {evidence.id}</p><p>Revision: {evidence.revisionId}</p><pre>{JSON.stringify(evidence.identity, null, 2)}</pre></details>
            <div className="rs-actions"><button className={canReview && !state.approved ? "rs-primary" : undefined} disabled={disabled || !canReview} onClick={openReview}>Review this advice</button><button onClick={() => view("advice")}>Back to advice</button></div>
          </article>}
          {review && review === reviewKey && canReview && <article hidden={canvasView !== "review"} id="studio-review" tabIndex={-1} className="rs-sheet rs-review" aria-label="Review exact advice">
            <span className="rs-kicker">For {state.owner.name} only</span><h3>Review: {state.draft!.label} for open tasks</h3>
            <p>Completed tasks show Done. Missing, denied or unavailable reads show no advice. The sample run checks these situations; it does not certify every live task or change any task.</p>
            <details><summary>Exact proposal and reviewed evidence</summary><p>Revision: {state.draft!.id}</p><p>Evidence: {state.evidence!.id}</p></details>
            <label className="rs-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={disabled} /> I reviewed these sample results and want this advice for my tasks.</label>
            <div className="rs-actions"><button className="rs-primary" disabled={disabled || !confirmed || state.approved}
              onClick={() => void mutate("approve", { revisionId: state.draft!.id, draftVersion: state.draftVersion, evidenceId: evidence!.id }, "This exact advice is approved. It is not selected until you choose Use.")}>Approve this advice</button></div>
          </article>}
        </>}
        <details className="rs-sheet rs-tools"><summary>Details and recovery</summary>
          {state && <>
          {state.selection.revision && <p>Current choice provenance: {state.selection.revision.provenance === "operator" ? "Operator-provided starting choice" : "Your approved choice"}</p>}
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
            {target && <div className="rs-restore-confirm"><p>Restore <strong>{target.label}</strong> for your open tasks; completed tasks show Done. {target.provenance === "operator" ? "This was an operator-provided starting choice." : "This choice was approved for you."} No task or earlier action is undone.</p>
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
