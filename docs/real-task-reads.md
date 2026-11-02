# Packaged real task reads

Open a task and choose **Check task advice**. The check reads the saved status without saving edits or changing any task. Maya initially uses `PENDING` for an open task; Leo initially uses `NEEDS_ATTENTION`. Both templates return `DONE` after completion. These differences live in two YAML programs under `extensions/task-read/`, compiled against one read/2 model and one `ClassifyTask` hook. Sam starts without configured advice. Each person can now review and select either prepared rule through the [read-only lifecycle](read-extension-lifecycle.md); filenames do not establish ownership. Native CRUD remains usable with advice off.

The host selects each user's exact model, artifact and DISPLAY consumer. Requests carry only the task resource ID and an empty body. Program, owner, model or consumer fields are rejected. The adapter binds the actor from the current server session, calls the owner-qualified native task service, checks the returned resource ID, maps `open`/`completed` to the model enums and projects only `{id,status}`. Foreign and missing IDs produce the same safe unavailable response. Advice never authorizes a native operation.

Authorization is fresh at entry, capability dispatch, the native read and result consumption. Session switching revokes the captured session. Client workspace/detail/selection-epoch guards discard old responses, including closing and reopening the same task; a new or failed check clears earlier advice without replacing unsaved form text. Runtime errors, invalid pins, malformed results and missing configurations display no default classification. The host holds at most six prepared owner/template bindings and eight concurrent invocations, each with a one-second runtime deadline. This is a local demo with fictional impersonation and a bounded read-only approval/selection lifecycle.

## Standalone distribution

`package.json` consumes `vendor/keir-runtime-node-0.0.0.tgz`; the lockfile pins its SHA-512 integrity and all dependency versions. `vendor/provenance.json` records the exact public core source revision, archive integrity and SHA-256 of every package file. The experimental version `0.0.0` alone does not identify this build. The archive contains the manifest, README and six source modules, including the optional read-simulation export. The installed module has no sibling-checkout or Java dependency. Ordinary `npm ci`, build and app execution require only the documented Node/npm installation and access to locked npm dependencies.

The checked-in model and compiled artifacts have independently held SHA-256 pins in `selection.json`. Changing a source, model or package requires deliberate regeneration, renewed host selection and verification; there is no filesystem discovery or network resolver for customer artifacts. Simulation and real runs bind separate catalogs around the same compiled artifact bytes. Simulation results do not certify real authorization or persistence.

## Regenerate intentionally

Regeneration is developer work; the application never launches a compiler. Use an isolated checkout of the exact `revision` in `vendor/provenance.json`, with the core repository's documented project-local Java/compiler tooling. Do not change global tools. Build `compiler-java` using that repository's wrapper and isolated Maven cache. Its CLI jar SHA-256 is recorded as build evidence; jar timestamps may differ on a rebuild.

From the demo checkout, run the compiler twice, once per source, with paths appropriate to that isolated core checkout:

```sh
java -jar <compiler-cli.jar> extensions/task-read/maya.yaml extensions/task-read/dcm.json --profile=keir-read/2 > extensions/task-read/maya.json
java -jar <compiler-cli.jar> extensions/task-read/leo.yaml extensions/task-read/dcm.json --profile=keir-read/2 > extensions/task-read/leo.json
```

Preserve stdout as raw bytes (use a byte-preserving process API on shells that transcode redirects). Compile again and compare exact bytes. Recompute the model SHA-256 over its canonical JSON and each source/artifact SHA-256; update the trusted selection only after review. JSON/YAML assets use LF in Git to preserve their pins.

To refresh the runtime, run `npm pack` in the isolated core `runtime-node/` directory, placing its archive under demo `vendor/`. Inspect all archive entries and contents for unexpected files or private data, record source revision/integrity/file hashes, then install that archive locally and update the lockfile. No public registry publication is needed. Do not bypass integrity checks. A fresh standalone demo checkout must pass `npm ci`, build and tests without access to the core checkout or Java at execution.

## Verification

`npm test` covers installed-package integrity, actual SQLite ownership/status projection, two programs, exact-artifact simulation parity, admission/resource/result failures, denial/revocation and the native advice API alongside native CRUD regressions. Browser checks are separate:

```sh
npm run build
npm run test:browser:install
npm run test:e2e -- --grep "task advice"
```

The browser fixture owns temporary servers/data and project-local Chromium. It checks saved status, preserved edits, failed-advice clearing, close/reopen and user-switch responses. The separate lifecycle journeys cover Studio review/approval/selection; AI calls and extension writes remain outside scope.
