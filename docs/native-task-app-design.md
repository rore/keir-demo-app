# Native task app: first implementation contract

Status: implemented native baseline with the current Daymark presentation described below. The core-owned `agent-workflow:native-task-app` record carries native delivery evidence; `agent-workflow:demo-customization-experience` carries the shared-shell correction and rendered review. This local demo is not a production identity platform.

## Small application boundary

Daymark uses React/TypeScript with Vite, a small same-origin Fastify API/static host and `node:sqlite` native services. No ORM, SSR, cloud database or generic transport framework. Studio uses the same app shell and the authoring/lifecycle APIs; see the [implementation map](../src/README.md). Node 24.14.1 is the existing qualification runtime; its SQLite API is experimental and must be documented and tested, not described as stable or made a reason to upgrade installed tools. Pin actual qualified packages in the lockfile.

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

Native operations create/list/rename projects and create/list/get/edit/complete tasks. Completion is idempotent. Reopening, deletion and sharing are outside this slice. Use parameterized owner-scoped queries, `NOT NULL`/status checks and enabled/verified foreign keys on every connection. Make seed and multi-statement operations transactional. Invalid operations leave prior data unchanged.

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
