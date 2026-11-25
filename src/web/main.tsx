import { createRoot } from "react-dom/client";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Temporal } from "temporal-polyfill";
import "./styles.css";
import Studio, { sha256, type Collection, type StudioTarget } from "./Studio";
import Customizations, { CustomizationsPage } from "./Customizations";
import TeamCapability from "./TeamCapability";
import { normalizeTaskTags } from "../task-workflow-values.mjs";

type User = { id: string; name: string; description?: string };
type Session = { user: User | null; contextToken: string; users?: User[]; draftScope?: string | null };
async function withDraftScope(session: Session): Promise<Session> {
  try { return { ...session, draftScope: session.user ? await sha256(session.contextToken) : null }; }
  catch { return { ...session, draftScope: null }; }
}
function studioLink() {
  if (!location.hash) return { valid: true, target: null };
  const params = new URLSearchParams(location.hash.slice(1));
  const keys = Array.from(params.keys());
  const id = (value: string | null) => value !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
  if (keys.length === 1 && id(params.get("teamProject"))) return { valid: true, target: null, teamProject: params.get("teamProject")! };
  if (keys.length === 1 && params.get("personal") === "1") return { valid: true, target: null, personal: true };
  if (keys.length === 1 && params.get("new") === "1") return { valid: true, target: { extensionId: null } as StudioTarget };
  if (keys.length < 1 || keys.length > 2 || new Set(keys).size !== keys.length || keys.some(key => !["customization", "conversation"].includes(key))
    || !id(params.get("customization")) || params.has("conversation") && !id(params.get("conversation"))) return { valid: false, target: null };
  return { valid: true, target: { extensionId: params.get("customization"), conversationId: params.get("conversation") } as StudioTarget };
}
type Project = { id: string; name: string; mode?: "PERSONAL" | "TEAM"; role?: "ADMIN" | "MEMBER" };
type Members = { project: Project; members: { id: string; name: string; role: "ADMIN" | "MEMBER" }[] };
type NativeReceipt = { kind: string; effect?: "CONFIRMED" | "NONE" | "UNKNOWN"; value?: { id: string }; code?: string };
type NativeChange = Pick<Task, "tags" | "priority" | "dueAt">;
type ReactionObservation = { capability?: "tasks.create" | "tasks.update"; observation?: { updated?: { id: string; before: NativeChange; after: NativeChange } } };
type Reaction = {
  state: "NO_BINDING" | "PENDING" | "STARTED" | "FINISHED";
  workflow?: boolean;
  team?: boolean;
  revisionId?: string | null;
  revoked?: boolean;
  outcome?: { classification?: string; effects?: { state?: string; effect?: string }[]; error?: { code?: string }; [key: string]: unknown } | null;
  receipt?: NativeReceipt | null;
  reconciliation?: ({ observedAt: string; receipt?: NativeReceipt | null } & ReactionObservation) | null;
  message?: string;
} & ReactionObservation;
type Task = {
  id: string;
  projectId: string;
  title: string;
  notes: string;
  tags: string[];
  priority: "low" | "normal" | "high";
  dueAt: string | null;
  status: "open" | "completed";
  completedAt: string | null;
  creatorId?: string;
  assigneeId?: string | null;
  assigneeName?: string | null;
  parentTaskId?: string | null;
  originEventId?: string | null;
};
type TaskDraft = Pick<Task, "title" | "notes" | "priority"> & { tags: string; dueTime: string; dueZone: string; dueTimeEdited: boolean };
type CreateBody = Pick<Task, "projectId" | "title" | "notes" | "tags" | "priority" | "dueAt">;
type CreateNotCreated = { operationId: string; state: "NOT_CREATED"; code: "RULE_DENIED" | "CHECK_UNAVAILABLE" | "STALE_ATTEMPT" | "NATIVE_REJECTED"; message: string };
type CreateResult = CreateNotCreated | { operationId: string; state: "CREATED"; task: Task } | { operationId: string; state: "UNRESOLVED" };
type CreateAttempt = { operationId: string; body: CreateBody; draftVersion: number; checked: boolean; suspended: boolean };
type CreateRecovery = { attempt: CreateAttempt; draft: TaskDraft; version: number };
const createUncertain = "We couldn't confirm whether this task was added. Your entries are still here.";

function isTask(value: unknown): value is Task {
  const task = value as Task | null;
  return !!task && typeof task === "object" && typeof task.id === "string" && !!task.id && typeof task.projectId === "string"
    && typeof task.title === "string" && typeof task.notes === "string" && Array.isArray(task.tags) && task.tags.every(tag => typeof tag === "string")
    && ["low", "normal", "high"].includes(task.priority) && ["open", "completed"].includes(task.status)
    && (task.dueAt === null || typeof task.dueAt === "string") && (task.completedAt === null || typeof task.completedAt === "string");
}
function createResult(value: unknown, operationId: string): CreateResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as CreateResult;
  const keys = Object.keys(result).sort().join(",");
  if (result.operationId !== operationId) return null;
  if (result.state === "NOT_CREATED" && keys === "code,message,operationId,state"
    && ["RULE_DENIED", "CHECK_UNAVAILABLE", "STALE_ATTEMPT", "NATIVE_REJECTED"].includes(result.code)
    && typeof result.message === "string" && result.message.length <= 4096) return result;
  if (result.state === "CREATED" && keys === "operationId,state,task" && isTask(result.task)) return result;
  if (result.state === "UNRESOLVED" && keys === "operationId,state") return result;
  return null;
}
type SearchFilters = { q: string; tag: string };
type SearchPage = { items: Task[]; nextAfter: string | null };
type TaskSearch = SearchPage & { pending: boolean; failure: { message: string; after: string | null } | null };
const emptyFilters = { q: "", tag: "" };
const emptyPage = { items: [], nextAfter: null };

function newTaskDraft(): TaskDraft {
  return { title: "", notes: "", tags: "", priority: "normal", dueTime: "", dueZone: Temporal.Now.timeZoneId(), dueTimeEdited: false };
}

function draftDueAt(draft: TaskDraft): string | null | undefined {
  if (!draft.dueTimeEdited) return undefined;
  if (!draft.dueTime) return null;
  const local = Temporal.PlainDateTime.from(draft.dueTime);
  let dueAt: string;
  try {
    dueAt = local.toZonedDateTime(draft.dueZone, { disambiguation: "reject" })
      .toInstant().toString({ fractionalSecondDigits: 3 });
  } catch {
    const earlier = local.toZonedDateTime(draft.dueZone, { disambiguation: "earlier" }).toPlainDateTime();
    throw new Error(earlier.equals(local)
      ? "This local time occurs twice. Choose a different time."
      : "This local time does not exist. Choose a different time.");
  }
  if (dueAt.length !== 24 || dueAt < "0001-01-01T00:00:00.000Z") throw new Error("Choose a time within UTC years 0001 to 9999.");
  return dueAt;
}

function taskDraft(task: Task, dueZone = Temporal.Now.timeZoneId()): TaskDraft {
  const local = task.dueAt ? Temporal.Instant.from(task.dueAt).toZonedDateTimeISO(dueZone).toPlainDateTime() : null;
  const dueTime = local && local.year >= 1 && local.year <= 9999 ? local.toString({ fractionalSecondDigits: 3 }) : "";
  return { title: task.title, notes: task.notes, tags: task.tags.join(", "), priority: task.priority ?? "normal", dueTime, dueZone, dueTimeEdited: false };
}

function formatDueTime(dueAt: string, timeZone = Temporal.Now.timeZoneId()) {
  return new Date(dueAt).toLocaleString(undefined, { timeZone, year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, timeZoneName: "shortOffset",
    era: dueAt.startsWith("0001-01-01") ? "short" : undefined });
}

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public diagnostics?: unknown[],
    public code?: string,
    public createResult?: CreateNotCreated,
  ) {
    super(message);
  }
}

async function api<T>(
  path: string,
  context?: string,
  method = "GET",
  body?: object,
  signal?: AbortSignal,
  createId?: string,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    signal,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(context ? { "X-Session-Context": context } : {}),
      ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
      ...(createId ? { "X-Task-Create-Id": createId } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await response.json();
  const terminal = createId ? createResult(data, createId) : null;
  if (!response.ok)
    throw new ApiError(
      typeof data.message === "string" ? data.message : "The request could not be completed.",
      response.status,
      Array.isArray(data.diagnostics) ? data.diagnostics : undefined,
      typeof data.code === "string" ? data.code : undefined,
      terminal?.state === "NOT_CREATED" ? terminal : undefined,
    );
  return data;
}

function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true">
        ✓
      </span>
      <span className="brand-copy">
        <span className="brand-name">Daymark</span>
      </span>
    </span>
  );
}
function dismissTool(event: KeyboardEvent<HTMLDetailsElement>) {
  if (event.key !== "Escape") return;
  event.preventDefault(); event.currentTarget.open = false;
  event.currentTarget.querySelector("summary")?.focus();
}

function closeTaskFilter(form: HTMLFormElement | null) {
  const filter = form?.querySelector<HTMLDetailsElement>(".task-filter");
  if (!filter) return;
  const restoreFocus = filter.contains(document.activeElement);
  filter.open = false;
  if (restoreFocus) filter.querySelector("summary")?.focus();
}

function App() {
  const createRecovery = useRef(new Map<string, CreateRecovery>());
  const projectIntent = useRef("");
  const [session, setSession] = useState<Session | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const authBusy = useRef(false);
  const authVersion = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const version = authVersion.current;
    api<Session>("session", undefined, "GET", undefined, abort.signal)
      .then(async (data) => {
        const scoped = await withDraftScope(data);
        if (abort.signal.aborted || authVersion.current !== version) return;
        setSession(scoped);
        setUsers(data.users ?? []);
      })
      .catch((error) => {
        if (error.name !== "AbortError")
          setError(
            "The local app could not be reached. Check it is running, then reload.",
          );
      })
      .finally(() => setLoading(false));
    channel.current = new BroadcastChannel("keir-demo-session");
    channel.current.onmessage = () => {
      // A queued explicit sign-in still runs in cross-tab lock order.
      if (!authBusy.current) authVersion.current++;
      setSession(null);
      setError(
        "The demo person changed in another tab. Choose a person to continue.",
      );
    };
    return () => {
      abort.abort();
      channel.current?.close();
    };
  }, []);
  function expired() {
    authVersion.current++;
    setSession(null);
    setError(
      "Your demo session changed or the app restarted. Choose a person to continue.",
    );
  }
  async function authenticate(userId?: string) {
    if (authBusy.current) return;
    authBusy.current = true;
    const version = ++authVersion.current;
    if (session?.user && session.user.id !== userId) history.replaceState(null, "", location.pathname + location.search);
    setPending(true);
    setSession(null);
    setError("");
    try {
      if (!navigator.locks)
        throw new Error(
          "This demo needs a current browser with Web Locks for safe sign-in across tabs.",
        );
      // Hold the cross-tab lock until the cookie-writing response is fully consumed.
      await navigator.locks.request("keir-demo-auth", async () => {
        if (authVersion.current !== version) return;
        const current = await api<Session>("session");
        if (authVersion.current !== version) return;
        const next = await api<Session>(
          "session",
          current.contextToken,
          userId ? "POST" : "DELETE",
          userId ? { userId } : {},
        );
        channel.current?.postMessage("changed");
        const scoped = await withDraftScope(next);
        if (authVersion.current !== version) return;
        setSession(scoped);
      });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Sign-in could not finish. Try again.",
      );
    } finally {
      authBusy.current = false;
      setPending(false);
    }
  }
  if (loading)
    return (
      <div className="boot">
        <Brand />
        <p role="status">Making a little room…</p>
      </div>
    );
  if (!session?.user)
    return (
      <div className="welcome">
        <header className="welcome-header">
          <Brand />
        </header>
        <main className="welcome-main">
          <div className="welcome-copy">
            <p className="eyebrow">PROJECTS AND TASKS</p>
            <h1>
              Your tasks.
              <br />
              A clear <em>next step.</em>
            </h1>
            <p className="intro">
              A local space for projects, tasks and notes.
            </p>
            <div className="paper-note">
              <span aria-hidden="true">✓</span>
              <p>
                Your work stays here.
                <br />
                <small>Saved locally. Ready when you return.</small>
              </p>
            </div>
          </div>
          <section className="people-card" aria-labelledby="welcome-title">
            <h2 id="welcome-title">Choose a demo person.</h2>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <div className="people">
              {users.map((user, index) => (
                <button
                  key={user.id}
                  className="person"
                  onClick={() => authenticate(user.id)}
                  disabled={pending}
                >
                  <span className={`avatar avatar-${index}`} aria-hidden="true">
                    {user.name[0]}
                  </span>
                  <span>
                    <strong>Continue as {user.name}</strong>
                    <small>{user.description}</small>
                  </span>
                </button>
              ))}
            </div>
            {pending && (
              <p role="status" className="muted">
                Opening your space…
              </p>
            )}
            <p className="demo-note">
              This is local demo sign-in, not a private account.
              <br />
              No passwords, AI keys or extensions needed.
            </p>
          </section>
        </main>
      </div>
    );
  return (
    <Workspace
      key={session.contextToken}
      session={session as Session & { user: User }}
      users={users}
      signOut={() => authenticate()}
      switchUser={authenticate}
      expired={expired}
      createRecovery={createRecovery.current}
      projectIntent={projectIntent}
    />
  );
}

function Workspace({
  session,
  users,
  signOut,
  switchUser,
  expired,
  createRecovery,
  projectIntent,
}: {
  session: Session & { user: User };
  users: User[];
  signOut: () => void;
  switchUser: (id: string) => void;
  expired: () => void;
  createRecovery: Map<string, CreateRecovery>;
  projectIntent: { current: string };
}) {
  const retainedCreate = useRef(createRecovery.get(session.user.id));
  const studioDrafts = useRef(new Map<string, string | null>());
  const invalidCreateProject = useRef(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsReady, setProjectsReady] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filters, setFilters] = useState(emptyFilters);
  const [search, setSearch] = useState<TaskSearch | null>(null);
  const appliedFilters = useRef<SearchFilters | null>(null);
  const searchRequest = useRef<AbortController | null>(null);
  const searchFocus = useRef<HTMLElement | null>(null);
  const searchHeading = useRef<HTMLHeadingElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createDraft, setCreateDraft] = useState<TaskDraft>(() => retainedCreate.current?.draft ?? newTaskDraft());
  const createDraftRef = useRef(createDraft);
  createDraftRef.current = createDraft;
  const [createAttempt, setCreateAttempt] = useState<CreateAttempt | null>(() => retainedCreate.current ? { ...retainedCreate.current.attempt, checked: false, suspended: false } : null);
  const createAttemptRef = useRef(createAttempt);
  createAttemptRef.current = createAttempt;
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createNotice, setCreateNotice] = useState("");
  const [createFormNotice, setCreateFormNotice] = useState("");
  const [createActivity, setCreateActivity] = useState<"adding" | "checking" | null>(null);
  const createRecoveryControls = useRef<HTMLDivElement>(null);
  const createConfirmation = useRef<HTMLParagraphElement>(null);
  const removedRecoveryFocus = useRef<HTMLElement | null>(null);
  const createVersion = useRef(retainedCreate.current?.version ?? 0);
  const createInstance = useRef(0);
  const createPending = useRef(false);
  const [projectName, setProjectName] = useState("");
  const [projectMode, setProjectMode] = useState<"PERSONAL" | "TEAM">("PERSONAL");
  const [membersOpen, setMembersOpen] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [rename, setRename] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Task | null>(null);
  const [recentCompletion, setRecentCompletion] = useState<string | null>(null);
  const pendingTaskOpen = useRef<{ task: Task; navigation: number } | null>(null);
  const [draft, setDraft] = useState<TaskDraft>({ title: "", notes: "", tags: "", priority: "normal", dueTime: "", dueZone: "UTC", dueTimeEdited: false });
  const draftVersion = useRef(0);
  const routeKey = "daymark-studio-route:" + session.user.id;
  const [entryLink] = useState(studioLink);
  const [savedRoute] = useState<(StudioTarget & { entryId: string }) | null>(() => {
    if (!entryLink.valid || entryLink.teamProject || entryLink.personal) return null;
    let stored: (StudioTarget & { entryId: string }) | null = null;
    try {
      const value = JSON.parse(sessionStorage.getItem(routeKey) ?? "null");
      if (value && /^[0-9a-f-]{36}$/i.test(value.entryId) && (value.extensionId === null || typeof value.extensionId === "string")
        && (value.conversationId == null || typeof value.conversationId === "string")) stored = value;
    } catch { /* A valid link can still be opened without tab storage. */ }
    if (entryLink.target) {
      const same = stored && stored.extensionId === entryLink.target.extensionId && (stored.conversationId ?? null) === (entryLink.target.conversationId ?? null);
      return { ...entryLink.target, history: same ? stored!.history === true : false, entryId: same ? stored!.entryId : crypto.randomUUID() };
    }
    return stored;
  });
  const [destination, setDestination] = useState<"tasks" | "customizations" | "studio">(savedRoute ? "studio" : !entryLink.valid || entryLink.teamProject || entryLink.personal ? "customizations" : "tasks");
  const [studioOrigin, setStudioOrigin] = useState<"detail" | "overview">("overview");
  const [studioTarget, setStudioTarget] = useState(savedRoute ?? { extensionId: null, entryId: crypto.randomUUID() });
  const [customizationNotice, setCustomizationNotice] = useState(entryLink.valid ? "" : "That customization link is invalid. Choose a saved item or start a new one.");
  const studioEntrySerial = useRef(0);
  const currentStudioEntry = useRef<string | null>(studioTarget.entryId);
  const personalReturn = useRef<(StudioTarget & { entryId: string }) | null>(null);
  const projectsRef = useRef(projects); projectsRef.current = projects;
  const scope = useRef("PERSONAL");
  const scopeLifetime = useRef(new AbortController());
  const [unavailableTeam, setUnavailableTeam] = useState(false);
  const [completionHold, setCompletionHold] = useState<{ taskId: string; message: string } | null>(null);
  function selectProject(id: string) {
    const selected = projectsRef.current.find(item => item.id === id);
    if (!selected) return;
    const nextScope = selected.mode === "TEAM" ? "TEAM:" + id : "PERSONAL";
    if (id === projectIntent.current && nextScope === scope.current) {
      setMembersOpen(false); setUnavailableTeam(false); return;
    }
    generation.current++;
    studioEntrySerial.current++;
    if (nextScope !== scope.current) {
      if (scope.current === "PERSONAL" && destination === "studio") personalReturn.current = studioTarget;
      scopeLifetime.current.abort(); scopeLifetime.current = new AbortController();
      scope.current = nextScope;
    }
    setMembersOpen(false); setUnavailableTeam(false);
    setRename(false);
    setTasks([]); setDetail(null); setCompletionHold(null); resetSearch(); setBusy(false);
    projectIntent.current = id;
    setProjectId(id);
  }
  function rememberStudio(next: StudioTarget & { entryId: string }) {
    currentStudioEntry.current = next.entryId;
    try { sessionStorage.setItem(routeKey, JSON.stringify(next)); } catch { /* Recovery still uses the submitted operation when storage permits. */ }
    const params = new URLSearchParams();
    if (next.extensionId) {
      params.set("customization", next.extensionId);
      if (next.conversationId) params.set("conversation", next.conversationId);
    } else params.set("new", "1");
    const hash = !next.extensionId && next.conversationId ? "" : "#" + params.toString();
    if (location.hash !== hash) history.replaceState(null, "", location.pathname + location.search + hash);
    setStudioTarget(next);
  }
  useEffect(() => {
    try {
      if (destination === "studio" && scope.current === "PERSONAL") sessionStorage.setItem(routeKey, JSON.stringify(studioTarget));
      else if (scope.current === "PERSONAL") sessionStorage.removeItem(routeKey);
    } catch { /* Tab recovery is unavailable when browser storage is disabled. */ }
    if (destination !== "studio" && destination !== "customizations" && location.hash) history.replaceState(null, "", location.pathname + location.search);
  }, [destination, studioTarget, routeKey]);
  useEffect(() => {
    const changed = () => {
      studioEntrySerial.current++;
      const link = studioLink();
      if (link.teamProject) {
        const selected = projectsRef.current.find(item => item.id === link.teamProject && item.mode === "TEAM");
        if (selected) selectProject(selected.id);
        else setUnavailableTeam(true);
        currentStudioEntry.current = null; setDestination("customizations");
      } else if (link.personal) {
        const selected = projectsRef.current.find(item => item.mode !== "TEAM");
        if (selected) selectProject(selected.id);
        currentStudioEntry.current = null; setDestination("customizations");
      } else if (link.valid && link.target) {
        const selected = projectsRef.current.find(item => item.mode !== "TEAM");
        if (selected) selectProject(selected.id);
        setStudioOrigin("overview"); setCustomizationNotice("");
        rememberStudio({ ...link.target, entryId: crypto.randomUUID() }); setDestination("studio");
      } else {
        currentStudioEntry.current = null;
        setCustomizationNotice(link.valid ? "" : "That customization link is invalid. Choose a saved item or start a new one.");
        setDestination("customizations");
      }
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [routeKey]);
  const detailVisible = useRef(false);
  detailVisible.current = destination === "tasks" && !!detail;
  const createVisible = useRef(false);
  createVisible.current = destination === "tasks" && createOpen;
  const resumeDetail = useRef(false);
  const destinationFocus = useRef<string | null>(null);
  const taskScroller = useRef<HTMLElement>(null);
  const taskScroll = useRef(0);
  const [notice, setNotice] = useState("");
  const lifetime = useRef(new AbortController());
  const generation = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const returnToSearch = useRef(false);
  const detailRef = useRef<HTMLDialogElement>(null);
  const detailInstance = useRef(0);
  const serverGeneration = useRef<number | null>(null);
  function beforeSelectionChange() {
    serverGeneration.current = null;
  }
  function reconcileSelection(next: number) {
    if (serverGeneration.current !== next) beforeSelectionChange();
    serverGeneration.current = next;
  }
  const project = projects.find((item) => item.id === projectId);
  useEffect(
    () => () => {
      lifetime.current.abort();
      scopeLifetime.current.abort();
      generation.current++;
    },
    [],
  );
  function handleError(error: unknown) {
    if (
      lifetime.current.signal.aborted ||
      (error as Error).name === "AbortError"
    )
      return;
    if (error instanceof ApiError && error.status === 401) expired();
    else
      setError(
        error instanceof Error
          ? error.message
          : "Something went wrong. Please try again.",
      );
  }
  const request = <T,>(
    path: string,
    method = "GET",
    body?: object,
    signal = lifetime.current.signal,
    createId?: string,
  ) => api<T>(path, session.contextToken, method, body, signal, createId);
  async function studioRequest<T>(path: string, method?: string, body?: object, signal?: AbortSignal) {
    const capturedScope = scope.current;
    // Setup is shared; Personal drafts and authoring remain outside Team scope.
    if (capturedScope.startsWith("TEAM:") && path !== "authoring/setup" && /^(extensions|authoring)(\/|\?|$)/.test(path))
      throw new Error("Personal customization routes are not available in Team scope.");
    const scopedSignal = AbortSignal.any([lifetime.current.signal, scopeLifetime.current.signal, ...(signal ? [signal] : [])]);
    try {
      const result = await request<T>(path, method, body, scopedSignal);
      if (capturedScope !== scope.current || scopedSignal.aborted) throw new DOMException("Scope changed", "AbortError");
      return result;
    }
    catch (error) { if (error instanceof ApiError && error.status === 401) handleError(error); throw error; }
  }
  function resetSearch() {
    searchRequest.current?.abort();
    appliedFilters.current = null;
    setSearch(null);
    setFilters(emptyFilters);
  }
  async function fetchSearch(next: SearchFilters, mode: "submit" | "refresh" | "more", after: string | null = null) {
    searchRequest.current?.abort();
    const controller = new AbortController();
    searchRequest.current = controller;
    appliedFilters.current = next;
    const current = generation.current;
    const signal = AbortSignal.any([controller.signal, lifetime.current.signal]);
    setSearch(previous => ({
      ...(previous && mode !== "submit" ? previous : { ...emptyPage, failure: null }),
      pending: true,
    }));
    const params = new URLSearchParams();
    if (next.q) params.set("q", next.q);
    if (next.tag) params.set("tag", next.tag);
    if (after !== null) params.set("after", after);
    try {
      const page = await request<SearchPage>(`projects/${projectId}/tasks/search?${params}`, "GET", undefined, signal);
      if (signal.aborted || current !== generation.current) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest(".task-search-results")) searchFocus.current = focused;
      setSearch(previous => ({
        ...page,
        items: mode === "more" && previous ? [...previous.items, ...page.items] : page.items,
        pending: false,
        failure: null,
      }));
    } catch (failure) {
      if (signal.aborted || current !== generation.current) return;
      if (failure instanceof ApiError && failure.status === 401) { handleError(failure); return; }
      const message = failure instanceof ApiError ? failure.message : "Search could not be completed. Please try again.";
      setSearch(previous => ({ ...(previous ?? emptyPage), pending: false, failure: { message, after } }));
    }
  }
  function refreshSearch() {
    if (appliedFilters.current) void fetchSearch(appliedFilters.current, "refresh");
  }
  function updateTask(saved: Task) {
    const replace = (items: Task[]) => items.map(item => item.id === saved.id ? saved : item);
    setTasks(replace);
    setSearch(previous => previous && { ...previous, items: replace(previous.items) });
    refreshSearch();
  }
  useLayoutEffect(() => {
    resetSearch();
    return () => searchRequest.current?.abort();
  }, [projectId]);
  useLayoutEffect(() => {
    const focused = searchFocus.current;
    if (focused && !focused.isConnected && document.activeElement === document.body && destination === "tasks") {
      searchHeading.current?.focus();
    }
    searchFocus.current = null;
  }, [search, destination]);
  function navigate(next: "tasks" | "customizations") {
    if (destination === "studio" && scope.current === "PERSONAL") personalReturn.current = studioTarget;
    studioEntrySerial.current++;
    currentStudioEntry.current = null;
    destinationFocus.current = next === "tasks" ? "tasks-heading" : "customizations-heading";
    setDestination(next);
    if (next === "tasks") setUnavailableTeam(false);
    const hash = next === "customizations" && project?.mode === "TEAM" ? "#teamProject=" + encodeURIComponent(project.id) : "";
    if (hash !== location.hash) history.pushState(null, "", location.pathname + location.search + hash);
  }
  async function openStudio(origin: "detail" | "overview", target: StudioTarget = { extensionId: null }) {
    if (scope.current !== "PERSONAL") { setDestination("customizations"); return; }
    const entry = ++studioEntrySerial.current;
    if (origin === "detail") {
      try {
        const collection = await studioRequest<Collection>("extensions");
        if (lifetime.current.signal.aborted || studioEntrySerial.current !== entry || !detailVisible.current) return;
        target = { extensionId: collection.selection.revision?.extensionId ?? null };
      } catch (failure) { handleError(failure); return; }
    }
    setCustomizationNotice("");
    setStudioOrigin(origin);
    rememberStudio({ ...target, entryId: target.recoveryId ?? crypto.randomUUID() });
    setDestination("studio");
  }
  function returnFromStudio() {
    studioEntrySerial.current++;
    currentStudioEntry.current = null;
    if (studioOrigin === "detail" && detail && tasks.some(task => task.id === detail.id)) {
      resumeDetail.current = true;
      setDestination("tasks");
    } else {
      destinationFocus.current = studioTarget.extensionId ? `edit-${studioTarget.extensionId}` : "new-customization";
      setDestination("customizations");
    }
  }
  function returnToTasks() {
    if (studioOrigin === "detail") { returnFromStudio(); return; }
    studioEntrySerial.current++;
    currentStudioEntry.current = null;
    setDestination("tasks");
  }
  useEffect(() => {
    if (destinationFocus.current) {
      document.getElementById(destinationFocus.current)?.focus({ preventScroll: true });
      destinationFocus.current = null;
    }
  }, [destination]);
  useEffect(() => {
    request<Project[]>("projects")
      .then((data) => {
        if (!lifetime.current.signal.aborted) {
          setProjects(data);
          const recovery = createRecovery.get(session.user.id);
          const original = recovery && data.find(project => project.id === recovery.attempt.body.projectId);
          if (recovery && !original) {
            retainCreate(null);
            retainedCreate.current = undefined;
            invalidCreateProject.current = true;
          }
          const linkedTeam = entryLink.teamProject && data.find(item => item.id === entryLink.teamProject && item.mode === "TEAM");
          if (entryLink.teamProject && !linkedTeam) setUnavailableTeam(true);
          const selected = linkedTeam || (savedRoute || entryLink.target || entryLink.personal
            ? data.find(item => item.mode !== "TEAM")
            : original ?? data.find(item => item.id === projectIntent.current) ?? data[0]);
          scope.current = selected?.mode === "TEAM" ? "TEAM:" + selected.id : "PERSONAL";
          projectIntent.current = selected?.id ?? "";
          setProjectId(selected?.id ?? "");
          setProjectsReady(true);
        }
      })
      .catch(handleError)
      .finally(() => {
        if (!lifetime.current.signal.aborted) setLoading(false);
      });
  }, []);
  useEffect(() => {
    const current = ++generation.current;
    if (pendingTaskOpen.current?.task.projectId !== projectId) pendingTaskOpen.current = null;
    setTasks([]);
    setRecentCompletion(null);
    setDetail(null);
    const recovery = createRecovery.get(session.user.id);
    const restoring = recovery?.attempt.body.projectId === projectId;
    if (projectId || !retainedCreate.current) {
      createVersion.current = restoring ? recovery.version : createVersion.current + 1;
      const next = restoring ? recovery.draft : newTaskDraft();
      createDraftRef.current = next;
      setCreateDraft(next);
      setCreateOpen(restoring);
      setCreateError(restoring ? createUncertain : "");
      setCreateFormNotice("");
    }
    setError("");
    setRename(false);
    setNotice("");
    setCreateNotice(invalidCreateProject.current ? "The project for the previous task addition is no longer available. Its saved draft and retry are no longer available here." : "");
    invalidCreateProject.current = false;
    taskScroll.current = 0;
    if (taskScroller.current) taskScroller.current.scrollTop = 0;
    if (!projectId) return;
    const abort = new AbortController();
    setLoading(true);
    request<Task[]>(
      `projects/${projectId}/tasks`,
      "GET",
      undefined,
      abort.signal,
    )
      .then((data) => {
        if (current === generation.current && !lifetime.current.signal.aborted) {
          setTasks(data);
          const target = pendingTaskOpen.current;
          if (target?.task.projectId === projectId) {
            pendingTaskOpen.current = null;
            if (studioEntrySerial.current === target.navigation) {
              const actual = data.find(task => task.id === target.task.id);
              if (actual) {
                detailInstance.current++; setDraft(taskDraft(actual)); setDetail(actual);
                requestAnimationFrame(() => { if (current === generation.current && studioEntrySerial.current === target.navigation && !lifetime.current.signal.aborted) returnFocus.current = document.getElementById("task-open-" + actual.id); });
              }
              else setNotice("The created task is no longer available in this project.");
            }
          }
        }
      })
      .catch((error) => {
        if (current === generation.current) handleError(error);
      })
      .finally(() => {
        if (current === generation.current && !lifetime.current.signal.aborted)
          setLoading(false);
      });
    return () => abort.abort();
  }, [projectId]);
  useLayoutEffect(() => {
    if (destination === "customizations") {
      document.scrollingElement?.scrollTo(0, 0);
      document.querySelector<HTMLElement>(".customizations-main")?.scrollTo(0, 0);
    }
  }, [destination]);
  useLayoutEffect(() => {
    if (destination === "tasks" && taskScroller.current) taskScroller.current.scrollTop = taskScroll.current;
    if ((detail || createOpen) && destination === "tasks") {
      detailRef.current?.showModal();
      if (createOpen) document.getElementById("edit-title")?.focus();
      if (resumeDetail.current) {
        document.getElementById("open-customizations")?.focus();
        resumeDetail.current = false;
      }
    }
    else {
      detailRef.current?.close();
      if (destination === "tasks" && returnFocus.current) {
        const opening = returnFocus.current;
        const row = opening.id ? document.getElementById(opening.id) : null;
        const fallback = returnToSearch.current ? searchHeading.current : null;
        (opening.isConnected ? opening : row ?? fallback ?? document.getElementById("tasks-heading"))?.focus();
        returnFocus.current = null;
      }
    }
  }, [detail?.id, createOpen, destination]);
  useLayoutEffect(() => {
    const previous = removedRecoveryFocus.current;
    removedRecoveryFocus.current = null;
    if (previous && !previous.isConnected && createVisible.current && detailRef.current?.open
      && (document.activeElement === document.body || document.activeElement === detailRef.current)) createConfirmation.current?.focus();
  }, [createAttempt, createFormNotice]);
  async function action<T>(
    operation: () => Promise<T>,
    success: (data: T) => void,
  ) {
    if (busy) return;
    const current = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await operation();
      if (!lifetime.current.signal.aborted && current === generation.current)
        success(data);
    } catch (error) {
      if (current === generation.current) handleError(error);
    } finally {
      if (!lifetime.current.signal.aborted && current === generation.current) setBusy(false);
    }
  }
  function saveProject(event: FormEvent) {
    event.preventDefault();
    action(
      () =>
        request<Project>(
          rename ? `projects/${projectId}` : "projects",
          rename ? "PATCH" : "POST",
          rename ? { name: projectName } : { name: projectName, mode: projectMode },
        ),
      (saved) => {
        setProjects((old) =>
          rename
            ? old.map((item) => (item.id === saved.id ? saved : item))
            : [...old, saved],
        );
        projectsRef.current = rename ? projectsRef.current.map(item => item.id === saved.id ? saved : item) : [...projectsRef.current, saved];
        selectProject(saved.id);
        setProjectName("");
        setNewProject(false);
        setProjectMode("PERSONAL");
        setRename(false);
        setNotice("Project saved.");
        requestAnimationFrame(() => document.getElementById("tasks-heading")?.focus());
      },
    );
  }
  function addTask(event: FormEvent) {
    event.preventDefault();
    try { void createTask(draftDueAt(createDraft)); }
    catch (failure) {
      openCreate();
      setCreateError((failure as Error).message);
    }
  }
  function changeCreateDraft(next: TaskDraft) {
    createVersion.current++;
    createDraftRef.current = next;
    setCreateDraft(next);
    const attempt = createAttemptRef.current;
    if (attempt?.body.projectId === projectId) createRecovery.set(session.user.id, { attempt, draft: next, version: createVersion.current });
  }
  function retainCreate(attempt: CreateAttempt | null) {
    createAttemptRef.current = attempt;
    setCreateAttempt(attempt);
    if (attempt) createRecovery.set(session.user.id, { attempt, draft: createDraftRef.current, version: createVersion.current });
    else createRecovery.delete(session.user.id);
  }
  function openCreate() {
    if (detailVisible.current) return;
    if (!createVisible.current) {
      createInstance.current++;
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      returnToSearch.current = false;
    }
    setCreateOpen(true);
  }
  function closeCreate() {
    createVersion.current++;
    createInstance.current++;
    if (createAttemptRef.current?.body.projectId === projectId) retainCreate(createAttemptRef.current);
    setCreateOpen(false);
  }
  async function createTask(dueAt?: string | null) {
    if (busy || createPending.current || createAttemptRef.current) return;
    let body: CreateBody;
    try {
      const title = createDraft.title.trim(), notes = createDraft.notes;
      if (!title || title.length > 120) throw new Error("Task title must be 1–120 characters.");
      if (notes.length > 4000) throw new Error("Notes must be 0–4000 characters.");
      body = { projectId, title, notes, tags: normalizeTaskTags(createDraft.tags.trim() ? createDraft.tags.split(",") : []),
        priority: createDraft.priority, dueAt: dueAt ?? null };
    } catch (failure) {
      setCreateError((failure as Error).message);
      openCreate();
      return;
    }
    const attempt = { operationId: crypto.randomUUID(), body, draftVersion: createVersion.current, checked: false, suspended: false };
    retainCreate(attempt);
    await sendCreate(attempt);
  }
  async function confirmedCreate(attempt: CreateAttempt, saved: Task, current: number) {
    const newerDraftOpen = createVisible.current && attempt.draftVersion !== createVersion.current;
    const focused = document.activeElement;
    if (newerDraftOpen && focused instanceof HTMLElement && createRecoveryControls.current?.contains(focused)) removedRecoveryFocus.current = focused;
    setCreateFormNotice(newerDraftOpen ? "The original task was added. Your newer changes are still here." : "");
    retainCreate(null);
    setCreateError("");
    if (attempt.draftVersion === createVersion.current) {
      createVersion.current++;
      const next = newTaskDraft();
      createDraftRef.current = next;
      setCreateDraft(next);
      setCreateOpen(false);
    }
    setCreateNotice("The original save was confirmed.");
    try {
      const next = await request<Task[]>(`projects/${attempt.body.projectId}/tasks`);
      if (lifetime.current.signal.aborted || current !== generation.current) return;
      setTasks(next);
      refreshSearch();
      setCreateNotice(next.some(task => task.id === saved.id) ? "Task added." : "The original save was confirmed. This task is no longer available in this project.");
    } catch (failure) {
      if (lifetime.current.signal.aborted || current !== generation.current) return;
      if (failure instanceof ApiError && failure.status === 401) { expired(); return; }
      setCreateNotice("The original save was confirmed, but the current task list could not be refreshed.");
    }
  }
  async function sendCreate(attempt: CreateAttempt) {
    if (busy || createPending.current || attempt.body.projectId !== projectId) return;
    createPending.current = true;
    const current = generation.current;
    const instance = createInstance.current;
    retainCreate({ ...attempt, checked: false });
    setCreateActivity("adding");
    setBusy(true);
    setCreateError("");
    setCreateNotice("");
    setCreateFormNotice("");
    setNotice("");
    try {
      const saved = await request<unknown>("tasks", "POST", attempt.body, lifetime.current.signal, attempt.operationId);
      if (lifetime.current.signal.aborted || current !== generation.current) return;
      if (!isTask(saved) || saved.projectId !== attempt.body.projectId) throw new Error("Unconfirmed task response");
      await confirmedCreate(attempt, saved, current);
    } catch (failure) {
      if (lifetime.current.signal.aborted || current !== generation.current || (failure as Error).name === "AbortError") return;
      if (failure instanceof ApiError && failure.createResult) {
        retainCreate(null);
        setCreateError("Not added. " + (failure.createResult.message.trim() ? failure.createResult.message : "Your entries are still here."));
      } else {
        retainCreate({ ...attempt, checked: false, suspended: failure instanceof ApiError && [401, 403, 404].includes(failure.status) });
        setCreateError(createUncertain);
        if (failure instanceof ApiError && failure.status === 401) { expired(); return; }
      }
      if (instance === createInstance.current || createVisible.current) openCreate();
    } finally {
      createPending.current = false;
      if (!lifetime.current.signal.aborted) { setBusy(false); setCreateActivity(null); }
    }
  }
  async function checkCreate() {
    const attempt = createAttemptRef.current;
    if (!attempt || attempt.body.projectId !== projectId || busy || createPending.current) return;
    createPending.current = true;
    const current = generation.current;
    setCreateActivity("checking");
    setBusy(true);
    try {
      const result = createResult(await request<unknown>(`task-create-operations/${attempt.operationId}`), attempt.operationId);
      if (lifetime.current.signal.aborted || current !== generation.current) return;
      if (!result || result.state === "CREATED" && result.task.projectId !== attempt.body.projectId) throw new Error("Unconfirmed task result");
      if (result.state === "CREATED") await confirmedCreate(attempt, result.task, current);
      else if (result.state === "NOT_CREATED") {
        retainCreate(null);
        setCreateError("Not added. " + (result.message.trim() ? result.message : "Your entries are still here."));
      } else {
        retainCreate({ ...attempt, checked: true, suspended: false });
        setCreateError(createUncertain);
      }
    } catch (failure) {
      if (lifetime.current.signal.aborted || current !== generation.current) return;
      const accessRejected = failure instanceof ApiError && [401, 403, 404].includes(failure.status);
      retainCreate({ ...attempt, checked: false, suspended: accessRejected });
      setCreateError(accessRejected ? "This task addition could not be checked with your current access. Your entries are kept." : createUncertain);
      if (failure instanceof ApiError && failure.status === 401) expired();
    } finally {
      createPending.current = false;
      if (!lifetime.current.signal.aborted) { setBusy(false); setCreateActivity(null); }
    }
  }
  function canComplete(task: Task) {
    return !task.creatorId || project?.role === "ADMIN" || (task.assigneeId ?? task.creatorId) === session.user.id;
  }
  function complete(task: Task) {
    if (busy) return;
    const instance = detailInstance.current;
    setCreateNotice(previous => previous === "Task added." ? "" : previous);
    setCompletionHold(previous => previous?.taskId === task.id ? null : previous);
    action(
      async () => {
        try { return { saved: await request<Task>(`tasks/${task.id}/complete`, "POST", {}) }; }
        catch (failure) {
          if (lifetime.current.signal.aborted) throw failure;
          // This endpoint's 422 is the native Team gate's rule denial, not an unavailable check.
          if (failure instanceof ApiError && failure.status === 422) return { hold: failure.message };
          const saved = await request<Task>(`tasks/${task.id}`);
          if (saved.status === "completed") return { saved };
          throw failure;
        }
      },
      ({ saved, hold }) => {
        if (!saved) {
          setCompletionHold({ taskId: task.id, message: hold });
          setNotice(`${task.title} stayed open on the last attempt. ${hold}`);
          return;
        }
         updateTask(saved);
         if (detail?.id === saved.id && detailInstance.current === instance) setDetail(saved);
         setNotice(`${saved.title} completed.`);
        setRecentCompletion(saved.id);
      },
    );
  }
  function closeDetail() {
    detailInstance.current++;
    setDetail(null);
  }
  function openCreatedTask(task: Task) {
    studioEntrySerial.current++;
    currentStudioEntry.current = null;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    returnToSearch.current = !!search;
    detailInstance.current++; setDestination("tasks");
    if (task.projectId !== projectId) { selectProject(task.projectId); pendingTaskOpen.current = { task, navigation: studioEntrySerial.current }; }
    else { setDraft(taskDraft(task)); setDetail(task); }
  }
  async function refreshCreatedTasks(created: Task) {
    const current = generation.current;
    if (created.projectId !== projectId) return;
    const next = await request<Task[]>(`projects/${projectId}/tasks`);
    if (current === generation.current && !lifetime.current.signal.aborted) {
      setTasks(next);
      refreshSearch();
    }
  }
  const open = tasks.filter((task) => task.status === "open");
  const completed = tasks.filter((task) => task.status === "completed");
  function taskRow(task: Task) {
    return (
      <li key={task.id} className={`task-row ${task.status}`}>
        <button
          className="completion"
          aria-label={
            task.status === "completed"
              ? `${task.title}, completed`
              : `Complete ${task.title}`
          }
          disabled={busy || task.status === "completed" || !canComplete(task)}
          onClick={() => complete(task)}
        >
          <span aria-hidden="true">✓</span>
        </button>
        <div className="task-row-content"><button
          id={"task-open-" + task.id}
          className="task-open"
          onClick={(event) => {
            returnFocus.current = event.currentTarget;
            returnToSearch.current = !!search;
            detailInstance.current++;
            setDraft(taskDraft(task));
            setDetail(task);
          }}
        >
          <span>{task.title}</span>
          {task.notes && <small>{task.notes}</small>}
          <span className="task-chevron" aria-hidden="true">›</span>
        </button>
        {task.assigneeName && <small className="task-assignee">Assigned to {task.assigneeName}{task.assigneeId === session.user.id && " (you)"}</small>}
        {task.status === "open" && completionHold?.taskId === task.id && <p className="task-completion-hold">
          <strong>This task stayed open.</strong> The rule said: “{completionHold.message}”
        </p>}
        {(task.priority === "high" || task.priority === "low" || task.dueAt) && <small className="muted">
          {task.priority === "high" ? "High priority" : task.priority === "low" ? "Low priority" : ""}
          {(task.priority === "high" || task.priority === "low") && task.dueAt && " · "}
          {task.dueAt && <time dateTime={task.dueAt}>Due {formatDueTime(task.dueAt)}</time>}
        </small>}
        {recentCompletion === task.id && detail?.id !== task.id && <TaskReaction source={task} request={studioRequest} confirmed={refreshCreatedTasks} openCreated={openCreatedTask} creation={!!task.creatorId} />}
        </div>
      </li>
    );
  }
  const projectOptions = (showType = false) => (["PERSONAL", "TEAM"] as const).map(mode => {
    const group = projects.filter(item => (item.mode === "TEAM" ? "TEAM" : "PERSONAL") === mode);
    const label = mode === "TEAM" ? "Team" : "Personal";
    return group.length > 0 && <optgroup key={mode} label={`${label} projects`}>
      {group.map(item => <option key={item.id} value={item.id}>{item.name}{showType ? ` · ${label}` : ""}</option>)}
    </optgroup>;
  });
  function startProject() {
    setNewProject(true); setRename(false); setProjectName(""); setProjectMode("PERSONAL");
  }
  const scopeControl = <div className="customization-scope">
    <label htmlFor="customization-project">Personal or Team project</label>
    <div className="form-line">
      <select id="customization-project" value={projectId} onChange={event => {
        const selected = projects.find(item => item.id === event.target.value);
        if (!selected) return;
        selectProject(selected.id); setDestination("customizations"); currentStudioEntry.current = null;
        history.pushState(null, "", location.pathname + location.search + (selected.mode === "TEAM"
          ? "#teamProject=" + encodeURIComponent(selected.id) : "#personal=1"));
      }}>
        {projectOptions(true)}
      </select>
      {project?.mode !== "TEAM" && personalReturn.current && <button className="quiet-button" onClick={() => {
        rememberStudio(personalReturn.current!); setDestination("studio");
      }}>Return to Personal Studio</button>}
    </div>
    {project?.mode !== "TEAM" && <p className="muted">Personal customizations belong to you across your Personal projects.</p>}
  </div>;
  return (
    <div className="workspace">
      <div className="workspace-body">
        <header className="workspace-top">
          <Brand />
          <nav className="destinations" aria-label="Main navigation">
            <button aria-current={destination === "tasks" ? "page" : undefined} onClick={() => navigate("tasks")}>Tasks</button>
            <button aria-current={destination !== "tasks" ? "page" : undefined} onClick={() => navigate("customizations")}>Customizations</button>
          </nav>
          <details className="user-tools tool-menu" onKeyDown={dismissTool}>
            <summary>{session.user.name}<span aria-hidden="true">⌄</span></summary>
            <div className="tool-menu-content">
            <div className="person-choices" role="group" aria-label="Demo person">
              {users.map((user) => (
                <button key={user.id} value={user.id} aria-pressed={user.id === session.user.id}
                  onClick={event => {
                    const menu = event.currentTarget.closest("details");
                    menu?.removeAttribute("open");
                    if (user.id !== session.user.id) switchUser(user.id);
                    else menu?.querySelector("summary")?.focus();
                  }}>
                  {user.name}
                  {user.id === session.user.id && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
            <button className="quiet-button" onClick={signOut}>
              Sign out
            </button>
            </div>
          </details>
        </header>
          <main ref={taskScroller} className="task-main" hidden={destination !== "tasks"} aria-labelledby="tasks-heading" tabIndex={0}
            onScroll={event => { if (destination === "tasks" && event.currentTarget.clientHeight) taskScroll.current = event.currentTarget.scrollTop; }}>
          <div className="task-page-heading">
          <div className="project-title">
            <div className="project-name">
              {project && <span className="project-type">{project.mode === "TEAM" ? "Team project" : "Personal project"}</span>}
              <h1 id="tasks-heading" tabIndex={-1}>{project?.name ?? "Tasks"}</h1>
            </div>
          {project?.mode === "TEAM" && project.role !== "ADMIN" ? <button className="quiet-button" onClick={() => setMembersOpen(true)}>View members</button>
            : project && <details className="tool-menu project-tools" onKeyDown={dismissTool}>
            <summary>Project settings <span aria-hidden="true">⌄</span></summary>
            <div className="tool-menu-content">
            {project?.mode === "TEAM" && <button className="quiet-button" onClick={event => {
              const menu = event.currentTarget.closest("details");
              menu?.removeAttribute("open"); menu?.querySelector("summary")?.focus(); setMembersOpen(true);
             }}>Manage members</button>}
            {project && (project.mode !== "TEAM" || project.role === "ADMIN") && (
              <button
                className="quiet-button"
                onClick={event => {
                  event.currentTarget.closest("details")?.removeAttribute("open");
                  setProjectName(project.name);
                  setRename(true);
                  setNewProject(false);
                }}
              >
                Rename project
              </button>
            )}
            </div>
          </details>}
          </div>
          </div>
          <div className="task-layout">
          <aside className="task-projects" aria-label="Project context">
          <nav className="project-list" aria-label="Projects">
            {(["PERSONAL", "TEAM"] as const).map(mode => {
              const group = projects.filter(item => (item.mode === "TEAM" ? "TEAM" : "PERSONAL") === mode);
              const label = mode === "TEAM" ? "Team projects" : "Personal projects";
              return group.length > 0 && <div key={mode} role="group" aria-label={label}>
                <p className="project-group-label" aria-hidden="true">{label}</p>
                {group.map(item => <button key={item.id} aria-current={destination === "tasks" && item.id === projectId ? "true" : undefined}
                  className={`project-link${destination === "tasks" && item.id === projectId ? " selected" : ""}`}
                  onClick={() => { selectProject(item.id); navigate("tasks"); }}>{item.name}</button>)}
              </div>;
            })}
          </nav>
          {project && <div className="mobile-projects">
            <label className="sr-only" htmlFor="project-select">Project</label>
            <select id="project-select" value={projectId} onChange={(event) => { selectProject(event.target.value); navigate("tasks"); }}>
              {projectOptions()}
            </select>
          </div>}
          <button id="new-project" className="quiet-button project-create" disabled={!projectsReady} onClick={startProject}>New project</button>
          </aside>
          <div className="project-work">
          {(newProject || rename) && (
            <form className="project-form project-editor" onSubmit={saveProject}>
              <h2>{rename ? "Rename project" : "New project"}</h2>
              <label htmlFor="project-name">
                {rename ? "Project name" : "New project name"}
              </label>
                <input
                  autoFocus
                  id="project-name"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  required
                  maxLength={80}
                  placeholder="Name this project"
                />
              {newProject && <div>
                <label htmlFor="project-mode">Who is this for?</label>
                <select id="project-mode" value={projectMode} onChange={event => setProjectMode(event.target.value as "PERSONAL" | "TEAM")}>
                  <option value="PERSONAL">Personal · only you</option><option value="TEAM">Team · shared tasks</option>
                </select>{projectMode === "TEAM" && <p className="muted">You can invite teammates after creating the project.</p>}
              </div>}
              <div className="form-line">
                <button className="primary" disabled={busy}>
                  Save project
                </button>
                <button
                  type="button"
                  className="quiet-button"
                   onClick={() => {
                     (newProject ? document.getElementById("new-project") : document.querySelector<HTMLElement>(".project-tools > summary"))?.focus();
                     setNewProject(false);
                    setRename(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
          <section className="task-surface" aria-label="Project tasks">
          {error && (
            <div className="error" role="alert">
              {error}
              <button
                className="quiet-button"
                onClick={() => location.reload()}
              >
                Reload
              </button>
            </div>
          )}
          <div className="sr-only" role="status">
            {notice}
          </div>
          {project && (
            <form className="quick-add" onSubmit={addTask}>
              <label className="sr-only" htmlFor="new-task">
                New task title
              </label>
              <input
                id="new-task"
                value={createDraft.title}
                onChange={(event) => changeCreateDraft({ ...createDraft, title: event.target.value })}
                required
                maxLength={120}
                 placeholder="New task title"
              />
              <button type="button" className="quiet-button" onClick={openCreate} disabled={loading}>Details</button>
              <button className="primary" disabled={busy || loading || !!createAttempt}>
                Add task <span aria-hidden="true">↵</span>
              </button>
            </form>
          )}
          {createNotice && <p className="task-create-notice" role="status">{createNotice}</p>}
          {project && (
            <form className="task-search-form" onSubmit={event => {
              event.preventDefault();
              setCreateNotice(previous => previous === "Task added." ? "" : previous);
              closeTaskFilter(event.currentTarget);
              const next = { q: filters.q.trim(), tag: filters.tag.trim() };
              if (next.q || next.tag) void fetchSearch(next, "submit");
            }}>
              <label>
                 <span className="sr-only">Search tasks</span>
                <input id="task-search-text" type="search" value={filters.q} maxLength={120} placeholder="Find a task…"
                  onChange={event => {
                    setCreateNotice(previous => previous === "Task added." ? "" : previous);
                    const q = event.target.value;
                    if (!q && !filters.tag && search) resetSearch();
                    else setFilters({ ...filters, q });
                  }} />
              </label>
              <details className="tool-menu task-filter" onKeyDown={dismissTool}>
              <summary onClick={() => setCreateNotice(previous => previous === "Task added." ? "" : previous)}>Filter <span aria-hidden="true">⌄</span>{filters.tag && <span className="sr-only">Tag filter entered</span>}</summary>
              <div className="tool-menu-content">
              <label>
                Filter by tag
                <input type="text" value={filters.tag}
                  placeholder="Enter an exact tag" onChange={event => setFilters({ ...filters, tag: event.target.value })} />
              </label>
              </div>
              </details>
              <div className="task-search-actions">
                <button className="quiet-button" aria-label="Search" disabled={!filters.q.trim() && !filters.tag.trim()}><span aria-hidden="true">⌕</span></button>
                {search && <button type="button" className="quiet-button" aria-label="Clear"
                  onClick={event => { closeTaskFilter(event.currentTarget.form); resetSearch(); document.getElementById("task-search-text")?.focus(); }}>
                  <span aria-hidden="true">×</span>
                </button>}
              </div>
              {search && appliedFilters.current?.tag && <p className="task-applied-filters">Tagged “{appliedFilters.current.tag}”</p>}
            </form>
          )}
           <div className="task-content" role="region" aria-label="Task list">
          {search && project ? (
            <section className="task-search-results" aria-labelledby="task-search-heading">
              <div className="list-heading">
                <h2 id="task-search-heading" ref={searchHeading} tabIndex={-1}>Search results</h2>
              </div>
              {search.items.length > 0 && <ul className="task-list">{search.items.map(taskRow)}</ul>}
              <p className="task-search-status" role="status">
                {search.pending ? "Searching tasks…" : search.items.length ? `${search.items.length} ${search.items.length === 1 ? "task" : "tasks"} shown.` : !search.failure ? "No tasks match your search." : ""}
              </p>
              {!search.pending && search.failure && <p className="error" role="alert">{search.failure.message}</p>}
              {(search.failure || search.nextAfter !== null) && (
                <button type="button" className="quiet-button" aria-disabled={search.pending} onClick={() => {
                  if (search.pending || !appliedFilters.current) return;
                  const after = search.failure ? search.failure.after : search.nextAfter;
                  void fetchSearch(appliedFilters.current, after === null ? "refresh" : "more", after);
                }}>{search.failure ? "Retry" : "Load more"}</button>
              )}
            </section>
          ) : loading ? (
            <div className="loading" role="status">
              <span className="loading-line" />
              Gathering your tasks…
            </div>
          ) : project ? (
            <>
              <div className="list-heading">
                <h2>
                   Open tasks <span>{open.length}</span>
                </h2>
              </div>
              {open.length ? (
                <ul className="task-list">{open.map(taskRow)}</ul>
              ) : (
                <div className="empty">
                   <p>{completed.length ? "All tasks in this project are complete." : "No tasks yet. Add the first one above."}</p>
                </div>
              )}
              {completed.length > 0 && (
                <section className="completed-section">
                  <h2>
                     Completed <span>{completed.length}</span>
                  </h2>
                  <ul className="task-list">{completed.map(taskRow)}</ul>
                </section>
              )}
            </>
          ) : (
            <div className="empty">
               <p>{projectsReady ? "Create a project to start adding tasks." : "Loading projects…"}</p>
            </div>
          )}
          </div>
          </section>
          </div>
          </div>
        </main>
        {destination === "customizations" && (!projectsReady ? <CustomizationsPage><p role="status">Checking project access…</p></CustomizationsPage>
          : unavailableTeam ? <CustomizationsPage scopeControl={scopeControl}><p role="alert">That Team project is not available. Choose an accessible scope.</p></CustomizationsPage>
          : project?.mode === "TEAM" ? <TeamCustomizations key={session.contextToken + project.id} project={project}
            request={studioRequest} scopeControl={scopeControl} open={() => { studioEntrySerial.current++; setDestination("studio"); }} />
          : <Customizations key="personal" request={studioRequest} changed={reconcileSelection} beforeSelectionChange={beforeSelectionChange} open={target => void openStudio("overview", target)} projects={projects.filter(item => item.mode !== "TEAM")} focusAction={destinationFocus.current ?? ""} notice={customizationNotice} scopeControl={scopeControl} />)}
        {destination === "studio" && projectsReady && project?.mode === "TEAM" && !unavailableTeam &&
          <main className="studio-main"><TeamCapability key={session.contextToken + project.id}
             project={project} request={studioRequest} scopeControl={scopeControl} back={() => navigate("customizations")} backToTasks={() => navigate("tasks")}
            operationScope={session.draftScope ? session.user.id + ":" + session.draftScope : null} /></main>}
        {destination === "studio" && projectsReady && project?.mode !== "TEAM" && !unavailableTeam && <main className="studio-main"><Studio key={studioTarget.entryId} request={studioRequest} changed={reconcileSelection} beforeSelectionChange={beforeSelectionChange}
          target={studioTarget} ownerId={session.user.id} draftScope={session.draftScope ?? null} drafts={studioDrafts.current} recoveryKey={"daymark-studio-work:" + session.user.id + ":" + studioTarget.entryId} projects={projects.filter(item => item.mode !== "TEAM")}
          targeted={next => { if (currentStudioEntry.current === studioTarget.entryId && !lifetime.current.signal.aborted) rememberStudio({ ...next, entryId: studioTarget.entryId }); }}
          openCustomization={next => { if (currentStudioEntry.current === studioTarget.entryId && !lifetime.current.signal.aborted) void openStudio("overview", next); }}
          unavailable={() => { if (currentStudioEntry.current !== studioTarget.entryId || lifetime.current.signal.aborted) return; currentStudioEntry.current = null; setCustomizationNotice("That customization or conversation is unavailable. Choose a saved item or start a new one."); setDestination("customizations"); }} task={studioOrigin === "detail" && detail ? { title: detail.title, status: detail.status } : undefined}
          back={returnFromStudio} backToTasks={returnToTasks} createNew={() => void openStudio("overview", { extensionId: null })} backLabel={studioOrigin === "detail" ? "Back to my task" : "Back to Customizations"} /></main>}
      </div>
      <dialog
        ref={detailRef}
        className="detail"
        aria-labelledby="detail-title"
        onCancel={(event) => {
          event.preventDefault();
          if (createOpen) closeCreate(); else closeDetail();
        }}
        onClose={() => {
          if (detailVisible.current && !detailRef.current?.open) closeDetail();
          if (createVisible.current && !detailRef.current?.open) closeCreate();
        }}
      >
        {createOpen && <TaskForm draft={createDraft} setDraft={changeCreateDraft} busy={busy} error={createError} submitBlocked={!!createAttempt}
          closeLabel={createAttempt ? "Close" : "Cancel"}
          closeNotice={createAttempt ? createActivity === "adding" ? "Adding… Closing this form won't stop the save." : "Closing this form won't stop the original save if it is still running." : undefined}
          recovery={<>
            {createFormNotice && <p ref={createConfirmation} className="task-create-notice" role="status" tabIndex={-1}>{createFormNotice}</p>}
            {createAttempt && <div ref={createRecoveryControls} className="task-create-recovery">
            {createAttempt.body.projectId !== projectId
              ? <><p>A task addition in another project still needs checking.</p>
                <button type="button" className="quiet-button" disabled={busy || !projects.some(project => project.id === createAttempt.body.projectId)}
                  onClick={() => selectProject(createAttempt.body.projectId)}>Return to that project</button></>
              : <><p>Original task title: {createAttempt.body.title}</p>
                <p>{createAttempt.suspended ? "Checking is suspended until access is available." : "Checking or retrying uses the original submitted details. Your current edits stay here."}</p>
                <div><button type="button" className="quiet-button" aria-disabled={busy} onClick={() => void checkCreate()}>Check result</button>
                  {createAttempt.checked && !createAttempt.suspended && <button type="button" className="quiet-button" aria-disabled={busy}
                    onClick={() => void sendCreate(createAttempt)}>Retry same attempt</button>}</div></>}
          </div>}</>}
          close={closeCreate} save={dueAt => void createTask(dueAt)} />}
        {detail && (
          <TaskDetail
            key={detail.id}
            task={detail}
            draft={draft}
            setDraft={next => { draftVersion.current++; setDraft(next); }}
            manage={() => void openStudio("detail")}
             busy={busy}
             complete={canComplete(detail) ? () => complete(detail) : undefined}
             error={error}
             hold={detail.status === "open" && completionHold?.taskId === detail.id ? completionHold.message : undefined}
            close={closeDetail}
            reactionRequest={studioRequest}
            visible={destination === "tasks"}
            reactionConfirmed={refreshCreatedTasks}
            openCreated={openCreatedTask}
            save={(dueAt) => {
              const instance = detailInstance.current;
              const version = draftVersion.current;
              const previous = taskDraft(detail, draft.dueZone);
              const textChanged = draft.title !== previous.title || draft.notes !== previous.notes;
              const tagsChanged = draft.tags !== previous.tags;
              const priorityChanged = draft.priority !== previous.priority;
              const dueAtChanged = dueAt !== undefined && dueAt !== (detail.dueAt ?? null);
              const body = {
                ...(textChanged || !tagsChanged && !priorityChanged && !dueAtChanged ? { title: draft.title, notes: draft.notes } : {}),
                ...(tagsChanged ? { tags: draft.tags.trim() ? draft.tags.split(",") : [] } : {}),
                ...(priorityChanged ? { priority: draft.priority } : {}),
                ...(dueAtChanged ? { dueAt } : {}),
              };
              action(
                () =>
                  request<Task>(`tasks/${detail.id}`, "PATCH", body),
                (saved) => {
                  updateTask(saved);
                  if (instance === detailInstance.current) {
                    if (version === draftVersion.current) closeDetail();
                    else {
                      const confirmed = taskDraft(saved, draft.dueZone);
                      setDetail(saved);
                      setDraft(current => {
                        const keepDueTime = current.dueTime !== draft.dueTime || current.dueTimeEdited !== draft.dueTimeEdited;
                        return {
                          title: current.title === draft.title ? confirmed.title : current.title,
                          notes: current.notes === draft.notes ? confirmed.notes : current.notes,
                          tags: current.tags === draft.tags ? confirmed.tags : current.tags,
                          priority: current.priority === draft.priority ? confirmed.priority : current.priority,
                          dueTime: keepDueTime ? current.dueTime : confirmed.dueTime,
                          dueZone: current.dueZone,
                          dueTimeEdited: keepDueTime && current.dueTimeEdited,
                        };
                      });
                    }
                  }
                  setNotice("Task saved.");
                },
              );
            }}
          />
        )}
      </dialog>
      {membersOpen && project?.mode === "TEAM" && <TeamMembers key={session.contextToken + project.id}
        project={project} users={users} request={studioRequest} close={() => setMembersOpen(false)} />}
    </div>
  );
}

function TeamCustomizations({ project, request, scopeControl, open }: {
  project: Project; request: Parameters<typeof TeamMembers>[0]["request"]; scopeControl: ReactNode; open: () => void;
}) {
  const [access, setAccess] = useState<"ADMIN" | "MEMBER" | "unavailable" | null>(null);
  const [saved, setSaved] = useState<{ draft: boolean; discussion: boolean; inUse: boolean | null } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let controller: AbortController;
    const refresh = () => {
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;
      setAccess(null); setSaved(null);
      void request<Members>(`projects/${project.id}/members`, "GET", undefined, signal).then(async ({ project: current }) => {
        if (signal.aborted) return;
        if (current.id !== project.id || current.mode !== "TEAM" || !["ADMIN", "MEMBER"].includes(current.role ?? "")) return setAccess("unavailable");
        if (current.role === "MEMBER") return setAccess("MEMBER");
        const [state, thread] = await Promise.all([
          request<{ draft: unknown; selection: { available: boolean; revisionId: string | null } }>(`projects/${project.id}/capability`, "GET", undefined, signal),
          request<{ conversation: unknown }>(`projects/${project.id}/authoring`, "GET", undefined, signal),
        ]);
        if (signal.aborted) return;
        setSaved({ draft: !!state.draft, discussion: !!thread.conversation, inUse: state.selection.available ? !!state.selection.revisionId : null });
        setAccess("ADMIN");
      }).catch(() => { if (!signal.aborted) setAccess("unavailable"); });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.removeEventListener("focus", refresh); };
  }, [project.id, retry]);
  const empty = saved?.inUse === false && !saved.draft && !saved.discussion;
  return <CustomizationsPage scopeControl={scopeControl}
    action={access === "ADMIN" && <button className="primary customization-start" onClick={open}>{empty ? "New customization" : "Open Studio"}</button>}>
    <section className="customization-list" aria-label="Team customization access">
      {access === "unavailable" ? <p className="customization-empty" role="alert">This Team project could not be accessed.{" "}
        <button className="quiet-button" onClick={() => setRetry(value => value + 1)}>Check access again</button></p>
        : <div className="customization-empty" role="status">{access === "ADMIN" ? <>
          <h2>{empty ? "No Team customizations yet" : saved?.inUse ? "A customization is on" : saved?.inUse === null ? "Couldn’t check what’s on" : "No customization is on"}</h2>
          <p>{empty ? `Start one to change how tasks work in ${project.name}.` : `Open Studio to review or continue saved work in ${project.name}.`}</p>
          <p>A customization that’s on can affect everyone’s new tasks in this project.</p>
        </> : access === "MEMBER" ? <><h2>Team customizations</h2><p>Only project admins can open Studio and see or change this project’s customization. You can still work on Team tasks.</p></>
            : <p>Checking project access…</p>}</div>}
    </section>
  </CustomizationsPage>;
}

function TeamMembers({ project, users, request, close }: {
  project: Project; users: User[]; close: () => void;
  request: <T>(path: string, method?: string, body?: object, signal?: AbortSignal) => Promise<T>;
}) {
  const [state, setState] = useState<Members | null>(null);
  const [error, setError] = useState("");
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const lifetime = useRef(new AbortController());
  const dialog = useRef<HTMLDialogElement>(null);
  const serial = useRef(0);
  async function refresh() {
    const turn = ++serial.current;
    setState(null); setError("");
    try {
      const next = await request<Members>(`projects/${project.id}/members`, "GET", undefined, lifetime.current.signal);
      if (lifetime.current.signal.aborted || turn !== serial.current) return;
      if (next.project.id !== project.id || next.project.mode !== "TEAM" || !["ADMIN", "MEMBER"].includes(next.project.role ?? ""))
        throw new Error("Unconfirmed Team scope");
      setState(next);
    } catch {
      if (!lifetime.current.signal.aborted && turn === serial.current) setError("This Team project could not be accessed. No Personal content is shown here.");
    }
  }
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    void refresh();
    const focus = () => { if (!dialog.current || dialog.current.open) void refresh(); };
    window.addEventListener("focus", focus);
    return () => {
      lifetime.current.abort(); serial.current++;
      window.removeEventListener("focus", focus);
      dialog.current?.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, [project.id]);
  async function add(event: FormEvent) {
    event.preventDefault();
    if (busy || !userId) return;
    const turn = ++serial.current;
    setBusy(true); setError("");
    try {
      const next = await request<Members>(`projects/${project.id}/members`, "POST", { userId }, lifetime.current.signal);
      if (lifetime.current.signal.aborted || turn !== serial.current) return;
      if (next.project.id !== project.id || next.project.role !== "ADMIN") throw new Error("Team authority changed");
      setState(next); setUserId("");
    } catch {
      if (!lifetime.current.signal.aborted && turn === serial.current) { setState(null); setError("The member was not confirmed. Refresh current access before trying again."); }
    } finally { if (!lifetime.current.signal.aborted) setBusy(false); }
  }
  return <dialog ref={dialog} className="detail team-members" aria-labelledby="team-members-title"
    onCancel={event => { event.preventDefault(); close(); }} onClose={close}>
    <div className="detail-heading"><h2 id="team-members-title">{project.name} · Team</h2>
      <button type="button" className="icon-button" aria-label="Close members" onClick={close}>×</button></div>
    <div className="member-content">{error ? <p className="error" role="alert">{error}</p> : !state ? <p role="status">Checking current membership…</p> : <>
      <ul>{state.members.map(member => <li key={member.id}>{member.name} · {member.role === "ADMIN" ? "Admin" : "Member"}</li>)}</ul>
      {state.project.role === "ADMIN" && <form onSubmit={add}>
        <label htmlFor="existing-member">Teammate</label>
        <select id="existing-member" value={userId} onChange={event => setUserId(event.target.value)} required>
          <option value="">Choose a person</option>
          {users.filter(user => !state.members.some(member => member.id === user.id)).map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
        </select><button className="primary" disabled={busy || !userId}>Add member</button>
      </form>}
      {state.project.role === "MEMBER" && <p className="muted">Only a project admin can add members or manage Team capabilities.</p>}
    </>}</div>
    <div className="detail-actions">{error && <button type="button" className="quiet-button" disabled={busy} onClick={() => void refresh()}>Check access again</button>}
      <button type="button" className="quiet-button" onClick={close}>Done</button></div>
  </dialog>;
}

function TaskReaction({ source, request, confirmed, openCreated, creation = false, bound }: {
  source: Task;
  request: <T>(path: string, method?: string, body?: object, signal?: AbortSignal) => Promise<T>;
  confirmed: (created: Task) => Promise<void>;
  openCreated: (created: Task) => void;
  creation?: boolean;
  bound?: (bound: boolean) => void;
}) {
  const [reaction, setReaction] = useState<Reaction | null>(null);
  const [created, setCreated] = useState<Task | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false), locked = useRef(false), serial = useRef(0), reads = useRef(0);
  const lifetime = useRef(new AbortController()), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announced = useRef<string | null>(null);
  const callbacks = useRef({ request, confirmed, bound }); callbacks.current = { request, confirmed, bound };
  async function read(reconcile = false, automatic = false) {
    if (!mounted.current || locked.current) return;
    if (!automatic) reads.current = 0;
    clearTimeout(timer.current); locked.current = true; const turn = ++serial.current;
    setChecking(true); setCreated(null);
    if (!creation || reaction) setError("");
    try {
      const next = await callbacks.current.request<Reaction>("tasks/" + encodeURIComponent(source.id) + "/reaction" + (reconcile ? "/reconcile" : "")
        + (creation ? "?trigger=TaskCreated" : ""), reconcile ? "POST" : "GET", reconcile ? {} : undefined, lifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      if (!["NO_BINDING", "PENDING", "STARTED", "FINISHED"].includes(next.state)) throw new Error("Unconfirmed reaction response");
      setError(""); setReaction(next);
      callbacks.current.bound?.(next.state !== "NO_BINDING");
      const observation = next.reconciliation?.receipt;
      const receipt = observation?.kind === "SUCCESS" && observation.effect === "CONFIRMED" ? observation : next.receipt;
      const isUpdate = (next.reconciliation?.capability ?? next.capability) === "tasks.update";
      if (receipt?.kind === "SUCCESS" && receipt.effect === "CONFIRMED" && typeof receipt.value?.id === "string" && receipt.value.id) {
        const actual = await callbacks.current.request<Task>("tasks/" + encodeURIComponent(receipt.value.id), "GET", undefined, lifetime.current.signal);
        if (!mounted.current || serial.current !== turn) return;
        if (actual.id !== receipt.value.id || typeof actual.title !== "string" || typeof actual.projectId !== "string"
            || next.team && (actual.projectId !== source.projectId || actual.parentTaskId !== source.id)) throw new Error("Affected task could not be resolved");
        if (!isUpdate) setCreated(actual);
        if (announced.current !== actual.id) {
          try { await callbacks.current.confirmed(actual); announced.current = actual.id; }
          catch { if (mounted.current && serial.current === turn) setError("The customization was confirmed, but the project list could not be refreshed. Check the result again."); }
        }
      }
      if (!next.revoked && ["PENDING", "STARTED"].includes(next.state) && ++reads.current < 12) timer.current = setTimeout(() => void read(false, true), 1000);
    } catch {
      if (mounted.current && serial.current === turn) setError(creation
        ? "The customization result could not be checked. Your task is kept."
        : "The customization result could not be checked. Your task stays completed. Check the result before deciding what to do next.");
    } finally { if (mounted.current && serial.current === turn) { locked.current = false; setChecking(false); } }
  }
  useEffect(() => {
    mounted.current = true; void read();
    return () => { mounted.current = false; serial.current++; clearTimeout(timer.current); lifetime.current.abort(); };
  }, [source.id]);
  const uncertain = reaction?.outcome?.classification === "UNCERTAIN" || reaction?.outcome?.effects?.some(effect => effect.state === "UNKNOWN" || effect.effect === "UNKNOWN")
    || reaction?.receipt?.effect === "UNKNOWN" || reaction?.receipt?.kind === "UNKNOWN_COMMIT";
  const observedReceipt = reaction?.reconciliation?.receipt;
  const receipt = observedReceipt?.kind === "SUCCESS" && observedReceipt.effect === "CONFIRMED" ? observedReceipt : reaction?.receipt;
  const confirmedReceipt = receipt?.kind === "SUCCESS" && receipt.effect === "CONFIRMED" && typeof receipt.value?.id === "string" && !!receipt.value.id;
  const linkedNextAction = reaction?.team && created?.parentTaskId === source.id
    ? `“${created.title}”${created.assigneeName ? ` · Assigned to ${created.assigneeName}` : ""} · ${created.status === "completed" ? "Completed" : "Open"}` : null;
  const update = (reaction?.reconciliation?.observation ?? reaction?.observation)?.updated;
  const unchanged = update && JSON.stringify(update.before) === JSON.stringify(update.after);
  const unreadable = !uncertain && !reaction?.outcome?.effects?.length
    && ["ADAPTER_TRANSIENT", "TASK_NOT_FOUND", "PROJECT_NOT_FOUND", "ACCESS_DENIED"].includes(reaction?.outcome?.error?.code ?? "");
  const noEffect = !uncertain && (receipt?.effect === "NONE" || !!reaction?.outcome
    && ["COMPLETED", "BUSINESS_REJECTION", "FAILED", "LIMIT_EXCEEDED"].includes(reaction.outcome.classification ?? "")
    && Array.isArray(reaction.outcome.effects) && reaction.outcome.effects.every(effect => effect.state === "NONE" || effect.effect === "NONE"));
  if (!error && (reaction?.state === "NO_BINDING" || !reaction)) return null;
  return <section className="task-reaction" aria-label={creation ? "Task creation customization outcome" : "Customization outcome"}>
    {linkedNextAction && <p><strong>Linked task</strong></p>}
    <p role="status">{confirmedReceipt ? update ? unchanged ? "The update made no change." : "This task was updated."
      : created ? linkedNextAction ?? `Created “${created.title}”` : checking ? "A task was added. Checking its details…" : "A task was added, but it is unavailable here."
      : unreadable ? "Could not check the rule’s conditions."
      : noEffect ? reaction?.workflow ? "This customization made no change." : "No task was added by this customization."
      : uncertain ? reaction?.team ? "We haven’t confirmed a linked task. It may already exist." : reaction?.workflow || creation ? "Could not confirm whether the customization changed a task." : "Could not confirm whether a task was added."
      : reaction?.revoked ? "This customization is no longer allowed to run."
      : reaction?.state === "PENDING" ? "This customization has not started yet."
        : !reaction ? null : reaction?.workflow || creation
            ? "Could not confirm whether the customization changed a task." : "Could not confirm whether a task was added."}</p>
    {reaction?.outcome?.classification && !["COMPLETED", "UNCERTAIN"].includes(reaction.outcome.classification) && <p>{creation ? "The customization did not finish successfully. Your task is kept." : "The customization did not finish successfully. Your completed task is kept."}</p>}
    {created && <button type="button" className="quiet-button" aria-label={`Open task: ${created.title}`} onClick={() => openCreated(created)}>{linkedNextAction ? "Open linked task" : "Open task"}</button>}
    {error && <p role="alert">{error}</p>}
    <div className="task-reaction-actions">{(reaction?.team && !confirmedReceipt || !reaction?.team) &&
      <button type="button" className="quiet-button" aria-disabled={checking} onClick={() => void read(reaction?.team === true && !!uncertain)}>{reaction?.team ? "Check again" : "Check result"}</button>}
      {!reaction?.team && (uncertain || reaction?.state === "STARTED") && <button type="button" className="quiet-button" disabled={checking} onClick={() => void read(true)}>Reconcile saved observation</button>}</div>
    {reaction && (reaction.outcome || receipt || reaction.reconciliation || reaction.message) && <details><summary>Result details</summary>
      {reaction.team && <p>Rules when this task started: {reaction.revisionId ?? "No policy"}.</p>}
      {confirmedReceipt && <p>{update ? "A saved native receipt confirms the update." : "A saved native receipt confirms that a task was created."}</p>}
      {update && !unchanged && <dl>
        {update.before.priority !== update.after.priority && <><dt>Priority</dt><dd>{update.before.priority} → {update.after.priority}</dd></>}
        {update.before.tags.join(", ") !== update.after.tags.join(", ") && <><dt>Tags</dt><dd>{update.after.tags.join(", ")}</dd></>}
        {update.before.dueAt !== update.after.dueAt && <><dt>Due time</dt><dd>{update.after.dueAt ?? "None"}{update.after.dueAt && " (UTC)"}</dd></>}
      </dl>}
      {confirmedReceipt && uncertain && <p>The original runtime outcome remains uncertain. The saved native receipt is a separate confirmation.</p>}
      {reaction.message && <p>{reaction.message}</p>}
      {reaction.reconciliation && <p className="muted">Native observation checked {new Date(reaction.reconciliation.observedAt).toLocaleString()}.</p>}
      {receipt && <pre aria-label="Saved native receipt">{JSON.stringify(receipt, null, 2)}</pre>}
      {reaction.outcome && <pre aria-label="Original runtime outcome">{JSON.stringify(reaction.outcome, null, 2)}</pre>}
    </details>}
  </section>;
}

function TaskDetail({
  task,
  draft,
  setDraft,
  manage,
  busy,
  error,
  hold,
  close,
  reactionRequest,
  visible,
  reactionConfirmed,
  openCreated,
  complete,
  save,
}: {
  task: Task;
  draft: TaskDraft;
  setDraft: (draft: TaskDraft) => void;
  manage: () => void;
  busy: boolean;
  error: string;
  hold?: string;
  close: () => void;
  reactionRequest: <T>(path: string, method?: string, body?: object, signal?: AbortSignal) => Promise<T>;
  visible: boolean;
  reactionConfirmed: (created: Task) => Promise<void>;
  openCreated: (created: Task) => void;
  complete?: () => void;
  save: (dueAt?: string | null) => void;
}) {
  const [parent, setParent] = useState<Task | null>(null);
  const [creationBound, setCreationBound] = useState(false), [completionBound, setCompletionBound] = useState(false);
  const [selectedCompletion, setSelectedCompletion] = useState<"selected" | "none" | "unavailable" | null>(null);
  const request = useRef(reactionRequest); request.current = reactionRequest;
  useEffect(() => {
    if (!visible || task.creatorId || task.status !== "open") return;
    const controller = new AbortController();
    void request.current<Collection>("extensions", "GET", undefined, controller.signal).then(collection => {
      if (!controller.signal.aborted) setSelectedCompletion(!collection.selection ? "unavailable" : collection.selection.revision ? "selected" : "none");
    }).catch(() => { if (!controller.signal.aborted) setSelectedCompletion("unavailable"); });
    return () => controller.abort();
  }, [task.id, task.creatorId, task.status, visible]);
  useEffect(() => {
    if (!task.parentTaskId || !task.originEventId) return;
    const controller = new AbortController();
    void request.current<Task>(`tasks/${encodeURIComponent(task.parentTaskId)}`, "GET", undefined, controller.signal).then(result => {
      if (!controller.signal.aborted && isTask(result) && result.id === task.parentTaskId
          && result.projectId === task.projectId && !result.parentTaskId) setParent(result);
    }).catch(() => { /* A parent outside the viewer's access has no link. */ });
    return () => controller.abort();
  }, [task.parentTaskId, task.originEventId, task.projectId]);
  const atTop = !!task.creatorId && !task.parentTaskId;
  const created = <TaskReaction source={task} request={reactionRequest} confirmed={reactionConfirmed} openCreated={openCreated} creation bound={setCreationBound} />;
  return <TaskForm task={task} draft={draft} setDraft={setDraft} busy={busy} error={error} close={close} save={save} complete={complete}
    recovery={<>
      {hold && <section aria-label="Last completion attempt" className="task-completion-hold">
        <p role="status"><strong>Not completed on the last attempt</strong><br />The rule said: “{hold}”</p>
        <p>Try completing this task again when ready.</p>
      </section>}
      {atTop && created}
      {parent && <section aria-label="Original task" className="task-reaction">
        <p><strong>Original task</strong></p>
        <button type="button" className="quiet-button" onClick={() => openCreated(parent)}>Open “{parent.title}”</button>
      </section>}
    </>}>
    {task.status === "completed" && !task.creatorId && <TaskReaction source={task} request={reactionRequest} confirmed={reactionConfirmed} openCreated={openCreated} bound={setCompletionBound} />}
    {!atTop && created}
    {!task.creatorId && (creationBound || completionBound || task.status === "open" && (selectedCompletion === "selected" || selectedCompletion === "unavailable")) &&
      <button id="open-customizations" type="button" className="quiet-button" disabled={busy} onClick={manage}>Customization Studio</button>}
  </TaskForm>;
}

function TaskForm({ task, draft, setDraft, busy, error, close, save, complete, children, recovery, submitBlocked = false, closeLabel = "Cancel", closeNotice }: {
  task?: Task;
  draft: TaskDraft;
  setDraft: (draft: TaskDraft) => void;
  busy: boolean;
  error: string;
  close: () => void;
  save: (dueAt?: string | null) => void;
  complete?: () => void;
  children?: ReactNode;
  recovery?: ReactNode;
  submitBlocked?: boolean;
  closeLabel?: string;
  closeNotice?: string;
}) {
  const { title, notes } = draft;
  const [dueTimeError, setDueTimeError] = useState("");
  const dueTimeInput = useRef<HTMLInputElement>(null);
  const errorSummary = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!task && error) errorSummary.current?.focus();
  }, [task, error]);
  function editDueTime(dueTime: string) {
    setDueTimeError("");
    setDraft({ ...draft, dueTime, dueTimeEdited: true });
  }
  function rejectDueTime(message: string) {
    setDueTimeError(message);
    dueTimeInput.current?.focus();
  }
  return (
    <>
    <form
      onSubmit={(event) => {
        event.preventDefault();
        let dueAt: string | null | undefined;
        try { dueAt = draftDueAt(draft); }
        catch (failure) { return rejectDueTime((failure as Error).message); }
        save(dueAt);
      }}
    >
      <div className="detail-heading">
        <h2 id="detail-title">{task ? "Task details" : "New task"}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={task ? "Close task details" : "Close new task"}
          onClick={close}
        >
          ×
        </button>
      </div>
      <div className="task-form-notices">
      {!task && error && <div ref={errorSummary} className="error" role="alert" tabIndex={-1}>{error}</div>}
      {recovery}
      </div>
      <div className="task-form-layout">
      <div className="task-form-copy">
      <label htmlFor="edit-title">Task title</label>
      <input
        id="edit-title"
        autoFocus
        value={title}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        maxLength={120}
        required
      />
      <label htmlFor="edit-notes">
        Notes <span className="muted">(optional)</span>
      </label>
      <textarea
        id="edit-notes"
        value={notes}
        onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
        maxLength={4000}
        placeholder="Add a note"
        rows={7}
      />
      <label htmlFor="edit-tags">Tags</label>
      <input id="edit-tags" value={draft.tags} aria-describedby="edit-tags-hint"
        onChange={event => setDraft({ ...draft, tags: event.target.value })} />
      <p id="edit-tags-hint" className="muted tag-hint">Separate tags with commas.</p>
      </div>
      <aside className="task-form-meta" aria-label="Task metadata">
      {task && <p className={`status-label ${task.status}`}>
        {task.status === "completed" ? "✓ Completed" : "○ Open"}
      </p>}
      {task?.creatorId && <p className="tag-hint">{task.assigneeName ? `Assigned to ${task.assigneeName}` : "Unassigned"}</p>}
      <label htmlFor="edit-priority">Priority</label>
      <select id="edit-priority" value={draft.priority}
        onChange={event => setDraft({ ...draft, priority: event.target.value as Task["priority"] })}>
        <option value="low">Low</option>
        <option value="normal">Normal</option>
        <option value="high">High</option>
      </select>
      <label htmlFor="edit-due-time">Due time <span className="muted">(optional)</span></label>
      <input id="edit-due-time" ref={dueTimeInput} type="datetime-local" min="0001-01-01T00:00" max="9999-12-31T23:59:59.999" step="any"
        value={draft.dueTime} aria-invalid={dueTimeError ? true : undefined}
        aria-describedby={dueTimeError ? "edit-due-zone edit-due-error" : "edit-due-zone"}
        onChange={event => editDueTime(event.target.value)} />
      <p id="edit-due-zone" className="muted tag-hint">Enter a local time.
        {task?.dueAt && !draft.dueTimeEdited && <> Saved time: {formatDueTime(task.dueAt, draft.dueZone)}.</>}
      </p>
      {task?.dueAt && !draft.dueTime && !draft.dueTimeEdited &&
        <button type="button" className="quiet-button" onClick={() => editDueTime("")}>Clear saved due time</button>}
      {dueTimeError && <p id="edit-due-error" className="error" role="alert">{dueTimeError}</p>}
      {task?.completedAt && (
        <p className="muted">
          Completed{" "}
          {new Date(task.completedAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </p>
      )}
      </aside>
      </div>
      {task && error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {children && <div className="task-form-extras">{children}</div>}
      <div className="detail-actions">
        {closeNotice && <p className="detail-close-notice" role="status">{closeNotice}</p>}
        <button type="button" className="quiet-button" onClick={close}>
          {closeLabel}
        </button>
        {task?.status === "open" && complete && <button type="button" className="quiet-button" disabled={busy} onClick={complete}>Complete task</button>}
        <button className="primary" disabled={busy || submitBlocked}>
          {task ? "Save changes" : "Add task"}
        </button>
      </div>
    </form>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
