import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import StudioComposer from "./StudioComposer";
import { AssistantSetup, canConfigureAssistant } from "./Studio";
import "./Studio.css";

type Parameters = { reviewerId: string; title: string; intent: string };
type Example = { id: string; name: string; fault: string; actors: { id: string; role: string; userId?: string }[];
  initialTasks: { ref: string; actor: string; title: string; priority?: string }[];
  actions: { op: string; actor?: string; ref: string; title?: string; priority?: string; expect: Record<string, string | number> }[] };
type Agreement = { summary: string; claims: { hook: string; outcomes: { id: string; when: Record<string, unknown>; expect: Record<string, unknown> }[] }[] };
type Revision = { revisionId: string; parameters: Parameters | null; agreement?: Agreement; revoked: boolean; manifest?: { format?: string } };
type Discussion = { savedControls: boolean; canContinue: boolean; availability: { available: boolean; code?: string | null }; conversation: { version: number; runId: string; status: string;
  agreement: Agreement | null; confirmRejected?: boolean; checkUnavailable?: boolean; messages: { id: string; role: string; text: string }[] } | null };
type ChoiceInput = { operationId: string; expectedDraftVersion: number; revisionId: string; evidenceId: string; cases: Example[];
  approvalId?: string; expectedSelectionGeneration?: number };
type ControlInput = { operationId: string; targetRevisionId: string; expectedSelectionRevisionId: string | null; expectedSelectionGeneration: number };
type ActionKind = "approvals" | "activations" | "deactivations" | "revocations";
type ActionInput = ChoiceInput | ControlInput;
type ListedVersion = { revisionId: string; behavior: string | null; revoked: boolean; current: boolean; draft: boolean; openRoots: number; pendingEffects: number };
type RevisionPage = { items: ListedVersion[]; next: string | null };
type Receipt = { id: string; kind: ActionKind; operationId: string; actorId: string; revisionId: string;
  evidenceId?: string; approvalId?: string; generation?: number; input?: ActionInput & { kind: string } };
type State = { draftVersion: number; draft: Revision | null; selected: Revision | null; evidence: { id: string; caseDigest: string } | null; examples: Example[];
  eligibility: { eligible: boolean; reason: string }; approval: Receipt | null;
  selection: { available: boolean; generation: number | null; revisionId: string | null; activation: Receipt | null } };
type Evidence = { id: string; revisionId: string; cases: Example[]; report: { passed: boolean; cases: { id: string; name: string; passed: boolean;
  events: { action: string; ref: string; expected: Record<string, unknown>; observed: Record<string, unknown>;
    mismatches: { path: string; expected: unknown; observed: unknown }[] }[] }[] } };
type Request = <T>(path: string, method?: string, body?: object, signal?: AbortSignal) => Promise<T>;
const facts: Record<string, Record<string, string>> = {
  status: { open: "The task stays open", completed: "The task is complete" },
  children: { 0: "No linked task is added", 1: "One linked task is added" },
  decision: { ALLOW: "Completion is allowed", DENY: "The rule stops completion", BLOCKED: "Daymark blocks this attempt" },
};
const fact = (key: string, value: unknown) => facts[key]?.[String(value)] ?? "No supported observation was recorded";
const identity = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export function replyText(text: string) {
  const inline = (line: string) => line.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code> : part);
  const blocks: { type: "p" | "ul" | "ol"; lines: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const marker = line.match(/^\s*([-*]|\d+\.)\s+/);
    const type = !marker ? "p" : /^\d/.test(marker[1]) ? "ol" : "ul";
    const previous = blocks.at(-1);
    if (type !== "p" && previous?.type === type) previous.lines.push(line.slice(marker![0].length));
    else blocks.push({ type, lines: [line.slice(marker?.[0].length ?? 0)] });
  }
  return blocks.map(({ type: Block, lines }, i) => Block === "p" ? <p key={i}>{inline(lines[0])}</p>
    : <Block key={i}>{lines.map((line, j) => <li key={j}>{inline(line)}</li>)}</Block>);
}
const actionMessages = { approvals: "Draft approved. It’s not on yet.", activations: "Turned on for new tasks.",
  deactivations: "Turned off for new tasks. Existing tasks keep the rule they started with.",
  revocations: "The chosen version was permanently revoked. Saved work was not undone." };

export default function TeamCapability({ project, request, scopeControl, back, backToTasks, openShared, operationScope, controlsOnly, onControl }: {
  project: { id: string; name: string }; request: Request; scopeControl: ReactNode;
  back: () => void; backToTasks: () => void; openShared: () => void; operationScope: string | null;
  controlsOnly?: boolean; onControl?: () => void;
}) {
  const [state, setState] = useState<State | null>(null), [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [discussion, setDiscussion] = useState<Discussion | null>(null), [text, setText] = useState("");
  const [cases, setCases] = useState<Example[]>([]), [evidence, setEvidence] = useState<Evidence | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false), [setupNotice, setSetupNotice] = useState("");
  const setupGeneration = useRef(0), setupInvoker = useRef<HTMLElement>(null);
  const operationKey = operationScope ? `daymark-team-action:${operationScope}:${project.id}` : null;
  const preparationKey = operationScope ? `daymark-team-confirm:${operationScope}:${project.id}` : null;
  const [unconfirmedPreparation, setUnconfirmedPreparation] = useState<string | null>(() => {
    try { return preparationKey ? sessionStorage.getItem(preparationKey) : null; } catch { return null; }
  });
  const [pendingChoice, setPendingChoice] = useState<{ kind: ActionKind; body: ActionInput; rejected?: boolean } | null>(() => {
    try {
      const text = operationKey && sessionStorage.getItem(operationKey);
      if (!text || text.length > 40960) return null;
      const saved = JSON.parse(text);
      return Object.hasOwn(actionMessages, saved?.kind) && /^[0-9a-f-]{36}$/.test(saved?.body?.operationId) ? saved : null;
    } catch { return null; }
  });
  const [choiceReceipt, setChoiceReceipt] = useState<Receipt | null>(null), [choiceNotice, setChoiceNotice] = useState("");
  const [revisionPage, setRevisionPage] = useState<RevisionPage | null>(null), [targetRevisionId, setTargetRevisionId] = useState("");
  const [laterVersions, setLaterVersions] = useState(false);
  const [confirmation, setConfirmation] = useState<{ kind: "deactivations" | "revocations"; body: ControlInput;
    targetLabel?: string; counts?: string; behavior?: string | null } | null>(null);
  const lifetime = useRef(new AbortController()), serial = useRef(0), edits = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null), stateRef = useRef(state); stateRef.current = state;
  const latestReply = useRef<HTMLDivElement>(null), focusReply = useRef(false), positioned = useRef(false);
  const conversationEnd = useRef<HTMLDivElement>(null);
  const proposalAction = useRef<HTMLButtonElement>(null);
  const preparationFeedback = useRef<HTMLDivElement>(null);
  const decision = useRef<HTMLElement>(null), draftHeading = useRef<HTMLHeadingElement>(null);
  const preparedFrom = useRef<{ revisionId: string | null } | null>(null);
  const choiceFocus = useRef<boolean>(false);
  const controlHeading = useRef<HTMLHeadingElement>(null), controlInvoker = useRef<HTMLButtonElement | null>(null);
  const base = `projects/${project.id}/capability`;
  const chat = `projects/${project.id}/authoring`;
  const conversation = discussion?.conversation;
  const authoring = conversation?.status === "RUNNING" || conversation?.status === "CANCELLING";
  const preparationUnknown = !!conversation?.agreement && !conversation.confirmRejected && conversation.runId === unconfirmedPreparation;
  useLayoutEffect(() => { heading.current?.focus(); }, []);
  useLayoutEffect(() => {
    if (positioned.current || !discussion) return;
    positioned.current = true;
    if (conversation?.messages.length) (proposalAction.current ?? conversationEnd.current)?.scrollIntoView({ block: "nearest" });
  }, [discussion, conversation?.messages.length]);
  useLayoutEffect(() => {
    if (!focusReply.current || authoring || busy || !latestReply.current) return;
    focusReply.current = false;
    if (document.activeElement === document.body || document.activeElement?.id === "studio-message") {
      if (document.activeElement === document.body) latestReply.current.focus({ preventScroll: true });
      (proposalAction.current ?? conversationEnd.current)?.scrollIntoView({ block: "nearest" });
    }
  }, [authoring, busy, conversation?.version]);
  useLayoutEffect(() => {
    if (busy || !preparationFeedback.current) return;
    preparationFeedback.current.scrollIntoView({ block: "nearest" });
    if (document.activeElement === document.body) preparationFeedback.current.focus({ preventScroll: true });
  }, [busy, preparationUnknown, conversation?.confirmRejected]);
  useLayoutEffect(() => {
    if (!state?.draft || busy || !decision.current) return;
    const prepared = preparedFrom.current && preparedFrom.current.revisionId !== state.draft.revisionId;
    if (!prepared && !choiceFocus.current) return;
    if (prepared) preparedFrom.current = null;
    choiceFocus.current = false;
    decision.current.scrollIntoView({ block: "nearest" });
    draftHeading.current?.focus({ preventScroll: true });
  }, [busy, state?.draft?.revisionId]);
  useLayoutEffect(() => {
    if (confirmation) controlHeading.current?.focus();
    else { if (!busy) controlInvoker.current?.focus(); controlInvoker.current = null; }
  }, [confirmation?.body.operationId]);
  function failure(e: unknown) {
    if (lifetime.current.signal.aborted || (e as Error).name === "AbortError") return;
    const status = (e as { status?: number }).status;
    if ([401, 403, 404].includes(status ?? 0)) {
      serial.current++; setState(null); setDiscussion(null); setEvidence(null); setCases([]); setMembers([]); setChoiceReceipt(null);
      setRevisionPage(null); setTargetRevisionId(""); setConfirmation(null); setSetupOpen(false); setSetupNotice("");
    }
    setError(e instanceof Error ? e.message : "Saved Team state could not be read.");
  }
  async function refresh(initial = false) {
    const read = ++serial.current;
    setError("");
    try {
      const access = await request<{ members: { id: string; name: string }[] }>(`projects/${project.id}/members`, "GET", undefined, lifetime.current.signal);
      const thread = await request<Discussion>(chat, "GET", undefined, lifetime.current.signal);
      const next = await request<State>(base, "GET", undefined, lifetime.current.signal);
      if (read !== serial.current || lifetime.current.signal.aborted) return;
      if (initial || next.draft?.revisionId !== stateRef.current?.draft?.revisionId) {
        setCases(next.examples); edits.current++; setEvidence(null);
      }
      setState(next); setMembers(access.members); setDiscussion(thread);
      await readRevisions(undefined, read);
       if (next.evidence && !next.draft?.manifest?.format) await readEvidence(next.evidence.id, next, read, initial);
      return next;
    } catch (e) { if (read === serial.current) failure(e); }
  }
  async function readRevisions(after?: string, read = ++serial.current) {
    try {
      const page = await request<RevisionPage>(`${base}/revisions${after ? "?after=" + encodeURIComponent(after) : ""}`, "GET", undefined, lifetime.current.signal);
      if (read !== serial.current || lifetime.current.signal.aborted) return;
      setRevisionPage(page); setTargetRevisionId(""); setLaterVersions(!!after);
    } catch (e) { if (read === serial.current) { setRevisionPage(null); failure(e); } }
  }
  async function readEvidence(id: string, current = state!, read = ++serial.current, restoreCases = false) {
    const edit = edits.current;
    try {
      const saved = await request<Evidence>(`${base}/evidence/${id}`, "GET", undefined, lifetime.current.signal);
      if (read !== serial.current || lifetime.current.signal.aborted || saved.revisionId !== current.draft?.revisionId || edit !== edits.current) return;
      setEvidence(saved);
      if (restoreCases) setCases(saved.cases);
    } catch (e) { if (read === serial.current) failure(e); }
  }
  useEffect(() => {
    void refresh(true);
    const focused = () => { void refresh(); };
    window.addEventListener("focus", focused);
    return () => { lifetime.current.abort(); serial.current++; window.removeEventListener("focus", focused); };
  }, [project.id]);
  useEffect(() => {
    if (!authoring) return;
    const timer = window.setTimeout(() => void refresh(), 600);
    return () => window.clearTimeout(timer);
  }, [discussion]);
  useEffect(() => {
    if (!discussion || !unconfirmedPreparation || preparationUnknown) return;
    rememberPreparation(null);
  }, [discussion, unconfirmedPreparation, preparationUnknown]);
  function rememberPreparation(runId: string | null) {
    setUnconfirmedPreparation(runId);
    if (!preparationKey) return;
    try {
      if (runId) sessionStorage.setItem(preparationKey, runId);
      else sessionStorage.removeItem(preparationKey);
    } catch { /* Readback still works in this view. */ }
  }
  async function chatAction(action: "turn" | "confirm" | "cancel") {
    if (!state || busy || pendingChoice || action === "turn" && (!text.trim() || authoring)
        || action !== "turn" && !conversation
        || action === "confirm" && (!conversation?.agreement || conversation.confirmRejected || preparationUnknown)) return;
    const input = action === "turn" ? { operationId: crypto.randomUUID(), text, expectedVersion: conversation?.version ?? 0, expectedDraftVersion: state.draftVersion }
      : { runId: conversation!.runId, expectedVersion: conversation!.version };
    if (action === "confirm") {
      rememberPreparation(conversation!.runId);
      preparedFrom.current = { revisionId: state.draft?.revisionId ?? null };
      setChoiceReceipt(null); setChoiceNotice("");
    }
    if (action === "turn") focusReply.current = true;
    setBusy(action); setError("");
    try {
      const next = await request<Discussion>(`${chat}/${action}`, "POST", input, lifetime.current.signal);
      if (lifetime.current.signal.aborted) return;
      setDiscussion(next);
      if (action === "turn") setText("");
      if (action === "confirm") await refresh();
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (action === "confirm" && ![401, 403, 404].includes(status ?? 0)) {
        await refresh(); // Only the saved thread resolves the attempt. Never repeat the POST.
      } else {
        await refresh();
        failure(e);
      }
    }
    finally { if (!lifetime.current.signal.aborted) setBusy(""); }
  }
  async function run() {
    if (!state || busy || uncertain || pendingChoice) return;
    const read = ++serial.current, edit = edits.current, revisionId = state.draft?.revisionId;
    const submitted = { expectedDraftVersion: state.draftVersion, revisionId, cases: structuredClone(cases) };
    setBusy("simulations"); setError("");
    try {
      const next = await request<State & { evidenceId?: string }>(`${base}/simulations`, "POST", submitted, lifetime.current.signal);
      if (read !== serial.current || lifetime.current.signal.aborted) return;
      if (next.draft?.revisionId !== revisionId) return;
      setState(next);
      if (next.evidenceId && edit === edits.current) await readEvidence(next.evidenceId, next, read);
    } catch (e) {
      if (read !== serial.current) return;
      failure(e); setUncertain(true);
    } finally { if (!lifetime.current.signal.aborted) setBusy(""); }
  }
  function rememberChoice(value: typeof pendingChoice) {
    setPendingChoice(value);
    try {
      if (!operationKey) throw new Error("No private tab storage");
      if (value) sessionStorage.setItem(operationKey, JSON.stringify(value)); else sessionStorage.removeItem(operationKey);
    } catch { setChoiceNotice("Tab recovery is unavailable. Keep this page open to check the original action."); }
  }
  async function checkChoice() {
    if (!pendingChoice || busy) return;
    const read = ++serial.current;
    setBusy("readback"); setError("");
    try {
      const result = await request<{ receipt: Receipt | null }>(`${base}/operations/${pendingChoice.body.operationId}`, "GET", undefined, lifetime.current.signal);
      if (read !== serial.current || lifetime.current.signal.aborted) return;
      if (!result.receipt) {
        if (pendingChoice.rejected) {
          rememberChoice(null); setChoiceNotice("Daymark rejected the action and found no saved result. Nothing was retried. Check what’s in use before making a new choice.");
          await refresh();
        } else setChoiceNotice("Daymark couldn’t find a saved result. The action may still have happened. Nothing was retried.");
        return;
      }
      if (result.receipt.operationId !== pendingChoice.body.operationId || identity(result.receipt.input) !== identity({ kind: pendingChoice.kind, ...pendingChoice.body }))
        throw new Error("The saved result does not match this action. Nothing was retried.");
      setChoiceReceipt(result.receipt); setChoiceNotice(""); rememberChoice(null);
      await refresh();
      onControl?.();
    } catch (e) { if (read === serial.current) failure(e); }
    finally { if (!lifetime.current.signal.aborted) setBusy(""); }
  }
  async function choose(kind: "approvals" | "activations") {
    if (!state?.draft || !evidence || !matching || !state.eligibility.eligible || state.evidence?.id !== evidence.id
        || busy || uncertain || pendingChoice || kind === "activations" && !state.approval) return;
    const body: ChoiceInput = { operationId: crypto.randomUUID(), expectedDraftVersion: state.draftVersion,
      revisionId: state.draft.revisionId, evidenceId: evidence.id, cases: structuredClone(cases),
      ...(kind === "activations" ? { approvalId: state.approval!.id, expectedSelectionGeneration: state.selection.generation! } : {}) };
    await postChoice(kind, body);
  }
  async function postChoice(kind: ActionKind, body: ActionInput) {
    const read = ++serial.current;
    setBusy(kind); setError(""); setChoiceReceipt(null); setChoiceNotice(""); rememberChoice({ kind, body });
    try {
      const result = await request<{ receipt: Receipt }>(`${base}/${kind}`, "POST", body, lifetime.current.signal);
      if (read !== serial.current || lifetime.current.signal.aborted) return;
      if (result.receipt.operationId !== body.operationId || identity(result.receipt.input) !== identity({ kind, ...body })) throw new Error("The reply did not identify this action.");
      setChoiceReceipt(result.receipt); rememberChoice(null);
      if (kind !== "revocations") choiceFocus.current = true;
      await refresh();
      onControl?.();
    } catch (e) {
      if (read === serial.current) {
        failure(e);
        if ((e as { status?: number }).status === 409) rememberChoice({ kind, body, rejected: true });
        setChoiceNotice("The action reply was not confirmed. Check its saved result; do not submit it again.");
      }
    } finally { if (!lifetime.current.signal.aborted) setBusy(""); }
  }
  const versionLabel = (item: ListedVersion) => `Version reference: ${item.revisionId} · ${
    item.current ? "In use for new tasks" : item.draft ? "Latest saved draft" : "Earlier version"}${item.revoked ? " · Revoked" : ""}`;
  const versionCounts = (item: ListedVersion) => `Open original tasks: ${item.openRoots}. Unfinished rule actions: ${item.pendingEffects}.`;
  function confirmControl(kind: "deactivations" | "revocations", invoker: HTMLButtonElement) {
    if (!state?.selection.available || state.selection.generation === null || busy || pendingChoice || confirmation) return;
    const target = kind === "deactivations" ? state.selection.revisionId : targetRevisionId;
    const version = revisionPage?.items.find(r => r.revisionId === target);
    if (!target || kind === "revocations" && (!version || version.revoked)) return;
    controlInvoker.current = invoker;
    setConfirmation({ kind, body: { operationId: crypto.randomUUID(), targetRevisionId: target,
      expectedSelectionRevisionId: state.selection.revisionId, expectedSelectionGeneration: state.selection.generation },
      ...(kind === "revocations" && version && { targetLabel: versionLabel(version), counts: versionCounts(version), behavior: version.behavior }) });
  }
  const matching = evidence && evidence.revisionId === state?.draft?.revisionId && identity(evidence.cases) === identity(cases);
  const normalExamples = evidence?.report.cases.filter(c => evidence.cases.find(e => e.id === c.id)?.fault === "NONE");
  const failedCase = matching ? normalExamples?.find(c => c.events.some(event => event.mismatches.length)) : undefined;
  const failedStep = failedCase?.events.findIndex(event => event.mismatches.length) ?? -1;
  const failedEvent = failedCase?.events[failedStep];
  const choiceEligible = !!matching && state?.evidence?.id === evidence?.id && state?.eligibility.eligible;
  const lifecycleBusy = !!pendingChoice || !!confirmation || authoring || ["turn", "confirm", "cancel", "approvals", "activations", "deactivations", "revocations", "readback"].includes(busy);
  const selectedAvailable = state?.selected && !state.selected.revoked && state.selected.revisionId === state.selection.revisionId;
  const name = (id: unknown) => members.find(member => member.id === id)?.name ?? "the selected teammate";
  const scriptedSummary = (params: Parameters | null | undefined) => params?.title && params.reviewerId
    ? `Adds “${params.title}” for ${name(params.reviewerId)} and waits for that task before completion.`
    : "A saved customization is on.";
  const currentUse = !state?.selection.available ? "Current use could not be checked."
    : state.selection.revisionId === null ? "Nothing is on for new tasks."
    : selectedAvailable ? state.selected?.manifest?.format ? "A Shared Studio rule is on for new tasks. Open Studio to review it."
      : state.selected?.agreement?.summary ?? scriptedSummary(state.selected?.parameters) : "The selected customization is unavailable.";
  const describe = (result: Record<string, unknown>) => {
    if (result.decision === "DENY") return typeof result.message === "string" && result.message ? `The task stays open. ${result.message}` : "The task stays open.";
    if (result.decision === "ALLOW") return result.status === "completed" ? "The task can be completed." : "Completion is allowed.";
    if (result.decision === "BLOCKED") return "Daymark could not complete the task.";
    if (typeof result.childTitle === "string" && result.childTitle) return `Adds “${result.childTitle}” for ${name(result.childAssigneeId)}.`;
    if (typeof result.children === "number") return `${fact("children", result.children)}.`;
    return typeof result.status === "string" ? `${fact("status", result.status)}.` : "No result available.";
  };
  const joined = (values: string[]) => new Intl.ListFormat("en", { type: "disjunction" }).format(values);
  const situation = (when: Record<string, unknown>, hook: string) => {
    const facts = Object.entries(when).flatMap(([key, value]) => {
      const values = Array.isArray(value) ? value : [value];
      if (key === "priority" && ["low", "normal", "high"].every(priority => values.includes(priority))) return [];
      const names = joined(values.map(v => v === "absent" ? "missing" : String(v)));
      return [key === "priority" ? `priority is ${names}` : key === "childStatus" ? `the linked task is ${names}` : `the main task is ${names}`];
    });
    return facts.length ? `When ${facts.join(" and ")}` : hook === "TaskCreated" ? "For every new main task" : "For every main task checked at completion";
  };
  const behavior = (agreement: Agreement) => <div className="team-behavior">
    {agreement.claims.map(claim => <p key={claim.hook}>{claim.outcomes.map(outcome => {
      const { expect } = outcome;
      const consequence = expect.children === 1 ? `Daymark adds “${expect.childTitle}” for ${name(expect.childAssigneeId)}`
        : expect.decision === "DENY" ? "the main task stays open"
          : expect.decision === "ALLOW" ? "the main task can be completed" : "Daymark adds no linked task";
      return <span key={outcome.id}>{situation(outcome.when, claim.hook)}, {consequence}.{" "}</span>;
    })}</p>)}
    {!agreement.claims.some(c => c.hook === "TaskBeforeComplete") && <p>This rule does not hold completion.</p>}
  </div>;
  function actionLabel(result: Evidence["report"]["cases"][number], index: number, business = false) {
    const example = evidence?.cases.find(c => c.id === result.id), action = example?.actions[index];
    if (!action) return "Daymark checks this step";
    const actor = example?.actors.find(a => a.id === action.actor);
    const person = actor?.userId ? name(actor.userId) : action.actor === "author" ? "The task creator" : "An example teammate";
    const root = action.ref.replace(/\.(?:child|review)$/, "");
    const title = [...(example?.initialTasks ?? []), ...(example?.actions ?? [])].find(a => a.title && a.ref === root)?.title;
    const task = title ? `“${title}”` : "the example task";
    if (action.op === "create") return `${person} adds ${task}${action.priority ? ` (${action.priority} priority)` : ""}`;
    const child = result.events.slice(0, index).reverse().find(e => e.action === "dispatch" && e.ref === root
      && e.observed.receipt === "CONFIRMED" && typeof e.observed.childTitle === "string")?.observed.childTitle;
    if (action.op === "dispatch") return business && result.events[index].observed.childTitle
      ? `Daymark adds “${result.events[index].observed.childTitle}” for ${name(result.events[index].observed.childAssigneeId)}`
      : `Daymark checks what happens when ${task} is added`;
    if (action.op === "complete") return `${person} ${business ? "finishes" : "tries to finish"} ${root === action.ref ? task : child ? `“${child}”` : `the linked task for ${task}`}`;
    return `${person} checks whether a linked task was saved for ${task}`;
  }
  const observation = (op: string, result: Record<string, unknown>) => op === "create" ? `${fact("status", result.status)}.`
    : op === "dispatch" && result.outcome !== "COMPLETED" ? "Daymark couldn’t confirm the expected task result." : describe(result);
  const hasChild = (c: Evidence["report"]["cases"][number]) => c.events.some(e => e.action === "dispatch"
    && e.observed.receipt === "CONFIRMED" && !!e.observed.childTitle);
  const preview = matching && evidence?.report.passed && state?.eligibility.eligible
    ? normalExamples?.find(c => hasChild(c) && c.events.some(e => e.action === "complete" && /\.(child|review)$/.test(e.ref) && e.observed.decision === "ALLOW"))
      ?? normalExamples?.find(hasChild)
      ?? normalExamples?.[0] : null;
  const draft = controlsOnly || state?.draft?.manifest?.format ? null : state?.draft;
  const currentDraftOn = !!draft && draft.revisionId === state?.selection.revisionId;
  const showActive = currentDraftOn && !state?.draft?.revoked;
  const approvalReason = !state?.evidence
    ? conversation?.checkUnavailable ? "The draft was saved, but its examples couldn’t be checked." : "Check the saved draft before approving it."
    : !matching ? "The current check couldn’t be read. Check the saved draft again before approving it."
      : failedCase ? `The draft behaved differently in the example “${failedCase.name}”. Approval is blocked.`
        : !evidence?.report.passed ? "Daymark couldn’t verify that the rule handles an interrupted attempt safely. Approval is blocked. Review the requested behavior or check again."
          : !state.eligibility.eligible ? "The examples matched, but they didn’t verify all the required behavior or current project access. Approval is blocked. Check who’s involved or revise the rule and check again."
            : "These are not the latest saved checks. Read the saved state before approving.";
  const recoveryNeeded = state && (pendingChoice || uncertain || preparationUnknown);
  function closeSetup(unconfirmed: boolean) {
    const generation = ++setupGeneration.current;
    setSetupOpen(false);
    if (unconfirmed) {
      setSetupNotice("Saving could not be confirmed. Checking current settings without resubmitting.");
      const current = () => setupGeneration.current === generation && !lifetime.current.signal.aborted;
      void request("authoring/setup", "GET", undefined, lifetime.current.signal).then(() => {
        if (!current()) return;
        setSetupNotice("Current settings checked. Whether the key was replaced remains unconfirmed.");
        void refresh();
      }).catch(() => { if (current()) setSetupNotice("Settings could not be checked. Open Configure to check again."); });
    }
    requestAnimationFrame(() => {
      if (!lifetime.current.signal.aborted) (setupInvoker.current?.getClientRects().length ? setupInvoker.current : heading.current)?.focus();
    });
  }
  const renderMessage = (message: NonNullable<Discussion["conversation"]>["messages"][number]) => <article key={message.id}
    className={`team-message team-message-${message.role}`}>
    <strong className="team-speaker">{message.role === "user" ? "You" : "Daymark"}</strong>
    {message.role === "user" ? <p>{message.text}</p> : replyText(message.text)}
  </article>;
  const messages = conversation?.messages ?? [];
  const recent = messages.at(-1)?.role === "assistant" ? 2 : 1;
  const transcript = <div className="team-transcript">
    {messages.length > recent && <details><summary>Earlier messages</summary>{messages.slice(0, -recent).map(renderMessage)}</details>}
    <div ref={latestReply} tabIndex={-1} role="log" aria-label="Latest messages">{messages.slice(-recent).map(renderMessage)}</div>
  </div>;
  const composer = <>
    {authoring && <div className="rs-working" role="status"><span>{conversation?.status === "CANCELLING" ? "Stopping…" : "Working on your request…"}</span>
      <button disabled={!!busy || conversation?.status === "CANCELLING"} onClick={() => void chatAction("cancel")}>Stop</button></div>}
     {discussion && !discussion.availability.available && <div className="rs-setup-notice">
       <p role="status">{canConfigureAssistant(discussion.availability) ? "Set up the assistant to create or change a customization." : "The assistant is unavailable. You can still review saved work."}</p>
       {canConfigureAssistant(discussion.availability) && <button disabled={!!busy || !!pendingChoice} onClick={event => {
         setupInvoker.current = event.currentTarget; ++setupGeneration.current; setSetupOpen(true);
       }}>Configure</button>}
     </div>}
     {setupNotice && <p className="rs-setup-notice" role="status">{setupNotice}</p>}
     <StudioComposer text={text} change={setText} canSend={!!discussion?.availability.available && !lifecycleBusy && !busy && !!text.trim()}
       submit={event => { event.preventDefault(); void chatAction("turn"); }} />
     <div ref={conversationEnd} />
  </>;
  return <section className={controlsOnly ? undefined : "read-studio team-capability"} aria-label="Saved Team history and controls">
    <div className="team-capability-body">
    {!controlsOnly && <header className="rs-header">
      <h1 ref={heading} tabIndex={-1}>Saved Team history and controls</h1>
       <div className="rs-header-actions"><button onClick={back}>Back to Customizations</button>
      </div>
      <div className="team-scope">{scopeControl}</div>
    </header>}
      {error && <div className="team-feedback" role="alert">{error}
        {!recoveryNeeded && <button disabled={!!busy} onClick={() => void refresh()}>Check saved state</button>}</div>}
      {!state && !error && <p role="status">Checking saved work…</p>}
      {uncertain && <div className="team-feedback" role="status"><p>The reply was not confirmed. Check the saved examples; this does not run them again. Another action may have saved the results.</p>
        <button onClick={() => void refresh()}>Check saved result</button>
        <button onClick={() => { setUncertain(false); setError(""); }}>I checked saved state</button></div>}
        {!controlsOnly && discussion && <p>{!discussion.canContinue ? "There is no earlier draft or discussion to continue. " : ""}
          <button className="quiet-button" onClick={openShared}>Open Studio</button> to start new work.</p>}
       {state && discussion?.savedControls !== false && <>
         {(pendingChoice || choiceNotice) && <section aria-label="Saved Team action">
           {pendingChoice && <><p>This action is still unconfirmed. Check whether it was saved. Nothing will be sent again.</p>
            <button disabled={!!busy} onClick={() => void checkChoice()}>Check saved action</button></>}
           {choiceNotice && <p role="status">{choiceNotice}</p>}
         </section>}
           {!controlsOnly && discussion?.canContinue && (!draft || conversation?.agreement) && <section aria-label="Conversation" className="rs-chat">
            {state.draft && !draft && <p>Saving an earlier-format rule here replaces the current draft. Its saved revision stays in history. This does not change what’s on.</p>}
            {transcript}
            {conversation?.agreement && <article className="rs-message rs-decision" aria-label="Proposed behavior">
               <h2>Proposed behavior for {project.name}</h2>
               {behavior(conversation.agreement)}
                <details><summary>Examples</summary>
                 {conversation.agreement.claims.map(claim => <div key={claim.hook}>
                   <h3>{claim.hook === "TaskCreated" ? "When a task is added" : "When someone tries to finish a task"}</h3>
                   <ul>{claim.outcomes.map(outcome => <li key={outcome.id}>{situation(outcome.when, claim.hook)}. {describe(outcome.expect)}</li>)}</ul>
                 </div>)}
               </details>
               <p><strong>In use now</strong><br />{currentUse}</p>
               {conversation.confirmRejected
                 ? <div ref={preparationFeedback} tabIndex={-1} className="team-feedback" role="alert">Daymark couldn’t save this proposal. No draft was saved for it. Send a new message below to prepare a fresh proposal.</div>
                 : busy !== "confirm" && preparationUnknown
                   ? <div ref={preparationFeedback} tabIndex={-1} className="team-feedback" role="status"><p>Daymark couldn’t tell whether the draft was saved. Check saved state. This won’t send the confirmation again.</p>
                     <button disabled={!!busy} onClick={() => void refresh()}>Check saved state</button></div>
                   : <><p>Confirming saves this draft and checks the examples. It won’t change real tasks or what’s in use.</p>
                     <button ref={proposalAction} className="rs-primary" disabled={!!busy || lifecycleBusy} onClick={() => void chatAction("confirm")}>{busy === "confirm" ? "Preparing and checking…" : "Confirm this behavior"}</button></>}
            </article>}
            {composer}
          </section>}
           {state.draft && draft && !conversation?.agreement && <>
             <section ref={decision} aria-label="Review and current use" className="team-decision">
               <h2 ref={draftHeading} tabIndex={-1}>{showActive ? "Customization in use" : state.draft.agreement ? "Proposed customization" : "Earlier saved customization"}</h2>
               <p className="team-project-name">{project.name} · Team</p>
               {state.draft.agreement ? behavior(state.draft.agreement) : <p>{scriptedSummary(state.draft.parameters)}</p>}
               <p role="status"><strong>{state.draft.revoked ? "Revoked" : showActive ? "On for new tasks" : state.approval ? "Approved · Not on yet" : "Draft · Not on"}</strong>
                 {!showActive && <><br />{currentUse}</>}</p>
               {state.draft.revoked && <p>This saved draft is revoked. It cannot run, be approved or be activated. Prepare a fresh revision to replace it.</p>}
                {!state.draft.revoked && !choiceEligible && <p>{approvalReason}</p>}
              {showActive && <button className="rs-primary" onClick={backToTasks}>Back to project Tasks</button>}
              {!matching || !choiceEligible ? <button className={showActive ? undefined : "rs-primary"} disabled={!!busy || uncertain || lifecycleBusy || state.draft.revoked}
               onClick={() => void run()}>{busy === "simulations" ? "Checking examples…" : "Check examples"}</button>
               : !state.approval ? <button className="rs-primary" disabled={!!busy || uncertain || lifecycleBusy}
                 onClick={() => void choose("approvals")}>Approve this draft</button>
                : state.draft.revisionId !== state.selection.revisionId && <>
                  <p>{selectedAvailable ? "This replaces the customization in use for new tasks. " : ""}Existing tasks keep the rule they started with.</p>
                 <button className="rs-primary" disabled={!state.selection.available || !!busy || uncertain || lifecycleBusy}
                   onClick={() => void choose("activations")}>Turn on for new tasks</button>
                </>}
            </section>
           {evidence && <section aria-label="Examples" className="team-examples">
             <h3>{matching && evidence.report.passed ? "Examples matched" : matching ? "Some examples did not match" : "Earlier example results"}</h3>
             <p>Examples only · No real tasks changed.</p>
              {preview && <details><summary>See how it works</summary><article className="rs-example">
                <h4>One example in {project.name}</h4>
                <ol>{preview.events.map((event, i) => (event.action === "create"
                    || event.action === "dispatch" && event.observed.receipt === "CONFIRMED"
                    || event.action === "complete" && event.observed.decision === "ALLOW")
                  && <li key={i}>{actionLabel(preview, i, true)}.</li>)}</ol>
              </article></details>}
               {failedCase && failedEvent && <article className="rs-example" aria-label="What didn’t match">
                 <h4>What didn’t match</h4>
                 <p>{actionLabel(failedCase, failedStep)}</p>
                 <p>Expected: {observation(failedEvent.action, failedEvent.expected)}</p>
                 <p>In the example: {observation(failedEvent.action, failedEvent.observed)}</p>
                 {observation(failedEvent.action, failedEvent.expected) === observation(failedEvent.action, failedEvent.observed)
                   && <p>Daymark couldn’t verify the details of that result.</p>}
               </article>}
           </section>}
          </>}
              {discussion?.canContinue && draft && !conversation?.agreement && <details className="team-more" open={authoring ? true : undefined}>
              <summary>Continue the conversation</summary>{transcript}{composer}
            </details>}
            {state.selection.available && selectedAvailable && <section className="team-control" aria-label="Stop current use">
               <h3>Current customization</h3>
               {!showActive && <p>{currentUse}</p>}
                <p>Turn this off to stop using it on new tasks. Existing tasks keep the rule they started with.</p>
               <button disabled={!!busy || lifecycleBusy}
                  onClick={e => confirmControl("deactivations", e.currentTarget)}>Turn off for new tasks</button>
             </section>}
             {confirmation?.kind === "deactivations" && controlConfirmation()}
             {choiceReceipt && !pendingChoice && !choiceNotice && <section aria-label="Saved Team action">
               <p role="status">{choiceReceipt.kind === "activations" && state.selection.activation?.id !== choiceReceipt.id
                 ? "That activation is historical. Current use has changed." : actionMessages[choiceReceipt.kind]}</p>
              </section>}
              {(!revisionPage || revisionPage.items.length > 0) && <details className="team-control"><summary>Advanced: emergency revocation</summary>
                <p>Project admins only. Permanently stop one version if it must stop affecting existing tasks. To stop using the current version only for new tasks, turn it off instead.</p>
                <p>Revoking a version stops its future actions and prevents unfinished original tasks that use it from being completed. Linked reviews can still be completed. Saved work and other versions are unchanged.</p>
                 <p>Earlier versions can still affect tasks. Match the reference under Rule version for this task in an affected original task’s details. Counts are a guide: a completed task can still have an unfinished rule action.</p>
               {!revisionPage ? <><p>The version list is unavailable.</p><button disabled={!!busy || lifecycleBusy} onClick={() => void readRevisions()}>Read version list</button></> : <>
                 <label htmlFor="team-revocation-target">Version to revoke</label>
                 <select id="team-revocation-target" value={targetRevisionId} disabled={!!busy || lifecycleBusy} onChange={e => setTargetRevisionId(e.target.value)}>
                   <option value="">Choose a saved version</option>
                    {revisionPage.items.map(r => <option key={r.revisionId} value={r.revisionId}>{versionLabel(r)}{r.behavior ? ` · ${r.behavior}` : ""} · {r.openRoots} open, {r.pendingEffects} unfinished</option>)}
                 </select>
                 {revisionPage.items.map(r => r.revisionId === targetRevisionId && <p key={r.revisionId} role="status">
                   {versionLabel(r)}. {versionCounts(r)}{r.behavior && <><br />{r.behavior}</>}
                 </p>)}
                  {laterVersions && <button disabled={!!busy || lifecycleBusy} onClick={() => void readRevisions()}>Back to first versions</button>}
                 {revisionPage.next && <button disabled={!!busy || lifecycleBusy} onClick={() => void readRevisions(revisionPage.next!)}>More versions</button>}
                <button disabled={!targetRevisionId || !!busy || lifecycleBusy || revisionPage.items.find(r => r.revisionId === targetRevisionId)?.revoked}
                  onClick={e => confirmControl("revocations", e.currentTarget)}>Review emergency revocation</button>
               </>}
               {confirmation?.kind === "revocations" && controlConfirmation()}
             </details>}
       </>}
     </div>
     {setupOpen && state && <AssistantSetup team request={request} close={closeSetup} beginSave={() => { ++setupGeneration.current; }} saved={() => {
       closeSetup(false); setSetupNotice("Settings saved. Send a message when you’re ready."); void refresh();
     }} />}
   </section>;

   function controlConfirmation() {
     if (!confirmation) return null;
     const stopping = confirmation.kind === "deactivations";
     return <section className="team-feedback" role="group" aria-label="Confirm Team control">
       <h3 ref={controlHeading} tabIndex={-1}>{stopping ? "Turn off for new tasks?" : "Confirm emergency revocation"}</h3>
        {stopping ? <p>Existing tasks keep the rule they started with.</p> : <>
          <p>{confirmation.targetLabel}. {confirmation.counts}</p>
          {confirmation.behavior && <p>{confirmation.behavior}</p>}
          <p>This version will be permanently revoked. Its future actions will stop and unfinished original tasks using it can’t be completed. Saved work and other versions are unchanged.</p>
       </>}
       <button disabled={!!busy} onClick={() => setConfirmation(null)}>Cancel</button>
       <button disabled={!!busy || !!pendingChoice} onClick={() => { setConfirmation(null); void postChoice(confirmation.kind, confirmation.body); }}>
          {stopping ? "Confirm stop for new tasks" : "Permanently revoke this version"}
       </button>
     </section>;
   }
}
