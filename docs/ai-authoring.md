# Configure AI authoring

Use this guide to configure the local provider, protect its key and control spending. Native tasks and saved history work without AI. Compiling a customization requires Java 21 and the [pinned compiler](package-provenance.md).

For the customer journey, [try a customization](../README.md#try-a-customization) or follow the [screenshot walkthrough](customization-walkthrough.md).

## Configure a provider

In the local app, open **Configure** and choose a supported provider and model. Enter its API key. To cap Daymark spending, enter a positive USD amount with up to six decimal places. Leave the allowance blank to use AI without a Daymark spending cap. Saving checks the values locally and sends no provider request. Every save requires the full key.

| `KEIR_AI_PROVIDER` | `KEIR_AI_MODEL` | Required key |
| --- | --- | --- |
| `openai` | `gpt-5.6-terra` | `OPENAI_API_KEY` |
| `anthropic` | `claude-haiku-5-5` | `ANTHROPIC_API_KEY` |

The saved settings file is `ai-authoring.json` in the app's chosen data directory (by default `.data/`). It is ignored by Git. Keep the data directory private and out of public assets, shared backups, and exports. The file contains the key in plaintext protected by the local OS account and directory permissions; it is not encrypted. POSIX creation uses mode `0600` where applicable; Windows uses the directory's inherited ACL. Configuration is shared across all three local demo people and is not production administrator authentication.

When set, the allowance is shared across all demo owners in the database. Daymark records a conservative cost estimate before each provider request, even with the cap off. Those records survive cancellations, settings changes and data resets. A cap must cover previous reservations and stops new requests when the remaining amount is too small. Provider charges still apply with either setting. Leave `KEIR_AI_MAX_USD` unset or blank for no Daymark cap when using environment configuration. Keep keys out of browser code, chat, screenshots, logs and public files.

OpenAI requests explicitly use 30-minute prompt caching. At the supported Terra rates, Daymark reserves $0.387072 per request, covering up to 135,168 input tokens at the cache-write rate and 4,096 output tokens. This is held allowance, not an invoice; cached reads and smaller requests can cost less, and Daymark does not refund the difference. The full native request is limited to 128 KiB and size-checked before reserving allowance or dispatch; the input reservation also includes a framing allowance. Provider prices can change, so review the [model pricing](https://developers.openai.com/api/docs/models/gpt-5.6-terra) and [cache-write rates](https://developers.openai.com/api/docs/guides/prompt-caching) before relying on an older app version's estimate.

Earlier OpenAI reservations omitted cache-write pricing. This version conservatively counts their missing allowance without rewriting saved receipts. A reset keeps the global held amount but removes its dispatch history, so any amount that can no longer be attributed is conservatively increased as well, even if some came from newer or other-provider requests. That adjustment can reduce the remaining allowance; reset and settings changes never create fresh credit.

The provider can receive your authoring text, bounded recent conversation, the published host contract, format examples, current draft and cases, and bounded synthetic check summaries. Owner-scoped project discovery sends existing project names and IDs to the provider to resolve project choices. The provider does not receive session cookies or protected runtime bindings. Provider-side retention depends on the provider and your account terms; local storage and deletion do not control provider retention. Avoid unrelated private information in messages.

Changing the provider, model, key or allowance requires fresh authoring context for future requests. The saved conversation stays with the customization. Continue explicitly in Studio when ready. If a save response is lost, resubmit the complete settings only if you want to retry the save. Wait for ongoing authoring or cancellation to settle before saving again.

For advanced local process configuration, `.env.example` documents the supported environment variables. The app does not load that file automatically. A valid saved local settings file takes precedence over environment configuration; if no local file exists, environment settings remain a fallback. An invalid existing settings file fails closed instead of falling back.

<a id="how-daymark-runs-the-assistant"></a>
For authoring tools, saved operations and recovery guarantees, see the [lifecycle reference](read-extension-lifecycle.md#authoring-service). Daymark loads the authoring guide recorded in [package provenance](package-provenance.md).

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
