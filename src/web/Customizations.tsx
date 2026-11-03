import { useEffect, useRef, useState } from "react";
import type { Collection, StudioTarget } from "./Studio";
import { pendingGuidedRequests, pendingRequests } from "./Studio";

export default function Customizations({ request, changed, open, focusAction = "", notice = "" }: {
  request: <T>(path: string) => Promise<T>;
  changed: (generation: number) => void;
  open: (target?: StudioTarget) => void;
  focusAction?: string;
  notice?: string;
}) {
  const [state, setState] = useState<Collection | null>(null);
  const [legacy, setLegacy] = useState<{ id: string; extensionId: string | null }[]>([]);
  const [error, setError] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [recoveries, setRecoveries] = useState<ReturnType<typeof pendingRequests>>([]);
  const [guidedRecoveries, setGuidedRecoveries] = useState<ReturnType<typeof pendingGuidedRequests>>([]);
  const [retry, setRetry] = useState(0);
  const callbacks = useRef({ request, changed });
  callbacks.current = { request, changed };
  useEffect(() => {
    let current = true;
    setError(false); setHistoryError(false);
    document.getElementById("customizations-heading")?.focus();
    callbacks.current.request<Collection>("extensions").then(next => {
      if (!current) return;
      callbacks.current.changed(next.selection.generation);
      setState(next);
      setRecoveries(pendingRequests(next.owner.id).filter(item => item.turn.target.kind === "create"
        || next.items.some(saved => saved.extension?.id === (item.turn.target.kind === "create" ? null : item.turn.target.extensionId))));
      setGuidedRecoveries(pendingGuidedRequests(next.owner.id));
    }).catch(() => { if (current) setError(true); });
    callbacks.current.request<{ conversations: { id: string; extensionId: string | null }[] }>("authoring").then(next => {
      if (current) setLegacy(next.conversations.filter(item => item.extensionId === null));
    }).catch(() => { if (current) setHistoryError(true); });
    return () => { current = false; };
  }, [retry]);
  useEffect(() => { if (state && focusAction) document.getElementById(focusAction)?.focus({ preventScroll: true }); }, [state, focusAction]);
  return <main className="customizations-main" aria-labelledby="customizations-heading">
    <h1 id="customizations-heading" tabIndex={-1}>Customizations</h1>
    <p className="page-intro">Make Daymark work your way. Start a change or return to a saved customization.</p>
    {notice && <p role="status">{notice}</p>}
    <button id="new-customization" className="primary customization-start" onClick={() => open()}>New customization</button>
    {error ? <div className="error" role="alert">Customizations could not be checked. <button onClick={() => setRetry(old => old + 1)}>Try again</button></div>
      : !state ? <p role="status">Loading your customizations…</p> : !state.items.length ? <p className="customization-empty">Your customizations will appear here.</p> : state.items.map(item => {
        const selected = item.selection.revision;
        const selectedItem = selected?.extensionId === item.extension!.id;
        const inUse = selectedItem && item.selection.eligible;
        const changes = !!item.draft && (!selectedItem || item.draft.id !== selected?.id);
        const status = selectedItem ? inUse ? changes ? "In use · Changes in progress" : "In use" : "Couldn’t check what’s in use"
          : item.approved ? "Approved · Ready to turn on" : item.draft ? "Draft" : item.extension!.hookId ? "Off" : "In discussion";
        return <article key={item.extension!.id} className="customization-card" aria-label={item.extension!.name}>
          <div className="customization-icon" aria-hidden="true">✓</div>
          <div className="customization-copy"><h2>{item.extension!.name}</h2>
            <p className="customization-status"><span className={`state-badge ${inUse ? "in-use" : ""}`}>{status}</span></p>
            {selectedItem && <p>{inUse ? "In use" : "Saved choice"}: {selected!.label}</p>}
            {changes && <p className="draft-status">Saved changes (version {item.draftVersion}): {item.draft!.label}{item.approved ? " · Approved" : ""}</p>}
            {!item.extension!.hookId && <p>Describe the goal and check what Daymark can support.</p>}
          </div>
          <button id={`edit-${item.extension!.id}`} className="primary" onClick={() => open({ extensionId: item.extension!.id })}>{changes ? "Continue changes" : "Edit"}<span aria-hidden="true"> →</span></button>
        </article>;
      })}
    {(!!recoveries.length || !!guidedRecoveries.length) && <section aria-label="Submitted requests"><h2>Submitted requests</h2><p>Check what was saved before deciding whether to retry.</p>
      {recoveries.map((item, index) => <p key={item.entryId}><button onClick={() => open({ extensionId: item.turn.target.kind === "create" ? null : item.turn.target.extensionId,
        conversationId: item.turn.conversationId, recoveryId: item.entryId })}>Check submitted request {index + 1}</button></p>)}
      {guidedRecoveries.map((item, index) => <p key={item.entryId}><button onClick={() => open({ extensionId: null, recoveryId: item.entryId })}>Check submitted example {index + 1}</button></p>)}
    </section>}
    {!!legacy.length && <details><summary>Earlier conversations</summary><p>These discussions have no confirmed customization link and can be read without changing saved work.</p>
      {legacy.map((item, index) => <p key={item.id}><button onClick={() => open({ extensionId: null, conversationId: item.id })}>Read earlier conversation {index + 1}</button></p>)}
    </details>}
    {historyError && <p role="status">Earlier conversations could not be checked. <button onClick={() => setRetry(old => old + 1)}>Try again</button></p>}
    <p className="customization-note">Describe your customization in Studio. Review its sample results, approve the exact proposal, then choose whether to use it. No task is changed by authoring.</p>
  </main>;
}
