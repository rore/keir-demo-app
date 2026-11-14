<a id="customization-lifecycle-reference"></a>
# Daymark host integration

Daymark implements Keir in a task-management application. Use this reference when building or changing that integration. For the user journey, start with the [walkthrough](customization-walkthrough.md); for provider keys, costs and privacy, use [AI setup](ai-authoring.md).

## Host responsibilities

Daymark owns data, permissions, the declared task operations, adapters, saved evidence and activation. Owner identity and replay keys come from trusted host context, never model or browser authority. Events keep their originating owner after sign-out. The packaged Node runtime executes the same compiled bytes in simulation and real execution, with different service implementations.

Each program has bounded operations and data and at most one possible mutation. It cannot call arbitrary URLs, scripts or SQL, schedule work, wait durably or retry automatically. Adding a capability requires a host-model revision and verification. Daymark offers no manual source or scenario editor. Production hosting and a separately packaged Studio remain outside this demo; [Studio embedding](studio-embedding.md) is a proposal.

## Checks before adding

Each owner may enable one **Before a new task is saved** rule independently of their after-added and after-completed rules. No selected check keeps ordinary native creation available. A selected check that cannot run stops creation; it never becomes an absent rule. Approval and turning on remain separate decisions.

The check receives the normalized proposed `projectId`, `priority`, typed `tags` list, `hasNotes` and `hasDueDate`. `hasNotes` means the native notes contain non-whitespace text; `hasDueDate` means native validation accepted a non-null due instant. The full title and notes stay private to native creation, with their existing limits. Tags retain the native eight-item limit. A project-specific condition compares the proposed typed ID with the customer's project choice resolved through authorized discovery.

The read-only program returns required `decision` (`ALLOW` or `DENY`) and bounded plain-text `message`. It can combine conditions, such as client tags requiring a due date or high priority requiring notes. An ALLOW permits normal native permission, validation and save checks to continue; it is not a save receipt. DENY keeps all entered fields for correction. Unavailable execution, bad output, cancellation, expired budget, changed approval/selection or stale read facts stop the attempt distinctly from a customer denial. There is no field-hint or message-parsing protocol.

The [tag-count example](customization-walkthrough.md#require-notes-for-many-tags) counts the host-normalized distinct list; it adds no database total or Decimal task field. Native limits apply before the hook.

Both human/API and automation creation use this check. Successful local READ projections are captured privately, then reread under the native transaction before insertion. Postwrite checks retain authority and deadlines without rejecting the operation for changing its own prewrite predicate. No asynchronous guard work holds the write transaction, and no guard WRITE or recursive READ hook is available.

Human attempts use [native creation identity and readback](native-task-app-design.md#creation-attempts-and-readback). Automation retains its original key and exact immutable receipts: a settled receipt replays before a new guard check; a concurrent saved winner beats a later denial. Confirmed denial maps to the existing `TASK_INVALID`/NONE capability result, while unavailable-before-write maps to `TRANSIENT_FAILURE`/NONE, with separate host diagnostic detail. Unknown write results remain unknown until native readback.

## Actions after adding or completing

An approved and enabled workflow runs after native task creation or completion commits. Each owner has one selection per trigger. The program may read an owner-visible task, check for an open task with an exact title in one accessible project, then create one task or update the triggering task. It can compare title, project, tags, priority, and due time. The event carries its persisted occurrence instant, so adding 168 elapsed hours gives an exact due time across daylight-saving changes. A successful open-task check describes the authorized read snapshot. Concurrent actions can still create another matching task.

The host catalog provides `tasks.get@3`, `tasks.openMatch@1`, `tasks.create@2`, and `tasks.update@1`. Create accepts a title and optional notes, comma-separated tags, priority, and due time. Update accepts a tag, priority, or due time and leaves omitted fields alone. Clear an existing due time in the native editor. The runtime limits each authored String to 256 UTF-8 bytes. Native title and tag limits still apply. Automation-created tasks do not start another creation workflow. A person can complete one later and trigger a completion workflow normally.

## Native outcomes

The native write and event capture commit together. The reaction runs afterward. A captured admission contains its owner, trigger, event time, revision, checked approval, dependency pins and original native key. The host prepares the exact artifact before the exclusive first claim. Each invocation receives fresh owner, event, key and deadline context. A claimed admission is never replayed after interruption. Unavailable dependencies leave unclaimed work pending. Revoked admissions remain revoked across reenable and restart.

## Runtime binding and host authority

Prepare and reuse only the same exact definition and artifact. Every invocation supplies fresh owner, event, original key and deadline context. Saved source and history remain readable when execution dependencies are unavailable.

The enclosing operation retains its one-second budget. A nested guard receives a smaller expiry reserving 100 ms for native revalidation and commit. The reserve is a configured bound, not a latency guarantee. Cancellation and the original deadline still prevent late continuation.

Ordinary startup needs no deployment report, build manifest, platform credential or separate installation approval. The runtime validates structural compatibility and enforces operation, resource and deadline limits. The native host owns current permission, selected approved bytes, owner-visible resources, original-key authenticity, duplicate payload checks and atomic task/receipt persistence. Reached capabilities check current authority and the supplied absolute deadline before sensitive work and commit. Simulation and customer approval do not certify these native guarantees.

Disable and deletion invalidate selection and durably revoke captured admissions through the existing lifecycle/native database. Reenable, restart or a new selection never clears a recorded revocation. Previously queued work stays held, interrupted work is never replayed, and finished or uncertain results keep their original receipts and dependency pins.

Test actual native ownership, receipt, revocation, deadline and process-restart behavior separately from synthetic checks; see [verification](../tests/README.md). Process-crash evidence does not establish arbitrary power-loss durability or live-provider/persona acceptance. Qualification is bounded by its recorded packages, platform and checks.

## Authoring service

The model can suggest source and help prepare examples. It cannot approve, activate, complete a native task or grant native authority. Treat model-written examples as proposals; agree on wanted behavior independently of observed results.

The same conversation can discuss other saved customizations and relevant tasks. **Send** and Enter submit explicit `intent: auto`. Each such turn starts without mutation authority and first resolves discussion, an explicit preparation request or unclear intent inside the existing checkpointed provider loop. The resolution request contains the current user text, bounded relevant same-target user history and necessary clarification context; it excludes task/tool/source text and earlier provider continuation. Assistant wording is context, not consent.

Daymark validates, fences and checkpoints the result for the exact owner/run/target/draft before freezing the turn's resolved intent. Only resolved preparation can advertise and execute compilation, scenario replacement or simulation. Both dispatch and host bindings enforce that result; later tool text cannot promote it. Missing, malformed or unclear resolution never permits preparation, and each new auto turn resolves afresh. Resolution uses the same configured provider, limits, reservations and uncertain-hold accounting; normal assistant context starts with a fresh provider continuation. Resolution stays in existing JSON state, with no schema migration or separate classifier service.

Older omitted, discussion and preparation request bodies retain their exact recovery semantics and hashes. Replaying a saved operation neither resolves intent again nor repeats its effects. Generic continuation remains discussion-only. No chat intent grants approval, activation or native task-write tools. Conversation messages, spending receipts and admission of a new empty discussion item are still saved. Natural-language interpretation remains fallible: these host fences cannot prove semantic consent. A mistaken preparation classification can alter a draft, but cannot change its owner/target, approve it, activate it or write native tasks.

The assistant asks about missing business choices and uses the owner's project catalog to resolve named projects. It compiles the proposed rule and checks it without changing native tasks. All three triggers can read through `tasks.get` and `tasks.openMatch`; only the after-added and after-completed triggers can use `tasks.create` and `tasks.update`. Daymark supplies session-bound authority. If the assistant cannot express the requested behavior, it asks before drafting an alternative.

1. After resolving an auto message's intent, Daymark supplies the normal assistant instructions, message, bounded saved context, current editing-target facts and a count of other saved items. Daymark owns the frozen intent, conversation, resource limits and allowed tool execution. An empty draft says nothing about whether other customizations exist.
2. `discover_catalog` returns the exact published domain capability model (DCM), its identity and fingerprint, supported hooks, the selected trigger when established, draft state, host guidance, and source and scenario examples. The DCM defines the callable operations, typed inputs and results, and protected parameters. The host guidance explains what those concepts mean in Daymark. Examples illustrate syntax.
3. The model can ask a question or propose source and expected examples. Daymark validates tool arguments and checks the current owner and draft on each operation. The Keir compiler checks source against the host's pinned DCM. The runtime runs the compiled artifact with simulation implementations and returns evidence for review.
4. Approval and activation are explicit user actions handled by Daymark. On a later matching task creation or completion, Daymark selects the active artifact for that owner and trigger and supplies real implementations and fresh trusted context to Keir. That execution uses the compiled rule without an AI request.

Host-side context tools are separate from the capabilities available to a compiled Keir rule:

| Tool | Read-only scope |
| --- | --- |
| `discover_customizations` | Up to 20 other nondeleted items using the existing owner-scoped collection cursor. Returns metadata, not full history or behavior inferred from names. |
| `inspect_customization` | One owned item's exact draft/approval and selected-version facts, artifact-derived behavior and bounded checked evidence. Retired, unavailable and partial details remain explicit. A selected revision can belong to another item; it is not the inspected item's draft. |
| `search_tasks` | Up to 25 tasks from one owned project, narrowed by text/tag or explicitly sampled with blank filters. Notes are omitted by default; requested notes have a 256-code-point excerpt and truncation flag. Counts and cursors describe that query, not all tasks. |
| `offer_customization` | A host-validated Open action, not an editing-target mutation. Clicking rechecks access/name and opens a fresh navigation entry. It never forwards the old request or changes what runs. |

Collection/task tool results have a 16 KiB limit; inspection has a 32 KiB limit. Omitted or unavailable details are labeled. Repeated pages also count against the existing complete provider-request and continuation limits. Task content and names remain untrusted structured data. These tools do not add Keir capabilities, general memory, cross-user reads or automatic background provider requests. [AI setup](ai-authoring.md#configure-a-provider) describes the provider data flow.

Rejected example submissions return the current draft identity and bounded field diagnostics to the assistant so it can repair its submission while keeping your requested examples and expected results. Three rejected submissions stop that explicit turn and keep saved work. Reading the catalog or other information does not reset that repair limit; saving a valid example suite does. Further draft or example-check work needs a clear user request through Send and still uses the shared allowance. Generic Continue/Try again actions resume discussion only; exact pending-request retries retain their original body and saved resolution. This does not let the assistant approve or activate a change.

Proposal descriptions come from the exact checked artifact and host definition. Unsupported expressions remain partial or unavailable; elapsed offsets do not imply calendar or working days. Simulation uses synthetic tasks and leaves native tasks unchanged. An expected unavailable read can match its expectation without proving all failures safe; an unknown effect remains unconfirmed.

## Expected, observed and real effects

Each evidence response contains independently saved expectations and an actual simulator report:

| Field | Meaning |
| --- | --- |
| `reports[].report.scenario.proposal` | Synthetic before-save proposal: project, priority, tags, notes presence and due-date presence. It excludes the full title and notes. |
| `reports[].expected.consumption`, `reports[].report.consumption` | Independent expected consumption and actual consumption: `ALLOWED`, `DENIED` or `BLOCKED`, with the returned decision and message when available. An unavailable example can pass when explicitly expected; it never permits a real save. |
| `reports[].report.scenario.task` | Synthetic source task: title, status and project when available. It belongs to that exact saved proof. |
| `reports[].expected.createdTasks` | Expected project/title creations from independent saved expectations; an empty array means none. Null explicitly means an unknown creation result; absent expectations grant no review eligibility. |
| `reports[].report.observed` | Actual simulated effect and created-task projections from native simulator calls and the effect ledger. `CONFIRMED` supports a creation preview; `NONE` with an empty array means known none; `UNKNOWN` or absent observations remain uncertain. |
| `reports[].report.status`, `mismatches` | Exact check result and disagreements. A label or source return value never establishes a native effect. A host-eligible exact PASS suite can include independently expected UNKNOWN/null paired with observed UNKNOWN/null: it remains reviewable while creation stays explicitly unconfirmed. |
| `approvedEvidenceId` | Exact proof retained by the current eligible approval, independent of the latest evidence run. |
| `selection.approvedEvidenceId` | Exact approval proof for the selected revision, or null when no eligible proof exists. |

Actual native outcomes are separate from synthetic evidence. `GET /api/tasks/:id/reaction` is a pure owner-scoped status read; it never starts or repeats execution. `POST /api/tasks/:id/reaction/reconcile` with an empty object deliberately reads existing native receipt state. Reconciliation records a separate observation time and never changes the original runtime outcome or retries a write. A source result named `CREATED` alone cannot support a task link. A saved `SUCCESS` receipt with `effect: CONFIRMED` must resolve through the owner's native task GET first. A confirmed later observation can reveal a task while the original run remains `UNKNOWN`; both remain visible. An unknown result means a task may exist. Do not complete again to retry it.

## Authority and retained history

A saved customization has its own owner-scoped identity, draft version, immutable revisions and linked discussions. A new item starts unbound; only successful host-admitted source binds the supported hook. A bound item cannot silently change contracts. Browser mutations name exact item/revision/version and observed selection generation; they cannot supply owner, artifact, pins, PASS claims or protected authority. Server transactions recheck approval, evidence, dependencies and current generation. Typed assent and client booleans grant no authority.

Real execution additionally requires compatible runtime binding and current native host permission. The optional `executionAvailability` projection explains when customizations cannot run. A false value disables activation and rollback; discussion, compilation, checks and customer approval remain valid. `selection.eligible` also reflects current execution authority, so a saved selection is not automatically claimed to be working. Simulation success and customer approval do not certify the real adapter or every future task.

Compilation resolves the optional model digest only against server-owned definitions. Requests cannot supply model bytes, authority or a compiler choice; there is no source sniffing or fallback compilation. New revisions need their own evidence, approval and separate activation. Existing artifacts, sources, approvals and receipts retain their exact identities rather than being silently recompiled. [Package provenance](package-provenance.md) owns the current and retained profile/package mapping.

Earlier advice conversations, scripted examples and their approvals remain historical. They cannot be resumed or turned into a task-creating customization. Start a new customization with fresh checks, approval and activation. Original receipt recovery remains readable and never creates a replacement item or repeats an old write.

Starting changes from the version in use requires a confirmation. Cancel preserves the current draft. Confirm copies the observed active revision under exact draft/version/generation checks, retains displaced changes and their discussion in History, and clears approval/evidence for the new draft. An old discussion cannot silently write over that new head. Native tasks, earlier effects and receipts are not undone.

Rename changes display metadata only and preserves item identity, revisions, evidence and selection. It compares the previous name so a stale edit cannot overwrite a newer rename. An original-request excerpt identifies a discussion; it does not promise support for that request.

## Delete and recover

Deletion confirms the exact name, draft version and selection generation. Running, cancelling or settling authoring returns `409 CUSTOMIZATION_BUSY`; use Stop and wait before confirming again. Cancel sends nothing. Deleting the selected item disables it transactionally; deleting another item leaves the current selection alone. An owner-scoped repeat returns the stable deletion receipt without another transition. Stale confirmation returns 409 and foreign items return 404.

Deleted items disappear from normal item/source/evidence/history navigation. Tombstones retain revisions, approvals, discussions, operation identities, dispatch outcomes and reserved or unknown spending internally; deletion is not a physical audit purge or refund. Original create/turn recovery returns `410 CUSTOMIZATION_DELETED` without recompiling, dispatching or creating a replacement. The browser clears only that matching pending request. A fresh explicit request can create a new item. Deleted-item turn recovery returns no actionable discussion or provider work; conflicting reuse of an operation identity still returns 409. The browser removes only that matching pending request, including when its preliminary item lookup is unavailable. Legacy discussions without a confirmed item link retain their existing read-only behavior.

## Client state and recovery

**New customization** opens an empty conversation. The first accepted message creates the saved item. Each saved customization has one visible conversation in Studio, even when a fresh authoring run is needed. Reopening the item and reading earlier messages use saved data. Sending a turn is an explicit action. History retains earlier saved versions and displaced drafts for inspection. Starting again from the version in use requires confirmation.

Unsent composer text stays with its exact customization in the current browser tab and authentication session, including navigation away and reload. It is never submitted automatically and is separate from submitted-request recovery. Changing the demo person or starting another authentication session does not restore it. If tab storage or the session fingerprint is unavailable, Studio keeps the draft in memory across navigation and reports that reload recovery is unavailable.

Saved messages, versions and receipts are paged. Discussions have no fixed age, total run duration, turn count or tool-call quota; each input and operation still has its own limits. A turn uses the current saved draft and bounded recent context. When that context is full, **Continue here from saved work** starts an explicit turn in the same conversation, using the shared allowance and preserving the previous request in the transcript. Reading earlier messages sends no provider request.

## Limits and recovery

Source is bounded UTF-8 text; suites, reports, provider context and responses have byte and format limits. Compiler, simulator, authoring and runtime work retain separate concurrency, timeout and cancellation controls. Complete evidence is fetched by exact owner-scoped ID; oversize or incomplete evidence is rejected rather than truncated into eligibility. History, versions and discussions are paged and retained without silently replacing the current head.

Startup marks interrupted authoring state without dispatching another provider request, compile or simulation. Cancellation cannot undo a committed operation. After a lost response, inspect the original operation receipt and saved state before explicitly retrying. Recovery retains that request's identity and does not create a replacement item. Reload never automatically repeats a paid turn, compile or native write. Restart requires sign-in while saved work and receipts persist. Interrupted native outcomes remain distinct from later reconciliation observations. The process-crash tests do not establish arbitrary power-loss durability.

Use a fresh data directory when starting the current-contract build alongside an earlier installation. Keep the earlier database and its matching app together. Restore a verified current backup into an isolated directory before switching which data you use. See [running Daymark](running.md#reset-and-restoration).

## Upgrade an earlier database

To cut over from Keir 1, keep the previous app and database together until eligible pending work settles. The migration refuses to proceed while any pending admission lacks a durable revocation. Revoked pending rows remain visible as history. Existing Keir 1 selections become historically unavailable, and current selections start off. Old sources, evidence, events and receipts remain readable. Start a new current-format revision and approve its own checked evidence before enabling it. Upgrading an existing Keir 2 database preserves its event selections and adds the before-save selection disabled.

<a id="package-and-verification"></a>
For package pins, see [provenance](package-provenance.md); for developer checks and their limits, see [verification](../tests/README.md). Provider compatibility and deployment are separate from synthetic and native tests.
