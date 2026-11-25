# Sample host implementation reference

This contributor reference records the native-service guarantees behind Daymark's Keir adapters. Start with the [customization walkthrough](customization-walkthrough.md) to see Keir in action; use this page when maintaining the sample host.

## Small application boundary

Daymark uses React/TypeScript with Vite, a small same-origin Fastify API/static host and `node:sqlite` native services. No ORM, SSR, cloud database or generic transport framework. Studio uses the same app shell and the authoring/lifecycle APIs; see the [implementation map](../src/README.md). Node 24.14.1 is the existing qualification runtime; its SQLite API is experimental and must be documented and tested, not described as stable or made a reason to upgrade installed tools. Pin actual qualified packages in the lockfile.

Daymark is a reference host for a Keir authoring agent. [Reusable turn logic](../src/keir-authoring-agent.mjs) handles intent, tool calls and exact draft handles without depending on task hooks. An [offline alternate-host check](../tests/authoring-agent.test.mjs) exercises that separation. This is code inside the reference app, not a packaged SDK or portable Studio UI. Daymark supplies the [Personal instructions and bindings](../src/authoring-agent.mjs), the [Team catalog and scoped tools](../src/team-authoring-host.mjs), and [authenticated Team turns, confirmation and automatic checks](../src/team-authoring-turns.mjs). The host owns the durable conversation and spending journal, permission checks, native data and evidence. People approve drafts and turn them on; the assistant cannot do either or write live tasks.

Bind loopback only. Built startup serves the native app from one local process. Native app startup does not require AI, Java, a core sibling checkout or a browser download. Three explicitly fictional demo identities represent three independent customer scopes; use Maya, Leo and Sam for consistency with the separate Studio prototype.

## Session and request context

- The server issues an opaque HttpOnly SameSite session cookie; session mapping is in memory. Restart retains data but requires sign-in again. Sign-in accepts only a known seeded identity, not arbitrary owner context.
- Each session has a separate unpredictable request-context token returned through same-origin session bootstrap. Every data request carries the token captured with its initiating UI scope; it must match the current cookie's live session. An old A context paired with B's current cookie must fail before reading or writing either user's data. Never derive owner from request payload/query.
- Check the configured Host including port; mutation, sign-in and sign-out require exact same-origin Origin including port, JSON content type where a body is accepted and bounded request bodies. Reject absent/null/foreign mutation origins, unsupported content types and broad CORS. Cookie settings alone are insufficient CSRF protection.
- Switching creates a new session and revokes the old one; never mutate an existing session's owner. Revalidate the captured live session immediately before the synchronous database operation, after the final asynchronous boundary. Do not yield between authorization and the transaction. Already committed A work remains A's work; sign-out cannot undo it.
- Only explicit serialized authentication transitions write/clear cookies. A stale ordinary API response must not clear B's cookie or replace it with A's. Do not abandon an auth request and start a competing auth transition. Clear client data/drafts/errors immediately on switch; abort old data requests and ignore stale-generation responses. Cross-tab stale contexts fail and require bootstrap.
- Missing and foreign resources have the same not-found response. Render untrusted text as text, serve only intended public assets and keep session/data responses uncached.

## Data model and storage

Projects have an opaque stable ID, server-owned user, required trimmed name (1–80 characters) and creation/update timestamps. Tasks have an opaque ID, a project, title (1–120), notes (0–4000), status `open` or `completed`, creation/update timestamps and a completion timestamp exactly when completed. Ownership is immutable. Derive task ownership through its project, or enforce an owner-consistent composite foreign key; independent disagreeing owner fields are not acceptable.

Native operations create/list/rename projects and create/list/get/edit/complete tasks. Completion is idempotent under current access. Reopening and deletion are outside this slice. Personal queries stay owner-scoped; Team access checks current project membership separately. Use parameterized queries, `NOT NULL`/status checks and enabled/verified foreign keys on every connection. Make seed and multi-statement operations transactional. Invalid operations leave prior data unchanged.

### Team projects

Schema 15 adds Personal-default project mode, Team membership, task creator/assignee and immutable child origin. Existing data stays Personal. Upgrades do not seed shared projects or change saved Personal selections, drafts, events, receipts or settings.

Choose **New project** next to the project list, then choose **Team**. New projects default to Personal. The creator becomes the first Team admin. Use **Project settings → Manage members** to add an existing demo user. Members can use **View members** beside the project name. The project starts with no policy. Current members can read the membership list through `GET /api/projects/:id/members`; only a current admin can add an existing user through `POST` on that route.

#### Author a Team customization

Select the Team project in **Customizations** and choose **New customization**, or **Open Studio** to continue saved work. Ask Daymark to add a linked review for Leo when someone adds a task, then keep the original task open until the review is done. Linked reviews do not start another creation rule. Check the proposed project, assignee, matching tasks and completion behavior before confirming. Resolve ambiguity and agree explicitly before leaving out an unsupported part. Daymark cannot send email, schedule reminders, set automatic due dates or update the original task with a Team rule. Only project admins can open Team Studio. If the assistant is not set up, **Configure** opens the [same provider settings](ai-authoring.md#configure-a-provider) as Personal Studio.

Choose **Confirm this behavior** to compile and save the exact draft, then automatically check its independently recorded expectations. An intentionally unused completion rule is saved as an absent binding, not a missing artifact. The checks run the saved artifacts through native services in disposable in-memory stores with synthetic people, tasks and interruptions. Real tasks and current use do not change. Use **Check examples** to recheck an existing draft, not as a separate first step.

Under **Examples**, open **See how it works** for a business example. If a business example fails, Studio shows what it expected and what happened. A missing, stale or insufficient check blocks approval even if some examples pass. Changed behavior needs a fresh agreement, revision and check. Earlier scripted revisions still use their saved lifecycle and strict six-example qualification; that is not the contract for new authored drafts.

Choose **Approve this draft** to record approval of the exact revision and its latest eligible evidence. A newer check needs a new approval, even if it passes. Separately choose **Turn on for new tasks** to select that revision. Already-started work keeps its saved rule or explicit no-policy choice. A new draft or a failed check does not replace the rule in use.

Choose **Back to project Tasks**. After a rule denies completion, the row and Task details show the last attempt's reason. You can open a verified linked task from the original task's details. A linked task alone does not establish a hold, and an earlier denial does not prove that a hold still applies. If linked creation is unconfirmed, use **Check again** to read the saved result. This does not rerun the rule or prove that no task was created.

#### Read back or stop Team use

After an unconfirmed preparation or example check, use the readback control shown by Studio. After an unconfirmed approval, activation, deactivation or revocation, choose **Check saved action**. It checks the original action without resubmitting. If Daymark cannot find the saved result, the current state alone does not prove what happened. Do not repeat an unconfirmed action or change its target. Raw evidence and receipts remain available through the existing technical interfaces.

When a customization is on, choose **Turn off for new tasks**, then **Confirm stop for new tasks**. Started work keeps its pinned rule unless that revision is revoked. New tasks save a no-policy choice until another rule is selected.

Under **Advanced: emergency revocation**, choose the **Version to revoke**. Use **More versions** if needed, then choose **Review emergency revocation**. Check the selected version and consequences before choosing **Permanently revoke this version**. The list includes earlier versions. Counts are a guide: completed tasks may still have unfinished rule actions.

Revocation permanently blocks that revision's future effects and completion of unfinished main tasks pinned to it. It clears the selection only if that exact revision is selected. Completed work, saved children and receipts are not undone. Verified linked tasks can still be completed. To replace a revoked draft, propose fresh behavior in the conversation, confirm and check it, then approve and turn it on separately. There is no repair, restore or repinning action. The manual fixture below is separate from Studio.

### Disposable native policy preview

The separate fixture below manually installs two compiled revisions to demonstrate native policy execution. It is not the Team Studio lifecycle. The three-operation Team catalog supports task reads, a provenance-filtered child summary and one linked create. Policy source chooses the child's title and assignee. Effects never admit another creation event.

In a separate checkout with qualified Node 24.14.1, Java 21 and dependencies, build and create a **new disposable directory**:

```sh
npm run build
node scripts/team-native-fixture.mjs .data
node src/server.mjs --data-dir .data --port 3179
```

The fixture refuses any existing directory. Do not use it with saved or live data. Sign in as Maya, choose **Shared collection**, and add a task. Its details link to the created review. Early completion is denied. Switch to Leo, choose the same project, complete the assigned review, then return as Maya and complete the original task. No provider call is used.

Current members can read, search and create. An admin or the assignee may edit/complete assigned work. For unassigned work, an admin or the creator may act. Storage `owner_id` remains the project's storage key, not the acting member. Create replay and reaction/reconciliation reads recheck current membership. Personal adapters and authoring projections cannot read or write Team data.

Each root saves an explicit no-policy marker or an immutable revision in its creation transaction. Selection changes and deactivation affect new roots only. A required but missing hook blocks completion. Revocation blocks covered execution. Completion evaluates the real read-only runtime outside SQLite, then rechecks current session, membership, assignment, saved pin, deadline, revocation and read facts inside its native transaction.

A claimed creation runs at most once. The native child, immutable origin and original-key receipt commit together. Reconciliation reads that key without invoking Keir. Runtime outcome and native observation stay separate. An open or unconfirmed attempt stays unresolved. A closed, fenced no-write attempt stays blocked when the pinned gate requires a child; this preview has no repair or retry action.

### Priority and due time

A task has low, normal or high priority. New and existing tasks default to normal. Native requests and responses use `priority` with the values `low`, `normal`, or `high`, and `dueAt` with a canonical UTC instant in `YYYY-MM-DDTHH:mm:ss.sssZ` form or `null`. Supported UTC years are 0001 through 9999. Omission on create uses the default. Omission on edit preserves the saved field, and `dueAt: null` clears the time. Edits to priority, due time or tags can leave title and notes untouched. When an edit supplies either title or notes, it supplies and validates both.

Task details accepts local date and time in the labeled browser time zone. It rejects newly entered times that are skipped or repeated when the offset changes. The task display shows the saved local time and its offset. Editing unrelated fields keeps the saved instant, including its milliseconds and the exact occurrence of a repeated local time.

Schema 11 adds priority and due time to the exact shipped schema 10. Existing tasks start with no due time. Startup validates format, schema identity, database integrity and foreign keys, then applies the upgrade transactionally. Prior values, IDs, relationships, and extension records are preserved. Confirmed reset requires the current schema and refuses schema 10 before backup or modification. Back up a live database and verify restoration before the first separately approved upgraded startup. A pre-upgrade backup is needed to run the earlier app again, and restoration returns the data to that backup's point in time.

### Tags and project search

Task details accepts up to eight optional tags. Separate tags with commas. A tag is trimmed, normalized to NFC, lowercased and normalized to NFC again. Each normalized tag is 1–32 UTF-16 units. Commas, control characters and malformed Unicode are invalid in a tag. Repeated tags count once after normalization. Native task responses include `tags` as an array. Create defaults to `[]`. Edit preserves tags when omitted and clears them with `[]`. A tags-only edit updates tags and the modification time while preserving the stored title and notes bytes.

**Search tasks** finds open and completed tasks in the selected project by text in the title or notes, by an exact tag, or by both. Text search treats punctuation literally and folds ASCII case. Non-ASCII text matches case exactly. Tag lookup uses the same normalization as saving tags. Search and tag editing are available with extensions and AI off.

`GET /api/projects/:id/tasks/search` uses the existing authenticated session context. Its only query parameters are `q`, `tag` and `after`, each supplied at most once. Supply at least one filter. A supplied `q` is trimmed, 1–120 UTF-16 units, well-formed and free of control characters. Both supplied filters must match. Responses contain `items` and `nextAfter`. Pages contain up to 25 matching tasks ordered by creation time and ID. Pass `nextAfter` with the same filters to continue. A missing or foreign anchor has the same not-found response. A null cursor means there were no further matches at read time. Paging reads current data, so changes before the cursor appear on refresh. Clearing search returns to the ordinary project list.

Schema version 9 adds an empty tag list to existing rows. It preserves task IDs, ownership, text, timestamps, and saved extension and effect data. Before updating a live database, back it up before the first upgraded startup and verify restoration. An older app rejects version 9. Restoring the pre-upgrade backup also rolls back writes made since that backup.

Keep one ignored local database. Seed only on initial creation or explicit reset; normal restart never overwrites edits. Startup and reset acquire the same exclusive project-data lock; a second process fails safely without stopping another. Reset requires explicit confirmation and a verified recoverable backup, holds the lock throughout and leaves original data intact if backup fails. Prefer transactional data reset over deleting files; verify backup restoration and rollback on failure. A stale lock must be reported with deliberate recovery instructions, never guessed safe or forcibly removed from another process.

## Native visual and interaction direction

The shared lockup reads Daymark with A KEIR Demo directly below on welcome, desktop navigation and the narrow header. Daymark uses white/mineral surfaces, dark ink, blue-black actions, restrained rust errors, fine borders and shared sans-serif typography. A persistent Tasks/Customizations rail and owner header surround independently scrolling content. Projects scroll inside their own rail section. Tasks retain visible completion, quick add and a native detail dialog. Studio shares controls and states and presents rule explanations and simulation in the conversation. The earlier advice-sheet canvas is [historical](historical/extension-studio-canvas-design.md). Avoid decorative metrics, gradients and unused navigation.

Desktop should show project navigation and the task list together. On narrow screens use a clear project selector and full-width task/detail view; do not compress a desktop sidebar into unreadable columns. Use semantic labeled forms, visible keyboard focus, inline validation, accessible completion controls and predictable detail-panel close/return-focus behavior. User selection/sign-out must be visible. Review actual desktop/mobile screens for normal, empty, loading, field error, API failure and expired-session states before claiming polish.

## Required checks

- Fast service/API tests use real temporary SQLite: normal CRUD/completion, bounds, missing/foreign IDs, forged owners, cross-owner project association, transaction rollback, idempotent seeds and persistent restart for all three users.
- Session tests include old-cookie replay, A token plus B cookie, revoked sessions waiting for request bodies, delayed API responses, delayed auth responses, serialized sign-out/switch and cross-tab stale context. Assert that forbidden requests change neither user's data.
- Reset tests cover startup/reset contention, second-server refusal, active-server refusal, backup failure, backup integrity/restoration and failed reset rollback. Use isolated paths only.
- Browser journeys cover three logins, project/task creation/edit/completion, sign-out/switch, delayed responses, restart, keyboard use and desktop/mobile empty/error screens. Every test owns its process, port and database; never attach to or stop the operator's app.
- Measure default test duration; keep browser setup and any slow/live checks separate. Verify a pinned clean install/build/start and document launch/reset. A future pre-design-time checkpoint must explicitly identify the native baseline it preserves; the current app already includes Keir integration.

<a id="creation-attempts-and-readback"></a>
## Native task creation

Task creation has a separate attempt identity so a lost response does not cause a duplicate task. This protocol belongs to Daymark. Automation keeps its existing original event key and native effect receipts.

### Create and read back

`POST /api/tasks` requires the usual current demo session, session-context header, same origin and JSON content type, plus `X-Task-Create-Id` containing a UUID. The business body remains `{projectId,title,notes?,tags?,priority?,dueAt?}`. Internal native callers supply the UUID separately as `createTask(owner,input,{operationId})`.

Choose a new UUID for an explicit attempt and retain it with the submitted body. The server normalizes the full candidate once using native field rules. Reusing the same ID and equivalent normalized candidate returns the original terminal result. Reusing it with a different candidate returns `409 CREATE_PAYLOAD_MISMATCH`; this does not prove that the original attempt failed. Different IDs are separate attempts, even with identical fields.

A confirmed creation returns `201 TaskDto`. A replay returns the same original task snapshot, including after that task is edited or deleted. It never recreates the task. Refresh the current authorized task list before rendering current task state; do not append the saved snapshot to it.

A confirmed no-create response has this closed body:

```json
{"operationId":"<attempt UUID>","state":"NOT_CREATED","code":"RULE_DENIED","message":"Add a due date for this task."}
```

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `RULE_DENIED` | 422 | The current rule denied the attempt. |
| `CHECK_UNAVAILABLE` | 503 | The selected rule could not be checked. |
| `STALE_ATTEMPT` | 409 | The attempt expired, was cancelled, or its rule changed. |
| `NATIVE_REJECTED` | 422 | Native validation rejected the normalized candidate. |

Only a validated terminal envelope for the matching attempt confirms no creation. A bare error or status code does not. Invalid input that cannot be normalized receives ordinary validation failure before a terminal result is recorded.

`GET /api/task-create-operations/:operationId` requires the current session and returns `{operationId,state:"CREATED",task}`, the saved `NOT_CREATED` envelope, or exactly `{operationId,state:"UNRESOLVED"}`. It never starts creation. An absent result remains unresolved because the original request may still finish.

After uncertainty, retain both the editable draft and the separate frozen attempt. Read back first. If still unresolved, an explicit retry uses the same ID and frozen body. Do not automatically resubmit, change the payload under that ID, or allocate another ID while the original attempt is unresolved. After confirmed no-create, an explicit correction is a new attempt with a new ID.

### Access and persistence

Tasks, their ordinary creation events and successful terminal results commit together. Confirmed no-create results contain no task or event. A matching concurrent winner takes precedence over a later allow or denial. Terminal results are immutable across ordinary restart and task edits/deletion.

Every saved-result read and replay checks the current session, owner and access to the original project. Project access loss returns a generic access error without the saved snapshot or rule message. A different owner cannot read the result by knowing its UUID.

The exclusive destructive demo reset backs up and clears these records with the tasks. Its newly seeded projects have different IDs. A retained attempt must remain bound to its original owner and exact project ID; never retarget it to the new default project. Browser drafts and attempt IDs are not promised to survive page reload.

## Local protocol and dependency boundary


Use the exact printed `127.0.0.1` origin and port. Host is checked on every request. Sign-in/out and mutations also require the exact Origin, bounded JSON and expected session context. API responses are uncached; ordinary API responses never write cookies. Only `dist/` is public. Authored source is UTF-8 text up to 64 KiB. Scenario documents are submitted as raw JSON strings (1–8, each at most 64 KiB and 128 KiB together) so duplicate keys reach the strict native parser unchanged. The preparation routes accept up to 1 MiB JSON; decoded source and case limits still apply.

Ordinary local startup and task management add no provider calls or telemetry. Live authoring explicitly sends context to the configured provider; see [provider context and local storage](ai-authoring.md#configure-a-provider). The server uses a loopback listener and exact-origin checks. Setup contacts npm. The scoped `glob` override replaces the static plugin's vulnerable transitive version with qualified `14.0.3`; remove it only when the plugin ships an independently checked fixed dependency range. Never use a blanket forced dependency upgrade.

`npm run test:browser:install` downloads pinned Chromium from Playwright's CDN into ignored `.tools/playwright/`; it does not install Linux OS libraries. Provisioning those libraries is a separate system setup step. See [browser checks](../tests/README.md#browser-checks) before running the suite; native app startup needs neither this browser download nor those test dependencies.

## Keir 1 cutover

Use the previous app to settle eligible pending Keir 1 work. Keep a verified backup with that app version and rehearse the upgrade on a separate copy. Keir 2 checks for pending work inside the migration transaction and refuses to switch while any pending event lacks a durable revocation. Revoked pending events remain visible as historical evidence. Both Keir 2 selections start off and previous selections become historically unavailable. Started or uncertain outcomes remain available for reconciliation.

To rehearse a restore, retain the upgraded copy separately and reopen the verified pre-cutover backup with the previous app in an isolated directory. Review any writes accepted since the backup before restoring it over a later database.

Cookie/server session establishes identity; a separate context token binds each request to its initiating UI scope. Queries remain owner-scoped. A write committed before sign-out remains that person's write; cancellation cannot undo it. Stale tabs return to sign-in instead of adopting a new cookie's identity. Current browsers with Web Locks and BroadcastChannel are required; pinned Playwright Chromium is qualified. Demo sign-in is deliberate impersonation, not production IAM.

The one-second operation budget reserves 100 ms for native revalidation and commit when invoking a nested guard. The original reserve measurement was 40 disk-backed creates, maximum 26.17 ms including two READs; it is not a four-READ worst-case bound or latency guarantee.
