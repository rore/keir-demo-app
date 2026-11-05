# Daymark · A Keir Demo

Daymark is a local workspace for projects, tasks and notes. **Tasks** is where you do ordinary work. **AI Studio**, opened from **Customizations**, helps you draft and test a rule for what happens after a task completes. Native tasks work without AI setup, Java or a sibling Keir checkout. Each fictional demo user has separate data, stored in local SQLite across restarts.

## Run locally

Use **Node.js 24.14.1** with npm. Daymark uses Node's experimental SQLite API and includes pinned Keir packages in this checkout.

```sh
npm ci
npm run build
npm start
```

Open the exact address printed in the terminal (by default `http://127.0.0.1:3000`). Choose Maya, Leo or Sam and open **Tasks** to try the seeded workspace. Demo sign-in selects a fictional local account. See [running Daymark](docs/running.md) for ports, isolated data directories and recovery.

## Try a customization

Today, a rule can react to a new task completion and create at most one task in an existing project you can access. It can match the source task's project or exact title and use a fixed title, copy the source title or append a literal suffix. The original task completion is saved independently of the reaction. See the [task customization contract](docs/task-effects.md).

1. With **Java 21** available, open **Customizations** → **New customization**. Use **Configure** to set up a provider, API key and spending allowance. Sending a request to the provider can incur charges. See [AI authoring setup](docs/ai-authoring.md#configure-a-provider).
2. In Maya's seeded workspace, try “When I complete a task in The spring collection, create a task titled Follow up in that project.” If you chose another demo user, use one of their projects. Review matching and nonmatching examples. The examples simulate service calls and leave saved tasks alone.
3. Choose **Approve this change** when the checked examples match your intent. Separately choose **Turn on for my tasks**. If another customization is active, the action is **Switch to this customization**.
4. Return to **Tasks** and complete a new matching task. Check its **Customization outcome** for the real result. Earlier completions stay as they were.

Daymark uses pinned Keir artifacts and native permission checks for real reactions. Integrated release qualification is still pending. Read the [customization lifecycle](docs/read-extension-lifecycle.md) for approval, activation and outcome details, and the [test guide](tests/README.md) for verification.

[Keir Core](https://github.com/rore/keir-core) provides the compiler, runtimes and embedding guides.

License selection and public release are pending. No open-source license grant is implied.
