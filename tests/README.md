# Application verification

Build with `npm run build`. `npm test` uses Node's test runner and temporary SQLite databases. Full authored-source verification also needs the pinned compiler and Java 21. Tests do not install Java, change global configuration, reuse an operator database or make live provider requests.

The current task-completion integration is an implemented candidate. Integrated release qualification is still pending. A passing synthetic check, fixture-generated approval or UI test does not establish native guarantees. See [task effects](../docs/task-effects.md) for the current runtime contract and host-owned authority checks. Runtime startup requires no deployment certificate or report approval.

## What each layer proves

The v11 migration fixture, `fixtures/daymark-shipped-v11.sqlite.gz`, was created with Daymark `59c819a` and synthetic data. It includes all four completion states, a settled receipt and reconciliation, and legacy title and notes containing embedded NUL bytes. Tests also derive an exact v10 schema from it by removing the two v11 task columns. The shipped fixture requires no compiler, checkout or database from a running app.

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

`keir-scenario.test.mjs` checks the pinned Core assets and runs all 45 raw vectors through the shared lexical, structural and UTF-8 byte checks. Daymark's fixture, typing, artifact admission and dispatch checks are covered separately in `task-effect-simulation.test.mjs`. [Core input provenance](../vendor/keir-verification/provenance.json)

Provider configuration/setup tests use temporary synthetic credentials and settings. They cover local persistence, precedence, validation and fresh-conversation behavior without contacting providers. The allowance ledger preserves reservations across cancellation, reset and settings changes. Authoring boundary tests distinguish exact saved proof from latest evidence, exclude protected host authority, and retain exact current operation recovery after deletion. History pagination and continuity tests preserve older work without sending it automatically to a provider.

## Browser checks

From a checkout with the documented Node/npm runtime:

```sh
npm run build
npm run test:browser:install
npm run test:e2e
```

Browser setup downloads pinned Chromium into ignored `.tools/playwright/`, separate from installed browsers and profiles. Browser fixtures own their loopback ports, app processes and temporary databases. Screenshots and traces live under ignored `build/` output. Mobile viewports do not certify physical devices or other browser engines. Download/setup is separate from warm test execution.

`task-customization-ui.spec.mjs` uses exact mocked Studio, evidence and reaction projections alongside real isolated native CRUD. It covers current and proposed proofs in one canvas, mismatch inspection, separate approval and activation, and activation gating when the installation is unavailable. Reaction cases cover unavailable sources, UNKNOWN outcomes and independent reconciliation of an original UNKNOWN. Created-task links require an owner-scoped confirmed receipt. The suite also covers foreign and late-owner responses, lost completion response readback, return focus after inspecting a created task, and unsaved native fields on list refresh. The optional `TASK_UI_STATIC_ROOT` selects an already-built isolated UI fixture.

Layout, recovery, setup, lifecycle and integrated-authoring journeys cover owner boundaries, late responses, reading position, unsaved native fields and exact authority under the current contract. `continuous-authoring.spec.mjs` exercises current conversation and history pagination, retry at the exact cursor and lost first-create receipt recovery. Layout cases include wheel/PageDown, stable rail/header/composer, pane edges, splitter limits and narrow/short viewports. Rendered designer review remains separate from automated assertions.

Actual integrated task qualification must exercise matching and nonmatching customer programs with distinct project/title constants through the real compiler, exact artifact simulation and native completion dispatcher. It must show that activation changes no tasks, matching completion creates the evidenced task, nonmatch creates none, duplicate completion does not replay, and owner changes, revocation, interruption and UNKNOWN remain honest. The final report must identify the measured bytes and limitations. This guide asserts no result for that pending qualification.

## Offline configured-AI fixture

`tests/fixtures/authoring-server.mjs` supplies scripted provider transport and uses isolated settings and data. Compiler, simulator and application routes are real where the fixture invokes them. `authoring-integrated.spec.mjs` covers the configured transport journey using current task-completion examples. Live-provider qualification is separate.

## Optional live checks and reporting

The provider qualification command is dry by default. A live run requires explicit authorization of provider costs and its separate finite allowance; saving in-app configuration does not grant that authorization. See [AI authoring](../docs/ai-authoring.md#optional-live-provider-qualification). Provider qualification is separate from native runtime, permission and persistence checks.

Keep default regression fast, record actual duration and investigate regressions. Use focused checks for changed behavior, then the required broader gates. Report failures, skipped work and mock boundaries explicitly; do not substitute a fixture PASS for actual package, provider or native execution verification. CI results and measured reports remain evidence with their stated scope, not production authentication or general durability guarantees.
