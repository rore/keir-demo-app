# Application scope

The task manager is a useful application and a reference consumer of `keir-core`. It owns the UI, task data, authentication/authorization, task DCM, real adapters, business scenarios and optional AI authoring and activation lifecycle.

## First connected demonstration

1. Create, list, edit and complete tasks in projects with tags, priority and due dates. Native task operations remain usable with extensions disabled.
2. Admit `TaskCompleted` only after a successful native completion. Expose bounded scoped reads and one protected task-create capability.
3. Compile a handwritten follow-up extension, review its deterministic simulation, explicitly approve the exact artifact and execute it using the same Node runner with real adapters.
4. Demonstrate no-op, business rejection, event replay and uncertain outcomes. Prove atomic origin uniqueness, current authorization and host-controlled replay with real persistence tests.

The application uses the Node runtime. Core's Java runtime is also initial scope and is demonstrated through its Java host example and shared conformance; this does not require a second task app.

## Later increments

Select additional customer behaviors that use meaningfully different operations or dependencies from one approved catalog. Weekly review alone repeats the invoice follow-up call shape, so it is not sufficient evidence of catalog reuse. Measure host code added per customization and the one-time cost of publishing hooks, capabilities, types and contracts. Compare the same requests with vendor-prewired hooks and relevant existing extension architectures. CEL can be used within either architecture; it is Keir's expression evaluator, not a competing product. Add any new hook or capability through an explicit DCM revision.

Then add bounded conversational authoring, compiler-diagnostic repair, artifact-derived behavior previews, independently reviewed scenario expectations, immutable approval, activation, disable and rollback.

## Boundaries

- One app deployment may bundle the Java compiler for authoring. No separate compiler service is required.
- No arbitrary URLs, scripts, SQL, automatic retries, durable waits or effectful loops in extension programs.
- One mutation per invocation remains the first demo bound. Dates on tasks do not schedule extension execution.
- Real adapter guarantees and activation authority belong to the host; simulation cannot certify them.
- License, UI framework, persistence engine, packaging and deployment choices remain open.

Historical task design and review are preserved in `keir-core/docs/design-baseline/`. That snapshot is reference material; this document owns ongoing application scope and the core repository owns framework specifications.
