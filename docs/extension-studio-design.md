# Extension Studio: conversation and canvas

## Product direction

Daymark is a task app with customization as a normal workspace destination. Use the stacked host identity **Daymark** with **A KEIR Demo** immediately below it. A person can open **Customizations** to see their saved setups, start a new change, or return to review and manage an existing one.

**Product direction.** A business user develops a customization through an agent that carries the application context and guides the process in everyday language. The earlier single-item interaction and [guided-example proposal](studio-guided-example.md) are historical. The working design below defines how a person creates and keeps distinct customizations.

## Interaction requirements after the reset

- The customer describes what they want, answers necessary business questions and judges concrete outcomes. The agent knows the scoped application context, available capabilities and process; it explains what is possible and what to do next. Do not ask the customer to operate discovery, compilation or simulation tools.
- Keep one ordinary conversation and a contextual canvas. The canvas shows a recognizable application object, a proposed effect or a useful example when needed. It supports the conversation; it is not a permanent results dashboard or a second workflow to manage.
- Explain checking in everyday language: “Let's try a few examples without changing your tasks, to check this does what you want.” Introduce each relevant situation and explain why it matters. Ask about expected outcomes where intent is unclear, then compare them with actual observations. Cover when the customization should act and when it should do nothing; never silently change expectations to make a check pass.
- The agent handles authoring, bounded repair and check orchestration. No Start/Try/Review carousel, technical stage navigation or toolbar of pipeline operations. Failures and mismatches lead to a brief explanation and a meaningful choice, not an unexplained technical status.
- Summarize the exact checked behavior for explicit human approval and a separate decision to turn it on. Keep these protections without requiring customers to learn revisions, artifacts or evidence identifiers. A changed proposal requires the applicable renewed review.
- Apply the same interaction to live AI and one clearly labeled scripted example. Do not ask for secrets in chat or imply that scripted replies are generated. Preserve existing customizations and unsaved work. Unsupported actions remain honestly unavailable; illustrative task creation is not implemented native execution.

Keep the [customer assistant guidance](https://github.com/rore/keir-core/blob/main/docs/agents/extension-assistant.md) aligned with the implemented conversation and tool behavior.

## Working design for creating and editing extensions

This is the target for the next application slice. The user-facing name is **Customizations**. Each saved customization belongs to one person and has its own conversation, proposed changes, checked examples and history. Maya can create B while A is in use, leave, and open either by name. A customization keeps its identity when its wording, draft or active version changes. Two items can have similar names.

### Where Maya starts

| Surface | What Maya sees | What her action means |
| --- | --- | --- |
| **Customizations** | A heading, **New customization**, then one row per saved item. Each row has a recognizable name and one line about its current state, such as *In use*, *Draft*, or *In use · Changes in progress*. Empty copy: “Your customizations will appear here.” | **New customization** always opens a blank conversation. Selecting a row opens only that item. While loading, show “Loading your customizations…”. If loading fails, offer **Try again**. An unsuccessful read cannot establish an empty collection. |
| **New customization** | A slim header with **Back to customizations**, the question “What would you like to change about your work?”, and a focused message field. At most one secondary **Try a guided example**. | Opening, typing and leaving an untouched start never adds an item or calls the assistant. The first accepted request creates one owner-scoped item and conversation. Give it a short name grounded in the request, with a neutral fallback. Subsequent turns and retries stay with it. A blank start must never hydrate the last chat. |
| **A saved customization** | The item’s name identifies the conversation. When active, summarize what it does today. If different changes exist, identify them separately. A quiet **History** entry holds earlier checks, approvals and changes in use. | **Edit** starts changes to the same item using its current behavior as context. **Continue changes** resumes its exact saved draft and discussion. Opening either view is read-only. Editing or approving A leaves the active version working until Maya turns on the exact reviewed change. |
| **A checked proposal** | The latest exchange summarizes the behavior, affected person and where it will appear. **See examples** opens the optional canvas. It pairs the expected and observed outcome for a recognizable situation. | Maya can correct the request in chat or **Approve this change**. Approval belongs only to the checked item, draft and evidence. Once approved, show the separate **Turn on** decision. Older examples open as history with no activation control for a different or stale draft. |

Keep the existing Daymark shell, readable transcript and resizable desktop divider. Give the current decision one location. With the canvas closed, the conversation must answer “What happens next?” on its own. On a phone, opening an example takes the available workspace and **Back to conversation** restores the invoking turn and focus. A short window must show the current decision and its action together. Entering Studio from a task carries its saved context and a return destination. Preserve unsaved task fields through the round trip.

Name a collection row for the person’s goal, for example *Flag unfinished work*. Put what runs today before pending work: “In use · Changes in progress” means an earlier version still runs. “Approved · Ready to turn on” means the reviewed change is saved and awaits a decision. “Off” keeps a previously used item available to open again. When current behavior cannot be verified, say “Couldn’t check what’s in use” and offer a read-only retry. Names and badges never identify the backing item.

### From a request to a decision

- **Discover the intent.** If Maya says “Help me notice work that needs attention,” use the available app context and ask the one question that changes the behavior, for example “What makes a task need attention for you?” The assistant discovers what this host can actually do. Only after Maya asks about checking an unfinished task should Studio explain where task advice appears. A guided example is labeled as scripted, keeps personal text separate, and never borrows or overwrites an unrelated saved item.
- **Explain a limit where it matters.** For “Create a review task when I finish the packaging sketches,” say “Daymark can’t create a follow-up task from here yet.” If relevant, offer “I can change the advice you see when you check a task. Would that help?” Wait for her answer. An unsupported request can remain a conversation with no executable proposal, approval or activation.
- **Check the behavior.** Use Maya’s answer to state what should happen *before* checking. For example, “I’ll try an unfinished task and a completed one. You asked for ‘Needs attention’ on the unfinished one and ‘Done’ on the completed one.” If the completed sample shows Pending, name the disagreement and retain the original expectation through repair. Only confirmed observations support approval. Show technical details on demand.
- **Explain the one-active limitation at the decision.** Multiple saved customizations can use task advice. Only one can supply that advice for a person at a time. When B is ready and A is in use, name both before activation: “Use ‘Flag unfinished work’ for task advice? ‘My usual advice’ will turn off and stay saved.” Primary action **Switch to Flag unfinished work**. Leaving keeps A in use and B approved. For an edit of A, say “Turn on these changes to ‘My usual advice’?” Once confirmed, show which item is on and a direct route to see its effect. No implicit activation on Send, approval or return.
- **Avoid replacing work by surprise.** A second tab may have changed this item or which advice is on. Withhold the stale action, preserve Maya’s unsent text, read the latest state and say what changed. If the item that would be turned off has changed, name it and obtain a fresh explicit switch decision. An old confirmation never authorizes a new replacement.
- **Edit when there are already saved changes.** Open A by identity and show the two behaviors. For example, “In use: unfinished tasks show ‘Pending’. Your saved changes would show ‘Needs attention’.” **Continue saved changes** reopens that draft and its conversation. **View what’s in use** opens the active version read-only. Neither choice creates or replaces a draft. For a separate idea, **New customization** remains available in the collection. This design needs one editable draft per item.
- **Start from the version in use.** In the active view, **Start changes from this version** explains the consequence: “You’ll start with ‘Pending’. Your unfinished ‘Needs attention’ changes and their discussion will stay in History. Your tasks will keep using ‘Pending’.” Offer **Start from this version** and **Cancel**. On confirmation, verify the owner and item, the displayed active revision and selection generation, and the expected draft version together. Only a match creates the new editable draft from the active version within A. Keep the previous draft, its discussion and its checked examples readable in History. The new draft needs its own checks and approval. Cancel or a stale confirmation writes nothing.

### Typing, leaving and coming back

**Enter** sends one nonblank message from the composer. **Shift+Enter** inserts a newline. During input-method composition, Enter commits the character or candidate without sending the message. Keep a labeled **Send** button for touch and keyboard use. Repeated keys, a slow response or a double-click cannot submit a second turn. Keep unsent text when sending is temporarily unavailable. In the guided example, hide the personal composer and its setup prompt, then restore its text on return.

On reload, reopen the named saved item and reconcile accepted messages, draft, checked evidence, approval and active choice from the server. Reloading a blank start stays blank. If the first send loses its response, check whether that request already created an item before offering retry. If the outcome is still unknown, say so and keep the same request identity. Never create a second item, repeat a paid turn or activate by replaying it. If the assistant stops after saving partial work, show what is actually saved and offer **Continue from saved work** only when it can safely continue. If another item is explicitly requested but unavailable, return to the collection with an explanation. Never substitute the owner’s most recent conversation.

A person switch clears the visible item, transcript, canvas, task context and pending decisions before loading the next person. Late responses cannot repopulate the new view. Returning to the original person loads only their saved work. Earlier single-item data must remain accessible to its original owner, with its active choice and review history intact. Never fabricate an item from an empty state.

If several conversations belong to one item, returning to a specifically opened discussion restores that discussion. Recovery checks the signed-in owner, item, conversation and pending operation together. A read during an ongoing check can report progress without resubmitting the work. An older conversation with a known owner but no proven item link remains readable to that owner in history. It grants no edit, approval or activation action on an item. Never attach it by matching names or timestamps.

### Acceptance journeys for the working app

| Start and action | Observable result to verify |
| --- | --- |
| Fresh owner, empty collection. Open New twice, type without sending, back out. Then send a first request. | No phantom item or reused transcript. Exactly one owned item after accepted send. Its first message is the request actually entered. |
| Existing owner with A in use. Open New, send B, reload, then reopen A and B separately. | B starts empty. Both items remain in the collection with their own names, chats and results. Checking a native task still uses A. |
| With A v1 in use and v2 drafted, continue v2, then inspect v1. Try starting from v1 with Cancel, with a stale confirmation from another tab, and with fresh confirmation. | Continue opens v2 and its conversation. Inspection, Cancel and a stale confirmation write nothing. Fresh confirmation makes a draft based on v1 under A. V1 still runs. V2, its discussion and evidence remain readable in History. Only the new draft’s own checks can support its approval. |
| Approve B and leave. Return, explicitly switch from A to B, then check a native task. | Approval alone leaves A active. The switch names both items. After confirmed activation B is in use, A is still saved and eligible history is accessible. |
| Delay, double-send or drop the first response. Race two tabs editing or switching. Refresh after uncertain activation. | One item and one accepted turn per original request. A stale tab cannot overwrite a newer choice. UI reports confirmed state or uncertainty without silently retrying or switching. |
| Ask for an ambiguous or unavailable behavior. Correct a failing sample. Inspect an older run. | Studio asks about intent, states actual limits, and checks only the agreed behavior. An unsupported request never becomes task advice without consent. Missing, mismatching and historical evidence grant no new approval. |
| Switch from Maya to Sam while B has a pending request. Open Maya’s saved link as Sam. Switch back to Maya, reopen B’s specific conversation during the job and after completion. | Sam never sees Maya’s text or late result. Maya recovers the original accepted operation and its eventual result without resending. Previously saved single-item work and its checked history remain reachable to the original owner. |
| Desktop, phone and short landscape. Type with Enter, Shift+Enter and an input method. Open a sample, return, approve, turn on and go back to an unsaved native task. | Exactly one intentional send, newline and composition preserved. Focus follows the decision. Completion and return are visible together. Native edits survive. |

Use isolated synthetic owners and a deliberately delayed or lost response for these checks. Judge the actual interaction as well as the stored state. A screenshot alone cannot establish which item received a turn or which version ran.

## Historical single-item baseline

Persistent Tasks and Customizations destinations share the owner context, sans-serif controls, mineral backgrounds and blue-black actions. The delivered Customizations overview distinguishes an untouched empty state from saved items and their In use, Off or Unavailable status, and exposes working Task advice discovery, setup/continue draft and open-existing paths. **New customization** starts a nonmutating conversation; description-based creation and its composer remain disabled with a visible accessible **To be implemented** explanation. A selected item's conversation presents choices and consequences inline. A separate status summary distinguishes In use, Off or Unavailable from Proposed and Approved states. Prepared read-only alternatives apply across the owner's projects.

Studio is a destination in that shell, identified by Customizations / Task advice and a workspace bar. The conversation asks how an open task should appear; a separate review panel starts closed and opens only through **View proposal**, **Latest run**, **Approved run** or **Manage**. Closing review returns to the conversation. Simulation reports its actual case count without opening the run view. Approval binds to its exact saved evidence independently of the latest run: a later run does not replace the approved evidence, and only explicit reapproval changes that binding. Explicit approval and subsequent Use remain separate. Saved-run provenance, technical details, reload and eligible recovery are grouped under management. Off or unavailable selection never invents a current Done result.

The signed-in shell is bounded to the viewport. Project navigation, main tasks/overview, conversation and review panel own their scroll regions; rail, owner controls and composer stay outside unrelated scrolling. Wide screens support resizing the workspace; phone-sized screens use a full-workspace view. View changes retain input, reading position and workspace width/focus. A quiet Manage task advice shortcut suspends the native dialog, retains title/notes, and returns to its exact invoking control; general entry returns to overview. Owner changes discard prior-owner state and pending responses. New replies preserve earlier reading position.

The current customer flow uses the task-advice conversation assistant, with existing compiled rules and actual simulator results. AI drafting requires locally configured provider settings; approval and Use remain explicit human actions. The customer app does not expose arbitrary source editing, multiple active advice rules or task effects. Approved evidence readback is tied to the current eligible customer draft's saved approval proof, not whichever run is latest. The sections below describe the earlier scripted future-authoring prototype; they do not expand current capabilities. Current iteration evidence belongs to the core-owned `agent-workflow:studio-on-demand-review` record; delivered design and rendered acceptance remain separate.

## Earlier prototype reference

Working design baseline: the user accepted the revised chat-led, resizable canvas as a good starting point. Refine visuals and interactions as real functionality lands; no further standalone prototype pass is requested. This accepts the direction, not a finished production interaction contract.

Run `node docs/extension-studio/serve.mjs` from the repository root and open `http://localhost:4179/`. No dependencies, Python or AI key are needed for this scripted prototype. Stop its task-owned loopback server with Ctrl+C. It serves only the HTML and state module; opening HTML directly may fail because it uses browser modules. `PORT` may select another available port without persistent environment changes.

The [core design feature](https://github.com/rore/keir-core/blob/main/roadmap/features/extension-studio-design.md) owns progress. Core record `agent-workflow:extension-studio-preview-clarity` tracks the historical scripted prototype. The prototype uses scripted conversation and sample tasks.

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

### Visual decisions

Describe features and designs in Daymark and Keir terms. Keep external product and company names, comparisons and source links in separate research notes.

- Give the current task and the person's next decision the most space. Keep navigation quiet.
- Use readable type, alignment and spacing to distinguish a question, its answer and the proposed change.
- Keep common decisions visible. Put history and technical details within reach when someone needs them.
- Ask one clear question. Let people correct a choice and see how it changes the result.

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
