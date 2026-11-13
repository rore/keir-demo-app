# Working in keir-demo-app

This repository uses `persistent-agent-roles`. At start, resume, handoff, or a new assignment, load the skill to verify your current Relay name and mapped guidance. If guidance is unavailable, report the gap and continue authorized work. Missing guidance is not permission to install global tools; that requires explicit approval.

- Load the shared [role mapping](https://github.com/rore/keir-core/blob/main/roles/mapping.yaml) and selected guide from core. Keir team responsibilities, architecture iteration and model/budget guidance live in [the core role guides](https://github.com/rore/keir-core/blob/main/roles/README.md). Team assignments must supply the applicable verified role and guide alongside the exact checkout and scope. The manager owns the shared core roadmap and task records. These guides do not assign work or change session settings.

- Keep tracked content and commit identity free of private paths, identities and operational details. Use relative references or generic examples; follow the [shared public-content rule](https://github.com/rore/keir-core/blob/main/roles/shared.md#privacy-cost-and-context).
- Keep the app useful without Keir or AI. Domain services own persistence, native validation, authorization and transaction boundaries.
- Project roadmap and demo feature status live in `keir-core/roadmap/`. Keep implementation and tests here. For code/mixed/governance tasks, follow the [shared Agent Workflow process](https://github.com/rore/keir-core/blob/main/docs/internal/workflow/current-process.md) with a core-owned Work Record and explicit task identity; resolve/check it from the core checkout and record demo revision/test evidence. Documentation-only changes under `docs/`, `README.md` and `CONTRIBUTING.md` are exempt. Do not install a second workflow or copy records here. Work on main without requiring PRs; keep risk-based reviews and verification.
- Consume independently packaged `keir-core` components. Do not copy the compiler or runtime into this repository or depend on a sibling checkout for normal builds.
- Host-bind identity, tenant, protected origin and replay keys. A search-before-create check does not establish atomic uniqueness.
- Use the exact compiled artifact and Node runner in simulation and production. AI cannot certify contracts or approve activation.
- Test real adapter guarantees separately from simulated outcomes. Do not claim a scaffold or fake adapter proves production behavior.
- Protect the user's environment: isolate tools and test data. Obtain explicit approval before changing installed tools, global configuration, PATH, persistent environment variables, integrations or user services. Ordinary repository edits and isolated tests are authorized by the task.

- Write for one reader and task. Human guides lead with purpose and an example; agent guides give inputs, actions and constraints. Consolidate before adding pages, link canonical contracts, and keep release/qualification logs out of usage instructions. Follow the [documentation guidance](https://github.com/rore/keir-core/blob/main/roles/documentation.md).
