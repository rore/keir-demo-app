# Contributing

Start with [application scope](docs/scope.md). The project roadmap, including demo work, lives in `keir-core/roadmap/`; do not create a second roadmap here. Keep one reviewable behavior per change, with tests and review appropriate to the risk. Work directly on main; PRs are not required.

Follow the [shared Agent Workflow process](https://github.com/rore/keir-core/blob/main/docs/internal/workflow/current-process.md) for code, mixed changes and governance work. Keep the task's Work Record in core and run its resolver/checker from the core checkout with the explicit task slug and fresh demo evidence. Record this repo's revision and tests there. Documentation-only edits under `docs/`, `README.md` or `CONTRIBUTING.md` are exempt. No second workflow installation or record copy belongs here.

Keep local test data isolated from everyday data. Use the pinned setup/build/test commands in [README.md](README.md) and [tests/README.md](tests/README.md); do not alter global tools. CI exercises the native baseline. Preserve the maintained [native contract](docs/native-task-app-design.md), including rejection, session-race, reset and persistence checks.

Follow the [shared testing guidelines](https://github.com/rore/keir-core/blob/main/docs/testing.md): fast default regression, explicit slow checks and measured coverage. Test real host authorization, persistence and adapter guarantees separately from simulation; keep demo-specific contract cases with their implementation.

Pin released core package versions. Before core releases, test explicit candidate artifacts against this app; do not silently switch ordinary development to sibling source imports.

License choice is pending; resolve it before inviting public contributions or publishing the application.
