# Contributing

Daymark demonstrates Keir in a working local task app. Read the [application scope](docs/scope.md) and [shared roadmap](https://github.com/rore/keir-core/blob/main/roadmap/board.md) before proposing a change.

## Build and test

Use Node.js 24.14.1 with npm. From the repository root:

```sh
npm ci
npm run build
npm test
```

The full authored-source suite also uses Java 21 and the compiler packaged in this repository. The [verification guide](tests/README.md) covers browser setup and explains what each test layer proves. Use isolated data and project-local tools. See [running Daymark](docs/running.md) to launch a separate local instance.

## Prepare a change

- Keep each change focused and report the checks you ran. Preserve the [native task contract](docs/native-task-app-design.md), including ownership, persistence and session behavior.
- Test real permissions, persistence and effect receipts separately from simulated examples. Keep app-specific tests here and follow the [shared testing guidelines](https://github.com/rore/keir-core/blob/main/docs/testing.md).
- Use the pinned Keir packages. Test a proposed dependency update against Daymark before changing its pins.
- Maintainers use the [shared development workflow](https://github.com/rore/keir-core/blob/main/docs/internal/workflow/current-process.md) for review, records and integration. The shared record lives in Core when required.

License choice is pending. Resolve it before inviting public contributions or publishing the application.
