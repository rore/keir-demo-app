# Extension Studio: conversation and canvas

Status: revised interaction proposal for user review. The user rejected the first staged prototype: chat is the main interaction, and a canvas supports the agent as it works. Earlier wizard screenshots and tests do not establish acceptance of this design.

Run `node docs/extension-studio/serve.mjs` from the repository root and open `http://localhost:4179/`. No dependencies, Python or AI key are needed for this scripted prototype. Stop its task-owned loopback server with Ctrl+C. It serves only the HTML and state module; opening HTML directly may fail because it uses browser modules. `PORT` may select another available port without persistent environment changes.

The [core design feature](https://github.com/rore/keir-core/blob/main/roadmap/features/extension-studio-design.md) owns progress; core record `agent-workflow:extension-studio-prototype` owns this contribution. Full live authoring, provider integration and native guarantees remain future implementation.

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
- Give the canvas enough space to explain behavior and compare examples. Its heading states what is being shown and which draft/revision it belongs to; selection status remains visible without becoming a progress stepper.
- Use warm off-white surfaces, forest-green actions, dark ink, restrained rust warnings, fine borders and editorial headings. Share a vocabulary with the native task app, not an early production component API.
- Use labeled controls, visible keyboard focus, text status as well as color and clear action consequences. On narrow screens stack the conversation and latest canvas with obvious labels; do not hide conversation behind a required stage tab.
- Keep technical IR/artifact details in optional inspection. Business users should understand conditions, effects, expectations and consequences without reading implementation details.

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

Start from Reset. Send the suggested completion-follow-up request, discuss the choices, and inspect the behavior canvas. Ask Show me some scenarios, then Test it. Ask for a mismatch and decide how to resolve it; the canvas expectation selector also sends a visible user input to the chat.

Ask Review this revision. Confirm the current behavior and expectations on the canvas, approve, then separately activate the prototype revision. Ask Try a completed task and Explore a lost response to inspect illustrative outcomes. Ask Show the behavior, change the title using quotes, retest/review and activate a second revision, then ask to roll back or disable it. Switch users and resume each conversation independently.

Everything is scripted. The small route set supports one representative pattern, not arbitrary natural-language interpretation. Suggested prompts expose that limitation. The real agent must clarify a visitor's actual request through host-owned tools rather than rely on these routes. No provider, compiler, real approval or native task mutation runs here.

## What needs detailed design next

- Clarification turns, interruptions and alternatives: how the agent checks its understanding and makes assumptions visible without over-questioning.
- Canvas update/continuity: preserve useful views, refer to earlier evidence and show revision changes without distracting redraws. Historic references must open correctly identified snapshots, not silently show latest data.
- Progress/cancellation/provider errors: use actual operation states, keep chat usable and explain what can still finish. The prototype's immediate scripted transitions are not this implementation.
- Recovery and persistence: durable conversations/drafts, reload during an operation, retrying safe authoring operations and preserving independent scenario expectations.
- Exact approval interaction: resolve how conversational requests and explicit canvas confirmations identify the precise current proposal, especially after intervening edits or user switches.
- User review of the actual conversation/canvas layout, density, mobile presentation, control feedback and before/after task evidence. This proposal remains unapproved until that review.

## Verification and production seams

`node --test docs/extension-studio/studio.test.mjs` checks the bounded prototype model, including continuous chat/canvas state, user scope, approval prerequisites, edit invalidation, mismatch recovery, rollback, provider absence and uncertainty; it also checks the allowlisted local launcher. Inspect actual browser behavior and desktop/narrow layouts, not only source or screenshots. Previous staged-prototype checks remain historical evidence only.

Production host services own scoped discovery, compilation, simulation, immutable evidence/approval, selection, revocation and native outcomes. The agent uses bounded authoring tools; a canvas renderer does not add new runtime capabilities. The complete demo uses operator-supplied server-side provider/model credentials and qualified multi-provider support. Real acceptance also requires native persistence/isolation, exact core artifacts, fast regression/UI journeys and separate opt-in live-provider checks.
