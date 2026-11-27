# Configure AI authoring

Use this guide to configure the local provider, protect its key and control spending. Native tasks and saved history work without AI. Compiling a customization requires Java 21 and the [pinned compiler](package-provenance.md).

For the customer journey, follow the [Personal walkthrough](customization-walkthrough.md) or [author a Team customization](native-task-app-design.md#author-a-team-customization).

## Personal: discuss your existing work

Try asking in Shared Studio, “What would complement the customizations I already have?” The assistant can inspect your other owned Personal rules and search a bounded page of tasks in an owned Personal project. It can distinguish the draft, its checked examples, and the revision in use. Reading another rule does not open or change it. A saved name alone does not describe what a rule does.

With **Allow task-note excerpts for this message** unchecked, Shared Studio searches task titles only and fetches no new note excerpts. If notes matter to your request, check the box before sending. This lets the assistant search notes and request up to 256 Unicode code points of notes per matching task on a bounded page in a Personal project you own. The choice resets when you send. A saved assistant reply that quotes an excerpt can still be sent to the provider on a later turn as part of the limited recent conversation, even with the box unchecked.

Use **New customization** in Personal to start in Shared Studio. In Team, choose **New customization** for a blank project or **Open Studio** when the project has a draft, a discussion, a rule in use, or saved rule history. Both Team buttons open Shared Studio. Use **Send** (or Enter) for questions and requests. Choose **Confirm and check** to save a draft and check its examples without another provider request. Approving and turning on the rule are separate choices.

In Team Studio, **More → Turn off for new tasks** stops the current rule for tasks people add later. Existing tasks keep the rule they started with. For emergency revocation or to continue an earlier Team draft or discussion from **More**, see [Saved Team history and controls](native-task-app-design.md#saved-team-history-and-controls).

Open an earlier saved Personal item to read or continue its work. In that editor, the confirmation button is **Confirm this behavior** and an offered **Open** action can open another customization. For a retired item, choose **Open history** to read its saved work.

Under **Submitted requests**, choose **Check submitted request** to look up an earlier request without resending it. If no saved result exists for an earlier request to create a customization, copy its text into Shared Studio to send it as a new request.

If a confirmation reply is lost, use **Read saved state** in Shared Studio or **Check authoring status** in the earlier Personal editor. A draft can be saved even when its checks are unavailable. Read the saved result before requesting another change.

If Shared Studio cannot read or use the assistant’s reply, choose **Check saved work** to see what was kept. This does not send the message again or confirm what the provider charged.

## Personal: check before creating in a project you own

In Shared Studio, a Personal after-save or after-completion rule can create a follow-up in the triggering task’s project or another Personal project you own. You can optionally check for an open task with an exact, case-sensitive title before creating it. Choose the lookup project separately: it can be the source project, the destination, or another Personal project you own. The lookup checks only that project and does not guarantee uniqueness.

The assistant can look beyond the first page of projects. If a name is ambiguous, it should ask which project you mean. The proposal and examples number projects with matching names, such as “Accounts” (project 1) and “Accounts” (project 2). Open **Rule details** to check their exact IDs. Renaming a project does not change its ID.

The rule can create one unlinked, unassigned task. The destination must pass any applicable before-save check from the rule revision that started the work. Daymark does not apply an unrelated Personal rule that happens to be on. Team lookup and creation stay in the same Team project. If your request includes unsupported behavior, the assistant should ask before narrowing it.

A Personal follow-up does not trigger an after-save rule. If you later complete it in Tasks, the standalone completion rule in use at that moment can run. If there is no completion rule, or the rule needs a binding from when the task was created, completion still saves without a rule effect.

Review the checked examples before approving and turning on the rule. If the result is uncertain, use **Check result** on the original task in Tasks. This reads the saved result without running the rule again.

## Team: confirm the proposed behavior in the earlier editor

A current project admin can choose **More → Open earlier Team work** in Shared Studio to continue an earlier draft or discussion. Start new work in Shared Studio. Check the proposal's scope, people and outcomes, including defaults like a fixed task title. If the assistant proposes dropping an unsupported part, agree to the narrower request before confirming. Daymark builds the checks from the proposed outcomes. **Confirm this behavior** saves and checks the exact draft without another provider request. If Daymark says it saved no draft, send a fresh request. If the reply is unconfirmed, use **Check saved state** instead of confirming again. In Shared Studio, these buttons are **Confirm and check** and **Read saved state**. A saved draft that fails the checks cannot be approved. Discussion can incur provider charges. Approval and turning on are separate, explicit choices.

## Update the task just saved or completed

In Shared Studio, try: “When I complete a task tagged intake, set its priority to high, clear its due date, and add ready.” In Personal and Team, an after-save or after-completion rule can change priority, set or clear the due date, and add one tag in a single update to the task that triggered it. It leaves other fields alone. It cannot edit a different task or also create a follow-up in the same step. Later edits take precedence. An after-save rule also skips the update if the task has since been completed.

In Personal, you can make the update depend on whether an exact, case-sensitive title is open in a specific Personal project you own. For example, add “only if Dispatch is open in the Index project.” Only the task that triggered the rule can change, even when it belongs to the lookup project. Check the lookup project label in the proposal and review both the match and miss examples. If project names repeat, open **Rule details** to check their exact IDs. If Daymark cannot verify the lookup, it makes no update. Team rules can only check their own project.

After saving or completing a Personal task, a rule can read one existing task by ID in a Personal project you own, check one exact open title in a separately chosen owned Personal project, or combine both checks. Use the result to update only the triggering task or create one unlinked, unassigned task in an owned Personal project. Each event can do one of those actions. Check the reference task and project labels in the proposal. Open **Rule details** for exact task IDs and to tell apart projects with matching names. If a required read cannot be verified, the original save or completion stands and the rule makes no change.

Review the **After save** or **After completion** examples and choose **Confirm and check**. Approve the checked draft before turning it on. If the result is uncertain, open the original task in Tasks and choose **Check result** in Personal or **Check again** in Team. These actions read the saved result without running the rule again.

In a Personal **Before save** rule, you can check one exact task ID in a Personal project you own, one case-sensitive open title in a chosen owned Personal project, or both. The rule makes no task changes. If Daymark cannot verify a required read, it does not save the new task.

The isolated Team review fixture uses scripted replies for linked review and high-priority triage. It exercises the real compiler, isolated native checks and task lifecycle. It does not qualify live interpretation, provider quality or arbitrary requests.

In the earlier Team editor, Daymark supplies the source language, program name, model pin, and hook from the host. The assistant supplies the rule steps, return value, and independent business outcomes. Daymark validates call steps and converts an unambiguous nested `call` into a capability name with separate `args`. It rejects conflicting forms before confirmation. For a declared requirement to wait until the linked review is done, it checks that both a missing and an open review block completion. An explicit exception is a different rule. Older full-source offers still work if their hook matches; Daymark replaces only the declared program metadata and rejects extra top-level fields. This does not rewrite saved rules.

## Configure a provider

In the local app, open **Configure** and choose a supported provider and model. Enter its API key. To cap Daymark spending, enter a positive USD amount with up to six decimal places. Leave the allowance blank to use AI without a Daymark spending cap. Saving checks the values locally and sends no provider request. Every save requires the full key.

| `KEIR_AI_PROVIDER` | `KEIR_AI_MODEL` | Required key |
| --- | --- | --- |
| `openai` | `gpt-5.6-terra` | `OPENAI_API_KEY` |
| `anthropic` | `claude-haiku-5-5` | `ANTHROPIC_API_KEY` |

The saved settings file is `ai-authoring.json` in the app's chosen data directory (by default `.data/`). It is ignored by Git. Keep the data directory private and out of public assets, shared backups, and exports. The file contains the key in plaintext protected by the local OS account and directory permissions; it is not encrypted. POSIX creation uses mode `0600` where applicable; Windows uses the directory's inherited ACL. Configuration is shared across all three local demo people and is not production administrator authentication.

The allowance is shared across Personal and Team authoring for all demo users. Daymark holds enough for a maximum-size request before sending it and releases only the excess after verified usage arrives. A cap must cover estimated spend plus any outstanding holds. Provider charges still apply with or without a Daymark cap. Leave `KEIR_AI_MAX_USD` unset or blank for no cap when using environment configuration. Keep keys out of browser code, chat, screenshots, logs and public files.

**Personal.** The provider can receive your authoring text, bounded recent conversation, the edited rule and its supported host contract. Tools can send project names and IDs, owned customization metadata and exact-version behavior or synthetic check summaries, or a bounded page of tasks from one owned project. Task results include titles, status, tags, priority, dates and whether notes exist. Shared Studio requires the message's notes opt-in for excerpts. The earlier Personal editor can request excerpts when needed. Excerpts are limited to 256 Unicode code points and marked when shortened. Pages and partial summaries do not establish a pattern across all your tasks.

**Team.** Daymark sends the scoped Team catalog with the provider request. It can include the shared project's name, its current members' names and IDs, the supported model and proposal format, what is in use, and the saved proposal's source, business outcomes and summary. Daymark does not send the native test scripts or evidence in the Team conversation. The conversation has no live task-list tool. Daymark checks current admin access for the project.

Each new message starts a fresh provider turn with a bounded transcript of the authorized discussion and settled results. Daymark does not replay earlier tool calls or pass private provider reasoning from an earlier turn. The assistant can explain, ask questions, and propose changes. It cannot confirm, approve, or turn anything on. The spending allowance and request limits still apply.

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
