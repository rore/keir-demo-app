# Application verification

Build with `npm run build`. `npm test` uses Node's test runner and temporary SQLite databases. Full authored-source verification also needs the pinned compiler and Java 21. Tests do not install Java, change global configuration, reuse an operator database or make live provider requests.

The current task-completion integration is an implemented candidate. Integrated release qualification is still pending. A passing synthetic check, fixture-generated approval or UI test does not establish native guarantees. See [task effects](../docs/task-effects.md) for the current runtime contract and host-owned authority checks. Runtime startup requires no deployment certificate or report approval.

## What each layer proves

| Layer | Coverage and boundary |
| --- | --- |
| Native data/API/session tests | Owner-scoped CRUD, validation, committed-write identity, auth races, locks, migrations, backups, reset and restart preservation. |
| Distribution/compiler tests | Actual package/provenance identity, pinned compiler diagnostics, source/output bounds, cancellation and child-process settlement. A synthetic admitted artifact used in an API test does not qualify compiler semantics. |
| Task-effect simulation tests | Exact effect artifact against synthetic capability calls and responses, independent expectations, match/nonmatch reports and honest confirmed/none/unknown effects. No real task is created by simulation. |
| Native effect storage/persistence/process tests | Original completion identity, atomic claim and effect receipt handling, recovery and bounded process-crash/restart guarantees against actual SQLite/native services. These are not arbitrary power-loss guarantees. |
| Runtime binding/dispatch tests | Complete compatible implementation binding, exact artifact preparation reuse, fresh invocation context, native denial/revocation/deadlines and unavailable binding without blocking native CRUD. |
| Authoring tests | Bounded project discovery and public contract, independent cases, durable turns/receipts/accounting, strict provider envelopes, cancellation and exact recovery. Scripted provider transports establish no live model compatibility. |
| Lifecycle tests | Exact item/revision/draft/evidence identity, approval independent of latest proof, separate activation, generation conflicts, retirement, deletion, source/history access and preservation. |
| Browser UI tests | Human decisions and native navigation, current/proposed proof identity, outcome honesty, owner/late-response fences, layout, focus and retained unsent fields. Projection mocks are identified separately from full runtime journeys. |

Relevant files include `data.test.mjs`, `api.test.mjs`, `session-race.test.mjs`, `startup.test.mjs`, `distribution.test.mjs` and `compiler.test.mjs`; `task-effect-simulation.test.mjs`, `native-task-effect-storage.test.mjs`, `native-task-effect-persistence.test.mjs`, `native-task-effect-process.test.mjs`, `task-effects.test.mjs` and `task-effects-runtime.test.mjs`; and the authoring/lifecycle/continuity regression files. Retained `task-read` tests cover the historical read contract, not permission to expose retired execution offers.

Provider configuration/setup tests use temporary synthetic credentials and settings. They cover local persistence, precedence, validation and fresh-conversation behavior without contacting providers. The allowance ledger remains conservative across cancellation/reset; changing settings does not refund reservations. Authoring boundary tests distinguish exact saved proof from latest evidence, exclude protected host authority, and retain original operation recovery after retirement/deletion. History pagination and continuity tests preserve older work without sending it automatically to a provider.

## Browser checks

From a checkout with the documented Node/npm runtime:

```sh
npm run build
npm run test:browser:install
npm run test:e2e
```

Browser setup downloads pinned Chromium into ignored `.tools/playwright/`, separate from installed browsers and profiles. Browser fixtures own their loopback ports, app processes and temporary databases. Screenshots and traces live under ignored `build/` output. Mobile viewports do not certify physical devices or other browser engines. Download/setup is separate from warm test execution.

`task-customization-ui.spec.mjs` is a focused public-projection UI suite. It uses exact mocked Studio/evidence/reaction projections and real isolated native CRUD. It verifies current and proposed proofs in one deliberately opened canvas; mismatch inspection without approval; separate approval/activation; unavailable-installation activation gating; known no-effect unavailable-source cases and independently expected UNKNOWN cases without invented effects; retired history/fresh creation; no task link from a source `CREATED` label; confirmed receipt resolution through owner-native GET; separate original UNKNOWN and reconciled confirmation; foreign/late-owner response rejection; lost completion response readback without another completion; created-task detail return focus; and preservation of unsaved native fields on list refresh. It does **not** qualify the dispatcher, runtime binding, package or installation. Its optional `TASK_UI_STATIC_ROOT` selects an already-built isolated UI fixture.

Existing layout, recovery, setup, lifecycle and integrated-authoring journeys preserve behavioral coverage while callers are adapted to the current contract. Earlier selectors for advice checks and scripted offers describe retired UI and must not be treated as the current product. Preserve their applicable owner, async, reading-position, native-unsaved and exact-authority assertions rather than skipping scenarios. The reviewed layout cases include wheel/PageDown, stable rail/header/composer, pane edges, splitter limits and narrow/short viewports. Rendered designer review remains separate from automated assertions.

Actual integrated task qualification must exercise matching and nonmatching customer programs with distinct project/title constants through the real compiler, exact artifact simulation and native completion dispatcher. It must show that activation changes no tasks, matching completion creates the evidenced task, nonmatch creates none, duplicate completion does not replay, and owner changes, revocation, interruption and UNKNOWN remain honest. The final report must identify the measured bytes and limitations. This guide asserts no result for that pending qualification.

## Offline configured-AI fixture

`tests/fixtures/authoring-server.mjs` supplies scripted provider transport for isolated review of supported protocol paths. It never modifies operator settings/data or makes an external provider request. Compiler/simulator and application routes remain real where the fixture invokes them. Legacy advice scripts are historical inputs until adapted; they do not authorize task effects or establish live-provider compatibility. `authoring-integrated.spec.mjs` covers the configured transport journey and should use current task-completion examples when qualifying this integration.

## Optional live checks and reporting

The provider qualification command is dry by default. A live run requires explicit authorization of provider costs and its separate finite allowance; saving in-app configuration does not grant that authorization. See [AI authoring](../docs/ai-authoring.md#optional-live-provider-qualification). Provider qualification is separate from native runtime, permission and persistence checks.

Keep default regression fast, record actual duration and investigate regressions. Use focused checks for changed behavior, then the required broader gates. Report failures, skipped work and mock boundaries explicitly; do not substitute a fixture PASS for actual package, provider or native execution verification. CI results and measured reports remain evidence with their stated scope, not production authentication or general durability guarantees.
