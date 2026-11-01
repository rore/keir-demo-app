# Keir Demo App

A planned polished local web task manager and reference integration for Keir. Visitors will clone this repository and run the app locally, signing in as one of three seeded demo users to explore independent customizations. Each user represents a SaaS customer's customization scope. The app defines extension points, approved task capabilities, permissions and real guarantees. Its AI-driven extension creation UI helps business users describe, generate, simulate and review customizations before activation. The complete authoring demo requires the visitor's own AI provider configuration and credentials; no private keys are shipped. Keir validates and executes the resulting extensions within the host-defined boundaries. Native task management and execution of already activated extensions remain available without AI calls.

**Status: initial project structure; no runnable application yet.**

| Path | Responsibility |
| --- | --- |
| [src/](src/README.md) | Task UI, services, persistence and host-owned authoring/activation |
| [keir/](keir/README.md) | Task-domain model, extension sources and business scenarios |
| [tests/](tests/README.md) | Application, adapter and integration verification |
| [docs/](docs/scope.md) | Application scope and integration boundaries |

The separate `keir-core` repository owns the Java compiler and both Java and Node runtimes. This app uses the Node runtime and invokes the Java compiler locally during authoring. It must consume pinned core packages; sibling source paths are not the normal installation model.

Project plans, demo feature status and in-scope task Work Records are managed in `keir-core`. This repository retains application scope, implementation and tests. Follow the [shared workflow](https://github.com/rore/keir-core/blob/main/docs/internal/workflow/current-process.md) for code/mixed/governance work, with documentation-only exemptions and direct-main delivery; PRs are not required. Do not duplicate workflow installation or records here.

Framework/UI, local storage, package coordinates and build commands are pending. The app is hosted locally without a hosted database or sibling core checkout. AI extension creation will use an operator-configured provider/model with server-side credentials; multiple providers will be qualified explicitly. Local hosting does not mean AI runs offline. No dependency installation is needed for this scaffold. See [contribution workflow](CONTRIBUTING.md).

The future `main` experience will have Keir's host configuration ready to explore. A planned `pre-design-time` starting branch and host-design skill will let visitors use their own coding agent and its existing authentication to build that integration from the native app. This is separate from the app's AI extension creation UI. That branch and skill are not delivered yet; see [the two walkthroughs](docs/scope.md#two-future-walkthroughs).

License selection and public release are pending. No open-source license grant is implied by this scaffold.
