# Task-domain integration assets

The maintained model and compiler selection live in [extensions/task-effect/current/](../extensions/task-effect/current/). [extension-catalog.mjs](../src/extension-catalog.mjs) loads those exact bytes and binds their identity to the pinned Keir packages. The [authoring examples](../src/authoring-example.mjs) supply source and scenario format examples; each customer's saved source, artifacts, reviewed scenarios and evidence live in the local database.

The earlier `extensions/task-effect/workflow/` and `title/` assets support compatibility and retained history; they are not the current authoring model. Preserve their exact bytes and pins. See the [lifecycle guide](../docs/read-extension-lifecycle.md) for existing selections and the [source map](../src/README.md) for real adapters.

Capabilities wrap native task services. Domain types and host-bound fields must remain consistent with those adapters. Approval, activation and current native permission remain separate requirements. Framework schemas and artifact semantics belong to [Keir Core](https://github.com/rore/keir-core), rather than this directory.
