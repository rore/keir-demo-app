# Optional AI authoring

Studio helps a business user describe a customization, clarify its behavior and check examples before deciding whether to use it. Live AI needs an operator-configured provider and can incur real charges. Native tasks and saved history work without AI setup. The current candidate uses the published `TaskCompleted` contract to create a task after a matching new completion. A general conversation grants no extra capabilities. Real execution requires compatible current-contract bytes and current native host permission; integrated release qualification remains pending. See [task effects](task-effects.md). Earlier advice and scripted-example execution offers are retired.

Compiling new customizations requires Java 21 and the independently pinned Keir compiler. App startup needs only the documented Node runtime. The app does not install or upgrade Java, and a working compiler does not qualify native effects.

## Configure a provider

In the local app, open **Configure** and choose one of the supported provider/model options. Enter its API key and a positive decimal total allowance (up to six fractional digits), then save. Saving checks the values locally; it does not contact the provider, verify the key, start a draft, or incur a charge. The status means **settings saved**, not **provider verified**. Every save requires the full key; the app never reads it back or retains a masked key for reuse.

| `KEIR_AI_PROVIDER` | `KEIR_AI_MODEL` | Required key |
| --- | --- | --- |
| `openai` | `gpt-5.6-terra` | `OPENAI_API_KEY` |
| `anthropic` | `claude-haiku-5-5` | `ANTHROPIC_API_KEY` |

The saved settings file is `ai-authoring.json` in the app's chosen data directory (by default `.data/`). It is ignored by Git. Keep the data directory private and out of public assets, shared backups, and exports. The file contains the key in plaintext protected by the local OS account and directory permissions; it is not encrypted. POSIX creation uses mode `0600` where applicable; Windows uses the directory's inherited ACL. Configuration is shared across all three local demo people and is not production administrator authentication.

The allowance is one positive, finite total shared across all demo owners in the database. The server reserves a conservative amount before each provider request. Reservations are durable and never refunded, including unused capacity, cancellation, interruption, or data reset. Changing settings or resetting data does not restore allowance. Choose an amount you are willing to spend; requests stop when it is exhausted. Do not put keys in browser code, chat, screenshots, logs, or public files.

The selected provider receives your authoring text, bounded recent conversation, the public host contract, static task-completion guidance, worked source and synthetic syntax examples, your current draft source and independent cases, and bounded sanitized per-example results. Owner-scoped project discovery supplies accessible project choices so a confirmed project and task title become customer-owned source constants; no hidden follow-up adapter chooses them. The selected version's identity is separate from the draft. An exact matching approved check may supply a bounded synthetic summary; missing checks are explicit. These summaries are not live task observations. Saved context helps retain choices; oversized context is explicitly marked incomplete. Results distinguish independently expected behavior from actual observations and mismatches. The provider does not receive session cookies or protected runtime bindings. Avoid unrelated private information in messages.

Without valid settings, AI authoring is unavailable; native tasks and saved history remain available. For tool authors learning Keir, use the [core manual authoring guide](https://github.com/rore/keir-core/blob/main/docs/manual-authoring.md).

Changing the provider, model, key, or allowance requires starting a fresh conversation before drafting again. Saved conversations and customizations remain readable. If a save response is lost, setup status cannot prove whether your submitted key matches; resubmit the complete settings only if you want to retry the save. A save is refused while authoring work is still settling, including cancellation; wait for it to finish before saving again.

## Draft, verify, decide

The model can suggest source and help prepare examples. It cannot approve, activate, complete a native task or grant native authority. Treat model-written examples as proposals; agree on wanted behavior independently of observed results.

The assistant asks about missing business choices and discovers projects through the owner's native project catalog. It confirms which existing project and title to use, then compiles and checks the change without changing native tasks. Source can use generic `tasks.get` and `tasks.create` under `TaskCompleted`; session-bound authority stays with the host. Unsupported behavior requires clarification rather than a silently substituted rule. There is no manual-authoring fallback or capability-selection wizard.

Earlier advice conversations, scripted examples and their approvals remain historical. They cannot be resumed or turned into a task-creating customization. Start a new customization with fresh checks, approval and activation. Original receipt recovery remains readable and never creates a replacement item or repeats an old write.

Describe matching and nonmatching outcomes before checking them. A deliberately opened canvas shows recognizable example tasks, independently expected created tasks and actual simulated effects. It also shows the current version's own exact checked behavior, or explains that it is unavailable; a label or source result such as `CREATED` is not evidence of a task. These examples are synthetic and make no native changes. Close the example to return to the same exchange and focus. Choose **Approve this change** only when the checked behavior matches your intent. **Turn on for my tasks** is a separate decision; switching names the replaced customization and keeps it saved. Activation creates nothing and replays no earlier completion. An unavailable runtime binding permits review and approval but cannot run the change.

## Conversations and recovery

**New customization** opens an empty conversation, even when other work exists. Opening it or typing does not create an item or call AI. The first accepted message creates a distinct saved item; later turns stay with that item. Opening a saved item resumes its current changes. History retains earlier discussions and displaced drafts for read-only inspection. Starting again from the version in use requires an explicit confirmation and preserves the unfinished work in History.

Conversations persist under their demo owner and saved customization and survive process restarts. If the process stops during a provider or host operation, the saved conversation is marked interrupted. Startup only reads and marks the saved state; it does not call the provider, compiler, or simulator again. Open the conversation, inspect its saved draft and status, and explicitly continue only when the UI offers that action. A cancel, timeout, or lost response can leave a saved change; check the original submitted request before retrying. Recovery does not automatically repeat a paid turn or create another item.

Discussions have no fixed age, total run duration, turn count or tool-call quota. Saved customizations, revisions, messages and receipts are retained and loaded in pages. **Load earlier messages**, discussion history and **Load more** retrieve older work without sending it to the provider or changing the current proposal. Every explicit turn uses the current saved draft and bounded recent context; older messages remain available for inspection.

Individual inputs, source, examples, responses and native provider requests still have byte and format limits. Provider, compiler and simulation operations retain their own timeouts, cancellation and concurrency controls; Keir execution retains its runtime budgets. The exact native request is checked before reserving allowance. When its context is full, progress is kept and **Continue here from saved work** starts another explicit turn in the same discussion using fresh host context. This does not reset the shared spending allowance or replay the previous request. Changing actual provider settings still requires a fresh discussion as described above.

For advanced local process configuration, `.env.example` documents the supported environment variables. The app does not load that file automatically. A valid saved local settings file takes precedence over environment configuration; if no local file exists, environment settings remain a fallback. An invalid existing settings file fails closed instead of falling back.

## Optional live provider qualification

The default command is a dry check and makes no provider request:

The qualification script reads only its process environment, not the running app's saved settings file. Supply its supported provider/model/key and finite allowance separately; in-app setup does not authorize a qualification call.

```sh
node scripts/check-authoring-provider.mjs
```

The opt-in check uses the isolated host fixture included with this project. Run it only after an operator has configured one accepted provider, supplied a key, chosen a spend cap, and explicitly authorized the possible provider costs:

```sh
node scripts/check-authoring-provider.mjs --live --host scripts/authoring-qualification-host.mjs
```

This can make billable live requests and exercise the local compiler/simulator. The script emits bounded status and qualification details, not credentials or provider continuation content. Fake protocol checks in the automated suite validate the harness and request handling; they do not establish real provider compatibility. No live provider qualification is claimed by this guide.

Each explicit qualification invocation creates and removes its own synthetic database and has its own configured allowance. It does not consume or reset the running app's ledger. Repeating the command can incur another allowance of charges.

Deleting a customization requires authoring for that item to Stop and fully settle first; deletion never cancels work or refunds credit automatically. Linked discussions then disappear from normal navigation. Their messages, operation identities, dispatch outcomes and reserved/UNKNOWN accounting remain retained internally. Exact submitted-turn recovery and replay return `410 CUSTOMIZATION_DELETED` with no actionable discussion or provider work; conflicting reuse of an operation identity still returns 409. The browser removes only that matching pending request and offers a return to the collection, including when its preliminary item lookup is unavailable. Legacy discussions without a confirmed item link retain their existing read-only behavior.
