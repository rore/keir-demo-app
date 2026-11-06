import { createRoot } from "react-dom/client";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Temporal } from "temporal-polyfill";
import "./styles.css";
import Studio, { type Collection, type StudioTarget } from "./Studio";
import Customizations from "./Customizations";

type User = { id: string; name: string; description?: string };
type Session = { user: User | null; contextToken: string; users?: User[] };
function studioLink() {
  if (!location.hash) return { valid: true, target: null };
  const params = new URLSearchParams(location.hash.slice(1));
  const keys = Array.from(params.keys());
  const id = (value: string | null) => value !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
  if (keys.length === 1 && params.get("new") === "1") return { valid: true, target: { extensionId: null } as StudioTarget };
  if (keys.length < 1 || keys.length > 2 || new Set(keys).size !== keys.length || keys.some(key => !["customization", "conversation"].includes(key))
    || !id(params.get("customization")) || params.has("conversation") && !id(params.get("conversation"))) return { valid: false, target: null };
  return { valid: true, target: { extensionId: params.get("customization"), conversationId: params.get("conversation") } as StudioTarget };
}
type Project = { id: string; name: string };
type NativeReceipt = { kind: string; effect?: "CONFIRMED" | "NONE" | "UNKNOWN"; value?: { id: string }; code?: string };
type NativeChange = Pick<Task, "tags" | "priority" | "dueAt">;
type ReactionObservation = { capability?: "tasks.create" | "tasks.update"; observation?: { updated?: { id: string; before: NativeChange; after: NativeChange } } };
type Reaction = {
  state: "NO_BINDING" | "PENDING" | "STARTED" | "FINISHED";
  workflow?: boolean;
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
};
type TaskDraft = Pick<Task, "title" | "notes" | "priority"> & { tags: string; dueTime: string; dueZone: string; dueTimeEdited: boolean };
type SearchFilters = { q: string; tag: string };
type SearchPage = { items: Task[]; nextAfter: string | null };
type TaskSearch = SearchPage & { pending: boolean; failure: { message: string; after: string | null } | null };
const emptyFilters = { q: "", tag: "" };
const emptyPage = { items: [], nextAfter: null };

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
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    signal,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(context ? { "X-Session-Context": context } : {}),
      ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
    },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      data.message ?? "The request could not be completed.",
      response.status,
      Array.isArray(data.diagnostics) ? data.diagnostics : undefined,
      typeof data.code === "string" ? data.code : undefined,
    );
  return data;
}

function Brand() {
  return (
    <span className="brand" aria-label="Daymark, A KEIR Demo">
      <span className="brand-mark" aria-hidden="true">
        ✓
      </span>
      <span className="brand-copy">
        <span className="brand-name">Daymark</span>
        <span className="brand-subline">A KEIR Demo</span>
      </span>
    </span>
  );
}
function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const authBusy = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    api<Session>("session", undefined, "GET", undefined, abort.signal)
      .then((data) => {
        setSession(data);
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
    setSession(null);
    setError(
      "Your demo session changed or the app restarted. Choose a person to continue.",
    );
  }
  async function authenticate(userId?: string) {
    if (authBusy.current) return;
    authBusy.current = true;
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
        const current = await api<Session>("session");
        const next = await api<Session>(
          "session",
          current.contextToken,
          userId ? "POST" : "DELETE",
          userId ? { userId } : {},
        );
        setSession(next);
        channel.current?.postMessage("changed");
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
          <span className="eyebrow">THE LOCAL DEMO</span>
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
            <span className="section-number">START HERE</span>
            <h2 id="welcome-title">Choose a demo person.</h2>
            <p>
              Choose a fictional demo person.
              <br />
              Each has a space of their own.
            </p>
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
                  <span className="arrow" aria-hidden="true">
                    ↗
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
        <footer className="welcome-footer">
          <span>Made for the work in front of you.</span>
        </footer>
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
    />
  );
}

function Workspace({
  session,
  users,
  signOut,
  switchUser,
  expired,
}: {
  session: Session & { user: User };
  users: User[];
  signOut: () => void;
  switchUser: (id: string) => void;
  expired: () => void;
}) {
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
  const [title, setTitle] = useState("");
  const [projectName, setProjectName] = useState("");
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
    if (!entryLink.valid) return null;
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
  const [destination, setDestination] = useState<"tasks" | "customizations" | "studio">(savedRoute ? "studio" : !entryLink.valid ? "customizations" : "tasks");
  const [studioOrigin, setStudioOrigin] = useState<"detail" | "overview">("overview");
  const [studioTarget, setStudioTarget] = useState(savedRoute ?? { extensionId: null, entryId: crypto.randomUUID() });
  const [customizationNotice, setCustomizationNotice] = useState(entryLink.valid ? "" : "That customization link is invalid. Choose a saved item or start a new one.");
  const studioEntrySerial = useRef(0);
  const currentStudioEntry = useRef<string | null>(studioTarget.entryId);
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
      if (destination === "studio") sessionStorage.setItem(routeKey, JSON.stringify(studioTarget));
      else sessionStorage.removeItem(routeKey);
    } catch { /* Tab recovery is unavailable when browser storage is disabled. */ }
    if (destination !== "studio" && location.hash) history.replaceState(null, "", location.pathname + location.search);
  }, [destination, studioTarget, routeKey]);
  useEffect(() => {
    const changed = () => {
      studioEntrySerial.current++;
      const link = studioLink();
      if (link.valid && link.target) {
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
  ) => api<T>(path, session.contextToken, method, body, signal);
  async function studioRequest<T>(path: string, method?: string, body?: object, signal?: AbortSignal) {
    const scopedSignal = signal ? AbortSignal.any([lifetime.current.signal, signal]) : lifetime.current.signal;
    try { return await request<T>(path, method, body, scopedSignal); }
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
    studioEntrySerial.current++;
    currentStudioEntry.current = null;
    destinationFocus.current = next === "tasks" ? "tasks-heading" : "customizations-heading";
    setDestination(next);
  }
  async function openStudio(origin: "detail" | "overview", target: StudioTarget = { extensionId: null }) {
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
          setProjectId(data[0]?.id ?? "");
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
    setTitle("");
    setError("");
    setRename(false);
    setNotice("");
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
    if (detail && destination === "tasks") {
      detailRef.current?.showModal();
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
  }, [detail?.id, destination]);
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
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  function saveProject(event: FormEvent) {
    event.preventDefault();
    action(
      () =>
        request<Project>(
          rename ? `projects/${projectId}` : "projects",
          rename ? "PATCH" : "POST",
          { name: projectName },
        ),
      (saved) => {
        setProjects((old) =>
          rename
            ? old.map((item) => (item.id === saved.id ? saved : item))
            : [...old, saved],
        );
        setProjectId(saved.id);
        setProjectName("");
        setNewProject(false);
        setRename(false);
        setNotice("Project saved.");
      },
    );
  }
  function addTask(event: FormEvent) {
    event.preventDefault();
    action(
      () => request<Task>("tasks", "POST", { projectId, title }),
      (saved) => {
        setTasks((old) => [...old, saved]);
        refreshSearch();
        setTitle("");
        setNotice("Task added.");
      },
    );
  }
  function complete(task: Task) {
    action(
      async () => {
        try { return await request<Task>(`tasks/${task.id}/complete`, "POST", {}); }
        catch (failure) {
          if (lifetime.current.signal.aborted) throw failure;
          const saved = await request<Task>(`tasks/${task.id}`);
          if (saved.status === "completed") return saved;
          throw failure;
        }
      },
      (saved) => {
        updateTask(saved);
        setNotice("A little more done.");
        setRecentCompletion(saved.id);
      },
    );
  }
  function closeDetail() {
    detailInstance.current++;
    setDetail(null);
  }
  function openCreatedTask(task: Task) {
    const navigation = ++studioEntrySerial.current;
    currentStudioEntry.current = null;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    returnToSearch.current = !!search;
    detailInstance.current++; setDestination("tasks");
    if (task.projectId !== projectId) { pendingTaskOpen.current = { task, navigation }; setProjectId(task.projectId); }
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
          disabled={busy || task.status === "completed"}
          onClick={() => complete(task)}
        >
          {task.status === "completed" ? "✓" : ""}
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
        </button>
        {(task.priority === "high" || task.priority === "low" || task.dueAt) && <small className="muted">
          {task.priority === "high" ? "High priority" : task.priority === "low" ? "Low priority" : ""}
          {(task.priority === "high" || task.priority === "low") && task.dueAt && " · "}
          {task.dueAt && <time dateTime={task.dueAt}>Due {formatDueTime(task.dueAt)}</time>}
        </small>}
        {recentCompletion === task.id && detail?.id !== task.id && <TaskReaction source={task} request={studioRequest} confirmed={refreshCreatedTasks} openCreated={openCreatedTask} />}
        </div>
        <span className="task-chevron" aria-hidden="true">
          ↗
        </span>
      </li>
    );
  }
  return (
    <div className="workspace">
      <aside className="rail">
        <Brand />
        <nav className="destinations" aria-label="Main navigation">
          <button aria-current={destination === "tasks" ? "page" : undefined} onClick={() => navigate("tasks")}>Tasks</button>
          <button aria-current={destination !== "tasks" ? "page" : undefined} onClick={() => navigate("customizations")}>Customizations</button>
        </nav>
        <div className="rail-heading">
          <span className="eyebrow">YOUR PROJECTS</span>
          <button
            className="icon-button"
            aria-label="New project"
            disabled={!projectsReady}
            onClick={() => {
              setNewProject(true);
              setRename(false);
              setProjectName("");
              navigate("tasks");
            }}
          >
            +
          </button>
        </div>
        <nav aria-label="Projects">
          {projects.map((item, index) => (
            <button
              key={item.id}
              className={`project-link ${destination === "tasks" && item.id === projectId ? "selected" : ""}`}
              onClick={() => { setProjectId(item.id); navigate("tasks"); }}
            >
              <span aria-hidden="true" className="project-symbol">
                {String(index + 1).padStart(2, "0")}
              </span>
              {item.name}
            </button>
          ))}
        </nav>
        <div className="rail-bottom">
          <span className="local-dot" aria-hidden="true" /> Saved on this device
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-top">
          <span className="desktop-context">{destination === "tasks" ? "Tasks" : "Customizations"}</span>
          <span className="mobile-brand"><Brand /></span>
          <div className="user-tools">
            <span className="small-avatar" aria-hidden="true">
              {session.user.name[0]}
            </span>
            <label className="sr-only" htmlFor="person-select">
              Demo person
            </label>
            <select
              id="person-select"
              value={session.user.id}
              onChange={(event) => switchUser(event.target.value)}
            >
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
            <button className="quiet-button" onClick={signOut}>
              Sign out
            </button>
          </div>
        </header>
        <nav className="mobile-destinations" aria-label="Mobile navigation">
          <label className="sr-only" htmlFor="destination-select">Destination</label>
          <select id="destination-select" value={destination === "tasks" ? "tasks" : "customizations"} onChange={event => navigate(event.target.value as "tasks" | "customizations")}>
            <option value="tasks">Tasks</option><option value="customizations">Customizations</option>
          </select>
        </nav>
        <main ref={taskScroller} className="task-main" hidden={destination !== "tasks"} aria-labelledby="tasks-heading" tabIndex={-1}
          onScroll={event => { if (destination === "tasks" && event.currentTarget.clientHeight) taskScroll.current = event.currentTarget.scrollTop; }}>
          <div className="mobile-projects">
            <label htmlFor="project-select">Project</label>
            <select
              id="project-select"
              value={projectId}
              onChange={(event) => { setProjectId(event.target.value); navigate("tasks"); }}
            >
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              aria-label="Add project"
              disabled={!projectsReady}
              onClick={() => {
                setNewProject(true);
                setRename(false);
                setProjectName("");
              }}
            >
              +
            </button>
          </div>
          <div className="project-title">
            <h1 id="tasks-heading" tabIndex={-1}>{project?.name ?? "Tasks"}</h1>
            {project && (
              <button
                className="quiet-button"
                onClick={() => {
                  setProjectName(project.name);
                  setRename(true);
                  setNewProject(false);
                }}
              >
                Rename project
              </button>
            )}
          </div>
          <p className="project-subtitle">
            {project
              ? "Your tasks in this project."
              : "Start a project. Give your next idea a place to land."}
          </p>
          {(newProject || rename) && (
            <form className="project-form" onSubmit={saveProject}>
              <label htmlFor="project-name">
                {rename ? "Project name" : "New project name"}
              </label>
              <div className="form-line">
                <input
                  autoFocus
                  id="project-name"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  required
                  maxLength={80}
                  placeholder="Something worth making"
                />
                <button className="primary" disabled={busy}>
                  Save project
                </button>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => {
                    setNewProject(false);
                    setRename(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
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
              <span aria-hidden="true">+</span>
              <label className="sr-only" htmlFor="new-task">
                New task title
              </label>
              <input
                id="new-task"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                maxLength={120}
                placeholder="What would you like to get done?"
              />
              <button className="primary" disabled={busy || loading}>
                Add task <span aria-hidden="true">↵</span>
              </button>
            </form>
          )}
          {project && (
            <form className="task-search-form" onSubmit={event => {
              event.preventDefault();
              const next = { q: filters.q.trim(), tag: filters.tag.trim() };
              if (next.q || next.tag) void fetchSearch(next, "submit");
            }}>
              <label>
                Search tasks
                <input id="task-search-text" type="search" value={filters.q} maxLength={120}
                  onChange={event => setFilters({ ...filters, q: event.target.value })} />
              </label>
              <label>
                Filter by tag
                <input type="text" value={filters.tag}
                  onChange={event => setFilters({ ...filters, tag: event.target.value })} />
              </label>
              <div className="task-search-actions">
                <button className="primary" disabled={!filters.q.trim() && !filters.tag.trim()}>Search</button>
                <button type="button" className="quiet-button" disabled={!search && !filters.q && !filters.tag}
                  onClick={() => { resetSearch(); document.getElementById("task-search-text")?.focus(); }}>
                  Clear
                </button>
              </div>
            </form>
          )}
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
                  Up next <span>{open.length}</span>
                </h2>
              </div>
              {open.length ? (
                <ul className="task-list">{open.map(taskRow)}</ul>
              ) : (
                <div className="empty">
                  <span aria-hidden="true">✳</span>
                  <h2>
                    {completed.length
                      ? "A little breathing room."
                      : "Room for something good."}
                  </h2>
                  <p>
                    {completed.length
                      ? "Everything here is done. Enjoy the pause, or add your next step."
                      : "Your first task starts just above. Keep it small."}
                  </p>
                </div>
              )}
              {completed.length > 0 && (
                <section className="completed-section">
                  <h2>
                    Done & dusted <span>{completed.length}</span>
                  </h2>
                  <ul className="task-list">{completed.map(taskRow)}</ul>
                </section>
              )}
            </>
          ) : (
            <div className="empty">
              <span aria-hidden="true">✳</span>
              <h2>Make a little room.</h2>
              <button
                className="primary"
                disabled={!projectsReady}
                onClick={() => setNewProject(true)}
              >
                Create your first project
              </button>
            </div>
          )}
          <footer className="task-footer">
            <span>
              <span className="local-dot" aria-hidden="true" />
              Local demo
            </span>
          </footer>
        </main>
        {destination === "customizations" && <Customizations request={studioRequest} changed={reconcileSelection} beforeSelectionChange={beforeSelectionChange} open={target => void openStudio("overview", target)} focusAction={destinationFocus.current ?? ""} notice={customizationNotice} />}
        {destination === "studio" && <main className="studio-main"><Studio key={studioTarget.entryId} request={studioRequest} changed={reconcileSelection} beforeSelectionChange={beforeSelectionChange}
          target={studioTarget} ownerId={session.user.id} recoveryKey={"daymark-studio-work:" + session.user.id + ":" + studioTarget.entryId} projects={projects}
          targeted={next => { if (currentStudioEntry.current === studioTarget.entryId && !lifetime.current.signal.aborted) rememberStudio({ ...next, entryId: studioTarget.entryId }); }}
          unavailable={() => { if (currentStudioEntry.current !== studioTarget.entryId || lifetime.current.signal.aborted) return; currentStudioEntry.current = null; setCustomizationNotice("That customization or conversation is unavailable. Choose a saved item or start a new one."); setDestination("customizations"); }} task={studioOrigin === "detail" && detail ? { title: detail.title, status: detail.status } : undefined}
          back={returnFromStudio} backToTasks={returnToTasks} createNew={() => void openStudio("overview", { extensionId: null })} backLabel={studioOrigin === "detail" ? "Back to my task" : "Back to Customizations"} /></main>}
      </div>
      <dialog
        ref={detailRef}
        className="detail"
        aria-labelledby="detail-title"
        onCancel={(event) => {
          event.preventDefault();
          closeDetail();
        }}
        onClose={() => {
          if (detailVisible.current && !detailRef.current?.open) closeDetail();
        }}
      >
        {detail && (
          <TaskDetail
            key={detail.id}
            task={detail}
            draft={draft}
            setDraft={next => { draftVersion.current++; setDraft(next); }}
            manage={() => void openStudio("detail")}
            busy={busy}
            error={error}
            close={closeDetail}
            reactionRequest={studioRequest}
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
    </div>
  );
}

function TaskReaction({ source, request, confirmed, openCreated, creation = false }: {
  source: Task;
  request: <T>(path: string, method?: string, body?: object, signal?: AbortSignal) => Promise<T>;
  confirmed: (created: Task) => Promise<void>;
  openCreated: (created: Task) => void;
  creation?: boolean;
}) {
  const [reaction, setReaction] = useState<Reaction | null>(null);
  const [created, setCreated] = useState<Task | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false), locked = useRef(false), serial = useRef(0), reads = useRef(0);
  const lifetime = useRef(new AbortController()), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announced = useRef<string | null>(null);
  const callbacks = useRef({ request, confirmed }); callbacks.current = { request, confirmed };
  async function read(reconcile = false, automatic = false) {
    if (!mounted.current || locked.current) return;
    if (!automatic) reads.current = 0;
    clearTimeout(timer.current); locked.current = true; const turn = ++serial.current;
    setChecking(true); setError(""); setCreated(null);
    try {
      const next = await callbacks.current.request<Reaction>("tasks/" + encodeURIComponent(source.id) + "/reaction" + (reconcile ? "/reconcile" : "")
        + (creation ? "?trigger=TaskCreated" : ""), reconcile ? "POST" : "GET", reconcile ? {} : undefined, lifetime.current.signal);
      if (!mounted.current || serial.current !== turn) return;
      if (!["NO_BINDING", "PENDING", "STARTED", "FINISHED"].includes(next.state)) throw new Error("Unconfirmed reaction response");
      setReaction(next);
      const observation = next.reconciliation?.receipt;
      const receipt = observation?.kind === "SUCCESS" && observation.effect === "CONFIRMED" ? observation : next.receipt;
      const isUpdate = (next.reconciliation?.capability ?? next.capability) === "tasks.update";
      if (receipt?.kind === "SUCCESS" && receipt.effect === "CONFIRMED" && typeof receipt.value?.id === "string" && receipt.value.id) {
        const actual = await callbacks.current.request<Task>("tasks/" + encodeURIComponent(receipt.value.id), "GET", undefined, lifetime.current.signal);
        if (!mounted.current || serial.current !== turn) return;
        if (actual.id !== receipt.value.id || typeof actual.title !== "string" || typeof actual.projectId !== "string") throw new Error("Affected task could not be resolved");
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
  const update = (reaction?.reconciliation?.observation ?? reaction?.observation)?.updated;
  const unchanged = update && JSON.stringify(update.before) === JSON.stringify(update.after);
  const unreadable = !uncertain && !reaction?.outcome?.effects?.length
    && ["ADAPTER_TRANSIENT", "TASK_NOT_FOUND", "PROJECT_NOT_FOUND", "ACCESS_DENIED"].includes(reaction?.outcome?.error?.code ?? "");
  const noEffect = !uncertain && (receipt?.effect === "NONE" || !!reaction?.outcome
    && ["COMPLETED", "BUSINESS_REJECTION", "FAILED", "LIMIT_EXCEEDED"].includes(reaction.outcome.classification ?? "")
    && Array.isArray(reaction.outcome.effects) && reaction.outcome.effects.every(effect => effect.state === "NONE" || effect.effect === "NONE"));
  if (creation && (!reaction || reaction.state === "NO_BINDING")) return null;
  return <section className="task-reaction" aria-label={creation ? "Task creation customization outcome" : "Customization outcome"}>
    <p role="status">{confirmedReceipt ? update ? unchanged ? "The update made no change." : "This task was updated."
      : created ? `Created “${created.title}”` : checking ? "A task was added. Checking its details…" : "A task was added, but it is unavailable here."
      : unreadable ? "Could not check the rule’s conditions."
      : noEffect ? reaction?.workflow ? "This customization made no change." : "No task was added by this customization."
      : uncertain ? reaction?.workflow || creation ? "Could not confirm whether the customization changed a task." : "Could not confirm whether a task was added."
      : reaction?.revoked ? "This customization is no longer allowed to run."
      : reaction?.state === "NO_BINDING" ? "No customization was recorded for this completion."
        : reaction?.state === "PENDING" ? "This customization has not started yet."
          : !reaction && checking ? "Checking the customization result…" : reaction?.workflow
            ? "Could not confirm whether the customization changed a task." : "Could not confirm whether a task was added."}</p>
    {reaction?.outcome?.classification && !["COMPLETED", "UNCERTAIN"].includes(reaction.outcome.classification) && <p>{creation ? "The customization did not finish successfully. Your task is kept." : "The customization did not finish successfully. Your completed task is kept."}</p>}
    {created && <button type="button" className="quiet-button" aria-label={`Open task: ${created.title}`} onClick={() => openCreated(created)}>Open task</button>}
    {error && <p role="alert">{error}</p>}
    <div className="task-reaction-actions"><button type="button" className="quiet-button" disabled={checking} onClick={() => void read()}>Check result</button>
      {(uncertain || reaction?.state === "STARTED") && <button type="button" className="quiet-button" disabled={checking} onClick={() => void read(true)}>Reconcile saved observation</button>}</div>
    {reaction && (reaction.outcome || receipt || reaction.reconciliation || reaction.message) && <details><summary>Result details</summary>
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
  close,
  reactionRequest,
  reactionConfirmed,
  openCreated,
  save,
}: {
  task: Task;
  draft: TaskDraft;
  setDraft: (draft: TaskDraft) => void;
  manage: () => void;
  busy: boolean;
  error: string;
  close: () => void;
  reactionRequest: <T>(path: string, method?: string, body?: object, signal?: AbortSignal) => Promise<T>;
  reactionConfirmed: (created: Task) => Promise<void>;
  openCreated: (created: Task) => void;
  save: (dueAt?: string | null) => void;
}) {
  const { title, notes } = draft;
  const [dueTimeError, setDueTimeError] = useState("");
  const dueTimeInput = useRef<HTMLInputElement>(null);
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
        if (!draft.dueTimeEdited) return save();
        if (!draft.dueTime) return save(null);
        const local = Temporal.PlainDateTime.from(draft.dueTime);
        let dueAt: string;
        try {
          dueAt = local.toZonedDateTime(draft.dueZone, { disambiguation: "reject" })
            .toInstant().toString({ fractionalSecondDigits: 3 });
        } catch {
          const earlier = local.toZonedDateTime(draft.dueZone, { disambiguation: "earlier" }).toPlainDateTime();
          return rejectDueTime(earlier.equals(local)
            ? "This local time occurs twice. Choose a different time."
            : "This local time does not exist. Choose a different time.");
        }
        if (dueAt.length !== 24 || dueAt < "0001-01-01T00:00:00.000Z") return rejectDueTime("Choose a time within UTC years 0001 to 9999.");
        save(dueAt);
      }}
    >
      <div className="detail-top">
        <button
          type="button"
          className="icon-button"
          aria-label="Close task details"
          onClick={close}
        >
          ×
        </button>
      </div>
      <h2 id="detail-title">Task details</h2>
      <span className={`status-label ${task.status}`}>
        {task.status === "completed" ? "✓ Completed" : "○ Up next"}
      </span>
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
        placeholder="A thought, a reference, a place to begin…"
        rows={7}
      />
      <label htmlFor="edit-tags">Tags</label>
      <input id="edit-tags" value={draft.tags} aria-describedby="edit-tags-hint"
        onChange={event => setDraft({ ...draft, tags: event.target.value })} />
      <p id="edit-tags-hint" className="muted tag-hint">Separate tags with commas. Use up to 8 tags, each up to 32 characters.</p>
      <label htmlFor="edit-priority">Priority</label>
      <select id="edit-priority" value={draft.priority}
        onChange={event => setDraft({ ...draft, priority: event.target.value as Task["priority"] })}>
        <option value="low">Low</option>
        <option value="normal">Normal</option>
        <option value="high">High</option>
      </select>
      <label htmlFor="edit-due-time">Due time <span className="muted">(optional)</span></label>
      <input id="edit-due-time" ref={dueTimeInput} type="datetime-local" min="0001-01-01T00:00" max="9999-12-31T23:59:59.999" step="0.001"
        value={draft.dueTime} aria-invalid={dueTimeError ? true : undefined}
        aria-describedby={dueTimeError ? "edit-due-zone edit-due-error" : "edit-due-zone"}
        onChange={event => editDueTime(event.target.value)} />
      <p id="edit-due-zone" className="muted tag-hint">Time zone: {draft.dueZone}.
        {task.dueAt && !draft.dueTimeEdited && <> Saved time: {formatDueTime(task.dueAt, draft.dueZone)}.</>}
      </p>
      {task.dueAt && !draft.dueTime && !draft.dueTimeEdited &&
        <button type="button" className="quiet-button" onClick={() => editDueTime("")}>Clear saved due time</button>}
      {dueTimeError && <p id="edit-due-error" className="error" role="alert">{dueTimeError}</p>}
      {task.completedAt && (
        <p className="muted">
          Completed{" "}
          {new Date(task.completedAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </p>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {task.status === "completed" && <TaskReaction source={task} request={reactionRequest} confirmed={reactionConfirmed} openCreated={openCreated} />}
      <TaskReaction source={task} request={reactionRequest} confirmed={reactionConfirmed} openCreated={openCreated} creation />
      <button id="open-customizations" type="button" className="quiet-button" disabled={busy} onClick={manage}>Customization Studio</button>
      <div className="detail-actions">
        <button type="button" className="quiet-button" onClick={close}>
          Cancel
        </button>
        <button className="primary" disabled={busy}>
          Save changes
        </button>
      </div>
    </form>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
