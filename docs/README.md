# Daymark documentation

Daymark uses Keir for checks before a new task is saved and actions after tasks are added or completed.

## Run and use Daymark

- [Run locally](../README.md#run-locally) to try the task workspace and its three demo accounts.
- [Try a customization](../README.md#try-a-customization) to draft a rule, check examples, approve it, and turn it on.
- [Configure an AI provider](ai-authoring.md#configure-a-provider) for conversational authoring.
- [Manage saved customizations and outcomes](read-extension-lifecycle.md) explains approval, activation, and what happens when an outcome needs reconciliation.
- [Local data and recovery](running.md) covers data directories, restart, backup, and reset.

## Integration reference

- [Native task behavior](native-task-app-design.md) covers task storage, tags, search, and access rules.
- [Task creation and readback](task-creation.md) explains attempt IDs, lost responses, replay and current project access.
- [Task completion and effects](task-effects.md) explains how Daymark binds Keir, simulates examples, and records real outcomes.
- [Studio embedding](studio-embedding.md) describes the boundary between the authoring experience and the host application.
- [Keir Core documentation](https://github.com/rore/keir-core/tree/main/docs) covers compiler and runtime APIs and the versioned specification.

For development, see [Contributing](../CONTRIBUTING.md) and the [test guide](../tests/README.md).
