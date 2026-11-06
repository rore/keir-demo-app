# Running and recovering the local demo

Use Node.js 24.14.1 with npm. From the repository root, run `npm ci`, `npm run build`, then `npm start`. One loopback process serves the built app and API, backed by Node's experimental SQLite API. Startup binds the task contract to native implementations. See [task effects](task-effects.md) for runtime compatibility and host authority.

Open **Tasks** to select a project and edit tags in a task's details. In that project, **Search tasks** looks in titles and notes, and **Filter by tag** matches a tag. If you enter both, results must match both. Use **Clear** to return to the project list of tasks.

Open **Customizations** to start a rule or reopen its saved conversation. On narrow screens use the **Destination** selector. Opening a saved link reads owner-authorized work without sending an authoring turn. Drafts, approvals, selections, history and completion receipts persist. Unsaved task edits survive view navigation within the same session and are discarded on sign-out or owner switch. See [review and use a customization](read-extension-lifecycle.md).

## Local data

Default storage is `.data/app.sqlite`, protected by `.data/app.lock`. Optional `--data-dir <directory>` on start/seed/reset selects isolated storage, resolved relative to the current directory. Pass the same location to all commands. Data/backups may contain your task text; keep them private and out of Git. Seeded data contains no credentials.

New databases receive the fictional Maya, Leo and Sam accounts and sample data. Restart and seed preserve edits without duplicating fixtures. Start, seed and reset check database version, schema and integrity before writable use. Keep unrecognized databases with the app that created them. Sessions are in memory, so restart requires sign-in while saved work persists. See [lifecycle recovery](read-extension-lifecycle.md#limits-and-recovery).

Running native tasks requires Node 24.14.1, not Java or AI credentials. Optional authored-source compilation requires the independently packaged pinned compiler and Java 21. `KEIR_JAVA_BIN` may identify an existing Java executable in the app process's launch environment; it is trusted server configuration, not a request field. This setting does not install Java or change PATH/global configuration. If compilation is unavailable, native tasks and saved history remain usable.

Real task reactions require compatible current-contract bytes, an approved and enabled customer revision, and current native host permission. The runtime binds the complete native implementation map once; each invocation supplies fresh owner/event/original-key/deadline context. Invalid binding or preparation leaves customization execution unavailable while native CRUD remains usable. Passing simulation or approving a draft does not establish native permission. Disable and deletion durably revoke captured work without a separate credential file. See [task effects](task-effects.md) for authority, legacy isolation and revocation limits.

After adding or completing a task, the UI reads its saved reaction separately. **Check result** performs a status read. **Reconcile saved observation** checks existing native receipt state. The original runtime outcome remains available alongside later native observations. A confirmed receipt can link an affected task only after the current owner can read it.

## Keir 1 cutover

Use the previous app to settle eligible pending Keir 1 work. Keep a verified backup with that app version and rehearse the upgrade on a separate copy. Keir 2 checks for pending work inside the migration transaction and refuses to switch while any pending event lacks a durable revocation. Revoked pending events remain visible as historical evidence. Both Keir 2 selections start off and previous selections become historically unavailable. Started or uncertain outcomes remain available for reconciliation.

To rehearse a restore, retain the upgraded copy separately and reopen the verified pre-cutover backup with the previous app in an isolated directory. Review any writes accepted since the backup before restoring it over a later database.

Cookie/server session establishes identity; a separate context token binds each request to its initiating UI scope. Queries remain owner-scoped. A write committed before sign-out remains that person's write; cancellation cannot undo it. Stale tabs return to sign-in instead of adopting a new cookie's identity. Current browsers with Web Locks and BroadcastChannel are required; pinned Playwright Chromium is qualified. Demo sign-in is deliberate impersonation, not production IAM.

## Stop and lock recovery

Use Ctrl+C in the owning terminal and wait for exit. Normal shutdown closes SQLite and releases the lock. A second start/seed/reset never stops the app or steals its lock.

A crash or forced termination, including Windows terminating a child process, can leave `app.lock`. Startup deliberately refuses it. Read its PID, verify the specific owning process has stopped, preserve your work, then deliberately remove that one lock file. PID absence alone is not an automatic cleanup rule. Never remove a live lock, delete the data folder to fix startup, or kill another process to free a port. If uncertain, keep the data and use another isolated `--data-dir`.

## Reset and restoration

After stopping the app, `npm run reset -- --confirm` acquires the lock and creates a unique backup under `.data/backups/`. It checks the current schema, SQLite integrity and foreign keys, compares native and customization rows to the source, then resets fixtures in one transaction. A backup failure prevents reset. A transaction failure restores previous rows. The lock stays held throughout.

To restore: stop the app, verify no process owns its lock, preserve current `app.sqlite` separately, then copy a selected verified backup over `app.sqlite` in the same data directory. Restart and inspect expected projects/tasks for all people. Never overwrite a live database. Tests reopen the generated backup and verify saved edits; automatic recovery does not guess which copy is right.

## HTTP and dependencies

Use the exact printed `127.0.0.1` origin and port. Host is checked on every request. Sign-in/out and mutations also require the exact Origin, bounded JSON and expected session context. API responses are uncached; ordinary API responses never write cookies. Only `dist/` is public. Authored source is UTF-8 text up to 64 KiB. Scenario documents are submitted as raw JSON strings (1–8, each at most 64 KiB and 128 KiB together) so duplicate keys reach the strict native parser unchanged. The preparation routes accept up to 1 MiB JSON; decoded source and case limits still apply.

No public listener, production credentials, broad CORS, telemetry or provider calls are added. Setup contacts npm. The scoped `glob` override replaces the static plugin's vulnerable transitive version with qualified `14.0.3`; remove it only when the plugin ships an independently checked fixed dependency range. Never use a blanket forced dependency upgrade. Browser setup contacts Playwright's CDN and stores test binaries inside the ignored project directory.
