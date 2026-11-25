import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import StudioComposer from "./StudioComposer";
import { AssistantSetup, canConfigureAssistant } from "./Studio";
import "./Studio.css";

type Parameters = { reviewerId: string; title: string; intent: string };
type Example = { id: string; name: string; fault: string; actors: { id: string; role: string; userId?: string }[];
  initialTasks: { ref: string; actor: string; title: string; priority?: string }[];
  actions: { op: string; actor?: string; ref: string; title?: string; priority?: string; expect: Record<string, string | number> }[] };
type Agreement = { summary: string; claims: { hook: string; outcomes: { id: string; when: Record<string, unknown>; expect: Record<string, unknown> }[] }[] };
type Revision = { revisionId: string; parameters: Parameters | null; agreement?: Agreement; manifest: { executableIdentity: string }; revoked: boolean };
type Discussion = { availability: { available: boolean; code?: string | null }; conversation: { version: number; runId: string; status: string;
  agreement: Agreement | null; checkUnavailable?: boolean; messages: { id: string; role: string; text: string }[] } | null };
type ChoiceInput = { operationId: string; expectedDraftVersion: number; revisionId: string; evidenceId: string; cases: Example[];
  approvalId?: string; expectedSelectionGeneration?: number };
type ControlInput = { operationId: string; targetRevisionId: string; expectedSelectionRevisionId: string | null; expectedSelectionGeneration: number };
type ActionKind = "approvals" | "activations" | "deactivations" | "revocations";
type ActionInput = ChoiceInput | ControlInput;
type Target = { revisionId: string; revokedAt: number | null };
type RevisionPage = { items: (Target & { revoked: boolean; current: boolean; draft: boolean; openRoots: number; pendingEffects: number })[]; next: string | null };
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
  outcome: { COMPLETED: "The rule finished", FAILED: "The rule failed", UNCERTAIN: "The rule outcome is uncertain",
    UNKNOWN: "No rule outcome was returned", NONE: "No rule outcome is recorded" },
  receipt: { CONFIRMED: "The linked task was saved", NONE: "No linked task is confirmed" },
  decision: { ALLOW: "Completion is allowed", DENY: "The rule stops completion", BLOCKED: "Daymark blocks this attempt" },
  effect: { CONFIRMED: "The linked task is confirmed saved", NONE: "The closed attempt saved no linked task",
    UNRESOLVED: "The write has not been reconciled" },
};
const fact = (key: string, value: unknown) => facts[key]?.[String(value)] ?? "No supported observation was recorded";
const identity = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
function replyText(text: string) {
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
  deactivations: "Turned off for new tasks. Started work keeps its existing rule.",
  revocations: "Emergency revocation recorded for the exact revision. Saved work was not undone." };

export default function TeamCapability({ project, request, scopeControl, back, backToTasks, operationScope }: {
  project: { id: string; name: string }; request: Request; scopeControl: ReactNode;
  back: () => void; backToTasks: () => void; operationScope: string | null;
}) {
  const [state, setState] = useState<State | null>(null), [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [discussion, setDiscussion] = useState<Discussion | null>(null), [text, setText] = useState("");
  const [cases, setCases] = useState<Example[]>([]), [evidence, setEvidence] = useState<Evidence | null>(null);
  const [source, setSource] = useState<unknown>(null), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false), [setupNotice, setSetupNotice] = useState("");
  const setupGeneration = useRef(0), setupInvoker = useRef<HTMLElement>(null);
  const [unconfirmedPreparation, setUnconfirmedPreparation] = useState<string | null>(null);
  const operationKey = operationScope ? `daymark-team-action:${operationScope}:${project.id}` : null;
  const [pendingChoice, setPendingChoice] = useState<{ kind: ActionKind; body: ActionInput; rejected?: boolean } | null>(() => {
    try {
      const text = operationKey && sessionStorage.getItem(operationKey);
      if (!text || text.length > 40960) return null;
      const saved = JSON.parse(text);
      return Object.hasOwn(actionMessages, saved?.kind) && /^[0-9a-f-]{36}$/.test(saved?.body?.operationId) ? saved : null;
    } catch { return null; }
  });
  const [choiceReceipt, setChoiceReceipt] = useState<Receipt | null>(null), [choiceNotice, setChoiceNotice] = useState("");
  const [choiceTarget, setChoiceTarget] = useState<Target | null>(null);
  const [revisionPage, setRevisionPage] = useState<RevisionPage | null>(null), [targetRevisionId, setTargetRevisionId] = useState("");
  const [confirmation, setConfirmation] = useState<{ kind: "deactivations" | "revocations"; body: ControlInput } | null>(null);
  const lifetime = useRef(new AbortController()), serial = useRef(0), edits = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null), stateRef = useRef(state); stateRef.current = state;
  const latestReply = useRef<HTMLDivElement>(null), focusReply = useRef(false), positioned = useRef(false);
  const conversationEnd = useRef<HTMLDivElement>(null);
  const decision = useRef<HTMLElement>(null), draftHeading = useRef<HTMLHeadingElement>(null);
  const preparedFrom = useRef<{ revisionId: string | null } | null>(null);
  const choiceFocus = useRef<boolean>(false);
  const controlHeading = useRef<HTMLHeadingElement>(null), controlInvoker = useRef<HTMLButtonElement | null>(null);
  const base = `projects/${project.id}/capability`;
  const chat = `projects/${project.id}/authoring`;
  const conversation = discussion?.conversation;
  const authoring = conversation?.status === "RUNNING" || conversation?.status === "CANCELLING";
  useLayoutEffect(() => { heading.current?.focus(); }, []);
  useLayoutEffect(() => {
    if (positioned.current || !discussion) return;
    positioned.current = true;
    if (conversation?.messages.length) conversationEnd.current?.scrollIntoView({ block: "nearest" });
  }, [discussion, conversation?.messages.length]);
  useLayoutEffect(() => {
    if (!focusReply.current || authoring || busy || !latestReply.current) return;
    focusReply.current = false;
    if (document.activeElement === document.body || document.activeElement?.id === "studio-message") {
      if (document.activeElement === document.body) latestReply.current.focus({ preventScroll: true });
      conversationEnd.current?.scrollIntoView({ block: "nearest" });
    }
  }, [authoring, busy, conversation?.version]);
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
      serial.current++; setState(null); setDiscussion(null); setEvidence(null); setSource(null); setCases([]); setMembers([]); setChoiceReceipt(null);
      setRevisionPage(null); setTargetRevisionId(""); setConfirmation(null); setChoiceTarget(null); setSetupOpen(false); setSetupNotice("");
    }
    setError(e instanceof Error ? e.message : "Saved Team state could not be read.");
  }
  async function refresh(initial = false) {
    const read = ++serial.current;
    setError("");
    try {
      const access = await request<{ members: { id: string; name: string }[] }>(`projects/${project.id}/members`, "GET", undefined, lifetime.current.signal);
      const next = await request<State>(base, "GET", undefined, lifetime.current.signal);
      const thread = await request<Discussion>(chat, "GET", undefined, lifetime.current.signal);
      if (read !== serial.current || lifetime.current.signal.aborted) return;
      if (initial || next.draft?.revisionId !== stateRef.current?.draft?.revisionId) {
        setCases(next.examples); edits.current++; setSource(null); setEvidence(null);
      }
      setState(next); setMembers(access.members); setDiscussion(thread);
      await readRevisions(undefined, read);
      if (next.evidence) await readEvidence(next.evidence.id, next, read, initial);
      return next;
    } catch (e) { if (read === serial.current) failure(e); }
  }
  async function readRevisions(after?: string, read = ++serial.current) {
    try {
      const page = await request<RevisionPage>(`${base}/revisions${after ? "?after=" + encodeURIComponent(after) : ""}`, "GET", undefined, lifetime.current.signal);
      if (read !== serial.current || lifetime.current.signal.aborted) return;
      setRevisionPage(page); setTargetRevisionId("");
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
  async function chatAction(action: "turn" | "confirm" | "cancel") {
    if (!state || busy || pendingChoice || action === "turn" && (!text.trim() || authoring)
        || action !== "turn" && !conversation || action === "confirm" && conversation?.runId === unconfirmedPreparation) return;
    const input = action === "turn" ? { operationId: crypto.randomUUID(), text, expectedVersion: conversation?.version ?? 0, expectedDraftVersion: state.draftVersion }
      : { runId: conversation!.runId, expectedVersion: conversation!.version };
    if (action === "confirm") {
      preparedFrom.current = { revisionId: state.draft?.revisionId ?? null };
      setChoiceReceipt(null); setChoiceTarget(null); setChoiceNotice("");
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
      if (action === "confirm" && (!status || status >= 500) && !lifetime.current.signal.aborted) setUnconfirmedPreparation(conversation!.runId);
      const saved = await refresh();
      if (action !== "confirm" || !saved?.draft || saved.draft.revisionId === preparedFrom.current?.revisionId
          || identity(saved.draft.agreement) !== identity(conversation?.agreement)) failure(e);
    }
    finally { if (!lifetime.current.signal.aborted) setBusy(""); }
  }
  async function run() {
    if (!state || busy || uncertain || pendingChoice) return;
    const read = ++serial.current, edit = edits.current, revisionId = state.draft?.revisionId;
    const submitted = { expectedDraftVersion: state.draftVersion, revisionId, cases: structuredClone(cases) };
    setBusy("simulations"); setError(""); setSource(null);
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
      const result = await request<{ receipt: Receipt | null; target?: Target }>(`${base}/operations/${pendingChoice.body.operationId}`, "GET", undefined, lifetime.current.signal);
      if (read !== serial.current || lifetime.current.signal.aborted) return;
      if (!result.receipt) {
        if (pendingChoice.rejected) {
          rememberChoice(null); setChoiceNotice("The server rejected this action and no receipt is saved. Nothing was retried. Review current state before making a new choice.");
          await refresh();
        } else setChoiceNotice("No receipt was found. That does not prove the original action never committed. No action was retried.");
        return;
      }
      if (result.receipt.operationId !== pendingChoice.body.operationId || identity(result.receipt.input) !== identity({ kind: pendingChoice.kind, ...pendingChoice.body }))
        throw new Error("The saved receipt does not match this action. Nothing was retried.");
      setChoiceReceipt(result.receipt); setChoiceTarget(result.target ?? null); setChoiceNotice(""); rememberChoice(null);
      await refresh();
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
    setBusy(kind); setError(""); setChoiceReceipt(null); setChoiceTarget(null); setChoiceNotice(""); rememberChoice({ kind, body });
    try {
      const result = await request<{ receipt: Receipt; target?: Target }>(`${base}/${kind}`, "POST", body, lifetime.current.signal);
      if (read !== serial.current || lifetime.current.signal.aborted) return;
      if (result.receipt.operationId !== body.operationId || identity(result.receipt.input) !== identity({ kind, ...body })) throw new Error("The reply did not identify this action.");
      setChoiceReceipt(result.receipt); setChoiceTarget(result.target ?? null); rememberChoice(null);
      if (kind !== "revocations") choiceFocus.current = true;
      await refresh();
    } catch (e) {
      if (read === serial.current) {
        failure(e);
        if ((e as { status?: number }).status === 409) rememberChoice({ kind, body, rejected: true });
        setChoiceNotice("The action reply was not confirmed. Check its saved receipt; do not resubmit.");
      }
    } finally { if (!lifetime.current.signal.aborted) setBusy(""); }
  }
  function confirmControl(kind: "deactivations" | "revocations", invoker: HTMLButtonElement) {
    if (!state?.selection.available || state.selection.generation === null || busy || pendingChoice || confirmation) return;
    const target = kind === "deactivations" ? state.selection.revisionId : targetRevisionId;
    if (!target || kind === "revocations" && !revisionPage?.items.some(r => r.revisionId === target && !r.revoked)) return;
    controlInvoker.current = invoker;
    setConfirmation({ kind, body: { operationId: crypto.randomUUID(), targetRevisionId: target,
      expectedSelectionRevisionId: state.selection.revisionId, expectedSelectionGeneration: state.selection.generation } });
  }
  const matching = evidence && evidence.revisionId === state?.draft?.revisionId && identity(evidence.cases) === identity(cases);
  const failedCase = evidence?.report.cases.find(c => c.events.some(event => event.mismatches.length));
  const failedStep = failedCase?.events.findIndex(event => event.mismatches.length) ?? -1;
  const firstMismatch = failedCase?.events[failedStep]?.mismatches[0];
  const choiceEligible = !!matching && state?.evidence?.id === evidence?.id && state?.eligibility.eligible;
  const lifecycleBusy = !!pendingChoice || !!confirmation || authoring || ["turn", "confirm", "cancel", "approvals", "activations", "deactivations", "revocations", "readback"].includes(busy);
  const selectedAvailable = state?.selected && !state.selected.revoked && state.selected.revisionId === state.selection.revisionId;
  const name = (id: unknown) => members.find(member => member.id === id)?.name ?? "the selected teammate";
  const scriptedSummary = (params: Parameters | null | undefined) => params?.title && params.reviewerId
    ? `Adds “${params.title}” for ${name(params.reviewerId)} and waits for that task before completion.`
    : "An earlier customization is on.";
  const currentUse = !state?.selection.available ? "Current use could not be checked."
    : state.selection.revisionId === null ? "Nothing is on for new tasks."
    : selectedAvailable ? state.selected?.agreement?.summary ?? scriptedSummary(state.selected?.parameters) : "The selected customization is unavailable.";
  const describe = (result: Record<string, unknown>) => {
    if (result.decision === "DENY") return typeof result.message === "string" && result.message ? `The task stays open. ${result.message}` : "The task stays open.";
    if (result.decision === "ALLOW") return result.status === "completed" ? "The task can be completed." : "Completion is allowed.";
    if (result.decision === "BLOCKED") return "Daymark could not complete the task.";
    if (typeof result.childTitle === "string" && result.childTitle) return `Adds “${result.childTitle}” for ${name(result.childAssigneeId)}.`;
    if (typeof result.children === "number") return `${fact("children", result.children)}.`;
    if (typeof result.effect === "string") return `${fact("effect", result.effect)}.`;
    return typeof result.status === "string" ? `${fact("status", result.status)}.` : "No result available.";
  };
  const joined = (values: string[]) => new Intl.ListFormat("en", { type: "disjunction" }).format(values);
  const situation = (when: Record<string, unknown>, hook: string) => {
    const facts = Object.entries(when).map(([key, value]) => {
      const names = joined((Array.isArray(value) ? value : [value]).map(v => v === "absent" ? "missing" : String(v)));
      return key === "priority" ? `priority is ${names}` : key === "childStatus" ? `the linked task is ${names}` : `the main task is ${names}`;
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
  const observation = (op: string, result: Record<string, unknown>) => op === "reconcile" ? `${fact("effect", result.effect)}.`
    : op === "create" ? `${fact("status", result.status)}.` : op === "dispatch" && result.outcome !== "COMPLETED"
      ? `${fact("outcome", result.outcome)}. ${fact("receipt", result.receipt)}.` : describe(result);
  const normalExamples = evidence?.report.cases.filter(c => c.passed && evidence.cases.find(e => e.id === c.id)?.fault === "NONE");
  const hasChild = (c: Evidence["report"]["cases"][number]) => c.events.some(e => e.action === "dispatch"
    && e.observed.receipt === "CONFIRMED" && !!e.observed.childTitle);
  const preview = matching && evidence?.report.passed && state?.eligibility.eligible
    ? normalExamples?.find(c => hasChild(c) && c.events.some(e => e.action === "complete" && /\.(child|review)$/.test(e.ref) && e.observed.decision === "ALLOW"))
      ?? normalExamples?.find(hasChild) : null;
  const currentDraftOn = !!state?.draft && state.draft.revisionId === state.selection.revisionId;
  const showActive = currentDraftOn && !state?.draft?.revoked;
  const recoveryNeeded = state && (pendingChoice || uncertain || conversation?.runId === unconfirmedPreparation);
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
  return <section className="read-studio team-capability" aria-label="Customization Studio">
    <div className="team-capability-body">
    <header className="rs-header">
      <h1 ref={heading} tabIndex={-1}>Customization Studio</h1>
       <div className="rs-header-actions"><button onClick={back}>Back to Customizations</button>
      </div>
      <div className="team-scope">{scopeControl}</div>
    </header>
      {error && <div className="team-feedback" role="alert">{error}
        {!recoveryNeeded && <button disabled={!!busy} onClick={() => void refresh()}>Check saved state</button>}</div>}
      {!state && !error && <p role="status">Checking saved work…</p>}
      {uncertain && <div className="team-feedback" role="status"><p>The reply was not confirmed. Check the saved examples; this does not run them again. Another action may have saved the results.</p>
        <button onClick={() => void refresh()}>Check saved result</button>
        <button onClick={() => { setUncertain(false); setError(""); }}>I checked saved state</button></div>}
      {state && <>
         {(pendingChoice || choiceNotice) && <section aria-label="Saved Team action">
           {pendingChoice && <><p>This action is still unconfirmed. Check whether it was saved. Nothing will be sent again.</p>
            <button disabled={!!busy} onClick={() => void checkChoice()}>Check saved action</button></>}
           {choiceNotice && <p role="status">{choiceNotice}</p>}
         </section>}
         {(!state.draft || conversation?.agreement) && <section aria-label="Conversation" className="rs-chat">
            {!conversation && <><h2>What should happen in this project?</h2>
              <p className="team-starter">Ask what Daymark can do, or describe a change. For example: “Add a follow-up for high-priority tasks.”</p></>}
            {transcript}
            {composer}
           {conversation?.agreement && <article className="rs-message rs-decision" aria-label="Proposed behavior">
               <h2>Proposed behavior for {project.name}</h2>
               {behavior(conversation.agreement)}
               <details><summary>Exact expected outcomes</summary>
                 {conversation.agreement.claims.map(claim => <div key={claim.hook}>
                   <h3>{claim.hook === "TaskCreated" ? "When a task is added" : "When someone tries to finish a task"}</h3>
                   <ul>{claim.outcomes.map(outcome => <li key={outcome.id}>{situation(outcome.when, claim.hook)}. {describe(outcome.expect)}</li>)}</ul>
                 </div>)}
               </details>
               <p><strong>In use now</strong><br />{currentUse}</p>
              <p>Confirming saves this draft and checks the examples. It won’t change real tasks or what’s in use.</p>
              {conversation.runId === unconfirmedPreparation
                ? <div role="status"><p>The save wasn’t confirmed. Check saved state before starting a new request. Don’t resend this confirmation.</p>
                  <button disabled={!!busy} onClick={() => void refresh()}>Check saved state</button></div>
                : <button className="rs-primary" disabled={!!busy || lifecycleBusy} onClick={() => void chatAction("confirm")}>{busy === "confirm" ? "Preparing and checking…" : "Confirm this behavior"}</button>}
           </article>}
          </section>}
          {state.draft && !conversation?.agreement && <>
             <section ref={decision} aria-label="Review and current use" className="team-decision">
               <h2 ref={draftHeading} tabIndex={-1}>{showActive ? "Customization in use" : state.draft.agreement ? "Proposed customization" : "Earlier saved customization"}</h2>
               <p className="team-project-name">{project.name} · Team</p>
               {state.draft.agreement ? behavior(state.draft.agreement) : <p>{scriptedSummary(state.draft.parameters)}</p>}
               <p role="status"><strong>{state.draft.revoked ? "Revoked" : showActive ? "On for new tasks" : state.approval ? "Approved · Not on yet" : "Draft · Not on"}</strong>
                 {!showActive && <><br />{currentUse}</>}</p>
               {state.draft.revoked && <p>This saved draft is revoked. It cannot run, be approved or be activated. Prepare a fresh revision to replace it.</p>}
               {!state.draft.revoked && !choiceEligible && <p>{!state.evidence && conversation?.checkUnavailable
                 ? "The draft was saved, but its examples couldn’t be checked."
                 : firstMismatch ? `The draft behaved differently in the example “${failedCase!.name}”. Approval is blocked.`
                   : state.eligibility.reason || "Reading the saved examples."}</p>}
              {showActive && <button className="rs-primary" onClick={backToTasks}>Back to project Tasks</button>}
              {!matching || !choiceEligible ? <button className={showActive ? undefined : "rs-primary"} disabled={!!busy || uncertain || lifecycleBusy || state.draft.revoked}
               onClick={() => void run()}>{busy === "simulations" ? "Checking examples…" : "Check examples"}</button>
               : !state.approval ? <button className="rs-primary" disabled={!!busy || uncertain || lifecycleBusy}
                 onClick={() => void choose("approvals")}>Approve this draft</button>
                : state.draft.revisionId !== state.selection.revisionId && <>
                 <p>{selectedAvailable ? "This replaces the customization in use for new tasks. " : ""}Started work keeps its rule.</p>
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
              <details open={firstMismatch ? true : undefined}><summary>Details · all {evidence.report.cases.length} checks</summary>
               {evidence.report.cases.map(c => <article key={c.id} className="rs-example">
                 <h4>{c.name}</h4>
                  {evidence.cases.find(example => example.id === c.id)?.fault === "BEFORE_WRITE" && <p>Example setup: The write is interrupted before it saves.</p>}
                  {evidence.cases.find(example => example.id === c.id)?.fault === "LOST_REPLY" && <p>Example setup: The task is saved but the reply is lost.</p>}
                   <ol>{c.events.map((event, i) => <li key={i}><strong>{actionLabel(c, i)}</strong>
                    {event.mismatches.length ? <><p>Expected: {observation(event.action, event.expected)}</p><p>In the example: {observation(event.action, event.observed)}</p></>
                      : <p>{observation(event.action, event.observed)}</p>}</li>)}</ol>
                 {!c.passed && <p>This example needs a correction before approval.</p>}
               </article>)}
                <details><summary>Exact example results</summary><pre>{JSON.stringify(evidence, null, 2)}</pre></details>
              </details>
           </section>}
          </>}
            {state.draft && !conversation?.agreement && <details className="team-more" open={authoring ? true : undefined}>
              <summary>Continue the conversation</summary>{transcript}{composer}
            </details>}
            {state.selection.available && selectedAvailable && <section className="team-control" aria-label="Stop current use">
               <h3>Current customization</h3>
               {!showActive && <p>{currentUse}</p>}
               <p>Turn this off to stop using it on new tasks. Started work keeps its existing rule.</p>
               <button disabled={!!busy || lifecycleBusy}
                  onClick={e => confirmControl("deactivations", e.currentTarget)}>Turn off for new tasks</button>
             </section>}
             {confirmation?.kind === "deactivations" && controlConfirmation()}
             {choiceReceipt && !pendingChoice && !choiceNotice && <section aria-label="Saved Team action">
               <p role="status">{choiceReceipt.kind === "activations" && state.selection.activation?.id !== choiceReceipt.id
                 ? "That activation is historical. Current use has changed." : actionMessages[choiceReceipt.kind]}</p>
               <details><summary>Saved action details</summary>
                 {choiceTarget && <p>Target: {choiceTarget.revisionId} · {choiceTarget.revokedAt === null ? "Not revoked" : "Revoked"}</p>}
                 <pre>{JSON.stringify(choiceReceipt, null, 2)}</pre></details>
             </section>}
             {(!revisionPage || revisionPage.items.length > 0) && <details className="team-control"><summary>Emergency revocation</summary>
               <p>Project admins only. Revoke a specific version if it must stop affecting unfinished work. To stop using it only for new tasks, turn it off instead.</p>
               <p>This blocks future effects and completion of unfinished main tasks using that version. Linked reviews can still be completed. It doesn’t undo saved work or change other versions. Revocation is permanent.</p>
               <p>Older versions can still affect tasks. The counts below are advisory, and unfinished effects can belong to completed tasks.</p>
              {!revisionPage ? <><p>The revision list is unavailable.</p><button disabled={!!busy || lifecycleBusy} onClick={() => void readRevisions()}>Read revision list</button></> : <>
                <label htmlFor="team-revocation-target">Exact revision to revoke</label>
                <select id="team-revocation-target" value={targetRevisionId} disabled={!!busy || lifecycleBusy} onChange={e => setTargetRevisionId(e.target.value)}>
                  <option value="">Choose an exact revision</option>
                  {revisionPage.items.map(r => <option key={r.revisionId} value={r.revisionId}>{r.revisionId} · {r.revoked ? "revoked" : "not revoked"}{r.current ? " · current" : ""}{r.draft ? " · draft" : ""}</option>)}
                </select>
                {revisionPage.items.filter(r => r.revisionId === targetRevisionId).map(r => <p key={r.revisionId} role="status">
                  Exact target: {r.revisionId}. {r.revoked ? "Revoked" : "Not revoked"}. {r.current ? "Currently selected" : "Not selected"}. {r.draft ? "Saved draft" : "Not the saved draft"}.
                  {" "}Open deliverables: {r.openRoots}. Pending or started effects: {r.pendingEffects}.
                </p>)}
                <button disabled={!!busy || lifecycleBusy} onClick={() => void readRevisions()}>First revisions</button>
                <button disabled={!revisionPage.next || !!busy || lifecycleBusy} onClick={() => void readRevisions(revisionPage.next!)}>Next revisions</button>
                <button disabled={!targetRevisionId || !!busy || lifecycleBusy || revisionPage.items.find(r => r.revisionId === targetRevisionId)?.revoked}
                  onClick={e => confirmControl("revocations", e.currentTarget)}>Review emergency revocation</button>
               </>}
               {confirmation?.kind === "revocations" && controlConfirmation()}
             </details>}
             {(state.draft || state.selection.revisionId || !state.selection.available) && <details className="team-control"><summary>Support diagnostics</summary>
               <details><summary>Exact current-use receipt</summary><pre>{JSON.stringify(state.selection, null, 2)}</pre></details>
               {state.draft && <details><summary>Rule details</summary><p>{state.draft.manifest.executableIdentity}</p><p>Revision: {state.draft.revisionId}</p>
                 <button onClick={async () => {
                   const read = ++serial.current, revisionId = state.draft!.revisionId, edit = edits.current;
                   try {
                     const value = await request(`${base}/revisions/${revisionId}`, "GET", undefined, lifetime.current.signal);
                     if (read === serial.current && !lifetime.current.signal.aborted && stateRef.current?.draft?.revisionId === revisionId && edit === edits.current) setSource(value);
                   } catch (e) { if (read === serial.current) failure(e); }
                 }}>Inspect exact source and artifacts</button>
                 {source != null && <pre aria-label="Exact Team source and artifacts">{JSON.stringify(source, null, 2)}</pre>}
               </details>}
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
       {stopping ? <p>Started work keeps its existing rule.</p> : <>
         <p>Exact target revision: {confirmation.body.targetRevisionId}</p>
         <p>This revision will be permanently revoked. Its future effects and completion of unfinished main tasks will be blocked. Saved work and other versions are unaffected.</p>
       </>}
       <button disabled={!!busy} onClick={() => setConfirmation(null)}>Cancel</button>
       <button disabled={!!busy || !!pendingChoice} onClick={() => { setConfirmation(null); void postChoice(confirmation.kind, confirmation.body); }}>
         {stopping ? "Confirm stop for new tasks" : "Revoke this exact revision"}
       </button>
     </section>;
   }
}
