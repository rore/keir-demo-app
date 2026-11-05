# Keir customer authoring guide

Help a customer draft and check an extension for their application. Ask about business choices in plain language and use the host’s tools for technical checks.

## Find out what the application allows

- Obtain the exact host-approved domain capability model (DCM), available entrypoints, and compiler configuration. Use scoped lookup for resources the customer names. Ask when a choice is ambiguous. If a required operation or the approved model is unavailable, explain the limit and stop that proposal.
- Read the entrypoint’s event, input, result and write limits. For each operation, read its parameter and result types, declared errors, and READ or WRITE effect. Only operations exposed by the model can appear in the extension. The host’s lookup, compilation and simulation tools support authoring separately.

## Draft and compile

- Trace each argument to an input, a customer-selected constant, or an available earlier result. Use declared fields and matching types. Use a typed literal for a fixed identifier, and an earlier unconditional Boolean value for a guard. A guarded call’s result is unavailable to later expressions.
- Leave identity, credentials, event context and request keys to the host. Count every possible write, including guarded writes. An extension can contain at most one write, and the entrypoint can restrict it to reads.
- Compile against the exact approved model. Use the diagnostic code and path to repair the draft while preserving the customer’s intent. Ask before changing that intent. If the model changes, compile and check the draft again.

## Simulate and hand back

- Agree on expected outcomes before running the exact compiled artifact in simulation. Include a matching case, a skipped action and any relevant denial or lost-response case. Compare observed results and write receipts with those expectations separately.
- `CONFIRMED` records a confirmed write. `NONE` records a definite no-effect outcome. `UNKNOWN` means the write may have happened. Surface uncertainty and leave reconciliation to the host. Use simulated operations for checks.
- Present the exact checked revision and its evidence to the authorized reviewer. Approval and activation are separate host decisions. A changed revision needs its own checks and approval.

## Follow-up example

The [source](../../conformance/keir-1/source.yaml) uses the [task model](../../examples/node-host/follow-up/dcm.json) to request a follow-up when a completed task belongs to the selected project. The [compiled artifact](../../conformance/keir-1/artifact.json) is paired with three independent scenarios showing a [confirmed write](../../conformance/keir-1/scenarios/main/normal.json), a [different project](../../conformance/keir-1/scenarios/main/other-project.json), and a [lost response](../../conformance/keir-1/scenarios/main/lost-response.json). The verification host selects the artifact and supplies the trusted context. The normal fixture returns the responses listed in the scenario. The lost-response fixture throws after dispatching the write, so its receipt is `UNKNOWN`.

Document shapes are defined by the [source](../../schemas/source-1/source.schema.json), [model](../../schemas/dcm-1/dcm.schema.json), [artifact](../../schemas/artifact-1/artifact.schema.json) and [scenario](../../schemas/scenario-1/scenario.schema.json) schemas. The compiler and runtimes enforce the semantic rules.
