# Extension Studio: conversation and canvas

## Current functional Daymark experience

Daymark is the task app; Keir is secondary powered-by attribution. Persistent Tasks and Customizations destinations share the owner context, sans-serif controls, mineral backgrounds and blue-black actions. The Customizations overview exposes one real Task advice item, not an invented gallery. It distinguishes server-confirmed selection (In use, Off, Unavailable) from the current draft or approved choice awaiting use. These prepared read-only alternatives apply across the owner's projects.

Studio is a destination in that shell, identified by Customizations / Task advice and a workspace bar. Its white conversation asks how an open task should appear; the ivory sheet on slate compares Current advice (In use, Off or Unavailable) with a proposed value marked in ochre and text. Contextual Advice, Sample results and Review views retain exact server evidence. Explicit approval and subsequent Use remain separate. Saved runs, provenance, technical details, reload and eligible recovery are grouped under Details and recovery. Off or unavailable selection never invents a current Done result.

The signed-in shell is bounded to the viewport. Project navigation, main tasks/overview, conversation and canvas own their scroll regions; rail, owner controls and composer stay outside unrelated scrolling. Narrow or short screens expose Conversation / Preview rather than stacking two long panes. Pane positions, unsent messages and native quick-add/project drafts survive view changes. A quiet Manage task advice shortcut suspends the native dialog, retains title/notes, and returns to its exact invoking control; general entry returns to overview. Owner changes discard prior-owner state and pending responses. New replies preserve earlier reading position.

This is a real manual lifecycle using existing compiled rules and actual simulator results. AI authoring, arbitrary source, multiple active advice rules and task effects remain unavailable. The sections below describe the earlier scripted future-authoring reference; they do not expand implemented capabilities. Delivery and rendered review evidence belongs to the core-owned `agent-workflow:demo-customization-experience` record.

## Earlier prototype reference

Working design baseline: the user accepted the revised chat-led, resizable canvas as a good starting point. Refine visuals and interactions as real functionality lands; no further standalone prototype pass is requested. This accepts the direction, not a finished production interaction contract.

Run `node docs/extension-studio/serve.mjs` from the repository root and open `http://localhost:4179/`. No dependencies, Python or AI key are needed for this scripted prototype. Stop its task-owned loopback server with Ctrl+C. It serves only the HTML and state module; opening HTML directly may fail because it uses browser modules. `PORT` may select another available port without persistent environment changes.

The [core design feature](https://github.com/rore/keir-core/blob/main/roadmap/features/extension-studio-design.md) owns progress. Core record `agent-workflow:extension-studio-preview-clarity` tracks this revision to the business-user proposal. The prototype uses scripted conversation and sample tasks.

## Business-user design direction

The user is changing how their work gets done. Assume knowledge of their work and no software knowledge. The agent leads the conversation, handles the technical authoring/checking process and asks the person only for missing intent or a meaningful decision. The canvas supports that conversation with familiar application objects and concrete outcomes. A polished appearance alone does not meet this requirement.

Read the [customer extension assistant guide](https://github.com/rore/keir-core/blob/main/docs/agents/extension-assistant.md) before designing the interaction. Its discovery, authoring, bounded repair, simulation and approval responsibilities belong behind the customer experience. The [host integration assistant](https://github.com/rore/keir-core/blob/main/docs/agents/host-integration-assistant.md) serves developers; its vocabulary and configuration tasks must not leak into Studio. Historical authoring diagrams explain the internal pipeline, not a mandatory user journey.

- Lead with a useful question about the person's work. Do not require them to know the next technical step, write a complete prompt or choose from a workflow dashboard. Ask one focused question when its answer matters; let them change their mind in the same conversation.
- Use the canvas when showing something is easier than describing it: a familiar task before and after, a choice between concrete outcomes, a short example or a summary of what will change. A flowchart is useful only when it improves understanding. Do not make the person operate a technical editor alongside the agent.
- Show the proposed effect, who it affects and what remains unchanged. Explain exceptions through recognizable situations, such as a task from another project or a task that no longer exists.
- Keep exact versions, evidence identities, compiler diagnostics and execution traces in secondary inspection. Their protections remain enforced even when their identifiers are absent from the main screen.
- Use clear, respectful everyday language. Avoid engineering nouns, lengthy explanatory paragraphs and arbitrary status badges. Simplify the question before adding help text. Preserve distinctions between a preview, a change currently in use and a result that actually happened.
- The agent proposes examples, checks the change and explains discrepancies. The person decides what should happen; the agent must not quietly change those expectations to make a check pass. Approval and turning on the change remain separate human decisions with understandable consequences.
- Make failure useful: explain what happened, what is still safe and the next available action. For an uncertain result, say that the task may have been created and must be checked before trying again. Never turn uncertainty into success merely to simplify the wording.

### Translate decisions, not just labels

The following are proposed customer-facing expressions, not changes to the underlying lifecycle contract.

| Internal concept | What the person should see or hear |
| --- | --- |
| Define trigger and scope | “Should this happen only for tasks in Launch?” |
| Proposed behavior | A familiar completed task next to the follow-up that would be added: “When you finish a task in Launch, add ‘Review completion’.” |
| Simulation | “Let's try a few examples without changing your tasks.” |
| Scenario expectation | “If you finish a task in Operations, should anything happen?” |
| Mismatch | “You wanted a follow-up here, but this change would leave the task list as it is. Which result do you want?” |
| Draft versus active revision | “Your current setup is still on. These changes aren't in use yet.” |
| Historical evidence | “Earlier example” with the original task and result; opening it does not apply it to the current proposal. |
| Exact review | “Here's what will change” with the effect, affected people/projects, exceptions and any unchecked situations. |
| Approval, then activation | “This is what I want,” followed by the separate decision “Turn this on.” |
| Unsupported request | “The app can't do that yet,” followed by a supported alternative only if it preserves a useful part of the person's goal. |

A representative exchange starts with “When I finish a task in Launch, add a task to review it.” The agent asks about any missing choice, then shows a recognizable task and its proposed follow-up. It asks whether a task in another project should behave differently, works through the answer, and explains the checked examples. The final decision summarizes the effect in the same language used in the original request. The person can inspect, correct or ask why throughout; these are conversational turns, not compulsory stages.

### Visual research and application

Use outside work to understand design decisions, not to reproduce another product's composition, branding or components. Develop Keir's visual direction around this audience and its task objects. Polish must include legibility, spacing, consistent controls, clear focus, responsive behavior, restrained motion and useful error/recovery states. No decorative AI motif, oversized introductory hero or generic collection of dashboard cards is justified by this task.

- [Linear's interface refresh](https://linear.app/now/behind-the-latest-design-refresh): study how supporting navigation recedes and how unnecessary icons/separators are reduced. Apply the principle of attention hierarchy; do not copy Linear's interface.
- [Apple's UI typography guidance](https://developer.apple.com/videos/play/wwdc2020/10175/): use type hierarchy, alignment and legibility to organize the work. Do not rely on oversized headings or tiny secondary text to manufacture contrast.
- [NN/g on progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/): keep commonly needed decisions visible and less-used detail available on request. This is not a reason to bring back a staged wizard.
- [DWP guidance on hint text](https://design-system.dwp.gov.uk/guidance/hint-text) and [Microsoft's guidance on user control](https://fluent2.microsoft.design/responsible-AI): improve the question itself, make actions understandable and let people correct the agent.

Acceptance for the next prototype: a person without technical knowledge can explain what will change, recognize who is affected, correct an example, tell whether it is currently in use and stop or revise it. They should not need to learn Keir terminology or ask which engineering step comes next. Test this through an actual interaction, not a screenshot alone.

The conversation opens on the current question. Earlier turns and their saved previews are available under Earlier messages. A single header identifies Studio and the sample user. The canvas shows a completed task and the follow-up it would add together on one task sheet. Example results state what happened, and expanding a result reveals what the user wanted.

The agent asks about project scope and offers ordinary replies: “Only Launch,” “Try a few examples” and “Change the task title.” Examples compare “You wanted” with “In this example.” “This is what I want” confirms the exact reviewed change; “Turn this on” remains a separate action. Chat requests cannot bypass those controls. Requests for all projects explain the one-project prototype limit without silently changing intent.

The current setup and proposed changes remain visibly distinct. Earlier examples preserve their original contents, unsent preview fields survive arriving results, and pause/continue retains the conversation. Narrow screens stack chat and preview with direct links between them. This is a design proposal ready for interaction review, not evidence of user acceptance or a live agent implementation.

## The interaction model

**The user talks to an agent. The agent uses a canvas when UI helps the conversation.** The conversation stays continuous: explain a goal, answer a clarification, ask why, change a choice, explore examples, inspect outcomes and decide what to activate. The canvas is not a separate workflow to navigate or a sequence the user must complete.

The agent selects a useful application-owned view for the current question: a behavior sketch, clarification controls, scenario editor, expected/observed comparison, trace, revision comparison or review card. Some questions need only a chat answer. Do not redraw or fill the canvas merely because another message arrived.

Canvas interactions are also user inputs. Changing a project, editing an expectation or confirming a revision produces a visible receipt in the conversation, followed by the agent's explanation or next question. Chat and canvas operate on the same scoped draft/evidence; neither has a hidden second version of the customization.

The agent controls presentation, not authority. Application-owned components render typed, validated content; a model does not execute arbitrary generated UI/code, bypass scope, rewrite expected outcomes or self-approve. The host still enforces exact compilation, simulation, human approval and activation boundaries.

## Representative conversation

1. Maya describes a task-completion follow-up in chat. The agent clarifies the project and new task title, bringing a behavior sketch and useful choice controls onto the canvas.
2. Maya answers in chat or changes the canvas choices. Her input is reflected in the conversation; the sketch updates while previous discussion remains visible.
3. Maya asks for examples. The agent presents editable scenario expectations. She can ask why a case matters, add/change an expectation or ask to run the examples without leaving the conversation.
4. The agent shows the comparison on the canvas and explains the results in chat. If a scenario disagrees with the draft, they discuss whether intent, behavior or expectation needs changing. The agent does not silently fix the oracle.
5. Maya asks to review. The agent brings the current revision and its evidence onto the canvas. Human approval and activation are explicit separate decisions, recorded back into chat. A request to activate never lets the model approve on her behalf.
6. After activation, the conversation can bring actual task-app evidence onto the canvas. They can inspect an outcome, discuss an uncertain write, revise a draft, disable it or restore a previous selection. Earlier effects are not undone by changing selection.

These are example exchanges, not mandatory navigation stages. A user can ask to revisit the diagram, compare alternatives or inspect a scenario at any point; current evidence gates control consequential actions.

## Example semantics and ownership

The scripted pattern is: when a task is completed in Launch, create a task titled Review completion. The host supplies event facts, protected user scope and generic `tasks.get`/`tasks.create`; the extension owns the project/title and conditional logic. Another project causes no change; a missing source causes business rejection without a write. No special follow-up capability or customer-specific hook input is introduced.

Leo's initial draft instead uses Operations and Plan next step. Sam has no selected customization. The prototype retains separate conversation, draft and selection per example user in tab-local session storage. That illustrates the desired experience, not implemented identity isolation. Real effects still need separately qualified core/native admission evidence; simulation alone cannot certify them.

## Layout and visual direction

- Keep a substantial conversation pane with persistent composer, readable agent/user turns and contextual suggested prompts. The chat is the starting point and remains available while canvas content changes.
- Give the canvas enough space to explain behavior and compare examples. Its heading states what is being shown; the current setup and proposed change stay distinct. Technical identities are available in optional detail.
- Use a charcoal app frame, a white conversation, and an ivory task sheet on a slate-grey work surface. Reserve oxblood for actions and mustard for the proposed new task. Text labels and task marks convey the same meaning as color.
- On desktop, drag the divider to set the conversation width. Keyboard users can focus the separator, adjust with the left and right arrows, or jump to a limit with Home or End. Each pane retains at least 320 pixels. This tab remembers the width after refresh. At 820 pixels and below, the conversation and preview stack with links between them.
- Keep technical IR/artifact details in optional inspection. Business users should understand conditions, effects, expectations and consequences without reading implementation details.

## Working-experience proposal

Two assumptions are deliberately open for user review: keep one continuing conversation per named customization; let the canvas follow new evidence while idle and offer new evidence while someone is inspecting or editing. These are runnable design choices, not accepted requirements.

The prototype opens on Maya's existing completion follow-up. Active r1 creates **Review completion**; draft r2 proposes **Prepare next step**. The conversation is populated with fictional earlier work and a current scope clarification. Leo has an Operations example; Sam demonstrates first use. Seeded approvals and activity are sample history, not actions by the visitor.

| Surface or state | Proposed behavior |
| --- | --- |
| Persistent identity | Header names the customization, example user and project. Current setup and changes not yet in use remain visible while either pane scrolls. |
| Conversation receipt | Behavior, scenario and review messages have evidence buttons. A button opens its saved draft, expectation, result and selection snapshot, not whatever is latest. |
| Inspecting old evidence | Saved evidence is marked read-only. Earlier results cannot approve or activate the current draft. Return to the current proposal explicitly. |
| Canvas attention | Keep this view pins its example. Focusing an editable canvas field also holds it, preserving unsent values. A new result appears as an offer; Show latest or Follow chat changes the view. Sending canvas choices intentionally updates the draft and returns to its current view. |
| Scenario mismatch | The default r2 example expects a task in another project, while behavior only applies to Launch. User explicitly chooses no change or discusses different behavior. The correction appears in chat; the script never silently repairs the expectation. |
| Exact review | Show change from active, trigger, owner, reads/writes, scenario evidence and remaining limits. Human approval and activation are separate controls. A stale review cannot apply to a changed proposal. |
| Running / paused | Try a few examples takes a short scripted delay. Pause retains changes and earlier examples. Continue starts a new operation identity; completion from the paused run is ignored. |
| Reload during work | Running work becomes interrupted. Continue is explicit; no background side effects resume. Changed drafts supersede the old run. Results cannot cross example users. |
| Narrow layout | Conversation and canvas stack, with direct links between them; the composer remains part of the conversation. No stage navigation is introduced. |

This increment uses tab-local example storage, under a new key that leaves the earlier prototype's data intact. It demonstrates recovery of submitted work and paused operations; it does not provide durable server history, cross-device sync or production cancellation. Unsubmitted composer and canvas text is not durable across reloads. A production design must distinguish cancellation requested from confirmed stop and reconcile operations that may have completed externally.

## Canvas and conversation contracts

| Context | Canvas contribution | Conversation and state rules |
| --- | --- | --- |
| Initial request | Calm empty canvas or a relevant starting illustration | Invite the user's goal in chat; no preconfigured rule is presented as already understood or active. |
| Clarification | Choice/form only when it improves the question | Both chat answers and canvas edits enter the same conversation. Explain proposed assumptions before accepting them. |
| Proposed behavior | Trigger/condition/action sketch and boundaries | Preserve original intent alongside the current proposal; explain unsupported requirements rather than quietly narrowing them. |
| Scenario design | Inputs and independently reviewed expectations | Canvas edits are explicit user changes, never an agent's silent rewrite of expected results. |
| Simulation result | Expected/observed comparison, mismatch detail or trace | Explain findings in chat; retain the evidence's exact draft/scenario identity. Simulation is not an actual mutation or proof of native guarantees. |
| Draft revision | Current behavior or difference from active revision | Edits invalidate affected validation/tests/approval, not the active snapshot. Old conversation references must not imply old evidence applies to the new revision. |
| Review request | Exact-revision evidence and human confirmation controls | Agent may request review; human actions bind the host-selected exact identity. Approval alone is not activation. |
| Outcome discussion | Actual native result, trace or explicitly illustrative prototype feed | Distinguish completed, no-op, business rejection, failed, limited and uncertain outcomes. Unknown effect is not safe to retry blindly. |
| Disable/rollback | Selected version and future-admission consequences | Preserve prior effects and admitted snapshots; neither operation undoes earlier changes. |
| Provider setup/failure | Configuration help or recoverable error when useful | Never ask for secrets in chat. Keep credentials server-side; preserve drafts/history while setup or budget problems are resolved. |
| Interrupted work | Last valid draft/evidence and pending-operation status | Explain what stopped versus what may still have completed. Retain conversation and avoid silently resuming side effects. |
| User switch | New user's own conversation/canvas/selection | Clear drafts in the composer; host enforces scope and rejects stale results. Do not reuse another customer's conversation or approval. |

## Prototype review tour

Start from **Restart example**. Read the current clarification and inspect the behavior: active r1 and draft r2 are distinct. Use the project/title controls to send an explicit choice to chat, or describe a change there. Choose **Run scenarios**, then **Pause run** and **Resume run** to inspect interruption without losing the active version.

The scripted result contains an other-project mismatch. Choose **Expect no change in other projects**; inspect the explicit correction in chat and the new matching results. Ask **Review this revision**. Review the change, scope, evidence and limits, check both confirmations, approve, then separately activate the prototype revision.

Reopen an earlier evidence receipt in the conversation. Its revision and result remain intact. Hold that view and ask for a new result; the canvas offers it without replacing what you are reading. To test unsent edits, edit a canvas title while a run is pending; the arriving result leaves the field value intact until you deliberately switch views or submit it.

After activation, choose **Edit a new draft**: the selected version stays active. Ask **Try a completed task** or **Explore a lost response** for illustrative outcomes, or **Disable it** / **Roll back** for selection changes. Switch to Leo and Sam to inspect separate sample conversations and first use. Reload while a run is in progress to see the interrupted state and explicit resume.

Everything is scripted. The small route set supports one representative pattern, not arbitrary natural-language interpretation. Suggested prompts expose that limitation. The real agent must clarify a visitor's actual request through host-owned tools rather than rely on these routes. No provider, compiler, real approval or native task mutation runs here.

## What needs detailed design next

- Clarification turns, interruptions and alternatives: how the agent checks its understanding and makes assumptions visible without over-questioning.
- User decisions on the proposed conversation lifetime, held-canvas behavior, density and visual direction; the runnable proposal does not settle those questions.
- Production progress/cancellation/provider errors: use actual host operation states, explain what can still finish, and distinguish late external completion from a confirmed stop. The prototype only delays a scripted result.
- Recovery and persistence: durable conversations/drafts across devices, unsent text recovery, host reconciliation after reload, retrying safe authoring operations and preserving independent scenario expectations.
- Exact approval interaction: resolve how conversational requests and explicit canvas confirmations identify the precise current proposal, especially after intervening edits or user switches.
- Refine density, palette, adjustable layout, mobile presentation and task evidence alongside each real workflow, using user feedback on that functionality.

## Verification and production seams

`node --test docs/extension-studio/studio.test.mjs` checks the bounded prototype model, including continuous chat/canvas state, user scope, approval prerequisites, edit invalidation, mismatch recovery, rollback, provider absence and uncertainty; it also checks the allowlisted local launcher. Inspect actual browser behavior and desktop/narrow layouts, not only source or screenshots. Previous staged-prototype checks remain historical evidence only.

Production host services own scoped discovery, compilation, simulation, immutable evidence/approval, selection, revocation and native outcomes. The agent uses bounded authoring tools; a canvas renderer does not add new runtime capabilities. The complete demo uses operator-supplied server-side provider/model credentials and qualified multi-provider support. Real acceptance also requires native persistence/isolation, exact core artifacts, fast regression/UI journeys and separate opt-in live-provider checks.
