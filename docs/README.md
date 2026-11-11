# Keir demo documentation

Start with the [screenshot walkthrough](customization-walkthrough.md): follow a request through compilation, simulation, approval and real host execution without installing the app.

## Run the example

- [Run locally](../README.md#run-locally), then [try the follow-up customization](../README.md#try-a-customization).
- [Configure an AI provider](ai-authoring.md#configure-a-provider) for conversational authoring.
- [Local setup and recovery](running.md) covers ports, data directories, backup and reset.

## Follow the Keir integration

- [Published model and hooks](../extensions/task-effect/current/dcm.json): the capabilities an extension can use.
- [Host binding and effects](task-effects.md): before-save decisions, after-save reactions and native receipts.
- [Customization lifecycle](read-extension-lifecycle.md): authoring operations, saved evidence, approval, identity and recovery.
- [Implementation map](../src/README.md): compiler, runtime, adapters and authoring services.
- [Package provenance](package-provenance.md): exact compiler, runtime and guide pins.
- [Keir embedding guide](https://github.com/rore/keir-core/blob/main/docs/embedding.md): the framework contracts demonstrated here.

For changes to the sample host, see [Contributing](../CONTRIBUTING.md), the [demonstration scope](scope.md) and [test guide](../tests/README.md). Native application invariants are linked from the contributor guide.

## Design research and history

These materials document design work rather than instructions for using the current app:

- [Studio embedding](studio-embedding.md): a proposed reusable UI boundary, not an independently packaged integration.
- [Business-understanding study](studio-business-understanding/concepts.md) and [recommendation](studio-business-understanding/recommendation.md): scripted design research with synthetic examples.
- [Rejected guided example](studio-guided-example.md), [superseded on-demand proposal](studio-on-demand-review.md) and [canvas-era design](historical/extension-studio-canvas-design.md): retained history.
