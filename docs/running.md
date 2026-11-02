# Running and recovering the local demo

Use Node 24.14.1, `npm ci`, `npm run build`, then `npm start`. One loopback process serves the built app and API. SQLite is experimental in this qualification runtime; these tests do not certify other runtimes or production operation.

The browser title and host identity are Daymark, powered by Keir. Tasks and Customizations are normal destinations; narrow screens provide a labeled Destination selector and a project selector in Tasks. Studio's Conversation / Preview controls also appear on short screens. Navigation uses local view state; reloading returns to Tasks while server-held advice, drafts, approvals and history persist. Unsaved native fields survive view navigation within the current owner session, and are discarded on sign-out or owner switch. Package names, cookies, storage locations and startup commands retain their existing identifiers.

## Local data

Default storage is `.data/app.sqlite`, protected by `.data/app.lock`. Optional `--data-dir <directory>` on start/seed/reset selects isolated storage, resolved relative to the current directory. Pass the same location to all commands. Data/backups may contain your task text; keep them private and out of Git. Seeded data contains no credentials.

Only new databases receive Maya/Leo/Sam and fixtures. Restart and seed preserve edits without duplicating fixtures. The read-only lifecycle adds a transactional schema-1-to-2 upgrade that retains native rows and records legacy advice as operator configuration, without inventing customer approval. Retain a recoverable backup before deliberately upgrading an existing installation; see [lifecycle recovery](read-extension-lifecycle.md#limits-and-recovery). Unknown schema versions, lock contention and database failures are errors, never reasons to discard data. Sessions are in memory; restart requires sign-in while tasks and lifecycle choices persist.

Cookie/server session establishes identity; a separate context token binds each request to its initiating UI scope. Queries remain owner-scoped. A write committed before sign-out remains that person's write; cancellation cannot undo it. Stale tabs return to sign-in instead of adopting a new cookie's identity. Current browsers with Web Locks and BroadcastChannel are required; pinned Playwright Chromium is qualified. Demo sign-in is deliberate impersonation, not production IAM.

## Stop and lock recovery

Use Ctrl+C in the owning terminal and wait for exit. Normal shutdown closes SQLite and releases the lock. A second start/seed/reset never stops the app or steals its lock.

A crash or forced termination, including Windows terminating a child process, can leave `app.lock`. Startup deliberately refuses it. Read its PID, verify the specific owning process has stopped, preserve your work, then deliberately remove that one lock file. PID absence alone is not an automatic cleanup rule. Never remove a live lock, delete the data folder to fix startup, or kill another process to free a port. If uncertain, keep the data and use another isolated `--data-dir`.

## Reset and restoration

After stopping the app, `npm run reset -- --confirm` acquires the lock and creates a unique backup under `.data/backups/`. It checks SQLite integrity/foreign keys and compares every native row to the source, then resets fixtures in one transaction. Backup failure prevents reset; transaction failure restores previous rows. The lock stays held throughout. Backups remain for deliberate recovery; no retention job deletes them.

To restore: stop the app, verify no process owns its lock, preserve current `app.sqlite` separately, then copy a selected verified backup over `app.sqlite` in the same data directory. Restart and inspect expected projects/tasks for all people. Never overwrite a live database. Tests reopen the generated backup and verify saved edits; automatic recovery does not guess which copy is right.

## HTTP and dependencies

Use the exact printed `127.0.0.1` origin and port. Host is checked on every request. Sign-in/out and mutations also require the exact Origin, bounded JSON and expected session context. API responses are uncached; ordinary API responses never write cookies. Only `dist/` is public.

No public listener, production credentials, broad CORS, telemetry or provider calls are added. Setup contacts npm. The scoped `glob` override replaces the static plugin's vulnerable transitive version with qualified `14.0.3`; remove it only when the plugin ships an independently checked fixed dependency range. Never use a blanket forced dependency upgrade. Browser setup contacts Playwright's CDN and stores test binaries inside the ignored project directory.
