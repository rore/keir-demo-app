# Keir 2 customer authoring guide

Authoring companion edition 4 pairs with Keir Core 0.2.0. Use the verified Core packages and a host that has enabled the Keir 2 contract.

## Discover the host contract

- Get the exact approved model, event entrypoint and compiler configuration from the host. Use the host's scoped lookup for resources the customer names. Ask when the request is ambiguous. If a required capability or the approved model is unavailable, explain the limit and stop that proposal.
- Read the entrypoint input, result and write limit. For each operation, check its business parameters, protected parameters, result type, declared errors and effect. The host supplies the authenticated actor, event, original request key and deadlines.

## Draft the extension

- Use only declared inputs, operations and earlier available results. Match their types. Use a typed literal for a fixed nominal identifier. For a list, test a value of its declared element type with `in`, or pass the list through unchanged. With an enum list, a direct literal naming a declared member also works.
- Use `has` on a declared optional field before reading it. Keep the check and the read in the same expression, in a guarded conditional arm or on the right of `&&`. Leave unused optional arguments and result fields out. A supplied `false` or empty string is present. `null` is invalid.
- Use UTC millisecond timestamps supplied by the host or `timestamp` with a canonical literal. Use `duration` with literal whole seconds for elapsed time. For seven elapsed days, use `duration("604800s")`. Use the event time from the input as the base when the customer's request is relative to the event.
- Count every possible write. One extension may contain at most one, including guarded or mutually exclusive calls. Choose a single write operation when needed. A host's entrypoint can allow only reads.
- Compile against the exact model. Use the diagnostic code and path to repair the draft while preserving the customer's intent. A changed model needs a new compile and check. [Keir 2 expression and model rules](../specs/workflow-expressions.md)

## Simulate and hand back

- Agree on independent expected outcomes before simulating the exact compiled artifact. For a membership rule, include a match and a miss. For optional input, check omission and a present value. For elapsed time, check the resulting timestamp and relevant range boundaries.
- Report the rule result and write receipt separately. `CONFIRMED` records a confirmed write, `NONE` a definite no-effect outcome, and `UNKNOWN` an attempt whose effect could not be established. An error after a confirmed write keeps the receipt. Leave reconciliation of uncertain writes to the host.
- Present the exact checked revision and evidence to the authorized reviewer. Approval and activation are separate host decisions. A changed revision needs its own check and approval.
