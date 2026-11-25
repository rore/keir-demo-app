# Configure AI authoring

Use this guide to configure the local provider, protect its key and control spending. Native tasks and saved history work without AI. Compiling a customization requires Java 21 and the [pinned compiler](package-provenance.md).

For the customer journey, follow the [Personal walkthrough](customization-walkthrough.md) or [author a Team customization](native-task-app-design.md#author-a-team-customization).

## Personal: discuss your existing work

Try asking, “What would complement the customizations I already have?” The assistant can inspect your saved rules and relevant tasks. It should explain which version and task evidence support its suggestion, and say when the information is incomplete. A saved name alone does not describe what a rule does.

Use **Send** (or Enter) for questions and requests. Ask directly when you want the assistant to create or revise the opened draft or check examples. Questions and suggestions are discussion; if your intent is unclear, the assistant asks before preparing changes. An offered **Open** action opens an existing customization after checking access again. It does not repeat your earlier request there. Your previous conversation and unsent text are kept. Review the proposal and its examples before deciding: approval and turning a checked revision on remain separate choices.

Daymark manages ordinary assistant context internally. You do not need to start another turn just to clear its working history. Saved messages and examples remain intact. Size and spending limits still apply; genuine failures remain visible. Generic **Continue** and **Try again** actions for other recoverable stops resume discussion only. Send a clear request for further draft or example-check work. Retrying an unconfirmed submitted request preserves that exact request's original intent. AI can misread natural language; inspect any prepared draft rather than treating the assistant's interpretation as approval.

## Team: confirm the proposed behavior

A current project admin uses Studio to discuss one Team project's rule. Check the proposal's scope, people and outcomes, including defaults like a fixed task title. If the assistant proposes dropping an unsupported part, agree to the narrower request before confirming. Daymark builds the checks from the proposed outcomes. **Confirm this behavior** saves and checks the exact draft without another provider request. If Daymark says it saved no draft, send a fresh request. If the reply is unconfirmed, use **Check saved state** instead of confirming again. A saved draft that fails the checks cannot be approved. Discussion can incur provider charges. Approval and turning on are separate, explicit choices.

The isolated Team review fixture uses scripted replies for two request shapes: linked review and high-priority triage. It exercises the real compiler, isolated native checks and task lifecycle. It does not qualify live interpretation, provider quality or arbitrary requests.

For new Team offers, Daymark supplies the source language, program name, model pin, and hook from the host. The assistant supplies the rule steps, return value, and independent business outcomes. Older full-source offers still work if their hook matches; Daymark replaces only the declared program metadata and rejects extra top-level fields. This does not rewrite saved rules.

## Configure a provider

In the local app, open **Configure** and choose a supported provider and model. Enter its API key. To cap Daymark spending, enter a positive USD amount with up to six decimal places. Leave the allowance blank to use AI without a Daymark spending cap. Saving checks the values locally and sends no provider request. Every save requires the full key.

| `KEIR_AI_PROVIDER` | `KEIR_AI_MODEL` | Required key |
| --- | --- | --- |
| `openai` | `gpt-5.6-terra` | `OPENAI_API_KEY` |
| `anthropic` | `claude-haiku-5-5` | `ANTHROPIC_API_KEY` |

The saved settings file is `ai-authoring.json` in the app's chosen data directory (by default `.data/`). It is ignored by Git. Keep the data directory private and out of public assets, shared backups, and exports. The file contains the key in plaintext protected by the local OS account and directory permissions; it is not encrypted. POSIX creation uses mode `0600` where applicable; Windows uses the directory's inherited ACL. Configuration is shared across all three local demo people and is not production administrator authentication.

The allowance is shared across Personal and Team authoring for all demo users. Daymark holds enough for a maximum-size request before sending it and releases only the excess after verified usage arrives. A cap must cover estimated spend plus any outstanding holds. Provider charges still apply with or without a Daymark cap. Leave `KEIR_AI_MAX_USD` unset or blank for no cap when using environment configuration. Keep keys out of browser code, chat, screenshots, logs and public files.

**Personal.** The provider can receive your authoring text, bounded recent conversation, the host contract, format examples, current draft and cases, and bounded synthetic check summaries. A turn includes the editing target and a count of other saved customizations, not the task database. On request, owner-scoped tools send project names and IDs, saved customization metadata and exact-version behavior/check summaries, or a bounded page of tasks from one project. Task results include titles, status, tags, priority, dates and whether notes exist. Notes are omitted unless requested for relevant context; returned notes are limited to 256 Unicode code points and marked when shortened. Pages and partial summaries do not establish a pattern across all your tasks.

**Team.** If the intent check proceeds to an assistant reply, Daymark sends the scoped Team catalog with that provider request. It can include the shared project's name, its current members' names and IDs, the supported model and proposal format, what is in use, and the saved proposal's source, business outcomes and summary. Daymark does not send the native test scripts or evidence in the Team conversation. The conversation has no live task-list tool. Daymark checks current admin access for the project.

A new free-text message first uses a bounded provider request to distinguish discussion, a preparation request or unclear intent. That step uses your message and relevant conversation context, not task/tool/source text. It counts against the same spending allowance and request limits. The later assistant step receives only the tools allowed for the resolved intent. Missing or invalid intent never permits draft preparation. This separation limits authority; it does not make AI interpretation infallible.

These reads use only the signed-in demo person's access. Task text and saved names are data, not instructions or permission to change a rule. The provider does not receive private records outside the signed-in person’s authorized scope, session cookies, or protected runtime bindings. Provider-side retention depends on the provider and your account terms; local storage and deletion do not control provider retention. Avoid unrelated private information in messages and tasks you ask the assistant to inspect.

Changing the provider, model, key or allowance requires fresh authoring context for future requests. The saved conversation stays with its Personal customization or Team project and admin. Continue explicitly in Customizations when ready. If a save response is lost, resubmit the complete settings only if you want to retry the save. Wait for ongoing authoring or cancellation to settle before saving again.

For advanced local process configuration, `.env.example` documents the supported environment variables. The app does not load that file automatically. A valid saved local settings file takes precedence over environment configuration; if no local file exists, environment settings remain a fallback. An invalid existing settings file fails closed instead of falling back.

## Spending estimates and earlier reservations

OpenAI requests use 30-minute prompt caching. At the supported Terra rates, Daymark holds $0.387072 before sending, covering up to 135,168 input tokens at the cache-write rate and 4,096 output tokens. After a confirmed response, Daymark estimates the cost from reported usage. If it can price that usage safely, the same saved dispatch records the estimate and releases the excess once. An interrupted or unpriceable response keeps the full hold. **Configure** shows estimated spend separately from held allowance. Neither is an invoice or a provider refund. Provider prices can change: see [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), and [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).

Earlier reservations without verified usage stay held, including the existing uplift for earlier OpenAI holds that omitted cache-write pricing. A reset carries forward settled estimates separately before removing dispatch history. Unclassified holds still receive the conservative uplift. Reset and settings changes never create fresh credit.

<a id="how-daymark-runs-the-assistant"></a>
For authoring tools, saved operations and recovery guarantees, see the [lifecycle reference](read-extension-lifecycle.md#authoring-service). Daymark loads the authoring guide recorded in [package provenance](package-provenance.md).

<a id="optional-live-provider-qualification"></a>
For the optional paid qualification harness, see [developer verification](../tests/README.md#optional-live-provider-qualification). Saving app settings does not authorize that check. Scripted automated tests do not qualify a live model.
