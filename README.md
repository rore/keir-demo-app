# Daymark · A Keir Demo

Daymark is a local task manager that demonstrates customer customizations with Keir. Use **Tasks** to manage projects, tag tasks, and search within a project. Open **Customizations** to check new tasks before saving or react after a task is added or completed. The task workspace runs without an AI provider or Java. Each fictional demo user has separate data, stored in SQLite across restarts.

## Run locally

Use **Node.js 24.14.1** with npm. Daymark uses Node's experimental SQLite API and includes pinned Keir packages in this checkout.

```sh
git clone https://github.com/rore/keir-demo-app.git
cd keir-demo-app
npm ci
npm run build
npm start
```

Open the exact address printed in the terminal (by default `http://127.0.0.1:3000`). Choose Maya, Leo or Sam and open **Tasks** to try the seeded workspace. Demo sign-in selects a fictional local account. See [running Daymark](docs/running.md) for ports, isolated data directories and recovery.

## Try a customization

A before-save rule can require a due date for client-tagged tasks, notes for high-priority tasks, or a review tag in a chosen project. Use **Details** beside quick-add to enter these fields before adding the task. A denied or unavailable check keeps the draft editable. Rules after adding or completing can read tasks and create one task or update the triggering task; their outcomes remain separate from the original save. See the [task customization contract](docs/task-effects.md).

1. With **Java 21** available, open **Customizations** → **New customization**. Use **Configure** to set up a provider, API key and spending allowance. Sending a request to the provider can incur charges. See [AI authoring setup](docs/ai-authoring.md#configure-a-provider).
2. In Maya's seeded workspace, try “When I complete a task in The spring collection, create a task titled Follow up in that project.” If you chose another demo user, use one of their projects. Review matching and nonmatching examples. The examples simulate service calls and leave saved tasks alone.
3. Choose **Approve this change** when the checked examples match your intent. Separately choose **Turn on for tasks completed**. If another rule is on for that trigger, Studio names the rule this will replace. The previous customization stays saved; rules for other triggers keep their selections.
4. Return to **Tasks** and complete a new matching task. Check its **Customization outcome** for the real result. Earlier completions stay as they were.

If a creation response is lost, **Check result** reads the original attempt. An explicit same-attempt retry keeps its original ID and submitted values; newer edits remain separate. See [task creation and readback](docs/task-creation.md).

## How it works

A business request becomes a Keir program using only the capabilities Daymark exposes. Daymark's assistant clarifies the request, compiles the program and simulates examples against the exact artifact. You review the expected and observed behavior, approve that revision and separately turn it on. Daymark then executes the approved artifact when the chosen trigger occurs; execution needs no further AI request.

Daymark owns the task data, permissions, capability implementations, conversations, evidence and activation policy. Keir supplies the language, compiler, runtime and simulation contracts. The [authoring guide](docs/ai-authoring.md#how-daymark-runs-the-assistant) follows that boundary; the [source map](src/README.md) links its implementation.

Daymark pins the compiler, runtime and authoring companion from [Keir Core 0.3.0](https://github.com/rore/keir-core/releases/tag/v0.3.0). Provenance records their exact source revisions and archive checksums. See the [documentation](docs/README.md) for setup, usage, and integration details, or [Contributing](CONTRIBUTING.md) for development and testing.

[Keir Core](https://github.com/rore/keir-core) provides the compiler, runtimes and embedding guides.

Licensed under the [Apache License 2.0](LICENSE).
