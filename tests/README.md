# Application verification

Build with `npm run build`. `npm test` uses Node's test runner and temporary SQLite databases. Full authored-source verification also needs the pinned compiler and Java 21. Tests do not install Java, change global configuration, reuse an operator database or make live provider requests.

This integration stages the independently qualified unpublished Core 0.5.0 compiler/runtime candidate. New authoring uses source `/3`, model `/4`, artifact/scenario `/4`; retained-model authoring uses source `/2`, model `/3`, artifact/scenario `/4`. Original `/2` event artifacts and compiler-0.3.0/0.3.1/0.4.0 `/3` artifacts keep their exact pins and approvals. The corrected companion 9 packet is byte-pinned, including its offline guide-linked index. Source review and this host's executable qualification remain pending. There is a separate selection for each trigger. See [task customizations](../docs/task-effects.md) and [package provenance](../docs/package-provenance.md). Runtime startup requires no deployment certificate or report approval.

Before-create tests compile the three required rules with the actual compiler, run independent scenario expectations, approve and activate exact artifacts, and exercise native/API creation. They cover read consistency, the operation's own insert, parent budgets, cancellation, approval/selection changes, original-key concurrency, old/new artifact coexistence, native limits and unchanged automation receipt bytes. Separate decision-consumer checks reject malformed outputs, trace/ledger inconsistencies and handled rejections that return ALLOW.

Creation-operation tests exercise committed-response recovery across restart, canonical candidate mismatch, immutable snapshots after task edits/deletion, current project/session access, concurrent winners, atomic rollback, and the real exclusive reset/backup inventory. Browser checks cover the three actual rule journeys at desktop, 320px and 683×384, separately from mocked Studio presentation tests. They assert denial/unavailable field retention and a single corrected native save. Recorded browser qualification does not certify other browser engines or live deployment.

## What each layer proves

The v11 migration fixture, `fixtures/daymark-shipped-v11.sqlite.gz`, was created with Daymark `59c819a` and synthetic data. It includes all four completion states, a settled receipt and reconciliation, and legacy title and notes containing embedded NUL bytes. Tests also derive an exact v10 schema from it by removing the two v11 task columns. The v12 fixture, `fixtures/daymark-shipped-v12.sqlite.gz`, comes from upgrading that copy with exact Daymark `e007019` and settling its eligible pending event through the Keir 1 dispatcher. It also contains a definitive no-effect receipt from the old native adapter. Stage B tests retain both kinds of receipt and verify that a later unrevoked pending admission blocks cutover.

| Layer | Coverage and boundary |
| --- | --- |
| Native data/API/session tests | Owner-scoped CRUD, validation, committed-write identity, auth races, locks, fresh database initialization, rejection of unsupported databases before writable open, current backups, reset and restart preservation. |
| Distribution/compiler tests | Actual package/provenance identity, pinned compiler diagnostics, source/output bounds, cancellation and child-process settlement. A synthetic admitted artifact used in an API test does not qualify compiler semantics. |
| Task-effect simulation tests | Whole-suite validation before dispatch, exact artifact admission, synthetic capability calls and responses, independent expectations, match/nonmatch reports and confirmed/none/unknown effects. |
| Native effect storage/persistence/process tests | Original completion identity, atomic claim and effect receipt handling, recovery and bounded process-crash/restart guarantees against actual SQLite/native services. These are not arbitrary power-loss guarantees. |
| Runtime binding/dispatch tests | Complete compatible implementation binding, exact artifact preparation reuse, fresh invocation context, native denial/revocation/deadlines and unavailable binding without blocking native CRUD. |
| Authoring tests | Bounded project discovery and public contract, independent cases, durable turns/receipts/accounting, strict provider envelopes, cancellation and exact recovery. Scripted provider transports establish no live model compatibility. |
| Lifecycle tests | Exact item/revision/draft/evidence identity, approval independent of latest proof, separate activation, generation conflicts, deletion, and source/history preservation for current-contract revisions. |
| Browser UI tests | Human decisions and native navigation, current/proposed proof identity, outcome honesty, owner/late-response fences, layout, focus and retained unsent fields. Projection mocks are identified separately from full runtime journeys. |

Relevant files include `data.test.mjs`, `api.test.mjs`, `session-race.test.mjs`, `startup.test.mjs`, `distribution.test.mjs`, `compiler.test.mjs`, `task-effect-simulation.test.mjs`, `native-task-effect-storage.test.mjs`, `native-task-effect-persistence.test.mjs`, `native-task-effect-process.test.mjs`, `task-effects.test.mjs` and `task-effects-runtime.test.mjs`. The authoring and lifecycle suites cover current revisions, and the cutover tests exercise rejection of obsolete inputs.

`keir-scenario.test.mjs` checks the pinned historical Core assets and runs all 45 Keir 1 raw vectors through the shared lexical, structural and UTF-8 byte checks. `task-workflow-simulation.test.mjs` preserves scenario `/1`–`/3` reading and checks current `/4` admission. Fixture, typing, artifact admission and dispatch checks use the task-effect and task-workflow simulation suites. [Core input provenance](../vendor/keir-verification/provenance.json)

Provider configuration/setup tests use temporary synthetic credentials and settings. They cover local persistence, precedence, validation and fresh-conversation behavior without contacting providers. The allowance ledger preserves reservations across cancellation, reset and settings changes. Authoring boundary tests distinguish exact saved proof from latest evidence, exclude protected host authority, and retain exact current operation recovery after deletion. History pagination and continuity tests preserve older work without sending it automatically to a provider.

`task-rule-description.test.mjs`, `task-follow-up-summary.test.mjs` and `task-rule-projection.test.mjs` cover checked-artifact descriptions, old/current JSON/YAML compatibility, aliases, elapsed offsets, unsupported constructs and exact read-only lifecycle associations. `evidence-summary.test.mjs` separates verification, availability and effect certainty; `rule-description-view.test.mjs` checks human wording without interpreting executable source.

## Browser checks

`studio-unsent-draft.spec.mjs` checks exact same-item draft retention across navigation and reload, person/item/authentication-session isolation, storage and fingerprint failures, first-item binding, and newer identical or empty edits across delayed acceptance, rejection and recovery. It uses synthetic saved items and scripted provider responses; retained drafts never become turns without an explicit send.

`studio-business-understanding.spec.mjs` exercises an offline due-date conversation through clarification, the inline behavior/before-after/simulation brief, separate approval and activation, a real effect on isolated native task rows, reopening and an edit while the earlier version stays on. It asserts complete supported scope, conditional uncertainty, situation labels and decision order, and captures desktop, narrow and short layouts with retained unsent text. A second behavior checks an exact supplied name across reload. The provider transport is scripted; this does not establish live-model adherence. Parallel browser commands must use separate `--output` directories so traces and screenshots do not overwrite each other.

From a checkout with the documented Node/npm runtime:

```sh
npm run build
npm run test:browser:install
npm run test:e2e
```

Browser setup downloads pinned Chromium into ignored `.tools/playwright/`, separate from installed browsers and profiles. Browser fixtures own their loopback ports, app processes and temporary databases. Screenshots and traces live under ignored `build/` output. Mobile viewports do not certify physical devices or other browser engines. Download/setup is separate from warm test execution.

`task-customization-ui.spec.mjs` uses exact mocked Studio, evidence and reaction projections alongside real isolated native CRUD. It covers inline review, secondary inspection of current and proposed proofs, mismatch inspection, separate approval and activation, and activation gating when the installation is unavailable. Reaction cases cover unavailable sources, UNKNOWN outcomes and independent reconciliation of an original UNKNOWN. Created-task links require an owner-scoped confirmed receipt. The suite also covers foreign and late-owner responses, lost completion response readback, return focus after inspecting a created task, and unsaved native fields on list refresh. The optional `TASK_UI_STATIC_ROOT` selects an already-built isolated UI fixture.

Layout, recovery, setup, lifecycle and integrated-authoring journeys cover owner boundaries, late responses, reading position, unsaved native fields and exact authority under the current contract. `continuous-authoring.spec.mjs` exercises current conversation and history pagination, retry at the exact cursor and lost first-create receipt recovery. Layout cases include wheel/PageDown, stable rail/header/composer, pane edges, splitter limits and narrow/short viewports. Rendered designer review remains separate from automated assertions.

The earlier Keir 2 integrated qualification passed the four workflows for intake priority, review-task creation, open-match follow-ups and missing due dates. Each used the same compiled artifact in simulation and against native task rows. The migration checks covered preserved records and receipts, rollback, the pending-event guard, reopening and restore with the previous package. That hosted run passed the build, 375 Node tests and 182 Chromium tests, with 12 opt-in Node tests skipped. [Native workflow tests](native-task-workflow.test.mjs) · [Workflow browser tests](e2e/studio-workflow.spec.mjs) · [Hosted verification](https://github.com/rore/keir-demo-app/actions/runs/42261861370)

## Offline configured-AI fixture

`tests/fixtures/authoring-server.mjs` supplies scripted provider transport and uses isolated settings and data. Compiler, simulator and application routes are real where the fixture invokes them. `authoring-integrated.spec.mjs` covers the configured transport journey, while `studio-workflow.spec.mjs` covers the two task triggers and four workflow examples. Live-provider qualification is separate.

## Optional live checks and reporting

The provider qualification command is dry by default. A live run requires explicit authorization of provider costs and its separate finite allowance; saving in-app configuration does not grant that authorization. See [AI authoring](../docs/ai-authoring.md#optional-live-provider-qualification). Provider qualification is separate from native runtime, permission and persistence checks.

Keep default regression fast, record actual duration and investigate regressions. Use focused checks for changed behavior, then the required broader gates. Report failures, skipped work and mock boundaries explicitly; do not substitute a fixture PASS for actual package, provider or native execution verification. CI results and measured reports remain evidence with their stated scope, not production authentication or general durability guarantees.

## Candidate compatibility fixtures

[The retained 0.3.0 snapshot](fixtures/saved-core-0.3.0.json) contains fictional source, real compiled artifacts, simulated evidence, approvals and active selections captured from demo revision `74778142e29048bfae0493d264a2e6e2fe7a14fd`, using its unchanged independently packaged Core 0.3.0 compiler and runtime. It covers all three hooks. No provider was called. Tests restore the original byte pins and recreate its fictional referenced project; they do not stamp an old producer into a new artifact. The retained 0.3.1 snapshot was captured from demo revision `a484d92bdd91b2c0ac6e0f6232d33820a51ca360` with its unchanged 0.3.1 packages before this upgrade. The current guard-summary fixture was regenerated through the published 0.4.0 compiler; its 0.3.0 and 0.3.1 originals remain alongside it.

Candidate compatibility tests reopen old and new selections on their exact models, enforce producer/host matching, run both event hooks in both cache orders with real native receipts, and exercise concurrent guards through native ALLOW, DENY and unavailable-proof BLOCKED paths. Original identities, evidence, approvals and selections must remain unchanged. The planned authentic 0.4 snapshot is captured only in disposable hosted qualification from exact baseline `77feb10032d3b63475057564ca56099b1e498faa`, using its separately installed 0.4 compiler/runtime. No old artifact is relabeled. The baseline install and capture have 120-second and 90-second child bounds inside the unchanged 25-minute job ceiling; their private cache and checkout are removed on exit. The resulting fixture must be inspected and pinned after successful capture. No capture or product test has run for this working change yet.

## Conditional follow-up

`task-conditional-follow-up.test.mjs` compiles with the pinned candidate JAR and executes the installed runtime against six independently specified scenarios: eligible absent/found, Normal priority, another project, failed lookup and failed task read. Assertions include exact ordered calls, skipped lookup traces, complete outcomes and receipts, compiler rejection of unproved result access, conservative unsupported summaries, and real native creation/no-op behavior. `studio-conditional-follow-up.spec.mjs` adds the real app journey through scripted clarification, summary, simulation, separate approval/activation, native Tasks and reopening, with narrow/short summary checks. It makes no live provider requests.

`core-candidate-compatibility.test.mjs` reopens authentic saved 0.3.0, 0.3.1 and hosted-captured 0.4.0 approvals, retains their rows unchanged, and executes them beside new 0.5.0 rules in both cache orders across all three hooks. `distribution.test.mjs` checks installed package bytes and exact retained package identity. These checks do not establish atomic uniqueness for the open-task snapshot or general production scale. The [business example](../docs/conditional-follow-up.md) describes the boundary.

## Numeric tag-count and notes journey

`task-tag-notes.test.mjs` specifies eight independent complete scenario expectations and native zero-through-eight tag boundaries, normalization/deduplication, whitespace-only notes, pre-hook rejection of invalid/nine tags, committed-response readback, later edits, automation immutable NONE receipts and replay, and retained/numeric profile switches. Summary negatives mutate actual checked protobuf overloads. Each test has a 60-second bound. Historical definition and fixture bytes stay unchanged.

`studio-tag-notes.spec.mjs` specifies the configured-offline natural-language journey through real compile/simulation, saved-artifact summaries, separate approval/activation, collection/current/reload surfaces, and details/quick-button/Enter creation. It checks field retention, correction with a new operation ID, native readback, unchanged other-owner/hook selections, and no provider calls during native execution. Its 90-second bound and desktop/320px/683×384 checks do not qualify other browsers, live providers or deployment. These are source assertions awaiting hosted execution after focused source review, not reported passes.
