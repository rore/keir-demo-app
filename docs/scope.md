# Application scope

The task manager is a useful application and a reference consumer of `keir-core`. It owns the UI, task data, authentication/authorization, task DCM, real adapters, business scenarios and optional AI authoring and activation lifecycle.

## First connected demonstration

1. Deliver a small native create/list/complete task flow that works with extensions disabled. Grow the remaining CRUD, projects, tags, priority, due dates and search alongside later integration work; completing every app feature is not a prerequisite to the first connected scenario.
2. Consume the packaged core read-and-decide path through an on-demand hook and a real scoped read. The core Java sample and shared fixtures prove the other runtime; do not build a second task app.
3. Once core's scalar-effect path is accepted, admit `TaskCompleted` after native completion and expose one protected create capability. Use actual task status/project data for the source-authored condition, not a customer-specific eligibility adapter. The host owns event admission, protected origin and original idempotency-key forwarding.
4. Compile a handwritten scalar follow-up, review exact-artifact simulation, approve that artifact and execute it through the same Node runner with real adapters. A richer tag/search/168-hour example follows when core admits those expressions; it does not block the initial scalar integration.
5. Demonstrate no-op, business rejection, redelivery and uncertain outcomes. Verify atomic origin uniqueness, current authorization, pinned event admission and any claimed safe recovery with real persistence tests. Do not blindly replay an unknown effect.
6. Add a pre-create guard consumer: DENY prevents persistence, while CONTINUE still runs native authorization, validation and required consistency checks. No independent extension-owned write may precede the native commit.

The application uses the Node runtime. Core's Java runtime is also initial scope and is demonstrated through its Java host example and shared conformance; this does not require a second task app.

## Later increments

Add customer behaviors and host capabilities as implementation needs arise, through explicit approved DCM revisions. Exercise different hook/result paths to verify integration behavior. The product value is accepted; a frozen-catalog study, marginal-host-code benchmark or competitor comparison is not a prerequisite. CEL remains Keir's expression evaluator.

Demonstrate the host integration assistant helping the app developer propose DCM/hooks/capability contracts and validation/evidence, with exact-revision host approval before publication. Core provides generic contracts and validators; the host owns this agent/tool integration. It need not be a separate chat product.

Then demonstrate the distinct customer extension assistant using the approved scoped catalog: bounded generation/repair, artifact-derived previews, reviewed scenario expectations, immutable approval, activation, disable and rollback. Neither assistant can certify its own guarantees or approve its own publication/activation. Provider, credentials and spend limits are decided before live model calls.

## Boundaries

- One app deployment may bundle the Java compiler for authoring. No separate compiler service is required.
- No arbitrary URLs, scripts, SQL, automatic retries, durable waits or effectful loops in extension programs.
- One mutation per invocation remains the first demo bound. Dates on tasks do not schedule extension execution.
- Real adapter guarantees and activation authority belong to the host; simulation cannot certify them.
- License, UI framework, persistence engine, packaging and deployment choices remain open.

Historical task design and review are preserved in `keir-core/docs/internal/design-baseline/`. That snapshot is reference material; this document owns ongoing application scope and the core repository owns framework specifications.
