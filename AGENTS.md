# Working in keir-demo-app

- Keep the app useful without Keir or AI. Domain services own persistence, native validation, authorization and transaction boundaries.
- Project roadmap and demo feature status live in `keir-core/roadmap/`. Keep implementation and tests here; link demo PRs to the core feature rather than copying its status. Agent Workflow is not required in this repo initially.
- Consume independently packaged `keir-core` components. Do not copy the compiler or runtime into this repository or depend on a sibling checkout for normal builds.
- Host-bind identity, tenant, protected origin and replay keys. A search-before-create check does not establish atomic uniqueness.
- Use the exact compiled artifact and Node runner in simulation and production. AI cannot certify contracts or approve activation.
- Test real adapter guarantees separately from simulated outcomes. Do not claim a scaffold or fake adapter proves production behavior.
- Protect the user's environment: isolate tools and test data. Obtain explicit approval before changing installed tools, global configuration, PATH, persistent environment variables, integrations or user services. Ordinary repository edits and isolated tests are authorized by the task.
