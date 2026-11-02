# Manual authored extension drafts

The Studio's **Details and recovery → Developer qualification · authored source** panel lets a developer compile a read-only Keir program and save independently written simulation examples. It is a manual qualification path, not AI generation. The host model and read-only `tasks.get` authority stay fixed. Source and examples cannot grant capabilities, approve themselves, or put themselves in use.

## Studio flow

1. Enter a program label and Keir source, then choose **Compile source**. A successful compile saves a source-only immutable revision with no suite. The current **In use** selection does not change. If Java or the compiler package is unavailable, native and saved advice continue to work.
2. Write one to eight separate **Example N JSON** documents. These are expected behavior you choose; the UI never copies observed output into them. Choose **Save expected examples**. This creates a new revision ID and advances the same `draftVersion`, while reusing the exact source and compiled artifact.
3. Choose **Try on sample tasks**, inspect the exact run, and approve only if every listed case passes. Approval does not activate the draft.
4. Choose **Use this advice for me** separately. This changes the selection generation. Until then, any previously active revision remains in use.

Editing source requires compiling a new source revision. Editing examples requires saving another suite revision. Either change needs fresh simulation evidence and approval. If approved revision A is active while draft B is edited or approved, A stays active; explicitly using B changes the selection. A remains available as a restore target.

The panel retains typed buffers during ordinary Studio review navigation. Loading a saved draft replaces those buffers. If a compile request is cancelled or its response is uncertain, cancellation only stops the request; a server commit may already have saved a new revision. Reload saved state before retrying. The UI does not automatically repeat compilation.

## Example source

This example reads the saved task and maps a completed task to `PENDING`, otherwise to `DONE`. The domain fingerprint matches the host model shipped with the prepared rules.

```yaml
language: keir/v0
domain: {id: demo.tasks, version: '1', fingerprint: 'sha256:8919c93684f13d58fe70070d0dc90aac0c5259e7d7f87358b20b932c997726b8'}
entrypoint: ClassifyTask
name: authored-task-check
steps:
  - id: readTask
    call: tasks.get
    args:
      taskId: {cel: input.taskId}
  - id: completed
    let: {cel: 'readTask.status == "COMPLETED"'}
return:
  record:
    classification: {cel: 'completed ? "PENDING" : "DONE"'}
```

## Independently written example

The following independently written case expects an open task to produce `DONE`. Its step name, adapter response, expected call, native result and displayed receipt match the example source and host contract. The source and this case are checked together through the packaged compiler and native simulator.

```json
{
  "format": "keir-read-simulation/1",
  "id": "open-task",
  "input": { "taskId": "sample-task" },
  "stubs": [
    {
      "step": "readTask",
      "capability": "tasks.get",
      "version": "1",
      "args": { "taskId": "sample-task" },
      "response": { "kind": "SUCCESS", "value": { "id": "sample-task", "status": "OPEN" } }
    }
  ],
  "expect": {
    "calls": [
      { "step": "readTask", "capability": "tasks.get", "version": "1", "args": { "taskId": "sample-task" } }
    ],
    "outcome": { "classification": "COMPLETED", "result": { "classification": "DONE" } },
    "consumption": { "status": "DISPLAYED", "code": "DONE" }
  }
}
```

## API contract

The API keeps compile and scenario proposal separate:

```text
POST /api/extensions/compile
{ "source": "...", "label": "Optional label", "draftVersion": 0 }

POST /api/extensions/scenarios
{ "revisionId": "current-revision-id", "cases": ["raw JSON document"], "draftVersion": 1 }

POST /api/extensions/simulate
{ "revisionId": "suite-bearing-revision-id", "draftVersion": 2 }

GET /api/extensions/revisions/:id
```

Compile accepts UTF-8 source up to 65,536 bytes. The host independently admits the compiler output, at most 1 MiB, then returns lifecycle state including the new revision ID, current draft version, and `suiteDigest: null`. Scenario proposal accepts 1–8 raw JSON strings, each at most 65,536 UTF-8 bytes, with at most 131,072 bytes in the canonical aggregate. It creates a new immutable revision reusing the exact source and artifact, and returns a non-null suite digest. Simulation reads the stored cases; clients cannot replace them during a run. The revision read returns `{revisionId, source, cases, suiteDigest}` and is owner-scoped. Neither route accepts client artifacts, dependency pins, owner identity, PASS claims, or authority changes.

Source and scenario documents remain JSON strings through request parsing, preserving duplicate keys for the compiler or strict simulator parser to reject. The new preparation routes have a 1 MiB raw JSON body cap; decoded source and scenario limits still apply. Existing prepared templates and their six original scenarios remain unchanged. Authored programs are not limited to those two templates: admitted constant and repeated-read programs are possible within host and runtime budgets.

## Resource and evidence limits

- Each owner can retain at most 32 authored revisions. Both source-only drafts and suite revisions use a slot; no old revision is silently deleted.
- The compiler wrapper allows one active job without a queue, with a 10-second deadline and 256 MiB Java heap setting. These controls do not constitute an OS sandbox or hard whole-process memory containment. Exact compiler provenance, byte identity and qualified Java are recorded in `vendor/compiler-provenance.json`; the app verifies its distribution before each compile.
- The prepared executable cache is capped at 16 entries. Live reads retain their eight-active-invocation ceiling and one-second checked deadline.
- Scenario cases are independent expectations. A finite passing suite covers only its listed cases; it does not certify all program behavior or production adapter guarantees.
- The server runs the native simulator against the exact stored artifact and case strings. Every case must pass for evidence to be eligible for approval. An incorrect expectation blocks approval; corrected examples require a new revision and new evidence.

## Compiler prerequisite

App startup, native tasks, prepared rules, and stored advice require Node.js 24.14.1, not Java. Source compilation additionally requires the independently packaged pinned compiler JAR and Java 21. `KEIR_JAVA_BIN` is trusted process launch configuration for an existing executable; requests cannot choose it. No global Java installation or PATH change is required. Missing compiler assets or Java disable compilation without disabling native task operation.

The database upgrade to schema 3 is additive and preserves existing native and lifecycle rows. Keep a recoverable backup before deliberately restarting an existing local database for migration. A user preview migration is a separate action for its owner; this guide does not authorize one.
