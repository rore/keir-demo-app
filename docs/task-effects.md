# Task workflow customizations

An approved and enabled workflow runs after native task creation or completion commits. Each owner has one selection per trigger. The program may read an owner-visible task, check for an open task with an exact title in one accessible project, then create one task or update the triggering task. It can compare title, project, tags, priority, and due time. The event carries its persisted occurrence instant, so adding 168 elapsed hours gives an exact due time across daylight-saving changes. A successful open-task check describes the authorized read snapshot. Concurrent actions can still create another matching task.

The host catalog provides `tasks.get@3`, `tasks.openMatch@1`, `tasks.create@2`, and `tasks.update@1`. Create accepts a title and optional notes, comma-separated tags, priority, and due time. Update accepts a tag, priority, or due time and leaves omitted fields alone. Clear an existing due time in the native editor. The runtime limits each authored String to 256 UTF-8 bytes. Native title and tag limits still apply. Automation-created tasks do not start another creation workflow. A person can complete one later and trigger a completion workflow normally.

Chat can discover projects, compile source and check independent synthetic examples. Review the examples, approve the exact checked revision, then turn it on separately for its trigger. Simulation and real execution use the same artifact bytes and dependency identities. Activation applies to future events.

## Native outcomes

The native write and event capture commit together. The reaction runs afterward. A captured admission contains its owner, trigger, event time, revision, checked approval, dependency pins and original native key. The host prepares the exact artifact before the exclusive first claim. Each invocation receives fresh owner, event, key and deadline context. A claimed admission is never replayed after interruption. Unavailable dependencies leave unclaimed work pending. Revoked admissions remain revoked across reenable and restart.

The reaction status GET reads retained evidence. **Check result** reads it again. **Reconcile saved observation** performs an explicit owner-authorized receipt lookup. A confirmed native receipt identifies the affected task and records the create or update observation. The original runtime result and a later dated reconciliation remain distinct. A receipt never grants access to an otherwise unavailable task.

To cut over from Keir 1, keep the previous app and database together until eligible pending work settles. The migration refuses to proceed while any pending admission lacks a durable revocation. Revoked pending rows remain visible as history. Existing Keir 1 selections become historically unavailable, and both Keir 2 selections start off. Old sources, evidence, events and receipts remain readable. Start a new Keir 2 revision and approve its own checked evidence before enabling it.

## Runtime binding and host authority

Daymark binds one Keir 0.2.0 model for both task triggers. Approved selections and pending events retain their exact model, artifact and package pins. The runtime reuses preparation for the same model and artifact. Native tasks and exact saved evidence remain available when a missing runtime archive prevents execution.

Ordinary startup needs no deployment report, build manifest, platform credential or separate installation approval. The runtime validates structural compatibility and enforces operation, resource and deadline limits. The native host owns current permission, selected approved bytes, owner-visible resources, original-key authenticity, duplicate payload checks and atomic task/receipt persistence. Reached capabilities check current authority and the supplied absolute deadline before sensitive work and commit. Simulation and customer approval do not certify these native guarantees.

Disable and deletion invalidate selection and durably revoke captured admissions through the existing lifecycle/native database. Reenable, restart or a new selection never clears a recorded revocation. Previously queued work stays held, interrupted work is never replayed, and finished or uncertain results keep their original receipts and dependency pins.

The runtime/compiler packages remain independently pinned by provenance and the lockfile. Test actual native ownership, receipt, revocation, deadline and process-restart behavior separately from synthetic checks; see [verification](../tests/README.md). Process-crash evidence does not establish arbitrary power-loss durability or live-provider/persona acceptance. Integrated release qualification remains pending.
