import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Collection, State, StudioTarget } from "./Studio";
import { pendingRequests, taskTriggerGroup } from "./Studio";

export default function Customizations({ request, changed, beforeSelectionChange, open, focusAction = "", notice = "" }: {
  request: <T>(path: string, method?: string, body?: object) => Promise<T>;
  changed: (generation: number) => void;
  beforeSelectionChange: () => void;
  open: (target?: StudioTarget) => void;
  focusAction?: string;
  notice?: string;
}) {
  const [state, setState] = useState<Collection | null>(null);
  const [loadingMore, setLoadingMore] = useState("");
  const [loadedItems, setLoadedItems] = useState(false);
  const [moreError, setMoreError] = useState("");
  const lifetime = useRef(0), paging = useRef(false);
  const [error, setError] = useState(false);
  const [recoveries, setRecoveries] = useState<ReturnType<typeof pendingRequests>>([]);
  const [retry, setRetry] = useState(0);
  const [deletion, setDeletion] = useState<{ id: string; name: string; draftVersion: number; generation: number; selected: boolean; message: string; blocked: boolean; uncertain: boolean } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState("");
  const deletingRef = useRef(false);
  const callbacks = useRef({ request, changed });
  callbacks.current = { request, changed };
  useEffect(() => {
    let current = true;
    ++lifetime.current; paging.current = false; deletingRef.current = false; setDeletion(null); setDeleting(false); setLoadingMore(""); setLoadedItems(false);
    setError(false);
    document.getElementById("customizations-heading")?.focus();
    callbacks.current.request<Collection>("extensions").then(next => {
      if (!current) return;
      callbacks.current.changed(next.selection.generation);
      setState(next);
      setRecoveries(pendingRequests(next.owner.id));
    }).catch(() => { if (current) setError(true); });
    return () => { current = false; ++lifetime.current; };
  }, [retry]);
  useEffect(() => { if (state && focusAction) document.getElementById(focusAction)?.focus({ preventScroll: true }); }, [state?.owner.id, focusAction]);
  useLayoutEffect(() => { if (deletion?.id) document.getElementById("customization-delete-confirm")?.focus(); }, [deletion?.id]);
  async function loadMore() {
    const cursor = state?.next;
    if (!cursor || !state || paging.current || deletingRef.current) return;
    paging.current = true;
    const turn = lifetime.current, ownerId = state.owner.id;
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const position = { x: window.scrollX, y: window.scrollY };
    setLoadingMore("items"); setMoreError("");
    try {
      const next = await callbacks.current.request<Collection>("extensions?before=" + encodeURIComponent(cursor));
      if (lifetime.current !== turn) return;
      if (next.owner.id !== ownerId) throw new Error("Customization owner mismatch");
      setState(old => old ? { ...old, items: [...old.items, ...next.items.filter(item => !old.items.some(row => row.extension?.id === item.extension?.id))], next: next.next } : old);
      setLoadedItems(true);
    } catch {
      if (lifetime.current === turn) setMoreError("Earlier saved work could not be loaded. Your current list is kept; try Load more again.");
    } finally { if (lifetime.current === turn) {
      paging.current = false; setLoadingMore("");
      requestAnimationFrame(() => { if (lifetime.current === turn) { focus?.focus({ preventScroll: true }); window.scrollTo(position.x, position.y); } });
    } }
  }
  function cancelDeletion() {
    if (deletingRef.current || !deletion) return;
    const id = deletion.id;
    const turn = lifetime.current;
    setDeletion(null);
    requestAnimationFrame(() => { if (lifetime.current === turn) document.getElementById("delete-" + id)?.focus({ preventScroll: true }); });
  }
  async function confirmDeletion(id: string) {
    if (!state || deletingRef.current || paging.current) return;
    const turn = lifetime.current, ownerId = state.owner.id;
    deletingRef.current = true; setDeleting(true); setDeletion(null); setDeleteNotice("");
    try {
      const saved = await callbacks.current.request<State>(`extensions/${encodeURIComponent(id)}`);
      if (lifetime.current !== turn) return;
      if (saved.owner.id !== ownerId || saved.extension?.id !== id) throw new Error("Customization identity mismatch");
      setState(old => old ? { ...old, items: old.items.map(item => item.extension!.id === id ? saved : item) } : old);
      setDeletion({ id, name: saved.extension.name, draftVersion: saved.draftVersion, generation: saved.selection.generation,
        selected: saved.selection.revision?.extensionId === id, message: "", blocked: false, uncertain: false });
    } catch {
      if (lifetime.current === turn) setDeleteNotice("Saved state could not be checked. Refresh the collection before confirming Delete.");
    } finally { if (lifetime.current === turn) { deletingRef.current = false; setDeleting(false); } }
  }
  async function refreshCollection(ownerId: string, turn: number, deletedId?: string) {
    const next = await callbacks.current.request<Collection>("extensions");
    if (lifetime.current !== turn) return;
    if (next.owner.id !== ownerId) throw new Error("Customization owner mismatch");
    callbacks.current.changed(next.selection.generation);
    setState(old => old ? { ...old, ...next, next: loadedItems ? old.next : next.next,
      items: loadedItems ? [...next.items, ...old.items.filter(item => item.extension!.id !== deletedId && !next.items.some(row => row.extension!.id === item.extension!.id))] : next.items } : next);
  }
  async function refreshDeletion() {
    if (!state || !deletion || deletingRef.current) return;
    const snapshot = deletion, turn = lifetime.current, ownerId = state.owner.id;
    deletingRef.current = true; setDeleting(true);
    try {
      const saved = await callbacks.current.request<State>(`extensions/${encodeURIComponent(snapshot.id)}`).catch(failure => {
        if ((failure as { status?: number }).status === 404) return null;
        throw failure;
      });
      if (lifetime.current !== turn) return;
      if (saved && (saved.owner.id !== ownerId || saved.extension?.id !== snapshot.id)) throw new Error("Customization identity mismatch");
      await refreshCollection(ownerId, turn, saved ? undefined : snapshot.id);
      if (lifetime.current !== turn) return;
      if (saved) setState(old => old ? { ...old, items: old.items.map(item => item.extension!.id === snapshot.id ? saved : item) } : old);
      setDeletion(null); setDeleteNotice(saved ? "Saved state refreshed. Review the customization and confirm Delete again." : "That customization is unavailable. Your collection was refreshed.");
      requestAnimationFrame(() => { if (lifetime.current === turn) (document.getElementById("delete-" + snapshot.id) ?? document.getElementById("customizations-heading"))?.focus({ preventScroll: true }); });
    } catch { if (lifetime.current === turn) setDeletion({ ...snapshot, message: "Saved state could not be refreshed. Try Refresh collection again before confirming." }); }
    finally { if (lifetime.current === turn) { deletingRef.current = false; setDeleting(false); } }
  }
  async function deleteCustomization() {
    if (!state || !deletion || deletingRef.current || paging.current || deletion.blocked) return;
    const snapshot = deletion, turn = lifetime.current, ownerId = state.owner.id;
    deletingRef.current = true; setDeleting(true); setDeleteNotice("");
    if (snapshot.selected) beforeSelectionChange();
    try {
      const receipt = await callbacks.current.request<{ extensionId: string; deletedAt: number }>(`extensions/${encodeURIComponent(snapshot.id)}/delete`, "POST", {
        expectedName: snapshot.name, draftVersion: snapshot.draftVersion, generation: snapshot.generation,
      });
      if (lifetime.current !== turn) return;
      if (receipt.extensionId !== snapshot.id || !Number.isSafeInteger(receipt.deletedAt) || receipt.deletedAt < 0) throw new Error("Unconfirmed deletion");
      setState(old => old ? { ...old, items: old.items.filter(item => item.extension!.id !== snapshot.id) } : old);
      setDeletion(null); setDeleteNotice(`“${snapshot.name}” was deleted.`);
      try { await refreshCollection(ownerId, turn, snapshot.id); }
      catch { if (lifetime.current === turn) setDeleteNotice(`“${snapshot.name}” was deleted. Current selection could not be checked. Refresh the collection before making another change.`); }
      requestAnimationFrame(() => { if (lifetime.current === turn) document.getElementById("customizations-heading")?.focus({ preventScroll: true }); });
    } catch (failure) {
      if (lifetime.current !== turn) return;
      const problem = failure as { status?: number; code?: string };
      const busy = problem.code === "CUSTOMIZATION_BUSY";
      const rejected = !!problem.status && problem.status >= 400 && problem.status < 500;
      setDeletion({ ...snapshot, blocked: rejected, uncertain: !rejected, message: busy
        ? "Open this customization and use Stop, then wait for authoring to settle before deleting it."
        : rejected ? "This customization or its selection changed, or it is unavailable. Refresh the collection and confirm again."
          : "Deletion could not be confirmed. It may have finished. Check deletion with the same confirmation before making another change." });
    } finally { if (lifetime.current === turn) { deletingRef.current = false; setDeleting(false); } }
  }
  return <main className="customizations-main" aria-labelledby="customizations-heading">
    <h1 id="customizations-heading" tabIndex={-1}>Customizations</h1>
    <p className="page-intro">Make Daymark work your way. Start a change or return to a saved customization.</p>
    {state?.executionAvailability?.available === false && <p role="status">{state.executionAvailability.message || "Task customizations cannot run in this installation yet. Your tasks still work."}</p>}
    {notice && <p role="status">{notice}</p>}
    {deleteNotice && <p role="status">{deleteNotice} <button className="quiet-button" onClick={() => setRetry(old => old + 1)}>Refresh collection</button></p>}
    <button id="new-customization" className="primary customization-start" onClick={() => open()}>New customization</button>
    {error ? <div className="error" role="alert">Customizations could not be checked. <button onClick={() => setRetry(old => old + 1)}>Try again</button></div>
      : !state ? <p role="status">Loading your customizations…</p> : !state.items.length ? <p className="customization-empty">Your customizations will appear here.</p> : state.items.map(item => {
        const selection = state.selections ? state.selections[item.extension!.hookId ?? ""] : state.selection;
        const selected = selection?.revision;
        const selectedItem = selected?.extensionId === item.extension!.id;
        const inUse = selectedItem && selection?.eligible && !item.retired;
        const changes = !!item.draft && (!selectedItem || item.draft.id !== selected?.id);
        const status = item.retired ? "Retired · history only" : selectedItem ? inUse ? changes ? item.approved ? "In use · Approved changes ready to turn on" : "In use · Changes in progress" : "In use" : "Couldn’t check what’s in use"
          : item.approved ? "Approved · Not in use" : item.draft ? "Saved changes · Not in use" : item.extension!.hookId ? "Not in use" : "In discussion";
        return <article key={item.extension!.id} className="customization-card" aria-label={item.extension!.name}>
          <div className="customization-copy">{!item.retired && taskTriggerGroup(item.extension!.hookId) && <p className="muted">{taskTriggerGroup(item.extension!.hookId)}</p>}<h2>{item.extension!.name}</h2>
            <p className="customization-status"><span className={`state-badge ${inUse ? "in-use" : ""}`}>{status}</span></p>
            {item.retired && <p>This earlier customization cannot run or be resumed. Its saved source, examples and history remain available.</p>}
            {item.extension!.name === "Untitled customization" && item.requestExcerpt && <p className="customization-request">Request: {item.requestExcerpt}</p>}
          </div>
          <div className="customization-actions"><button id={`edit-${item.extension!.id}`} className="primary" disabled={deleting} onClick={() => open({ extensionId: item.extension!.id })}>{item.retired ? "Open history" : changes ? "Continue changes" : "Open"}<span aria-hidden="true"> →</span></button>
            <button id={`delete-${item.extension!.id}`} className="quiet-button" disabled={deleting || !!loadingMore} onClick={() => void confirmDeletion(item.extension!.id)}>Delete</button></div>
          {deletion?.id === item.extension!.id && <section className="customization-delete" aria-labelledby="customization-delete-title" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancelDeletion(); } }}>
            <h3 id="customization-delete-title">Delete “{deletion.name}”?</h3>
            <p>This removes the customization from your saved work. You cannot undo this here. Your tasks stay unchanged.</p>
            {deletion.selected && <p>Deleting this customization also clears its saved selection.</p>}
            {deletion.message && <p role="alert">{deletion.message}</p>}
            <div className="customization-delete-actions"><button id="customization-delete-confirm" className="primary" disabled={deleting || deletion.blocked} onClick={() => void deleteCustomization()}>{deleting ? "Deleting…" : deletion.uncertain ? "Check deletion" : `Delete “${deletion.name}”`}</button>
              {deletion.blocked && <button className="quiet-button" disabled={deleting} onClick={() => void refreshDeletion()}>Refresh collection</button>}
              <button className="quiet-button" disabled={deleting} onClick={cancelDeletion}>Cancel</button></div>
          </section>}
        </article>;
      })}
    {(state?.next || loadedItems) && <button disabled={!!loadingMore || deleting} aria-disabled={!state?.next} onClick={() => void loadMore()}>{state?.next ? "Load more customizations" : "All customizations loaded"}</button>}
    {moreError && <p role="status">{moreError}</p>}
    {!!recoveries.length && <section aria-label="Submitted requests"><h2>Submitted requests</h2><p>Check what was saved before deciding whether to retry.</p>
      {recoveries.map((item, index) => <p key={item.entryId}><button onClick={() => open({ extensionId: item.turn.target.kind === "create" ? null : item.turn.target.extensionId,
        conversationId: item.turn.conversationId, recoveryId: item.entryId })}>Check submitted request {index + 1}</button></p>)}
    </section>}
  </main>;
}
