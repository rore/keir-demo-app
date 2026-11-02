import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import "./Studio.css";

type Revision = { id: string; templateId: string; label: string; pins: object; provenance: "operator" | "customer" };
type History = { id: number; generation: number; operation: string; revisionId: string | null };
type State = {
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
type Message = { who: "You" | "Studio"; text: string; evidenceId?: string };
type Props = {
  request: <T>(path: string, method?: string, body?: object) => Promise<T>;
  changed: (generation: number) => void;
  beforeSelectionChange: () => void;
  back: () => void;
};
const advice = (code?: string) => ({ PENDING: "Pending", NEEDS_ATTENTION: "Needs attention", DONE: "Done" })[code ?? ""] ?? code;
const outcome = (value?: Outcome) => !value ? "No completed result" :
  `${value.classification.replaceAll("_", " ").toLowerCase()}${value.code ? ` · ${advice(value.code)}` : ""}`;

export default function Studio({ request, changed, beforeSelectionChange, back }: Props) {
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
  const [history, setHistory] = useState<History[]>([]);
  const [historyNext, setHistoryNext] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([{ who: "Studio", text:
    "How should an open task appear when you check its advice? Choose Pending or Needs attention below. Completed tasks will say Done. These are prepared choices; this Studio does not generate new rules or change your tasks." }]);
  const room = useRef<HTMLDivElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
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
    setMessages(old => [...old, { who, text, evidenceId }].slice(-40));
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
    setConfirmed(false);
    say("Review the exact proposal and its sample results on the canvas. Only the separate Approve button records your approval; Use is a further decision.");
  }
  async function refresh() {
    if (locked.current) return;
    locked.current = true;
    const turn = ++serial.current;
    setBusy("Checking saved advice…"); setError("");
    try {
      const next = await callbacks.current.request<State>("extensions");
      if (mounted.current && serial.current === turn) { apply(next); setNotice("Showing saved server state."); }
    } catch {
      if (mounted.current && serial.current === turn) { setTrusted(false); setError("Saved advice could not be checked. Reload saved state before making another change."); }
    } finally {
      if (mounted.current && serial.current === turn) { locked.current = false; setBusy(""); }
    }
  }
  useEffect(() => {
    mounted.current = true;
    document.getElementById("studio-conversation")?.focus();
    void refresh();
    return () => { mounted.current = false; ++serial.current; locked.current = false; };
  }, []);
  useEffect(() => {
    const log = chatEnd.current?.parentElement;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages.length]);
  useEffect(() => { if (review) document.getElementById("studio-review")?.focus(); }, [review]);

  async function mutate(operation: string, body: object, message: string, selection = false) {
    if (locked.current || !trusted) return;
    locked.current = true;
    const turn = ++serial.current;
    setBusy(operation === "simulate" ? "Trying the sample tasks…" : "Saving your choice…");
    setError(""); setNotice(""); setReview(""); setConfirmed(false);
    try {
      if (selection) callbacks.current.beforeSelectionChange();
      const next = await callbacks.current.request<State>(`extensions/${operation}`, "POST", body);
      if (!mounted.current || serial.current !== turn) return;
      apply(next); say(message); setNotice(message);
      if (operation === "simulate" && next.evidence) {
        const proof = await callbacks.current.request<Evidence>(`extensions/evidence/${encodeURIComponent(next.evidence.id)}`);
        if (mounted.current && serial.current === turn) {
          setEvidence(proof);
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
      if (mounted.current && serial.current === turn) setEvidence(proof);
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
  return <section className="read-studio" aria-label="Advice Studio">
    <header className="rs-header"><div><span className="rs-wordmark">keir.</span><span>Advice Studio</span></div>
      <button onClick={back} disabled={!!busy}>Back to my task</button></header>
    <div className="rs-room" ref={room} style={{ "--rs-chat": `${width}%` } as CSSProperties}>
      <section className="rs-chat" aria-labelledby="studio-conversation">
        <div className="rs-chat-head"><h1 id="studio-conversation" tabIndex={-1}>A little help with task advice.</h1>
          {state && <p>Advice for {state.owner.name}</p>}
          <p>Prepared choices for your own tasks. Manual guidance, no AI authoring.</p><a href="#studio-canvas" className="rs-mobile-link">See advice and examples ↓</a></div>
        <div className="rs-messages" role="log" aria-label="Studio conversation" aria-live="polite">
          {messages.map((message, i) => <article className={`rs-message ${message.who === "You" ? "rs-yours" : ""}`} key={i}>
            <strong>{message.who}</strong><p>{message.text}</p>{message.evidenceId && <button disabled={!!busy} className="rs-link"
              onClick={() => void showEvidence(message.evidenceId!)}>Reopen these sample results</button>}
          </article>)}<div ref={chatEnd} />
        </div>
        <div className="rs-choices" aria-label="Prepared advice choices">{state?.catalog.map(item => <button key={item.id} disabled={disabled}
          onClick={() => void mutate("draft", { templateId: item.id, draftVersion: state.draftVersion }, `Proposed: ${item.label} for open tasks. Your In use choice has not changed.`)}>
          {item.label} for open tasks</button>)}</div>
        <form className="rs-composer" onSubmit={submit}><label className="sr-only" htmlFor="studio-message">Message to Studio</label>
          <textarea id="studio-message" maxLength={500} rows={2} value={text} onChange={e => setText(e.target.value)} placeholder="Ask to review this advice…" />
          <button disabled={disabled || !text.trim()}>Send</button></form>
        <p className="rs-chat-note">Messages last while this Studio is open. Saved advice and sample results are held by the server.</p>
      </section>
      <div className="rs-divider" role="separator" tabIndex={0} aria-label="Resize conversation and advice" aria-orientation="vertical"
        aria-valuemin={30} aria-valuemax={70} aria-valuenow={width}
        onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault(); setWidth(old => event.key === "Home" ? 30 : event.key === "End" ? 70 : Math.max(30, Math.min(70, old + (event.key === "ArrowLeft" ? -2 : 2))));
        } }}
        onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && room.current) {
          const bounds = room.current.getBoundingClientRect(); setWidth(Math.round(Math.max(30, Math.min(70, (event.clientX - bounds.left) / bounds.width * 100))));
        } }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />
      <section id="studio-canvas" tabIndex={-1} className="rs-canvas" aria-label="Advice and sample results">
        <div className="rs-canvas-heading"><h2>Your task advice</h2><button onClick={() => void refresh()} disabled={!!busy}>Reload saved state</button></div>
        <a href="#studio-conversation" className="rs-mobile-link">Back to conversation ↑</a>
        {busy && <p role="status" className="rs-callout">{busy}</p>}
        {error && <p role="alert" className="rs-error">{error}</p>}
        {notice && <p role="status" className="rs-callout">{notice}</p>}
        {state && <>
          <div className="rs-comparison">
            <article className="rs-sheet" aria-label={state.selection.revision && !state.selection.eligible ? "Unavailable advice" : "In use advice"}>
              <span className="rs-kicker">{state.selection.revision && !state.selection.eligible ? "Unavailable selection" : "In use"}</span>
              <h3>{state.selection.revision ? state.selection.eligible ? state.selection.revision.label : "Advice is unavailable" : "Advice is off"}</h3>
              <p>{state.selection.revision ? state.selection.eligible ? `Open tasks: ${state.selection.revision.label}. Completed tasks: Done.`
                : `Your saved ${state.selection.revision.label} choice could not be validated. Task advice is not displayed. Your tasks still work as usual.`
                : "Task advice is not selected. Your tasks still work as usual."}</p>
              {state.selection.revision && <small>{state.selection.revision.provenance === "operator" ? "Operator-provided starting choice" : "Your approved choice"}</small>}
              <button disabled={disabled || !state.selection.revision} onClick={() => void mutate("disable", { generation: state.selection.generation }, "Your advice is off. Your tasks have not changed.", true)}>Turn off my advice</button>
            </article>
            <article className="rs-sheet rs-proposed" aria-label="Proposed advice"><span className="rs-kicker">Proposed</span>
              <h3>{state.draft?.label ?? "Choose an open-task label"}</h3>
              <p>{state.draft ? `For your tasks: open → ${state.draft.label}; completed → Done. No task is edited.` : "Choose Pending or Needs attention in the conversation to prepare advice."}</p>
              {state.draft && <><p>{state.approved ? "Approved. Use is a separate decision." : "This proposal is not approved."}</p>
                <div className="rs-actions"><button disabled={disabled} onClick={() => void mutate("simulate", { revisionId: state.draft!.id, draftVersion: state.draftVersion }, "A new sample run was saved.")}>Try on sample tasks</button>
                  {state.evidence && <button disabled={!!busy} onClick={() => void showEvidence(state.evidence!.id)}>Open current sample results</button>}
                  <button disabled={disabled || !canReview} onClick={openReview}>Review this advice</button></div></>}
            </article>
          </div>
          {!!state.evidenceHistory.length && <details className="rs-sheet"><summary>Saved sample runs</summary>
            <p>Open a server-held run to inspect its original results. Earlier runs do not approve a new proposal.</p>
            <ol>{state.evidenceHistory.map((item, index) => <li key={item.id}>
              <button disabled={!!busy} onClick={() => void showEvidence(item.id)}>Open saved sample run {index + 1}</button>
              <small>{item.id === state.evidence?.id ? "Current proposal" : "Earlier run"} · revision {item.revisionId}</small>
            </li>)}</ol>
          </details>}
          {evidence && <article className="rs-sheet rs-results" aria-label="Sample results">
            <span className="rs-kicker">Saved sample run · {currentEvidence ? "Current proposal" : "Earlier proposal"}</span>
            <h3>{evidence.passed ? "Sample run passed" : "Sample run did not pass"}</h3>
            <p>These are synthetic sample tasks, not live task changes. Expected results were defined independently of this run.</p>
            <div className="rs-table-wrap"><table><caption>Expected and actual sample results</caption><thead><tr><th>Sample task</th><th>Expected</th><th>Actual</th></tr></thead>
              <tbody>{evidence.reports.map(item => <tr key={item.id}><th scope="row">{item.label}</th><td>{outcome(item.expected)}</td>
                <td><strong>{item.report.status === "PASS" ? "Matches" : item.report.status.replaceAll("_", " ")}</strong><br />{outcome(item.report.native)}
                  {item.report.consumption && <small>{item.report.consumption.status === "DISPLAYED" ? `Shown: ${advice(item.report.consumption.code)}` : "Advice not displayed"}</small>}
                  {!!item.report.mismatches?.length && <details><summary>Mismatch details</summary><pre>{JSON.stringify(item.report.mismatches, null, 2)}</pre></details>}</td></tr>)}</tbody></table></div>
            <details><summary>Saved run identity</summary><p>Evidence: {evidence.id}</p><p>Revision: {evidence.revisionId}</p><pre>{JSON.stringify(evidence.identity, null, 2)}</pre></details>
          </article>}
          {review && review === reviewKey && canReview && <article id="studio-review" tabIndex={-1} className="rs-sheet rs-review" aria-label="Review exact advice">
            <span className="rs-kicker">For {state.owner.name} only</span><h3>Review: {state.draft!.label} for open tasks</h3>
            <p>Completed tasks show Done. Missing, denied or unavailable reads show no advice. The sample run checks these situations; it does not certify every live task or change any task.</p>
            <details><summary>Exact proposal and reviewed evidence</summary><p>Revision: {state.draft!.id}</p><p>Evidence: {state.evidence!.id}</p></details>
            <label className="rs-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={disabled} /> I reviewed these sample results and want this advice for my tasks.</label>
            <div className="rs-actions"><button className="rs-primary" disabled={disabled || !confirmed || state.approved}
              onClick={() => void mutate("approve", { revisionId: state.draft!.id, draftVersion: state.draftVersion, evidenceId: evidence!.id }, "This exact advice is approved. It is not selected until you choose Use.")}>Approve this advice</button></div>
          </article>}
          {state.approved && state.draft && <article className="rs-sheet" aria-label="Approved advice"><h3>Approved: {state.draft.label}</h3>
            <p>Your In use choice changes only when you choose this advice below.</p><button className="rs-primary" disabled={disabled}
              onClick={() => void mutate("activate", { revisionId: state.draft!.id, draftVersion: state.draftVersion, generation: state.selection.generation }, "Your approved advice is now in use. Return to your task and check advice to see it.", true)}>Use this advice for me</button></article>}
          <article className="rs-sheet" aria-label="Restore earlier advice"><h3>Return to an earlier choice</h3>
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
          </article>
        </>}
        <details className="rs-lookup"><summary>Open a saved sample run by ID</summary><form onSubmit={event => { event.preventDefault(); void showEvidence(lookup); }}>
          <label htmlFor="studio-evidence">Evidence ID for this person</label><input id="studio-evidence" maxLength={160} value={lookup} onChange={e => setLookup(e.target.value)} />
          <button disabled={!!busy || !lookup.trim()}>Open saved sample run</button></form></details>
      </section>
    </div>
  </section>;
}
