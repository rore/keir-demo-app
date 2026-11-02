# Review and select task advice

Choose **Customizations** from Daymark's normal navigation, then open **Task advice**. The overview shows server-confirmed In use, Off or Unavailable separately from a draft or approved choice awaiting use. An approved draft already selected is the current choice. Studio offers two prepared rules: Pending or Needs attention for open tasks across the person's projects; both show Done for completed tasks. These are existing compiled read-only programs. Studio guides the choice through conversation and a resizable canvas; it does not call AI, compile source or create follow-up tasks.

1. Choose a proposed rule. Your current advice stays in use.
2. Choose **Try on sample tasks**. The server runs six actual bounded simulations and saves immutable evidence. Compare independently authored expected results with actual results for open, completed, missing, business-denied, host-denied and transient-read cases.
3. Review the exact proposal and sample evidence, then explicitly choose **Approve this advice**. Approval alone leaves current advice unchanged.
4. Choose **Use this advice for me**, return to Tasks, open a saved task and check live advice. The contextual **Manage task advice** shortcut opens this same Studio and returns to its invoking control with unsaved title/notes retained; the check reads saved task status.
5. Open **Manage saved advice** for **Turn off my advice** or an exact previously used choice to restore. Inspect its provenance and confirm. Neither operation changes native tasks or another person's choice.

Studio keeps Advice, Sample results and exact Review in contextual canvas views. Saved sample runs, selection history, technical identities, reload and recovery are secondary. On narrow or short screens, **Conversation / Preview** switches the visible pane while retaining its position and unsent message. New replies do not move someone reading earlier conversation; a New messages control returns to the latest replies. Welcome can scroll normally; the signed-in shell bounds project, task, transcript and canvas scrolling independently.

Typed assent can open review but never approves or activates a rule. A different proposal invalidates an old activation request even when the active generation is unchanged. Historical sample runs remain available for inspection; they cannot approve a different revision. Failed checks never become a default classification. Conflicts and uncertain mutation responses reload saved state before retry.

## Evidence API meanings

Each saved suite returns `reports[]` with a host-authored `expected` annotation and an actual simulator `report`. These fields have different types:

| Field | Meaning |
| --- | --- |
| `expected.classification` | Expected native outcome category: `COMPLETED`, `BUSINESS_REJECTION` or `FAILED`; never a display receipt status. |
| `expected.code` | On `COMPLETED`, the expected advisory value (`PENDING`, `NEEDS_ATTENTION` or `DONE`). On rejection/failure, the expected original native diagnostic code. This compact scenario annotation is not itself a consumer receipt. |
| `report.native` | Actual bounded native summary from the simulator. Domain rejection codes are redacted to `NATIVE_ERROR`; the original codes are compared privately by the simulator. |
| `report.consumption` | Actual safe receipt: `{status:"DISPLAYED",code:"PENDING"}` (or another allowed advisory code), or `{status:"NOT_DISPLAYED"}`. Native outcome categories never appear in `status`. |

The independently authored case bytes separately pin `expect.outcome` and `expect.consumption`. For a successful case, the expected safe receipt is `DISPLAYED` with the expected advisory code; every rejection/failure case expects `NOT_DISPLAYED` without a code. The server validates actual `report.consumption` against that exact expected receipt, as well as native outcome, complete ordered suite membership and dependency identities. The canvas summarizes expected/actual displayed advice in everyday terms; each row's Technical run details retains the exact expected annotation and actual native/consumption/mismatch fields. It never compares a native category to a receipt status.

The state DTO's `approved` boolean only controls presentation. Approval rechecks server-held owner, exact current draft/revision/version and complete eligible evidence in its committing transaction. Activation rechecks the current draft/version, eligible approval/evidence and expected selection generation before committing. Neither a client boolean nor a rendered PASS authorizes activation. Both curated rules read the saved task status; there is no customer project filter or follow-up creation control.

## Authority and persistence

SQLite schema 2 holds owner-scoped immutable revision identities, exact suite evidence, approvals, current draft/version, selection generation and transition history. The server owns model/artifact/source/compiler/environment/package/adapter/consumer pins and suite/fixture/case identities. A browser can submit only curated template IDs, exact server record IDs and expected versions; client owners, bundles, PASS claims and authority overrides are rejected. Every approval records its actual owner/approver and exact evidence reference.

The packaged files named `maya` and `leo` are curated template material, not owners. Any demo person can select either through their own records. Maya initially has Pending, Leo Needs attention and Sam no selection. The one-time version-1 upgrade records existing defaults as operator-provided starting choices with actual activation history; it creates no customer approval or simulation evidence. Disabled selections stay disabled after restart. Missing or invalid dependencies never silently reseed defaults.

Advice captures one revision/generation and retains its exact prepared dependencies. Current session, approval/dependencies, ownership and generation are checked before native dispatch and consumption. An away-and-back change still invalidates the old generation. A client epoch advances before each selection mutation, preventing an already-produced late HTTP success or failure from restoring old advice. User changes discard the old workspace, including Studio state; they do not adopt a previous person's responses.

The local server, packaged assets and SQLite file are trusted against direct operating-system replacement. Hashes prove byte identity, not approval authority. This does not protect against a malicious database/server owner and does not provide production identity management. Synthetic simulation does not certify real adapters or all future tasks.

## Limits and recovery

- Six cases run sequentially. One suite per owner and two globally may run; excess work returns 429 without queueing. Slots remain held until settlement.
- Live advice retains the eight-invocation ceiling and one-second checked deadline. At most six prepared bindings cover three owners × two templates with exact dependency keys; revisions do not grow the cache.
- Native simulator case/report limits apply. Persisted suites are at most 128 KiB; lifecycle responses at most 256 KiB. History/evidence metadata pages contain at most 20 rows; complete evidence is fetched by exact owner-scoped ID. Oversize evidence is rejected, never truncated into eligibility.
- No hard synchronous preemption, remote cancellation or durable free-form conversation is promised. Restart requires sign-in while lifecycle selections/evidence persist.

All new database operations use synchronous transactions without awaits. Existing reset verifies lifecycle rows in its recoverable backup before deleting them in dependency order. When upgrading an existing local installation, stop its owning app and retain a recoverable database backup before a deliberate restart. The next normal startup transactionally upgrades schema 1 to 2; failed upgrade leaves native rows intact. Do not delete or reset a database to resolve an unsupported version. Automated development verification uses synthetic databases and never migrates an operator preview's data.

## Verification and package

The app consumes the independently packed runtime at the exact source revision in `vendor/provenance.json`. Archive/lock SHA-512 and all eight installed file identities are checked, including the root runtime and `@keir/runtime-node/read-simulation` export. Existing source/artifact/model pins are unchanged; neither Java nor a sibling core checkout is required to run the app.

`npm test` includes migration/reopen/reset/backup, actual six-case simulation, stale/foreign/forged evidence, explicit approval, transactional generation conflicts, selection versus in-flight reads, resource limits and existing native regressions. `npm run test:e2e` covers actual Studio/native journeys, late responses, uncertain activation readback, narrow layout and restart. Browser installation remains project-local and separate from warm execution. Shared core/Java qualification is reused for unchanged artifact/runtime semantics; these tests do not claim AI, effects or production authentication.
