# Optional AI authoring

AI authoring is an optional, server-side drafting aid in the local Studio. The app and its existing manual authoring and saved advice flows work without provider credentials. Provider setup is an operator choice and can incur real charges.

## Configure a provider

Set these variables in the environment of the server process before starting the app. The app does not load `.env` or `.env.example` automatically. `.env.example` shows the two accepted configurations; use only one provider/model/key pair:

| `KEIR_AI_PROVIDER` | `KEIR_AI_MODEL` | Required key |
| --- | --- | --- |
| `openai` | `gpt-5.6-terra` | `OPENAI_API_KEY` |
| `anthropic` | `claude-haiku-5-5` | `ANTHROPIC_API_KEY` |

Set `KEIR_AI_MAX_USD` to a positive decimal allowance, with up to six fractional digits. It is one finite, durable allowance shared across all demo owners in that database. The server reserves a conservative amount before each provider request. Reservations are never refunded, including for unused capacity, cancellation, interruption, or reset. Requests stop when the allowance is exhausted. Choose a cap you are willing to spend before enabling a provider.

Keep keys in the server process environment. Do not put them in browser code, API requests, screenshots, logs, or public files. Provider credentials, internal counters, and continuation state are not part of the public app responses.

The selected provider receives your authoring text, the public host contract, draft source, synthetic cases and sanitized tool results. It does not receive session cookies, protected bindings or native task records. Avoid including unrelated private information in authoring messages.

Without a valid configuration, AI authoring is unavailable; native tasks, saved advice, and the manual authored-source qualification path remain available. Java is only needed for source compilation, as described in [manual authored drafts](authored-extension-drafts.md).

## Draft, verify, decide

The model can suggest a read-only draft and help prepare examples. It cannot approve a draft or activate it. Treat model-written examples as proposals, not independent expectations.

Before using advice, independently choose and review the expected scenarios, run them through the host compiler and simulator, and inspect the exact results. Approve only the exact revision with eligible host evidence. Then choose **Use this advice for me** as a separate human action. Until that choice, the currently selected advice remains in use.

## Conversations and recovery

Conversations persist under their demo owner and survive process restarts. If the process stops during a provider or host operation, the saved conversation is marked interrupted. Startup only reads and marks the saved state; it does not call the provider, compiler, or simulator again. Open the conversation, inspect its saved draft and status, and explicitly continue only when the UI offers that action. A cancel, timeout, or lost response can leave a saved change; read saved state before retrying.

The shared allowance is stored with the database and is preserved by the app's deliberate reset. Do not delete or replace the database to recover allowance. Use the existing data backup and recovery guidance before any deliberate database operation.

## Optional live provider qualification

The default command is a dry check and makes no provider request:

```sh
node scripts/check-authoring-provider.mjs
```

The opt-in check uses the isolated host fixture included with this project. Run it only after an operator has configured one accepted provider, supplied a key, chosen a spend cap, and explicitly authorized the possible provider costs:

```sh
node scripts/check-authoring-provider.mjs --live --host scripts/authoring-qualification-host.mjs
```

This can make billable live requests and exercise the local compiler/simulator. The script emits bounded status and qualification details, not credentials or provider continuation content. Fake protocol checks in the automated suite validate the harness and request handling; they do not establish real provider compatibility. No live provider qualification is claimed by this guide.

Each explicit qualification invocation creates and removes its own synthetic database and has its own configured allowance. It does not consume or reset the running app's ledger. Repeating the command can incur another allowance of charges.
