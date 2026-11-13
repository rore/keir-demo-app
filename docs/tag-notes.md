# Require notes for heavily tagged new tasks

This example uses the independently qualified Core 0.5 candidate. It demonstrates supplied-list length and Integer comparison, not Decimal amounts or a total query count. Package publication, live-provider qualification and deployment are separate.

## Describe and check the rule

In **Customizations → New customization**, ask:

> Before saving a new task with more than three tags, require notes.

Confirm that tags count once after trimming, Unicode normalization and lowercasing. Whitespace-only notes do not count. Four through eight tags **with notes are allowed**. This is not a three-tag limit.

The assistant discovers the host contract, compiles a draft and saves independent examples. Open **See proposed change**, read the condition in **Summary**, then choose **View simulation**. The checked examples should include:

| New task proposal | Expected decision |
| --- | --- |
| No tags or exactly three normalized tags, no notes | Allow normal native checks to continue. |
| Four or eight tags, no notes | Deny with a correction asking for notes. |
| Four or eight tags, non-whitespace notes | Allow normal native checks to continue. |
| Raw `Client, client, REVIEW, internal` | Three distinct normalized tags; notes are not required. |
| Deliberately unavailable required check | Stop saving because the check could not run. This is not a business denial. |

Simulation changes no real tasks. A successful ALLOW is not a native save receipt. The app still checks permissions, valid fields and the native eight-tag ceiling. Nine distinct tags fail native validation before the rule runs.

## Approve, then turn on separately

Choose **Approve this change** only after reviewing its exact checked examples. Approval saves agreement but changes neither tasks nor the active rule. Use the separate **Turn on for new tasks** control when ready. The app keeps the selections for task-added and task-completed reactions unchanged.

The condition shown for the proposal, checked review and version in use comes from that version's verified compiled artifact. A missing or incomplete description is not evidence that the threshold and notes requirement were checked.

## Try a real new task

1. In **Tasks**, choose **Details** and enter a title, four distinct tags and no notes.
2. Choose **Add task**. The app keeps your entries and asks for notes. No task or task-added event is created.
3. Add non-whitespace notes and submit again. The app starts a new corrected attempt and saves the task once.
4. Alternatively, reduce the tags to three and save without notes.

The quick-add button and Enter key use the same native creation guard, including any details retained in the form. A lost response must be checked against the original attempt before another creation is offered.

Automation through `tasks.create` also uses the guard. A denied automation attempt retains its existing original-key NONE receipt for replay, but creates no task or task-added event. A rule that could not be checked stays distinct from a rule that rejected the proposal.

## Boundaries

- Only future new-task creation is checked. Existing tasks and later edits are not retroactively restricted.
- Native tags remain limited to eight. Core counts the bounded list it receives; Daymark supplies normalization and distinctness.
- Saved older rules, model identities and approvals remain tied to their exact bytes. Editing and recompiling produces a new revision needing its own examples, approval and separate activation.
- Automated regression can use scripted offline authoring transport with the real compiler, simulator and native services. That is not qualification of a live language model or an operator deployment.
