# Application scope

Daymark is a local task manager and reference consumer of Keir. It uses a React/TypeScript UI, Fastify and SQLite. Native tasks and saved history need Node.js, without AI or Java; conversational authoring uses an operator-configured provider and Java 21. See [setup](../README.md#run-locally) and [AI configuration](ai-authoring.md).

## Capabilities

- Projects and tasks support tags, priority, due times and project search, with data retained across restarts.
- Three fictional demo accounts have separate tasks, customizations, discussions, approvals and active selections. Sign-in is local demo impersonation; production identity integration is outside this app's scope.
- A selected check can allow or deny a new task before saving. An unavailable selected check blocks the save and preserves the entered fields. ALLOW still requires native permission, validation and transaction checks.
- Rules after task creation or completion can read scoped data and create one task or update the triggering task. They run after native commit; dates on tasks do not schedule rule execution.
- The assistant compiles source and simulates independently expected examples. Human approval and activation are separate. Future matching events execute the approved artifact without another AI request.
- Native receipts distinguish confirmed effects, rejection and uncertainty. Recovery reads saved state before any explicit retry; it never blindly repeats an unknown write.

## Ownership and limits

Daymark owns persistence, permissions, the published task model, adapters, evidence and activation. Owner identity and replay keys come from trusted host context. A browser-supplied ID cannot select another person's data, and events retain their originating owner after sign-out. The assistant cannot approve or activate its own proposal, publish the host catalog or certify native guarantees.

The same packaged Node runtime executes the artifact in simulation and through real adapters. Core's Java runtime is demonstrated by its separate host example and conformance suite. Simulation does not establish real persistence or concurrency guarantees; see [task customizations](task-effects.md) and [verification](../tests/README.md).

Programs have bounded operations and data, with at most one possible mutation per invocation. They cannot execute arbitrary URLs, scripts or SQL, wait durably, retry automatically or run effectful loops. New capabilities require an explicit host-model revision and verification. Daymark exposes no manual source or scenario editor.

Provider credentials stay server-side and are shared by the local demo accounts; the app does not provide production administrator authentication. [AI setup](ai-authoring.md) covers accepted provider pairs, costs, context and retention. [Running Daymark](running.md) covers backups, restart and deliberate data reset.

Daymark is [Apache 2.0 licensed](../LICENSE) and listens on loopback. Production hosting and independently reusable Studio packaging remain separate work. Future work is tracked in the [Core roadmap](https://github.com/rore/keir-core/tree/main/roadmap), including the [host-integration assistant](https://github.com/rore/keir-core/blob/main/roadmap/features/host-integration-assistant.md).
