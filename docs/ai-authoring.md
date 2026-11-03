# Optional AI authoring

The task-advice conversation assistant can prepare advice for review. It needs an operator-configured provider and can incur real charges. Native tasks and saved advice continue to work without AI setup.

## Configure a provider

In the local app, open **Configure** and choose one of the supported provider/model options. Enter its API key and a positive decimal total allowance (up to six fractional digits), then save. Saving checks the values locally; it does not contact the provider, verify the key, start a draft, or incur a charge. The status means **settings saved**, not **provider verified**. Every save requires the full key; the app never reads it back or retains a masked key for reuse.

| `KEIR_AI_PROVIDER` | `KEIR_AI_MODEL` | Required key |
| --- | --- | --- |
| `openai` | `gpt-5.6-terra` | `OPENAI_API_KEY` |
| `anthropic` | `claude-haiku-5-5` | `ANTHROPIC_API_KEY` |

The saved settings file is `ai-authoring.json` in the app's chosen data directory (by default `.data/`). It is ignored by Git. Keep the data directory private and out of public assets, shared backups, and exports. The file contains the key in plaintext protected by the local OS account and directory permissions; it is not encrypted. POSIX creation uses mode `0600` where applicable; Windows uses the directory's inherited ACL. Configuration is shared across all three local demo people and is not production administrator authentication.

The allowance is one positive, finite total shared across all demo owners in the database. The server reserves a conservative amount before each provider request. Reservations are durable and never refunded, including unused capacity, cancellation, interruption, or data reset. Changing settings or resetting data does not restore allowance. Choose an amount you are willing to spend; requests stop when it is exhausted. Do not put keys in browser code, chat, screenshots, logs, or public files.

The selected provider receives your authoring text, bounded recent conversation, the public host contract, static business guidance about supported task advice, a worked source/scenario, your current draft source and independent synthetic cases, and bounded sanitized per-example results. Saved context helps it retain your choices when you return; oversized context is explicitly marked incomplete. Results distinguish independently expected behavior from actual observations and mismatches. It does not receive session cookies, protected bindings or native task records. Avoid including unrelated private information in authoring messages.

Without valid settings, AI authoring is unavailable; native tasks and saved advice remain available. For tool authors learning Keir, use the [core manual authoring guide](https://github.com/rore/keir-core/blob/main/docs/manual-authoring.md).

Changing the provider, model, key, or allowance requires starting a fresh conversation before drafting again. Saved conversations and advice remain readable. If a save response is lost, setup status cannot prove whether your submitted key matches; resubmit the complete settings only if you want to retry the save. A save is refused while authoring work is still settling, including cancellation; wait for it to finish before saving again.

## Draft, verify, decide

The model can suggest a read-only draft and help prepare examples. It cannot approve a draft or activate it. Treat model-written examples as proposals, not independent expectations.

The assistant leads the conversation, asks about missing business choices, prepares the change and tries examples without changing tasks. It explains mismatches rather than changing expectations to make a check pass. The current contract can show Done, Pending or Needs attention from a task's status; it cannot create follow-ups, edit tasks or run background automation.

The clearly labeled scripted example needs no AI credentials and makes no provider request. It demonstrates Needs attention for open tasks and Done for completed tasks using the real compiler, independent synthetic cases, simulator and exact review. The scripted replies are not an AI conversation; the saved draft, evidence and approval remain available after leaving the example. Starting an example must not silently replace an unrelated draft. Approval and turning it on remain separate human decisions.

Before using advice, independently choose and review the expected scenarios, run them through the host compiler and simulator, and inspect the exact results. Approve only the exact revision with eligible host evidence. Then choose **Use this advice for me** as a separate human action. Until that choice, the currently selected advice remains in use.

## Conversations and recovery

Conversations persist under their demo owner and survive process restarts. If the process stops during a provider or host operation, the saved conversation is marked interrupted. Startup only reads and marks the saved state; it does not call the provider, compiler, or simulator again. Open the conversation, inspect its saved draft and status, and explicitly continue only when the UI offers that action. A cancel, timeout, or lost response can leave a saved change; read saved state before retrying.

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
