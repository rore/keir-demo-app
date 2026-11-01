# Native task app: first implementation contract

Status: accepted technical/visual direction for the native slice; implementation and rendered verification remain pending. The core-owned `agent-workflow:native-task-app` record carries review and delivery evidence. This local demo is not a production identity platform.

## Small application boundary

Use React/TypeScript with Vite, a small same-origin Fastify API/static host and `node:sqlite` native services. No ORM, SSR, cloud database, generic transport framework or Studio implementation. Node 24.14.1 is the existing qualification runtime; its SQLite API is experimental and must be documented and tested, not described as stable or made a reason to upgrade installed tools. Pin actual qualified packages in the lockfile.

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

Native operations create/list/rename projects and create/list/get/edit/complete tasks. Edit title/notes and, if exposed, move only to another project owned by the same user. Completion is idempotent; reopening, deletion, sharing, tags, priority, dates and search are outside this slice. Use parameterized owner-scoped queries, `NOT NULL`/status checks and enabled/verified foreign keys on every connection. Make seed and multi-statement operations transactional; invalid operations leave prior data unchanged.

Keep one ignored local database. Seed only on initial creation or explicit reset; normal restart never overwrites edits. Startup and reset acquire the same exclusive project-data lock; a second process fails safely without stopping another. Reset requires explicit confirmation and a verified recoverable backup, holds the lock throughout and leaves original data intact if backup fails. Prefer transactional data reset over deleting files; verify backup restoration and rollback on failure. A stale lock must be reported with deliberate recovery instructions, never guessed safe or forcibly removed from another process.

## Native visual and interaction direction

Use warm off-white paper, forest-green selection/actions, dark ink, restrained rust errors, fine borders and clear local typography. Keep the layout compact and useful: a project rail, clear current user/project context, task list with visible completed states, quick add and a task-detail panel. Avoid decorative metrics, gradients and unused navigation. The Studio prototype shares a visual vocabulary but does not dictate a production component API.

Desktop should show project navigation and the task list together. On narrow screens use a clear project selector and full-width task/detail view; do not compress a desktop sidebar into unreadable columns. Use semantic labeled forms, visible keyboard focus, inline validation, accessible completion controls and predictable detail-panel close/return-focus behavior. User selection/sign-out must be visible. Review actual desktop/mobile screens for normal, empty, loading, field error, API failure and expired-session states before claiming polish.

## Required checks

- Fast service/API tests use real temporary SQLite: normal CRUD/completion, bounds, missing/foreign IDs, forged owners, cross-owner project association, transaction rollback, idempotent seeds and persistent restart for all three users.
- Session tests include old-cookie replay, A token plus B cookie, revoked sessions waiting for request bodies, delayed API responses, delayed auth responses, serialized sign-out/switch and cross-tab stale context. Assert that forbidden requests change neither user's data.
- Reset tests cover startup/reset contention, second-server refusal, active-server refusal, backup failure, backup integrity/restoration and failed reset rollback. Use isolated paths only.
- Browser journeys cover three logins, project/task creation/edit/completion, sign-out/switch, delayed responses, restart, keyboard use and desktop/mobile empty/error screens. Every test owns its process, port and database; never attach to or stop the operator's app.
- Measure default test duration; keep browser setup and any slow/live checks separate. Verify a pinned clean install/build/start and document launch/reset. Preserve the native baseline for the future pre-design-time checkpoint; no completed Keir wiring is added now.
