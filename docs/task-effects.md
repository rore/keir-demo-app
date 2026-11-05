# Task-completion customizations

New customizations use `TaskCompleted`: after a native task completion commits, an approved and enabled program can read an owner-visible task and create a task in an owner-visible existing project. The project and title are constants in the customer's authored program. The host catalog provides generic `tasks.get` and `tasks.create` capabilities; it does not contain a follow-up rule or customer-specific adapter.

Chat can discover projects, compile source and check independent synthetic examples. It cannot approve, enable or create native tasks. Review the examples, approve the exact checked revision, then enable it separately. Simulation and real execution use the same artifact bytes and dependency identities. Enabling a customization creates nothing and does not replay earlier completions.

## Native outcomes

Native completion succeeds independently of a reaction. A captured admission contains its owner, revision, checked approval, dependency pins and original native key. The host binds the complete implementation map once and reuses preparation for the same exact artifact before the exclusive first claim. Each invocation receives fresh owner/event/key/deadline context; a prepared program grants no permission. A claimed admission is never replayed after interruption. Unavailable dependencies leave unclaimed work pending; the bounded scanner continues past it. Revoked admissions remain revoked across reenable and restart.

The reaction status GET only reads retained evidence. **Check saved outcome** reads it again. **Reconcile saved observation** performs an explicit read-authorized native receipt lookup; it does not execute the program or retry a write. The immutable runtime result and a later dated reconciliation remain distinct. An authored label such as “created” is not evidence of creation. Only a confirmed native receipt plus a current owner-visible task supports an outcome link.

Legacy advice is retired for new execution, authoring and activation. Its saved source, evidence, history, original operation receipts and accounting remain readable by its owner. Stop, disable and delete remain available. An old approval never authorizes a write; start a fresh customization for the task contract.

## Runtime binding and host authority

The current executable contract is `keir-effect/4`, with `keir-dcm/effect-4`, `keir-artifact/effect-4` and host definition `daymark.task-completed/2`. Startup uses the complete native implementation map with `bindModel(dcmBytes, implementations)`; preparation uses `prepareProgram(artifactBytes, boundModel)`. Invalid model, capability/version/mode or artifact compatibility leaves no usable handle. Native tasks remain available when customization initialization fails.

Ordinary startup needs no deployment report, build manifest, platform credential or separate installation approval. The runtime validates structural compatibility and enforces operation, resource and deadline limits. The native host owns current permission, selected approved bytes, owner-visible resources, original-key authenticity, duplicate payload checks and atomic task/receipt persistence. Reached capabilities check current authority and the supplied absolute deadline before sensitive work and commit. Simulation and customer approval do not certify these native guarantees.

Disable and deletion invalidate selection and durably revoke captured admissions through the existing lifecycle/native database. Reenable, restart or a new selection never clears a recorded revocation. Earlier effect contracts and definition `/1` remain historical and ineligible: old PENDING stays held before claim, STARTED never replays, and FINISHED/UNKNOWN results and native receipts remain readable under current owner permission. Existing stored pins and history are not rewritten or upgraded into authority.

The runtime/compiler packages remain independently pinned by provenance and the lockfile. Test actual native ownership, receipt, revocation, deadline and process-restart behavior separately from synthetic checks; see [verification](../tests/README.md). Process-crash evidence does not establish arbitrary power-loss durability or live-provider/persona acceptance. Integrated release qualification remains pending.
