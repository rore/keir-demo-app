# Application verification

Build with `npm run build`. `npm test` uses Node's runner with real temporary SQLite:

- `data.test.mjs`: CRUD/bounds/completion, same-owner foreign keys, seeds/restart, lock/backup/restoration and reset rollback.
- `api.test.mjs`: foreign/missing resources, forged ownership, Host/Origin/JSON/body limits, session matching and revoked-cookie rejection without cookie writes.
- `session-race.test.mjs`: real partially delivered HTTP body revoked before completion cannot write; previously committed work retains its original owner.
- `startup.test.mjs`: test-owned startup/second-server/reset contention, private-path rejection, CLI startup and deliberate stale-lock refusal.
- `distribution.test.mjs`: repository archive/lock integrity and installed runtime file identity.
- `task-read.test.mjs`, `task-read-api.test.mjs`: installed-package real SQLite reads, different customer programs, exact-artifact simulation parity, pins/resource/result/authority failures and session-isolated advice endpoints.
- `extension-lifecycle.test.mjs`, `lifecycle-api.test.mjs`, `lifecycle-persistence.test.mjs`: actual six-case evidence, approval/selection history, approved-evidence readback independent of the latest run, explicit reapproval, stale/foreign/current authority, bounds, generation races, isolated upgrade/reopen/reset/backup and native advice integration.

Tests own temporary paths and loopback servers, never an operator app. No sleeps or live provider calls. SQLite's experimental warning is expected on Node 24.14.1 and is not suppressed.

`npm run test:browser:install` downloads pinned Chromium to `.tools/playwright/` without changing installed browsers/profiles or global environment. `npm run test:e2e` exercises the built app: all three people create/rename projects and create/edit/complete tasks, restart persistence, mobile/keyboard/detail focus, validation/API errors, delayed data and cross-tab delayed auth. Fixtures own their server/port/database. Screenshots are ignored in `build/screens/`; failed traces in `build/browser-results/`. Mobile viewports do not certify physical devices or other engines.

The task-advice journeys also cover preserved edits, open/completed status, failures clearing old advice and pending results across close/reopen or user switching. Select them with `npm run test:e2e -- --grep "task advice"`.

The separate `lifecycle.spec.mjs` journeys exercise real sample review, explicit approval/use, uncertain mutation readback, historical evidence, native edits, already-produced late advice, named restore and restart. Customization journeys cover the empty and saved overview states, nonmutating new-conversation entry, disabled description creation, discovery/setup/continue/open-existing paths, inline choice consequences, status distinctions, and on-demand review navigation with retained workspace state. Studio has no AI or arbitrary source-authoring service.

`lifecycle-advice-races.spec.mjs` holds actual already-produced unavailable-advice and simulation receipts across restore or cross-tab owner changes. `customization-layout.spec.mjs` enters Studio through normal navigation, checks real overview selection/draft states, native draft/return focus, abandoned overview/Studio responses and owner away-and-back. Deterministic overflowing projects/tasks/transcript/evidence exercise wheel and PageDown, exact scroll positions, stable rail/header/composer, pane edges, splitter limits and narrow/short layouts (390×844, 900×500, 360×540, 683×384). It checks viewport bounds and retained pane positions/unsent text; screenshots complement these assertions. Rendered designer review remains a separate acceptance requirement.

Keep default regression fast, measure duration and investigate regressions. Browser download is separate from warm execution. CI builds and runs both suites. Production identity qualification and live-provider checks belong to later slices; these tests claim none of those guarantees.
