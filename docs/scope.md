# Application scope

The task manager is a useful application and a reference consumer of `keir-core`. It owns the UI, task data, authentication/authorization, task DCM, real adapters, business scenarios, AI-driven extension creation UI and activation lifecycle.

Daymark is a local web demonstration with isolated demo sign-in, native projects and tasks, checks before saving, and actions after adding or completing tasks using the pinned Keir packages. It uses React/TypeScript and Vite, a same-origin Fastify host and SQLite through `node:sqlite`. Visitors supply their own AI provider configuration for conversational authoring and Java 21 for compilation. Native task management requires Node and the local SQLite database. See [local setup](../README.md), the [native contract](native-task-app-design.md) and [task customizations](task-effects.md).

## Experience and user scopes

- Deliver a distinctive, polished task application with coherent typography, spacing, color and interactions. Review rendered desktop/mobile, loading, empty and error states; include keyboard access. Choose a visual direction before implementation rather than accepting a generic generated dashboard.
- Seed three fictional demo users with an explicit local sign-in/sign-out flow. This is local demo impersonation, not enterprise authentication. Each user stands in for a SaaS customer, with separate projects/tasks, extension sources, scenarios, approvals and active bindings. The immutable host catalog can be shared; customer programs and activation remain scoped. A production identity platform is outside this demo's scope.
- Enforce ownership in host services and trusted invocation context. A client-supplied user/resource ID cannot select another user's data or extension. Async events retain their originating scope regardless of browser sign-out or user switching.
- Demonstrate different programs at the same hook for different users; changing, disabling or rolling back one user's customization must leave the others intact. Customer authors may approve their own extensions where host policy permits; the AI agent cannot grant itself approval or publish the host catalog.
- Persist local demo data across restarts and document a deliberate demo-data reset procedure. Keep runtime data and credentials out of tracked content; setup must use isolated project tooling.

## Extension Studio experience

Extension Studio uses conversation for describing a change, clarification, rule explanations and simulation. Application-owned views show expected and observed behavior; arbitrary generated code does not render the UI. Secondary inspection exposes saved versions and evidence. The [current design](extension-studio-design.md) distinguishes implemented interactions from proposed refinements; the [canvas-era design](historical/extension-studio-canvas-design.md) is historical.

Maintain the UX specification and review proposed changes before implementing them; track design and implementation in the core roadmap's owning features. Agent-directed presentation never grants publication, approval or activation authority.

The design must show the full journey: describe intent, clarify requirements, inspect proposed behavior, create/review test scenarios, simulate, understand results, approve an exact revision, activate, observe native app behavior and revise/disable/roll back. Define backtracking and recovery, not only a successful linear path. A business user should understand what runs, when, for whom, what it may change and what has actually been verified without writing code or inspecting IR.

Specify conversation and structured review areas, information hierarchy, navigation, feedback and progress, draft versus active states, approval invalidation and scenario expectations. Cover setup, loading, empty states, unsupported requests, compiler repair, mismatches, provider failures, cancellation, reload/resume and switching users. Keep simulated evidence distinct from actual execution and preserve honest uncertainty.

Review substantive interaction changes with representative content: a successful customization, a recoverable failed attempt, two users with different customizations and native outcomes. Review accessibility and interaction continuity; label scripted prototype behavior. Implementation evidence, visual review and opt-in live-provider qualification remain distinct; see [verification](../tests/README.md).

## Current connected behavior

1. Native projects and tasks include tags, priority, due times and project search, with owner-scoped persistence across restarts and no AI requirement.
2. The packaged Node runtime binds real scoped `tasks.get` and `tasks.openMatch` reads. The Core Java sample and shared fixtures exercise the other runtime.
3. `TaskCreated` and `TaskCompleted` run after native commit and can create one task or update the triggering task. Source expresses project, title and other supported conditions and values. Daymark owns selection, event admission, protected context and original idempotency keys.
4. The assistant compiles source, proposes independent expected scenarios and simulates the exact artifact. Human approval and activation are separate. The same Node runtime executes the approved artifact through real adapters; execution needs no AI request.
5. Native receipts distinguish confirmed effects, business rejection and uncertain outcomes. Recovery reads existing state rather than blindly replaying an unknown effect. See [task effects](task-effects.md) for actual guarantees and limits.
6. `TaskBeforeCreate` can allow or deny a proposed task without writing. ALLOW continues native authorization, validation and transaction checks; DENY or an unavailable selected check prevents saving and preserves the editable proposal.

The application uses the Node runtime. Core's Java runtime is also initial scope and is demonstrated through its Java host example and shared conformance; this does not require a second task app.

## Later increments

Add customer behaviors and host capabilities as implementation needs arise, through explicit approved DCM revisions. Exercise different hook/result paths to verify integration behavior. The product value is accepted; a frozen-catalog study, marginal-host-code benchmark or competitor comparison is not a prerequisite. CEL remains Keir's expression evaluator.

Deliver the host-design guidance as a skill for the developer's own coding agent to propose DCM/hooks/capability contracts and validation/evidence, with exact-revision host approval before publication. The coding agent uses its existing model and authentication. Core provides generic contracts and validators; no second in-app host-design chat is required.

The in-app customer extension assistant already uses the approved scoped catalog for generation/repair, checked examples and lifecycle decisions. Further host capabilities require explicit model revisions and verification. Neither assistant can certify its own guarantees or approve its own publication/activation. The app operator supplies server-side provider credentials; seeded demo users do not receive or expose those keys.

The [AI setup guide](ai-authoring.md) lists the two provider/model pairs accepted by the current adapters. Accepted configuration does not establish live compatibility. Qualify live behavior separately with explicit opt-in, operator keys and spend limits; fake-provider tests cover protocol regression. Do not promise interchangeable models. Keep secrets in ignored local configuration/environment, out of browser bundles, fixtures, logs and exports; document provider context and retention.

## Walkthroughs

`main` is the ready-configured host application. Visitors run it locally, sign in as different demo users and explore their independent customer customizations. Use the [customization walkthrough](../README.md#try-a-customization) to create and run a rule.

A future `pre-design-time` branch starts from the same native app before Keir host integration is completed. Visitors load the host-design skill in their coding agent to inspect the domain and help define the DCM, extension points, capability bindings and verification. Host-owner review remains required; this is the developer persona, separate from the in-app customer authoring persona and its provider configuration.

Create this branch/checkpoint once a useful native baseline exists. Back it with an immutable starting commit/tag, pin compatible core dependencies and document its scope, setup and deliberate refresh procedure. Verify that exact checkpoint; do not continually merge the finished integration into it. Treat it as a reproducible tutorial starting point rather than a second independently evolving app. Keep all planning and progress in the core roadmap's host-integration-assistant feature.

## Boundaries

- One app deployment may bundle the Java compiler for authoring. No separate compiler service is required.
- No arbitrary URLs, scripts, SQL, automatic retries, durable waits or effectful loops in extension programs.
- One mutation per invocation remains the first demo bound. Dates on tasks do not schedule extension execution.
- Real adapter guarantees and activation authority belong to the host; simulation cannot certify them.
- Daymark is [Apache 2.0 licensed](../LICENSE), with React/TypeScript, Fastify and SQLite selected and implemented. It is a local loopback application; a production deployment and reusable Studio packaging remain separate work.

Historical task design and review are preserved in `keir-core/docs/internal/design-baseline/`. That snapshot is reference material; this document owns ongoing application scope and the core repository owns framework specifications.
