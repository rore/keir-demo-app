# Daymark · Keir Demo App

A small local task workspace: projects, tasks, notes and a satisfying completion flow. Sign in as Maya, Leo or Sam, three fictional demo people with independent data. Your work stays in a local SQLite database across restarts.

The shared app lockup shows **Daymark** with **A KEIR Demo** directly beneath it. Use **Tasks** for native work and **Customizations** to describe a change or reopen a named saved item. The implemented candidate reacts to a new task completion by creating a task in an existing project, using the published `TaskCompleted` contract. The assistant discovers accessible projects, clarifies the target and title, then checks synthetic matching and nonmatching examples. Review the expected and observed task behavior, approve it, then separately turn it on. Several customizations can be saved; one is selected at a time. Activation creates nothing and replays no earlier completions.

Real execution uses the current task contract, compatible runtime binding and native host permission checks; integrated release qualification is still pending. An unavailable customization binding keeps native tasks usable and explains why customizations cannot run. See [task effects](docs/task-effects.md). Earlier task-advice and scripted-example execution paths are retired; their saved source, examples and history remain readable. Task details have a **Customizations** shortcut, and returning preserves unsaved title/notes. Running native tasks needs no AI credentials, Java, hosted database or sibling repository. Demo sign-in is local impersonation, not production authentication.

## Run locally

Prerequisite: **Node.js 24.14.1** with npm. Its `node:sqlite` API is experimental. Nothing here installs or upgrades global tools. Package versions are pinned in `package-lock.json`.

For tool authors who want to learn Keir, see the [core manual authoring guide](https://github.com/rore/keir-core/blob/main/docs/manual-authoring.md).

AI authoring is optional and server-side. The provider can draft but cannot approve or activate a customization. People review exact evidence and make both decisions. The local Configure dialog stores settings in the app data directory. See the [AI authoring guide](docs/ai-authoring.md) for key handling, shared spending limits and environment fallback. New source compilation requires the pinned compiler and Java 21; the app installs neither.

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

The full authoring regression requires Java 21; it does not install Java or change global settings. Build first, then run:

```sh
npm test
npm run test:browser:install
npm run test:e2e
```

Native regression uses temporary data. Browser setup downloads separate test Chromium **inside `.tools/playwright/`** without changing installed browsers/profiles. Browser journeys own their servers, ports and databases; they never reuse an operator app. After browser setup, `npm run test:all` runs both suites. See [test details](tests/README.md).

## Studio and its design reference

The functional Studio shares Daymark's navigation and controls. Conversation leads, with one current decision. A named example opens beside its exchange on request; on a phone it takes the available workspace. Closing it returns to the same place in chat. History and technical inspection are secondary. See the [experience and design reference](docs/extension-studio-design.md).

The earlier scripted prototype remains available with `node docs/extension-studio/serve.mjs` at [the prototype address](http://localhost:4179/); it is a separate historical design reference. See the [current customization lifecycle](docs/read-extension-lifecycle.md) for review, activation and retained history. Tool authors can use the [core manual authoring guide](https://github.com/rore/keir-core/blob/main/docs/manual-authoring.md).

## Project boundaries

| Path | Responsibility |
| --- | --- |
| `src/data.mjs` | SQLite schema, exclusive lock, seed/reset and native services |
| `src/app.mjs`, `src/server.mjs` | Same-origin API, sessions and local startup |
| `src/web/` | React/TypeScript workspace and responsive styles |
| `src/task-effects.mjs`, `src/task-effect-simulation.mjs`, `extensions/task-effect/` | Native completion reaction, synthetic effect checks and published task contract |
| `vendor/` | Pinned runtime/compiler packages and provenance |
| `src/extension-lifecycle.mjs`, `src/extension-catalog.mjs` | Persisted review/approval/selection and shared curated dependency identities |
| `tests/` | Real persistence/API checks and browser journeys |
| `docs/` | [Scope](docs/scope.md), [native contract](docs/native-task-app-design.md), local operation and future design |
| `extensions/task-read/`, `keir/` | Retained earlier read-only material, outside the current execution offer |

React/Vite and Fastify provide the UI/server foundation. Native services and database constraints enforce validation and ownership. Auth transitions serialize across tabs; stale requests cannot adopt another person's scope. Reopening, deletion, tags, priority, dates, search and collaboration are outside this slice.

[keir-core](https://github.com/rore/keir-core) owns the shared roadmap, framework, roles and Work Records. See [retired task reads](docs/real-task-reads.md) for the earlier contract and [task effects](docs/task-effects.md) for current authority and verification limits. The planned pre-design-time walkthrough/checkpoint and host-design skill are not delivered; see [future walkthroughs](docs/scope.md#two-future-walkthroughs).

License selection and public release are pending. No open-source license grant is implied.
