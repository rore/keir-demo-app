import { useEffect, useRef, useState } from "react";
import type { State } from "./Studio";

export default function Customizations({ request, changed, open, focusAction = "" }: {
  request: <T>(path: string) => Promise<T>;
  changed: (generation: number) => void;
  open: (start?: boolean) => void;
  focusAction?: string;
}) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const callbacks = useRef({ request, changed });
  callbacks.current = { request, changed };
  useEffect(() => {
    let current = true;
    setError(false);
    document.getElementById("customizations-heading")?.focus();
    callbacks.current.request<State>("extensions").then(next => {
      if (!current) return;
      callbacks.current.changed(next.selection.generation);
      setState(next);
    }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [retry]);
  useEffect(() => { if (state && focusAction) document.getElementById(focusAction)?.focus({ preventScroll: true }); }, [state, focusAction]);
  const selected = state?.selection.revision;
  const inUse = !!selected && !!state?.selection.eligible;
  const selectedDraft = inUse && selected.id === state?.draft?.id;
  const known = state && (selected || state.draft || state.selection.generation > 0 || state.history.length || state.evidenceHistory.length);
  return <main className="customizations-main" aria-labelledby="customizations-heading">
    <h1 id="customizations-heading" tabIndex={-1}>Customizations</h1>
    <p className="page-intro">Make Daymark work your way. Start a change or return to a saved customization.</p>
    <button id="new-customization" className="primary customization-start" onClick={() => open(true)}>New customization</button>
    {error ? <div className="error" role="alert">Customizations could not be checked. <button onClick={() => setRetry(old => old + 1)}>Retry</button></div>
      : !state ? <p role="status">Checking your customizations…</p> : !known ? <p className="customization-empty">You have no saved customizations. Start a conversation to describe what you want.</p> : <article className="customization-card" aria-label="Task advice customization">
        <div className="customization-icon" aria-hidden="true">✓</div>
        <div className="customization-copy"><h2>Task advice</h2><p>Choose what you see when you check an open task.</p>
          <p className="customization-status"><span className={`state-badge ${inUse ? "in-use" : ""}`}>{selected ? inUse ? "In use" : "Unavailable" : "Off"}</span>
            {inUse ? selected.kind === "authored" ? `${selected.label} · reviewed authored examples` : `Open tasks: ${selected.label} · completed tasks: Done` : selected ? "Your saved choice cannot be validated. Tasks still work as usual." : "No advice is selected. Tasks still work as usual."}</p>
          {state.draft && <p className="draft-status">{selectedDraft ? "Current choice" : state.approved ? "Approved · awaiting use" : "Draft"}: {state.draft.label}</p>}
          <small>Read-only advice for {state.owner.name}. Saved choices and sample results remain available.</small>
        </div>
        <button id="edit-task-advice" className="primary" onClick={() => open()}>{state.draft && !state.approved ? "Continue draft" : "Open"}<span aria-hidden="true"> →</span></button>
      </article>}
    <p className="customization-note">Describe your customization in Studio. Review its sample results, approve the exact proposal, then choose whether to use it. No task is changed by authoring.</p>
  </main>;
}
