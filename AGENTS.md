# Working in keir-demo-app

This repository uses `persistent-agent-roles`. At start, resume, handoff, or a new assignment, load the skill to verify your current Relay name and mapped guidance. If missing, install it globally from [Collection](https://github.com/rore/rore-collection/tree/main/skills/persistent-agent-roles).

- Load the shared [role mapping](https://github.com/rore/keir-core/blob/main/roles/mapping.yaml) and selected guide from core. Keir team responsibilities, architecture iteration and model/budget guidance live in [the core role guides](https://github.com/rore/keir-core/blob/main/roles/README.md). Team assignments must supply the applicable verified role and guide alongside the exact checkout and scope. The manager owns the shared core roadmap; this repository adds no separate workflow process. These guides do not assign work or change session settings.

- Keep the app useful without Keir or AI. Domain services own persistence, native validation, authorization and transaction boundaries.
- Project roadmap and demo feature status live in `keir-core/roadmap/`. Keep implementation and tests here; link demo PRs to the core feature rather than copying its status. Agent Workflow is not required in this repo initially.
- Consume independently packaged `keir-core` components. Do not copy the compiler or runtime into this repository or depend on a sibling checkout for normal builds.
- Host-bind identity, tenant, protected origin and replay keys. A search-before-create check does not establish atomic uniqueness.
- Use the exact compiled artifact and Node runner in simulation and production. AI cannot certify contracts or approve activation.
- Test real adapter guarantees separately from simulated outcomes. Do not claim a scaffold or fake adapter proves production behavior.
- Protect the user's environment: isolate tools and test data. Obtain explicit approval before changing installed tools, global configuration, PATH, persistent environment variables, integrations or user services. Ordinary repository edits and isolated tests are authorized by the task.
