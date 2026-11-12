# Daymark · A Keir Demo

Daymark demonstrates Keir in a working application: describe a rule, check examples, then run the approved extension through the host's own services. A small task app supplies the example domain—a completed task can trigger a follow-up.

## Run locally

Use **Node.js 24.14.1** with npm. Keir packages are pinned in this checkout. The basic workspace runs without AI or Java; customization authoring uses the setup below.

```sh
git clone https://github.com/rore/keir-demo-app.git
cd keir-demo-app
npm ci
npm run build
npm start
```

Open the exact address printed in the terminal (by default `http://127.0.0.1:3000`). Choose Maya for the walkthrough. The other fictional accounts demonstrate separate customer state. See [running Daymark](docs/running.md) for ports, isolated data directories and recovery.

## Try a customization

[Follow the screenshot walkthrough](docs/customization-walkthrough.md) to see a project follow-up rule go from request to a saved task, without running the app.

1. With **Java 21** available, open **Customizations** → **New customization**. Use **Configure** to set up a provider, API key and an optional spending allowance. Sending a request to the provider can incur charges. See [AI authoring setup](docs/ai-authoring.md#configure-a-provider).
2. In Maya's seeded workspace, try “When I complete a task in The spring collection, create a task titled Follow up in that project.” If you chose another demo user, use one of their projects. Review matching and nonmatching examples. The examples simulate service calls and leave saved tasks alone.
3. Choose **Approve this change** when the checked examples match your intent. Separately choose **Turn on for tasks completed**. If another rule is on for that trigger, Studio names the rule this will replace. The previous customization stays saved; rules for other triggers keep their selections.
4. Return to **Tasks** and complete a new matching task. Check its **Customization outcome** for the real result. Earlier completions stay as they were.

An unknown outcome may already have changed a task. Use [saved-result recovery](docs/customization-walkthrough.md#changes-and-recovery) before retrying.

The host also exposes before-save checks and after-create actions. The [host-binding reference](docs/task-effects.md) explains these hooks and their native guarantees.

[Try the conditional follow-up example](docs/conditional-follow-up.md) to see Core 0.4.0 use an optional lookup’s answer: check only high-priority completions, then create a follow-up only when none is open.

## How it works

A business request becomes a Keir program using only the capabilities Daymark exposes. Daymark's assistant clarifies the request, compiles the program and simulates examples against the exact artifact. You review the expected and observed behavior, approve that revision and separately turn it on. Daymark then executes the approved artifact when the chosen trigger occurs; execution needs no further AI request.

Daymark owns the task data, permissions, capability implementations, conversations, evidence and activation policy. Keir supplies the language, compiler, runtime and simulation contracts. Inspect the [published model](extensions/task-effect/current/dcm.json), [authoring service](docs/read-extension-lifecycle.md#authoring-service) and [implementation map](src/README.md) to follow that boundary.

This checkout vendors pinned Keir compiler/runtime packages and an authoring guide. [Package provenance](docs/package-provenance.md) records their versions, hashes and compatibility. See the [documentation](docs/README.md) for setup and integration, or [Contributing](CONTRIBUTING.md) for development and testing.

[Keir Core](https://github.com/rore/keir-core) provides the compiler, runtimes and embedding guides.

Licensed under the [Apache License 2.0](LICENSE).
