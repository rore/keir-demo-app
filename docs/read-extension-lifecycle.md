# Customization lifecycle reference

This reference describes Daymark's authoring, evidence and recovery contracts. For customer actions, use [Try a customization](../README.md#try-a-customization) and the [screenshot walkthrough](customization-walkthrough.md). Provider configuration and spending are covered in [AI setup](ai-authoring.md).

## Authoring service

The model can suggest source and help prepare examples. It cannot approve, activate, complete a native task or grant native authority. Treat model-written examples as proposals; agree on wanted behavior independently of observed results.

The assistant asks about missing business choices and uses the owner's project catalog to resolve named projects. It compiles the proposed rule and checks it without changing native tasks. All three triggers can read through `tasks.get` and `tasks.openMatch`; only the after-added and after-completed triggers can use `tasks.create` and `tasks.update`. Daymark supplies session-bound authority. If the assistant cannot express the requested behavior, it asks before drafting an alternative.

1. On an explicit send, Daymark supplies instructions, the message, bounded saved context, and an allowlist of authoring tools to its configured model. Daymark owns the conversation, resource limits, and tool execution.
2. `discover_catalog` returns the exact published domain capability model (DCM), its identity and fingerprint, supported hooks, the selected trigger when established, draft state, host guidance, and source and scenario examples. The DCM defines the callable operations, typed inputs and results, and protected parameters. The host guidance explains what those concepts mean in Daymark. Examples illustrate syntax.
3. The model can ask a question or propose source and expected examples. Daymark validates tool arguments and checks the current owner and draft on each operation. The Keir compiler checks source against the host's pinned DCM. The runtime runs the compiled artifact with simulation implementations and returns evidence for review.
4. Approval and activation are explicit user actions handled by Daymark. On a later matching task creation or completion, Daymark selects the active artifact for that owner and trigger and supplies real implementations and fresh trusted context to Keir. That execution uses the compiled rule without an AI request.

Rejected example submissions return the current draft identity and bounded field diagnostics to the assistant so it can repair its submission while keeping your requested examples and expected results. Three rejected submissions stop that explicit turn and keep saved work. Reading the catalog or other information does not reset that repair limit; saving a valid example suite does. Continuing requires an explicit send and still uses the shared allowance. This does not let the assistant approve or activate a change.

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

Current authoring uses the [pinned packages](package-provenance.md) with source `keir/2`, model `keir-dcm/3`, artifact `keir-artifact/3` and scenario `keir-scenario/3`. Existing `/2` event artifacts and compiler 0.3.0 `/3` artifacts retain their exact pins, approvals and evidence and execute through the pinned runtime’s supported compatibility rules. Editing creates a current-format revision requiring its own checked approval. Earlier Keir 1 rules remain readable as history after cutover.

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

Startup marks interrupted authoring state without dispatching another provider request, compile or simulation. Cancellation cannot undo a committed operation. After a lost response, inspect the original operation receipt and saved state before explicitly retrying. Recovery retains that request's identity and does not create a replacement item. Reload never automatically repeats a paid turn, compile or native write. Restart requires sign-in while saved work and receipts persist. Interrupted native outcomes remain distinct from later reconciliation observations. See [task effects](task-effects.md) for exact process-crash and durability limits; no arbitrary power-loss guarantee is implied.

Use a fresh data directory when starting the current-contract build alongside an earlier installation. Keep the earlier database and its matching app together. Restore a verified current backup into an isolated directory before switching which data you use. See [running Daymark](running.md#reset-and-restoration).

## Package and verification

The runtime and compiler are independently packaged and pinned through repository provenance and the lockfile. New compilations use the current Keir specification and Daymark DCM. Existing approved selections keep their original compatible model and package pins. See [task effects](task-effects.md) for the binding and native authority boundary.

The [verification guide](../tests/README.md) distinguishes public-projection UI tests, actual compiler/simulator checks, native persistence/process tests, integrated qualification and optional live-provider checks. No live-provider compatibility or integrated release result is asserted by this lifecycle guide.
