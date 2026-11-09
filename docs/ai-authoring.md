# Optional AI authoring

Studio helps you describe a customization and check examples before deciding whether to use it. Live AI needs a configured provider and can incur charges. Native tasks and saved history work without AI setup. A check can allow or deny a proposed task before saving. A workflow can create one task or update the triggering task after a matching creation or completion. Real execution requires a compatible approved revision, activation and current native host permission. See [task customizations](task-effects.md).

Daymark pins Core 0.3.0 release packages and the exact authoring companion v5 guide. Compiling new customizations requires Java 21 and the independently pinned Keir compiler. App startup needs only the documented Node runtime. Existing `/2` event artifacts retain their original execution pins; new authoring uses the `/3` model and artifact formats. The app does not install or upgrade Java, and a working compiler does not qualify native effects.

## Configure a provider

In the local app, open **Configure** and choose a supported provider and model. Enter its API key. To cap Daymark spending, enter a positive USD amount with up to six decimal places. Leave the allowance blank to use AI without a Daymark spending cap. Saving checks the values locally and sends no provider request. Every save requires the full key.

| `KEIR_AI_PROVIDER` | `KEIR_AI_MODEL` | Required key |
| --- | --- | --- |
| `openai` | `gpt-5.6-terra` | `OPENAI_API_KEY` |
| `anthropic` | `claude-haiku-5-5` | `ANTHROPIC_API_KEY` |

The saved settings file is `ai-authoring.json` in the app's chosen data directory (by default `.data/`). It is ignored by Git. Keep the data directory private and out of public assets, shared backups, and exports. The file contains the key in plaintext protected by the local OS account and directory permissions; it is not encrypted. POSIX creation uses mode `0600` where applicable; Windows uses the directory's inherited ACL. Configuration is shared across all three local demo people and is not production administrator authentication.

When set, the allowance is shared across all demo owners in the database. Daymark records a conservative cost estimate before each provider request, even with the cap off. Those records survive cancellations, settings changes and data resets. A cap must cover previous reservations and stops new requests when the remaining amount is too small. Provider charges still apply with either setting. Leave `KEIR_AI_MAX_USD` unset or blank for no Daymark cap when using environment configuration. Keep keys out of browser code, chat, screenshots, logs and public files.

The provider can receive your authoring text, bounded recent conversation, the published host contract, format examples, current draft and cases, and bounded synthetic check summaries. Daymark offers owner-scoped project discovery for named project choices. The provider does not receive session cookies or protected runtime bindings. Avoid unrelated private information in messages.

AI authoring requires valid settings. Native tasks and saved history work before provider setup. For tool authors learning the current contract, use the [v5 authoring companion](https://github.com/rore/keir-core/releases/download/v0.3.0/keir-authoring-v5.zip), which includes the guide, schemas and examples. Daymark loads its pinned guide text locally. The discovered catalog includes read-only checks before adding a task and actions after adding or completing. A before-save ALLOW is permission to continue normal native checks, not evidence that a task was saved.

Changing the provider, model, key or allowance requires fresh authoring context for future requests. The saved conversation stays with the customization. Continue explicitly in Studio when ready. If a save response is lost, resubmit the complete settings only if you want to retry the save. Wait for ongoing authoring or cancellation to settle before saving again.

## Draft, verify, decide

The model can suggest source and help prepare examples. It cannot approve, activate, complete a native task or grant native authority. Treat model-written examples as proposals; agree on wanted behavior independently of observed results.

The assistant asks about missing business choices and uses the owner's project catalog to resolve named projects. It compiles the proposed rule and checks it without changing native tasks. All three triggers can read through `tasks.get` and `tasks.openMatch`; only the after-added and after-completed triggers can use `tasks.create` and `tasks.update`. Daymark supplies session-bound authority. If the assistant cannot express the requested behavior, it asks before drafting an alternative.

### How Daymark runs the assistant

1. On an explicit send, Daymark supplies instructions, the message, bounded saved context, and an allowlist of authoring tools to its configured model. Daymark owns the conversation, resource limits, and tool execution.
2. `discover_catalog` returns the exact published domain capability model (DCM), its identity and fingerprint, supported hooks, the selected trigger when established, draft state, host guidance, and source and scenario examples. The DCM defines the callable operations, typed inputs and results, and protected parameters. The host guidance explains what those concepts mean in Daymark. Examples illustrate syntax.
3. The model can ask a question or propose source and expected examples. Daymark validates tool arguments and checks the current owner and draft on each operation. The Keir compiler checks source against the host's pinned DCM. The runtime runs the compiled artifact with simulation implementations and returns evidence for review.
4. Approval and activation are explicit user actions handled by Daymark. On a later matching task creation or completion, Daymark selects the active artifact for that owner and trigger and supplies real implementations and fresh trusted context to Keir. That execution uses the compiled rule without an AI request.

Earlier advice conversations, scripted examples and their approvals remain historical. They cannot be resumed or turned into a task-creating customization. Start a new customization with fresh checks, approval and activation. Original receipt recovery remains readable and never creates a replacement item or repeats an old write.

Describe matching and nonmatching outcomes before checking them. Studio shows **About this rule** and **Simulation** in the conversation, with the example task, independently expected changes and observed simulated result. It reports created or updated tasks, no change, uncertainty and unavailable evidence distinctly. **Hide simulation** keeps the conversation and unsent text. Secondary inspection shows one saved version at a time. These examples use synthetic data. Choose **Approve this change** when the checked behavior matches your intent. **Turn on for tasks added** or **Turn on for tasks completed** activates the approved version for that trigger. Switching identifies the replaced customization and keeps it saved. Activation takes effect on future matching events. An unavailable runtime binding permits review and approval while execution remains unavailable.

## Conversations and recovery

**New customization** opens an empty conversation. The first accepted message creates the saved item. Each saved customization has one visible conversation in Studio, even when a fresh authoring run is needed. Reopening the item and reading earlier messages use saved data. Sending a turn is an explicit action. History retains earlier saved versions and displaced drafts for inspection. Starting again from the version in use requires confirmation.

Conversations persist under their demo owner and saved customization and survive process restarts. If the process stops during a provider or host operation, the saved conversation is marked interrupted. Startup only reads and marks the saved state; it does not call the provider, compiler, or simulator again. Open the conversation, inspect its saved draft and status, and explicitly continue only when the UI offers that action. A cancel, timeout, or lost response can leave a saved change; check the original submitted request before retrying. Recovery does not automatically repeat a paid turn or create another item.

Discussions have no fixed age, total run duration, turn count or tool-call quota. Saved customizations, revisions, messages and receipts are retained and loaded in pages. **Load earlier messages**, discussion history and **Load more** retrieve older work without sending it to the provider or changing the current proposal. Every explicit turn uses the current saved draft and bounded recent context; older messages remain available for inspection.

Individual inputs, source, examples, responses and native provider requests have byte and format limits. Provider, compiler, simulation and runtime work have separate limits. The exact native request is checked before reserving allowance. When its context is full, **Continue here from saved work** starts another explicit turn in the same visible conversation using fresh host context. It uses the existing shared spending allowance and preserves the previous request in the transcript.

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
