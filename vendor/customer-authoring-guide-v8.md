# Customer authoring guide

Companion edition 8 targets development Core 0.4.0 and exact producer `keir-compiler-java/0.4.0`. Source remains `keir/2`; model, artifact and scenario remain `/3`; the descriptor recipe remains `keir-record-descriptors/2`. This is unreleased source guidance, not installed-package qualification or authority to upgrade a host. Use it only when the host explicitly supports this exact tuple. Earlier editions and approved artifact bytes remain unchanged.

A distributable candidate requires a truthful committed Core compatibility record, a reviewed companion input commit and an independently verified archive pin. Until those inputs and actual package evidence exist, do not treat this guide or an in-memory recipe test as a qualified companion release.

## Discover and preserve authority

Get the host-approved model, entrypoint, supported package/producer tuple, compiler configuration and scoped authoring tools. Read the input/output types, capability results and errors, protected bindings, lifecycle and limits. Resolve named resources with authorized host tools. Ask only for unresolved business choices. If a needed hook, operation or producer is unavailable, report that boundary rather than inventing an adapter, model field or host upgrade.

EVENT/AFTER_COMMIT/EVENT_REPORT runs after the native operation and cannot veto it. REQUEST/BEFORE_COMMIT/DECISION is read-only and runs before native commit. The host owns authentication, permissions, original keys, protected arguments, exact artifact approval/selection, native consistency, cancellation and commit. A simulation establishes none of those native guarantees.

## Draft and compile

Use only declared data and capabilities. Preserve exact Boolean, String, nominal, enum, Timestamp and bounded-list types. Use typed literals for nominal identifiers; do not supply protected parameters. Optional absence is not null: false and empty String are present. Lists remain bounded host values, not computed collections. Timestamps use canonical UTC millisecond strings; Duration is expression-only literal whole seconds.

Compile with compiler 0.4.0 against the exact trusted `/3` model. Use diagnostic codes and paths for bounded repair without changing the requested behavior. Source or model changes require compilation and new artifact approval. The compiler never impersonates an older producer or authors against a `/2` model.

Count every possible call and write, including skipped and mutually exclusive calls: eight steps, four calls, at most one possible event WRITE, and zero possible decision WRITEs. Existing expression/value/trace ceilings remain in force. No retry, numeric feature, list transformation or additional effect is introduced.

## Use a conditional call's actual scalar result

If an earlier CALL `r` has `when: g`, and `g` names an earlier unconditional Boolean BIND, use `g ? r.reference : input.existingReference`. Only that exact checked identifier establishes result existence in its true arm. Parentheses that parse to the same identifier do not change it. An equivalent Boolean expression, alias of a different guard, `g && other`, negation or a constant supplies no proof. If the CALL itself uses an alias as its guard, that exact alias identifier is required.

For an optional scalar use both proofs in one expression: `g ? (has(r.note) ? r.note : "") : ""`. A field-presence test cannot prove its record exists. Proof persists inside nested subexpressions of the true arm, not into false arms, siblings or later expressions. A valid scalar conditional BIND becomes an ordinary typed value afterward. Do not read a bare guarded record or any of its list fields, even for membership.

The rule applies to later BINDs, arguments, handler fields and root return fields. A consuming CALL's own `when` supplies no implicit proof. Arguments and handlers see the environment before their own CALL, never its own result. A later rejection handler can use an earlier successful result with the same explicit proof, but remains a terminating BUSINESS_REJECTION, not authorization to continue.

The complete [event source](../../conformance/keir-3/source-guarded-result.json) and [model](../../conformance/keir-3/dcm-guarded-result.json) return the adapter's actual validated nominal reference on success and the input reference when skipped. The [READ decision source](../../conformance/keir-3/source-guarded-result-read.json) and [model](../../conformance/keir-3/dcm-guarded-result-read.json) preserve zero WRITE authority and the existing decision/message consumer shape. Separate [handler](../../conformance/keir-3/source-guarded-result-handler.json) and [unused-result](../../conformance/keir-3/source-guarded-result-unused.json) examples exercise those environments. Their compiled artifacts, byte pins and independently specified scenarios accompany the guide.

## Simulate and submit

Agree on complete expected outcomes before simulation. Run the exact artifact with the host's simulated implementations. Cover true/skipped calls, actual returned references, optional absent/empty/false fields, misleading guards, repeated true/false invocations, rejection, transient and uncertain outcomes, malformed/oversized values and expiry. A failed call never becomes absence or chooses a successful fallback. No placeholder record is supplied for a skipped call.

Report business results, ordered calls, traces and write receipts separately. CONFIRMED is reported commit evidence, NONE definite no-effect evidence, and UNKNOWN unresolved attempted effect. A later failure preserves a confirmed receipt. Reconciliation belongs to the host. For decisions, only valid COMPLETED ALLOW with empty effects permits further native checks. DENY or failed/malformed evaluation blocks; handled BUSINESS_REJECTION with ALLOW still blocks. Observe native attempts/results separately from decision consumption.

Present the exact model/artifact revision and expected/observed evidence to the authorized reviewer. Approval and activation are separate host decisions. Prior `/2` and earlier `/3` approvals remain tied to their exact bytes; recompilation never transfers approval.

## Matching references

The archive's manifest identifies its exact committed source, compatibility status and payload digests. Bundled [language](../specs/language.md), [artifact](../specs/compiler-artifact.md), [runtime](../specs/runtime.md), [workflow-expression](../specs/workflow-expressions.md), [model](../specs/domain-model.md) and [decision](../specs/pre-operation-decisions.md) references define these semantics. Bundled source/model/artifact/scenario schemas check structure, not runtime proof or host authority. Other integration references belong to the matching repository documentation. Supply the host's own exact model and authorized tools separately.
