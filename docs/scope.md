# Application scope

The task manager is a useful application and a reference consumer of `keir-core`. It owns the UI, task data, authentication/authorization, task DCM, real adapters, business scenarios, AI-driven extension creation UI and activation lifecycle.

The app is a local web demonstration: visitors clone this repository, follow documented prerequisites/setup and open it in their browser. The complete extension-authoring experience requires the visitor to configure their own AI provider/model and credentials. Native tasks and already activated extensions remain usable without AI calls; this fallback does not replace the AI-driven creation UI. Local hosting needs no sibling core checkout or hosted database. Packaged core behavior is available; native app implementation remains unassigned until a bounded manager assignment.

## Experience and user scopes

- Deliver a distinctive, polished task application with coherent typography, spacing, color and interactions. Review rendered desktop/mobile, loading, empty and error states; include keyboard access. Choose a visual direction before implementation rather than accepting a generic generated dashboard.
- Seed three fictional demo users with an explicit local sign-in/sign-out flow. This is local demo impersonation, not enterprise authentication. Each user stands in for a SaaS customer, with separate projects/tasks and, when introduced, extension sources, scenarios, approvals and active bindings. The immutable host catalog can be shared; customer programs and activation remain scoped. A production identity platform is outside this demo's scope.
- Enforce ownership in host services and trusted invocation context. A client-supplied user/resource ID cannot select another user's data or extension. Async events retain their originating scope regardless of browser sign-out or user switching.
- Demonstrate different programs at the same hook for different users; changing, disabling or rolling back one user's customization must leave the others intact. Customer authors may approve their own extensions where host policy permits; the AI agent cannot grant itself approval or publish the host catalog.
- Persist local demo data across restarts and document a deliberate demo-data reset procedure. Keep runtime data and credentials out of tracked content; setup must use isolated project tooling.

## First connected demonstration

1. Deliver the polished local web flow with three demo logins, projects and native task create/edit/list/complete, working with extensions disabled and retained across restarts. Grow tags, priority, due dates and search alongside later integration work; completing every app feature is not a prerequisite to the first connected scenario.
2. Consume the packaged core read-and-decide path through an on-demand hook and a real scoped read. The core Java sample and shared fixtures prove the other runtime; do not build a second task app.
3. Once core's real-effect assurance/admission contract and actual native evidence are accepted, admit `TaskCompleted` after native completion and expose generic `tasks.create`. Existing simulation-only support is insufficient. Use actual task status/project data for the source-authored condition, not a customer-specific eligibility adapter. The host owns user-scoped selection/event admission, protected origin and original idempotency-key forwarding.
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

`main` becomes the ready-configured host application: visitors run it locally, sign in as different demo users and explore their independent customer customizations. The scaffold is not configured or runnable yet.

A future `pre-design-time` branch starts from the same native app before Keir host integration is completed. Visitors load the host-design skill in their coding agent to inspect the domain and help define the DCM, extension points, capability bindings and verification. Host-owner review remains required; this is the developer persona, separate from the in-app customer authoring persona and its provider configuration.

Create this branch/checkpoint once a useful native baseline exists. Back it with an immutable starting commit/tag, pin compatible core dependencies and document its scope, setup and deliberate refresh procedure. Verify that exact checkpoint; do not continually merge the finished integration into it. Treat it as a reproducible tutorial starting point rather than a second independently evolving app. Keep all planning and progress in the core roadmap's host-integration-assistant feature.

## Boundaries

- One app deployment may bundle the Java compiler for authoring. No separate compiler service is required.
- No arbitrary URLs, scripts, SQL, automatic retries, durable waits or effectful loops in extension programs.
- One mutation per invocation remains the first demo bound. Dates on tasks do not schedule extension execution.
- Real adapter guarantees and activation authority belong to the host; simulation cannot certify them.
- License, UI framework, persistence engine, packaging and deployment choices remain open.

Historical task design and review are preserved in `keir-core/docs/internal/design-baseline/`. That snapshot is reference material; this document owns ongoing application scope and the core repository owns framework specifications.
