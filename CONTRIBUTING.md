# Contributing

Daymark is a reference host for Keir. Read the [host integration](docs/read-extension-lifecycle.md) and [shared roadmap](https://github.com/rore/keir-core/blob/main/roadmap/board.md) before proposing a change.

## Build and test

Use Node.js 24.14.1 with npm. From the repository root:

```sh
npm ci
npm run build
npm test
```

The full authored-source suite also uses Java 21 and the compiler packaged in this repository. The [verification guide](tests/README.md) covers browser setup and explains what each test layer proves. Use isolated data and project-local tools. See [running Daymark](docs/running.md) to launch a separate local instance.

## Prepare a change

- Keep each change focused and report the checks you ran. Preserve the [host application invariants](docs/native-task-app-design.md), including ownership, persistence and session behavior.
- Test real permissions, persistence and effect receipts separately from simulated examples. Keep app-specific tests here and follow the [shared testing guidelines](https://github.com/rore/keir-core/blob/main/CONTRIBUTING.md#testing-principles).
- Use the pinned Keir packages. Test a proposed dependency update against Daymark before changing its pins.
- Maintainers use the [shared development workflow](https://github.com/rore/keir-core/blob/main/docs/internal/workflow/current-process.md) for review, records and integration. The shared record lives in Core when required.

Daymark is licensed under the [Apache License 2.0](LICENSE). Preserve the bundled third-party licenses and notices under `vendor/` when updating or redistributing dependencies.

## Design and history

Current host internals are described in the [implementation reference](docs/native-task-app-design.md) and [Studio design](docs/extension-studio-design.md). [Reusable Studio embedding](docs/studio-embedding.md) remains a proposal. The [business-understanding study](docs/studio-business-understanding/concepts.md) and [recommendation](docs/studio-business-understanding/recommendation.md) are scripted design research. The [canvas-era design](docs/historical/extension-studio-canvas-design.md) and [prototype](docs/extension-studio/README.md) preserve earlier work.

The [rejected guided example](https://github.com/rore/keir-demo-app/blob/9eaddae0ed262f06727f440651204e746974979e/docs/studio-guided-example.md) and [superseded on-demand proposal](https://github.com/rore/keir-demo-app/blob/9eaddae0ed262f06727f440651204e746974979e/docs/studio-on-demand-review.md) remain in Git history.
