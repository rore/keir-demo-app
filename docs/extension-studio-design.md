# Customization Studio: understand a change through conversation

## Current direction

The conversation is the workspace. Application-owned explanations, task previews and example results appear inside it when they help the person understand a decision. Do not restore the old split canvas, a permanent decision dashboard, or a technical workflow toolbar.

This specification supersedes the [preserved canvas-era design](historical/extension-studio-canvas-design.md). The [old scripted prototype](extension-studio/README.md) is historical; its files and tests remain intact. Earlier visual passes establish only their recorded scope, not acceptance of the whole experience.

The [business-understanding study](studio-business-understanding/concepts.md) and its [recommendation](studio-business-understanding/recommendation.md) preserve the earlier selection of A: one decision brief inside the conversation, after ordinary clarification. B is historical, not an extra production flow. Later working-application reviews found that accumulated controls and explanations crowded out the conversation. The current correction consolidates that delivered interaction rather than introducing another canvas or wizard.

Keep a compact, persistent strip with the exact saved name and current-use/draft distinction. One Send belongs beside a short input that grows with the message. Questions and suggestions stay discussion; clear requests can prepare the opened draft, and ambiguous intent needs clarification. Do not ask the person to choose a send mode. A suggestion about another customization offers an explicit, identifiable Open action; it never changes the target or repeats the previous request there.

Use one compact proposal card in the conversation. Its collapsed state shows a concise behavior/scope summary, meaningful evidence status and Review. Full behavior, exceptions, examples and limitations expand there before the human decision. The Draft status can return to this same object; do not add another permanent review button or a parallel review workspace. Reading what is currently on uses the same business-readable presentation, explicitly read-only and distinct from the draft.

## What the person is doing

A person describes a change to how Daymark handles their work. The assistant discovers supported capabilities, resolves missing intent, prepares the proposal and checks agreed examples. The person does not operate a compiler, select evidence identifiers, or manage a save pipeline.

A customization is a named behavior with its own continuing conversation. Its proposed behavior, simulation and version currently in use are distinct. Keep that distinction visible in ordinary language, without requiring knowledge of revisions or storage.

- **Conversation:** ask questions, clarify intent, return to earlier messages. Opening it sends no new request.
- **Proposed change:** the exact behavior being considered. Show trigger, all known conditions, effect and what remains unchanged.
- **Simulation:** example tasks showing intended and observed outcomes. Explain “Example tasks; your tasks are unchanged.” They do not change the person's tasks or establish untested behavior.
- **Approved, not on yet:** the person agreed to the checked proposal; actual use has not changed.
- **On:** the exact selected behavior is in use for the named trigger. Later edits do not replace it automatically.
- **Earlier versions:** secondary inspection for understanding changes or starting a new proposal from eligible earlier work. Reading an earlier version changes nothing.

Do not offer a main action called Save history or ask the person to decide what an internal saved run means. Confirmed progress is kept automatically. Unknown results must use truthful recovery wording, never an invented saved indicator. Keep unsent messages as unsent drafts.

## Explain before asking for approval

Explain the proposed behavior and its example outcomes as sections of the same inline review, not competing Summary, simulation and approval destinations. Explain examples as “Example tasks; your tasks are unchanged.” Describe outcomes in task language: “Due date added as intended,” “Existing date kept,” or “No change when details were unavailable—as intended.” A compact evidence status must not replace meaningful outcomes with pass totals. Keep independent “What we wanted” and “What happened” details accessible. “Could not finish the simulation,” “Different from what we wanted,” “Could not confirm whether the task changed,” and “Not covered by this simulation” describe different states and must not be collapsed into success.

Lead with what will happen in recognizable task language. A description is derived from the exact source and verified bindings, not a remembered chat message, generated name, or a handful of passing examples. Unknown conditions remain unknown; they cannot be omitted to make a confident sentence.

Show one concrete before/after task before detailed results. Preserve the actual rule's time meaning, trigger and read-time conditions. Explain whether the value is based on the event time, current time, calendar date or elapsed duration; these are not interchangeable. Use ordinary dates in the preview, and put precise time-zone or daylight-saving explanation beside it when material.

Then distinguish changes as intended, intentional no-changes, an intentionally simulated problem handled as intended, a wrong outcome, an unfinished check and situations not checked. A match total alone is not a decision explanation. Name the simulated problem and actual observed result; do not pair a generic failure headline with an unexplained passing badge.

Keep independent expected results inspectable. A mismatch shows what was wanted and what happened, with a clear correction path. Never rewrite expectations to make a check pass. Approval remains unavailable when required evidence is absent, stale, mismatched or untrustworthy. A known limitation is not silently converted into either success or total failure.

## Decisions and authority

“Approve this change” records agreement to the exact proposal and its checked evidence. Explain that it does not turn the change on. After approval, offer a separate “Turn on” action. Before replacing an existing selection, name the behavior that will stop and the one that will start. Other triggers keep their current selections.

Report confirmed activation separately from a submitted request. Unknown completion is not success; use the existing explicit readback/recovery operation. A changed proposal requires the applicable renewed checks and approval. The assistant cannot approve or activate for the person.

When the person asks a follow-up, keep the composer, reading position and unsent text. A late reply offers new information without replacing the example being read. Earlier evidence stays tied to its original proposal and is visibly read-only when it cannot support the current decision.

Show one host-owned progress or recovery outcome beside the affected exchange. Keep Stop near progress. Distinguish retrying an exact unconfirmed request from starting a fresh continuation; neither happens automatically. Cancellation cannot undo an accepted change. Do not repeat the same outcome as assistant text, a status panel and permanent helper instructions.

## Collection and returning to work

Customizations lists saved names as the primary identity, with trigger/scope, a short verified behavior description, current use and work in progress. Keep full rule paragraphs inside the item. Preserve explicit names; a suggestion never silently renames an item. An exploratory first question must not become the permanent identity of a completed proposal. Duplicate-name opening offers include enough trigger/scope/state context to choose deliberately, rather than relying on the name alone.

Opening an item restores its own discussion. Use “See proposed change,” “What is on now,” and “Earlier versions” only when those destinations exist and have a clear purpose. Keep earlier conversations and version history distinguishable: one explains the discussion; the other explains what behavior changed. Restoring eligible earlier work makes a new proposal and must disclose the effect on current use before an action.

Owner switches never expose another person's messages, draft or late result. Back navigation restores the invoking task or collection control and any retained native task draft. No navigation action silently resends a message or repeats a mutation.

## Responsive and accessible behavior

Keep the normal application frame, sidebar and top bar unchanged when entering or leaving Studio. Bound the Studio content inside the main pane, with its target/status, reading area and composer aligned as one column. Never apply that reading-width limit to the shared application shell. App-owned review stays in the conversation. Before/after task cards may sit side by side at wide widths and stack on a phone. Preserve the same hierarchy on desktop, short windows, mobile and browser zoom: compact exact target/state, one conversation/review scroll region, and a reachable growing composer. Do not leave a sticky generic status while the target name scrolls away. Do not recover space by reducing readable body type or hiding meaningful uncertainty. Rename, history, deliberate disable and technical operations belong under More rather than the main reading surface.

Use semantic headings, field labels, visible keyboard focus and text outcomes that do not depend on color. Expand evidence under a named example, returning focus and reading position when it closes. Approval and activation completion must be perceivable without stealing focus from a newer edit. Test 320-pixel width and short landscape with real content, including long names and uncertainty.

## Design evidence and production boundary

The business-understanding prototypes are scripted and use synthetic names, dates and tasks. They do not invoke an assistant, compiler, provider, lifecycle endpoint or task service. Their state transitions demonstrate the intended experience, not runtime correctness. The current application retains host-owned identity, evidence freshness, approval and activation controls.

Compare both alternatives with the same semantic inputs. A fresh reviewer should explain when the rule acts, every relevant condition, the actual change, when nothing changes, what was not checked and whether the behavior is currently on. Record confusion and revise. An agent proxy review helps find ambiguity; it does not stand in for human usability research or user acceptance.
