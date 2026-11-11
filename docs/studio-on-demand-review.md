# Historical Studio interaction proposal

This is a historical interaction proposal. The [current Studio design](extension-studio-design.md) supersedes its single-item entry, pipeline controls and approval flow.

The product starts with a person who wants Daymark to work differently. They can discover available starting points, describe the change, check what it would do, decide when to use it, and return later to manage it. **Customizations** is the front door. **Studio** is the workspace for making or revising one change. Task advice is the first working customization in that journey.

## Destinations and entry

Keep **Daymark** as the host name with **A KEIR Demo** on the line below it. The same host navigation and person selector frame Tasks, Customizations and Studio.

| Surface | Question it answers | Behavior for the next iteration |
| --- | --- | --- |
| **Customizations** | “What have I changed, and what is in use?” | Show the person's known customizations with current status and a separate draft, when present. **New customization** is always discoverable after the owner context is established. Existing items offer **Open** or **Continue draft**. An empty collection explains how to start. Loading and failed reads have their own states. |
| **New customization** | “Where can I start?” | Open a fresh Studio start view in conversation with **What would you like Daymark to do differently?** Offer **See available starting points** as an inline reply. Show **Create from a description · To be implemented** with a short explanation that free-form requests cannot yet be turned into a customization. The person can go back or use a supported starting point. Entering this view creates no record. |
| **Available starting points** | “What can I configure today?” | Show **Task advice** with “Choose the advice you see when you check a task.” Offer **Continue draft** for a pending change, **Open existing setup** for a saved selection or an approved choice awaiting use, and **Set up** when advice is off and there is no draft. Each action opens the same person's task-advice item and retains its history. The two advice labels are answers inside that flow. |
| **Studio for a customization** | “What would change?” | Name the selected customization in the heading. Open in readable chat with inline choices and one immediate consequence. Keep current and proposed status in a compact summary outside transcript scrolling. Open optional resizable review for examples and decisions that need inspection. |
| **Return and manage** | “What is it doing now? Can I change it?” | Back returns to the invoking collection entry or the originating native task. From the item, revise its settings, inspect saved examples, turn it off or restore an eligible earlier choice. Show the person, outcome and consequences before a restore. Preserve the originating task's unsaved edits. |

Use the current owner's saved selection, draft and retained lifecycle records to distinguish a known setup from a starting point that has never been configured. An off setup with retained history still belongs in the collection. An untouched starting point belongs in discovery. A prepared starting point and an existing setup may lead to the same item, but neither path creates a duplicate. Reuse the current read model for task advice. A second customization type can join this structure when the host actually supports it.

## Availability and state

| State | What the person sees | Permitted action |
| --- | --- | --- |
| Planned capability | **Create from a description · To be implemented.** “For now, choose an available starting point.” The reason is visible text, including on touch and to assistive technology. | The planned action is disabled. Keep discovery and return usable. Do not accept a request, simulate an assistant reply or claim a draft was saved. |
| Supported and available | A working starting point or saved item with its owner-scoped status. | Set up, open or continue the existing item. Use server-offered choices. |
| Off, draft or approved | **Off** or **In use** describes the current selection. **Proposed** or **Approved · Ready to use** describes the separate revision being considered. | Try the proposal, inspect actual results, approve the eligible revision, then separately choose **Use**. |
| Working feature temporarily unavailable | **Unavailable** and the specific safe recovery action. During loading, say what is being checked. When a saved choice is ineligible, retain its identity for inspection. | Retry or refresh where supported. Gate consequential actions on trusted current state. An error must never appear as an empty collection or a planned feature. |
| Earlier or stale result | Original situation, expected outcome and observed result, labelled as belonging to the earlier change. | Inspect or return to the current proposal. Earlier evidence cannot approve a new revision. |

Show a planned control only where it explains the next real product action. One unavailable authoring path at the start is sufficient for this iteration. Add discovery items as they become usable. Use **Try on sample tasks**, approval and activation wherever the working lifecycle permits them today.

## Working example: Maya changes task advice

Maya opens her **Task advice** item from the collection, or reaches it through an available starting point. Above the conversation, a compact summary reads **In use · Pending**. It stays visible when the conversation scrolls. The transcript has a comfortable reading width even when it has the whole workspace.

**Studio** asks “When you check an open task, what should it say?” The replies **Pending** and **Needs attention** appear directly below. Maya selects **Needs attention**. When the server saves the draft, her choice appears as her turn. Studio replies “An open task would say **Needs attention**. A completed task would still say **Done**.” The summary now reads **In use · Pending** and **Proposed · Needs attention**. The available action is **Try on sample tasks**.

Maya runs the examples. The reply summarizes the actual result and offers **Review 6 examples** when the run contains six. Following that action opens the results beside the conversation. The sheet compares what Maya expected with what happened. Her next decision is **Approve this advice** for the exact current proposal and results. Once she approves, the summary still shows **In use · Pending**, now alongside **Approved · Needs attention**. **Use this advice for me** is a separate decision. Only after the server confirms use does the current value become **Needs attention**.

If Maya leaves after approving, reopening Studio brings her back to the saved status and the action for her approved change. She can see what is in use without finding a particular message.

## Where each decision lives

| Moment | In the conversation | In the review surface or host app |
| --- | --- | --- |
| Choose or revise | Render the two catalog choices under the current question. After selection, record the choice and show one sentence describing its consequence. Offer **Change choice** on the current proposal. | The review surface starts closed. An explicit **View proposal** action is available from the persistent summary. |
| Check examples | **Try on sample tasks** uses the existing simulator. Announce progress once. Show a short result from the returned evidence and a button to inspect it. An incomplete or failed run says what needs attention. | **Review examples** opens the saved run. Present the selected example and its expected and actual advice. Keep technical details expandable. A mismatch blocks approval. Never substitute a successful-looking summary for missing results. |
| Approve and use | A typed request to approve or use opens the current review. Chat can acknowledge an action the person took. | Review names the owner, proposed outcome and exact examples. Keep the existing explicit confirmation, followed by separate **Use this advice for me**. When a person explicitly approves in review, the next available Use control is adjacent and receives focus. |
| Revisit | Earlier replies are receipts. **Reopen these examples** opens the original evidence, even after the draft has changed. Superseded choices and approvals cannot change the current draft. | Label earlier evidence clearly. Offer **Return to current proposal**. Current evidence and approval remain server-bound. |
| Check a real task or manage | A short receipt after activation points to **Check task advice** in the native task. | Keep disable, named restore, history and recovery under their existing management affordance, reachable from the status summary even when review is closed. Preserve the native task's saved status and unsaved edits. |

## Explain the example in place

Lead each sample row with the situation and the advice Daymark actually showed. Keep the expected outcome visible for comparison. If the result needs explanation, put one sentence beside that row. For example, when the saved completed-task sample shows **Done**, the note can read “The proposed change applies only to open tasks.” The note explains the scope of the saved proposal. A failed or unexpected result still shows the difference between expected and actual advice.

Use “You chose …” only when a recorded choice by that person is linked to the proposal revision behind the sample. A prepared expectation can be labelled **Expected**. If the saved evidence does not establish who supplied it, use neutral wording or omit the note. Reopening an earlier run uses its own evidence and revision, even if Maya has since made a different choice.

## Opening, closing and returning

- Tall and wide screens open review as the existing resizable pane. On phones and short screens the same review occupies the available workspace, with a clear **Back to conversation** control. A hidden pane and splitter are outside the focus order.
- Let the person open and close review deliberately. Finishing a simulation offers its results in chat. An incoming result leaves an earlier example in place while the person is reading it. Closing review retains its identity, scroll position, conversation input and preferred split width during that visit.
- Focus the results or review heading on explicit open. On close, return focus to the invoking control, or the current summary action if that control has been superseded. Returning to Daymark still respects the original overview or task-detail entry.
- On reopen, read the current owner's saved state before offering consequential actions. Distinguish **Off**, **Unavailable**, a pending draft and an approved choice awaiting use. User switches clear the earlier owner's transcript, review, focus target and late responses. After an uncertain mutation, reconcile saved state before offering another action.

## Implementation boundary and design checks

Reuse the functional Studio controller, native overview, simulator, immutable evidence lookup and approval/selection guards. Change presentation and focus ownership. Separate whether review is open from which evidence it displays. Derive current controls from trusted server state. Render historical inline controls as receipts, with their own evidence identity. The available advice choices describe the saved status of an open or completed task. Due dates and blocked tasks belong to hypothetical future workflows.

An internal rendered walkthrough and focused browser checks provide the immediate acceptance evidence:

1. Enter Customizations from Tasks without opening a task. Compare a person with a saved setup and a person with none. Open **New customization**. Read the planned-authoring explanation using keyboard or touch, then discover **Task advice**. Backing out leaves the collection unchanged. From a person with a setup, discovery reopens that same item and draft.
2. Choose **Needs attention** for an open task. Verify the choice and consequence appear together in chat while **In use · Pending** stays visible. Run the actual samples, then open, resize, close and reopen their results. Check focus, unsent input and reading position on desktop, phone and a short viewport. Completion of a check must not pull someone away from a different example.
3. Inspect a result, then revise the choice and reopen the earlier run. Its explanation still fits its original revision. A prepared expectation carries no invented user attribution. A mismatch or stale result prevents approval and offers a route back to the current draft.
4. Approve a current passing proposal, then leave and re-enter through the collection before using it. Confirm Pending remains in use and Needs attention is approved. Explicitly use it and check advice on a saved native task. Confirm the other person's selection is independent and that returning through the native task shortcut preserves unsaved task edits.
5. Turn off a known setup, retain its draft and history, then inspect and restore an eligible prior choice. Verify Off, Unavailable, loading/error and To be implemented have distinct wording and actions. Switch people during an outstanding request and verify the old response cannot populate the new person's collection or Studio.

Maya can understand the effect of one advice choice in the conversation. Open review when she needs to compare several outcomes or approve the exact change. Revisit the default when a real Daymark customization requires people to keep those outcomes visible while revising it.
