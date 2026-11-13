# Running and recovering the local demo

Use Git and Node.js 24.14.1 with npm. Daymark includes its pinned Keir packages; a sibling Core checkout is unnecessary. One loopback process serves the built app and API, backed by Node's experimental SQLite API.

```sh
git clone https://github.com/rore/keir-demo-app.git
cd keir-demo-app
npm ci
npm run build
npm run seed -- --data-dir .data/try-daymark
npm start -- --port 4317 --data-dir .data/try-daymark
```

Open the printed `http://127.0.0.1:4317` address. Use a free port and a fresh private data directory for a separate instance. Seeding is optional on a new database; startup seeds it automatically. Keep the same directory when restarting. The example above does not configure an AI provider or contact one.

| Activity | Requirements |
| --- | --- |
| Startup and native task management | Node.js 24.14.1 and the installed project dependencies; no Java or provider credentials |
| Compile and simulate authored source without AI | Java 21 and the pinned compiler/runtime; Core's [quickstart](https://github.com/rore/keir-core/blob/main/docs/quickstart.md) provides this command-line path |
| Live conversational authoring in Daymark | Java 21 plus a supported provider/model and API key; requests may incur charges |
| Browser tests | Project dependencies, Playwright's pinned Chromium download and the platform's browser OS libraries |

Daymark's conversational authoring does not provide an offline generation mode. Reading saved conversations and outcomes makes no provider request; executing an approved artifact also requires no AI request.

## Local data

Default storage is `.data/app.sqlite`, protected by `.data/app.lock`. Optional `--data-dir <directory>` on start/seed/reset selects isolated storage, resolved relative to the current directory. Pass the same location to all commands. Data/backups may contain your task text; keep them private and out of Git. Seeded data contains no credentials.

New databases receive the fictional Maya, Leo and Sam accounts and sample data. Restart and seed preserve edits without duplicating fixtures. Start, seed and reset check database version, schema and integrity before writable use. Keep unrecognized databases with the app that created them. Sessions are in memory, so restart requires sign-in while saved work persists. See [lifecycle recovery](read-extension-lifecycle.md#limits-and-recovery).

Running native tasks requires Node 24.14.1, not Java or AI credentials. Optional authored-source compilation requires the independently packaged pinned compiler and Java 21. `KEIR_JAVA_BIN` may identify an existing Java executable in the app process's launch environment; it is trusted server configuration, not a request field. This setting does not install Java or change PATH/global configuration. If compilation is unavailable, native tasks and saved history remain usable.

For execution authority and saved outcomes, see [host integration](read-extension-lifecycle.md). When upgrading an older database, keep its matching app and verified backup, and [rehearse the cutover](read-extension-lifecycle.md#upgrade-an-earlier-database) on a separate copy.

## Stop and lock recovery

Use Ctrl+C in the owning terminal and wait for exit. Normal shutdown closes SQLite and releases the lock. A second start/seed/reset never stops the app or steals its lock.

A crash or forced termination, including Windows terminating a child process, can leave `app.lock`. Startup deliberately refuses it. Read its PID, verify the specific owning process has stopped, preserve your work, then deliberately remove that one lock file. PID absence alone is not an automatic cleanup rule. Never remove a live lock, delete the data folder to fix startup, or kill another process to free a port. If uncertain, keep the data and use another isolated `--data-dir`.

## Reset and restoration

After stopping the app, `npm run reset -- --confirm` acquires the lock and creates a unique backup under `.data/backups/`. It checks the current schema, SQLite integrity and foreign keys, compares native and customization rows to the source, then resets fixtures in one transaction. A backup failure prevents reset. A transaction failure restores previous rows. The lock stays held throughout.

For the isolated example above, stop its process with Ctrl+C before either command:

```sh
npm run seed -- --data-dir .data/try-daymark
npm run reset -- --confirm --data-dir .data/try-daymark
```

Seed retains saved changes. Reset deliberately restores demo fixtures and backs up this directory's database under `.data/try-daymark/backups/`; it does not reset the durable authoring spending ledger or refund provider costs. Use reset only when you intend to replace that instance's saved work.

To restore: stop the app, verify no process owns its lock, preserve current `app.sqlite` separately, then copy a selected verified backup over `app.sqlite` in the same data directory. Restart and inspect expected projects/tasks for all people. Never overwrite a live database. Tests reopen the generated backup and verify saved edits; automatic recovery does not guess which copy is right.

## Local security

Use the exact printed loopback origin. Only built files in `dist/` are public. Sign-in is fictional demo impersonation, not production authentication. Startup and native tasks make no provider requests or telemetry; AI authoring sends the [documented context](ai-authoring.md#configure-a-provider) to your provider. Setup contacts npm. See the [implementation reference](native-task-app-design.md#local-protocol-and-dependency-boundary) for request limits and exact-origin checks, and the [test guide](../tests/README.md#browser-checks) for optional browser downloads.

## Troubleshooting

| Symptom | Check or recovery |
| --- | --- |
| Source compilation unavailable | Check `java -version` in the launch terminal for Java 21 and retain the pinned compiler assets. Daymark selects `KEIR_JAVA_BIN`, then `JAVA_HOME/bin/java`, then `java`. A process-local override can select an existing executable without changing global PATH. Native tasks remain available. |
| Port already in use | Choose another `--port` and use the exact printed origin. Do not stop another app to free its port. |
| Data directory locked | Follow [lock recovery](#stop-and-lock-recovery); keep the database and never remove a live lock. A fresh isolated directory is an alternative. |
| AI settings unavailable or rejected | Use **Configure** with one of the exact [supported pairs](ai-authoring.md#configure-a-provider) and the full API key. Saving validates locally rather than testing the key. An invalid saved settings file fails closed instead of falling back to environment settings. |
| Provider rejects an authoring turn | Inspect the saved status before explicitly retrying. Check provider credentials, account access and rate limits; no reload automatically repeats a paid request. |
| Spending allowance exhausted | Existing reservations survive cancellation, settings changes and reset. Review the shared allowance in **Configure**; increasing it or leaving it uncapped permits further charges. Reset is not a refund. |


<a id="keir-1-cutover"></a>
<a id="http-and-dependencies"></a>
