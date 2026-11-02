# Studio with review on demand

Daymark's task-advice Studio opens in conversation. Put a bounded choice and its immediate consequence beside the question. Open the existing review surface when the person asks to inspect examples, resolve a discrepancy, or decide whether to approve an exact proposal. This is the working design for the next functional iteration. We will evaluate it with real Daymark workflows as they land.

## Maya's first change

Maya opens **Customizations → Task advice**. Above the conversation, a compact summary reads **In use · Pending**. It stays visible when the conversation scrolls. The transcript has a comfortable reading width even when it has the whole workspace.

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

1. Start with an active Pending choice. Select Needs attention, run the real samples and open, resize, close and reopen review. Verify the initial view is readable on its own and the chosen result survives the round trip.
2. Approve, then leave and re-enter before using. The status still says Pending is in use. Activating explicitly updates the summary and native advice on a saved open task.
3. Change the open-task choice after a run and reopen that earlier run. Verify its results and any explanation still describe the original choice, that prepared expectations carry no invented user attribution, and that the old run cannot approve the new proposal. Check a failed or stale result and the visible recovery action.
4. Exercise Off with a separate draft, Unavailable, disable, restore, owner switch during an outstanding request, and return to an unsaved native task. Reuse existing lifecycle coverage where the affected path is already exercised.
5. At desktop, phone and short/zoom-equivalent sizes, use keyboard alone to reach choices, review and the return action. Check transcript/preview scrolling, focus restoration and Send reachability.

Maya can understand the effect of one advice choice in the conversation. Open review when she needs to compare several outcomes or approve the exact change. Revisit the default when a real Daymark customization requires people to keep those outcomes visible while revising it.
