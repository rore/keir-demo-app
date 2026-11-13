# Keir host binding in Daymark

## Checks before adding

Each owner may enable one **Before a new task is saved** rule independently of their after-added and after-completed rules. No selected check keeps ordinary native creation available. A selected check that cannot run stops creation; it never becomes an absent rule. Approval and turning on remain separate decisions.

The check receives the normalized proposed `projectId`, `priority`, typed `tags` list, `hasNotes` and `hasDueDate`. `hasNotes` means the native notes contain non-whitespace text; `hasDueDate` means native validation accepted a non-null due instant. The full title and notes stay private to native creation, with their existing limits. Tags retain the native eight-item limit. A project-specific condition compares the proposed typed ID with the customer's project choice resolved through authorized discovery.

The read-only program returns required `decision` (`ALLOW` or `DENY`) and bounded plain-text `message`. It can combine conditions, such as client tags requiring a due date or high priority requiring notes. An ALLOW permits normal native permission, validation and save checks to continue; it is not a save receipt. DENY keeps all entered fields for correction. Unavailable execution, bad output, cancellation, expired budget, changed approval/selection or stale read facts stop the attempt distinctly from a customer denial. There is no field-hint or message-parsing protocol.

The numeric model also supports [requiring notes for more than three tags](tag-notes.md). It counts the host-normalized distinct list, not a database total. Four through eight tags with non-whitespace notes are allowed. Nine distinct or invalid tags fail native validation before the hook. This authored rule checks creation only, not existing tasks or later edits.

Both human/API and automation creation use this check. Successful local READ projections are captured privately, then reread under the native transaction before insertion. Postwrite checks retain authority and deadlines without rejecting the operation for changing its own prewrite predicate. No asynchronous guard work holds the write transaction, and no guard WRITE or recursive READ hook is available.

Human attempts use [native creation identity and readback](native-task-app-design.md#creation-attempts-and-readback). Automation retains its original key and exact immutable receipts: a settled receipt replays before a new guard check; a concurrent saved winner beats a later denial. Confirmed denial maps to the existing `TASK_INVALID`/NONE capability result, while unavailable-before-write maps to `TRANSIENT_FAILURE`/NONE, with separate host diagnostic detail. Unknown write results remain unknown until native readback.

## Actions after adding or completing

An approved and enabled workflow runs after native task creation or completion commits. Each owner has one selection per trigger. The program may read an owner-visible task, check for an open task with an exact title in one accessible project, then create one task or update the triggering task. It can compare title, project, tags, priority, and due time. The event carries its persisted occurrence instant, so adding 168 elapsed hours gives an exact due time across daylight-saving changes. A successful open-task check describes the authorized read snapshot. Concurrent actions can still create another matching task.

The host catalog provides `tasks.get@3`, `tasks.openMatch@1`, `tasks.create@2`, and `tasks.update@1`. Create accepts a title and optional notes, comma-separated tags, priority, and due time. Update accepts a tag, priority, or due time and leaves omitted fields alone. Clear an existing due time in the native editor. The runtime limits each authored String to 256 UTF-8 bytes. Native title and tag limits still apply. Automation-created tasks do not start another creation workflow. A person can complete one later and trigger a completion workflow normally.

Chat can discover projects, compile source and check independent synthetic examples. Review the examples, approve the exact checked revision, then turn it on separately for its trigger. Simulation and real execution use the same artifact bytes and dependency identities. Activation applies to future events.

## Native outcomes

The native write and event capture commit together. The reaction runs afterward. A captured admission contains its owner, trigger, event time, revision, checked approval, dependency pins and original native key. The host prepares the exact artifact before the exclusive first claim. Each invocation receives fresh owner, event, key and deadline context. A claimed admission is never replayed after interruption. Unavailable dependencies leave unclaimed work pending. Revoked admissions remain revoked across reenable and restart.

The reaction status GET reads retained evidence. **Check result** reads it again. **Reconcile saved observation** performs an explicit owner-authorized receipt lookup. A confirmed native receipt identifies the affected task and records the create or update observation. The original runtime result and a later dated reconciliation remain distinct. A receipt never grants access to an otherwise unavailable task.

To cut over from Keir 1, keep the previous app and database together until eligible pending work settles. The migration refuses to proceed while any pending admission lacks a durable revocation. Revoked pending rows remain visible as history. Existing Keir 1 selections become historically unavailable, and current selections start off. Old sources, evidence, events and receipts remain readable. Start a new current-format revision and approve its own checked evidence before enabling it. Upgrading an existing Keir 2 database preserves its event selections and adds the before-save selection disabled.

## Runtime binding and host authority

New authoring selects the numeric `/4` model for all three triggers. Editing an earlier `/3` model keeps that model with the new 0.5 compiler; both new authoring profiles produce artifact/scenario `/4`. [Package provenance](package-provenance.md) identifies the exact packages, corrected companion candidate and remaining acceptance gates. Original compiler-0.2 `/2` artifacts and compiler-0.3.0/0.3.1/0.4.0 `/3` artifacts retain their exact definitions, approvals, sources and receipts. They are never silently recompiled or approved under a new producer. Recompilation needs its own new evidence, approval and separate activation. Preparation is reused only for the same exact definition and artifact, never for owner or request authority. Saved source and history remain readable when execution dependencies are unavailable.

The enclosing operation retains its one-second budget. A nested guard receives a smaller expiry reserving 100 ms for native revalidation and commit. An isolated sample of 40 successful disk-backed creates measured a maximum native transaction of 26.17 ms, including a two-READ guard. This selects the reserve; it is not a four-READ worst-case bound or a latency guarantee. Cancellation and the original deadline still prevent late continuation.

Ordinary startup needs no deployment report, build manifest, platform credential or separate installation approval. The runtime validates structural compatibility and enforces operation, resource and deadline limits. The native host owns current permission, selected approved bytes, owner-visible resources, original-key authenticity, duplicate payload checks and atomic task/receipt persistence. Reached capabilities check current authority and the supplied absolute deadline before sensitive work and commit. Simulation and customer approval do not certify these native guarantees.

Disable and deletion invalidate selection and durably revoke captured admissions through the existing lifecycle/native database. Reenable, restart or a new selection never clears a recorded revocation. Previously queued work stays held, interrupted work is never replayed, and finished or uncertain results keep their original receipts and dependency pins.

The runtime/compiler packages remain independently pinned by provenance and the lockfile. Test actual native ownership, receipt, revocation, deadline and process-restart behavior separately from synthetic checks; see [verification](../tests/README.md). Process-crash evidence does not establish arbitrary power-loss durability or live-provider/persona acceptance. Qualification is bounded by its recorded packages, platform and checks.
