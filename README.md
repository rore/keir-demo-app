# Daymark · Keir Demo App

A small local task workspace: projects, tasks, notes and a satisfying completion flow. Sign in as Maya, Leo or Sam, three fictional demo people with independent data. Your work stays in a local SQLite database across restarts.

Daymark is the working host-app identity, with secondary **Powered by Keir** attribution. Use **Tasks** for native work and **Customizations → Task advice** to open Studio directly. Try sample tasks, review and approve a prepared read-only rule, then explicitly put it in use. Maya and Leo begin with different rules; Sam starts without one. Task details retain **Check task advice** and a **Manage task advice** shortcut to the same Studio; returning preserves unsaved title/notes. Native CRUD remains independent of advice. Running the app needs no AI credentials, Java, hosted database or sibling repository. Demo sign-in is local impersonation, not production authentication or a private account.

## Run locally

Prerequisite: **Node.js 24.14.1** with npm. This is the qualified runtime; its `node:sqlite` API is experimental. Nothing here installs or upgrades global tools. Package versions are pinned in `package-lock.json`.

From this repository:

```sh
npm ci
npm run build
npm start
```

Open the printed [local app address](http://127.0.0.1:3000). Use that exact host/port; `localhost` is a different origin and is rejected. If occupied, use `npm start -- --port 3001`. The app never stops another service.

First start seeds the demo. Optional `npm run seed` preserves edits. One process owns `.data/`; another start/seed/reset fails safely. Use **Ctrl+C in the owning terminal** to stop normally. Restart requires sign-in; projects/tasks persist. Data, test browsers and local configuration are ignored by Git.

## Deliberate reset

Stop the app, then run:

```sh
npm run reset -- --confirm
```

Reset holds the startup lock and verifies a recoverable backup in `.data/backups/` before resetting data transactionally. Backup failure preserves the original; failed reset rolls back. Startup never resets existing data. Read [data lifecycle and recovery](docs/running.md) before restoring a backup or removing a stale lock.

## Verify

Build first, then:

```sh
npm test
npm run test:browser:install
npm run test:e2e
```

Native regression uses temporary data. Browser setup downloads separate test Chromium **inside `.tools/playwright/`** without changing installed browsers/profiles. Browser journeys own their servers, ports and databases; they never reuse an operator app. After browser setup, `npm run test:all` runs both suites. See [test details](tests/README.md).

## Studio and its design reference

The functional Studio shares Daymark's navigation and controls, with a white conversation and ivory advice sheet on slate. Desktop panes scroll separately; narrow or short screens switch between **Conversation** and **Preview**, retaining positions and unsent text. See the [implemented experience and design reference](docs/extension-studio-design.md).

The earlier scripted prototype remains available with `node docs/extension-studio/serve.mjs` at [the prototype address](http://localhost:4179/); it is a separate future-authoring reference. The native app includes the real server-backed read-only Studio; see [review and select task advice](docs/read-extension-lifecycle.md). Complete AI extension creation remains future work and will use the runner's own server-side provider configuration and credentials.

## Project boundaries

| Path | Responsibility |
| --- | --- |
| `src/data.mjs` | SQLite schema, exclusive lock, seed/reset and native services |
| `src/app.mjs`, `src/server.mjs` | Same-origin API, sessions and local startup |
| `src/web/` | React/TypeScript workspace and responsive styles |
| `src/task-read.mjs`, `extensions/task-read/`, `vendor/` | Scoped read adapter, trusted programs/model and integrity-pinned runtime package |
| `src/extension-lifecycle.mjs`, `src/extension-catalog.mjs` | Persisted review/approval/selection and shared curated dependency identities |
| `tests/` | Real persistence/API checks and browser journeys |
| `docs/` | [Scope](docs/scope.md), [native contract](docs/native-task-app-design.md), local operation and future design |
| `keir/` | Earlier extension material; current runnable reads are under `extensions/task-read/` |

React/Vite and Fastify provide the UI/server foundation. Native services and database constraints enforce validation and ownership. Auth transitions serialize across tabs; stale requests cannot adopt another person's scope. Reopening, deletion, tags, priority, dates, search and collaboration are outside this slice.

[keir-core](https://github.com/rore/keir-core) owns the shared roadmap, framework, roles and Work Records. See [real task reads](docs/real-task-reads.md) for rule behavior, authority, package provenance and regeneration. The planned pre-design-time walkthrough/checkpoint and host-design skill are not delivered; see [future walkthroughs](docs/scope.md#two-future-walkthroughs).

License selection and public release are pending. No open-source license grant is implied.
