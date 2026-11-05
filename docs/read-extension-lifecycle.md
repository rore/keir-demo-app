# Review and use a task customization

Choose **Customizations** to start a rule or reopen a saved item. Each customization has one visible conversation. Use **Load earlier messages** to read more of it without sending a provider request. Under `TaskCompleted`, a matching new completion can create one task in an existing project you can access. Real effects require compatible artifacts and current native host permission. Native task management remains available when effects cannot run. See [task effects](task-effects.md).

1. Choose **New customization** and describe your goal. Opening or typing saves nothing and calls no provider. The first accepted message creates a distinct owner-scoped item. The assistant discovers accessible projects and clarifies the project, created-task title and matching behavior.
2. Agree on matching and nonmatching examples. The assistant compiles the source and checks synthetic situations, explaining disagreements with the independently wanted results. Source owns the chosen project and title; a hidden task-specific adapter does not choose them.
3. Open the named checked example deliberately. The canvas shows the task situation, expected creation and actual observed effect. Current and proposed behavior come from their own exact proofs; missing or incomparable current proof is explicit. Examples are synthetic and do not change native tasks.
4. Choose **Approve this change** when eligible evidence matches your intent. Approval alone changes no active selection. Separately choose **Turn on for my tasks**, or **Switch to this customization** when replacing another named item. Activation creates nothing, replays no earlier completion and preserves the previous saved item.
5. Complete a later native task normally. The completion remains successful independently of reaction failure. Its **Customization outcome** shows saved status separately; a confirmed native receipt and an owner-authorized read are required before **Open created task** appears.

Examples start closed and open from their exchange. Closing restores reading position, focus and unsent text. Background replies do not replace the example being read. Wide screens support resizing; narrow or short screens use Conversation / Preview navigation. Approval stays with its exact proof even when a newer check becomes latest. Explicitly reviewing and approving the newer run changes that binding. History and technical inspection show original source, compiled artifact, cases, pins and saved reports without granting authority over a different draft.

New AI items start as **Untitled customization**. **Rename** changes display metadata only; it preserves identity, revisions, evidence and selection. Save compares the exact previous name, so stale edits cannot overwrite another rename. An optional original-request excerpt helps distinguish unnamed items; it does not promise support for that request.

## Expected, observed and real effects

Each evidence response contains independently saved expectations and an actual simulator report:

| Field | Meaning |
| --- | --- |
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

The current TaskCompleted definition uses Keir 0.1.0 with the `keir/1`, `keir-dcm/1`, `keir-artifact/1` and `keir-scenario/1` formats. History and restore use the exact saved current revision and its own evidence. Keep databases from earlier builds with their matching app version.

Starting changes from the version in use requires a confirmation. Cancel preserves the current draft. Confirm copies the observed active revision under exact draft/version/generation checks, retains displaced changes and their discussion in History, and clears approval/evidence for the new draft. An old discussion cannot silently write over that new head. Native tasks, earlier effects and receipts are not undone.

## Delete and recover

Deletion confirms the exact name, draft version and selection generation. Running, cancelling or settling authoring returns `409 CUSTOMIZATION_BUSY`; use Stop and wait before confirming again. Cancel sends nothing. Deleting the selected item disables it transactionally; deleting another item leaves the current selection alone. An owner-scoped repeat returns the stable deletion receipt without another transition. Stale confirmation returns 409 and foreign items return 404.

Deleted items disappear from normal item/source/evidence/history navigation. Tombstones retain revisions, approvals, discussions, operation identities, dispatch outcomes and reserved or unknown spending internally; deletion is not a physical audit purge or refund. Original create/turn recovery returns `410 CUSTOMIZATION_DELETED` without recompiling, dispatching or creating a replacement. The browser clears only that matching pending request. A fresh explicit request can create a new item.

## Limits and recovery

Source is bounded UTF-8 text; suites, reports, provider context and responses have byte and format limits. Compiler, simulator, authoring and runtime work retain separate concurrency, timeout and cancellation controls. Complete evidence is fetched by exact owner-scoped ID; oversize or incomplete evidence is rejected rather than truncated into eligibility. History, versions and discussions are paged and retained without silently replacing the current head.

Cancellation cannot undo a committed operation. After a lost response, inspect the original operation receipt and saved state before explicitly retrying; reload never automatically repeats a paid turn, compile or native write. Restart requires sign-in while saved work and receipts persist. Interrupted native outcomes remain distinct from later reconciliation observations. See [task effects](task-effects.md) for exact process-crash and durability limits; no arbitrary power-loss guarantee is implied.

Use a fresh data directory when starting the current-contract build alongside an earlier installation. Keep the earlier database and its matching app together. Restore a verified current backup into an isolated directory before switching which data you use. See [running Daymark](running.md#reset-and-restoration).

## Package and verification

The runtime and compiler are independently packaged and pinned through repository provenance and the lockfile. New compilations use the current Keir specification and Daymark DCM. Existing approved selections keep their original compatible model and package pins. See [task effects](task-effects.md) for the binding and native authority boundary.

The [verification guide](../tests/README.md) distinguishes public-projection UI tests, actual compiler/simulator checks, native persistence/process tests, integrated qualification and optional live-provider checks. No live-provider compatibility or integrated release result is asserted by this lifecycle guide.
