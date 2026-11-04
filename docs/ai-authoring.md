# Optional AI authoring

Studio helps a business user describe a customization, clarify its behavior and check examples before deciding whether to use it. Live AI needs an operator-configured provider and can incur real charges. Native tasks, saved customizations and the labeled scripted example work without AI setup. Today's host contract supports read-only task advice; a general conversation does not grant unsupported capabilities.

Compiling new customizations, including the scripted example, requires Java 21 for the packaged Keir compiler. App startup and execution of already saved advice need only the documented Node runtime; the app does not install or upgrade Java.

## Configure a provider

In the local app, open **Configure** and choose one of the supported provider/model options. Enter its API key and a positive decimal total allowance (up to six fractional digits), then save. Saving checks the values locally; it does not contact the provider, verify the key, start a draft, or incur a charge. The status means **settings saved**, not **provider verified**. Every save requires the full key; the app never reads it back or retains a masked key for reuse.

| `KEIR_AI_PROVIDER` | `KEIR_AI_MODEL` | Required key |
| --- | --- | --- |
| `openai` | `gpt-5.6-terra` | `OPENAI_API_KEY` |
| `anthropic` | `claude-haiku-5-5` | `ANTHROPIC_API_KEY` |

The saved settings file is `ai-authoring.json` in the app's chosen data directory (by default `.data/`). It is ignored by Git. Keep the data directory private and out of public assets, shared backups, and exports. The file contains the key in plaintext protected by the local OS account and directory permissions; it is not encrypted. POSIX creation uses mode `0600` where applicable; Windows uses the directory's inherited ACL. Configuration is shared across all three local demo people and is not production administrator authentication.

The allowance is one positive, finite total shared across all demo owners in the database. The server reserves a conservative amount before each provider request. Reservations are durable and never refunded, including unused capacity, cancellation, interruption, or data reset. Changing settings or resetting data does not restore allowance. Choose an amount you are willing to spend; requests stop when it is exhausted. Do not put keys in browser code, chat, screenshots, logs, or public files.

The selected provider receives your authoring text, bounded recent conversation, the public host contract, static business guidance about supported task advice, a worked source and five synthetic syntax examples covering successful and unavailable reads, your current draft source and independent synthetic cases, and bounded sanitized per-example results. It also receives the selected version’s identity separately from the draft. For this customization’s eligible customer-approved selection, an exact matching approved check can supply a bounded synthetic summary; missing checks are explicit, and another customization’s selection supplies identity only. These summaries do not describe live task observations. Saved context helps it retain your choices when you return; oversized context is explicitly marked incomplete. Invalid scenario syntax returns a bounded case diagnostic for repair; business expectations remain independent of observed results. Results distinguish independently expected behavior from actual observations and mismatches. It does not receive session cookies, protected bindings or native task records. Avoid including unrelated private information in authoring messages.

Without valid settings, AI authoring is unavailable; native tasks and saved advice remain available. For tool authors learning Keir, use the [core manual authoring guide](https://github.com/rore/keir-core/blob/main/docs/manual-authoring.md).

Changing the provider, model, key, or allowance requires starting a fresh conversation before drafting again. Saved conversations and advice remain readable. If a save response is lost, setup status cannot prove whether your submitted key matches; resubmit the complete settings only if you want to retry the save. A save is refused while authoring work is still settling, including cancellation; wait for it to finish before saving again.

## Draft, verify, decide

The model can suggest a read-only draft and help prepare examples. It cannot approve a draft or activate it. Treat model-written examples as proposals, not independent expectations.

The assistant leads the conversation, asks about missing business choices, prepares the change and tries examples without changing tasks. It explains mismatches rather than changing expectations to make a check pass. The current contract can show Done, Pending or Needs attention from a task's status; it cannot create follow-ups, edit tasks or run background automation.

The clearly labeled scripted example needs no AI credentials and makes no provider request. It demonstrates Needs attention for open tasks and Done for completed tasks using the real compiler, independent synthetic cases, simulator and exact review. The scripted replies are not an AI conversation; the saved draft, evidence and approval remain available after leaving the example. Starting an example must not silently replace an unrelated draft. Approval and turning it on remain separate human decisions.

Describe the wanted outcomes before checking them. The assistant prepares and runs the examples through the actual Keir compiler and simulator, then explains what happened. A named example opens on request and returns to its exchange when closed. Choose **Approve this change** only when the checked behavior matches your intent. Turning it on is a separate action; switching from another customization names the one being replaced and keeps it saved. Until that choice, the currently selected advice remains in use.

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
