# Customer authoring guide

Companion edition 7 is for Keir Core 0.3.1. It uses source `keir/2`, model `keir-dcm/3`, artifact `keir-artifact/3`, scenario `keir-scenario/3` and descriptor recipe `keir-record-descriptors/2`. Use the verified compatibility record supplied with the companion and the exact host model.

This edition is an unpublished packaging candidate. It includes the full project license and compiler-produced 0.3.1 examples without changing the runtime contracts; a candidate archive does not establish new release qualification.

## Discover

Get the host's approved model, exact entrypoint, compiler configuration and scoped tools. Read the input and output types, lifecycle, capabilities, parameters, protected bindings, declared errors and call/write limits. Resolve customer-named resources through authorized host tools. Ask only for missing business choices. If the required hook or operation is unavailable, explain that limit and stop the proposal.

Choose behavior for the declared lifecycle. EVENT/AFTER_COMMIT/EVENT_REPORT runs after the original operation and cannot veto it. REQUEST/BEFORE_COMMIT/DECISION evaluates a proposed operation before native commit. Do not relabel an event or an advisory result as an authoritative decision.

## Draft and compile

- Use only declared input and operations and definitely available earlier results. Use the exact declared semantic types, including typed literals for nominal identifiers. Never supply protected parameters from source.
- For bounded lists, use membership with the declared element type or pass the list through unchanged. For optional fields, keep `has` and the protected read in the same expression. Omission is absent; `false` and an empty string are present; `null` is invalid.
- Use host-supplied canonical UTC millisecond timestamps or `timestamp` with a valid literal. Use `duration` with literal whole seconds for elapsed time. Seven elapsed days is `duration("604800s")`.
- Count every potential call and write, including false-guarded and mutually exclusive calls. Event extensions can contain at most one possible WRITE, subject to host restrictions. Decision extensions can contain none, even if the catalog publishes WRITE operations for other hooks.
- Compile with compiler 0.3.1 against the exact `/3` model. Use diagnostic codes and paths for bounded repair while preserving the customer's intent. Source or model changes require a new compile. Compiler 0.3.1 does not author against `/2` models.

## Return a decision

For a DECISION hook, return its closed output record with required `decision`. Its named enum has exactly `ALLOW` and `DENY`. Additional host-declared bounded scalar fields, such as a plain-text message, are permitted. Use approved READ results to choose the decision; do not invent capability names or expose native authority in the source.

Only valid COMPLETED ALLOW with empty effects permits the host to continue. DENY stops the native operation. Failed or malformed evaluation blocks it. A handled BUSINESS_REJECTION with an ALLOW result still blocks. ALLOW is not evidence that the native operation committed.

The host authenticates requests, selects approved artifacts, supplies protected context and owns native validation, permissions, consistency, cancellation and commit. It distinguishes authoritative absence from an unavailable selected extension and rechecks mutable facts at commit. Do not infer or fabricate those guarantees from a successful simulation.

## Simulate and submit

Agree on expected outcomes before simulation. Use the exact compiled artifact with the host's simulated implementations. For a decision, include ALLOW, DENY, denied and failed READs, malformed output, expiry and cancellation. Include a handled rejection with ALLOW and a native failure after ALLOW. Check any declared message as plain text. Observe native attempts and results separately from decision consumption.

For an event extension, test the matching and no-op paths and relevant business rejection and uncertain-write cases. Report business results and write receipts separately. CONFIRMED records reported commit evidence, NONE definite no-effect evidence, and UNKNOWN a write whose effect could not be established. An error after a confirmed write retains its receipt. Reconciliation belongs to the host.

Present the exact checked artifact/model revision and expected and observed evidence to the authorized reviewer. Approval and activation are separate host decisions. A changed artifact needs its own checks and approval. Existing `/2` and compiler 0.3.0 `/3` approvals stay tied to their old artifact and model bytes; recompilation never transfers approval.

## References

Read the [language rules](https://github.com/rore/keir-core/blob/5c772d02b4dc92bb28ea8aedabd34498ff6d9391/docs/specs/language.md), [model rules](https://github.com/rore/keir-core/blob/5c772d02b4dc92bb28ea8aedabd34498ff6d9391/docs/specs/domain-model.md), [workflow expressions](https://github.com/rore/keir-core/blob/5c772d02b4dc92bb28ea8aedabd34498ff6d9391/docs/specs/workflow-expressions.md) and [pre-operation decision contract](https://github.com/rore/keir-core/blob/5c772d02b4dc92bb28ea8aedabd34498ff6d9391/docs/specs/pre-operation-decisions.md) for semantics. These links pin the matching specification revision. Use the bundled [source](../../schemas/source-2/source.schema.json), [model](../../schemas/dcm-3/dcm.schema.json), [artifact](../../schemas/artifact-3/artifact.schema.json) and [scenario](../../schemas/scenario-3/scenario.schema.json) schemas for structure.

The [example model](../../conformance/keir-3/dcm-guard.json) supports [input-only](../../conformance/keir-3/source-guard-input.json), [READ-based](../../conformance/keir-3/source-guard.json) and [handled-rejection](../../conformance/keir-3/source-guard-handler.json) sources. Their separate compiled artifacts and digest files are bundled unchanged. Scenarios cover [input ALLOW](../../conformance/keir-3/scenarios/guard-input/guard-input-allow.json), [input DENY](../../conformance/keir-3/scenarios/guard-input/guard-input-deny.json), [READ ALLOW](../../conformance/keir-3/scenarios/guard/guard-allow.json), [READ DENY](../../conformance/keir-3/scenarios/guard/guard-deny.json) and [handled rejection with ALLOW](../../conformance/keir-3/scenarios/guard-handler/guard-handler-allow.json), which still blocks native continuation. Supply host-specific models and tool definitions separately.
