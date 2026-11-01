import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import "./styles.css";

type User = { id: string; name: string; description?: string };
type Session = { user: User | null; contextToken: string; users?: User[] };
type Project = { id: string; name: string };
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
    );
  return data;
}

function Brand() {
  return (
    <span className="brand" aria-label="Keir">
      <span className="brand-mark" aria-hidden="true">
        k
      </span>
      keir<span className="brand-dot">.</span>
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
            <p className="eyebrow">A LITTLE ROOM FOR GOOD WORK</p>
            <h1>
              Less noise.
              <br />
              More <em>done.</em>
            </h1>
            <p className="intro">
              A thoughtful place for projects, small steps,
              <br className="desktop-break" /> and the satisfying feeling of
              finishing.
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
            <span className="section-number">01 / COME ON IN</span>
            <h2 id="welcome-title">Make yourself at home.</h2>
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
          <span>KEIR / NATIVE TASKS</span>
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
  const [notice, setNotice] = useState("");
  const lifetime = useRef(new AbortController());
  const generation = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const detailRef = useRef<HTMLDialogElement>(null);
  const detailInstance = useRef(0);
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
  useEffect(() => {
    if (detail) detailRef.current?.showModal();
    else {
      detailRef.current?.close();
      returnFocus.current?.focus();
    }
  }, [detail?.id]);
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
            }}
          >
            +
          </button>
        </div>
        <nav aria-label="Projects">
          {projects.map((item, index) => (
            <button
              key={item.id}
              className={`project-link ${item.id === projectId ? "selected" : ""}`}
              onClick={() => setProjectId(item.id)}
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
          <p>
            A clear space.
            <br />
            One thing at a time.
          </p>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-top">
          <span className="eyebrow">A LITTLE ROOM FOR GOOD WORK</span>
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
        <main className="task-main">
          <div className="mobile-projects">
            <label htmlFor="project-select">Project</label>
            <select
              id="project-select"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
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
          <p className="eyebrow greeting">
            YOUR SPACE, {session.user.name.toUpperCase()}
          </p>
          <div className="project-title">
            <h1>{project?.name ?? "A fresh start"}</h1>
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
              ? "Small steps make room for bigger things."
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
                <span className="eyebrow">ONE STEP AT A TIME</span>
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
              Local demo · extensions off
            </span>
            <span>Good work takes its own time.</span>
          </footer>
        </main>
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
          if (detail) closeDetail();
        }}
      >
        {detail && (
          <TaskDetail
            key={detail.id}
            task={detail}
            busy={busy}
            error={error}
            close={closeDetail}
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
  busy,
  error,
  close,
  save,
}: {
  task: Task;
  busy: boolean;
  error: string;
  close: () => void;
  save: (title: string, notes: string) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save(title, notes);
      }}
    >
      <div className="detail-top">
        <span className="eyebrow">A CLOSER LOOK</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Close task details"
          onClick={close}
        >
          ×
        </button>
      </div>
      <h2 id="detail-title">One small step.</h2>
      <span className={`status-label ${task.status}`}>
        {task.status === "completed" ? "✓ Completed" : "○ Up next"}
      </span>
      <label htmlFor="edit-title">Task title</label>
      <input
        id="edit-title"
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        maxLength={120}
        required
      />
      <label htmlFor="edit-notes">
        Notes <span className="muted">(optional)</span>
      </label>
      <textarea
        id="edit-notes"
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
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
      <div className="detail-actions">
        <button type="button" className="quiet-button" onClick={close}>
          Cancel
        </button>
        <button className="primary" disabled={busy}>
          Save changes
        </button>
      </div>
    </form>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
