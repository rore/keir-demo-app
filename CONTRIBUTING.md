# Contributing

Start with [application scope](docs/scope.md). The project roadmap, including demo work, lives in `keir-core/roadmap/`; do not create a second roadmap here. Keep one reviewable behavior per change, with tests and PR review appropriate to the risk. Link demo PRs to the relevant core feature. Agent Workflow is not required here initially.

Keep local test data isolated from everyday data. No build commands or dependencies are configured yet; add reproducible setup and CI with the first executable application slice, without altering global tools.

Follow the [shared testing guidelines](https://github.com/rore/keir-core/blob/main/docs/testing.md): fast default regression, explicit slow checks and measured coverage. Test real host authorization, persistence and adapter guarantees separately from simulation; keep demo-specific contract cases with their implementation.

Pin released core package versions. Before core releases, test explicit candidate artifacts against this app; do not silently switch ordinary development to sibling source imports.

License choice is pending; resolve it before inviting public contributions or publishing the application.
