# Application scope

The task manager is a useful application and a reference consumer of `keir-core`. It owns the UI, task data, authentication/authorization, task DCM, real adapters, business scenarios, AI-driven extension creation UI and activation lifecycle.

Daymark is a local web demonstration with isolated demo sign-in, native projects and tasks, and task-completion customizations using the pinned Keir packages. Visitors supply their own AI provider configuration for conversational authoring and Java 21 for compilation. Native task management requires Node and the local SQLite database. See [local setup](../README.md), the [native contract](native-task-app-design.md) and [task effects](task-effects.md).

## Experience and user scopes

- Deliver a distinctive, polished task application with coherent typography, spacing, color and interactions. Review rendered desktop/mobile, loading, empty and error states; include keyboard access. Choose a visual direction before implementation rather than accepting a generic generated dashboard.
- Seed three fictional demo users with an explicit local sign-in/sign-out flow. This is local demo impersonation, not enterprise authentication. Each user stands in for a SaaS customer, with separate projects/tasks and, when introduced, extension sources, scenarios, approvals and active bindings. The immutable host catalog can be shared; customer programs and activation remain scoped. A production identity platform is outside this demo's scope.
- Enforce ownership in host services and trusted invocation context. A client-supplied user/resource ID cannot select another user's data or extension. Async events retain their originating scope regardless of browser sign-out or user switching.
- Demonstrate different programs at the same hook for different users; changing, disabling or rolling back one user's customization must leave the others intact. Customer authors may approve their own extensions where host policy permits; the AI agent cannot grant itself approval or publish the host catalog.
- Persist local demo data across restarts and document a deliberate demo-data reset procedure. Keep runtime data and credentials out of tracked content; setup must use isolated project tooling.

## Extension Studio experience

The Extension Studio is the major demo experience: an agent chat is the primary interaction, with a contextual canvas showing useful UI as the agent works. The agent can visualize behavior, ask a structured clarification, present scenarios or compare results while the conversation continues. Canvas interactions feed explicit user input back into chat. This is not a staged wizard or workflow dashboard; application-owned components render the canvas, not arbitrary generated code.

This requires deliberate, detailed product, UI and interaction design before its production UI is implemented. Maintain its UX specification, screen/state inventory and interactive prototype in this repo; track design and implementation in the core roadmap's existing owning features. Agent-directed presentation never grants publication, approval or activation authority.

The design must show the full journey: describe intent, clarify requirements, inspect proposed behavior, create/review test scenarios, simulate, understand results, approve an exact revision, activate, observe native app behavior and revise/disable/roll back. Define backtracking and recovery, not only a successful linear path. A business user should understand what runs, when, for whom, what it may change and what has actually been verified without writing code or inspecting IR.

Specify conversation and structured review areas, information hierarchy, navigation, feedback and progress, draft versus active states, approval invalidation and scenario expectations. Cover setup, loading, empty states, unsupported requests, compiler repair, mismatches, provider failures, cancellation, reload/resume and switching users. Keep simulated evidence distinct from actual execution and preserve honest uncertainty.

Review an interactive prototype with the user before implementing the Studio UI. Include a full successful customization, a recoverable failed attempt, two users with different customizations and visible before/after behavior in the task app. Review visual polish, accessibility and interaction continuity using representative content; label scripted prototype behavior. Implemented acceptance later requires real authoring/lifecycle/native evidence, fast regression/UI journeys and opt-in live-provider checks.

## First connected demonstration

1. Deliver the polished local web flow with three demo logins, projects and native task create/edit/list/complete, working with extensions disabled and retained across restarts. Grow tags, priority, due dates and search alongside later integration work; completing every app feature is not a prerequisite to the first connected scenario.
2. Bind the packaged Node runtime to real scoped task reads. The Core Java sample and shared fixtures exercise the other runtime.
3. Admit `TaskCompleted` after native completion and expose generic `tasks.create`. Use actual task status and project data for the source-authored condition. The host owns user-scoped selection and event admission, protected origin and original idempotency-key forwarding.
4. Compile a handwritten scalar follow-up, review exact-artifact simulation, approve that artifact and execute it through the same Node runner with real adapters. A richer tag/search/168-hour example follows when core admits those expressions; it does not block the initial scalar integration.
5. Demonstrate no-op, business rejection, redelivery and uncertain outcomes. Verify atomic origin uniqueness, current authorization, pinned event admission and any claimed safe recovery with real persistence tests. Do not blindly replay an unknown effect.
6. Add a pre-create guard consumer: DENY prevents persistence, while CONTINUE still runs native authorization, validation and required consistency checks. No independent extension-owned write may precede the native commit.

The application uses the Node runtime. Core's Java runtime is also initial scope and is demonstrated through its Java host example and shared conformance; this does not require a second task app.

## Later increments

Add customer behaviors and host capabilities as implementation needs arise, through explicit approved DCM revisions. Exercise different hook/result paths to verify integration behavior. The product value is accepted; a frozen-catalog study, marginal-host-code benchmark or competitor comparison is not a prerequisite. CEL remains Keir's expression evaluator.

Deliver the host-design guidance as a skill for the developer's own coding agent to propose DCM/hooks/capability contracts and validation/evidence, with exact-revision host approval before publication. The coding agent uses its existing model and authentication. Core provides generic contracts and validators; no second in-app host-design chat is required.

Then deliver the distinct in-app customer extension assistant using the approved scoped catalog: bounded generation/repair, artifact-derived previews, reviewed scenario expectations, immutable approval, activation, disable and rollback. Neither assistant can certify its own guarantees or approve its own publication/activation. The app operator supplies their own server-side provider credentials; seeded demo users do not receive or expose those keys.

Qualify at least two provider/model configurations through the same authoring workflow, with required tool/structured-output capabilities, bounded cost, cancellation and clear setup/authentication errors. Evaluate a small adapter boundary or existing multi-provider library before selecting dependencies; do not promise every provider/model is interchangeable. Keep secrets in ignored local configuration/environment, out of browser bundles, fixtures, logs and exports. Document what is sent to the provider. Fast fake-provider tests cover regression; live compatibility checks use explicit opt-in, operator keys and spend limits.

## Two future walkthroughs

`main` is the ready-configured host application. Visitors run it locally, sign in as different demo users and explore their independent customer customizations. Use the [customization walkthrough](../README.md#try-a-customization) to create and run a rule.

A future `pre-design-time` branch starts from the same native app before Keir host integration is completed. Visitors load the host-design skill in their coding agent to inspect the domain and help define the DCM, extension points, capability bindings and verification. Host-owner review remains required; this is the developer persona, separate from the in-app customer authoring persona and its provider configuration.

Create this branch/checkpoint once a useful native baseline exists. Back it with an immutable starting commit/tag, pin compatible core dependencies and document its scope, setup and deliberate refresh procedure. Verify that exact checkpoint; do not continually merge the finished integration into it. Treat it as a reproducible tutorial starting point rather than a second independently evolving app. Keep all planning and progress in the core roadmap's host-integration-assistant feature.

## Boundaries

- One app deployment may bundle the Java compiler for authoring. No separate compiler service is required.
- No arbitrary URLs, scripts, SQL, automatic retries, durable waits or effectful loops in extension programs.
- One mutation per invocation remains the first demo bound. Dates on tasks do not schedule extension execution.
- Real adapter guarantees and activation authority belong to the host; simulation cannot certify them.
- License, UI framework, persistence engine, packaging and deployment choices remain open.

Historical task design and review are preserved in `keir-core/docs/internal/design-baseline/`. That snapshot is reference material; this document owns ongoing application scope and the core repository owns framework specifications.
