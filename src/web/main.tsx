import { createRoot } from "react-dom/client";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
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
type Advice = { status: "DISPLAYED"; classification: "DONE" | "PENDING" | "NEEDS_ATTENTION" }
  | { status: "NOT_DISPLAYED"; message: string };
type Task = {
  id: string;
  projectId: string;
  title: string;
  notes: string;
  status: "open" | "completed";
  completedAt: string | null;
};
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [projectName, setProjectName] = useState("");
  const [newProject, setNewProject] = useState(false);
  const [rename, setRename] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Task | null>(null);
  const [draft, setDraft] = useState({ title: "", notes: "" });
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
  const detailRef = useRef<HTMLDialogElement>(null);
  const detailInstance = useRef(0);
  const adviceEpoch = useRef(0);
  const serverGeneration = useRef<number | null>(null);
  const [lifecycleEpoch, setLifecycleEpoch] = useState(0);
  function beforeSelectionChange() {
    adviceEpoch.current++;
    setLifecycleEpoch(adviceEpoch.current);
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
    setTasks([]);
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
        if (current === generation.current && !lifetime.current.signal.aborted)
          setTasks(data);
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
    if (destination === "tasks" && taskScroller.current) taskScroller.current.scrollTop = taskScroll.current;
    if (detail && destination === "tasks") {
      detailRef.current?.showModal();
      if (resumeDetail.current) {
        document.getElementById("manage-task-advice")?.focus();
        resumeDetail.current = false;
      }
    }
    else {
      detailRef.current?.close();
      if (destination === "tasks") returnFocus.current?.focus();
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
        setTitle("");
        setNotice("Task added.");
      },
    );
  }
  function complete(task: Task) {
    action(
      () => request<Task>(`tasks/${task.id}/complete`, "POST", {}),
      (saved) => {
        setTasks((old) =>
          old.map((item) => (item.id === saved.id ? saved : item)),
        );
        setNotice("A little more done.");
      },
    );
  }
  function closeDetail() {
    detailInstance.current++;
    setDetail(null);
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
        <button
          className="task-open"
          onClick={(event) => {
            returnFocus.current = event.currentTarget;
            detailInstance.current++;
            setDraft({ title: task.title, notes: task.notes });
            setDetail(task);
          }}
        >
          <span>{task.title}</span>
          {task.notes && <small>{task.notes}</small>}
        </button>
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
          {loading ? (
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
        {destination === "customizations" && <Customizations request={studioRequest} changed={reconcileSelection} open={target => void openStudio("overview", target)} focusAction={destinationFocus.current ?? ""} notice={customizationNotice} />}
        {destination === "studio" && <main className="studio-main"><Studio key={studioTarget.entryId} request={studioRequest} changed={reconcileSelection} beforeSelectionChange={beforeSelectionChange}
          target={studioTarget} ownerId={session.user.id} recoveryKey={"daymark-studio-work:" + session.user.id + ":" + studioTarget.entryId}
          targeted={next => { if (currentStudioEntry.current === studioTarget.entryId && !lifetime.current.signal.aborted) rememberStudio({ ...next, entryId: studioTarget.entryId }); }}
          unavailable={() => { if (currentStudioEntry.current !== studioTarget.entryId || lifetime.current.signal.aborted) return; currentStudioEntry.current = null; setCustomizationNotice("That customization or conversation is unavailable. Choose a saved item or start a new one."); setDestination("customizations"); }} task={studioOrigin === "detail" && detail ? { title: detail.title, status: detail.status } : undefined}
          back={returnFromStudio} backLabel={studioOrigin === "detail" ? "Back to my task" : "Back to Customizations"} /></main>}
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
            setDraft={setDraft}
            manage={() => void openStudio("detail")}
            busy={busy}
            error={error}
            close={closeDetail}
            adviceEpoch={lifecycleEpoch}
            check={async () => {
              const instance = detailInstance.current, current = generation.current, epoch = adviceEpoch.current;
              const fresh = () => !lifetime.current.signal.aborted && current === generation.current && instance === detailInstance.current && epoch === adviceEpoch.current;
              try {
                const result = await request<Advice>(`tasks/${detail.id}/advice`, "POST", {});
                return fresh() ? result : undefined;
              } catch (error) {
                if (fresh()) {
                  handleError(error);
                  return { status: "NOT_DISPLAYED" as const, message: "Task advice is unavailable. Your task has not changed." };
                }
              }
            }}
            save={(title, notes) => {
              const instance = detailInstance.current;
              action(
                () =>
                  request<Task>(`tasks/${detail.id}`, "PATCH", {
                    title,
                    notes,
                  }),
                (saved) => {
                  setTasks((old) =>
                    old.map((item) => (item.id === saved.id ? saved : item)),
                  );
                  if (instance === detailInstance.current) closeDetail();
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

function TaskDetail({
  task,
  draft,
  setDraft,
  manage,
  busy,
  error,
  close,
  check,
  adviceEpoch,
  save,
}: {
  task: Task;
  draft: { title: string; notes: string };
  setDraft: (draft: { title: string; notes: string }) => void;
  manage: () => void;
  busy: boolean;
  error: string;
  close: () => void;
  check: () => Promise<Advice | undefined>;
  adviceEpoch: number;
  save: (title: string, notes: string) => void;
}) {
  const { title, notes } = draft;
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [checking, setChecking] = useState(false);
  const pendingAdvice = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => { pendingAdvice.current++; setAdvice(null); setChecking(false); }, [adviceEpoch]);
  async function checkTask() {
    if (checking) return;
    setChecking(true);
    setAdvice(null);
    const id = ++pendingAdvice.current;
    const result = await check();
    if (mounted.current && id === pendingAdvice.current) {
      setAdvice(result ?? null);
      setChecking(false);
    }
  }
  return (
    <>
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save(title, notes);
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
      <section aria-label="Task advice">
        <button type="button" className="quiet-button" disabled={busy || checking} onClick={checkTask}>
          {checking ? "Checking task…" : "Check task advice"}
        </button>
        <button id="manage-task-advice" type="button" className="quiet-button" disabled={busy} onClick={manage}>Manage task advice</button>
        <p className="muted">Checks the saved task status using your configured rule. Advice does not change tasks.</p>
        {advice && <p role="status">{advice.status === "NOT_DISPLAYED" ? advice.message : {
          DONE: "Task advice: Done", PENDING: "Task advice: Pending",
          NEEDS_ATTENTION: "Task advice: Needs attention",
        }[advice.classification]}</p>}
      </section>
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
